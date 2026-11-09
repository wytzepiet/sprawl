//! The town's rules: whoever needs something goes and gets it. A family
//! drives to the nearest shop for what it wants; a shop's lorry, and a
//! maker's, drive to whoever makes what they lack; a maker of raw goods
//! stacks its yard and waits to be fetched from. Every errand is a trip on
//! the mayor's roads, and a queue in a yard shows where supply is short.
//! Every house is also a worker, who keeps their own hours at the nearest
//! maker with a seat free: a maker works slower for every seat empty.
//!
//! A family kept waiting too long moves down, a cottage's out; one well
//! looked after grows, once the materials come. People moving in or up
//! hand the mayor a pick: more road, a road tool, another building. A day
//! nobody left adds to the streak, and to the road.
//!
//! The map keeps what is where and traffic moves it; this decides where
//! everyone goes next. No money, and no losing: only a town that grows or
//! doesn't.

mod errands;
mod fire;
pub(crate) mod homes;
mod makers;
mod picks;
mod start;

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use traffic::event_queue::EventQueue;
use model::{BuildingKind, EntityId, GameObject, GameTime, Good, GridCoord, Offer, Unlock, DAY_MS};
use map::Map;
use crate::world::World;

pub use errands::car_idle;
pub use start::found;

/// Road tiles a town starts with, each family moving in brings, a pick
/// gives, and a day nobody left earns.
pub const START_ROADS: u32 = 40;
pub const HOUSE_ROADS: u32 = 3;
pub const PICK_ROADS: u32 = 20;
pub const CLEAN_DAY_ROADS: u32 = 4;
/// People moving in or up who bring a pick.
pub const PICK_STEP: u32 = 10;
/// How often the town looks round: what its shops stock, its standing.
const LOOK_MS: GameTime = 5_000;

/// The wakes that are nobody's: no entity has these ids.
pub const SPAWN: EntityId = EntityId::MAX;
pub const DAWN: EntityId = EntityId::MAX - 1;
pub const LOOK: EntityId = EntityId::MAX - 2;

/// The town's standings, the people each begins at, and the ground new
/// families settle on: a hamlet's patch, growing to a city's. The mayor
/// builds anywhere; the road he has is his limit.
pub const STATUSES: [(&str, u32, (i32, i32)); 5] = [
    ("Hamlet", 0, (44, 30)),
    ("Village", 12, (60, 40)),
    ("Town", 40, (76, 52)),
    ("City", 110, (92, 62)),
    ("Metropolis", 250, (110, 74)),
];

/// What the mayor has to build with, who has come and gone, and the pick
/// on the table. Saved.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Town {
    /// Road tiles the town may lay, all told: what is laid comes off it
    /// (`Map::laid`).
    pub allowance: u32,
    /// Buildings in hand, to place.
    pub hand: BTreeMap<BuildingKind, u32>,
    /// Lorries in hand, for a building to take on (`add_lorry`).
    #[serde(default)]
    pub lorries: u32,
    /// Road tools picked.
    pub tools: BTreeSet<Unlock>,
    /// Kinds the town has met: wanted, or what a wanted kind is made from.
    pub met: BTreeSet<BuildingKind>,
    /// Kinds met that come to hand once what feeds them stands.
    pub waiting: BTreeSet<BuildingKind>,
    /// People who moved in or up, all told, and those a pick was handed for.
    pub arrived: u32,
    pub picked: u32,
    /// People who left, all told, and since the last pick.
    pub left: u32,
    pub left_since: u32,
    /// Houses that grew, all told.
    pub grew: u32,
    pub offer: Vec<Offer>,
    pub spawned: u32,
    /// The day it is, from 1; clean days in a row; and how the day began.
    pub day: u32,
    pub streak: u32,
    pub dawn_was: (u32, u32, u32),
    pub dawn: Option<model::Dawn>,
    pub status: u8,
    /// Where the town began, for the camera to find it and the ground to
    /// grow round.
    pub start: Option<GridCoord>,
    roll: u64,
    /// Each car out on an errand, and how far it has got. Not saved: a
    /// loaded world's cars are all home.
    #[serde(skip)]
    errands: BTreeMap<EntityId, errands::Errand>,
    /// When each worker may go to work again. Not saved.
    #[serde(skip)]
    rest: BTreeMap<EntityId, GameTime>,
    /// What the town's makers could make of each good, a minute, past what
    /// its families eat, for more to take it up (`picks::rates`). Not
    /// saved: counted every look.
    #[serde(skip)]
    room: BTreeMap<Good, f64>,
    /// What moved, by step and good, for the bot to read. Not saved.
    #[serde(skip)]
    pub tally: BTreeMap<(&'static str, Good), u32>,
}

impl Town {
    pub fn has(&self, kind: BuildingKind) -> bool {
        self.hand.get(&kind).is_some_and(|&n| n > 0)
    }

    pub fn roads(&self, map: &Map) -> u32 {
        self.allowance.saturating_sub(map.laid)
    }

    /// The town as its mayor sees it.
    pub fn view(&self, map: &Map) -> model::Town {
        model::Town {
            people: people(map),
            roads: self.roads(map),
            hand: self.hand.iter().filter(|(_, n)| **n > 0).map(|(&k, &n)| (k, n)).collect(),
            lorries: self.lorries,
            tools: self.tools.iter().copied().collect(),
            toward: self.arrived.saturating_sub(self.picked),
            step: PICK_STEP,
            left: self.left,
            offer: self.offer.clone(),
            day: self.day,
            streak: self.streak,
            status: self.status,
            dawn: self.dawn,
            start: self.start,
        }
    }

    /// Where new families settle, corner to corner: round where the town
    /// began, as wide as its standing.
    fn ground(&self) -> Option<(GridCoord, GridCoord)> {
        let c = self.start?;
        let (w, h) = STATUSES[self.status as usize].2;
        Some((GridCoord { x: c.x - w / 2, y: c.y - h / 2 }, GridCoord { x: c.x + w - w / 2 - 1, y: c.y + h - h / 2 - 1 }))
    }

    /// A number from 0 to 1, the same on every machine.
    fn roll(&mut self) -> f64 {
        self.roll = self.roll.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.roll;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Whether the hand may use this: a tool's road, priority, height.
    /// Road without end and every tool: the puzzle's town, and the tests'.
    pub fn boundless(&mut self) {
        self.allowance = 1_000_000;
        self.tools.extend(Unlock::ALL);
    }

    pub fn may(&self, tool: model::Tool, road: bool, up: Option<[u8; 2]>) -> bool {
        use model::Tool::*;
        let need = match tool {
            Street | Demolish => None,
            OneWay => Some(Unlock::OneWay),
            Wide => Some(Unlock::Wide),
            Light => Some(Unlock::Lights),
        };
        need.is_none_or(|u| self.tools.contains(&u))
            && (!road || self.tools.contains(&Unlock::Priority))
            && (up.is_none_or(|[a, b]| a == 0 && b == 0) || self.tools.contains(&Unlock::Overpass))
    }
}

/// Everyone who lives here.
pub fn people(map: &Map) -> u32 {
    map.objects.of_kind(BuildingKind::House).filter_map(|id| map.building(id)?.home.as_ref()).map(|h| homes::LEVELS[h.level as usize].people).sum()
}

/// How dark it is, 0 by day to 1 at night. Makers and lorries work through
/// the night; families stay in and the shops shut, so the roads clear and
/// the lorries catch up.
pub fn dark(now: GameTime) -> f64 {
    let ph = (now % DAY_MS as GameTime) as f64 / DAY_MS as f64;
    if ph < 0.68 {
        0.0
    } else if ph < 0.74 {
        (ph - 0.68) / 0.06
    } else if ph < 0.94 {
        1.0
    } else {
        (1.0 - ph) / 0.06
    }
}

/// Shops sell by day: at night their shutters are down and they only take
/// in stock.
pub fn open(now: GameTime) -> bool {
    dark(now) < 0.5
}

/// A wake that is nobody's: the town's own clock.
pub fn wake(world: &mut World, events: &mut EventQueue, id: EntityId, now: GameTime) {
    match id {
        SPAWN => homes::spawn(world, events, now),
        DAWN => dawn(world, events, now),
        LOOK => look(world, events, now),
        _ => {}
    }
}

/// A building's turn: a family's wants come and its patience runs; a
/// maker makes; a shop's lorry sees what its shelf lacks.
pub fn building_wake(world: &mut World, events: &mut EventQueue, id: EntityId, now: GameTime) {
    let Some(b) = world.map.building(id) else { return };
    match b.kind {
        BuildingKind::House => homes::turn(world, events, id, now),
        BuildingKind::Shop => {
            for car in world.map.objects.fleet(id).collect::<Vec<_>>() {
                if !world.town.errands.contains_key(&car) {
                    events.wake(0, car);
                }
            }
        }
        _ => makers::turn(world, events, id, now),
    }
}

/// The town looks round: what each shop stocks, by what its families
/// want; its standing, and the ground it may build on; anything newly
/// placed or reached wakes.
fn look(world: &mut World, events: &mut EventQueue, now: GameTime) {
    homes::catchment(world);
    world.town.room = picks::rates(world).into_iter().map(|(g, f)| (g, f.make - f.taken)).collect();
    standing(world);
    fire::look(world, events, now, LOOK_MS);
    picks::release(world);
    events.wake(LOOK_MS, LOOK);
}

/// The town's standing by its people, and the ground it may build on with
/// it, round where it began.
pub fn standing(world: &mut World) {
    let pop = people(&world.map);
    let status = STATUSES.iter().rposition(|s| pop >= s.1).unwrap_or(0) as u8;
    if status > world.town.status {
        world.town.status = status;
        world.news.push(model::News { text: format!("A {}", STATUSES[status as usize].0.to_lowercase()), sub: "families settle further out".into(), at: 0 });
    }
}

/// The day turns: yesterday summed up, a clean day added to the streak,
/// and to the road.
fn dawn(world: &mut World, events: &mut EventQueue, now: GameTime) {
    let town = &mut world.town;
    let (came, left, grew) = (town.arrived - town.dawn_was.0, town.left - town.dawn_was.1, town.grew - town.dawn_was.2);
    if town.day > 0 {
        town.streak = if left == 0 { town.streak + 1 } else { 0 };
        if left == 0 {
            town.allowance += CLEAN_DAY_ROADS;
        }
        town.dawn = Some(model::Dawn { day: town.day, came, left, grew });
    }
    town.day = (now / DAY_MS as GameTime) as u32 + 1;
    town.dawn_was = (town.arrived, town.left, town.grew);
    let day = DAY_MS as GameTime;
    events.wake(day - now % day, DAWN);
}

/// The town's clocks set going: a loaded world's, or a new one's.
pub fn begin(world: &mut World, events: &mut EventQueue, now: GameTime) {
    let day = DAY_MS as GameTime;
    if world.town.day == 0 {
        world.town.day = (now / day) as u32 + 1;
        world.town.dawn_was = (world.town.arrived, world.town.left, world.town.grew);
    }
    events.wake(day - now % day, DAWN);
    events.wake(0, LOOK);
    events.wake(homes::next_spawn(world, now), SPAWN);
    let ids: Vec<EntityId> = world.map.objects.iter().filter(|e| matches!(e.object, GameObject::Building(_))).map(|e| e.id).collect();
    for id in ids {
        events.wake(0, id);
        for car in world.map.objects.fleet(id).collect::<Vec<_>>() {
            events.wake(0, car);
        }
    }
    standing(world);
}

/// A building from the hand placed: one fewer in hand, and it wakes.
pub fn placed(world: &mut World, events: &mut EventQueue, id: EntityId) {
    let Some(kind) = world.map.building(id).map(|b| b.kind) else { return };
    if let Some(n) = world.town.hand.get_mut(&kind) {
        *n = n.saturating_sub(1);
    }
    world.town.met.insert(kind);
    events.wake(0, id);
    picks::release(world);
}

/// A building taken down: what the mayor placed comes back to hand; a
/// house's family moves to a cottage nearby, if there's room.
pub fn raze(world: &mut World, events: &mut EventQueue, id: EntityId, now: GameTime) {
    let Some(b) = world.map.building(id) else { return };
    let (kind, at) = (b.kind, b.tiles[0]);
    world.town.lorries += trucks(&world.map, id).saturating_sub(1);
    errands::forget(world, id);
    world.map.remove_building(id);
    if kind == BuildingKind::House {
        homes::rehouse(world, events, at, now);
    } else {
        *world.town.hand.entry(kind).or_default() += 1;
    }
}

/// A lorry from the hand taken on by a building that runs fewer than it
/// has docks for: its next errand runs beside the first's. Refused, why.
pub fn add_lorry(world: &mut World, events: &mut EventQueue, id: EntityId, now: GameTime) -> Option<model::News> {
    let refuse = |why: &str| Some(model::News { text: "No lorry for it".into(), sub: why.into(), at: 0 });
    let Some(b) = world.map.building(id) else { return refuse("nothing there") };
    let row = model::blueprint::blueprint(b.kind);
    if world.town.lorries == 0 {
        return refuse("a pick brings one");
    }
    if row.lorries == 0 {
        return refuse("it runs no lorries");
    }
    if world.map.street_of(id).is_none() {
        return refuse("no road to it yet");
    }
    if trucks(&world.map, id) >= row.docks() as u32 {
        return refuse("its docks are full");
    }
    world.town.lorries -= 1;
    let at = world.map.objects.get(id).and_then(|e| e.position);
    let car = world.map.insert_at(GameObject::Car(model::Car::new(id, model::CarRole::Truck)), at);
    world.map.park_in_lot(id, car, now);
    events.wake(0, car);
    None
}

/// The lorries a building runs.
fn trucks(map: &Map, id: EntityId) -> u32 {
    map.objects.fleet(id).filter(|&c| map.car(c).is_some_and(|c| c.role == model::CarRole::Truck)).count() as u32
}

/// A card of the pick taken.
pub fn pick(world: &mut World, n: u8, now: GameTime) {
    picks::pick(world, n, now);
}

// ---- reading the map ----------------------------------------------------

fn of_kind(map: &Map, kind: BuildingKind) -> Vec<(EntityId, GridCoord)> {
    map.objects.of_kind(kind).filter_map(|id| Some((id, map.objects.get(id)?.position?))).collect()
}

fn stock(map: &Map, id: EntityId, good: Good) -> f64 {
    map.building(id).and_then(|b| b.stocks.get(&good)).map_or(0.0, |s| s.level)
}

/// Tiles between two buildings, across or along, whichever is more: as
/// the client measures a shop's reach.
fn apart(map: &Map, a: EntityId, b: EntityId) -> i32 {
    match (map.objects.get(a).and_then(|e| e.position), map.objects.get(b).and_then(|e| e.position)) {
        (Some(p), Some(q)) => (p.x - q.x).abs().max((p.y - q.y).abs()),
        _ => i32::MAX,
    }
}

/// Whether a car can drive from one building to the other.
fn reaches(map: &Map, a: EntityId, b: EntityId) -> bool {
    match (map.street_of(a), map.street_of(b)) {
        (Some(x), Some(y)) => map.network.connected(x, y),
        _ => false,
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod bot;
