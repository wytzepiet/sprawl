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
//! A "when" order waits for a price: buy so many packages when it falls to
//! it, sell when it rises to it. It is read each hour, and booked as far
//! as the deck and the treasury go.

use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::economy::world_price;
use crate::engine::GameTime;
use crate::protocol::{Good, DAY_MS};
use crate::world::World;

/// The goods on the market, in the order the list shows them.
pub const GOODS: [Good; 4] = [Good::Timber, Good::Stone, Good::Crates, Good::Fuel];

/// How far a good's price may stray from the world's, each way, as a
/// share of it: the band. Never under freight, so the world's two prices
/// are always at least as far apart as the market's buy and sell.
fn band(good: Good) -> f64 {
    match good {
        Good::Stone => 0.15,
        Good::Timber | Good::Crates => 0.2,
        Good::Fuel => 0.5,
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

/// A "when" order: so many packages of a good, bought once the price falls
/// to this, or sold once it rises to it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct When {
    #[ts(type = "number")]
    pub id: u64,
    pub good: Good,
    pub out: bool,
    pub packages: u32,
    pub price: f64,
}

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
    pub orders: Vec<When>,
    /// Something a client would draw changed since it was last sent.
    #[serde(skip)]
    pub changed: bool,
}

/// A good on the market as the clients are sent it: the price, the
/// band, what the town pays and gets at its harbour, and the week.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Quote {
    pub good: Good,
    pub price: f64,
    pub floor: f64,
    pub ceiling: f64,
    /// How far a package moves the price, a unit's: each is paid at the
    /// price it moved to.
    pub step: f64,
    /// The price each hour kept, oldest first; the last is the hour just
    /// gone.
    pub history: Vec<f64>,
}

/// The market's part of what the clients are sent, when it changes.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Prices {
    pub goods: Vec<Quote>,
    pub orders: Vec<When>,
    /// The hour the last price is for, from the world's start.
    #[ts(type = "number")]
    pub hour: u64,
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
        Prices { goods, orders: self.orders.clone(), hour: self.hour }
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
/// orders whose price came read. Read each step of the game: no wake of
/// its own, so a level or a replay with no market plays as it did.
pub fn hour(world: &mut World, events: &mut crate::engine::event_queue::EventQueue, now: GameTime) {
    let mut traded = false;
    while (world.market.hour + 1) * HOUR <= now {
        world.market.step(world.terrain_seed);
        // An order is read at the hour's price, and booked as far as it goes.
        for i in (0..world.market.orders.len()).rev() {
            let o = world.market.orders[i];
            let price = world.market.price(o.good);
            if if o.out { price < o.price } else { price > o.price } {
                continue;
            }
            let left = o.packages - trade(world, o.good, o.out, o.packages);
            traded |= left < o.packages;
            if left == 0 {
                world.market.orders.remove(i);
            } else {
                world.market.orders[i].packages = left;
            }
        }
    }
    if traded {
        crate::haul::call_lorries(world, events);
    }
}

/// Buy so many packages of a good from the market, on the next ferry in, or
/// sell them, to wait at the harbour for a lorry: each at the price it
/// moves to. How many were booked.
pub fn trade(world: &mut World, good: Good, out: bool, packages: u32) -> u32 {
    let Some(&harbour) = world.harbours.keys().next() else { return 0 };
    for n in 0..packages {
        let price = world.market.next(good, out);
        if !crate::orders::book(world, harbour, good, out, None, price, None) {
            return n;
        }
        world.market.traded(good, 1.0, out);
    }
    packages
}

/// A "when" order placed.
pub fn order(world: &mut World, good: Good, out: bool, packages: u32, price: f64) {
    if packages == 0 || !price.is_finite() {
        return;
    }
    let id = world.objects.reserve_id();
    world.market.orders.push(When { id, good, out, packages, price });
    world.market.changed = true;
}

pub fn cancel(world: &mut World, order: u64) {
    world.market.orders.retain(|o| o.id != order);
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
