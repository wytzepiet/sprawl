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
//! The one kind so far is stock: a shop draws on its shelves with every
//! visit, and calls when they run low. Empty shelves sell nothing.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::blueprint::blueprint;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::protocol::{Car, CarRole, EntityId, GameObject, DAY_MS};
use crate::world::World;

/// What a call is for, and so who answers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum CallKind {
    /// Shelves running low. Answered by a truck.
    Stock,
}

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

/// Shelves below this fraction call for stock.
const LOW: f64 = 0.5;
/// Unloading at the door: ten minutes.
pub const SERVICE_MS: GameTime = DAY_MS as GameTime / 144;

/// A car pulled in at a building: the visit draws on the shelves, and low
/// shelves call for stock. Buildings whose row keeps no stock never run
/// out.
pub fn visit(world: &mut World, events: &mut EventQueue, building: EntityId, now: GameTime) {
    let Some(entry) = world.objects.get_mut(building) else { return };
    let GameObject::Building(ref mut b) = entry.object else { return };
    let per_delivery = blueprint(b.kind).stock;
    if per_delivery == 0 {
        return;
    }
    b.stock = (b.stock - 1.0 / per_delivery as f64).max(0.0);
    let low = b.stock < LOW;
    if low && !world.calls.iter().any(|c| c.at == building) {
        world.calls.push(Call { kind: CallKind::Stock, at: building, raised: now, answered_by: None });
        dispatch(world, events, now);
    }
}

/// Does this building have anything on its shelves? A building that keeps
/// no stock always does.
pub fn stocked(world: &World, building: EntityId) -> bool {
    match world.objects.get(building).map(|e| &e.object) {
        Some(GameObject::Building(b)) => b.stock > 0.0,
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
        let answered = match nearest_free_vehicle(world, kind, at) {
            Some((car, from)) => crate::car::spawn::start_trip(world, events, car, from, at, now, GameTime::MAX).then_some(car),
            None => {
                // From beyond the edge: a truck appears on the road out past
                // the frontier and drives in. It belongs to nobody here; it
                // goes when it is done.
                let car = world.insert_at(GameObject::Car(Car { owner: at, trip: None, role: CarRole::Truck, spot: None }), None);
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
/// as many as its row says, each in a dock.
pub fn stable(world: &mut World, facility: EntityId) {
    let kind = match world.objects.get(facility).map(|e| &e.object) {
        Some(GameObject::Building(b)) => b.kind,
        _ => return,
    };
    let tile = world.objects.get(facility).and_then(|e| e.position);
    while fleet_of(world, facility).len() < blueprint(kind).vehicles as usize {
        let car = world.insert_at(GameObject::Car(Car { owner: facility, trip: None, role: CarRole::Truck, spot: None }), tile);
        world.park_in_lot(facility, car, 0);
    }
}

/// The nearest facility that answers this kind with a vehicle free, and
/// the driveway it leaves from.
fn nearest_free_vehicle(world: &mut World, kind: CallKind, at: EntityId) -> Option<(EntityId, EntityId)> {
    let here = world.objects.get(at)?.position?;
    let mut facilities: Vec<(i32, EntityId)> = world
        .objects
        .all_entries()
        .iter()
        .filter_map(|e| match e.object {
            GameObject::Building(ref b) if blueprint(b.kind).answers == Some(kind) => {
                let p = e.position?;
                Some(((p.x - here.x).abs().max((p.y - here.y).abs()), e.id))
            }
            _ => None,
        })
        .collect();
    facilities.sort_unstable();
    for (_, facility) in facilities {
        let Some(door) = world.road_node_for_building(facility) else { continue };
        stable(world, facility);
        let free = fleet_of(world, facility).into_iter().find(|&car| {
            matches!(world.objects.get(car).map(|e| &e.object), Some(GameObject::Car(c)) if c.trip.is_none())
        });
        if let Some(car) = free {
            return Some((car, door));
        }
    }
    None
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
/// a vehicle on a call has finished unloading, and delivers.
pub fn car_idle(world: &mut World, events: &mut EventQueue, car: EntityId, now: GameTime) {
    let owner = match world.objects.get(car).map(|e| &e.object) {
        Some(GameObject::Car(c)) if c.role != CarRole::Private && c.trip.is_none() => c.owner,
        _ => return,
    };
    let Some(i) = world.calls.iter().position(|c| c.answered_by == Some(car)) else { return };
    let call = world.calls.remove(i);
    if let Some(entry) = world.objects.get_mut(call.at)
        && let GameObject::Building(ref mut b) = entry.object
    {
        b.stock = 1.0;
    }
    println!(
        "delivery: {:?} to building {} answered {}s after the call",
        call.kind,
        call.at,
        (now - call.raised) / 1000
    );
    // Home, if there is one to go to; a truck from beyond the edge is gone.
    let facility = matches!(world.objects.get(owner).map(|e| &e.object), Some(GameObject::Building(b)) if blueprint(b.kind).answers.is_some());
    if facility {
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
