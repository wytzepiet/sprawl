pub mod curve;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::engine::GameTime;
use crate::protocol::DAY_MS;
use curve::Curve;

const H: u32 = DAY_MS / 24;
const HOUR: f64 = H as f64;

/// Something a resident has to do. Three kinds, by where the timing lives:
/// a **timed** need is used up by the passage of time and carries it in
/// `drain`; a **constant** need is imposed by the world and carries it in
/// the curve of whatever serves it, holding a fixed level meanwhile; a
/// **driven** need is used up by the road, a little per tile, and is the
/// car's rather than the day's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Need {
    /// Being at home. The baseline every other activity has to beat, and
    /// what pulls a resident back when the shift ends and nothing else is
    /// open yet.
    Home,
    Work,
    Rest,
    /// Meals take as long as the hunger owed, up to a sitting: served at
    /// home always, and wherever sells food while it is open.
    Eat,
    /// Time off. Served indifferently at home and well at a place to go —
    /// the first need with nothing in the world to say when.
    Leisure,
    /// The tank. Used by the mile rather than the hour, and refilled at a pump.
    Fuel,
}

impl Need {
    /// Baseline first, so ties fall to staying put.
    pub const ALL: [Need; 6] = [Need::Home, Need::Work, Need::Rest, Need::Eat, Need::Leisure, Need::Fuel];
    /// The needs a person carries. The tank is the car's, though its
    /// driver is the one who decides to fill it.
    pub const OWN: [Need; 5] = [Need::Home, Need::Work, Need::Rest, Need::Eat, Need::Leisure];

    /// A tank's worth, in tiles. What sets how often anyone stops for fuel.
    pub const TANK_TILES: f64 = 500.0;

    /// Stock used per tile driven.
    pub fn per_tile() -> f64 {
        Need::Fuel.cap() / Need::TANK_TILES
    }

    /// How long a fill takes: twenty minutes at the pump, so the pump's
    /// rate is the tank over that.
    pub const FILL_MS: f64 = HOUR / 3.0;

    /// Holds its level: the world's curves say when, not the stock.
    pub fn constant(self) -> bool {
        matches!(self, Need::Work | Need::Home)
    }

    /// Stock used per millisecond not spent refilling it. Zero for a
    /// constant need. For `D` hours a day at unit rate this is `D / (24 - D)`.
    pub fn drain(self) -> f64 {
        match self {
            Need::Work | Need::Home | Need::Fuel => 0.0,
            Need::Rest => 8.0 / 16.0,
            // About 1.2 hours a day, as people actually spend: a sitting is
            // owed ten hours after the last, and lunch out is worth the
            // drive about six hours after breakfast.
            Need::Eat => 0.05,
            // About five hours a day, as people actually spend, at the rate
            // home serves it.
            Need::Leisure => 0.35 * 5.0 / 19.0,
        }
    }

    /// The most that can be held, in milliseconds of need.
    pub fn cap(self) -> f64 {
        match self {
            Need::Work | Need::Home => 24.0 * HOUR,
            Need::Rest => 12.0 * HOUR,
            Need::Eat => 0.5 * HOUR,
            Need::Leisure => 5.0 * HOUR,
            // What an empty tank costs: the afternoon it takes to be towed
            // and filled, which is what a fill has to be worth to be
            // scored against its price. A near-empty tank then beats an
            // evening in and loses to a shift, as it should.
            Need::Fuel => 2.0 * HOUR,
        }
    }

    /// The one thing a tap sells, in milliseconds of need: a sitting, an
    /// evening, a tank, an hour of labour. A price is per one of these,
    /// and a shelf counts them. docs/economy.md §12.1.
    pub fn unit(self) -> f64 {
        match self {
            Need::Work | Need::Home | Need::Rest => HOUR,
            Need::Eat | Need::Leisure | Need::Fuel => self.cap(),
        }
    }

    /// Where a fresh stock stands. A constant need sits at `k * cap` for
    /// good, and `k` is the threshold: the agent works unless something else
    /// is more than this short. Home must beat waiting overnight at work
    /// (`0.5 * shift / 24`, about 0.19) and lose to a morning's commute.
    /// Read as what is missing: Work is half short, Home three tenths.
    pub fn fresh(self) -> Stock {
        let cap = self.cap();
        let level = match self {
            Need::Work => 0.5 * cap,
            Need::Home => 0.7 * cap,
            // Everyone drives in from beyond the edge, where fuel is
            // unlimited: the tank is full, less the drive in.
            Need::Rest | Need::Eat | Need::Leisure | Need::Fuel => cap,
        };
        Stock { level, cap }
    }

    /// Hours a day a timed need asks for: the referent `drain` was derived
    /// from. Zero for a constant need, which fills time rather than
    /// demanding it.
    fn daily_ms(self) -> f64 {
        let drain = self.drain();
        DAY_MS as f64 * drain / (1.0 + drain)
    }

    /// The best any tap anywhere serves this: greatest rate, least overhead.
    /// What bounds a stock's score without looking at any building.
    pub fn bounds(self) -> (f64, GameTime) {
        crate::blueprint::all_taps()
            .filter(|t| t.need == self)
            .fold((0.0, GameTime::MAX), |(r, h), t| (r.max(t.rate), h.min(t.overhead)))
    }

    /// The most any option for a stock `short` of full can score, from the
    /// bounds alone: `w * min(R, L / H)`.
    pub fn ceiling(self, short: f64) -> f64 {
        let (r, h) = self.bounds();
        let by_overhead = if h == 0 { f64::INFINITY } else { short / h as f64 };
        short / self.cap() * r.min(by_overhead)
    }

    /// The shortfall at which `ceiling` first exceeds `target`, or None if
    /// no shortfall under `cap` does.
    pub fn short_for(self, target: f64) -> Option<f64> {
        let (r, h) = self.bounds();
        let cap = self.cap();
        let h = h as f64;
        // Below `r * h` the overhead term binds and the ceiling is quadratic
        // in the shortfall; above, the rate binds and it is linear.
        let u = if h == 0.0 {
            target * cap / r
        } else {
            let quad = (target * cap * h).sqrt();
            if quad <= r * h { quad } else { target * cap / r }
        };
        (u < cap).then_some(u)
    }
}

/// Something that runs down: a shelf of meals, a tank, a night's sleep, a
/// day of time off. `(level, cap)` on whoever holds it; it drains by use
/// and refills at a tap or by a delivery. What is missing is the need, and
/// how much of the cap is missing is its weight. docs/economy.md §4.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Stock {
    pub level: f64,
    pub cap: f64,
}

impl Stock {
    pub fn full(cap: f64) -> Stock {
        Stock { level: cap, cap }
    }

    /// What is missing.
    pub fn short(&self) -> f64 {
        self.cap - self.level
    }

    /// Fraction of the cap missing: the weight in the score.
    pub fn weight(&self) -> f64 {
        if self.cap > 0.0 { self.short() / self.cap } else { 0.0 }
    }

    /// Use some up, down to empty.
    pub fn take(&mut self, amount: f64) {
        self.level = (self.level - amount).max(0.0);
    }

    /// Put some in, up to the cap.
    pub fn add(&mut self, amount: f64) {
        self.level = (self.level + amount).min(self.cap);
    }
}

/// One need's standing with one resident: the stock, and a note.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Bucket {
    pub need: Need,
    #[serde(default)]
    pub stock: Stock,
    /// How far short of being served on the spot the last wake fell, from 0
    /// (as well as it could be) to 1 (nothing found anywhere). A record of
    /// the last decision, not a plan: the demand readout sums it to say what
    /// the city wants and where, without asking anyone to think again.
    #[serde(default)]
    pub shortfall: f64,
}

impl Bucket {
    /// A full set, the way a new resident is issued them.
    pub fn fresh() -> Vec<Bucket> {
        Need::OWN.iter().map(|&need| Bucket { need, stock: need.fresh(), shortfall: 0.0 }).collect()
    }

    /// A car's tank, as issued: full.
    pub fn tank() -> Stock {
        Need::Fuel.fresh()
    }

    /// Any need a saved resident predates, issued fresh; any they no longer
    /// carry — the tank, once it moved to the car — dropped; any saved
    /// before it was a stock, with no cap to its name, issued fresh.
    pub fn top_up(buckets: &mut Vec<Bucket>) {
        buckets.retain(|b| Need::OWN.contains(&b.need));
        for b in buckets.iter_mut() {
            if b.stock.cap == 0.0 {
                b.stock = b.need.fresh();
            }
        }
        for &need in &Need::OWN {
            if !buckets.iter().any(|b| b.need == need) {
                buckets.push(Bucket { need, stock: need.fresh(), shortfall: 0.0 });
            }
        }
    }
}

/// A building's offer to serve one need.
#[derive(Debug, Clone)]
pub struct Tap {
    pub need: Need,
    pub curve: Curve,
    /// Need refilled per availability-millisecond. Infinite for a
    /// service whose length is fixed regardless of how much is missing.
    pub rate: f64,
    /// Time on arrival before service begins.
    pub overhead: GameTime,
    /// How many it serves at once at full rate. Past that, everyone present
    /// is served proportionally slower.
    pub slots: u32,
}

impl Tap {
    /// Units it could sell in a day with every slot busy: what "sold out"
    /// is measured against.
    pub fn rated(&self) -> f64 {
        self.slots as f64 * self.curve.per_day() * self.rate / self.need.unit()
    }
}

/// Check the needs against the invariant the decision procedure leans on.
/// What each building serves is checked with its blueprint.
pub fn check() {
    let day = DAY_MS as u64;
    // N1: what is used up fits in a day.
    let asked: f64 = Need::ALL.iter().map(|n| n.daily_ms()).sum();
    assert!(asked <= day as f64, "needs ask for {:.1}h of a 24h day", asked / HOUR);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_definitions_hold_up() {
        check();
    }

    #[test]
    fn rest_asks_for_eight_hours() {
        assert!((Need::Rest.daily_ms() - 8.0 * HOUR).abs() < 1.0);
    }

    #[test]
    fn the_ceiling_inverts() {
        for need in Need::ALL {
            let short = 0.3 * need.cap();
            let target = need.ceiling(short);
            let back = need.short_for(target).expect("under cap");
            assert!((back - short).abs() < 1.0, "{need:?}: {back} vs {short}");
        }
        assert_eq!(Need::Rest.short_for(f64::INFINITY), None);
    }

    #[test]
    fn a_stock_runs_down_and_refills_within_its_cap() {
        let mut s = Stock::full(10.0);
        s.take(4.0);
        assert_eq!((s.level, s.short(), s.weight()), (6.0, 4.0, 0.4));
        s.take(100.0);
        assert_eq!(s.level, 0.0);
        s.add(100.0);
        assert_eq!(s.level, 10.0);
    }
}
