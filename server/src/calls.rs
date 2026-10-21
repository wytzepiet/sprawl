//! Call-outs: something in the town calls, and a vehicle answers.
//! docs/game.md §Goods.
//!
//! A call has a good and a place. A stock at its reorder point calls, and
//! the building takes its turn: the nearest depot with the good on its
//! shelf and a van free, by road, delivers it. A site calls for each of
//! its materials the same way. A depot's own shelf of a good a maker in town makes
//! sends its lorry to fetch from the nearest maker's yard with some; what
//! the town has to buy comes by sea (`haul`). A farm's tractor is no call
//! at all: it runs over the farm's own land (`world/fields.rs`). A vehicle
//! drives to the caller, spends the service time at its door, and goes
//! home. Empty shelves serve nothing, and nothing a van carries crosses
//! the border, so nothing it carries is paid for.

use serde::{Deserialize, Serialize};

use crate::blueprint::blueprint;
use crate::economy;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::protocol::{Car, CarRole, EntityId, GameObject, Good, DAY_MS};
use crate::world::pathfinding::Routes;
use crate::world::World;

/// What a call is for, and so who answers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CallKind {
    /// A stock at its reorder point, or a site's material: answered by the
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
    /// The vehicle on its way, once one is; what it carries is its own
    /// (`Car::load`).
    pub answered_by: Option<EntityId>,
    /// Where a fetch was sent.
    pub from: Option<EntityId>,
}

/// Unloading at the door: ten minutes.
pub const SERVICE_MS: GameTime = DAY_MS as GameTime / 144;

/// A call nothing could answer is tried again in an hour
/// (`game::CALLS_AGAIN`).
pub const RETRY_MS: GameTime = DAY_MS as GameTime / 24;

/// A hand on shift at the building: a tractor goes only with someone to
/// drive it.
pub fn staffed(world: &World, building: EntityId) -> bool {
    world.objects.iter().any(|e| matches!(e.object, GameObject::Resident(ref r) if r.at == Some(building) && r.selected == Some(crate::needs::Need::Work)))
}

/// What a building is short of and calls for: a site, each material not
/// yet in; a standing building, every shelf its row buys under its
/// reorder point.
fn wants(world: &World, building: EntityId) -> Vec<Good> {
    let Some(GameObject::Building(b)) = world.objects.get(building).map(|e| &e.object) else { return Vec::new() };
    if let Some(site) = &b.site {
        return site.iter().filter(|(_, s)| s.short() > 0.0).map(|(&g, _)| g).collect();
    }
    b.stocks.iter().filter(|&(&g, s)| economy::buys(b.kind, g) && s.level < economy::reorder(world, building, g)).map(|(&g, _)| g).collect()
}

/// A stock changed, or time passed: the building takes its turn. A
/// stock at its reorder point calls — a depot's own shelf of what a maker
/// in town makes for a fetch, anything else for a delivery; a depot wakes
/// its lorries; and a farm with a hand on shift, room in the yard and a
/// ripe field sends the tractor.
pub fn turn(world: &mut World, events: &mut EventQueue, building: EntityId, now: GameTime) {
    let Some(GameObject::Building(b)) = world.objects.get(building).map(|e| &e.object) else { return };
    let kind = b.kind;
    if b.site.is_none() && economy::farm(kind) {
        world.farm_run(events, building, now);
    }
    let mut calls = Vec::new();
    for good in wants(world, building) {
        // A depot fetches only what a maker in town makes; what the town
        // buys comes by sea, booked on the deck.
        let depot = economy::depot(kind);
        if depot && !crate::protocol::BuildingKind::ALL.into_iter().any(|k| economy::makes(k, good)) {
            continue;
        }
        let kind_of_call = if depot { CallKind::Fetch } else { CallKind::Stock };
        calls.push(Call { kind: kind_of_call, good, at: building, raised: now, answered_by: None, from: None });
    }
    if economy::depot(kind) {
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
            Some(GameObject::Building(b)) => b.site.as_ref().unwrap_or(&b.stocks).get(&good).map_or(0.0, |s| s.short()),
            _ => continue,
        };
        let answered = match kind {
            // The depot's own lorry goes to the nearest maker's yard with
            // the good, and back with it.
            CallKind::Fetch => free_vehicle(world, at, CarRole::Truck).and_then(|(car, door)| {
                let seller = nearest_source(world, at, good, order.min(good.per_box()))?;
                crate::car::spawn::start_trip(world, events, car, door, seller, now, GameTime::MAX).then(|| {
                    world.calls[i].from = Some(seller);
                    car
                })
            }),
            CallKind::Stock => nearest_seller(world, at, good).and_then(|(depot, van, door)| {
                crate::car::spawn::start_trip(world, events, van, door, at, now, GameTime::MAX).then(|| {
                    let units = economy::loaded(world, depot, good, order.min(economy::van_load(good)));
                    load(world, van, Some((good, units)));
                    van
                })
            }),
        };
        world.calls[i].answered_by = answered;
        if answered.is_none() && kind == CallKind::Stock {
            crate::missions::sense(world, crate::missions::When::Short(good), now);
        }
    }
    if world.calls.iter().any(|c| c.answered_by.is_none()) {
        events.wake(RETRY_MS, crate::game::CALLS_AGAIN);
    }
}

/// The nearest maker's yard in town with a load of the good on it, by
/// road: a lorry goes for a load, not for the last shift's handful.
/// `None` where nothing can be reached.
fn nearest_source(world: &World, at: EntityId, good: Good, load: f64) -> Option<EntityId> {
    let door = world.street_of(at)?;
    let mut routes = Routes::from(world, door);
    let sources: Vec<EntityId> = world
        .objects
        .iter()
        .filter(|e| e.id != at && matches!(e.object, GameObject::Building(ref b) if economy::source(b.kind, good) && b.stocks.get(&good).is_some_and(|s| s.level > 0.0 && s.level >= load)))
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
    let have = world.objects.fleet(facility).filter(|&c| !matches!(world.objects.get(c).map(|e| &e.object), Some(GameObject::Car(c)) if c.role == CarRole::Ferry)).count();
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
    let car = world.objects.fleet(facility).find(|&car| {
        world.claims.get(&car).is_none_or(|&b| b == facility)
            && matches!(world.objects.get(car).map(|e| &e.object), Some(GameObject::Car(c)) if c.role == role && c.trip.is_none() && c.run.is_none() && !(role == CarRole::Truck && c.hitched.is_some()))
    })?;
    Some((car, door))
}

/// Put a load on a vehicle, or take it off; what it carried.
pub fn load(world: &mut World, car: EntityId, load: Option<(Good, f64)>) -> Option<(Good, f64)> {
    match world.objects.get_mut(car).map(|e| &mut e.object) {
        Some(GameObject::Car(c)) => std::mem::replace(&mut c.load, load),
        _ => None,
    }
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
            // Home, with whatever it never landed (its caller gone) back
            // on the shelf.
            None => {
                if let Some((good, units)) = load(world, car, None) {
                    economy::delivered(world, owner, good, units);
                }
                economy::refilled(world, car, now)
            }
        }
        return;
    };
    let call = world.calls[i];
    // At the far end of a fetch: load, and set off home with it.
    let empty = matches!(world.objects.get(car).map(|e| &e.object), Some(GameObject::Car(c)) if c.load.is_none());
    let at_seller = call.from.is_some_and(|s| here.is_some() && world.objects.get(s).and_then(|e| e.position) == here && empty);
    if at_seller {
        let seller = call.from.unwrap();
        let order = match world.objects.get(call.at).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.stocks.get(&call.good).map_or(0.0, |s| s.short()),
            _ => 0.0,
        };
        let units = economy::loaded(world, seller, call.good, order);
        load(world, car, Some((call.good, units)));
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
    let units = load(world, car, None).map_or(0.0, |(_, u)| u);
    let left = economy::delivered(world, call.at, call.good, units);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::tests::*;
    use crate::protocol::{BuildingKind, Good, DAY_MS};
    use crate::engine::event_queue::EventQueue;

    /// Sell `units` off a shop's shelf, as visits would, and let it call.
    fn sell(world: &mut World, events: &mut EventQueue, shop: EntityId, units: f64, now: GameTime) {
        if let Some(GameObject::Building(b)) = world.objects.get_mut(shop).map(|e| &mut e.object) {
            b.stocks.get_mut(&Good::Crates).unwrap().take(units);
        }
        crate::calls::turn(world, events, shop, now);
    }

    /// The first shelf, as a fraction of full.
    fn stock(world: &World, building: EntityId) -> f64 {
        match world.objects.get(building).unwrap().object {
            GameObject::Building(ref b) => {
                let s = &b.stocks[&crate::economy::shelves(b.kind)[0]];
                s.level / s.cap
            }
            _ => unreachable!(),
        }
    }

    /// With a warehouse in town with crates on its shelf, its own van
    /// answers, and comes home.
    #[test]
    fn a_warehouse_sends_its_own_truck_and_it_comes_home() {
        let mut world = street();
        let shop = build(&mut world, 20, BuildingKind::Shop);
        let warehouse = build(&mut world, 60, BuildingKind::Depot);
        let mut events = EventQueue::new();
        sell(&mut world, &mut events, shop, 35.0, 0);
        let truck = world.calls[0].answered_by.expect("the warehouse answers");
        assert!(matches!(world.objects.get(truck).unwrap().object, GameObject::Car(ref c) if c.owner == warehouse));
        // The shop learned how long a delivery from next door takes, and
        // reorders later for it.
        let before = crate::economy::reorder(&world, shop, Good::Crates);

        // Out through one ring and home through another, at lot speed, on
        // top of the drive: under three hours.
        pump(&mut world, &mut events, 0, 3 * DAY_MS as u64 / 24);
        assert!(world.calls.is_empty());
        let e = world.objects.get(truck).expect("the warehouse keeps its truck");
        assert!(matches!(e.object, GameObject::Car(ref c) if c.trip.is_none()));
        assert_eq!(e.position, world.objects.get(warehouse).unwrap().position, "parked back at the warehouse");
        assert_eq!(stock(&world, shop), 1.0, "the shelves are full again");
        assert!(crate::economy::reorder(&world, shop, Good::Crates) < before, "the shop did not learn the lead time");
    }

    /// The building's turn: a buyer takes the nearest seller with stock,
    /// by road. Of two depots the nearer answers; one with an empty shelf
    /// is no seller, and the farther answers; with nothing in town on a
    /// shelf, nobody does: the world comes only by sea.
    #[test]
    fn a_buyer_takes_the_nearest_seller_with_stock() {
        let mut world = street();
        let shop = build(&mut world, 20, BuildingKind::Shop);
        let near = build(&mut world, 30, BuildingKind::Depot);
        let far = build(&mut world, 60, BuildingKind::Depot);
        let mut events = EventQueue::new();
        let empty = |world: &mut World, depot: EntityId| {
            if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
                b.stocks.get_mut(&Good::Crates).unwrap().level = 0.0;
            }
        };
        let answered_by = |world: &World| {
            let truck = world.calls.last().unwrap().answered_by?;
            match world.objects.get(truck).unwrap().object {
                GameObject::Car(ref c) => Some(c.owner),
                _ => unreachable!(),
            }
        };
        sell(&mut world, &mut events, shop, 35.0, 0);
        assert_eq!(answered_by(&world), Some(near), "the nearer depot did not answer");
        // The order stands until it lands; another shop asks fresh.
        let other = build(&mut world, 24, BuildingKind::Shop);
        empty(&mut world, near);
        sell(&mut world, &mut events, other, 35.0, 0);
        assert_eq!(answered_by(&world), Some(far), "an empty shelf answered");
        let third = build(&mut world, 10, BuildingKind::Shop);
        empty(&mut world, far);
        sell(&mut world, &mut events, third, 35.0, 0);
        assert_eq!(answered_by(&world), None, "with nothing in town somebody answered");
    }
}
