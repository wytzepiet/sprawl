//! Packages between the harbour, the makers and the depots
//! (docs/plan-goods.md, docs/shipping.md §Boxes and lorries).
//!
//! A depot's lorry is a flatbed that carries a few packages, and it hauls
//! of its own accord: home from the harbour's quay with what landed there
//! for the town and its depot has room for, the nearest depot's first;
//! home from a maker's yard with what the depot is short of; out to the
//! quay with what a slot going out wants, loaded at the depot, or at a
//! maker's yard. At every pad it stands while the forklift lifts its
//! packages on or off (`Map::lift`): the one simulated cost of a move,
//! and the queue at a busy pad. Nothing about an errand is remembered: a
//! lorry reads what it should do from where it is and what it carries, as
//! a resident does.

use std::collections::BTreeMap;

use model::blueprint::blueprint;

use crate::economy::whole;
use traffic::event_queue::EventQueue;
use model::GameTime;
use model::{CarRole, EntityId, GameObject, Good, Leg, Package, Sailing, Sea, Shipment};
use crate::world::World;

/// Packages a lorry's flatbed carries.
pub const LOAD: u32 = 5;

/// Every package in the world, and where it is: the shipments list, read
/// off every place a package can be.
pub fn packages(world: &World) -> Vec<(Package, Leg, Option<EntityId>)> {
    let mut out = Vec::new();
    for e in world.map.objects.iter() {
        match e.object {
            GameObject::Car(ref c) => {
                out.extend(c.booked.iter().map(|&t| (t, Leg::Booked, Some(e.id))));
                out.extend(c.deck.iter().flatten().map(|&t| (t, Leg::Aboard, Some(e.id))));
                let home = world.map.claims.get(&e.id) == Some(&c.owner);
                out.extend(c.cargo.iter().map(|&t| (t, if home { Leg::Yard } else { Leg::Hauled }, Some(e.id))));
            }
            GameObject::Building(ref b) => out.extend(b.pad.iter().map(|&t| (t, Leg::Quay, Some(e.id)))),
            _ => {}
        }
    }
    out
}

/// What is on its way to a depot of a good, booked, at sea, on the quay or
/// on a lorry, in units: as good as in stock.
/// A package for the town, for whichever depot's lorry comes first, counts
/// for every depot: a town of one depot, which is the town that has them,
/// counts it once.
pub fn incoming(world: &World, depot: EntityId, good: Good) -> f64 {
    packages(world).iter().filter(|(t, _, _)| t.to.is_none_or(|d| d == depot) && t.good == good && !t.outbound).count() as f64 * good.per_package()
}

/// The harbour a depot books through: the nearest standing, by its tile.
fn harbour_for(world: &World, depot: EntityId) -> Option<EntityId> {
    let at = world.map.objects.get(depot)?.position?;
    world.map
        .harbours
        .keys()
        .filter_map(|&h| Some((h, world.map.objects.get(h)?.position?)))
        .min_by_key(|&(h, p)| ((p.x - at.x).abs() + (p.y - at.y).abs(), h))
        .map(|(h, _)| h)
}

/// Something landed on a quay, or a slot going out was booked: every
/// lorry standing idle thinks again.
pub fn call_lorries(world: &mut World, events: &mut EventQueue) {
    let idle: Vec<EntityId> = world.map
        .objects
        .iter()
        .filter(|e| matches!(e.object, GameObject::Car(ref c) if c.role == CarRole::Truck && c.trip.is_none()))
        .map(|e| e.id)
        .collect();
    for lorry in idle {
        events.wake(0, lorry);
    }
}

/// Packages of a good a depot has room for, whole, less what is on the
/// lorry already.
fn room(world: &World, depot: EntityId, good: Good, aboard: &[Package]) -> u32 {
    let free = world.map.building(depot).and_then(|d| d.stocks.get(&good)).map_or(0, |s| whole(s.short(), good));
    free.saturating_sub(aboard.iter().filter(|t| t.good == good && !t.outbound).count() as u32)
}

/// Is this package on a quay one for the depot's lorry: the depot's, or
/// the town's, or one whose depot has gone.
fn for_depot(world: &World, t: &Package, depot: EntityId) -> bool {
    !t.outbound && (t.to == Some(depot) || t.to.is_none_or(|d| world.map.objects.get(d).is_none()))
}

/// The harbour whose quay has packages the depot's lorry should fetch,
/// ones the depot has room for, more than the other lorries on their way
/// there can take: the nearest.
fn waiting_for(world: &World, depot: EntityId, lorry: EntityId) -> Option<EntityId> {
    let at = world.map.objects.get(depot)?.position?;
    world.map
        .harbours
        .keys()
        .filter_map(|&h| {
            let b = world.map.building(h)?;
            let p = world.map.objects.get(h)?.position?;
            let fits = b.pad.iter().filter(|t| for_depot(world, t, depot) && room(world, depot, t.good, &[]) > 0).count() as u32;
            let coming = coming_for(world, h) - world.map.car(lorry).filter(|c| c.trip.as_ref().is_some_and(|t| t.destination == h)).map_or(0, |c| room_aboard(c));
            (fits > coming).then_some(((p.x - at.x).abs() + (p.y - at.y).abs(), h))
        })
        .min()
        .map(|(_, h)| h)
}

/// Places on a harbour's quay neither filled nor held. A package going
/// out holds its place from when a lorry is loaded with it, so what the
/// ferry lands never fills the quay under lorries of exports, each
/// waiting there for room the packages it waits to take would free.
pub fn quay_room(world: &World, harbour: EntityId) -> usize {
    let held: usize = world.map
        .objects
        .iter()
        .filter_map(|e| match e.object {
            GameObject::Car(ref c) if c.role == CarRole::Truck && harbour_for(world, c.owner) == Some(harbour) => Some(c.cargo.iter().filter(|t| t.outbound).count()),
            _ => None,
        })
        .sum();
    let pad = world.map.building(harbour).map_or(0, |b| b.pad.len());
    map::sea::QUAY.saturating_sub(pad + held)
}

/// Packages going out a depot's lorry may be loaded with: a load, as far
/// as its harbour's quay has room for them.
fn out_room(world: &World, depot: EntityId) -> u32 {
    harbour_for(world, depot).map_or(0, |h| quay_room(world, h) as u32).min(LOAD)
}

/// The goods slots going out at the depot's harbour want.
fn wanted_out(world: &World, depot: EntityId) -> Vec<Good> {
    harbour_for(world, depot).and_then(|h| world.map.building(h)).map_or(Vec::new(), |b| b.outgoing.iter().map(|t| t.good).collect())
}

/// A slot going out at the depot's harbour, taken to be filled with a
/// package of its good: the package as it is loaded.
fn fill_out(world: &mut World, depot: EntityId, good: Good) -> Option<Package> {
    let h = harbour_for(world, depot)?;
    let b = world.map.building_mut(h)?;
    let i = b.outgoing.iter().position(|t| t.good == good)?;
    Some(b.outgoing.remove(i))
}

/// A maker's package for its depot.
fn for_home(world: &mut World, good: Good, depot: EntityId) -> Package {
    let id = world.map.objects.reserve_id();
    Package { id, good, to: Some(depot), outbound: false, order: id, partner: None, price: 0.0 }
}

/// Is the depot under its reorder point of a good, counting what is on
/// its way: the town's own shelf comes before the world's.
fn short_of(world: &World, depot: EntityId, good: Good) -> bool {
    let Some(b) = world.map.building(depot) else { return false };
    let Some(s) = b.stocks.get(&good) else { return false };
    s.level + incoming(world, depot, good) < crate::economy::reorder(world, depot, good)
}

/// Whole packages of a good a depot has over its reorder point.
fn spare(world: &World, depot: EntityId, good: Good) -> u32 {
    world.map.building(depot).and_then(|b| b.stocks.get(&good)).map_or(0, |s| whole(s.level - crate::economy::reorder(world, depot, good), good))
}

/// The makers in town with a load in their yards of a good the depot is
/// short of, as much as it has room for up to a lorry's, or else of one a
/// slot going out wants, and whether the depot is short of it: the town's
/// own shelf before the world's, then the nearest by the tiles between
/// them. A load spoken for by an empty lorry on its way there is not the
/// yard's to offer again, so a dozen lorries do not all make for the
/// nearest farm while the others fill. A lorry is free to go to a maker
/// whenever it is empty, so a farm's endless crates for the world would
/// otherwise keep it from the sawmill's timber the town is out of.
fn makers_with_surplus(world: &World, depot: EntityId) -> Vec<(bool, EntityId)> {
    let Some(at) = world.map.objects.get(depot).and_then(|e| e.position) else { return Vec::new() };
    let out = wanted_out(world, depot);
    let mut coming: BTreeMap<EntityId, u32> = BTreeMap::new();
    for e in world.map.objects.iter() {
        if let GameObject::Car(ref c) = e.object
            && c.role == CarRole::Truck
            && c.cargo.is_empty()
            && let Some(t) = &c.trip
        {
            *coming.entry(t.destination).or_default() += LOAD;
        }
    }
    let mut makers: Vec<_> = world.map
        .objects
        .iter()
        .filter_map(|e| match e.object {
            GameObject::Building(ref b) => {
                let good = blueprint(b.kind).makes?;
                let short = short_of(world, depot, good);
                let load = if short { room(world, depot, good, &[]).min(LOAD) } else { (out.iter().filter(|&&g| g == good).count() as u32).min(out_room(world, depot)) }.min(LOAD);
                let spare = whole(b.stocks.get(&good)?.level, good).saturating_sub(coming.get(&e.id).copied().unwrap_or(0));
                let p = e.position?;
                (load > 0 && spare >= load && world.map.street_of(e.id).is_some()).then_some((!short, (p.x - at.x).abs() + (p.y - at.y).abs(), e.id))
            }
            _ => None,
        })
        .collect();
    makers.sort_unstable();
    makers.into_iter().map(|(sold, _, id)| (!sold, id)).collect()
}

/// Set out for the first of these that a trip can be started to, from
/// the depot's door: one refused, its yard full, is no reason not to go
/// to the next. Whether it went.
fn set_out(world: &mut World, events: &mut EventQueue, lorry: EntityId, door: EntityId, to: impl IntoIterator<Item = EntityId>, now: GameTime) -> bool {
    to.into_iter().any(|to| world.drive(events, |t, e| traffic::car::spawn::start_trip(t, e, lorry, door, to, now, GameTime::MAX)))
}

/// The lorry woke, parked, the forklift done with it: at the end of its
/// drive, or called. At home it has its packages for the town lifted off
/// into stock, is loaded with what a slot going out wants, and sets out if
/// there is a reason to; at a maker's yard it is loaded, and goes; at a
/// harbour it has what it brought lifted off onto the quay and what it
/// came for lifted on, and goes home.
pub fn lorry_wake(world: &mut World, events: &mut EventQueue, lorry: EntityId, now: GameTime) {
    let Some(c) = world.map.car(lorry) else { return };
    if c.trip.is_some() {
        return;
    }
    let depot = c.owner;
    let Some(home) = world.map.street_of(depot) else { return };
    let at = world.map.claims.get(&lorry).copied().unwrap_or(depot);
    if world.map.harbours.contains_key(&at) {
        return at_harbour(world, events, lorry, depot, at, now);
    }
    if at != depot {
        return at_maker(world, events, lorry, depot, at, now);
    }
    crate::economy::refilled(world, lorry, now);
    // Home: what it brought for the town is lifted off into stock; what
    // does not fit is stacked in the yard over its line.
    let cargo = world.map.car(lorry).map_or(Vec::new(), |c| c.cargo.clone());
    let (home_goods, out): (Vec<Package>, Vec<Package>) = cargo.into_iter().partition(|t| !t.outbound);
    if !home_goods.is_empty() {
        if let Some(c) = world.map.car_mut(lorry) {
            c.cargo = out;
        }
        for good in Good::ALL {
            let n = home_goods.iter().filter(|t| t.good == good).count() as u32;
            if n == 0 {
                continue;
            }
            let units = n as f64 * good.per_package();
            let left = crate::economy::delivered(world, depot, good, units);
            if let Some(s) = world.map.building_mut(depot).and_then(|b| b.stocks.get_mut(&good)) {
                s.level += left;
            }
            world.lumps.push(model::Lump { building: depot, coins: 0.0, gdp: 0.0, at: now, good: Some(good), units });
            world.map.lift(depot, lorry, good, n, false, now);
        }
        crate::calls::turn(world, events, depot, now);
        return wait(world, events, lorry, now);
    }
    let empty = world.map.car(lorry).is_none_or(|c| c.cargo.is_empty());
    // Empty: to a maker's yard for what the depot is short of; else to a
    // harbour where packages wait for it, what the town bought; else to a
    // maker's yard for what a slot going out wants. The first that lets
    // it in: one refused, its yard full, is no reason not to go to the
    // next.
    let makers = if empty { makers_with_surplus(world, depot) } else { Vec::new() };
    let short = makers.iter().filter(|m| m.0).map(|m| m.1);
    let sold = makers.iter().filter(|m| !m.0).map(|m| m.1);
    let to: Vec<EntityId> = short.chain(waiting_for(world, depot, lorry)).chain(sold).collect();
    if set_out(world, events, lorry, home, to.iter().copied(), now) {
        return;
    }
    // Still empty, and slots going out want goods the depot has whole
    // packages of over its reorder point: they are lifted on, a load at
    // most. The town's own shelf comes before the world's.
    if empty {
        let (mut loaded, most) = (0, out_room(world, depot));
        for good in wanted_out(world, depot) {
            if loaded == most || spare(world, depot, good) == 0 {
                continue;
            }
            let Some(t) = fill_out(world, depot, good) else { continue };
            crate::economy::loaded(world, depot, good, 1);
            if let Some(c) = world.map.car_mut(lorry) {
                c.cargo.push(t);
            }
            world.map.lift(depot, lorry, good, 1, true, now);
            loaded += 1;
        }
        if loaded > 0 {
            crate::calls::turn(world, events, depot, now);
            return wait(world, events, lorry, now);
        }
    }
    // With exports aboard: to the harbour. Refused anywhere, it tries
    // again in a while.
    let laden = world.map.car(lorry).is_some_and(|c| !c.cargo.is_empty());
    let harbour = laden.then(|| harbour_for(world, depot)).flatten();
    if (!to.is_empty() || harbour.is_some()) && !set_out(world, events, lorry, home, harbour, now) {
        events.wake(crate::calls::RETRY_MS, lorry);
    }
}

/// The lorry stands until its forklift is done.
fn wait(world: &World, events: &mut EventQueue, lorry: EntityId, now: GameTime) {
    let due = world.map.car(lorry).map_or(now, |c| c.due);
    events.wake(due.saturating_sub(now).max(1), lorry);
}

/// At a maker's yard: empty, it is loaded with what the depot is short of,
/// as much as it has room for, or else with what slots going out want;
/// loaded, it goes, home with what is the depot's, to the harbour with
/// what is the world's.
fn at_maker(world: &mut World, events: &mut EventQueue, lorry: EntityId, depot: EntityId, maker: EntityId, now: GameTime) {
    let cargo = world.map.car(lorry).map_or(Vec::new(), |c| c.cargo.clone());
    if !cargo.is_empty() {
        let to = if cargo.iter().any(|t| !t.outbound) { Some(depot) } else { harbour_for(world, depot) };
        let gone = to.zip(world.map.street_of(maker)).is_some_and(|(to, door)| world.drive(events, |t, e| traffic::car::spawn::start_trip(t, e, lorry, door, to, now, GameTime::MAX)));
        if !gone {
            events.wake(crate::calls::RETRY_MS, lorry);
        }
        return;
    }
    let Some(good) = world.map.building(maker).and_then(|b| blueprint(b.kind).makes) else { return go_home(world, events, lorry, maker, now) };
    let home = short_of(world, depot, good);
    let want = if home { room(world, depot, good, &[]).min(LOAD) } else { (wanted_out(world, depot).iter().filter(|&&g| g == good).count() as u32).min(out_room(world, depot)) }.min(LOAD);
    let n = crate::economy::loaded(world, maker, good, want);
    if n == 0 {
        return go_home(world, events, lorry, maker, now);
    }
    for _ in 0..n {
        let t = if home { Some(for_home(world, good, depot)) } else { fill_out(world, depot, good) };
        if let (Some(t), Some(c)) = (t, world.map.car_mut(lorry)) {
            c.cargo.push(t);
        }
    }
    world.map.lift(maker, lorry, good, n, true, now);
    crate::calls::turn(world, events, maker, now);
    wait(world, events, lorry, now);
}

/// At a harbour, in a dock: what it brought for the ferry is lifted off
/// onto the quay, as far as the quay has room; then what is on the quay
/// for its depot, that the depot has room for, is lifted on, a load at
/// most. Nothing to move, it goes home; with exports the quay has no room
/// for, it waits.
fn at_harbour(world: &mut World, events: &mut EventQueue, lorry: EntityId, depot: EntityId, harbour: EntityId, now: GameTime) {
    let cargo = world.map.car(lorry).map_or(Vec::new(), |c| c.cargo.clone());
    let quay = world.map.building(harbour).map_or(0, |b| b.pad.len());
    let (mut dropped, mut kept): (Vec<Package>, Vec<Package>) = cargo.into_iter().partition(|t| t.outbound);
    let space = map::sea::QUAY.saturating_sub(quay);
    kept.extend(dropped.split_off(space.min(dropped.len())));
    let mut taken = Vec::new();
    if let Some(b) = world.map.building(harbour) {
        for (i, t) in b.pad.iter().enumerate() {
            if kept.len() + taken.len() >= LOAD as usize {
                break;
            }
            let aboard: Vec<Package> = kept.iter().chain(taken.iter().map(|(_, t)| t)).copied().collect();
            if for_depot(world, t, depot) && room(world, depot, t.good, &aboard) > 0 {
                taken.push((i, *t));
            }
        }
    }
    if dropped.is_empty() && taken.is_empty() {
        if kept.iter().any(|t| t.outbound) {
            return events.wake(map::HANDLE_MS * LOAD as GameTime, lorry);
        }
        return go_home(world, events, lorry, harbour, now);
    }
    if let Some(b) = world.map.building_mut(harbour) {
        for &(i, _) in taken.iter().rev() {
            b.pad.remove(i);
        }
        b.pad.extend(&dropped);
    }
    // A package for the town is the depot's once its lorry has it.
    kept.extend(taken.iter().map(|&(_, t)| Package { to: Some(depot), ..t }));
    if let Some(c) = world.map.car_mut(lorry) {
        c.cargo = kept;
    }
    for good in Good::ALL {
        let off = dropped.iter().filter(|t| t.good == good).count() as u32;
        world.map.lift(harbour, lorry, good, off, false, now);
    }
    for good in Good::ALL {
        let on = taken.iter().filter(|(_, t)| t.good == good).count() as u32;
        world.map.lift(harbour, lorry, good, on, true, now);
    }
    // The ferry at the ramp may load what was dropped, or land more.
    if let Some(ferry) = world.ferry_of(harbour).filter(|&f| world.map.car(f).is_some_and(|c| c.spot.is_some())) {
        events.wake(0, ferry);
    }
    wait(world, events, lorry, now);
}

fn go_home(world: &mut World, events: &mut EventQueue, lorry: EntityId, from: EntityId, now: GameTime) {
    let Some(depot) = world.map.car(lorry).map(|c| c.owner) else { return };
    let door = world.map.street_of(from);
    let gone = door.is_some_and(|door| world.drive(events, |t, e| traffic::car::spawn::start_trip(t, e, lorry, door, depot, now, GameTime::MAX)));
    if !gone {
        events.wake(crate::calls::RETRY_MS, lorry);
    }
}

/// The sea's part of an update: every package with an order, where it is
/// and when it lands; every harbour's timetable.
pub fn sea(world: &World) -> Sea {
    let calls: BTreeMap<EntityId, Option<GameTime>> = world.map.harbours.keys().flat_map(|&h| world.ferries_of(h)).map(|f| (f, world.next_call(f))).collect();
    let shipments = packages(world)
        .into_iter()
        .map(|(t, leg, carrier)| {
            let c = carrier.and_then(|id| world.map.car(id));
            let eta = match leg {
                Leg::Booked => carrier.and_then(|f| calls.get(&f).copied().flatten()),
                Leg::Aboard => c.map(|c| c.due).filter(|_| c.is_some_and(|c| c.spot.is_none())),
                Leg::Hauled => c.and_then(|c| c.trip.as_ref()).map(|t| t.eta),
                _ => None,
            };
            Shipment { order: t.order, partner: t.partner, price: t.price, package: t.id, good: t.good, to: t.to, outbound: t.outbound, leg, carrier, at: carrier.and_then(|id| world.map.objects.get(id)?.position), eta }
        })
        .collect();
    let sailings = world.map
        .harbours
        .keys()
        .filter_map(|&harbour| {
            let h = world.map.building(harbour)?;
            let ferry = world.ferry_of(harbour)?;
            let c = world.map.car(ferry)?;
            let berthed = c.spot.is_some();
            let arrives = if berthed { c.due - traffic::sea::DWELL } else { c.due };
            let departs = arrives + traffic::sea::DWELL;
            Some(Sailing {
                harbour,
                ferry,
                arrives,
                departs,
                berthed,
                packages: c.deck.iter().flatten().count() as u32,
                settlers: c.passengers.len() as u32,
                deck: map::sea::DECK as u32,
                booked: c.booked.len() as u32,
                waiting: world.waiting_settlers(harbour).len() as u32,
                lands: world.next_ferry(harbour).and_then(|f| world.next_call(f))?,
                turn: world.turn(harbour)?,
                outgoing: h.outgoing.clone(),
            })
        })
        .collect();
    let lanes = world.lanes.as_ref().map_or(Vec::new(), |lanes| world.lines.values().flat_map(|l| &l.legs).flat_map(|leg| lanes.drawn(leg)).collect());
    Sea { shipments, sailings, lanes }
}

/// Packages the lorries on their way to a harbour have room for.
fn coming_for(world: &World, harbour: EntityId) -> u32 {
    world.map
        .objects
        .iter()
        .filter_map(|e| match e.object {
            GameObject::Car(ref c) if c.role == CarRole::Truck && c.trip.as_ref().is_some_and(|t| t.destination == harbour) => Some(room_aboard(c)),
            _ => None,
        })
        .sum()
}

/// Packages landed on a harbour's quay a lorry will take: as many as the
/// lorries on their way there or loading at it have room for; all of
/// them while a lorry stands free at home, about to come.
pub fn fetching(world: &World, harbour: EntityId) -> u32 {
    let mut room = 0;
    for e in world.map.objects.iter() {
        let GameObject::Car(ref c) = e.object else { continue };
        if c.role != CarRole::Truck {
            continue;
        }
        match &c.trip {
            Some(t) if t.destination == harbour => room += room_aboard(c),
            None if world.map.claims.get(&e.id) == Some(&harbour) => room += room_aboard(c),
            None if c.cargo.is_empty() && world.map.claims.get(&e.id) == Some(&c.owner) => return u32::MAX,
            _ => {}
        }
    }
    room
}

/// Packages a lorry has room for, what it brings in.
fn room_aboard(c: &model::Car) -> u32 {
    LOAD.saturating_sub(c.cargo.iter().filter(|t| !t.outbound).count() as u32)
}

/// What a lorry or a van costs from the world: a vehicle is an import
/// like any other, paid as it is bought.
pub const LORRY_PRICE: f64 = 40.0;
/// Vehicles a depot can keep beyond its own lorry and two vans: its yard
/// has eight docks.
pub const MORE_LORRIES: u8 = 5;

/// Buy the depot another lorry, to fetch, or another van, to deliver,
/// from the world, while its yard has a dock for one and the treasury
/// can pay. It stands in the yard at once, and goes about the depot's
/// work.
pub fn buy(world: &mut World, events: &mut EventQueue, depot: EntityId, role: CarRole, now: GameTime) {
    let treasury = world.treasury;
    let Some(b) = world.map.building_mut(depot) else { return };
    if !model::blueprint::depot(b.kind) || b.lorries + b.vans >= MORE_LORRIES || treasury < LORRY_PRICE {
        return;
    }
    match role {
        CarRole::Truck => b.lorries += 1,
        CarRole::Van => b.vans += 1,
        _ => return,
    }
    crate::economy::bought(world, depot, LORRY_PRICE, now);
    world.map.stable(depot);
    call_lorries(world, events);
    crate::calls::dispatch(world, events, now);
}

/// The sea as the server has it, for reading: the summary the client gets,
/// every harbour's quay, forklifts and ferry, and every lorry and what it
/// carries.
pub fn inspect(world: &World, now: GameTime) -> serde_json::Value {
    use serde_json::json;
    let harbours: Vec<_> = world.map
        .harbours
        .keys()
        .map(|&h| {
            let quay = world.map.building(h).map(|b| (b.pad.clone(), b.lifts.clone()));
            let ferry = world.ferry_of(h).and_then(|f| world.map.car(f).map(|c| json!({
                "id": f, "at": world.map.objects.get(f).and_then(|e| e.position), "due": c.due, "moored": c.spot.is_some(),
                "sailing": c.sail.is_some(), "deck": c.deck, "passengers": c.passengers, "booked": c.booked,
            })));
            json!({ "harbour": h, "quay": quay.as_ref().map(|q| &q.0), "lifts": quay.as_ref().map(|q| &q.1), "ferry": ferry })
        })
        .collect();
    let lorries: Vec<_> = world.map
        .objects
        .iter()
        .filter_map(|e| match e.object {
            GameObject::Car(ref c) if c.role == CarRole::Truck => Some(json!({
                "id": e.id, "depot": c.owner, "at": e.position, "to": c.trip.as_ref().map(|t| t.destination),
                "cargo": c.cargo, "due": c.due, "standing_at": world.map.claims.get(&e.id),
            })),
            _ => None,
        })
        .collect();
    let mut market = world.market.prices();
    market.goods.iter_mut().for_each(|q| q.history.clear());
    json!({ "now": now, "summary": sea(world), "market": market, "harbours": harbours, "lorries": lorries })
}
