//! Call-outs: something in the town calls, and a vehicle answers.
//! docs/services.md §5.
//!
//! A call has a good and a place. A stock at its reorder point calls, and
//! the building takes its turn: the nearest depot with the good on its
//! shelf and a van free, by road, delivers it. A site calls for its timber
//! the same way. A depot's own shelf of a good a maker in town makes
//! sends its lorry to fetch from the nearest maker's yard with some; what
//! the town has to buy comes by sea (`haul`). A farm's tractor is no call
//! at all: it runs over the farm's own land (`world/fields.rs`). A vehicle
//! drives to the caller, spends the service time at its door, and goes
//! home. Empty shelves serve nothing, and nothing a van carries crosses
//! the border, so nothing it carries is paid for.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::blueprint::blueprint;
use crate::economy;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::protocol::{Car, CarRole, EntityId, GameObject, Good, DAY_MS};
use crate::world::pathfinding::Routes;
use crate::world::World;

/// What a call is for, and so who answers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum CallKind {
    /// A stock at its reorder point, or a site's timber: answered by the
    /// nearest depot with the good and a van free.
    Stock,
    /// A depot's lorry out to a maker's yard for its input, and back with
    /// it. `from` says where it went.
    Fetch,
}

/// A call raised and not yet resolved.
#[derive(Debug, Clone, Copy)]
pub struct Call {
    pub kind: CallKind,
    /// The good it is for.
    pub good: Good,
    /// The building calling.
    pub at: EntityId,
    pub raised: GameTime,
    /// The vehicle on its way, once one is.
    pub answered_by: Option<EntityId>,
    /// What it carries, in units of the good: loaded at the seller's as
    /// it leaves.
    pub load: f64,
    /// Where a fetch was sent.
    pub from: Option<EntityId>,
}

/// Unloading at the door: ten minutes.
pub const SERVICE_MS: GameTime = DAY_MS as GameTime / 144;

/// A call nothing could answer is tried again in an hour. The wake that
/// is nobody's, like midnight.
pub const RETRY_MS: GameTime = DAY_MS as GameTime / 24;
pub const RETRY: EntityId = EntityId::MAX - 1;

/// A hand on shift at the building: a tractor goes only with someone to
/// drive it.
pub fn staffed(world: &World, building: EntityId) -> bool {
    world.objects.iter().any(|e| matches!(e.object, GameObject::Resident(ref r) if r.at == Some(building) && r.selected == Some(crate::needs::Need::Work)))
}

/// What a building is short of and calls for: a site, its timber; a
/// standing building, every shelf its row buys under its reorder point.
fn wants(world: &World, building: EntityId) -> Vec<Good> {
    let Some(GameObject::Building(b)) = world.objects.get(building).map(|e| &e.object) else { return Vec::new() };
    if let Some(site) = b.site {
        return if site.short() > 0.0 { vec![Good::Timber] } else { Vec::new() };
    }
    // A depot that sells a good fetches it whenever it has room for a
    // load, so what makers make goes through it and out to the world.
    let selling = |g: &Good, s: &crate::needs::Stock| b.rules.get(g).is_some_and(|r| r.sell.is_some()) && s.short() >= g.per_box() / 2.0;
    b.stocks.iter().filter(|&(&g, s)| economy::buys(b.kind, g) && (s.level < economy::reorder(world, building, g) || selling(&g, s))).map(|(&g, _)| g).collect()
}

/// A stock changed, or time passed: the building takes its turn. A
/// stock at its reorder point calls — a depot's own shelf of what a maker
/// in town makes for a fetch, anything else for a delivery; a depot reads
/// its rules (`haul::top_up`); and a farm with a hand on shift, room in
/// the yard and a ripe field sends the tractor.
pub fn turn(world: &mut World, events: &mut EventQueue, building: EntityId, now: GameTime) {
    let Some(GameObject::Building(b)) = world.objects.get(building).map(|e| &e.object) else { return };
    let kind = b.kind;
    if b.site.is_none() && economy::farm(kind) {
        world.farm_run(events, building, now);
    }
    let mut calls = Vec::new();
    for good in wants(world, building) {
        // A depot fetches only what a maker in town makes; what the town
        // buys comes by sea, booked by its rules.
        let depot = economy::depot(kind);
        if depot && !crate::protocol::BuildingKind::ALL.into_iter().any(|k| economy::makes(k, good)) {
            continue;
        }
        let kind_of_call = if depot { CallKind::Fetch } else { CallKind::Stock };
        calls.push(Call { kind: kind_of_call, good, at: building, raised: now, answered_by: None, load: 0.0, from: None });
    }
    if economy::depot(kind) {
        crate::haul::top_up(world, building);
        crate::haul::call_lorries(world, events);
    }
    // One call a good a building: a vehicle already on its way keeps its
    // call; every call nothing has answered yet gives way to what the
    // stock says now.
    calls.retain(|c| !world.calls.iter().any(|o| o.at == c.at && o.good == c.good && o.answered_by.is_some()));
    world.calls.retain(|o| !(o.at == building && o.answered_by.is_none()));
    if !calls.is_empty() {
        world.calls.extend(calls);
        dispatch(world, events, now);
    }
}

/// Midnight: every building takes its turn, so a row nobody visits still
/// draws, and every line reads the labour market at the next settle.
pub fn turns(world: &mut World, events: &mut EventQueue, now: GameTime) {
    let ids: Vec<EntityId> = world.objects.iter().filter(|e| matches!(e.object, GameObject::Building(_))).map(|e| e.id).collect();
    for id in ids {
        turn(world, events, id, now);
        world.unsettled.insert(id);
    }
}

/// Does this building have something on every shelf its taps sell from?
/// A building that keeps no shelf always does; a site never does.
pub fn stocked(world: &World, building: EntityId) -> bool {
    match world.objects.get(building).map(|e| &e.object) {
        Some(GameObject::Building(b)) => b.site.is_none() && blueprint(b.kind).taps.iter().all(|t| t.need.good().and_then(|g| b.stocks.get(&g)).is_none_or(|s| s.level > 0.0)),
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
        if answered_by.is_some() || world.street_of(at).is_none() {
            continue;
        }
        let order = match world.objects.get(at).map(|e| &e.object) {
            Some(GameObject::Building(b)) => match b.site {
                Some(site) => site.short(),
                None => b.stocks.get(&good).map_or(0.0, |s| s.short()),
            },
            _ => continue,
        };
        let answered = match kind {
            // The depot's own lorry goes to the nearest maker's yard with
            // the good, and back with it.
            CallKind::Fetch => free_vehicle(world, at, CarRole::Truck).and_then(|(car, door)| {
                let seller = nearest_source(world, at, good)?;
                crate::car::spawn::start_trip(world, events, car, door, seller, now, GameTime::MAX).then(|| {
                    world.calls[i].from = Some(seller);
                    car
                })
            }),
            CallKind::Stock => nearest_seller(world, at, good).and_then(|(depot, van, door)| {
                crate::car::spawn::start_trip(world, events, van, door, at, now, GameTime::MAX).then(|| {
                    world.calls[i].load = economy::loaded(world, depot, good, order);
                    van
                })
            }),
        };
        world.calls[i].answered_by = answered;
    }
    if world.calls.iter().any(|c| c.answered_by.is_none()) {
        events.wake(RETRY_MS, RETRY);
    }
}

/// The nearest maker's yard in town with the good on it, by road. `None`
/// where nothing can be reached.
fn nearest_source(world: &World, at: EntityId, good: Good) -> Option<EntityId> {
    let door = world.street_of(at)?;
    let mut routes = Routes::from(world, door);
    let sources: Vec<EntityId> = world
        .objects
        .iter()
        .filter(|e| e.id != at && matches!(e.object, GameObject::Building(ref b) if economy::source(b.kind, good) && b.stocks.get(&good).is_some_and(|s| s.level > 0.0)))
        .map(|e| e.id)
        .collect();
    sources
        .into_iter()
        .filter_map(|seller| Some((routes.cost_to(world.street_of(seller)?)?, seller)))
        .min_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)))
        .map(|(_, s)| s)
}

/// The building's turn: the nearest depot with the good on its shelf and
/// a van standing free, by road: the depot, its van, and the driveway it
/// leaves from. `None` where none can be reached.
fn nearest_seller(world: &mut World, at: EntityId, good: Good) -> Option<(EntityId, EntityId, EntityId)> {
    // Every depot with the good on its shelf, in id order, so two runs of
    // the same town make the same choice.
    let depots: Vec<EntityId> = world
        .objects
        .iter()
        .filter(|e| e.id != at && matches!(e.object, GameObject::Building(ref b) if economy::depot(b.kind) && b.stocks.get(&good).is_some_and(|s| s.level > 0.0)))
        .map(|e| e.id)
        .collect();
    let vans: Vec<(EntityId, EntityId, EntityId)> = depots.into_iter().filter_map(|d| free_vehicle(world, d, CarRole::Van).map(|(van, door)| (d, van, door))).collect();
    let door = world.street_of(at)?;
    let mut routes = Routes::from(world, door);
    vans.into_iter()
        .filter_map(|(depot, van, from)| Some((if from == door { 0.0 } else { routes.cost_to(from)? }, depot, van, from)))
        .min_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)))
        .map(|(_, depot, van, from)| (depot, van, from))
}

/// A facility's vehicles, standing in its yard from the day it is reached:
/// the ones its row lists, each in a dock; a harbour's tug by its ramp.
pub fn stable(world: &mut World, facility: EntityId) {
    let kind = match world.objects.get(facility).map(|e| &e.object) {
        Some(GameObject::Building(b)) if b.site.is_none() => b.kind,
        _ => return,
    };
    let bought = match world.objects.get(facility).map(|e| &e.object) {
        Some(GameObject::Building(b)) => b.lorries as usize,
        _ => 0,
    };
    let vehicles: Vec<CarRole> = blueprint(kind).vehicles.iter().copied().chain(std::iter::repeat_n(CarRole::Truck, bought)).collect();
    if vehicles.is_empty() {
        return;
    }
    let tile = world.objects.get(facility).and_then(|e| e.position);
    let have = fleet_of(world, facility).into_iter().filter(|&c| !matches!(world.objects.get(c).map(|e| &e.object), Some(GameObject::Car(c)) if c.role == CarRole::Ferry)).count();
    for role in vehicles.into_iter().skip(have) {
        let car = world.insert_at(GameObject::Car(Car::new(facility, role)), tile);
        if role == CarRole::Tug {
            continue;
        }
        world.park_in_lot(facility, car, 0);
    }
}

/// A facility's vehicle of a role standing free in its yard, and the
/// driveway it leaves from. None where no road reaches the yard.
fn free_vehicle(world: &mut World, facility: EntityId, role: CarRole) -> Option<(EntityId, EntityId)> {
    let door = world.street_of(facility)?;
    stable(world, facility);
    let car = fleet_of(world, facility).into_iter().find(|&car| {
        world.claims.get(&car).is_none_or(|&b| b == facility)
            && matches!(world.objects.get(car).map(|e| &e.object), Some(GameObject::Car(c)) if c.role == role && c.trip.is_none() && c.run.is_none() && !(role == CarRole::Truck && c.hitched.is_some_and(|t| !t.empty())))
    })?;
    Some((car, door))
}

/// The vehicles a facility owns, in id order.
fn fleet_of(world: &World, facility: EntityId) -> Vec<EntityId> {
    world.objects.iter().filter(|e| matches!(e.object, GameObject::Car(ref c) if c.owner == facility)).map(|e| e.id).collect()
}

/// A vehicle woke while parked. Private cars have nothing to think about;
/// the ferry and the tug keep the harbour's time; a depot's lorry with no
/// call is on the harbour run (`haul`); a vehicle on a call has finished
/// at a door, and delivers or loads; and one home in its yard with nothing
/// to do is filled there (`economy::refilled`).
pub fn car_idle(world: &mut World, events: &mut EventQueue, car: EntityId, now: GameTime) {
    let (owner, here, run, role) = match world.objects.get(car) {
        Some(e) => match e.object {
            GameObject::Car(ref c) if c.role != CarRole::Private && c.trip.is_none() => (c.owner, e.position, c.run.is_some(), c.role),
            _ => return,
        },
        None => return,
    };
    match role {
        CarRole::Ferry => return world.ferry_wake(events, car, now),
        CarRole::Tug => return world.tug_wake(events, car, now),
        CarRole::Tractor if run => return world.tractor_step(events, car, now),
        _ => {}
    }
    let Some(i) = world.calls.iter().position(|c| c.answered_by == Some(car)) else {
        if role == CarRole::Truck {
            crate::haul::lorry_wake(world, events, car, now);
            return;
        }
        // Done somewhere else, and not yet away: home, as soon as the
        // street lets it out.
        match world.claims.get(&car).copied().filter(|&at| at != owner) {
            Some(at) => {
                let home = world.street_of(at).is_some_and(|door| crate::car::spawn::start_trip(world, events, car, door, owner, now, GameTime::MAX));
                if !home {
                    events.wake(SERVICE_MS, car);
                }
            }
            None => economy::refilled(world, car, now),
        }
        return;
    };
    let call = world.calls[i];
    // At the far end of a fetch: load, and set off home with it.
    let at_seller = call.from.is_some_and(|s| here.is_some() && world.objects.get(s).and_then(|e| e.position) == here && call.load == 0.0);
    if at_seller {
        let seller = call.from.unwrap();
        let order = match world.objects.get(call.at).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.stocks.get(&call.good).map_or(0.0, |s| s.short()),
            _ => 0.0,
        };
        world.calls[i].load = economy::loaded(world, seller, call.good, order);
        turn(world, events, seller, now);
        let gone = world.street_of(seller).is_some_and(|door| crate::car::spawn::start_trip(world, events, car, door, owner, now, GameTime::MAX));
        if !gone {
            events.wake(SERVICE_MS, car);
        }
        return;
    }
    let call = world.calls.remove(i);
    // How long it took, from the call to the load landing: the lead time
    // the next reorder point covers.
    world.books.entry(call.at).or_default().lead = Some(now - call.raised);
    let left = economy::delivered(world, call.at, call.good, call.load);
    match call.kind {
        // Home from the yard: what did not fit goes back where it came from.
        CallKind::Fetch => {
            if let Some(seller) = call.from {
                economy::delivered(world, seller, call.good, left);
            }
            economy::refilled(world, car, now);
            crate::haul::call_lorries(world, events);
        }
        // At the caller's door: back to the depot, with what did not fit.
        CallKind::Stock => {
            economy::delivered(world, owner, call.good, left);
            let back = world.street_of(call.at).is_some_and(|door| crate::car::spawn::start_trip(world, events, car, door, owner, now, GameTime::MAX));
            if !back {
                events.wake(SERVICE_MS, car);
            }
            turn(world, events, owner, now);
        }
    }
    // Up to the stock: a load short of the order, or a long lead, leaves
    // it under the reorder point still.
    turn(world, events, call.at, now);
    dispatch(world, events, now);
}
