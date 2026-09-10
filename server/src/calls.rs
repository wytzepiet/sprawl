//! Call-outs: something in the city calls, and a vehicle answers.
//! docs/services.md §5.
//!
//! A call has a kind and a place. A shelf at its reorder point calls for
//! stock, and the building takes its turn (docs/economy.md §6.2): among
//! every seller it can reach — a depot with the good on its shelf and a
//! van free, or the outside beyond the edge — it takes the cheapest
//! delivered, which is the posted price in hours of its own earning plus
//! the drive. A depot's own shelf running low calls for a fetch: one of
//! its lorries drives out past the edge, is away a while, and comes back
//! full. The vehicle drives to the caller, spends the service time at its
//! door, and goes home — or, from beyond the edge, simply goes. Empty
//! shelves sell nothing, and every delivery is paid for as it lands
//! (`economy::delivered`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::blueprint::blueprint;
use crate::economy;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::needs::Bucket;
use crate::protocol::{Car, CarRole, EntityId, GameObject, DAY_MS};
use crate::world::pathfinding::Routes;
use crate::world::World;

/// What a call is for, and so who answers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum CallKind {
    /// Shelves at their reorder point. Answered by whichever seller the
    /// building finds cheapest delivered: a depot's van, or a lorry from
    /// beyond the edge.
    Stock,
    /// A depot's stock running low. Answered by one of its own lorries,
    /// out past the edge and back.
    Fetch,
}

/// How long a lorry is away beyond the edge: two hours.
pub const AWAY_MS: GameTime = DAY_MS as GameTime / 12;

/// A call raised and not yet resolved.
#[derive(Debug, Clone, Copy)]
pub struct Call {
    pub kind: CallKind,
    /// The building calling.
    pub at: EntityId,
    pub raised: GameTime,
    /// The vehicle on its way, once one is.
    pub answered_by: Option<EntityId>,
    /// What it carries, in units of the caller's shelf: loaded at the
    /// seller's as it leaves. A fetch carries nothing back it has to
    /// account for; the depot fills.
    pub load: f64,
}

/// Unloading at the door: ten minutes.
pub const SERVICE_MS: GameTime = DAY_MS as GameTime / 144;

/// A shelf changed: one at its reorder point calls for stock. A depot
/// calls for a fetch from beyond the edge; anything else calls for a
/// delivery. Buildings whose row keeps no stock never run out.
pub fn restock(world: &mut World, events: &mut EventQueue, building: EntityId, now: GameTime) {
    let Some(GameObject::Building(b)) = world.objects.get(building).map(|e| &e.object) else { return };
    if b.stock.cap == 0.0 || b.stock.level >= economy::reorder(world, building) {
        return;
    }
    let kind = if economy::depot(b.kind) { CallKind::Fetch } else { CallKind::Stock };
    if world.calls.iter().any(|c| c.at == building && c.kind == kind) {
        return;
    }
    world.calls.push(Call { kind, at: building, raised: now, answered_by: None, load: 0.0 });
    dispatch(world, events, now);
}

/// Does this building have anything on its shelves? A building that keeps
/// no stock always does.
pub fn stocked(world: &World, building: EntityId) -> bool {
    match world.objects.get(building).map(|e| &e.object) {
        Some(GameObject::Building(b)) => b.stock.cap == 0.0 || b.stock.level > 0.0,
        _ => false,
    }
}

/// Send a vehicle to every open call that one can be sent to. A call
/// nothing can answer yet waits for the next vehicle to come home.
pub fn dispatch(world: &mut World, events: &mut EventQueue, now: GameTime) {
    // A caller that has gone, or a vehicle that has, ends or reopens the call.
    world.calls.retain(|c| world.objects.get(c.at).is_some());
    for c in &mut world.calls {
        if c.answered_by.is_some_and(|car| world.objects.get(car).is_none()) {
            c.answered_by = None;
        }
    }
    for i in 0..world.calls.len() {
        let Call { kind, at, answered_by, .. } = world.calls[i];
        if answered_by.is_some() {
            continue;
        }
        // Nothing can be delivered to a door no road reaches.
        if world.road_node_for_building(at).is_none() {
            continue;
        }
        let Some((here, order)) = world.objects.get(at).and_then(|e| match e.object {
            GameObject::Building(ref b) => Some((e.position?, b.stock.short())),
            _ => None,
        }) else {
            continue
        };
        let answered = match kind {
            // A depot's lorry sets out for the edge, if the town can pay
            // for what it brings back (docs/economy.md §9).
            CallKind::Fetch if world.treasury <= 0.0 => None,
            CallKind::Fetch => free_vehicle(world, at, CarRole::Truck).and_then(|(car, door)| {
                let exit = world.entry_node_near(here)?;
                crate::car::spawn::leave_for_edge(world, events, car, door, exit, now).then_some(car)
            }),
            CallKind::Stock => match cheapest_seller(world, at, now) {
                Some(Seller::Depot(depot, van, door)) => crate::car::spawn::start_trip(world, events, van, door, at, now, GameTime::MAX).then(|| {
                    world.calls[i].load = economy::loaded(world, depot, order, now);
                    van
                }),
                Some(Seller::Edge(entry)) => {
                    // From beyond the edge: a lorry appears on the road out
                    // past the frontier and drives in. It belongs to nobody
                    // here; it goes when it is done.
                    let car = world.insert_at(GameObject::Car(Car { owner: at, trip: None, role: CarRole::Truck, spot: None, away: 0, fuel: Bucket::tank() }), None);
                    let started = crate::car::spawn::start_trip(world, events, car, entry, at, now, GameTime::MAX);
                    if !started {
                        world.despawn_car(car);
                    }
                    world.calls[i].load = order;
                    started.then_some(car)
                }
                None => None,
            },
        };
        world.calls[i].answered_by = answered;
    }
}

/// Who delivers an order.
enum Seller {
    /// A depot, its van, and the driveway it leaves from.
    Depot(EntityId, EntityId, EntityId),
    /// A lorry from beyond the edge, and the road it drives in on.
    Edge(EntityId),
}

/// The building's turn, docs/economy.md §6.2: every seller of its shelf's
/// good it can reach, at the delivered price — the order at the posted
/// price, in hours of the building's own earning, plus the time until the
/// load lands — and the cheapest wins. That is the score of §6.1 for an
/// order every seller fills alike. A depot sells what its shelf holds, by
/// a van standing free; the outside sells without limit, by a lorry that
/// drives in from the nearest exit, while the town can pay for it
/// (docs/economy.md §9). `None` where no seller can be reached.
fn cheapest_seller(world: &mut World, at: EntityId, now: GameTime) -> Option<Seller> {
    let (kind, order, here) = match world.objects.get(at) {
        Some(e) => match e.object {
            GameObject::Building(ref b) => (b.kind, b.stock.short(), e.position?),
            _ => return None,
        },
        None => return None,
    };
    let need = economy::shelf_need(kind);
    // Every depot with the good on its shelf, in id order, so two runs of
    // the same town make the same choice.
    let mut depots: Vec<EntityId> = world
        .objects
        .iter()
        .filter(|e| e.id != at && matches!(e.object, GameObject::Building(ref b) if economy::depot(b.kind) && economy::shelf_need(b.kind) == need && b.stock.level > 0.0))
        .map(|e| e.id)
        .collect();
    depots.sort_unstable();
    let vans: Vec<(EntityId, EntityId, EntityId)> = depots.into_iter().filter_map(|d| free_vehicle(world, d, CarRole::Van).map(|(van, door)| (d, van, door))).collect();
    let door = world.road_node_for_building(at)?;
    let mut routes = Routes::from(world, door);
    // Milliseconds of the building's own time per hour of money.
    let dear = economy::HOUR / economy::earns(world, at, now);
    let mut delivered = |from: EntityId, price: f64| -> Option<f64> {
        let drive = if from == door { 0.0 } else { routes.cost_to(from)? };
        Some(drive + order * price * dear)
    };
    let mut best: Option<(f64, Seller)> = None;
    if world.treasury > 0.0
        && let Some(edge) = world.nearest_edge(here)
        && let Some(entry) = world.road_node_for_building(edge)
        && let Some(cost) = delivered(entry, economy::import(economy::wholesale(need)))
    {
        best = Some((cost, Seller::Edge(entry)));
    }
    for (depot, van, from) in vans {
        if let Some(cost) = delivered(from, economy::price_of(world, depot, need))
            && best.as_ref().is_none_or(|(b, _)| cost < *b)
        {
            best = Some((cost, Seller::Depot(depot, van, from)));
        }
    }
    best.map(|(_, seller)| seller)
}

/// A facility's vehicles, standing in its yard from the day it is reached:
/// the ones its row lists, each in a dock.
pub fn stable(world: &mut World, facility: EntityId) {
    let kind = match world.objects.get(facility).map(|e| &e.object) {
        Some(GameObject::Building(b)) => b.kind,
        _ => return,
    };
    let tile = world.objects.get(facility).and_then(|e| e.position);
    let have = fleet_of(world, facility).len();
    for &role in blueprint(kind).vehicles.iter().skip(have) {
        let car = world.insert_at(GameObject::Car(Car { owner: facility, trip: None, role, spot: None, away: 0, fuel: Bucket::tank() }), tile);
        world.park_in_lot(facility, car, 0);
    }
}

/// A facility's vehicle of a role standing free in its yard, and the
/// driveway it leaves from. None where no road reaches the yard.
fn free_vehicle(world: &mut World, facility: EntityId, role: CarRole) -> Option<(EntityId, EntityId)> {
    let door = world.road_node_for_building(facility)?;
    stable(world, facility);
    let car = fleet_of(world, facility).into_iter().find(|&car| {
        matches!(world.objects.get(car).map(|e| &e.object), Some(GameObject::Car(c)) if c.role == role && c.trip.is_none() && c.away == 0)
    })?;
    Some((car, door))
}

/// The vehicles a facility owns, in id order.
fn fleet_of(world: &World, facility: EntityId) -> Vec<EntityId> {
    let mut fleet: Vec<EntityId> = world
        .objects
        .iter()
        .filter(|e| matches!(e.object, GameObject::Car(ref c) if c.owner == facility))
        .map(|e| e.id)
        .collect();
    fleet.sort_unstable();
    fleet
}

/// A vehicle woke while parked. Private cars have nothing to think about;
/// a vehicle on a call has finished unloading, and delivers; a lorry
/// beyond the edge comes back in, and one home from beyond fills the
/// depot.
pub fn car_idle(world: &mut World, events: &mut EventQueue, car: EntityId, now: GameTime) {
    let (owner, away) = match world.objects.get(car).map(|e| &e.object) {
        Some(GameObject::Car(c)) if c.role != CarRole::Private && c.trip.is_none() => (c.owner, c.away),
        _ => return,
    };
    let Some(i) = world.calls.iter().position(|c| c.answered_by == Some(car)) else { return };
    if away > 0 {
        // Back in from beyond the edge, loaded, home to the depot.
        let home = world.objects.get(owner).and_then(|e| e.position);
        let came = home
            .and_then(|p| world.entry_node_near(p))
            .is_some_and(|entry| crate::car::spawn::start_trip(world, events, car, entry, owner, now, GameTime::MAX));
        if came {
            if let Some(entry) = world.objects.get_mut(car)
                && let GameObject::Car(ref mut c) = entry.object
            {
                c.away = 0;
            }
        } else {
            events.wake(SERVICE_MS, car);
        }
        return;
    }
    let call = world.calls.remove(i);
    // How long it took, from the call to the load landing: the lead time
    // the next reorder point covers.
    world.books.entry(call.at).or_default().lead = Some(now - call.raised);
    // Home, if there is one to go to; a truck from beyond the edge is gone.
    // A lorry home from a fetch is home already.
    let facility = matches!(world.objects.get(owner).map(|e| &e.object), Some(GameObject::Building(b)) if blueprint(b.kind).answers.is_some());
    // The shelf fills, and is paid for: by the shop to the depot whose van
    // this is, or to the edge; by the depot to the edge for what the lorry
    // brought back.
    match call.kind {
        CallKind::Fetch => economy::fetched(world, call.at, now),
        CallKind::Stock => {
            economy::delivered(world, call.at, facility.then_some(owner), call.load, now);
            // Up to the shelf: a load short of the order, or a long lead,
            // leaves it under the reorder point still.
            restock(world, events, call.at, now);
            if facility {
                restock(world, events, owner, now);
            }
        }
    }
    println!(
        "delivery: {:?} to building {} answered {}s after the call",
        call.kind,
        call.at,
        (now - call.raised) / 1000
    );
    if call.kind == CallKind::Fetch {
        // Nothing to do: the depot is full and the lorry in its dock.
    } else if facility {
        let back = world
            .road_node_for_building(call.at)
            .is_some_and(|door| crate::car::spawn::start_trip(world, events, car, door, owner, now, GameTime::MAX));
        if !back {
            events.wake(SERVICE_MS, car);
        }
    } else {
        world.despawn_car(car);
    }
    dispatch(world, events, now);
}
