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
