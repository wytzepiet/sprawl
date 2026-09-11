//! Call-outs: something in the city calls, and a vehicle answers.
//! docs/services.md §5.
//!
//! A call has a good and a place. A stock at its reorder point calls, and
//! the building takes its turn (docs/economy.md §6.2): among every seller
//! of the good it can reach — a depot with it on the shelf and a van free,
//! an office with services on its shelf and a car free, or the outside
//! beyond the edge — it takes the cheapest delivered, which is the posted
//! price in hours of its own earning plus the drive. A depot's own shelf
//! running low sends one of its lorries out past the edge, away a while,
//! and back full; a maker's shelf running full sends its car out with the
//! load, since what nobody in town buys the edge buys (§8.1). The vehicle
//! drives to the caller, spends the service time at its door, and goes
//! home — or, from beyond the edge, simply goes. Empty shelves sell
//! nothing, and every delivery is paid for as it lands
//! (`economy::delivered`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::blueprint::blueprint;
use crate::economy;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::needs::Need;
use crate::protocol::{Car, CarRole, EntityId, GameObject, DAY_MS};
use crate::world::pathfinding::Routes;
use crate::world::World;

/// What a call is for, and so who answers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum CallKind {
    /// A stock at its reorder point. Answered by whichever seller the
    /// building finds cheapest delivered: a depot's van, an office's car,
    /// or one from beyond the edge.
    Stock,
    /// A trip beyond the edge by the building's own vehicle: a depot's
    /// lorry, out for its shelf's good and back full; a maker's car, out
    /// with a load nobody in town bought, and back paid.
    Edge,
}

/// How long a lorry is away beyond the edge: two hours.
pub const AWAY_MS: GameTime = DAY_MS as GameTime / 12;

/// A call raised and not yet resolved.
#[derive(Debug, Clone, Copy)]
pub struct Call {
    pub kind: CallKind,
    /// The good it is for.
    pub good: Need,
    /// The building calling.
    pub at: EntityId,
    pub raised: GameTime,
    /// The vehicle on its way, once one is.
    pub answered_by: Option<EntityId>,
    /// What it carries, in units of the good: loaded at the seller's as
    /// it leaves. A lorry out for a fetch carries nothing it has to
    /// account for; the depot fills.
    pub load: f64,
}

/// Unloading at the door: ten minutes.
pub const SERVICE_MS: GameTime = DAY_MS as GameTime / 144;

/// A call nothing could answer is tried again in an hour. The wake that
/// is nobody's, like midnight: a home calls at midnight with the
/// household's car in the driveway, and the driveway clears when they
/// leave for work.
pub const RETRY_MS: GameTime = DAY_MS as GameTime / 24;
pub const RETRY: EntityId = EntityId::MAX - 1;

/// Who carries a good over the edge: a lorry for crates and tanks, a car
/// for someone who does the job on site.
fn lorry(good: Need) -> CarRole {
    if good == Need::Services { CarRole::Company } else { CarRole::Truck }
}

/// Who carries it the last mile from a seller in town.
fn van(good: Need) -> CarRole {
    if good == Need::Services { CarRole::Company } else { CarRole::Van }
}

/// A stock changed, or time passed: the building takes its turn. Its
/// services are drawn for the time since the last look; a stock at its
/// reorder point calls for it — a depot's own shelf for a fetch from
/// beyond the edge, anything else for a delivery — and a maker's shelf
/// with no room for the next shift's make ships to the edge, since a
/// shift lands on the shelf in one lump as its tab is paid and a lump
/// that does not fit is lost (docs/economy.md §12.7). A row never calls
/// for what its own labour makes.
pub fn turn(world: &mut World, events: &mut EventQueue, building: EntityId, now: GameTime) {
    let Some(GameObject::Building(b)) = world.objects.get(building).map(|e| &e.object) else { return };
    let kind = b.kind;
    let full: Vec<Need> = b.stocks.iter().filter(|(good, s)| economy::makes(kind, **good) && s.short() < economy::lump(kind)).map(|(good, _)| *good).collect();
    economy::drawn(world, building, now);
    let Some(GameObject::Building(b)) = world.objects.get(building).map(|e| &e.object) else { return };
    let mut calls = Vec::new();
    for (&good, stock) in &b.stocks {
        let call = if economy::makes(kind, good) {
            full.contains(&good).then_some(CallKind::Edge)
        } else if stock.level < economy::reorder(world, building, good) {
            Some(if economy::depot(kind) && good == economy::shelf_need(kind) { CallKind::Edge } else { CallKind::Stock })
        } else {
            None
        };
        if let Some(kind) = call
            && !world.calls.iter().any(|c| c.at == building && c.good == good)
        {
            calls.push(Call { kind, good, at: building, raised: now, answered_by: None, load: 0.0 });
        }
    }
    if !calls.is_empty() {
        world.calls.extend(calls);
        dispatch(world, events, now);
    }
}

/// Midnight: every building takes its turn, so a row nobody visits still
/// draws.
pub fn turns(world: &mut World, events: &mut EventQueue, now: GameTime) {
    let mut ids: Vec<EntityId> = world.objects.iter().filter(|e| matches!(e.object, GameObject::Building(_))).map(|e| e.id).collect();
    ids.sort_unstable();
    for id in ids {
        turn(world, events, id, now);
    }
}

/// Does this building have anything on the shelf its taps sell from? A
/// building that keeps no shelf always does.
pub fn stocked(world: &World, building: EntityId) -> bool {
    match world.objects.get(building).map(|e| &e.object) {
        Some(GameObject::Building(b)) => b.stocks.get(&economy::shelf_need(b.kind)).is_none_or(|s| s.level > 0.0),
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
        let Call { kind, good, at, answered_by, .. } = world.calls[i];
        if answered_by.is_some() {
            continue;
        }
        // Nothing can be delivered to a door no road reaches.
        if world.road_node_for_building(at).is_none() {
            continue;
        }
        let Some((here, order, maker)) = world.objects.get(at).and_then(|e| match e.object {
            GameObject::Building(ref b) => Some((e.position?, b.stocks.get(&good)?.short(), economy::makes(b.kind, good))),
            _ => None,
        }) else {
            continue
        };
        let answered = match kind {
            // A depot's lorry sets out for the edge, if the town can pay
            // for what it brings back (docs/economy.md §9); a maker's car
            // sets out with what it is selling there.
            CallKind::Edge if !maker && world.treasury <= 0.0 => None,
            CallKind::Edge => free_vehicle(world, at, lorry(good)).and_then(|(car, door)| {
                let exit = world.entry_node_near(here)?;
                crate::car::spawn::leave_for_edge(world, events, car, door, exit, now).then(|| {
                    if maker {
                        world.calls[i].load = economy::shipped(world, at, good);
                    }
                    car
                })
            }),
            CallKind::Stock => match cheapest_seller(world, at, good, now) {
                Some(Seller::Depot(depot, van, door)) => crate::car::spawn::start_trip(world, events, van, door, at, now, GameTime::MAX).then(|| {
                    world.calls[i].load = economy::loaded(world, depot, good, order, now);
                    van
                }),
                Some(Seller::Edge(entry)) => {
                    // From beyond the edge: a lorry, or a consultant's car,
                    // appears on the road out past the frontier and drives
                    // in. It belongs to nobody here; it goes when it is done.
                    let car = world.insert_at(GameObject::Car(Car::new(at, lorry(good))), None);
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
    if world.calls.iter().any(|c| c.answered_by.is_none()) {
        events.wake(RETRY_MS, RETRY);
    }
}

/// Who delivers an order.
enum Seller {
    /// A depot, its vehicle, and the driveway it leaves from.
    Depot(EntityId, EntityId, EntityId),
    /// From beyond the edge, and the road it drives in on.
    Edge(EntityId),
}

/// The building's turn, docs/economy.md §6.2: every seller of the good it
/// can reach, at the delivered price — the order at the posted price, in
/// hours of the building's own earning, plus the time until the load
/// lands — and the cheapest wins. That is the score of §6.1 for an order
/// every seller fills alike. A depot sells what its shelf holds, by a
/// vehicle standing free; the outside sells without limit, by a vehicle
/// that drives in from the nearest exit, while the town can pay for it
/// (docs/economy.md §9). `None` where no seller can be reached.
fn cheapest_seller(world: &mut World, at: EntityId, good: Need, now: GameTime) -> Option<Seller> {
    let (order, here) = match world.objects.get(at) {
        Some(e) => match e.object {
            GameObject::Building(ref b) => (b.stocks.get(&good)?.short(), e.position?),
            _ => return None,
        },
        None => return None,
    };
    // Every depot with the good on its shelf, in id order, so two runs of
    // the same town make the same choice.
    let mut depots: Vec<EntityId> = world
        .objects
        .iter()
        .filter(|e| e.id != at && matches!(e.object, GameObject::Building(ref b) if economy::depot(b.kind) && economy::shelf_need(b.kind) == good && b.stocks.get(&good).is_some_and(|s| s.level > 0.0)))
        .map(|e| e.id)
        .collect();
    depots.sort_unstable();
    let vans: Vec<(EntityId, EntityId, EntityId)> = depots.into_iter().filter_map(|d| free_vehicle(world, d, van(good)).map(|(van, door)| (d, van, door))).collect();
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
        && let Some(cost) = delivered(entry, economy::import(economy::wholesale(good)))
    {
        best = Some((cost, Seller::Edge(entry)));
    }
    for (depot, van, from) in vans {
        if let Some(cost) = delivered(from, economy::price_of(world, depot, good))
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
        let car = world.insert_at(GameObject::Car(Car::new(facility, role)), tile);
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
/// a vehicle on a call has finished unloading, and delivers; one beyond
/// the edge comes back in, and one home from beyond fills the depot, or
/// is paid for what it took; and one home in its yard is filled and put
/// right there (`economy::refilled`).
pub fn car_idle(world: &mut World, events: &mut EventQueue, car: EntityId, now: GameTime) {
    let (owner, away) = match world.objects.get(car).map(|e| &e.object) {
        Some(GameObject::Car(c)) if c.role != CarRole::Private && c.trip.is_none() => (c.owner, c.away),
        _ => return,
    };
    // Home with nothing to do: filled and put right in the yard, at the
    // building's cost.
    let Some(i) = world.calls.iter().position(|c| c.answered_by == Some(car)) else {
        economy::refilled(world, car, now);
        return;
    };
    if away > 0 {
        // Back in from beyond the edge, home to the yard.
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
    // A seller's own vehicle has a home to go to; one from beyond the
    // edge, which the caller owns for the trip, is gone when it is done.
    // A vehicle home from beyond the edge is home already.
    let facility = call.kind == CallKind::Edge || owner != call.at;
    match call.kind {
        // A maker's car is paid for its load; a depot's lorry lands its.
        CallKind::Edge if call.load > 0.0 => economy::exported(world, call.at, call.good, call.load, now),
        CallKind::Edge => economy::delivered(world, call.at, None, call.good, f64::INFINITY, now),
        CallKind::Stock => {
            economy::delivered(world, call.at, facility.then_some(owner), call.good, call.load, now);
            if facility {
                turn(world, events, owner, now);
            }
        }
    }
    // Up to the stock: a load short of the order, or a long lead, leaves
    // it under the reorder point still; a maker's shelf may be full again.
    turn(world, events, call.at, now);
    println!(
        "delivery: {:?} {:?} to building {} answered {}s after the call",
        call.kind,
        call.good,
        call.at,
        (now - call.raised) / 1000
    );
    if call.kind == CallKind::Edge {
        // Nothing to do: the vehicle is in its dock, and is filled there.
        economy::refilled(world, car, now);
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
