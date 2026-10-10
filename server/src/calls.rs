//! Call-outs: something in the city calls, and a vehicle answers.
//! docs/services.md §5.
//!
//! A call has a good and a place. A stock at its reorder point calls, and
//! the building takes its turn: the nearest depot with the good on its
//! shelf and a van free, by road, delivers it; where none in town has it,
//! a lorry from the world beyond the edge does, while the town can pay
//! (docs/trade.md). A depot's own shelf running low sends its own lorry
//! to fetch: to the nearest source in town with the good, a maker's yard
//! or a port's quay, or out to the world beyond the edge, and back with
//! the load. A port's shelves are fetched by the world's ship. A farm's
//! tractor is no call at all: it runs over the farm's own land
//! (`world/fields.rs`). A maker's shelf running full calls for a lorry
//! from beyond the edge to take the load, since what nobody in town takes
//! the world buys. A vehicle drives to the caller, spends the service time
//! at its door, and goes home — or, from beyond the edge, simply goes.
//! Empty shelves serve nothing, and only what crosses the border is paid
//! for, as it lands (`economy::delivered`).

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
    /// The building's own vehicle out for its input and back with it: a
    /// depot's lorry to a maker's yard or beyond the edge. `from` says
    /// where it went; `None` is beyond the edge.
    Fetch,
    /// A lorry from beyond the edge, come for a load nobody in town
    /// bought from a maker, and gone with it.
    Pickup,
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
    /// it leaves. A lorry out for a fetch beyond the edge carries nothing
    /// it has to account for; the depot fills.
    pub load: f64,
    /// Where a fetch was sent: a seller in town, or `None` for beyond the
    /// edge.
    pub from: Option<EntityId>,
}

/// Unloading at the door: ten minutes.
pub const SERVICE_MS: GameTime = DAY_MS as GameTime / 144;

/// A call nothing could answer is tried again in an hour. The wake that
/// is nobody's, like midnight: a home calls at midnight with the
/// household's car in the driveway, and the driveway clears when they
/// leave for work.
pub const RETRY_MS: GameTime = DAY_MS as GameTime / 24;
pub const RETRY: EntityId = EntityId::MAX - 1;

fn kind_of(world: &World, building: EntityId) -> Option<crate::protocol::BuildingKind> {
    match world.objects.get(building)?.object {
        GameObject::Building(ref b) => Some(b.kind),
        _ => None,
    }
}

/// A hand on shift at the building: a tractor goes only with someone to
/// drive it.
pub fn staffed(world: &World, building: EntityId) -> bool {
    world.objects.iter().any(|e| matches!(e.object, GameObject::Resident(ref r) if r.at == Some(building) && r.selected == Some(Need::Work)))
}

/// A stock changed, or time passed: the building takes its turn. Time
/// passes at it — services drawn, a crop grown; a stock at its reorder
/// point calls for what the row buys — a depot's own shelf for a fetch,
/// anything else for a delivery; a maker's shelf with no room for the
/// next load calls for a pickup from beyond the edge,
/// since a load lands in one lump and a lump that does not fit is lost
/// (docs/economy.md §12.7); and a farm with a hand on shift, room in the
/// yard and a ripe field sends the tractor. A row never calls for what
/// its own labour makes.
pub fn turn(world: &mut World, events: &mut EventQueue, building: EntityId, now: GameTime) {
    let Some(GameObject::Building(b)) = world.objects.get(building).map(|e| &e.object) else { return };
    let kind = b.kind;
    let mut calls = Vec::new();
    let mut call = |kind: CallKind, good: Need| calls.push(Call { kind, good, at: building, raised: now, answered_by: None, load: 0.0, from: None });
    if let Some(make) = blueprint(kind).makes
        && let Some(shelf) = b.stocks.get(&make)
    {
        if shelf.short() < economy::lump(kind) {
            call(CallKind::Pickup, make);
        }
    }
    // A farm's tractor sets out on a run, with a hand to drive it.
    if economy::farm(kind) {
        world.farm_run(events, building, now);
    }
    let Some(GameObject::Building(b)) = world.objects.get(building).map(|e| &e.object) else { return };
    for (&good, stock) in &b.stocks {
        if economy::buys(kind, good) && stock.level < economy::reorder(world, building, good) {
            call(if economy::depot(kind) && economy::shelves(kind).contains(&good) { CallKind::Fetch } else { CallKind::Stock }, good);
        }
    }
    // One call a good a building: a vehicle already on its way keeps its
    // call; every call nothing has answered yet gives way to what the
    // stock says now, including one for a shelf that filled meanwhile —
    // a ship lands every shelf at once, and the call for the second
    // shelf must not send it out again empty (docs/economy.md §12.10).
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
/// A building that keeps no shelf always does.
pub fn stocked(world: &World, building: EntityId) -> bool {
    match world.objects.get(building).map(|e| &e.object) {
        Some(GameObject::Building(b)) => blueprint(b.kind).taps.iter().all(|t| b.stocks.get(&t.need).is_none_or(|s| s.level > 0.0)),
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
        if world.street_of(at).is_none() {
            continue;
        }
        let Some((here, row, order)) = world.objects.get(at).and_then(|e| match e.object {
            GameObject::Building(ref b) => Some((e.position?, b.kind, b.stocks.get(&good)?.short())),
            _ => None,
        }) else {
            continue
        };
        let answered = match kind {
            // The world's ship sails in from beyond the horizon for a
            // port's shelves, while the town can pay for what it brings.
            // It belongs to nobody here; it goes when it is done.
            CallKind::Fetch if economy::ships(row) => (world.treasury > 0.0).then(|| {
                let mut ship = Car::new(at, CarRole::Ship);
                ship.away = now + crate::world::sea::SAILING;
                let ship = world.insert_at(GameObject::Car(ship), None);
                events.wake(crate::world::sea::SAILING, ship);
                ship
            }),
            // The building's own vehicle goes for its input: to a source
            // in town, or out past the edge if the town can pay for what
            // it brings back (docs/economy.md §9).
            CallKind::Fetch => free_vehicle(world, at, CarRole::Truck).and_then(|(car, door)| match nearest_source(world, at, good)? {
                Source::Edge(exit) => crate::car::spawn::leave_for_edge(world, events, car, door, exit, now).then_some(car),
                Source::Seller(seller) => crate::car::spawn::start_trip(world, events, car, door, seller, now, GameTime::MAX).then(|| {
                    world.calls[i].from = Some(seller);
                    car
                }),
            }),
            // A lorry from beyond the edge comes for the load, and belongs
            // to nobody here.
            CallKind::Pickup => world.entry_node_near(here).and_then(|entry| {
                let car = world.insert_at(GameObject::Car(Car::new(at, CarRole::Truck)), None);
                let started = crate::car::spawn::start_trip(world, events, car, entry, at, now, GameTime::MAX);
                if !started {
                    world.despawn_car(car);
                }
                started.then_some(car)
            }),
            CallKind::Stock => match nearest_seller(world, at, good) {
                Some(Seller::Depot(depot, van, door)) => crate::car::spawn::start_trip(world, events, van, door, at, now, GameTime::MAX).then(|| {
                    world.calls[i].load = economy::loaded(world, depot, good, order);
                    van
                }),
                Some(Seller::Edge(entry)) => {
                    // From beyond the edge: a lorry appears on the road out past the frontier and drives
                    // in. It belongs to nobody here; it goes when it is done.
                    let car = world.insert_at(GameObject::Car(Car::new(at, CarRole::Truck)), None);
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

/// Where a fetch goes.
enum Source {
    /// A seller in town: a maker's yard, or a port's quay.
    Seller(EntityId),
    /// Beyond the edge, by the road that leaves it.
    Edge(EntityId),
}

/// Where a building's own vehicle fetches its input from: the nearest
/// source in town with the good on it, by road — a maker's yard or a
/// port's quay (`economy::source`) — or, where none in town has it, the
/// world beyond the edge while the town can pay. `None` where nothing can
/// be reached.
fn nearest_source(world: &World, at: EntityId, good: Need) -> Option<Source> {
    let here = world.objects.get(at)?.position?;
    let door = world.street_of(at)?;
    let mut routes = Routes::from(world, door);
    let nearest = world
        .objects
        .iter()
        .filter(|e| e.id != at && matches!(e.object, GameObject::Building(ref b) if economy::source(b.kind, good) && b.stocks.get(&good).is_some_and(|s| s.level > 0.0)))
        .map(|e| e.id)
        .collect::<Vec<_>>()
        .into_iter()
        .filter_map(|seller| Some((routes.cost_to(world.street_of(seller)?)?, seller)))
        .min_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    if let Some((_, seller)) = nearest {
        return Some(Source::Seller(seller));
    }
    let entry = world.entry_node_near(here).filter(|_| world.treasury > 0.0)?;
    routes.cost_to(entry).map(|_| Source::Edge(entry))
}

/// Who delivers an order.
enum Seller {
    /// A depot, its vehicle, and the driveway it leaves from.
    Depot(EntityId, EntityId, EntityId),
    /// From beyond the edge, and the road it drives in on.
    Edge(EntityId),
}

/// The building's turn: the nearest depot with the good on its shelf and
/// a van standing free, by road; or, where none in town has one, the
/// world, by a lorry that drives in from the nearest exit, while the town
/// can pay for it. `None` where no seller can be reached.
fn nearest_seller(world: &mut World, at: EntityId, good: Need) -> Option<Seller> {
    let here = world.objects.get(at)?.position?;
    // Every depot with the good on its shelf, in id order, so two runs of
    // the same town make the same choice.
    let depots: Vec<EntityId> = world
        .objects
        .iter()
        .filter(|e| e.id != at && matches!(e.object, GameObject::Building(ref b) if economy::depot(b.kind) && economy::shelves(b.kind).contains(&good) && b.stocks.get(&good).is_some_and(|s| s.level > 0.0)))
        .map(|e| e.id)
        .collect();
    let vans: Vec<(EntityId, EntityId, EntityId)> = depots.into_iter().filter_map(|d| free_vehicle(world, d, CarRole::Van).map(|(van, door)| (d, van, door))).collect();
    let door = world.street_of(at)?;
    let mut routes = Routes::from(world, door);
    let nearest = vans
        .into_iter()
        .filter_map(|(depot, van, from)| Some((if from == door { 0.0 } else { routes.cost_to(from)? }, depot, van, from)))
        .min_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    if let Some((_, depot, van, from)) = nearest {
        return Some(Seller::Depot(depot, van, from));
    }
    let entry = world.nearest_edge(here).filter(|_| world.treasury > 0.0).and_then(|edge| world.street_of(edge))?;
    routes.cost_to(entry).map(|_| Seller::Edge(entry))
}

/// A facility's vehicles, standing in its yard from the day it is reached:
/// the ones its row lists, each in a dock.
pub fn stable(world: &mut World, facility: EntityId) {
    let kind = match world.objects.get(facility).map(|e| &e.object) {
        Some(GameObject::Building(b)) => b.kind,
        _ => return,
    };
    let vehicles = &blueprint(kind).vehicles;
    if vehicles.is_empty() {
        return;
    }
    let tile = world.objects.get(facility).and_then(|e| e.position);
    let have = fleet_of(world, facility).len();
    for &role in vehicles.iter().skip(have) {
        let car = world.insert_at(GameObject::Car(Car::new(facility, role)), tile);
        world.park_in_lot(facility, car, 0);
    }
}

/// A facility's vehicle of a role standing free in its yard, and the
/// driveway it leaves from. None where no road reaches the yard.
fn free_vehicle(world: &mut World, facility: EntityId, role: CarRole) -> Option<(EntityId, EntityId)> {
    let door = world.street_of(facility)?;
    stable(world, facility);
    let car = fleet_of(world, facility).into_iter().find(|&car| {
        matches!(world.objects.get(car).map(|e| &e.object), Some(GameObject::Car(c)) if c.role == role && c.trip.is_none() && c.run.is_none() && c.away == 0)
    })?;
    Some((car, door))
}

/// The vehicles a facility owns, in id order.
fn fleet_of(world: &World, facility: EntityId) -> Vec<EntityId> {
    let fleet: Vec<EntityId> = world
        .objects
        .iter()
        .filter(|e| matches!(e.object, GameObject::Car(ref c) if c.owner == facility))
        .map(|e| e.id)
        .collect();
    fleet
}

/// A vehicle woke while parked. Private cars have nothing to think about;
/// a vehicle on a call has finished at a door, and delivers, loads or
/// leaves; one beyond the edge comes back in, and one home from beyond
/// fills the depot, or is paid for what it took; a lorry from beyond the
/// edge that took a pickup out is paid as it leaves the map; and one home
/// in its yard with nothing to do is filled and put right there
/// (`economy::refilled`).
pub fn car_idle(world: &mut World, events: &mut EventQueue, car: EntityId, now: GameTime) {
    let (owner, away, here, run, role) = match world.objects.get(car) {
        Some(e) => match e.object {
            GameObject::Car(ref c) if c.role != CarRole::Private && c.trip.is_none() => (c.owner, c.away, e.position, c.run.is_some(), c.role),
            _ => return,
        },
        None => return,
    };
    // A tractor on its run, or a ship on its voyage, is at the next tile.
    if run {
        if role == CarRole::Ship {
            world.ship_step(events, car, now);
        } else {
            world.tractor_step(events, car, now);
        }
        return;
    }
    // Home with nothing to do: filled in the yard, at the building's
    // cost.
    let Some(i) = world.calls.iter().position(|c| c.answered_by == Some(car)) else {
        economy::refilled(world, car, now);
        return;
    };
    let call = world.calls[i];
    if away > 0 {
        // A pickup has left the map with its load: the edge pays for it.
        if call.kind == CallKind::Pickup {
            world.calls.remove(i);
            economy::exported(world, call.at, call.good, call.load, now);
            println!("pickup: {:?} from building {}, {} units, gone {}s after the call", call.good, call.at, call.load, (now - call.raised) / 1000);
            world.despawn_car(car);
            turn(world, events, call.at, now);
            dispatch(world, events, now);
            return;
        }
        // Back in from beyond the edge: over the horizon to the quay, or
        // in at the nearest exit and along the roads to the yard.
        let home = world.objects.get(owner).and_then(|e| e.position);
        let came = if role == CarRole::Ship {
            world.sail_home(events, car, now)
        } else {
            home.and_then(|p| world.entry_node_near(p))
                .is_some_and(|entry| crate::car::spawn::start_trip(world, events, car, entry, owner, now, GameTime::MAX))
        };
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
    // At the far end of a fetch, or at a maker's door for a pickup: load,
    // and set off with it.
    let at_seller = call.from.is_some_and(|s| here.is_some() && world.objects.get(s).and_then(|e| e.position) == here && call.load == 0.0);
    let at_pickup = call.kind == CallKind::Pickup && here == world.objects.get(call.at).and_then(|e| e.position);
    if at_seller || at_pickup {
        let gone = if at_pickup {
            world.calls[i].load = economy::shipped(world, call.at, call.good);
            let exit = world.objects.get(call.at).and_then(|e| e.position).and_then(|p| world.entry_node_near(p));
            match (world.street_of(call.at), exit) {
                (Some(door), Some(exit)) => crate::car::spawn::leave_for_edge(world, events, car, door, exit, now),
                _ => false,
            }
        } else {
            let seller = call.from.unwrap();
            let order = match world.objects.get(call.at).map(|e| &e.object) {
                Some(GameObject::Building(b)) => b.stocks.get(&call.good).map_or(0.0, |s| s.short()),
                _ => 0.0,
            };
            world.calls[i].load = economy::loaded(world, seller, call.good, order);
            turn(world, events, seller, now);
            world.street_of(seller).is_some_and(|door| crate::car::spawn::start_trip(world, events, car, door, owner, now, GameTime::MAX))
        };
        if !gone {
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
    // A vehicle home from a fetch or a shipment is home already.
    let facility = call.kind != CallKind::Stock || owner != call.at;
    match call.kind {
        // A lorry lands its load, from a seller in town, or from beyond
        // the edge without limit; a ship lands every shelf's worth at once.
        CallKind::Fetch => match call.from {
            Some(_) => economy::delivered(world, call.at, false, call.good, call.load, now),
            None if role == CarRole::Ship => {
                for good in kind_of(world, call.at).map(economy::shelves).unwrap_or_default() {
                    economy::delivered(world, call.at, true, good, f64::INFINITY, now);
                }
            }
            None => economy::delivered(world, call.at, true, call.good, f64::INFINITY, now),
        },
        CallKind::Pickup => {}
        CallKind::Stock => {
            economy::delivered(world, call.at, !facility, call.good, call.load, now);
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
    if role == CarRole::Ship {
        // The world's ship sails back over the horizon.
        if !world.set_sail(events, car, now) {
            world.despawn_car(car);
        }
    } else if call.kind != CallKind::Stock {
        // Nothing to do: the vehicle is in its dock, and is filled there.
        economy::refilled(world, car, now);
    } else if facility {
        let back = world
            .street_of(call.at)
            .is_some_and(|door| crate::car::spawn::start_trip(world, events, car, door, owner, now, GameTime::MAX));
        if !back {
            events.wake(SERVICE_MS, car);
        }
    } else {
        world.despawn_car(car);
    }
    dispatch(world, events, now);
}
