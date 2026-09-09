//! What a city earns: its taps, serving people.
//!
//! Output belongs to whoever produced it. A house earns by sheltering its
//! household, a factory by employing whoever turns up, a restaurant by
//! feeding whoever comes in — from the next town over as readily as from
//! down the street. That is what lets one city be the place people live and
//! another the place they work, and what makes the road between them worth
//! building. There is one owner today, the world; this is the seam.
//!
//! The ledger does not wait for a shift to end. It knows who is being served
//! where and what that is worth per millisecond, so the total at any moment
//! is a sum of the taps' hours integrated since it last took stock — exact,
//! whether or not anything happened to wake it in between — and the rate is
//! there for a client to run the bar forward with between updates.

use crate::engine::GameTime;
use crate::needs::Tap;
use crate::protocol::{BuildingKind, Growth, DAY_MS};
use crate::world::World;

/// One hour of need served — the unit prices and levels are written in.
/// Obligation is kept in milliseconds, so saying so here is what keeps
/// those numbers legible.
pub const SERVED_HOUR: f64 = DAY_MS as f64 / 24.0;
/// Output for the first level. Each one after costs a level more than the last.
const LEVEL_BASE: f64 = 30.0 * SERVED_HOUR;

/// One point: a minute of need served. Obligation is kept in milliseconds,
/// which makes for numbers nobody can read on a bar.
fn points(served: f64) -> f64 {
    served * 60.0 / SERVED_HOUR
}

/// What one of a kind costs the mayor, in the ledger's own units, with the
/// build's discount on its class.
pub fn price(world: &World, kind: BuildingKind) -> f64 {
    let b = crate::blueprint::blueprint(kind);
    b.price * SERVED_HOUR / world.build.weight(b.class)
}

/// What the mayor has to spend: earned, less spent.
pub fn balance(world: &World, now: GameTime) -> f64 {
    world.xp.at(now) - world.spent
}

/// Everything the dials need to draw themselves, so the numbers behind
/// them stay in here with the constants that set them.
pub fn growth(world: &World, now: GameTime) -> Growth {
    let earned = world.xp.at(now);
    let (level, reached) = level(earned);
    Growth {
        level,
        xp: points(earned - reached),
        xp_needed: points(LEVEL_BASE * (level as f64 + 1.0)),
        balance: points(balance(world, now)),
        rate: points(world.xp.rate(now)),
        taken: world.build.taken(),
        road_tiles_left: world.build.road_tiles().saturating_sub(world.laid),
    }
}

/// The city's level, and what it took to reach it.
///
/// Level `n` is reached at `LEVEL_BASE * n * (n + 1) / 2`, so each one asks for
/// a little more than the last.
pub fn level(earned: f64) -> (u32, f64) {
    let n = (((1.0 + 8.0 * earned / LEVEL_BASE).sqrt() - 1.0) / 2.0).floor().max(0.0);
    (n as u32, LEVEL_BASE * n * (n + 1.0) / 2.0)
}

#[derive(Default)]
pub struct Ledger {
    /// Earned up to `since`, in obligation-milliseconds served.
    settled: f64,
    since: GameTime,
    /// Everyone being served right now: their rate, and the tap's hours.
    pub streams: Vec<(f64, &'static Tap)>,
}

impl Ledger {
    pub fn load(settled: f64, since: GameTime) -> Self {
        Ledger { settled, since, streams: Vec::new() }
    }

    /// Earned so far, to the millisecond.
    pub fn at(&self, now: GameTime) -> f64 {
        self.settled + self.streams.iter().map(|(r, t)| r * t.curve.integral(self.since, now)).sum::<f64>()
    }

    /// Earning per millisecond right now.
    pub fn rate(&self, now: GameTime) -> f64 {
        self.streams.iter().map(|(r, t)| r * t.curve.at(now)).sum()
    }

    /// Bank what the present streams have earned. Call before they change.
    pub fn settle(&mut self, now: GameTime) {
        self.settled = self.at(now);
        self.since = now;
    }
}
