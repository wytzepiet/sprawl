//! Call-outs: something in the town calls, and a vehicle answers.
//! docs/game.md §Goods.
//!
//! A call has a good and a place. A stock at its reorder point, with room
//! for a package, calls, and the building takes its turn: the nearest
//! depot with a package of the good on its pad and a van free, by road,
//! loads the van and it delivers. A site calls for each of its materials
//! the same way. A depot's lorry fetches from makers' yards of its own
//! accord, and what the town has to buy comes by sea (`haul`). A farm's
//! tractor is no call at all: it runs over the farm's own land
//! (`map/fields.rs`). A van stands at its depot while the forklift loads
//! it, drives to the caller, stands while the caller's unloads it
//! (`Map::lift`), and goes home. Empty pads serve nothing, and nothing a
//! van carries crosses the border, so nothing it carries is paid for.

use model::blueprint::blueprint;
use crate::economy;
use traffic::event_queue::EventQueue;
use model::GameTime;
use model::{CarRole, EntityId, GameObject, Good, DAY_MS};
use map::pathfinding::Routes;
use crate::world::World;

/// A call raised and not yet resolved.
#[derive(Debug, Clone, Copy)]
pub struct Call {
    /// The good it is for.
    pub good: Good,
    /// The building calling.
    pub at: EntityId,
    pub raised: GameTime,
    /// The van loaded for it, once one is; what it carries is its own
    /// (`Car::load`).
    pub answered_by: Option<EntityId>,
}

pub use traffic::car::SERVICE_MS;

/// A call nothing could answer is tried again in an hour
/// (`game::CALLS_AGAIN`).
pub const RETRY_MS: GameTime = DAY_MS as GameTime / 24;

/// A hand on shift at the building: a tractor goes only with someone to
/// drive it.
pub fn staffed(world: &World, building: EntityId) -> bool {
    world.map.objects.iter().any(|e| matches!(e.object, GameObject::Resident(ref r) if r.at == Some(building) && r.selected == Some(model::needs::Need::Work)))
}

/// What a building is short of and calls for: a site, each material not
/// yet in; a standing building that is no depot, every shelf its row buys
/// under its reorder point, with room for a package of it.
fn wants(world: &World, building: EntityId) -> Vec<Good> {
    let Some(b) = world.map.building(building) else { return Vec::new() };
    if let Some(site) = &b.site {
        return site.iter().filter(|(_, s)| s.short() > 0.0).map(|(&g, _)| g).collect();
    }
    if model::blueprint::depot(b.kind) {
        return Vec::new();
    }
    b.stocks.iter().filter(|&(&g, s)| economy::buys(b.kind, g) && s.level < economy::reorder(world, building, g) && economy::whole(s.short(), g) > 0).map(|(&g, _)| g).collect()
}

/// A stock changed, or time passed: the building takes its turn. A
/// stock at its reorder point calls for a delivery; a depot wakes its
/// lorries; and a farm with a hand on shift, room in the yard and a ripe
/// field sends the tractor.
pub fn turn(world: &mut World, events: &mut EventQueue, building: EntityId, now: GameTime) {
    let Some(b) = world.map.building(building) else { return };
    let kind = b.kind;
    if b.site.is_none() && model::blueprint::farm(kind) {
        world.farm_run(events, building, now);
    }
    let mut calls: Vec<Call> = wants(world, building).into_iter().map(|good| Call { good, at: building, raised: now, answered_by: None }).collect();
    if model::blueprint::depot(kind) {
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
    let ids: Vec<EntityId> = world.map.objects.iter().filter(|e| matches!(e.object, GameObject::Building(_))).map(|e| e.id).collect();
    for id in ids {
        turn(world, events, id, now);
        world.map.unsettled.insert(id);
    }
}

/// Does this building have something on every shelf its taps sell from?
/// A building that keeps no shelf always does; a site never does.
pub fn stocked(world: &World, building: EntityId) -> bool {
    match world.map.objects.get(building).map(|e| &e.object) {
        Some(GameObject::Building(b)) => b.site.is_none() && blueprint(b.kind).taps.iter().all(|t| t.need.good().and_then(|g| b.stocks.get(&g)).is_none_or(|s| s.level > 0.0)),
        _ => false,
    }
}

/// Load a van for every open call that one can be found for: as many
/// packages as the caller has room for, up to a vanload, lifted on at its
/// depot. A call nothing can answer yet waits for the next van to come
/// home.
pub fn dispatch(world: &mut World, events: &mut EventQueue, now: GameTime) {
    // A caller that has gone, or a vehicle that has, ends or reopens the call.
    world.calls.retain(|c| world.map.objects.get(c.at).is_some());
    for c in &mut world.calls {
        if c.answered_by.is_some_and(|car| world.map.objects.get(car).is_none()) {
            c.answered_by = None;
        }
    }
    for i in 0..world.calls.len() {
        let Call { good, at, answered_by, .. } = world.calls[i];
        if answered_by.is_some() || world.map.street_of(at).is_none() {
            continue;
        }
        let room = match world.map.objects.get(at).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.site.as_ref().unwrap_or(&b.stocks).get(&good).map_or(0, |s| economy::whole(s.short(), good)),
            _ => continue,
        };
        let answered = nearest_seller(world, at, good, now).map(|(depot, van)| {
            let n = economy::loaded(world, depot, good, room.min(economy::VAN_LOAD));
            load(world, van, Some((good, n as f64 * good.per_package())));
            let ready = world.map.lift(depot, van, good, n, true, now);
            events.wake(ready - now, van);
            turn(world, events, depot, now);
            van
        });
        world.calls[i].answered_by = answered;
    }
    if world.calls.iter().any(|c| c.answered_by.is_none()) {
        events.wake(RETRY_MS, crate::game::CALLS_AGAIN);
    }
}

/// The building's turn: the nearest depot with a package of the good on
/// its pad and a van standing free, by road: the depot and its van.
/// `None` where none can be reached.
fn nearest_seller(world: &mut World, at: EntityId, good: Good, now: GameTime) -> Option<(EntityId, EntityId)> {
    // Every depot with the good on its pad, in id order, so two runs of
    // the same town make the same choice.
    let depots: Vec<EntityId> = world.map
        .of_kinds(model::blueprint::depot)
        .into_iter()
        .filter(|&(id, b)| id != at && b.stocks.get(&good).is_some_and(|s| economy::whole(s.level, good) > 0))
        .map(|(id, _)| id)
        .collect();
    let vans: Vec<(EntityId, EntityId, EntityId)> = depots.into_iter().filter_map(|d| free_vehicle(world, d, CarRole::Van, now).map(|(van, door)| (d, van, door))).collect();
    let door = world.map.street_of(at)?;
    let mut routes = Routes::from(&world.map, door);
    vans.into_iter()
        .filter_map(|(depot, van, from)| Some((if from == door { 0.0 } else { routes.cost_to(from)? }, depot, van)))
        .min_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)))
        .map(|(_, depot, van)| (depot, van))
}

/// A facility's vehicle of a role standing free in its yard, no forklift
/// at it, and the driveway it leaves from. None where no road reaches the
/// yard.
fn free_vehicle(world: &mut World, facility: EntityId, role: CarRole, now: GameTime) -> Option<(EntityId, EntityId)> {
    let door = world.map.street_of(facility)?;
    world.map.stable(facility);
    let car = world.map.objects.fleet(facility).find(|&car| {
        world.map.claims.get(&car).is_none_or(|&b| b == facility)
            && !world.calls.iter().any(|c| c.answered_by == Some(car))
            && matches!(world.map.objects.get(car).map(|e| &e.object), Some(GameObject::Car(c)) if c.role == role && c.trip.is_none() && c.run.is_none() && c.load.is_none() && c.due <= now)
    })?;
    Some((car, door))
}

/// Put a load on a vehicle, or take it off; what it carried.
pub fn load(world: &mut World, car: EntityId, load: Option<(Good, f64)>) -> Option<(Good, f64)> {
    match world.map.objects.get_mut(car).map(|e| &mut e.object) {
        Some(GameObject::Car(c)) => std::mem::replace(&mut c.load, load),
        _ => None,
    }
}

/// A vehicle woke while parked. Private cars have nothing to think about;
/// the ferry keeps the harbour's time; a depot's lorry is on its rounds
/// (`haul`); one standing for a forklift waits for it; a van loaded at
/// home for a call sets out, and one at the caller's door is unloaded
/// there; and one home in its yard with nothing to do is filled there
/// (`economy::refilled`).
pub fn car_idle(world: &mut World, events: &mut EventQueue, car: EntityId, now: GameTime) {
    let (owner, run, role) = match world.map.objects.get(car) {
        Some(e) => match e.object {
            GameObject::Car(ref c) if c.role != CarRole::Private && c.trip.is_none() => (c.owner, c.run.is_some(), c.role),
            _ => return,
        },
        None => return,
    };
    match role {
        CarRole::Ferry => return world.ferry_wake(events, car, now),
        CarRole::Tractor if run => return world.tractor_step(events, car, now),
        _ => {}
    }
    if !world.map.handled(car, now) {
        let due = world.map.car(car).map_or(now, |c| c.due);
        events.wake(due - now, car);
        return;
    }
    if role == CarRole::Truck {
        crate::haul::lorry_wake(world, events, car, now);
        return;
    }
    let at = world.map.claims.get(&car).copied().unwrap_or(owner);
    let call = world.calls.iter().position(|c| c.answered_by == Some(car));
    match call {
        // Loaded at home for a call: out to the caller, as soon as the
        // street lets it.
        Some(i) if at == owner => {
            let to = world.calls[i].at;
            let gone = world.map.street_of(owner).is_some_and(|door| world.drive(events, |t, e| traffic::car::spawn::start_trip(t, e, car, door, to, now, GameTime::MAX)));
            if !gone {
                events.wake(SERVICE_MS, car);
            }
        }
        // At the caller's door: what fits, whole, is lifted off onto its
        // pad, and the van stands while it is; then it goes home.
        Some(i) => {
            let call = world.calls.remove(i);
            // How long it took, from the call to the load landing: the
            // lead time the next reorder point covers.
            world.books.entry(call.at).or_default().lead = Some(now - call.raised);
            let units = load(world, car, None).map_or(0.0, |(_, u)| u);
            let left = economy::delivered(world, call.at, call.good, units);
            if left > 0.0 {
                load(world, car, Some((call.good, left)));
            }
            let n = economy::whole(units - left, call.good);
            let done = world.map.lift(call.at, car, call.good, n, false, now);
            events.wake((done - now).max(SERVICE_MS * (n == 0) as GameTime), car);
            // Up to the stock: a load short of the order, or a long lead,
            // leaves it under the reorder point still.
            turn(world, events, call.at, now);
            dispatch(world, events, now);
        }
        // Done somewhere else: home, as soon as the street lets it out.
        None if at != owner => {
            let home = world.map.street_of(at).is_some_and(|door| world.drive(events, |t, e| traffic::car::spawn::start_trip(t, e, car, door, owner, now, GameTime::MAX)));
            if !home {
                events.wake(SERVICE_MS, car);
            }
        }
        // Home, with whatever it never landed (its caller gone, or no
        // room there) back on the pad.
        None => {
            if let Some((good, units)) = load(world, car, None) {
                economy::delivered(world, owner, good, units);
            }
            economy::refilled(world, car, now);
            turn(world, events, owner, now);
            dispatch(world, events, now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::tests::*;
    use model::{BuildingKind, Good, DAY_MS};
    use traffic::event_queue::EventQueue;

    /// Sell `units` off a shop's shelf, as visits would, and let it call.
    fn sell(world: &mut World, events: &mut EventQueue, shop: EntityId, units: f64, now: GameTime) {
        if let Some(b) = world.map.building_mut(shop) {
            b.stocks.get_mut(&Good::Crates).unwrap().take(units);
        }
        crate::calls::turn(world, events, shop, now);
    }

    /// The first shelf, as a fraction of full.
    fn stock(world: &World, building: EntityId) -> f64 {
        let b = world.map.building(building).unwrap();
        let s = &b.stocks[&model::blueprint::shelves(b.kind)[0]];
        s.level / s.cap
    }

    /// With a warehouse in town with crates on its shelf, its own van
    /// answers, and comes home.
    #[test]
    fn a_warehouse_sends_its_own_truck_and_it_comes_home() {
        let mut world = street();
        let shop = build(&mut world, 20, BuildingKind::Shop);
        let warehouse = build(&mut world, 60, BuildingKind::Depot);
        let mut game = game(world);
        sell(&mut game.world, &mut game.events, shop, 50.0, 0);
        let world = &game.world;
        let truck = world.calls[0].answered_by.expect("the warehouse answers");
        assert!(matches!(world.map.objects.get(truck).unwrap().object, GameObject::Car(ref c) if c.owner == warehouse));
        // The shop learned how long a delivery from next door takes, and
        // reorders later for it.
        let before = crate::economy::reorder(world, shop, Good::Crates);

        // Out through one ring and home through another, at lot speed, on
        // top of the drive: under three hours.
        game.run_to(3 * DAY_MS as u64 / 24);
        let world = &game.world;
        assert!(world.calls.is_empty());
        let e = world.map.objects.get(truck).expect("the warehouse keeps its truck");
        assert!(matches!(e.object, GameObject::Car(ref c) if c.trip.is_none()));
        assert_eq!(e.position, world.map.objects.get(warehouse).unwrap().position, "parked back at the warehouse");
        assert_eq!(stock(world, shop), 1.0, "the shelves are full again");
        assert!(crate::economy::reorder(world, shop, Good::Crates) < before, "the shop did not learn the lead time");
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
            if let Some(b) = world.map.building_mut(depot) {
                b.stocks.get_mut(&Good::Crates).unwrap().level = 0.0;
            }
        };
        let answered_by = |world: &World| {
            let truck = world.calls.last().unwrap().answered_by?;
            Some(world.map.car(truck).unwrap().owner)
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
