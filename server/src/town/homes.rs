//! Families: who moves in where, what they want and how long they wait for
//! it, and how a house grows. And the shops, which stock what the
//! families round them want. A family takes up a good only once a shop has
//! one to spare, so wanting something new, bread off a farm still sowing,
//! grows as fast as its supply does; and a house grows only once it has
//! everything its level wants.

use std::collections::BTreeMap;

use traffic::event_queue::EventQueue;
use model::{BuildingKind, CarRole, EntityId, GameObject, GameTime, Good, GridCoord, Home, Stock, Want};
use model::blueprint::maker;
use crate::world::World;
use super::{apart, dark, of_kind, open, reaches, HOUSE_ROADS, SPAWN};

/// A house at each level: its name, its people, what it wants and about
/// how often, and what it grows with once it has been well looked after
/// this many times.
pub struct Level {
    pub name: &'static str,
    pub people: u32,
    pub wants: &'static [(Good, GameTime)],
    pub grow: &'static [(Good, u32)],
    pub after: u32,
}

pub const LEVELS: [Level; 5] = [
    Level { name: "", people: 0, wants: &[], grow: &[], after: 0 },
    Level { name: "Cottage", people: 2, wants: &[(Good::Fish, 70_000)], grow: &[(Good::Planks, 2)], after: 2 },
    Level { name: "House", people: 4, wants: &[(Good::Fish, 68_000), (Good::Bread, 80_000)], grow: &[(Good::Bricks, 3)], after: 5 },
    Level { name: "Townhouse", people: 8, wants: &[(Good::Fish, 76_000), (Good::Bread, 84_000), (Good::Furniture, 110_000)], grow: &[(Good::Glass, 3)], after: 7 },
    Level { name: "Apartment", people: 14, wants: &[(Good::Fish, 80_000), (Good::Bread, 88_000), (Good::Furniture, 110_000), (Good::Clothes, 120_000)], grow: &[], after: 0 },
];

/// How long a family waits on a want before it moves down, or out. The
/// clock stops at night, when the shops are shut.
pub const PATIENCE_MS: GameTime = 150_000;
/// How often a family looks at what it wants.
const TURN_MS: GameTime = 2_000;
/// How far a family drives to a shop, in tiles across and along.
pub const REACH: i32 = 26;
/// A shop keeps a couple of each, and about what a house buys in a day
/// for each house it serves; at most this many.
const SHELF: f64 = 2.0;
const SHELF_MAX: f64 = 30.0;
const DAY_NEED: f64 = 2.5;

// ---- a family's turn -----------------------------------------------------

/// A family's turn: a good its level wants and it has never had is taken
/// up, if a shop has one to spare; what has come due is wanted, or taken
/// from the pantry;
/// a want waited on past patience moves the family down; one well looked
/// after asks for what it grows with; and their car, if it is home and
/// idle, goes for it.
pub fn turn(world: &mut World, events: &mut EventQueue, id: EntityId, now: GameTime) {
    let quiet = !loud_near(world, id);
    let night = dark(now);
    let away = world.map.objects.fleet(id).all(|car| super::errands::at_work(world, car));
    let spare = &mut world.town.spare;
    let Some(h) = world.map.building_mut(id).and_then(|b| b.home.as_mut()) else { return };
    // At night the clock stops, and while everyone is at work: nothing
    // comes due, and nobody minds the wait.
    if night >= 0.5 || away {
        for d in h.due.values_mut() {
            *d += TURN_MS;
        }
        for w in h.wants.iter_mut() {
            w.since += TURN_MS;
        }
        events.wake(TURN_MS, id);
        return;
    }
    let level = &LEVELS[h.level as usize];
    let mut met = Vec::new();
    for &(good, every) in level.wants {
        let due = match h.due.get(&good) {
            Some(&due) => due,
            None => match spare.get_mut(&good).filter(|n| **n > 0) {
                Some(n) => {
                    *n -= 1;
                    now
                }
                // None to spare: the town hears of it, nobody waits.
                None => {
                    met.push(good);
                    continue;
                }
            },
        };
        if due > now || h.wants.iter().any(|w| w.good == good) {
            continue;
        }
        h.due.insert(good, now + every);
        match h.pantry.get_mut(&good).filter(|n| **n > 0) {
            Some(n) => {
                *n -= 1;
                h.fed += 1;
            }
            None => {
                h.wants.push(Want { good, since: now, by: None });
                met.push(good);
            }
        }
    }
    // Well looked after, in everything, and quiet: it asks for what it
    // grows with.
    let all = level.wants.iter().all(|(g, _)| h.due.contains_key(g));
    if h.growing.is_none() && !level.grow.is_empty() && h.fed >= level.after && all && quiet {
        h.growing = Some(level.grow.iter().map(|&(g, n)| (g, Stock { level: 0.0, cap: n as f64 })).collect());
        met.extend(level.grow.iter().map(|&(g, _)| g));
    }
    let late = h.wants.iter().find(|w| now >= w.since + PATIENCE_MS).map(|w| w.good);
    for good in met {
        super::picks::unlock(world, maker(good));
    }
    if let Some(good) = late {
        down(world, events, id, good, now);
        return;
    }
    events.wake(TURN_MS, id);
    for car in world.map.objects.fleet(id).collect::<Vec<_>>() {
        if !world.town.errands.contains_key(&car) {
            events.wake(0, car);
        }
    }
}

/// A family that waited too long: a cottage's moves out and the house
/// comes down; a bigger house's moves down a level.
fn down(world: &mut World, events: &mut EventQueue, id: EntityId, good: Good, now: GameTime) {
    let Some(h) = world.map.building(id).and_then(|b| b.home.as_ref()) else { return };
    let level = h.level;
    let people = LEVELS[level as usize].people - LEVELS[level as usize - 1].people;
    world.town.left += people;
    world.town.left_since += 1;
    let what = good.name().to_lowercase();
    if level <= 1 {
        super::errands::forget(world, id);
        world.map.remove_building(id);
        world.news.push(model::News { text: "A family left".into(), sub: format!("they waited too long for {what}"), at: id });
        return;
    }
    world.news.push(model::News { text: format!("A {} moved down", LEVELS[level as usize].name.to_lowercase()), sub: format!("they waited too long for {what}"), at: id });
    if let Some(h) = world.map.building_mut(id).and_then(|b| b.home.as_mut()) {
        h.level -= 1;
        h.fed = 0;
        h.growing = None;
        h.wants.retain(|w| w.by.is_some());
        for w in h.wants.iter_mut() {
            w.since = now;
        }
        h.due = LEVELS[h.level as usize].wants.iter().filter(|(g, _)| h.due.contains_key(g)).map(|&(g, every)| (g, now + every / 2)).collect();
    }
    fit_cars(world, id, now);
    events.wake(TURN_MS, id);
}

/// What came home answers: wants met, and what the house grows with put
/// by. All of it in, it grows a level.
pub fn unpack(world: &mut World, events: &mut EventQueue, id: EntityId, car: EntityId, got: &[Good], extra: &[Good], now: GameTime) {
    let Some(h) = world.map.building_mut(id).and_then(|b| b.home.as_mut()) else { return };
    let mut grown = false;
    for &good in got {
        if let Some(i) = h.wants.iter().position(|w| w.good == good && w.by == Some(car)) {
            h.wants.remove(i);
            h.fed += 1;
        } else if let Some(s) = h.growing.as_mut().and_then(|g| g.get_mut(&good)).filter(|s| s.short() >= 1.0) {
            s.level += 1.0;
        } else {
            *h.pantry.entry(good).or_default() += 1;
        }
    }
    for &good in extra {
        *h.pantry.entry(good).or_default() += 1;
    }
    for w in h.wants.iter_mut().filter(|w| w.by == Some(car)) {
        w.by = None;
    }
    if h.growing.as_ref().is_some_and(|g| g.values().all(|s| s.short() < 1e-6)) && (h.level as usize) < LEVELS.len() - 1 {
        h.growing = None;
        h.level += 1;
        h.fed = 0;
        grown = true;
    }
    if grown {
        let level = h.level;
        world.town.arrived += LEVELS[level as usize].people - LEVELS[level as usize - 1].people;
        world.town.grew += 1;
        fit_cars(world, id, now);
        super::picks::offer(world, now);
    }
    events.wake(0, id);
}

/// A cottage has one car, a house or bigger two: two workers, two errands.
fn fit_cars(world: &mut World, id: EntityId, now: GameTime) {
    let Some(level) = world.map.building(id).and_then(|b| b.home.as_ref()).map(|h| h.level) else { return };
    let want = if level >= 2 { 2 } else { 1 };
    let cars: Vec<EntityId> = world.map.objects.fleet(id).collect();
    let at = world.map.objects.get(id).and_then(|e| e.position);
    for _ in cars.len()..want {
        let car = world.map.insert_at(GameObject::Car(model::Car::new(id, CarRole::Private)), at);
        world.map.park_in_lot(id, car, now);
    }
    // A car out comes home to find itself sold (`errands::forget`).
    for &car in cars.iter().skip(want) {
        if !world.town.errands.contains_key(&car) {
            super::errands::drop_car(world, car);
        }
    }
}

// ---- families moving in ----------------------------------------------------

/// A cottage at a tile, a family in it who will want fish once there is
/// some to spare.
pub fn house(world: &mut World, at: GridCoord, now: GameTime) -> Option<EntityId> {
    if let Some((lo, hi)) = world.town.ground()
        && (at.x < lo.x || at.y < lo.y || at.x > hi.x || at.y > hi.y)
    {
        return None;
    }
    let map = &mut world.map;
    if map.terrain.get(&(at.x, at.y)) != Some(&land::TerrainType::Grass) {
        return None;
    }
    let tiles = [at];
    let facing = map.site_for(at, BuildingKind::House).or_else(|| (0..4).find(|&f| map.may_stand_on(&tiles, BuildingKind::House, f)))?;
    let id = map.place_building(at, BuildingKind::House, facing)?;
    if loud_near(world, id) {
        world.map.remove_building(id);
        return None;
    }
    if let Some(b) = world.map.building_mut(id) {
        b.home = Some(Home { level: 1, wants: Vec::new(), due: BTreeMap::new(), pantry: BTreeMap::new(), growing: None, fed: 0 });
    }
    fit_cars(world, id, now);
    Some(id)
}

/// A family moves in beside a house already here, likelier beside a road;
/// now and then a hamlet of its own away from everyone. The next is due
/// sooner as the town grows, later while its families are kept waiting.
pub fn spawn(world: &mut World, events: &mut EventQueue, now: GameTime) {
    // No town, nobody comes: a test's street.
    if world.town.start.is_none() {
        return;
    }
    // A pick on the table, or a third of the town kept waiting: nobody
    // new until it is seen to.
    if !world.town.offer.is_empty() || strained(world, now) > 0.3 {
        events.wake(2_000, SPAWN);
        return;
    }
    world.town.spawned += 1;
    let homes: Vec<GridCoord> = of_kind(&world.map, BuildingKind::House).into_iter().map(|(_, p)| p).collect();
    let hamlet = world.town.spawned >= 8 && world.town.spawned % 7 == 1;
    let mut placed = None;
    if !hamlet && !homes.is_empty() {
        for _ in 0..60 {
            let h = homes[(world.town.roll() * homes.len() as f64) as usize % homes.len()];
            let at = GridCoord { x: h.x + ((world.town.roll() - 0.5) * 7.0).round() as i32, y: h.y + ((world.town.roll() - 0.5) * 7.0).round() as i32 };
            let by_road = world.map.site_for(at, BuildingKind::House).is_some();
            if by_road || world.town.roll() < 0.35 {
                placed = house(world, at, now);
                if placed.is_some() {
                    break;
                }
            }
        }
    }
    if placed.is_none()
        && let Some((lo, hi)) = world.town.ground()
    {
        let mut best: Option<(i32, GridCoord)> = None;
        for _ in 0..80 {
            let at = GridCoord { x: lo.x + 1 + (world.town.roll() * (hi.x - lo.x - 1) as f64) as i32, y: lo.y + 1 + (world.town.roll() * (hi.y - lo.y - 1) as f64) as i32 };
            let near = world.map.objects.iter().filter_map(|e| match e.object {
                GameObject::Building(ref b) => Some(b.tiles.iter().map(|t| (t.x - at.x).abs().max((t.y - at.y).abs()) + if b.kind == BuildingKind::House { 0 } else { 2 }).min()?),
                _ => None,
            }).min().unwrap_or(99);
            if (6..=12).contains(&near) && best.is_none_or(|b| near > b.0) && world.map.terrain.get(&(at.x, at.y)) == Some(&land::TerrainType::Grass) {
                best = Some((near, at));
            }
        }
        if let Some((_, at)) = best {
            placed = house(world, at, now);
        }
    }
    if let Some(id) = placed {
        world.town.arrived += LEVELS[1].people;
        world.town.allowance += HOUSE_ROADS;
        events.wake(0, id);
        super::picks::offer(world, now);
    }
    events.wake(next_spawn(world, now), SPAWN);
}

/// When the next family is due: the first two soon, then sooner as the
/// town grows; later while its families are kept waiting, and none while
/// many are.
pub fn next_spawn(world: &World, now: GameTime) -> GameTime {
    let strained = strained(world, now);
    let base = match world.town.spawned {
        0 => 50_000.0,
        1 => 40_000.0,
        _ => (48_000.0 - now as f64 / 20.0).max(12_000.0),
    };
    (base * (1.0 + 4.0 * strained)) as GameTime
}

/// How many of the town's families have waited half their patience on
/// something, of all of them.
fn strained(world: &World, now: GameTime) -> f64 {
    let homes: Vec<&Home> = world.map.objects.iter().filter_map(|e| match e.object {
        GameObject::Building(ref b) => b.home.as_ref(),
        _ => None,
    }).collect();
    homes.iter().filter(|h| h.wants.iter().any(|w| now.saturating_sub(w.since) > PATIENCE_MS / 2)).count() as f64 / homes.len().max(1) as f64
}

/// A family whose house came down moves to a cottage nearby, if there's
/// room; what the house had grown into is lost.
pub fn rehouse(world: &mut World, events: &mut EventQueue, at: GridCoord, now: GameTime) {
    for r in 2i32..6 {
        for dy in -r..=r {
            for dx in -r..=r {
                if dx.abs().max(dy.abs()) != r {
                    continue;
                }
                let p = GridCoord { x: at.x + dx, y: at.y + dy };
                if world.map.site_for(p, BuildingKind::House).is_some()
                    && let Some(id) = house(world, p, now)
                {
                    events.wake(0, id);
                    return;
                }
            }
        }
    }
    world.town.left += LEVELS[1].people;
    world.town.left_since += 1;
    world.news.push(model::News { text: "A family left".into(), sub: "their house came down, and there was no room nearby".into(), at: 0 });
}

/// Is a loud maker within two tiles of the building: a house there won't grow.
fn loud_near(world: &World, id: EntityId) -> bool {
    let Some(b) = world.map.building(id) else { return false };
    let mine = b.tiles.clone();
    world.map.objects.iter().any(|e| match e.object {
        GameObject::Building(ref o) if e.id != id && model::blueprint::blueprint(o.kind).loud => o.tiles.iter().any(|t| mine.iter().any(|m| (m.x - t.x).abs().max((m.y - t.y).abs()) <= 2)),
        _ => false,
    })
}

/// What the town's shops have to spare of each good: on their shelves,
/// past what its families already wait on.
pub fn spare(world: &mut World) {
    let mut n: BTreeMap<Good, f64> = BTreeMap::new();
    for e in world.map.objects.iter() {
        let GameObject::Building(ref b) = e.object else { continue };
        match &b.home {
            Some(h) => h.wants.iter().for_each(|w| *n.entry(w.good).or_default() -= 1.0),
            None if b.kind == BuildingKind::Shop => b.stocks.iter().for_each(|(&g, s)| *n.entry(g).or_default() += s.level.floor()),
            None => {}
        }
    }
    world.town.spare = n.into_iter().filter(|&(_, v)| v >= 1.0).map(|(g, v)| (g, v as u32)).collect();
}

// ---- shops ---------------------------------------------------------------

/// Every shop stocks what the houses within its reach want, what they grow
/// with too; a house within reach of two shops counts half at each, so a
/// second shop beside a busy one takes half the work.
pub fn catchment(world: &mut World) {
    let map = &world.map;
    let shops: Vec<EntityId> = of_kind(map, BuildingKind::Shop).into_iter().map(|(id, _)| id).filter(|&id| map.street_of(id).is_some()).collect();
    let mut share: BTreeMap<EntityId, BTreeMap<Good, f64>> = shops.iter().map(|&s| (s, BTreeMap::new())).collect();
    for (h, _) in of_kind(map, BuildingKind::House) {
        let Some(home) = map.building(h).and_then(|b| b.home.as_ref()) else { continue };
        let near: Vec<EntityId> = shops.iter().copied().filter(|&s| apart(map, s, h) <= REACH && reaches(map, s, h)).collect();
        let goods: Vec<Good> = LEVELS[home.level as usize].wants.iter().map(|w| w.0).chain(home.growing.iter().flat_map(|g| g.keys().copied())).collect();
        for &s in &near {
            for &g in &goods {
                *share.get_mut(&s).unwrap().entry(g).or_default() += 1.0 / near.len() as f64;
            }
        }
    }
    for (shop, goods) in share {
        let Some(b) = world.map.building_mut(shop) else { continue };
        for (&g, &n) in &goods {
            b.stocks.entry(g).or_insert(Stock { level: 0.0, cap: 0.0 }).cap = (SHELF + (DAY_NEED * n).ceil()).min(SHELF_MAX);
        }
        b.stocks.retain(|g, s| goods.contains_key(g) || s.level >= 1.0);
        for (g, s) in b.stocks.iter_mut() {
            if !goods.contains_key(g) {
                s.cap = s.level;
            }
        }
    }
}

/// The nearest shop within reach of a house that has any of these on its
/// shelves, else that sells any of them, open.
pub fn shop_for(world: &World, home: EntityId, goods: &[Good], now: GameTime) -> Option<EntityId> {
    if !open(now) {
        return None;
    }
    let map = &world.map;
    let has = |s: EntityId, k: f64| map.building(s).is_some_and(|b| goods.iter().any(|g| b.stocks.get(g).is_some_and(|st| st.level >= k)));
    of_kind(map, BuildingKind::Shop)
        .into_iter()
        .map(|(id, _)| id)
        .filter(|&s| apart(map, s, home) <= REACH && reaches(map, s, home) && has(s, 0.0))
        .min_by_key(|&s| (!has(s, 1.0), apart(map, s, home), s))
}
