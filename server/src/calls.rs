//! Call-outs: something in the city calls, and a vehicle answers.
//! docs/services.md §5.
//!
//! A call has a kind and a place. A facility whose row answers that kind
//! sends a vehicle it owns; if the city has no such facility, a vehicle
//! comes from beyond the edge of the map, along the roads, slowly. The
//! vehicle drives to the caller, spends the service time at its door,
//! and goes home — or, from beyond the edge, simply goes. The call's
//! consequence scales with how long that took.
//!
//! Stock: a shop's shelf goes down with every sale, and it calls when the
//! shelf runs low; a depot's van answers. Empty shelves sell nothing. A
//! depot's shelf goes down with every delivery it makes, and when that
//! runs low it calls for a fetch: one of its lorries drives out past the
//! edge of the map, is away a while, and comes back full. Every delivery
//! is paid for as it lands (`economy::delivered`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::blueprint::blueprint;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::protocol::{Car, CarRole, EntityId, GameObject, DAY_MS};
use crate::needs::Bucket;
use crate::world::World;

/// What a call is for, and so who answers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum CallKind {
    /// Shelves running low. Answered by a depot's van, or a lorry from
    /// beyond the edge where the city has no depot.
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
}

/// Shelves below this fraction call for stock: the reorder point.
const LOW: f64 = 0.5;
/// Unloading at the door: ten minutes.
pub const SERVICE_MS: GameTime = DAY_MS as GameTime / 144;

/// A shelf changed: low shelves call for stock, if the purse can pay for
/// it (docs/economy.md §9). A depot calls for a fetch from beyond the
/// edge; anything else calls for a delivery. Buildings whose row keeps no
/// stock never run out.
pub fn restock(world: &mut World, events: &mut EventQueue, building: EntityId, now: GameTime) {
    let Some(GameObject::Building(b)) = world.objects.get(building).map(|e| &e.object) else { return };
    if b.stock.cap == 0.0 || b.stock.level >= LOW * b.stock.cap {
        return;
    }
    let kind = if blueprint(b.kind).answers == Some(CallKind::Stock) { CallKind::Fetch } else { CallKind::Stock };
    if !crate::economy::solvent(world, building) || world.calls.iter().any(|c| c.at == building && c.kind == kind) {
        return;
    }
    world.calls.push(Call { kind, at: building, raised: now, answered_by: None });
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

/// Send a vehicle to every open call that one can be sent to. A call with
/// nothing free to answer it waits for the next vehicle to come home.
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
        let Some(here) = world.objects.get(at).and_then(|e| e.position) else { continue };
        let answered = match (kind, nearest_free_vehicle(world, kind, at)) {
            // A depot's lorry sets out for the edge.
            (CallKind::Fetch, Answer::Send(car, from)) => {
                let exit = world.entry_node_near(here);
                exit.is_some_and(|exit| crate::car::spawn::leave_for_edge(world, events, car, from, exit, now)).then_some(car)
            }
            (CallKind::Fetch, _) => None,
            (CallKind::Stock, Answer::Send(car, from)) => {
                crate::car::spawn::start_trip(world, events, car, from, at, now, GameTime::MAX).then_some(car)
            }
            // A depot exists but has nothing free, or nothing to send: wait.
            (CallKind::Stock, Answer::Busy) => None,
            (CallKind::Stock, Answer::Nobody) => {
                // From beyond the edge: a lorry appears on the road out past
                // the frontier and drives in. It belongs to nobody here; it
                // goes when it is done.
                let car = world.insert_at(GameObject::Car(Car { owner: at, trip: None, role: CarRole::Truck, spot: None, away: 0, fuel: Bucket::tank() }), None);
                let started = world
                    .entry_node_near(here)
                    .is_some_and(|entry| crate::car::spawn::start_trip(world, events, car, entry, at, now, GameTime::MAX));
                if !started {
                    world.despawn_car(car);
                }
                started.then_some(car)
            }
        };
        world.calls[i].answered_by = answered;
    }
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

enum Answer {
    Send(EntityId, EntityId),
    /// A facility exists but has nothing to send right now.
    Busy,
    /// No facility in the city answers this.
    Nobody,
}

/// Who answers a call: for a fetch, one of the caller's own lorries; for
/// stock, a van from the nearest depot with something on its shelves. The
/// vehicle, and the driveway it leaves from.
fn nearest_free_vehicle(world: &mut World, kind: CallKind, at: EntityId) -> Answer {
    let Some(here) = world.objects.get(at).and_then(|e| e.position) else { return Answer::Nobody };
    // A depot's shelves hold food. A pump's tanks are filled from beyond
    // the edge until something in town refines fuel.
    if kind == CallKind::Stock
        && let Some(GameObject::Building(b)) = world.objects.get(at).map(|e| &e.object)
        && crate::economy::shelf_need(b.kind) != crate::needs::Need::Eat
    {
        return Answer::Nobody;
    }
    let (wanted, answers) = match kind {
        CallKind::Fetch => (CarRole::Truck, None),
        CallKind::Stock => (CarRole::Van, Some(CallKind::Stock)),
    };
    let mut facilities: Vec<(i32, EntityId)> = world
        .objects
        .all_entries()
        .iter()
        .filter_map(|e| match e.object {
            GameObject::Building(ref b) if answers.is_some_and(|k| blueprint(b.kind).answers == Some(k)) || (answers.is_none() && e.id == at) => {
                let p = e.position?;
                Some(((p.x - here.x).abs().max((p.y - here.y).abs()), e.id))
            }
            _ => None,
        })
        .collect();
    if facilities.is_empty() {
        return Answer::Nobody;
    }
    facilities.sort_unstable();
    for (_, facility) in facilities {
        let Some(door) = world.road_node_for_building(facility) else { continue };
        if kind == CallKind::Stock && !stocked(world, facility) {
            continue;
        }
        stable(world, facility);
        let free = fleet_of(world, facility).into_iter().find(|&car| {
            matches!(world.objects.get(car).map(|e| &e.object), Some(GameObject::Car(c)) if c.role == wanted && c.trip.is_none() && c.away == 0)
        });
        if let Some(car) = free {
            return Answer::Send(car, door);
        }
    }
    Answer::Busy
}

/// The vehicles a facility owns.
fn fleet_of(world: &World, facility: EntityId) -> Vec<EntityId> {
    world
        .objects
        .all_entries()
        .iter()
        .filter(|e| matches!(e.object, GameObject::Car(ref c) if c.owner == facility))
        .map(|e| e.id)
        .collect()
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
    // Home, if there is one to go to; a truck from beyond the edge is gone.
    // A lorry home from a fetch is home already.
    let facility = matches!(world.objects.get(owner).map(|e| &e.object), Some(GameObject::Building(b)) if blueprint(b.kind).answers.is_some());
    // The shelf fills, and is paid for: by the shop to the depot whose van
    // this is, or to the edge; by the depot to the edge for what the lorry
    // brought back.
    match call.kind {
        CallKind::Fetch => crate::economy::fetched(world, call.at, now),
        CallKind::Stock => {
            crate::economy::delivered(world, call.at, facility.then_some(owner), now);
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
