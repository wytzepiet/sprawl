//! Packages between the harbour, the makers and the depots
//! (docs/plan-goods.md, docs/shipping.md §Boxes and lorries).
//!
//! A depot's lorry is a flatbed that carries a few packages, and it hauls
//! of its own accord: home from the harbour's quay with what landed there
//! for the town and its depot has room for, the nearest depot's first;
//! home from a maker's yard with what the depot is short of; out to the
//! quay with what a slot going out wants, loaded at the depot, or at a
//! maker's yard. At every pad it stands while the forklift lifts its
//! packages on or off (`World::lift`): the one simulated cost of a move,
//! and the queue at a busy pad. Nothing about an errand is remembered: a
//! lorry reads what it should do from where it is and what it carries, as
//! a resident does.

use std::collections::BTreeMap;

use crate::blueprint::blueprint;

use crate::economy::whole;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::protocol::{CarRole, EntityId, Errand, GameObject, Good, Leg, Package, Sailing, Sea, Shipment, Doing};
use crate::world::World;

/// Packages a lorry's flatbed carries.
pub const LOAD: u32 = 5;

/// What the mayor's lorry stands at a site for, a package of what it
/// brought: the building of it. A house is six seconds of play.
pub const BUILD_MS: GameTime = 6_000;

/// Every package in the world, and where it is: the shipments list, read
/// off every place a package can be.
pub fn packages(world: &World) -> Vec<(Package, Leg, Option<EntityId>)> {
    let mut out = Vec::new();
    for e in world.objects.iter() {
        match e.object {
            GameObject::Car(ref c) => {
                out.extend(c.booked.iter().map(|&t| (t, Leg::Booked, Some(e.id))));
                out.extend(c.deck.iter().flatten().map(|&t| (t, Leg::Aboard, Some(e.id))));
                let home = world.claims.get(&e.id) == Some(&c.owner);
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
    let at = world.objects.get(depot)?.position?;
    world
        .harbours
        .keys()
        .filter_map(|&h| Some((h, world.objects.get(h)?.position?)))
        .min_by_key(|&(h, p)| ((p.x - at.x).abs() + (p.y - at.y).abs(), h))
        .map(|(h, _)| h)
}

/// Something landed on a quay, or a slot going out was booked: every
/// lorry standing idle thinks again.
pub fn call_lorries(world: &mut World, events: &mut EventQueue) {
    let idle: Vec<EntityId> = world
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
    let free = world.building(depot).and_then(|d| d.stocks.get(&good)).map_or(0, |s| whole(s.short(), good));
    free.saturating_sub(aboard.iter().filter(|t| t.good == good && !t.outbound).count() as u32)
}

/// Is this package on a quay one for the depot's lorry: the depot's, or
/// the town's, or one whose depot has gone.
fn for_depot(world: &World, t: &Package, depot: EntityId) -> bool {
    !t.outbound && (t.to == Some(depot) || t.to.is_none_or(|d| world.objects.get(d).is_none()))
}

/// The harbour whose quay has packages the depot's lorry should fetch,
/// ones the depot has room for, more than the other lorries on their way
/// there can take: the nearest.
fn waiting_for(world: &World, depot: EntityId, lorry: EntityId) -> Option<EntityId> {
    let at = world.objects.get(depot)?.position?;
    world
        .harbours
        .keys()
        .filter_map(|&h| {
            let b = world.building(h)?;
            let p = world.objects.get(h)?.position?;
            let fits = b.pad.iter().filter(|t| for_depot(world, t, depot) && room(world, depot, t.good, &[]) > 0).count() as u32;
            let coming: u32 = world
                .objects
                .iter()
                .filter(|e| e.id != lorry)
                .filter_map(|e| match e.object {
                    GameObject::Car(ref c) if c.role == CarRole::Truck && c.errand.is_none() && !world.harbours.contains_key(&c.owner) && c.trip.as_ref().is_some_and(|t| t.destination == h) => Some(LOAD.saturating_sub(c.cargo.iter().filter(|t| !t.outbound).count() as u32)),
                    _ => None,
                })
                .sum();
            (fits > coming).then_some(((p.x - at.x).abs() + (p.y - at.y).abs(), h))
        })
        .min()
        .map(|(_, h)| h)
}

/// The goods slots going out at the depot's harbour want.
fn wanted_out(world: &World, depot: EntityId) -> Vec<Good> {
    harbour_for(world, depot).and_then(|h| world.building(h)).map_or(Vec::new(), |b| b.outgoing.iter().map(|t| t.good).collect())
}

/// A slot going out at the depot's harbour, taken to be filled with a
/// package of its good: the package as it is loaded.
fn fill_out(world: &mut World, depot: EntityId, good: Good) -> Option<Package> {
    let h = harbour_for(world, depot)?;
    let b = world.building_mut(h)?;
    let i = b.outgoing.iter().position(|t| t.good == good)?;
    Some(b.outgoing.remove(i))
}

/// A maker's package for its depot.
fn for_home(world: &mut World, good: Good, depot: EntityId) -> Package {
    let id = world.objects.reserve_id();
    Package { id, good, to: Some(depot), outbound: false, order: id, partner: None, price: 0.0 }
}

/// Is the depot under its reorder point of a good, counting what is on
/// its way: the town's own shelf comes before the world's.
fn short_of(world: &World, depot: EntityId, good: Good) -> bool {
    let Some(b) = world.building(depot) else { return false };
    let Some(s) = b.stocks.get(&good) else { return false };
    s.level + incoming(world, depot, good) < crate::economy::reorder(world, depot, good)
}

/// Whole packages of a good a depot has over its reorder point.
fn spare(world: &World, depot: EntityId, good: Good) -> u32 {
    world.building(depot).and_then(|b| b.stocks.get(&good)).map_or(0, |s| whole(s.level - crate::economy::reorder(world, depot, good), good))
}

/// The nearest maker in town with a load in its yard of a good the depot
/// is short of, as much as it has room for up to a lorry's, or else of
/// one a slot going out wants, by the tiles between them: the town's own
/// shelf before the world's. A lorry is free to go to a maker whenever it
/// is empty, so a farm's endless crates for the world would otherwise keep
/// it from the sawmill's timber the town is out of.
fn maker_with_surplus(world: &World, depot: EntityId) -> Option<EntityId> {
    let at = world.objects.get(depot)?.position?;
    let out = wanted_out(world, depot);
    world
        .objects
        .iter()
        .filter_map(|e| match e.object {
            GameObject::Building(ref b) => {
                let good = blueprint(b.kind).makes?;
                let short = short_of(world, depot, good);
                let load = if short { room(world, depot, good, &[]).min(LOAD) } else { out.iter().filter(|&&g| g == good).count() as u32 }.min(LOAD);
                (load > 0 && whole(b.stocks.get(&good)?.level, good) >= load && world.street_of(e.id).is_some()).then_some((!short, e.id, e.position?))
            }
            _ => None,
        })
        .min_by_key(|&(sold, id, p)| (sold, (p.x - at.x).abs() + (p.y - at.y).abs(), id))
        .map(|(_, id, _)| id)
}

/// The lorry woke, parked, the forklift done with it: at the end of its
/// drive, or called. At home it has its packages for the town lifted off
/// into stock, is loaded with what a slot going out wants, and sets out if
/// there is a reason to; at a maker's yard it is loaded, and goes; at a
/// harbour it has what it brought lifted off onto the quay and what it
/// came for lifted on, and goes home.
pub fn lorry_wake(world: &mut World, events: &mut EventQueue, lorry: EntityId, now: GameTime) {
    let Some(c) = world.car(lorry) else { return };
    if c.trip.is_some() {
        return;
    }
    let depot = c.owner;
    if world.harbours.contains_key(&depot) {
        return errand(world, events, lorry, now);
    }
    let Some(home) = world.street_of(depot) else { return };
    let at = world.claims.get(&lorry).copied().unwrap_or(depot);
    if world.harbours.contains_key(&at) {
        return at_harbour(world, events, lorry, depot, at, now);
    }
    if at != depot {
        return at_maker(world, events, lorry, depot, at, now);
    }
    crate::economy::refilled(world, lorry, now);
    // Home: what it brought for the town is lifted off into stock; what
    // does not fit is stacked in the yard over its line.
    let cargo = world.car(lorry).map_or(Vec::new(), |c| c.cargo.clone());
    let (home_goods, out): (Vec<Package>, Vec<Package>) = cargo.into_iter().partition(|t| !t.outbound);
    if !home_goods.is_empty() {
        if let Some(c) = world.car_mut(lorry) {
            c.cargo = out;
        }
        for good in crate::market::GOODS {
            let n = home_goods.iter().filter(|t| t.good == good).count() as u32;
            if n == 0 {
                continue;
            }
            let units = n as f64 * good.per_package();
            let left = crate::economy::delivered(world, depot, good, units);
            if let Some(s) = world.building_mut(depot).and_then(|b| b.stocks.get_mut(&good)) {
                s.level += left;
            }
            world.lumps.push(crate::protocol::Lump { building: depot, coins: 0.0, gdp: 0.0, at: now, good: Some(good), units });
            world.lift(depot, lorry, good, n, false, now);
        }
        crate::calls::turn(world, events, depot, now);
        return wait(world, events, lorry, now);
    }
    let empty = world.car(lorry).is_none_or(|c| c.cargo.is_empty());
    // Empty, and a maker in town has a load of what the depot is short of
    // or a slot going out wants: the lorry fetches it from the maker's
    // yard.
    if empty && let Some(maker) = maker_with_surplus(world, depot) {
        if !crate::car::spawn::start_trip(world, events, lorry, home, maker, now, GameTime::MAX) {
            events.wake(crate::calls::RETRY_MS, lorry);
        }
        return;
    }
    // Still empty, and slots going out want goods the depot has whole
    // packages of over its reorder point: they are lifted on, a load at
    // most. The town's own shelf comes before the world's.
    if empty {
        let mut loaded = 0;
        for good in wanted_out(world, depot) {
            if loaded == LOAD || spare(world, depot, good) == 0 {
                continue;
            }
            let Some(t) = fill_out(world, depot, good) else { continue };
            crate::economy::loaded(world, depot, good, 1);
            if let Some(c) = world.car_mut(lorry) {
                c.cargo.push(t);
            }
            world.lift(depot, lorry, good, 1, true, now);
            loaded += 1;
        }
        if loaded > 0 {
            crate::calls::turn(world, events, depot, now);
            return wait(world, events, lorry, now);
        }
    }
    // With exports aboard, or packages on a quay for the depot: to the
    // harbour.
    let laden = world.car(lorry).is_some_and(|c| !c.cargo.is_empty());
    let harbour = waiting_for(world, depot, lorry).or_else(|| laden.then(|| harbour_for(world, depot)).flatten());
    let Some(harbour) = harbour else { return };
    if !crate::car::spawn::start_trip(world, events, lorry, home, harbour, now, GameTime::MAX) {
        events.wake(crate::calls::RETRY_MS, lorry);
    }
}

/// The lorry stands until its forklift is done.
fn wait(world: &World, events: &mut EventQueue, lorry: EntityId, now: GameTime) {
    let due = world.car(lorry).map_or(now, |c| c.due);
    events.wake(due.saturating_sub(now).max(1), lorry);
}

/// At a maker's yard: empty, it is loaded with what the depot is short of,
/// as much as it has room for, or else with what slots going out want;
/// loaded, it goes, home with what is the depot's, to the harbour with
/// what is the world's.
fn at_maker(world: &mut World, events: &mut EventQueue, lorry: EntityId, depot: EntityId, maker: EntityId, now: GameTime) {
    let cargo = world.car(lorry).map_or(Vec::new(), |c| c.cargo.clone());
    if !cargo.is_empty() {
        let to = if cargo.iter().any(|t| !t.outbound) { Some(depot) } else { harbour_for(world, depot) };
        let gone = to.zip(world.street_of(maker)).is_some_and(|(to, door)| crate::car::spawn::start_trip(world, events, lorry, door, to, now, GameTime::MAX));
        if !gone {
            events.wake(crate::calls::RETRY_MS, lorry);
        }
        return;
    }
    let Some(good) = world.building(maker).and_then(|b| blueprint(b.kind).makes) else { return go_home(world, events, lorry, maker, now) };
    let home = short_of(world, depot, good);
    let want = if home { room(world, depot, good, &[]).min(LOAD) } else { wanted_out(world, depot).iter().filter(|&&g| g == good).count() as u32 }.min(LOAD);
    let n = crate::economy::loaded(world, maker, good, want);
    if n == 0 {
        return go_home(world, events, lorry, maker, now);
    }
    for _ in 0..n {
        let t = if home { Some(for_home(world, good, depot)) } else { fill_out(world, depot, good) };
        if let (Some(t), Some(c)) = (t, world.car_mut(lorry)) {
            c.cargo.push(t);
        }
    }
    world.lift(maker, lorry, good, n, true, now);
    crate::calls::turn(world, events, maker, now);
    wait(world, events, lorry, now);
}

/// At a harbour, in a dock: what it brought for the ferry is lifted off
/// onto the quay, as far as the quay has room; then what is on the quay
/// for its depot, that the depot has room for, is lifted on, a load at
/// most. Nothing to move, it goes home; with exports the quay has no room
/// for, it waits.
fn at_harbour(world: &mut World, events: &mut EventQueue, lorry: EntityId, depot: EntityId, harbour: EntityId, now: GameTime) {
    let cargo = world.car(lorry).map_or(Vec::new(), |c| c.cargo.clone());
    let quay = world.building(harbour).map_or(0, |b| b.pad.len());
    let (mut dropped, mut kept): (Vec<Package>, Vec<Package>) = cargo.into_iter().partition(|t| t.outbound);
    let space = crate::world::sea::QUAY.saturating_sub(quay);
    kept.extend(dropped.split_off(space.min(dropped.len())));
    let mut taken = Vec::new();
    if let Some(b) = world.building(harbour) {
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
            return events.wake(crate::world::HANDLE_MS * LOAD as GameTime, lorry);
        }
        return go_home(world, events, lorry, harbour, now);
    }
    if let Some(b) = world.building_mut(harbour) {
        for &(i, _) in taken.iter().rev() {
            b.pad.remove(i);
        }
        b.pad.extend(&dropped);
    }
    // A package for the town is the depot's once its lorry has it.
    kept.extend(taken.iter().map(|&(_, t)| Package { to: Some(depot), ..t }));
    if let Some(c) = world.car_mut(lorry) {
        c.cargo = kept;
    }
    for good in crate::market::GOODS {
        let off = dropped.iter().filter(|t| t.good == good).count() as u32;
        world.lift(harbour, lorry, good, off, false, now);
    }
    for good in crate::market::GOODS {
        let on = taken.iter().filter(|(_, t)| t.good == good).count() as u32;
        world.lift(harbour, lorry, good, on, true, now);
    }
    // The ferry at the ramp may load what was dropped, or land more.
    if let Some(ferry) = world.ferry_of(harbour).filter(|&f| world.car(f).is_some_and(|c| c.spot.is_some())) {
        events.wake(0, ferry);
    }
    wait(world, events, lorry, now);
}

fn go_home(world: &mut World, events: &mut EventQueue, lorry: EntityId, from: EntityId, now: GameTime) {
    let Some(depot) = world.car(lorry).map(|c| c.owner) else { return };
    let door = world.street_of(from);
    let gone = door.is_some_and(|door| crate::car::spawn::start_trip(world, events, lorry, door, depot, now, GameTime::MAX));
    if !gone {
        events.wake(crate::calls::RETRY_MS, lorry);
    }
}

/// The mayor's lorry: the harbour's.
pub fn mayors(world: &World) -> Option<EntityId> {
    world.harbours.keys().flat_map(|&h| world.objects.fleet(h)).find(|&c| world.car(c).is_some_and(|c| c.role == CarRole::Truck))
}

/// Whole packages of a good to be had at a pad: the town's on a quay, a
/// maker's or a depot's yard; or aboard the mayor's lorry.
fn to_be_had(world: &World, at: EntityId, good: Good) -> u32 {
    if let Some(c) = world.car(at) {
        return c.cargo.iter().filter(|t| t.good == good && !t.outbound).count() as u32;
    }
    let Some(b) = world.building(at) else { return 0 };
    if world.harbours.contains_key(&at) {
        return b.pad.iter().filter(|t| t.good == good && !t.outbound && t.to.is_none_or(|d| world.objects.get(d).is_none())).count() as u32;
    }
    b.stocks.get(&good).map_or(0, |s| whole(s.level, good))
}

/// Does this building take a good from the mayor's lorry: a site short
/// of it, the harbour (sold, to the world), a depot with room.
fn takes(world: &World, to: EntityId, good: Good) -> bool {
    let Some(b) = world.building(to) else { return false };
    match &b.site {
        Some(site) => site.get(&good).is_some_and(|s| s.short() > 1e-9),
        None => world.harbours.contains_key(&to) || (crate::economy::depot(b.kind) && room(world, to, good, &[]) > 0),
    }
}

/// The hand sends the mayor's lorry: so many packages of a good from a
/// pad to a building that takes them, as many as a lorry carries and the
/// pad has. Its errand before is dropped, unless it has a load aboard of
/// something else. Whether it set out.
pub fn send(world: &mut World, events: &mut EventQueue, from: EntityId, good: Good, packages: u32, to: EntityId) -> bool {
    let Some(lorry) = mayors(world) else { return false };
    let aboard = world.car(lorry).map_or(Vec::new(), |c| c.cargo.clone());
    let from = if from == lorry || aboard.iter().any(|t| t.good == good) { lorry } else { from };
    let n = packages.min(LOAD).min(to_be_had(world, from, good));
    if n == 0 || !takes(world, to, good) || (from != lorry && !aboard.is_empty()) {
        return false;
    }
    let doing = if from == lorry { Doing::Carry } else { Doing::Fetch };
    if let Some(c) = world.car_mut(lorry) {
        c.errand = Some(Errand { from, good, packages: n, to, doing });
    }
    if world.car(lorry).is_some_and(|c| c.trip.is_none()) {
        events.wake(0, lorry);
    }
    true
}

/// The mayor's lorry woke, parked, its forklift done: it does the next
/// thing its errand asks. Away from where that is, it drives there; at
/// the pad it is loaded; at a site it stands while it is built, and then
/// unloads; at the harbour what it brought is sold, onto the quay for the
/// ferry; at a depot it is lifted into stock.
fn errand(world: &mut World, events: &mut EventQueue, lorry: EntityId, now: GameTime) {
    let Some(c) = world.car(lorry) else { return };
    let Some(e) = c.errand else { return };
    let at = world.claims.get(&lorry).copied().unwrap_or(c.owner);
    let set = |world: &mut World, e: Option<Errand>| {
        if let Some(c) = world.car_mut(lorry) {
            c.errand = e;
        }
    };
    let there = match e.doing {
        Doing::Fetch => e.from,
        Doing::Carry | Doing::Build => e.to,
    };
    if at != there {
        let gone = world.street_of(at).is_some_and(|door| crate::car::spawn::start_trip(world, events, lorry, door, there, now, GameTime::MAX));
        if !gone {
            events.wake(crate::calls::RETRY_MS, lorry);
        }
        // A load to sell: the ferry in waits for it.
        if gone && world.harbours.contains_key(&there) && e.doing == Doing::Carry {
            world.wait_for(there);
        }
        return;
    }
    match e.doing {
        Doing::Fetch => {
            let n = fetch(world, events, lorry, e.from, e.good, e.packages, now);
            set(world, (n > 0).then_some(Errand { packages: n, doing: Doing::Carry, ..e }));
            wait(world, events, lorry, now);
        }
        Doing::Carry if world.building(e.to).is_some_and(|b| b.site.is_some()) => {
            let n = world.car(lorry).map_or(0, |c| c.cargo.iter().filter(|t| t.good == e.good).count()) as GameTime;
            if let Some(c) = world.car_mut(lorry) {
                c.due = now + n.max(1) * BUILD_MS;
                c.errand = Some(Errand { doing: Doing::Build, ..e });
            }
            wait(world, events, lorry, now);
        }
        Doing::Carry | Doing::Build => {
            unload(world, events, lorry, e.to, e.good, now);
            set(world, None);
            wait(world, events, lorry, now);
        }
    }
}

/// Packages of a good lifted onto the mayor's lorry at a pad: the town's
/// off the quay, or out of a yard. How many.
fn fetch(world: &mut World, events: &mut EventQueue, lorry: EntityId, at: EntityId, good: Good, packages: u32, now: GameTime) -> u32 {
    let taken: Vec<Package> = if world.harbours.contains_key(&at) {
        let mut taken = Vec::new();
        if let Some(b) = world.building_mut(at) {
            while taken.len() < packages as usize {
                let Some(i) = b.pad.iter().position(|t| t.good == good && !t.outbound && t.to.is_none()) else { break };
                taken.push(Package { to: None, ..b.pad.remove(i) });
            }
        }
        taken
    } else {
        let n = crate::economy::loaded(world, at, good, packages);
        (0..n)
            .map(|_| {
                let id = world.objects.reserve_id();
                Package { id, good, to: None, outbound: false, order: id, partner: None, price: 0.0 }
            })
            .collect()
    };
    let n = taken.len() as u32;
    if let Some(c) = world.car_mut(lorry) {
        c.cargo.extend(taken);
    }
    world.lift(at, lorry, good, n, true, now);
    if !world.harbours.contains_key(&at) {
        crate::calls::turn(world, events, at, now);
    }
    n
}

/// What the mayor's lorry carries of a good, lifted off where it is: into
/// a site, which may stand; onto the quay, sold at the market's price, for
/// the ferry; into a depot's stock. What does not fit stays aboard.
fn unload(world: &mut World, events: &mut EventQueue, lorry: EntityId, to: EntityId, good: Good, now: GameTime) {
    let cargo = world.car(lorry).map_or(Vec::new(), |c| c.cargo.clone());
    let (mine, rest): (Vec<Package>, Vec<Package>) = cargo.into_iter().partition(|t| t.good == good);
    let mut kept = rest;
    let mut off = 0;
    if world.harbours.contains_key(&to) {
        let space = crate::world::sea::QUAY.saturating_sub(world.building(to).map_or(0, |b| b.pad.len()));
        for t in mine {
            if off as usize >= space {
                kept.push(t);
                continue;
            }
            let price = world.market.deal(good, true);
            if let Some(b) = world.building_mut(to) {
                b.pad.push(Package { outbound: true, price, to: None, ..t });
            }
            off += 1;
        }
        if let Some(ferry) = world.ferry_of(to).filter(|&f| world.car(f).is_some_and(|c| c.spot.is_some())) {
            events.wake(0, ferry);
        }
    } else {
        let units = mine.len() as f64 * good.per_package();
        let left = crate::economy::delivered(world, to, good, units);
        let n = mine.len() - whole(left, good) as usize;
        off = n as u32;
        kept.extend(mine.into_iter().skip(n));
        world.lumps.push(crate::protocol::Lump { building: to, coins: 0.0, gdp: 0.0, at: now, good: Some(good), units: units - left });
        crate::calls::turn(world, events, to, now);
    }
    if let Some(c) = world.car_mut(lorry) {
        c.cargo = kept;
    }
    world.lift(to, lorry, good, off, false, now);
    world.missions.stir();
}

/// The sea's part of an update: every package with an order, where it is
/// and when it lands; every harbour's timetable.
pub fn sea(world: &World) -> Sea {
    let calls: BTreeMap<EntityId, Option<GameTime>> = world.harbours.keys().flat_map(|&h| world.ferries_of(h)).map(|f| (f, world.next_call(f))).collect();
    let shipments = packages(world)
        .into_iter()
        .map(|(t, leg, carrier)| {
            let c = carrier.and_then(|id| world.car(id));
            let eta = match leg {
                Leg::Booked => carrier.and_then(|f| calls.get(&f).copied().flatten()),
                Leg::Aboard => c.map(|c| c.due).filter(|_| c.is_some_and(|c| c.spot.is_none())),
                Leg::Hauled => c.and_then(|c| c.trip.as_ref()).map(|t| t.eta),
                _ => None,
            };
            Shipment { order: t.order, partner: t.partner, price: t.price, package: t.id, good: t.good, to: t.to, outbound: t.outbound, leg, carrier, at: carrier.and_then(|id| world.objects.get(id)?.position), eta }
        })
        .collect();
    let sailings = world
        .harbours
        .keys()
        .filter_map(|&harbour| {
            let h = world.building(harbour)?;
            let ferry = world.ferry_of(harbour)?;
            let c = world.car(ferry)?;
            let berthed = c.spot.is_some();
            let arrives = if berthed { c.due - crate::shipping::DWELL } else { c.due };
            let departs = arrives + crate::shipping::DWELL;
            Some(Sailing {
                harbour,
                ferry,
                arrives,
                departs,
                berthed,
                packages: c.deck.iter().flatten().count() as u32,
                settlers: c.passengers.len() as u32,
                deck: crate::world::sea::DECK as u32,
                booked: c.booked.len() as u32,
                waiting: world.waiting_settlers(harbour).len() as u32,
                lands: world.next_ferry(harbour).and_then(|f| world.next_call(f))?,
                turn: world.turn(harbour)?,
                outgoing: h.outgoing.clone(),
            })
        })
        .collect();
    let lanes = world.lanes.as_ref().map_or(Vec::new(), |lanes| world.lines.values().flat_map(|l| &l.legs).flat_map(|leg| lanes.drawn(leg)).collect());
    Sea { shipments, sailings, lanes, letters: crate::orders::letters(world) }
}

/// What a lorry costs from the world: a vehicle is an import like any
/// other, paid as it is bought.
pub const LORRY_PRICE: f64 = 40.0;
/// Lorries a depot can keep beyond its own: its yard has eight docks, and
/// its vans want two of them.
pub const MORE_LORRIES: u8 = 3;

/// Buy the depot another lorry from the world, while its yard has a dock
/// for one and the treasury can pay. It stands in the yard at once, and
/// goes about the depot's work.
pub fn buy_lorry(world: &mut World, events: &mut EventQueue, depot: EntityId, now: GameTime) {
    let treasury = world.treasury;
    let Some(b) = world.building_mut(depot) else { return };
    if !crate::economy::depot(b.kind) || b.lorries >= MORE_LORRIES || treasury < LORRY_PRICE {
        return;
    }
    b.lorries += 1;
    crate::economy::bought(world, depot, LORRY_PRICE, now);
    crate::calls::stable(world, depot);
    call_lorries(world, events);
}

/// The sea as the server has it, for reading: the summary the client gets,
/// every harbour's quay, forklifts and ferry, and every lorry and what it
/// carries.
pub fn inspect(world: &World, now: GameTime) -> serde_json::Value {
    use serde_json::json;
    let harbours: Vec<_> = world
        .harbours
        .keys()
        .map(|&h| {
            let quay = world.building(h).map(|b| (b.pad.clone(), b.lifts.clone()));
            let ferry = world.ferry_of(h).and_then(|f| world.car(f).map(|c| json!({
                "id": f, "at": world.objects.get(f).and_then(|e| e.position), "due": c.due, "moored": c.spot.is_some(),
                "sailing": c.sail.is_some(), "deck": c.deck, "passengers": c.passengers, "booked": c.booked,
            })));
            json!({ "harbour": h, "quay": quay.as_ref().map(|q| &q.0), "lifts": quay.as_ref().map(|q| &q.1), "ferry": ferry })
        })
        .collect();
    let lorries: Vec<_> = world
        .objects
        .iter()
        .filter_map(|e| match e.object {
            GameObject::Car(ref c) if c.role == CarRole::Truck => Some(json!({
                "id": e.id, "depot": c.owner, "at": e.position, "to": c.trip.as_ref().map(|t| t.destination),
                "cargo": c.cargo, "due": c.due, "standing_at": world.claims.get(&e.id),
            })),
            _ => None,
        })
        .collect();
    let mut market = world.market.prices();
    market.goods.iter_mut().for_each(|q| q.history.clear());
    json!({ "now": now, "summary": sea(world), "market": market, "harbours": harbours, "lorries": lorries })
}
