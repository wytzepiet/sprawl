//! The order board: letters from the mayors of the towns beyond the map's
//! edge, each asking for boxes of a good, and paying for them as they sail
//! (docs/missions.md §Orders).
//!
//! A letter comes in on a ferry. An order is a mission (`Key::Order`): one
//! step, so many units of a good sailed for its town, and its reward the
//! mayor's. A box loaded to go out while an order wants that good is
//! marked for it (`bound`): it carries the order's number as its
//! shipment's, drives to the park and sails with the ferry to the edge,
//! and the mayor's coins land at the harbour as it casts off (`sailed`).
//! An order not filled by its day lapses as a ferry comes in.
//!
//! A mayor's standing with the town is read off the orders: what they
//! started with, a point for each filled and half one off for each that
//! lapsed. Nothing else about a mayor is kept.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::blueprint::blueprint;
use crate::engine::GameTime;
use crate::missions::{Goal, Key, Mission, Reward, Step};
use crate::protocol::{BuildingKind, EntityId, GameObject, Good, News, Trailer, DAY_MS};
use crate::world::World;

/// Who writes: in the order they come to trust the town.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Mayor {
    Tam,
    Mira,
    Bess,
    Aldra,
}

/// Which way a town lies, beyond which edge of the map.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Compass {
    North,
    East,
    South,
    West,
}

/// A mayor as the clients are sent one: who, where, how they look, and
/// how they stand with the town.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Neighbour {
    pub mayor: Mayor,
    pub name: String,
    pub town: String,
    pub toward: Compass,
    /// The town's colour, the crest's ground.
    pub colour: String,
    /// The face, in words: what a portrait would be drawn from
    /// (docs/shelved.md §Faces). The crest is drawn for now.
    pub looks: String,
    pub standing: f64,
    /// Writes to the town yet.
    pub writes: bool,
}

struct Who {
    mayor: Mayor,
    name: &'static str,
    town: &'static str,
    toward: Compass,
    colour: &'static str,
    looks: &'static str,
    /// What they ask for, most wanted first.
    goods: &'static [Good],
    /// Boxes in a letter, before standing adds to it.
    boxes: u32,
    /// What they pay, over the world's price.
    price: f64,
    /// Standing before any order.
    trust: f64,
    /// A letter: cool, then warm, `{n}` how many boxes and `{good}` of what.
    voice: [&'static str; 2],
}

const WHO: [Who; 4] = [
    Who {
        mayor: Mayor::Tam,
        name: "Old Tam",
        town: "Saltmere",
        toward: Compass::West,
        colour: "#3f7fa8",
        looks: "an old fisherman, white beard, oilskin hat, pipe",
        goods: &[Good::Crates, Good::Fuel],
        boxes: 1,
        price: 1.25,
        trust: 1.0,
        voice: [
            "The boats are in and the larder isn't. Could you spare {n} of {good}? No great hurry, the fish keep.",
            "You've never let Saltmere down. {n} of {good} again, if you would, and a pint for whoever drives it.",
        ],
    },
    Who {
        mayor: Mayor::Mira,
        name: "Mira",
        town: "Northgate",
        toward: Compass::North,
        colour: "#6b5b7b",
        looks: "a miner, dark hair cropped short, soot on one cheek, lamp helmet under her arm",
        goods: &[Good::Timber],
        boxes: 2,
        price: 1.5,
        trust: 0.0,
        voice: [
            "We're short of {good} before winter. Can you send {n}?",
            "Your props hold. {n} of {good}. Same as before.",
        ],
    },
    Who {
        mayor: Mayor::Bess,
        name: "Bess",
        town: "Fernhollow",
        toward: Compass::South,
        colour: "#c98a2b",
        looks: "a farmer, round red cheeks, straw hat, a sprig of wheat",
        goods: &[Good::Stone, Good::Timber],
        boxes: 2,
        price: 1.5,
        trust: 0.0,
        voice: [
            "Hello from Fernhollow! The cows have kicked the barn down again. {n} of {good} would put it right!",
            "Our favourite town! Another barn, another {n} of {good}. The cows send their love.",
        ],
    },
    Who {
        mayor: Mayor::Aldra,
        name: "Lord Aldra",
        town: "Port Aldra",
        toward: Compass::East,
        colour: "#a33b3b",
        looks: "a lord, grey whiskers, a chain of office, monocle",
        goods: &[Good::Crates, Good::Timber, Good::Stone, Good::Fuel],
        boxes: 4,
        price: 2.0,
        trust: 0.0,
        voice: [
            "Port Aldra has heard well of you. We require {n} of {good}, and pay accordingly.",
            "My dear friend: {n} of {good}, at your earliest convenience. The usual terms, with our thanks.",
        ],
    },
];

fn who(mayor: Mayor) -> &'static Who {
    &WHO[mayor as usize]
}

/// Orders open at once, at most.
pub const OPEN: usize = 3;
/// Between one letter and the next, at least: a third of the town's day.
pub const GAP: GameTime = DAY_MS as GameTime / 3;
/// How long an order stands: two of the town's days.
pub const LASTS: GameTime = 2 * DAY_MS as GameTime;
/// Standing, as filled orders raise it and lapsed ones lower it, between
/// none and this.
pub const MOST: f64 = 5.0;
const FILLED: f64 = 1.0;
const LAPSED: f64 = 0.5;
/// Standing with another mayor before Port Aldra writes.
pub const GOOD: f64 = 3.0;
/// Each point of standing adds this much to the price.
const WARMTH: f64 = 0.1;

fn orders(world: &World) -> impl Iterator<Item = &Mission> {
    world.missions.list.iter().filter(|m| matches!(m.key, Key::Order(_)))
}

fn open(world: &World) -> impl Iterator<Item = &Mission> {
    orders(world).filter(|m| m.finished.is_none())
}

/// How a mayor stands with the town, read off their orders.
pub fn standing(world: &World, mayor: Mayor) -> f64 {
    orders(world).filter(|m| m.from == Some(mayor) && m.finished.is_some()).fold(who(mayor).trust, |s, m| {
        let filled = m.steps.iter().all(|s| s.done);
        (s + if filled { FILLED } else { -LAPSED }).clamp(0.0, MOST)
    })
}

/// Does the mayor write yet: Port Aldra only once the town stands well
/// with someone else.
fn writes(world: &World, mayor: Mayor) -> bool {
    mayor != Mayor::Aldra || WHO.iter().any(|w| w.mayor != Mayor::Aldra && standing(world, w.mayor) >= GOOD)
}

pub fn neighbours(world: &World) -> Vec<Neighbour> {
    WHO.iter()
        .map(|w| Neighbour {
            mayor: w.mayor,
            name: w.name.into(),
            town: w.town.into(),
            toward: w.toward,
            colour: w.colour.into(),
            looks: w.looks.into(),
            standing: standing(world, w.mayor),
            writes: writes(world, w.mayor),
        })
        .collect()
}

/// What the town can send: goods a maker in town makes and the depots
/// have two boxes of, or a depot holds over its line to sell; and, one
/// step further, goods a kind of building not built yet would make.
pub fn sourceable(world: &World) -> (Vec<Good>, Vec<Good>) {
    let mut now = Vec::new();
    let mut built = Vec::new();
    let kept = |good: Good| crate::missions::depots(world).map(|(_, b)| b.stocks.get(&good).map_or(0.0, |s| s.level)).sum::<f64>();
    for e in world.objects.iter() {
        let GameObject::Building(ref b) = e.object else { continue };
        built.push(b.kind);
        let made = blueprint(b.kind).makes.filter(|&g| b.site.is_none() && world.street_of(e.id).is_some() && kept(g) >= 2.0 * g.per_box());
        let over = b.rules.iter().filter(|(g, r)| r.sell.is_some_and(|line| b.stocks.get(g).is_some_and(|s| s.level > line))).map(|(&g, _)| g);
        for g in made.into_iter().chain(over) {
            if !now.contains(&g) {
                now.push(g);
            }
        }
    }
    let further = BuildingKind::ALL.iter().filter(|&&k| world.build.may_place(k) && !built.contains(&k)).filter_map(|&k| blueprint(k).makes).filter(|g| !now.contains(g)).collect();
    (now, further)
}

fn named(good: Good) -> String {
    format!("{good:?}").to_lowercase()
}

fn boxes(n: u32, good: Good) -> String {
    format!("{n} {} of {}", if n == 1 { "box" } else { "boxes" }, named(good))
}

/// A ferry came in at the harbour: what is overdue lapses, and a letter
/// may come with it. At most `OPEN` at once, one a `GAP`, and none before
/// the opening is done.
pub fn post(world: &mut World, harbour: EntityId, now: GameTime) {
    // One whose last box has sailed is filled, if not yet read as filled.
    for m in world.missions.list.iter_mut().filter(|m| m.finished.is_none() && !m.steps[0].done && m.due.is_some_and(|d| d <= now)) {
        m.finished = Some(now);
        let (w, Goal::Delivered { good, .. }) = (who(m.from.unwrap_or(Mayor::Tam)), m.steps[0].goal) else { continue };
        world.news.push(News { text: format!("{} of {} gave up waiting", w.name, w.town), sub: format!("for {}: standing falls", named(good)), at: harbour });
    }
    let last = orders(world).map(|m| m.opened).max();
    if !world.missions.finished(Key::Opening) || open(world).count() >= OPEN || last.is_some_and(|t| now < t + GAP) {
        return;
    }
    if let Some(order) = write(world, now) {
        let Goal::Delivered { good, units, .. } = order.steps[0].goal else { return };
        let (w, Reward::Order { coins, .. }) = (who(order.from.unwrap()), order.reward) else { return };
        world.news.push(News {
            text: format!("A letter from {} of {}", w.name, w.town),
            sub: format!("{} for {coins:.0} coins", boxes((units / good.per_box()).round() as u32, good)),
            at: harbour,
        });
        world.missions.list.push(order);
        world.missions.stir();
    }
}

/// The next letter: from whoever has written least, of those who write
/// and want something the town can send, Tam before Mira before Bess
/// before Port Aldra. Every third reaches one step further, for a good
/// another building would make, where a mayor wants one, and so does the
/// first, while the town makes nothing to spare. Otherwise nobody asks
/// what the town cannot send now: no letter is better than one that
/// lapses.
pub fn write(world: &mut World, now: GameTime) -> Option<Mission> {
    let (can, further) = sourceable(world);
    let stretch = orders(world).count() % 3 == 2 || can.is_empty();
    let sets = if stretch { vec![&further, &can] } else { vec![&can] };
    let mut by: Vec<(usize, Mayor)> = WHO.iter().filter(|w| writes(world, w.mayor) && !open(world).any(|m| m.from == Some(w.mayor))).map(|w| (orders(world).filter(|m| m.from == Some(w.mayor)).count(), w.mayor)).collect();
    by.sort();
    let (w, good) = sets.into_iter().find_map(|goods| {
        by.iter().find_map(|&(n, mayor)| {
            let w = who(mayor);
            let wanted: Vec<Good> = w.goods.iter().copied().filter(|g| goods.contains(g)).collect();
            (!wanted.is_empty()).then(|| (w, wanted[n % wanted.len()]))
        })
    })?;
    let standing = standing(world, w.mayor);
    let count = w.boxes + (standing / 2.0).floor() as u32;
    let units = count as f64 * good.per_box();
    let coins = (units * crate::economy::world_price(good) * w.price * (1.0 + WARMTH * standing)).round();
    let n = if count == 1 { "a box".to_string() } else { format!("{count} boxes") };
    let letter = w.voice[(standing >= 2.0) as usize].replace("{n}", &n).replace("{good}", &named(good));
    let id = world.objects.reserve_id();
    Some(Mission {
        key: Key::Order(id),
        title: format!("{} of {}", w.name, w.town),
        steps: vec![Step {
            goal: Goal::Delivered { good, units, sailed: 0.0 },
            title: format!("{} to {}", boxes(count, good), w.town),
            text: format!("{}, mayor of {}: {letter}\n\nSell {} from a depot: the next boxes out are marked for {}, and the coins land as each sails.", w.name, w.town, named(good), w.town),
            done: false,
            at: None,
        }],
        reward: Reward::Order { coins, standing: FILLED },
        opened: now,
        finished: None,
        from: Some(w.mayor),
        due: Some(now + LASTS),
    })
}

/// The open order a box of this good loaded to go out is marked for: the
/// oldest that still wants more than is sailed or on its way.
pub fn bound(world: &World, good: Good) -> Option<u64> {
    let marked = crate::haul::boxes(world);
    open(world).find_map(|m| {
        let (Key::Order(id), Goal::Delivered { good: g, units, sailed }) = (m.key, m.steps[0].goal) else { return None };
        let going: f64 = marked.iter().filter(|(t, ..)| t.outbound && t.order == id).map(|(t, ..)| t.units).sum();
        (g == good && sailed + going < units - 1e-6).then_some(id)
    })
}

/// A box went out on the ferry: if it was marked for an open order, it is
/// counted to it and its mayor's coins are what it fetches, and the last
/// fills it. None, and the world buys it.
pub fn sailed(world: &mut World, t: &Trailer) -> Option<f64> {
    let m = world.missions.list.iter_mut().find(|m| m.key == Key::Order(t.order) && m.finished.is_none())?;
    let (Goal::Delivered { units, sailed, .. }, Reward::Order { coins, .. }) = (&mut m.steps[0].goal, m.reward) else { return None };
    *sailed += t.units;
    let paid = coins * t.units / *units;
    m.steps[0].done = *sailed >= *units - 1e-6;
    world.missions.stir();
    Some(paid)
}
