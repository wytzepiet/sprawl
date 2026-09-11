//! Call-outs: something in the city calls, and a vehicle answers.
//! docs/services.md §5.
//!
//! A call has a good and a place. A stock at its reorder point calls, and
//! the building takes its turn (docs/economy.md §6.2): among every seller
//! of the good it can reach — a depot with it on the shelf and a van free,
//! an office with services on its shelf and a car free, or the outside
//! beyond the edge — it takes the cheapest delivered, which is the posted
//! price in hours of its own earning plus the drive. A depot's own shelf
//! running low sends its own lorry to fetch: to the cheapest source it
//! can reach, a maker's yard in town or the world beyond the edge, and
//! back with the load; a farm's tractor fetches its ripe fields the same
//! way, at no price (§12.8). A maker's shelf running full sends its car
//! out with the load, since what nobody in town buys the edge buys
//! (§8.1), or, with no lorry of its own, calls for one from beyond the
//! edge to come and take it. A vehicle drives to the caller, spends the
//! service time at its door, and goes home — or, from beyond the edge,
//! simply goes. Empty shelves sell nothing, and every delivery is paid
//! for as it lands (`economy::delivered`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::blueprint::blueprint;
use crate::economy;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::needs::Need;
use crate::protocol::{Car, CarRole, EntityId, GameObject, GridCoord, DAY_MS};
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
    /// depot's lorry to a maker's yard or beyond the edge, a farm's
    /// tractor to a ripe field. `from` says where it went; `None` is
    /// beyond the edge.
    Fetch,
    /// A maker's own vehicle out past the edge with a load nobody in
    /// town bought, and back paid.
    Ship,
    /// A lorry from beyond the edge, come for a load nobody in town
    /// bought from a maker with no lorry of its own, and gone with it.
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

/// Who carries a good over the edge: a lorry for crates and tanks, a car
/// for someone who does the job on site.
fn lorry(good: Need) -> CarRole {
    if good == Need::Services { CarRole::Company } else { CarRole::Truck }
}

/// Who carries it the last mile from a seller in town.
fn van(good: Need) -> CarRole {
    if good == Need::Services { CarRole::Company } else { CarRole::Van }
}

/// Which of a kind's own vehicles fetches its input: the tractor where
/// it keeps one, else the lorry.
fn fetcher(kind: crate::protocol::BuildingKind) -> CarRole {
    if blueprint(kind).vehicles.contains(&CarRole::Tractor) { CarRole::Tractor } else { CarRole::Truck }
}

/// A hand on shift at the building: a tractor goes only with someone to
/// drive it.
fn staffed(world: &World, building: EntityId) -> bool {
    world.objects.iter().any(|e| matches!(e.object, GameObject::Resident(ref r) if r.at == Some(building) && r.selected == Some(Need::Work)))
}

/// Where a farm's tractor stops for a field: the track beside it, or any
/// road the field touches.
pub fn beside(world: &World, at: GridCoord) -> Option<EntityId> {
    [(0, -1), (1, 0), (0, 1), (-1, 0)].into_iter().find_map(|(dx, dy)| world.road_node_at(GridCoord { x: at.x + dx, y: at.y + dy }))
}

/// A farm's ripe fields, as the road nodes beside them. A field built
/// over since the last look is dropped first (`World::tend`).
fn ripe_fields(world: &mut World, farm: EntityId, now: GameTime) -> Vec<EntityId> {
    world.tend(farm);
    let Some(GameObject::Building(b)) = world.objects.get(farm).map(|e| &e.object) else { return Vec::new() };
    let mut nodes: Vec<EntityId> = b.fields.iter().filter(|f| economy::ripe(f, now)).filter_map(|f| beside(world, f.at)).collect();
    nodes.sort_unstable();
    nodes.dedup();
    nodes
}

/// A stock changed, or time passed: the building takes its turn. Time
/// passes at it — services drawn, a crop grown; a stock at its reorder
/// point calls for what the row buys — a depot's own shelf for a fetch,
/// anything else for a delivery; a maker's shelf with no room for the
/// next load ships to the edge, or calls for pickup if it has no lorry,
/// since a load lands in one lump and a lump that does not fit is lost
/// (docs/economy.md §12.7); and a farm with a hand on shift, room in the
/// yard and a ripe field sends the tractor. A row never calls for what
/// its own labour makes.
pub fn turn(world: &mut World, events: &mut EventQueue, building: EntityId, now: GameTime) {
    economy::passed(world, building, now);
    let Some(GameObject::Building(b)) = world.objects.get(building).map(|e| &e.object) else { return };
    let kind = b.kind;
    let mut calls = Vec::new();
    let mut call = |kind: CallKind, good: Need| calls.push(Call { kind, good, at: building, raised: now, answered_by: None, load: 0.0, from: None });
    if let Some(make) = blueprint(kind).makes
        && let Some(shelf) = b.stocks.get(&make.good)
    {
        if shelf.short() < economy::lump(kind) {
            call(if blueprint(kind).vehicles.contains(&lorry(make.good)) { CallKind::Ship } else { CallKind::Pickup }, make.good);
        } else if economy::fields(kind) > 0 && staffed(world, building) && !ripe_fields(world, building, now).is_empty() {
            call(CallKind::Fetch, make.good);
        }
    }
    let Some(GameObject::Building(b)) = world.objects.get(building).map(|e| &e.object) else { return };
    for (&good, stock) in &b.stocks {
        if economy::buys(kind, good) && stock.level < economy::reorder(world, building, good) {
            call(if economy::depot(kind) && good == economy::shelf_need(kind) { CallKind::Fetch } else { CallKind::Stock }, good);
        }
    }
    // One call a good a building: a vehicle already on its way keeps its
    // call; a call nothing has answered yet gives way to what the stock
    // says now.
    calls.retain(|c| !world.calls.iter().any(|o| o.at == c.at && o.good == c.good && o.answered_by.is_some()));
    world.calls.retain(|o| !(o.answered_by.is_none() && calls.iter().any(|c| c.at == o.at && c.good == o.good)));
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
        let Some((here, order, bk)) = world.objects.get(at).and_then(|e| match e.object {
            GameObject::Building(ref b) => Some((e.position?, b.stocks.get(&good)?.short(), b.kind)),
            _ => None,
        }) else {
            continue
        };
        let answered = match kind {
            // A maker's car sets out with what it is selling beyond the edge.
            CallKind::Ship => free_vehicle(world, at, lorry(good)).and_then(|(car, door)| {
                let exit = world.entry_node_near(here)?;
                crate::car::spawn::leave_for_edge(world, events, car, door, exit, now).then(|| {
                    world.calls[i].load = economy::shipped(world, at, good);
                    car
                })
            }),
            // The building's own vehicle goes for its input: to a source
            // in town, or out past the edge if the town can pay for what
            // it brings back (docs/economy.md §9).
            CallKind::Fetch => free_vehicle(world, at, fetcher(bk)).and_then(|(car, door)| match cheapest_source(world, at, good, now)? {
                Source::Edge(exit) => crate::car::spawn::leave_for_edge(world, events, car, door, exit, now).then_some(car),
                Source::Seller(seller) => crate::car::spawn::start_trip(world, events, car, door, seller, now, GameTime::MAX).then(|| {
                    world.calls[i].from = Some(seller);
                    car
                }),
                Source::Field(node) => crate::car::spawn::drive_to(world, events, car, door, node, now).then(|| {
                    world.calls[i].from = Some(node);
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

/// Where a fetch goes.
enum Source {
    /// A seller in town: a maker's yard.
    Seller(EntityId),
    /// A farm's own ripe field: the road node beside it.
    Field(EntityId),
    /// Beyond the edge, by the road that leaves it.
    Edge(EntityId),
}

/// Where a building's own vehicle fetches its input from: the cheapest
/// landed, which is the load at the posted price in hours of the
/// building's own earning, plus the drive there and back and the wait at
/// the far end. A farm fetches its own ripe fields, at no price, so the
/// nearest; anything else fetches from a maker's yard in town with the
/// good on it, or from beyond the edge while the town can pay. A row
/// never fetches what it makes from anyone else. `None` where nothing
/// can be reached.
fn cheapest_source(world: &mut World, at: EntityId, good: Need, now: GameTime) -> Option<Source> {
    let (order, here, kind) = match world.objects.get(at) {
        Some(e) => match e.object {
            GameObject::Building(ref b) => (b.stocks.get(&good)?.short(), e.position?, b.kind),
            _ => return None,
        },
        None => return None,
    };
    let door = world.road_node_for_building(at)?;
    if economy::fields(kind) > 0 {
        let fields = ripe_fields(world, at, now);
        let mut routes = Routes::from(world, door);
        return fields.into_iter().filter_map(|node| Some((routes.cost_to(node)?, node))).min_by(|a, b| a.0.total_cmp(&b.0)).map(|(_, node)| Source::Field(node));
    }
    let mut makers: Vec<EntityId> = world
        .objects
        .iter()
        .filter(|e| e.id != at && matches!(e.object, GameObject::Building(ref b) if economy::makes(b.kind, good) && b.stocks.get(&good).is_some_and(|s| s.level > 0.0)))
        .map(|e| e.id)
        .collect();
    makers.sort_unstable();
    let mut routes = Routes::from(world, door);
    let dear = economy::HOUR / economy::earns(world, at, now);
    let mut best: Option<(f64, Source)> = None;
    if world.treasury > 0.0
        && let Some(entry) = world.entry_node_near(here)
        && let Some(drive) = routes.cost_to(entry)
    {
        best = Some((2.0 * drive + AWAY_MS as f64 + order * economy::import(economy::wholesale(good)) * dear, Source::Edge(entry)));
    }
    for seller in makers {
        let Some(their) = world.road_node_for_building(seller) else { continue };
        let Some(drive) = routes.cost_to(their) else { continue };
        let cost = 2.0 * drive + SERVICE_MS as f64 + order * economy::price_of(world, seller, good) * dear;
        if best.as_ref().is_none_or(|(b, _)| cost < *b) {
            best = Some((cost, Source::Seller(seller)));
        }
    }
    best.map(|(_, source)| source)
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
/// a vehicle on a call has finished at a door, and delivers, loads or
/// leaves; one beyond the edge comes back in, and one home from beyond
/// fills the depot, or is paid for what it took; a lorry from beyond the
/// edge that took a pickup out is paid as it leaves the map; and one home
/// in its yard with nothing to do is filled and put right there
/// (`economy::refilled`).
pub fn car_idle(world: &mut World, events: &mut EventQueue, car: EntityId, now: GameTime) {
    let (owner, away, here) = match world.objects.get(car) {
        Some(e) => match e.object {
            GameObject::Car(ref c) if c.role != CarRole::Private && c.trip.is_none() => (c.owner, c.away, e.position),
            _ => return,
        },
        None => return,
    };
    // Home with nothing to do: filled and put right in the yard, at the
    // building's cost.
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
    // At the far end of a fetch, or at a maker's door for a pickup: load,
    // and set off with it.
    let at_seller = call.from.is_some_and(|s| here.is_some() && world.objects.get(s).and_then(|e| e.position) == here && call.load == 0.0);
    let at_pickup = call.kind == CallKind::Pickup && here == world.objects.get(call.at).and_then(|e| e.position);
    if at_seller || at_pickup {
        let gone = if at_pickup {
            world.calls[i].load = economy::shipped(world, call.at, call.good);
            let exit = world.objects.get(call.at).and_then(|e| e.position).and_then(|p| world.entry_node_near(p));
            match (world.road_node_for_building(call.at), exit) {
                (Some(door), Some(exit)) => crate::car::spawn::leave_for_edge(world, events, car, door, exit, now),
                _ => false,
            }
        } else if let Some(node) = call.from.filter(|&s| matches!(world.objects.get(s).map(|e| &e.object), Some(GameObject::RoadNode(_)))) {
            // At a field: its crop is the load, and the field starts again.
            world.calls[i].load = world.harvest(call.at, node, now);
            crate::car::spawn::start_trip(world, events, car, node, owner, now, GameTime::MAX)
        } else {
            let seller = call.from.unwrap();
            let order = match world.objects.get(call.at).map(|e| &e.object) {
                Some(GameObject::Building(b)) => b.stocks.get(&call.good).map_or(0.0, |s| s.short()),
                _ => 0.0,
            };
            world.calls[i].load = economy::loaded(world, seller, call.good, order, now);
            turn(world, events, seller, now);
            world.road_node_for_building(seller).is_some_and(|door| crate::car::spawn::start_trip(world, events, car, door, owner, now, GameTime::MAX))
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
        // A maker's car is paid for its load; a lorry lands its, from a
        // seller in town at the seller's price or from beyond the edge
        // without limit.
        CallKind::Ship => economy::exported(world, call.at, call.good, call.load, now),
        CallKind::Fetch => match call.from {
            Some(from) if matches!(world.objects.get(from).map(|e| &e.object), Some(GameObject::RoadNode(_))) => economy::harvested(world, call.at, call.load),
            Some(seller) => economy::delivered(world, call.at, Some(seller), call.good, call.load, now),
            None => economy::delivered(world, call.at, None, call.good, f64::INFINITY, now),
        },
        CallKind::Pickup => {}
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
    if call.kind != CallKind::Stock {
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
