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
//! One price, the same to buy and to sell, but for freight. Each package moves it a step,
//! a two-hundredth of the way from the world's price to the band's edge, and is
//! paid at the price it moved to: a package bought pushes the price up and
//! costs the new price, a package sold pushes it down and gets the new one.
//! So a quick flip always loses a step a package and both freights, and a town that buys a
//! whole ferry of a good pays more for the last package than the first. Past
//! the band there is no more room: the world sells at its ceiling and
//! buys at its floor.
//!
//! The price steps once an hour of the town's day, from the world's seed
//! and the hour alone, so the same seed and the same trades give the same
//! graph on every machine. A week of hours is kept, and saved.
//!
//! The town trades by itself (docs/core.md §Trade): whatever it lacks
//! the ship brings, and it pays; whatever is left over sails, and it is
//! paid. Each hour, each good: bought up to what the town will want
//! before the ferry after next can bring more (`want`), sold over twice
//! that, or over that and what its depots hold, whichever is more.
//! Between the two it waits, so nothing is bought one hour to be sold
//! the next, and what its makers make more of than it wants sails
//! before their yards fill and stop them.
//!
//! Every crossing costs freight (`FREIGHT`): a package bought costs the
//! price it moved to and that share more, one sold gets that share less.
//! What the town makes for itself it never pays the freight on.
//!
//! Every package is a mayor's (`orders::partner`), and what crossed is
//! kept as deals: a few days of them, and a day of each good's tally.

use model::market::{Deal, Flow, Quote, Prices};
use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::economy::{world_price, FREIGHT};
use model::blueprint::depot;
use model::GameTime;
use model::{EntityId, GameObject, Good, Package, DAY_MS};
use crate::world::World;

/// The goods on the market, in the order the list shows them. Bread is
/// fresh and never on it: every town bakes its own.
pub const GOODS: [Good; 10] = [Good::Timber, Good::Stone, Good::Grain, Good::Fuel, Good::Cement, Good::Ore, Good::Coal, Good::Steel, Good::Machinery, Good::Crude];

/// How far a good's price may stray from the world's, each way, as a
/// share of it: the band.
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
/// Deals kept: a few days' worth.
const DEALS: usize = 200;
/// Packages the town trades to move a price from the world's to its
/// ceiling or floor. A town that buys a lorry of fuel a sailing barely
/// moves it, the drift back taking each step away again within the day;
/// a whole deck of sixty bought at once moves it most of a third of its
/// band.
const DEPTH: f64 = 200.0;
/// How much deeper the market is to a town with a container port
/// standing: bulk, its trades moving the price a third as far.
const PORT_DEPTH: f64 = 3.0;
/// How much of an hour's push from the mayors lasts into the next: a
/// glut or a shortage lasts most of a day.
const LASTS: f64 = 0.85;
/// How far an hour's push moves the price through its band, and how much
/// of the way back to the world's it drifts each hour.
const PUSH: f64 = 0.12;
const BACK: f64 = 0.03;

/// An hour of a good: units made and used in town, packages in and out
/// over the border, and their coins.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
struct Tally {
    made: f64,
    used: f64,
    imported: u32,
    exported: u32,
    spent: f64,
    earned: f64,
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
    /// Each good, an hour a row, the last day's; the last row the hour
    /// going.
    #[serde(default)]
    tallies: VecDeque<BTreeMap<Good, Tally>>,
    /// What crossed the border, oldest first.
    #[serde(default)]
    deals: VecDeque<Deal>,
    /// A container port stands, as last settled: the market is deeper to
    /// the town (`PORT_DEPTH`). Derived.
    #[serde(skip)]
    pub port: bool,
    /// Something a client would draw changed since it was last sent.
    #[serde(skip)]
    pub changed: bool,
}

impl Market {
    pub fn price(&self, good: Good) -> f64 {
        world_price(good) * (1.0 + band(good) * self.at.get(&good).copied().unwrap_or(0.0))
    }
    /// What the world sells at: the most the market ever asks.
    pub fn ceiling(good: Good) -> f64 {
        world_price(good) * (1.0 + band(good))
    }
    /// What the world buys at: the least the market ever offers.
    pub fn floor(good: Good) -> f64 {
        world_price(good) * (1.0 - band(good))
    }
    /// How far a package moves a good's price, a unit's.
    pub fn nudge(&self, good: Good) -> f64 {
        world_price(good) * band(good) / self.depth()
    }
    /// Packages that move a price from the world's to its band's edge.
    fn depth(&self) -> f64 {
        if self.port { DEPTH * PORT_DEPTH } else { DEPTH }
    }
    /// What a unit of the next package costs the town bought, or gets it
    /// sold: the price it moves to, never past the band, and the freight.
    pub fn next(&self, good: Good, out: bool) -> f64 {
        let moved = (self.price(good) + if out { -1.0 } else { 1.0 } * self.nudge(good)).clamp(Self::floor(good), Self::ceiling(good));
        moved * if out { 1.0 - FREIGHT } else { 1.0 + FREIGHT }
    }

    /// So many units of a good made in town, or used.
    pub fn made(&mut self, good: Good, units: f64) {
        self.tally(good).made += units;
    }
    pub fn used(&mut self, good: Good, units: f64) {
        self.tally(good).used += units;
    }
    fn tally(&mut self, good: Good) -> &mut Tally {
        if self.tallies.is_empty() {
            self.tallies.push_back(BTreeMap::new());
        }
        self.tallies.back_mut().unwrap().entry(good).or_default()
    }

    /// A package crossed the border, landed or sailed: on the hour's
    /// tally, and a deal, or one more of the last deal if that is the same
    /// good with the same partner the same way this hour.
    pub fn crossed(&mut self, t: &Package, now: GameTime) {
        let Some(partner) = t.partner else { return };
        let tally = self.tally(t.good);
        if t.outbound {
            tally.exported += 1;
            tally.earned += t.value();
        } else {
            tally.imported += 1;
            tally.spent += t.value();
        }
        match self.deals.back_mut().filter(|d| (d.good, d.out, d.partner) == (t.good, t.outbound, partner) && d.at / HOUR == now / HOUR) {
            Some(d) => {
                d.price = (d.price * d.packages as f64 + t.price) / (d.packages + 1) as f64;
                d.packages += 1;
            }
            None => {
                self.deals.push_back(Deal { at: now, good: t.good, packages: 1, out: t.outbound, partner, price: t.price });
                if self.deals.len() > DEALS {
                    self.deals.pop_front();
                }
            }
        }
        self.changed = true;
    }

    /// Units of a good the town used an hour over what it made, over the
    /// hours kept but the one going.
    fn rate(&self, good: Good) -> f64 {
        let done = self.tallies.len().saturating_sub(1);
        let net: f64 = self.tallies.iter().take(done).filter_map(|h| h.get(&good)).map(|t| t.used - t.made).sum();
        net / done.max(1) as f64
    }

    /// The town traded so many packages: the price moves its way.
    fn traded(&mut self, good: Good, packages: f64, out: bool) {
        let depth = self.depth();
        let at = self.at.entry(good).or_default();
        *at = (*at + if out { -1.0 } else { 1.0 } * packages / depth).clamp(-1.0, 1.0);
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
        self.tallies.push_back(BTreeMap::new());
        while self.tallies.len() > 24 {
            self.tallies.pop_front();
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
                step: self.nudge(good),
                history: self.history.get(&good).map_or(Vec::new(), |h| h.iter().copied().collect()),
            })
            .collect();
        let mut day = BTreeMap::<Good, Tally>::new();
        for (&good, t) in self.tallies.iter().flatten() {
            let d = day.entry(good).or_default();
            d.made += t.made;
            d.used += t.used;
            d.imported += t.imported;
            d.exported += t.exported;
            d.spent += t.spent;
            d.earned += t.earned;
        }
        let flows = day
            .into_iter()
            .map(|(good, t)| Flow { good, made: t.made, used: t.used, imported: t.imported, exported: t.exported, spent: t.spent, earned: t.earned })
            .collect();
        Prices { goods, flows, deals: self.deals.iter().copied().collect(), hour: self.hour }
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
/// town's goods kept. Read each step of the game: no wake of its own, so
/// a level or a replay with no market plays as it did.
pub fn hour(world: &mut World, events: &mut traffic::event_queue::EventQueue, now: GameTime) {
    let mut traded = false;
    while (world.market.hour + 1) * HOUR <= now {
        world.market.step(world.map.terrain_seed);
        crate::research::hour(world);
        traded |= keep(world, now);
    }
    if traded {
        crate::haul::call_lorries(world, events);
    }
}

/// What the town has of a good: on its depots' shelves, in the yards of
/// the makers that make it, in its vans, and on its way in, less what
/// waits at a harbour to go out.
fn position(world: &World, good: Good) -> f64 {
    let kept: f64 = world
        .map
        .objects
        .iter()
        .filter_map(|e| match e.object {
            GameObject::Building(ref b) if depot(b.kind) || model::blueprint::makes(b.kind, good) => b.stocks.get(&good).map(|s| s.level),
            GameObject::Car(ref c) => c.load.filter(|l| l.0 == good).map(|l| l.1),
            _ => None,
        })
        .sum();
    let coming = crate::haul::packages(world).iter().filter(|(t, ..)| t.good == good && !t.outbound).count() as f64;
    let going: usize = world.map.harbours.keys().filter_map(|&h| world.map.building(h)).map(|b| b.outgoing.iter().filter(|t| t.good == good).count()).sum();
    kept + (coming - going as f64) * good.per_package()
}

/// What the town will want of a good before the ferry after next can
/// bring more, `ahead` from now: what it uses over what it makes, at the
/// last day's rate, and what its sites still wait for and its counters'
/// and works' bins have room for.
fn want(world: &World, good: Good, ahead: GameTime) -> f64 {
    let owed: f64 = world
        .map
        .objects
        .iter()
        .filter_map(|e| match e.object {
            GameObject::Building(ref b) => match b.site {
                Some(ref site) => site.get(&good).map(|s| s.short()),
                None if !depot(b.kind) && crate::economy::buys(b.kind, good) => b.stocks.get(&good).map(|s| s.short()),
                None => None,
            },
            _ => None,
        })
        .sum();
    (world.market.rate(good) * ahead as f64 / HOUR as f64).max(0.0) + owed
}

/// What the depots hold of a good at most.
fn room(world: &World, good: Good) -> f64 {
    world.map.depots().into_iter().filter_map(|(_, b)| b.stocks.get(&good)).map(|s| s.cap).sum()
}

/// An hour's trade: each good bought up to what the town will want, and
/// sold over twice that or over that and a full depot's, whichever is
/// more. Whether anything was booked.
fn keep(world: &mut World, now: GameTime) -> bool {
    let Some(&harbour) = world.map.harbours.keys().next() else { return false };
    let (Some(lands), Some(line)) = (world.next_ferry(harbour).and_then(|f| world.next_call(f)), world.lines.get(&harbour)) else { return false };
    let ahead = lands.saturating_sub(now) + line.cycle() / line.every_call() as GameTime;
    let mut traded = false;
    for good in GOODS {
        let (have, want, per) = (position(world, good), want(world, good, ahead), good.per_package());
        let sell = (2.0 * want).max(want + room(world, good));
        let (out, n) = if have < want { (false, ((want - have) / per).ceil()) } else { (true, ((have - sell) / per).floor().max(0.0)) };
        traded |= trade(world, harbour, good, out, n as u32) > 0;
    }
    traded
}

/// Buy so many packages of a good from the market, on the next ferry in, or
/// sell them, to wait at the harbour for a lorry: each at the price it
/// moves to, a mayor's. How many were booked.
fn trade(world: &mut World, harbour: EntityId, good: Good, out: bool, packages: u32) -> u32 {
    let partner = crate::orders::partner(good, out, world.market.hour);
    for n in 0..packages {
        let price = world.market.next(good, out);
        if !crate::orders::book(world, harbour, good, out, Some(partner), price) {
            return n;
        }
        world.market.traded(good, 1.0, out);
    }
    packages
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

    /// What crossed the border of a good, in and out, in packages, and
    /// who with: the deals kept.
    fn traded(world: &World, good: Good) -> ([u32; 2], Vec<Deal>) {
        let deals: Vec<Deal> = world.market.prices().deals.into_iter().filter(|d| d.good == good).collect();
        let sum = |out: bool| deals.iter().filter(|d| d.out == out).map(|d| d.packages).sum();
        ([sum(false), sum(true)], deals)
    }

    /// A sawmill in the woods and nothing in town built of timber: what
    /// the depot has no room for sails, to mayors whose towns want it,
    /// and none is bought.
    #[test]
    fn a_town_sells_what_it_makes_and_does_not_use() {
        use crate::game::tests::*;
        use land::TerrainType;
        use model::BuildingKind;
        let mut world = street();
        for x in SAWMILL_X - 5..SAWMILL_X + 7 {
            for y in 5..14 {
                world.map.terrain.insert((x, y), TerrainType::Forest);
            }
        }
        build(&mut world, HARBOUR_X - 12, BuildingKind::Depot);
        build(&mut world, SAWMILL_X, BuildingKind::Sawmill);
        build(&mut world, SAWMILL_X - 6, BuildingKind::Apartment);
        let mut game = game(world);
        game.run_to(3 * DAY_MS as GameTime);
        let ([bought, sold], deals) = traded(&game.world, Good::Timber);
        println!("timber: bought {bought}, sold {sold}: {deals:?}");
        assert_eq!(bought, 0, "timber bought by a town that makes it");
        assert!(sold > 0, "the sawmill's timber never sailed");
        let earned: f64 = game.world.town.season().map(|p| p.sold.get(&Good::Timber).copied().unwrap_or(0.0)).sum();
        assert!(earned > 0.0, "nobody paid for the timber");
        let wants = |m: model::orders::Mayor| crate::orders::trades().nth(m as usize).unwrap().0.contains(&Good::Timber);
        assert!(deals.iter().all(|d| d.out && wants(d.partner) && d.price <= Market::ceiling(Good::Timber) * (1.0 - FREIGHT)), "{deals:?}");
    }

    /// A town that bakes and drives and grows no grain and pumps no oil:
    /// grain and fuel come over the sea ahead of need, so neither the
    /// bakery's bin nor the pumps' tanks, with the depot's shelf behind
    /// them, ever stand empty once the first has come; and none is sold
    /// again.
    #[test]
    fn a_town_buys_ahead_what_it_uses_and_does_not_make() {
        use crate::game::tests::*;
        use model::BuildingKind;
        let mut world = street();
        let depot = build(&mut world, HARBOUR_X - 12, BuildingKind::Depot);
        // Bare, as a depot is built.
        world.map.building_mut(depot).unwrap().stocks.values_mut().for_each(|s| s.level = 0.0);
        let bakery = build(&mut world, 40, BuildingKind::Bakery);
        let pump = build(&mut world, 30, BuildingKind::GasStation);
        for x in [0, 3, 6, 9, 12] {
            build(&mut world, x, BuildingKind::Apartment);
        }
        build(&mut world, 20, BuildingKind::Shop);
        build(&mut world, 46, BuildingKind::Supermarket);
        let mut game = game(world);
        let level = |w: &World, at: EntityId, good: Good| w.map.building(at).and_then(|b| b.stocks.get(&good)).map_or(0.0, |s| s.level);
        let mut dry = Vec::new();
        for hour in 1..=4 * 24 {
            game.run_to(hour * HOUR);
            let w = &game.world;
            for (at, good) in [(bakery, Good::Grain), (pump, Good::Fuel)] {
                if hour > 24 && level(w, at, good) + level(w, depot, good) <= 0.0 {
                    dry.push((hour, good));
                }
            }
        }
        for good in [Good::Grain, Good::Fuel] {
            let ([bought, sold], _) = traded(&game.world, good);
            println!("{good:?}: bought {bought}, sold {sold}");
            assert!(bought > 0, "no {good:?} was bought");
            assert_eq!(sold, 0, "{good:?} bought was sold again");
        }
        assert!(dry.is_empty(), "ran dry, at hours: {dry:?}");
    }

    /// The same seed, the same graph; buying moves the price up, and the
    /// town never pays over the ceiling nor gets under the floor, but
    /// for the freight.
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
        assert!(m.next(Good::Fuel, false) <= Market::ceiling(Good::Fuel) * (1.0 + FREIGHT) + 1e-9);
        m.traded(Good::Fuel, 1e6, true);
        assert!(m.next(Good::Fuel, true) >= Market::floor(Good::Fuel) * (1.0 - FREIGHT) - 1e-9);
    }
}
