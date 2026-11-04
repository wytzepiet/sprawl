//! The town's rules: whoever needs something goes and gets it. A family
//! drives to the nearest shop for what it wants; a shop's lorry drives to
//! whoever makes what its shelf lacks; a maker stacks its yard and waits
//! to be fetched from. Every errand is a trip on the mayor's roads, and a
//! queue in a yard shows where supply is short. A family that waits too
//! long leaves. Families moving in hand the mayor a pick: more road, or
//! another building to place.
//!
//! The map keeps what is where and traffic moves it; this decides where
//! everyone goes next.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use traffic::event_queue::EventQueue;
use model::{BuildingKind, CarRole, EntityId, GameObject, GameTime, Good, GridCoord, Home, Offer, Want};
use map::Map;
use crate::world::World;

/// A cottage's family, and what it wants: fish, about this often.
pub const PEOPLE: u32 = 2;
pub const WANT_MS: GameTime = 90_000;
/// How long a family waits on a want before it leaves.
pub const PATIENCE_MS: GameTime = 180_000;
/// A crate of fish caught, a fishery's boat out and back.
pub const FISH_MS: GameTime = 12_000;
/// How far a family drives to a shop, in tiles across and along.
pub const REACH: i32 = 24;
/// Crates a shop's lorry carries.
pub const LOAD: u32 = 10;
/// Lorries that may wait in a maker's yard.
pub const SPOTS: usize = 2;
/// How often whoever waits at a counter or a yard looks again.
const POLL_MS: GameTime = 2_000;
/// Waiting with something aboard, how long before going home with it;
/// with nothing, before giving up.
const SOME_MS: GameTime = 18_000;
const NONE_MS: GameTime = 75_000;
/// Road tiles a town starts with, each new family brings, and a pick gives.
const START_ROADS: u32 = 48;
const HOUSE_ROADS: u32 = 4;
const PICK_ROADS: u32 = 30;
/// People who move in to bring a pick.
pub const PICK_STEP: u32 = 10;

/// What the mayor has to build with, who has come and gone, and the pick
/// on the table. Saved.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Town {
    /// Road tiles the town may lay, all told: what is laid comes off it
    /// (`Map::laid`).
    pub allowance: u32,
    pub tokens: BTreeMap<BuildingKind, u32>,
    /// People who moved in, all told, and those a pick was handed for.
    pub arrived: u32,
    pub picked: u32,
    pub left: u32,
    /// Whether anyone left since the last pick: a clean stretch earns a
    /// wider choice.
    pub left_since: u32,
    pub offer: Vec<Offer>,
    pub spawned: u32,
    pub next_spawn: GameTime,
    /// Where the town began, for the camera to find it.
    pub start: Option<GridCoord>,
    roll: u64,
    /// Each car out on an errand, and how far it has got. Not saved: a
    /// loaded world's cars are all home.
    #[serde(skip)]
    errands: BTreeMap<EntityId, Errand>,
    /// Something a client shows changed.
    #[serde(skip)]
    pub changed: bool,
}

/// A car's errand: where it went for what, what it has, and since when
/// it has waited there.
#[derive(Debug, Clone)]
struct Errand {
    to: EntityId,
    /// What it went for: a family's wants, or a lorry's crates.
    want: u32,
    got: u32,
    waiting: Option<GameTime>,
    home: bool,
}

impl Town {
    pub fn has(&self, kind: BuildingKind) -> bool {
        self.tokens.get(&kind).is_some_and(|&n| n > 0)
    }

    /// The town as its mayor sees it.
    pub fn view(&self, map: &Map) -> model::Town {
        model::Town {
            roads: self.allowance.saturating_sub(map.laid),
            tokens: self.tokens.iter().filter(|(_, n)| **n > 0).map(|(&k, &n)| (k, n)).collect(),
            people: people(map),
            toward: self.arrived.saturating_sub(self.picked),
            step: PICK_STEP,
            left: self.left,
            offer: self.offer.clone(),
            start: self.start,
        }
    }

    /// A number from 0 to 1, the same on every machine.
    fn roll(&mut self) -> f64 {
        self.roll = self.roll.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.roll;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// Everyone who lives here.
pub fn people(map: &Map) -> u32 {
    map.objects.iter().filter(|e| matches!(e.object, GameObject::Building(ref b) if b.home.is_some())).count() as u32 * PEOPLE
}

/// The wake that is nobody's: the next family moving in.
pub const SPAWN: EntityId = EntityId::MAX;

// ---- the start ----------------------------------------------------------

/// A new town: a fishery on the shore nearest the island's middle, two
/// cottages a little inland, a shop in hand and road enough to join them.
pub fn found(world: &mut World, now: GameTime) {
    let map = &mut world.map;
    let town = &mut world.town;
    town.allowance = START_ROADS;
    town.tokens = BTreeMap::from([(BuildingKind::Shop, 1)]);
    town.roll = map.terrain_seed as u64;
    town.next_spawn = now + 90_000;
    let Some((fishery, at)) = shore(map) else { return };
    town.start = Some(at);
    map.finish(fishery);
    // Two cottages a little inland: dry land all round, apart.
    let mut homes: Vec<GridCoord> = Vec::new();
    'out: for r in 5..12 {
        for i in 0..8 * r {
            let (dx, dy) = ring(r, i);
            let p = GridCoord { x: at.x + dx, y: at.y + dy };
            let dry = (-3..=3).all(|ex| (-3..=3).all(|ey| matches!(map.terrain.get(&(p.x + ex, p.y + ey)), Some(land::TerrainType::Grass | land::TerrainType::Forest))));
            if dry && homes.iter().all(|h| (h.x - p.x).abs().max((h.y - p.y).abs()) >= 3) && house(map, p, now, town).is_some() {
                homes.push(p);
                if homes.len() == 2 {
                    break 'out;
                }
            }
        }
    }
}

/// The first place on a shore, out from the island's middle, a fishery
/// stands: it, standing, and its tile.
fn shore(map: &mut Map) -> Option<(EntityId, GridCoord)> {
    for r in 0..80 {
        for i in 0..(8 * r).max(1) {
            let (x, y) = ring(r, i);
            let tiles: Vec<GridCoord> = Map::footprint(GridCoord { x, y }, model::blueprint::plot(BuildingKind::Fishery, 0).size).collect();
            if !map.on_shore(&tiles) {
                continue;
            }
            for facing in 0..4 {
                if let Some(id) = map.place_building(GridCoord { x, y }, BuildingKind::Fishery, facing) {
                    return Some((id, GridCoord { x, y }));
                }
            }
        }
    }
    None
}

/// The `i`th tile round the square ring `r` tiles out from the middle.
fn ring(r: i32, i: i32) -> (i32, i32) {
    if r == 0 {
        return (0, 0);
    }
    let side = 2 * r;
    let (k, t) = (i / side, i % side);
    match k {
        0 => (-r + t, -r),
        1 => (r, -r + t),
        2 => (r - t, r),
        _ => (-r, r - t),
    }
}

/// A cottage at a tile, a family in it who will want fish soon.
fn house(map: &mut Map, at: GridCoord, now: GameTime, town: &mut Town) -> Option<EntityId> {
    let facing = map.site_for(at, BuildingKind::House).or_else(|| (0..4).find(|&f| map.may_stand_on(&Map::footprint(at, (1, 1)).collect::<Vec<_>>(), BuildingKind::House, f)))?;
    let id = map.place_building(at, BuildingKind::House, facing)?;
    // Their car, parked on the drive.
    let car = map.insert_at(GameObject::Car(model::Car::new(id, CarRole::Private)), Some(at));
    map.park_in_lot(id, car, now);
    let first = now + 9_000 + (town.roll() * 30_000.0) as GameTime;
    if let Some(b) = map.building_mut(id) {
        b.home = Some(Home { level: 1, wants: Vec::new(), due: BTreeMap::from([(Good::Fish, first)]), happy: 0 });
    }
    Some(id)
}

// ---- families moving in --------------------------------------------------

/// A family moves in beside a house already here, likelier beside a road;
/// now and then a hamlet of its own away from everyone. The next is due
/// sooner as the town grows, later while its families are kept waiting.
pub fn spawn(world: &mut World, events: &mut EventQueue, now: GameTime) {
    let town = &mut world.town;
    let map = &mut world.map;
    town.spawned += 1;
    let homes: Vec<GridCoord> = map.objects.iter().filter_map(|e| match e.object {
        GameObject::Building(ref b) if b.home.is_some() => e.position,
        _ => None,
    }).collect();
    let hamlet = town.spawned >= 8 && town.spawned % 7 == 1;
    let mut placed = None;
    if !hamlet && !homes.is_empty() {
        for _ in 0..60 {
            let h = homes[(town.roll() * homes.len() as f64) as usize % homes.len()];
            let at = GridCoord { x: h.x + ((town.roll() - 0.5) * 9.0).round() as i32, y: h.y + ((town.roll() - 0.5) * 9.0).round() as i32 };
            let by_road = map.site_for(at, BuildingKind::House).is_some();
            if (by_road || town.roll() < 0.35) && homes.iter().all(|p| p.x != at.x || p.y != at.y) {
                placed = house(map, at, now, town);
                if placed.is_some() {
                    break;
                }
            }
        }
    }
    if placed.is_none() {
        let start = town.start.unwrap_or(GridCoord { x: 0, y: 0 });
        for _ in 0..80 {
            let at = GridCoord { x: start.x + ((town.roll() - 0.5) * 48.0) as i32, y: start.y + ((town.roll() - 0.5) * 48.0) as i32 };
            let near = homes.iter().map(|p| (p.x - at.x).abs().max((p.y - at.y).abs())).min().unwrap_or(99);
            if (10..=18).contains(&near) {
                placed = house(map, at, now, town);
                if placed.is_some() {
                    break;
                }
            }
        }
    }
    if let Some(id) = placed {
        town.arrived += PEOPLE;
        town.allowance += HOUSE_ROADS;
        town.changed = true;
        events.wake(0, id);
        offer(world);
    }
    // Strained: the share of families kept waiting past half their patience.
    let town = &mut world.town;
    let homes: Vec<&Home> = world.map.objects.iter().filter_map(|e| match e.object {
        GameObject::Building(ref b) => b.home.as_ref(),
        _ => None,
    }).collect();
    let strained = homes.iter().filter(|h| h.wants.iter().any(|w| now.saturating_sub(w.since) > PATIENCE_MS / 2)).count() as f64 / homes.len().max(1) as f64;
    let base = match town.spawned {
        1 => 75_000.0,
        2 => 60_000.0,
        _ => (72_000.0 - now as f64 / 40.0).max(18_000.0),
    };
    let next = (base * (1.0 + 0.8 * strained)) as GameTime;
    town.next_spawn = now + next;
    events.wake(next, SPAWN);
}

// ---- picks ---------------------------------------------------------------

/// Every `PICK_STEP` people moving in, the mayor is offered a pick: what
/// the town most lacks always among it, the rest by chance weighted by
/// need; a wider one when nobody left since the last.
fn offer(world: &mut World) {
    let town = &world.town;
    if !town.offer.is_empty() || town.arrived < town.picked + PICK_STEP {
        return;
    }
    let map = &world.map;
    let shops: Vec<(EntityId, GridCoord)> = of_kind(map, BuildingKind::Shop);
    let homes: Vec<(EntityId, GridCoord)> = map.objects.iter().filter_map(|e| match e.object {
        GameObject::Building(ref b) if b.home.is_some() => Some((e.id, e.position?)),
        _ => None,
    }).collect();
    let unserved = homes.iter().filter(|(_, h)| !shops.iter().any(|(_, s)| (s.x - h.x).abs() + (s.y - h.y).abs() <= REACH)).count() as f64;
    let starved = shops.iter().filter(|&&(id, _)| stock(map, id, Good::Fish) < 1.0).count() as f64;
    let waiting: f64 = homes.iter().filter_map(|&(id, _)| map.building(id)?.home.as_ref()).map(|h| h.wants.len() as f64).sum();
    let roads = town.allowance.saturating_sub(map.laid);
    let mut cands = vec![
        (Offer::Kind(BuildingKind::Shop, 1), 1.0 + unserved * 1.5),
        (Offer::Kind(BuildingKind::Fishery, 1), 1.0 + starved * 3.0 + waiting * 0.5),
        (Offer::Roads(PICK_ROADS), if roads < 20 { 6.0 } else { 2.0 }),
    ];
    let want = if town.left_since == 0 { 3 } else { 2 };
    cands.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut out = vec![cands.remove(0).0];
    let town = &mut world.town;
    while out.len() < want && !cands.is_empty() {
        let total: f64 = cands.iter().map(|c| c.1).sum();
        let mut r = town.roll() * total;
        let mut k = 0;
        while k + 1 < cands.len() && r > cands[k].1 {
            r -= cands[k].1;
            k += 1;
        }
        out.push(cands.remove(k).0);
    }
    town.offer = out;
    town.changed = true;
}

/// A card of the pick taken.
pub fn pick(world: &mut World, n: u8) {
    let town = &mut world.town;
    let Some(&card) = town.offer.get(n as usize) else { return };
    match card {
        Offer::Kind(kind, k) => *town.tokens.entry(kind).or_default() += k,
        Offer::Roads(k) => town.allowance += k,
    }
    town.offer.clear();
    town.picked += PICK_STEP;
    town.left_since = 0;
    town.changed = true;
    offer(world);
}

// ---- the mayor's hand ---------------------------------------------------

/// A building from the hand, placed: one fewer in hand, and it wakes.
pub fn placed(world: &mut World, events: &mut EventQueue, id: EntityId, _now: GameTime) {
    let Some(kind) = world.map.building(id).map(|b| b.kind) else { return };
    if let Some(n) = world.town.tokens.get_mut(&kind) {
        *n = n.saturating_sub(1);
    }
    world.town.changed = true;
    events.wake(0, id);
}

/// A building taken down: what the mayor placed comes back to hand.
pub fn raze(world: &mut World, _events: &mut EventQueue, id: EntityId, _now: GameTime) {
    let Some(b) = world.map.building(id) else { return };
    if b.home.is_none() {
        *world.town.tokens.entry(b.kind).or_default() += 1;
    }
    world.map.remove_building(id);
    world.town.changed = true;
}

// ---- buildings ----------------------------------------------------------

/// A building's turn: a family's wants come and its patience runs; a
/// fishery's boat lands a crate.
pub fn building_wake(world: &mut World, events: &mut EventQueue, id: EntityId, now: GameTime) {
    let Some(b) = world.map.building(id) else { return };
    match (b.kind, b.home.is_some()) {
        (_, true) => home(world, events, id, now),
        (BuildingKind::Fishery, _) => {
            if world.map.street_of(id).is_some()
                && let Some(s) = world.map.building_mut(id).and_then(|b| b.stocks.get_mut(&Good::Fish))
                && s.level + 1.0 <= s.cap
            {
                s.level += 1.0;
            }
            events.wake(FISH_MS, id);
        }
        // A shop: its lorry sees what its shelf lacks.
        _ => {
            for car in world.map.objects.fleet(id).collect::<Vec<_>>() {
                events.wake(0, car);
            }
        }
    }
}

/// A family's turn: what has come due is wanted; a want waited on past
/// patience sends the family away; and their car, if it is home and
/// idle, goes for it.
fn home(world: &mut World, events: &mut EventQueue, id: EntityId, now: GameTime) {
    let Some(h) = world.map.building(id).and_then(|b| b.home.as_ref()) else { return };
    let due: Vec<Good> = h.due.iter().filter(|&(g, &d)| d <= now && !h.wants.iter().any(|w| w.good == *g)).map(|(&g, _)| g).collect();
    if !due.is_empty()
        && let Some(h) = world.map.building_mut(id).and_then(|b| b.home.as_mut())
    {
        for good in due {
            h.wants.push(Want { good, since: now, by: None });
            h.due.insert(good, now + WANT_MS);
        }
    }
    let Some(h) = world.map.building(id).and_then(|b| b.home.as_ref()) else { return };
    if h.wants.iter().any(|w| now >= w.since + PATIENCE_MS) {
        leave(world, id);
        return;
    }
    let next = h.due.iter().filter(|(g, _)| !h.wants.iter().any(|w| w.good == **g)).map(|(_, &d)| d).chain(h.wants.iter().map(|w| w.since + PATIENCE_MS)).min();
    if let Some(next) = next {
        events.wake(next.saturating_sub(now).max(1), id);
    }
    for car in world.map.objects.fleet(id).collect::<Vec<_>>() {
        if !world.town.errands.contains_key(&car) {
            events.wake(0, car);
        }
    }
}

/// A family gone: their house stands empty and comes down.
fn leave(world: &mut World, id: EntityId) {
    world.map.remove_building(id);
    world.town.left += PEOPLE;
    world.town.left_since += 1;
    world.town.changed = true;
}

// ---- errands ------------------------------------------------------------

/// A parked car's turn: what its owner needs, fetched.
pub fn car_idle(world: &mut World, events: &mut EventQueue, car: EntityId, now: GameTime) {
    let Some(c) = world.map.car(car) else { return };
    if c.trip.is_some() {
        return;
    }
    let (owner, role) = (c.owner, c.role);
    if !world.map.handled(car, now) {
        events.wake(c.due.saturating_sub(now).max(1), car);
        return;
    }
    let Some(errand) = world.town.errands.get(&car).cloned() else {
        return set_out(world, events, car, owner, role, now);
    };
    if errand.home {
        return unpack(world, events, car, owner, role, errand, now);
    }
    if world.map.building(errand.to).is_none() {
        return go_home(world, events, car, owner, errand.to, now);
    }
    fetch(world, events, car, owner, role, errand, now);
}

/// At home and idle: out for what is lacking, to the nearest place that
/// has it, or else that makes or sells it with room to wait.
fn set_out(world: &mut World, events: &mut EventQueue, car: EntityId, owner: EntityId, role: CarRole, now: GameTime) {
    let Some(door) = world.map.street_of(owner) else { return };
    let (good, want) = match role {
        CarRole::Private => {
            let Some(h) = world.map.building(owner).and_then(|b| b.home.as_ref()) else { return };
            let open: Vec<Good> = h.wants.iter().filter(|w| w.by.is_none()).map(|w| w.good).collect();
            match open.first() {
                Some(&g) => (g, open.iter().filter(|&&o| o == g).count() as u32),
                None => return,
            }
        }
        CarRole::Truck => {
            // Half empty, it goes for the rest.
            let (lacks, cap) = world.map.building(owner).and_then(|b| b.stocks.get(&Good::Fish)).map_or((0.0, 0.0), |s| (s.cap - s.level, s.cap));
            if lacks < 1.0 || lacks < cap / 2.0 {
                return;
            }
            (Good::Fish, (lacks as u32).min(LOAD))
        }
        _ => return,
    };
    let Some(to) = source(world, owner, door, good, role) else {
        events.wake(POLL_MS * 5, car);
        return;
    };
    if !world.drive(events, |t, e| traffic::car::spawn::start_trip(t, e, car, door, to, now, GameTime::MAX)) {
        events.wake(POLL_MS, car);
        return;
    }
    if role == CarRole::Private {
        if let Some(h) = world.map.building_mut(owner).and_then(|b| b.home.as_mut()) {
            for w in h.wants.iter_mut().filter(|w| w.by.is_none() && w.good == good) {
                w.by = Some(car);
            }
        }
    }
    world.town.errands.insert(car, Errand { to, want, got: 0, waiting: None, home: false });
}

/// The nearest place a vehicle from `home` can get a good: one that has
/// it, else one that makes or sells it with room to wait. A family's car
/// goes to shops within reach; a lorry to makers.
fn source(world: &World, home: EntityId, door: EntityId, good: Good, role: CarRole) -> Option<EntityId> {
    let map = &world.map;
    let at = map.objects.get(home)?.position?;
    let kind = if role == CarRole::Private { BuildingKind::Shop } else { BuildingKind::Fishery };
    let mut best: Option<(i32, EntityId)> = None;
    let mut wait: Option<(i32, EntityId)> = None;
    for (id, p) in of_kind(map, kind) {
        let d = (p.x - at.x).abs() + (p.y - at.y).abs();
        if role == CarRole::Private && d > REACH {
            continue;
        }
        let Some(street) = map.street_of(id) else { continue };
        if !map.network.connected(door, street) {
            continue;
        }
        if stock(map, id, good) >= 1.0 {
            best = best.filter(|b| b.0 <= d).or(Some((d, id)));
        } else if role == CarRole::Private || world.town.errands.values().filter(|e| e.to == id && !e.home).count() < SPOTS {
            wait = wait.filter(|b| b.0 <= d).or(Some((d, id)));
        }
    }
    best.or(wait).map(|(_, id)| id)
}

/// At the counter or in the yard: what is there is taken, a family's at
/// the till, a lorry's lifted aboard; home once it has it all, with what
/// it has once it has waited a while, empty-handed once nothing comes.
fn fetch(world: &mut World, events: &mut EventQueue, car: EntityId, owner: EntityId, role: CarRole, mut errand: Errand, now: GameTime) {
    let since = *errand.waiting.get_or_insert(now);
    let have = stock(&world.map, errand.to, Good::Fish).floor() as u32;
    let take = have.min(errand.want - errand.got);
    if take > 0 {
        if let Some(s) = world.map.building_mut(errand.to).and_then(|b| b.stocks.get_mut(&Good::Fish)) {
            s.level -= take as f64;
        }
        errand.got += take;
        errand.waiting = Some(now);
        // Off the shelf: its lorry sees what it lacks.
        for lorry in world.map.objects.fleet(errand.to).collect::<Vec<_>>() {
            if !world.town.errands.contains_key(&lorry) {
                events.wake(0, lorry);
            }
        }
        if role == CarRole::Truck {
            world.map.lift(errand.to, car, Good::Fish, take, true, now);
            if let Some(c) = world.map.car_mut(car) {
                c.load = Some((Good::Fish, errand.got as f64));
            }
        }
    }
    let waited = now - errand.waiting.unwrap_or(since);
    let done = errand.got >= errand.want || (errand.got > 0 && waited >= SOME_MS) || now - since >= NONE_MS;
    let to = errand.to;
    world.town.errands.insert(car, errand);
    if done {
        // The forklift first, then off.
        if world.map.handled(car, now) {
            go_home(world, events, car, owner, to, now);
        } else {
            let due = world.map.car(car).map_or(now, |c| c.due);
            if let Some(e) = world.town.errands.get_mut(&car) {
                e.want = e.got;
            }
            events.wake(due - now, car);
        }
    } else {
        let due = world.map.car(car).map_or(now, |c| c.due).max(now + POLL_MS);
        events.wake(due - now, car);
    }
}

/// Back home from `from`, with what it has.
fn go_home(world: &mut World, events: &mut EventQueue, car: EntityId, owner: EntityId, from: EntityId, now: GameTime) {
    let gone = world.map.street_of(from).is_some_and(|door| world.drive(events, |t, e| traffic::car::spawn::start_trip(t, e, car, door, owner, now, GameTime::MAX)));
    if let Some(e) = world.town.errands.get_mut(&car) {
        e.home = true;
    }
    if !gone {
        // No way home from there: it is home at once.
        if world.map.building(from).is_none() || world.map.street_of(owner).is_none() {
            world.drive(events, |t, e| traffic::car::simulation::park_at_home(t, e, car));
            events.wake(0, car);
        } else {
            if let Some(e) = world.town.errands.get_mut(&car) {
                e.home = false;
            }
            events.wake(POLL_MS, car);
        }
    }
}

/// Home with the load: a family's wants it answers are met, the rest
/// open again; a lorry's crates lifted onto its shop's shelf.
fn unpack(world: &mut World, events: &mut EventQueue, car: EntityId, owner: EntityId, role: CarRole, errand: Errand, now: GameTime) {
    world.town.errands.remove(&car);
    match role {
        CarRole::Private => {
            if let Some(h) = world.map.building_mut(owner).and_then(|b| b.home.as_mut()) {
                let mut got = errand.got;
                h.wants.retain(|w| {
                    if w.by == Some(car) && got > 0 {
                        got -= 1;
                        false
                    } else {
                        true
                    }
                });
                h.happy += errand.got;
                for w in h.wants.iter_mut().filter(|w| w.by == Some(car)) {
                    w.by = None;
                }
                    }
            events.wake(0, owner);
        }
        CarRole::Truck => {
            if errand.got > 0 {
                let done = world.map.lift(owner, car, Good::Fish, errand.got, false, now);
                if let Some(s) = world.map.building_mut(owner).and_then(|b| b.stocks.get_mut(&Good::Fish)) {
                    s.level = (s.level + errand.got as f64).min(s.cap);
                }
                if let Some(c) = world.map.car_mut(car) {
                    c.load = None;
                }
                events.wake(done.saturating_sub(now).max(POLL_MS), car);
            } else {
                events.wake(POLL_MS * 5, car);
            }
        }
        _ => {}
    }
}

// ---- reading the map ----------------------------------------------------

fn of_kind(map: &Map, kind: BuildingKind) -> Vec<(EntityId, GridCoord)> {
    map.objects.of_kind(kind).filter_map(|id| Some((id, map.objects.get(id)?.position?))).collect()
}

fn stock(map: &Map, id: EntityId, good: Good) -> f64 {
    map.building(id).and_then(|b| b.stocks.get(&good)).map_or(0.0, |s| s.level)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::Game;

    /// A strip of meadow by the sea, a street along it: the fishery on
    /// the shore at its east end, houses and a shop along it.
    fn coast() -> World {
        let mut map = Map::meadow(-30..30, -12..12).street(-20..16);
        for x in 14..30 {
            for y in -12..12 {
                map.terrain.insert((x, y), land::TerrainType::Sea);
            }
        }
        let mut world = World::from(map);
        world.town.start = Some(GridCoord { x: 0, y: 0 });
        world.town.allowance = 1000;
        world.town.next_spawn = GameTime::MAX / 2;
        world
    }

    fn homes(world: &World) -> Vec<&Home> {
        world.map.objects.iter().filter_map(|e| match e.object {
            GameObject::Building(ref b) => b.home.as_ref(),
            _ => None,
        }).collect()
    }

    /// The loop, end to end: families want fish, drive to the shop for it;
    /// the shop's lorry fetches it from the fishery; nobody waits long
    /// enough to leave.
    #[test]
    fn a_shop_stocked_from_the_fishery_feeds_its_street() {
        let mut world = coast();
        let fishery = world.map.place_on_street(GridCoord { x: 12, y: 1 }, BuildingKind::Fishery).expect("a fishery on the shore");
        let shop = world.map.place_on_street(GridCoord { x: 0, y: 1 }, BuildingKind::Shop).expect("a shop on the street");
        let mut town = std::mem::take(&mut world.town);
        for x in [-10, -6, -3, 4, 7] {
            house(&mut world.map, GridCoord { x, y: -1 }, 0, &mut town).expect("a house on the street");
        }
        world.town = town;
        let mut game = Game::new(world, 0, 1, Box::new(World::new));
        game.run_to(3_600_000);
        let world = &game.world;
        assert!(world.map.building(fishery).is_some() && world.map.building(shop).is_some());
        assert_eq!(world.town.left, 0, "a family left");
        let fed: u32 = homes(world).iter().map(|h| h.happy).sum();
        assert!(fed >= 5 * 30, "{fed} meals in an hour");
    }

    /// A family nobody brings fish to leaves.
    #[test]
    fn a_family_kept_waiting_leaves() {
        let mut world = coast();
        let mut town = std::mem::take(&mut world.town);
        house(&mut world.map, GridCoord { x: 0, y: -1 }, 0, &mut town).unwrap();
        world.town = town;
        let mut game = Game::new(world, 0, 1, Box::new(World::new));
        game.run_to(PATIENCE_MS + 60_000);
        assert!(homes(&game.world).is_empty());
        assert_eq!(game.world.town.left, PEOPLE);
    }

    /// A new town is a fishery on the shore and two cottages near it.
    #[test]
    fn a_town_begins_by_the_water() {
        let mut world = World::from(Map::meadow(-30..30, -12..12));
        for x in 14..30 {
            for y in -12..12 {
                world.map.terrain.insert((x, y), land::TerrainType::Sea);
            }
        }
        let game = Game::new(world, 0, 1, Box::new(World::new));
        let world = &game.world;
        assert_eq!(world.map.objects.of_kind(BuildingKind::Fishery).count(), 1);
        assert_eq!(homes(world).len(), 2);
        assert_eq!(world.town.tokens.get(&BuildingKind::Shop), Some(&1));
    }
}
