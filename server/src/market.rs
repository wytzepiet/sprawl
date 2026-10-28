//! The market (docs/plan-market.md §The first version): a price per
//! good that moves, inside a band the world sets and never moves.
//!
//! The world always sells, at the band's ceiling, and always buys, at its
//! floor. Between the two the market's price wanders, pushed by the
//! computer's mayors (`orders.rs` §WHO) making what their towns make and
//! buying what they want, and by the town's own trades: what it buys
//! pushes the price up, what it sells pushes it down. How lively a good
//! is is how wide its band is: stone narrow, fuel wide.
//!
//! One price, the same to buy and to sell. Each package moves it a step,
//! a two-hundredth of the way from the world's price to the band's edge, and is
//! paid at the price it moved to: a package bought pushes the price up and
//! costs the new price, a package sold pushes it down and gets the new one.
//! So a quick flip always loses a step a package, and a town that buys a
//! whole ferry of a good pays more for the last package than the first. Past
//! the band there is no more room: the world sells at its ceiling and
//! buys at its floor. Freight leaves the price for now; real distances
//! later.
//!
//! The price steps once an hour of the town's day, from the world's seed
//! and the hour alone, so the same seed and the same trades give the same
//! graph on every machine. A week of hours is kept, and saved.
//!
//! A line keeps a good (docs/core.md §Trade): each hour the town buys up
//! to it what it has not got, and sells what it has over it, a package at a
//! time and as far as its offices' desks go: every clerk at a desk an hour
//! trades `CLERK` packages. The mayor's own Buy and Sell never wait on a
//! desk.

use model::market::{Flow, Line, Quote, Prices};
use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::economy::world_price;
use model::GameTime;
use model::{BuildingKind, EntityId, GameObject, Good, DAY_MS};
use crate::world::World;

/// The goods on the market, in the order the list shows them. Bread is
/// fresh and never on it: every town bakes its own.
pub const GOODS: [Good; 10] = [Good::Timber, Good::Stone, Good::Grain, Good::Fuel, Good::Cement, Good::Ore, Good::Coal, Good::Steel, Good::Machinery, Good::Crude];

/// How far a good's price may stray from the world's, each way, as a
/// share of it: the band. Never under freight, so the world's two prices
/// are always at least as far apart as the market's buy and sell.
fn band(good: Good) -> f64 {
    match good {
        Good::Stone | Good::Cement => 0.15,
        Good::Timber | Good::Bread | Good::Grain | Good::Coal => 0.2,
        Good::Ore | Good::Steel => 0.3,
        Good::Machinery => 0.35,
        Good::Fuel | Good::Crude => 0.5,
    }
}

/// The market steps once an hour of the town's day.
pub const HOUR: GameTime = DAY_MS as GameTime / 24;
/// Hours of price kept: a week.
const KEPT: usize = 7 * 24;
/// Packages the town trades to move a price from the world's to its
/// ceiling or floor. A town that buys a lorry of fuel a sailing barely
/// moves it, the drift back taking each step away again within the day;
/// a whole deck of sixty bought at once moves it most of a third of its
/// band.
const DEPTH: f64 = 200.0;
/// How much of an hour's push from the mayors lasts into the next: a
/// glut or a shortage lasts most of a day.
const LASTS: f64 = 0.85;
/// How far an hour's push moves the price through its band, and how much
/// of the way back to the world's it drifts each hour.
const PUSH: f64 = 0.12;
const BACK: f64 = 0.03;
/// Packages a clerk trades in an hour at an office's desk: an office's
/// twelve, eight to five, about forty a day.
pub const CLERK: f64 = 0.4;

/// The market as the world keeps it, and saves it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Market {
    /// Hours stepped since the world began.
    pub hour: u64,
    /// Each good's place in its band: -1 its floor, 1 its ceiling.
    at: BTreeMap<Good, f64>,
    /// The push the mayors give each, lasting from hour to hour.
    push: BTreeMap<Good, f64>,
    /// Each good's price at the end of each hour kept, oldest first.
    history: BTreeMap<Good, VecDeque<f64>>,
    /// Each good's line: units kept.
    #[serde(default)]
    pub lines: BTreeMap<Good, f64>,
    /// Packages the desks may still trade, from the hours gone: the clerks'
    /// work kept till a line wants it, a day's at most.
    #[serde(default)]
    desk: f64,
    /// Packages a day the desks could trade, as staffed in the hour just
    /// gone, and whether the lines wanted more than they had.
    #[serde(skip)]
    desks: f64,
    #[serde(skip)]
    full: bool,
    /// What the town made and used of each good, an hour a row, the last
    /// day's; the last row the hour going.
    #[serde(default)]
    flows: VecDeque<BTreeMap<Good, [f64; 2]>>,
    /// Something a client would draw changed since it was last sent.
    #[serde(skip)]
    pub changed: bool,
}

impl Market {
    pub fn price(&self, good: Good) -> f64 {
        world_price(good) * (1.0 + band(good) * self.at.get(&good).copied().unwrap_or(0.0))
    }
    /// What the world sells at: the most the town ever pays.
    pub fn ceiling(good: Good) -> f64 {
        world_price(good) * (1.0 + band(good))
    }
    /// What the world buys at: the least the town ever gets.
    pub fn floor(good: Good) -> f64 {
        world_price(good) * (1.0 - band(good))
    }
    /// How far a package moves a good's price, a unit's.
    pub fn nudge(good: Good) -> f64 {
        world_price(good) * band(good) / DEPTH
    }
    /// What a unit of the next package costs bought, or gets sold: the price
    /// it moves to, never past the band.
    pub fn next(&self, good: Good, out: bool) -> f64 {
        (self.price(good) + if out { -1.0 } else { 1.0 } * Self::nudge(good)).clamp(Self::floor(good), Self::ceiling(good))
    }

    /// So many units of a good made in town, or used.
    pub fn made(&mut self, good: Good, units: f64) {
        self.flow(good, 0, units);
    }
    pub fn used(&mut self, good: Good, units: f64) {
        self.flow(good, 1, units);
    }
    fn flow(&mut self, good: Good, k: usize, units: f64) {
        if self.flows.is_empty() {
            self.flows.push_back(BTreeMap::new());
        }
        self.flows.back_mut().unwrap().entry(good).or_default()[k] += units;
    }

    /// The town traded so many packages: the price moves its way.
    fn traded(&mut self, good: Good, packages: f64, out: bool) {
        let at = self.at.entry(good).or_default();
        *at = (*at + if out { -1.0 } else { 1.0 } * packages / DEPTH).clamp(-1.0, 1.0);
        self.changed = true;
    }

    /// One hour: each mayor makes and buys a little more or less than
    /// usual, and each price moves with the sum of it.
    fn step(&mut self, seed: u32) {
        for good in GOODS {
            let (mut shock, mut n) = (0.0, 0.0);
            for (m, w) in crate::orders::trades().enumerate() {
                let wants = w.0.contains(&good) as i32 as f64 - w.1.contains(&good) as i32 as f64;
                if wants != 0.0 {
                    shock += wants * noise(seed, self.hour, m as u64, good as u64);
                    n += 1.0;
                }
            }
            let push = self.push.entry(good).or_default();
            *push = LASTS * *push + (1.0 - LASTS) * shock / f64::max(1.0, n).sqrt();
            let push = *push;
            let at = self.at.entry(good).or_default();
            *at = (*at * (1.0 - BACK) + PUSH * push).clamp(-1.0, 1.0);
            let price = self.price(good);
            let h = self.history.entry(good).or_default();
            h.push_back(price);
            if h.len() > KEPT {
                h.pop_front();
            }
        }
        self.flows.push_back(BTreeMap::new());
        while self.flows.len() > 24 {
            self.flows.pop_front();
        }
        self.hour += 1;
        self.changed = true;
    }

    pub fn prices(&self) -> Prices {
        let goods = GOODS
            .iter()
            .map(|&good| Quote {
                good,
                price: self.price(good),
                floor: Self::floor(good),
                ceiling: Self::ceiling(good),
                step: Self::nudge(good),
                history: self.history.get(&good).map_or(Vec::new(), |h| h.iter().copied().collect()),
            })
            .collect();
        let lines = self.lines.iter().map(|(&good, &keep)| Line { good, keep }).collect();
        let mut day = BTreeMap::<Good, [f64; 2]>::new();
        for (&good, &[m, u]) in self.flows.iter().flatten() {
            let d = day.entry(good).or_default();
            d[0] += m;
            d[1] += u;
        }
        let flows = day.into_iter().map(|(good, [made, used])| Flow { good, made, used }).collect();
        Prices { goods, lines, desks: self.desks, full: self.full, hour: self.hour, flows }
    }
}

/// A number between -1 and 1, the same for the same four every time.
fn noise(seed: u32, hour: u64, mayor: u64, good: u64) -> f64 {
    let mut z = (seed as u64) ^ hour.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (mayor << 48) ^ (good << 56);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    (z >> 11) as f64 / (1u64 << 52) as f64 - 1.0
}

/// Every hour gone by since the market last stepped, stepped, and the
/// lines kept. Read each step of the game: no wake of its own, so a level
/// or a replay with no market plays as it did.
pub fn hour(world: &mut World, events: &mut traffic::event_queue::EventQueue, now: GameTime) {
    let mut traded = false;
    while (world.market.hour + 1) * HOUR <= now {
        world.market.step(world.map.terrain_seed);
        crate::research::hour(world);
        traded |= keep(world);
    }
    if traded {
        crate::haul::call_lorries(world, events);
    }
}

/// The standing offices' clerks: those with a desk, and those at it now.
fn clerks(world: &World) -> (usize, usize) {
    let office = |b: Option<EntityId>| matches!(b.and_then(|b| world.map.objects.get(b)).map(|e| &e.object), Some(GameObject::Building(b)) if b.kind == BuildingKind::Office && b.site.is_none());
    let hired: Vec<_> = world.map.resident_ids().into_iter().filter_map(|id| world.map.resident(id)).filter(|r| office(r.work)).collect();
    let at_desk = hired.iter().filter(|r| r.at.is_some() && r.at == r.work).count();
    (hired.len(), at_desk)
}

/// What the town has of a good, as a line reads it: on its depots'
/// shelves and on its way in, less what waits at a harbour to go out.
fn position(world: &World, good: Good) -> f64 {
    let shelved: f64 = world.map.depots().into_iter().map(|(_, b)| b.stocks.get(&good).map_or(0.0, |s| s.level)).sum();
    let coming = crate::haul::packages(world).iter().filter(|(t, ..)| t.good == good && !t.outbound).count() as f64;
    let going: usize = world.map.harbours.keys().filter_map(|&h| world.map.building(h)).map(|b| b.outgoing.iter().filter(|t| t.good == good).count()).sum();
    shelved + (coming - going as f64) * good.per_package()
}

/// An hour's clerks to the desk, and each line kept as far as the desk
/// goes: a package bought for each one short of it, sold for each over.
/// Whether anything was traded.
fn keep(world: &mut World) -> bool {
    let (hired, at_desk) = clerks(world);
    let m = &mut world.market;
    // A clerk's day is an office's shift, eight to five.
    let desks = hired as f64 * 9.0 * CLERK;
    m.changed |= desks != m.desks;
    m.desks = desks;
    m.desk = (m.desk + at_desk as f64 * CLERK).min(desks.max(1.0));
    let mut traded = false;
    let mut wanted = false;
    let lines: Vec<(Good, f64)> = world.market.lines.iter().map(|(&g, &k)| (g, k)).collect();
    for (good, keep) in lines {
        let per = good.per_package();
        let off = ((position(world, good) - keep) / per).trunc();
        let out = off > 0.0;
        let mut n = off.abs() as u32;
        while n > 0 && world.market.desk >= 1.0 {
            if trade(world, good, out, 1) == 0 {
                break;
            }
            world.market.desk -= 1.0;
            traded = true;
            n -= 1;
        }
        wanted |= n > 0 && world.market.desk < 1.0;
    }
    if world.market.full != wanted {
        world.market.full = wanted;
        world.market.changed = true;
    }
    traded
}

/// Buy so many packages of a good from the market, on the next ferry in, or
/// sell them, to wait at the harbour for a lorry: each at the price it
/// moves to. How many were booked.
pub fn trade(world: &mut World, good: Good, out: bool, packages: u32) -> u32 {
    let Some(&harbour) = world.map.harbours.keys().next() else { return 0 };
    for n in 0..packages {
        let price = world.market.next(good, out);
        if !crate::orders::book(world, harbour, good, out, None, price) {
            return n;
        }
        world.market.traded(good, 1.0, out);
    }
    packages
}

/// A good's line set, or taken away.
pub fn line(world: &mut World, good: Good, keep: Option<f64>) {
    match keep.filter(|k| k.is_finite() && *k >= 0.0) {
        Some(k) => world.market.lines.insert(good, k),
        None => world.market.lines.remove(&good),
    };
    world.market.changed = true;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A month of hours: every price stays in its band, wanders over most
    /// of it, and comes back to the world's on the whole; fuel swings
    /// wider than stone.
    #[test]
    fn prices_wander_inside_their_bands() {
        let mut m = Market::default();
        let mut seen: BTreeMap<Good, Vec<f64>> = BTreeMap::new();
        for _ in 0..30 * 24 {
            m.step(7);
            for good in GOODS {
                seen.entry(good).or_default().push(m.price(good));
            }
        }
        for (good, p) in &seen {
            let (lo, hi) = p.iter().fold((f64::MAX, f64::MIN), |(lo, hi), &x| (lo.min(x), hi.max(x)));
            let mean = p.iter().sum::<f64>() / p.len() as f64;
            let w = world_price(*good);
            println!("{good:?}: {lo:.3}..{hi:.3}, mean {mean:.3}, world {w:.3}");
            assert!(lo >= Market::floor(*good) - 1e-9 && hi <= Market::ceiling(*good) + 1e-9, "{good:?} left its band");
            assert!((hi - lo) / w > band(*good) * 0.6, "{good:?} hardly moved: {lo:.3}..{hi:.3}");
            assert!((mean / w - 1.0).abs() < band(*good) * 0.5, "{good:?} drifted off: mean {mean:.3}");
        }
        let swing = |g: Good| (Market::ceiling(g) - Market::floor(g)) / world_price(g);
        assert!(swing(Good::Fuel) > 2.0 * swing(Good::Stone));
        assert_eq!(m.history[&Good::Fuel].len(), KEPT, "a week is kept");
    }

    /// A line on timber under what the town has: with no office nobody
    /// sells what is over it; with one staffed, the clerks sell down to
    /// the line within a day and stop there.
    #[test]
    fn an_office_keeps_a_line() {
        use crate::game::tests::*;
        use model::BuildingKind;
        let run = |office: bool| {
            let mut world = street();
            build(&mut world, HARBOUR_X - 12, BuildingKind::Depot);
            build(&mut world, 0, BuildingKind::Apartment);
            build(&mut world, 6, BuildingKind::Apartment);
            if office {
                build(&mut world, 12, BuildingKind::Office);
            }
            let mut game = game(world);
            game.run_to(DAY_MS as GameTime / 3);
            let had = position(&game.world, Good::Timber);
            line(&mut game.world, Good::Timber, Some(20.0));
            game.run_to(2 * DAY_MS as GameTime);
            (had, position(&game.world, Good::Timber), game.world.market.desks)
        };
        let (had, none, _) = run(false);
        assert!(had > 40.0, "the town had only {had} timber to sell");
        assert!((none - had).abs() < 1e-6, "{had} timber became {none} with no office to sell it");
        let (had, kept, desks) = run(true);
        println!("{had} timber kept to {kept}; desks {desks:.0} packages a day");
        assert!((kept - 20.0).abs() <= Good::Timber.per_package(), "the line kept {kept}, not 20");
    }

    /// The same seed, the same graph; buying moves the price up, and the
    /// town never pays over the ceiling nor gets under the floor.
    #[test]
    fn the_same_seed_gives_the_same_market() {
        let run = || {
            let mut m = Market::default();
            (0..100).for_each(|_| m.step(3));
            m.price(Good::Fuel)
        };
        assert_eq!(run(), run());
        let mut m = Market::default();
        let before = m.price(Good::Fuel);
        assert!(m.next(Good::Fuel, false) > before && m.next(Good::Fuel, true) < before, "a package is paid at the price it moves to");
        m.traded(Good::Fuel, 50.0, false);
        assert!(m.price(Good::Fuel) > before, "buying did not push the price");
        m.traded(Good::Fuel, 1e6, false);
        assert!(m.next(Good::Fuel, false) <= Market::ceiling(Good::Fuel) + 1e-9);
        m.traded(Good::Fuel, 1e6, true);
        assert!(m.next(Good::Fuel, true) >= Market::floor(Good::Fuel) - 1e-9);
    }
}
