//! Lines and their round. A line is a ring of calls its ships sail
//! round, timed on a clock face so its ferries keep their places on it.

use crate::engine::GameTime;

use super::{length, sail_ms, HOUR};

/// The clock a line times by: its round is this times a power of two (50
/// minutes, 1:40, 3:20, 6:40, 13:20), so its sailings keep their places
/// on the clock. Fifty minutes, not an hour: the season's ferry, its raw
/// round 2:44, would have waited out a four-hour one, and its town went
/// hungry; at 3:20 it does not.
pub const TAKT: GameTime = HOUR * 5 / 6;
/// The longest a harbour waits between calls of the world's line: as
/// often as the old ferry came, on the clock (four `TAKT`s, 3:20).
pub const CALL_EVERY: GameTime = 4 * TAKT;

/// A place a line calls: a harbour, or the world beyond the map's edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Call {
    Harbour(u64),
    World,
}

/// A line: the calls its ships make, in order and round again; the way
/// from each to the next (`legs[i]` from `calls[i]`); how long a ship
/// stands at a harbour, and at the world beyond the edge.
#[derive(Debug, Clone)]
pub struct Line {
    pub calls: Vec<Call>,
    pub legs: Vec<Vec<[f64; 2]>>,
    pub dwell: GameTime,
    pub stay: GameTime,
}

impl Line {
    /// How long a leg takes: eased at the berths, at full speed over the
    /// edge.
    pub fn leg_ms(&self, i: usize) -> GameTime {
        let n = self.calls.len();
        let ease = [self.calls[i] != Call::World, self.calls[(i + 1) % n] != Call::World];
        sail_ms(length(&self.legs[i]), ease)
    }

    /// Once round as timetabled: every leg and every stay, on the clock.
    pub fn cycle(&self) -> GameTime {
        let sailed: GameTime = (0..self.calls.len()).map(|i| self.leg_ms(i) + if self.calls[i] == Call::World { self.stay } else { self.dwell }).sum();
        sailed.div_ceil(TAKT).next_power_of_two() * TAKT
    }

    /// Ships enough that one calls every `CALL_EVERY` at most, evenly
    /// round the line: a round of a power of two `TAKT`s divides into a
    /// power of two of them, each on the clock.
    pub fn every_call(&self) -> usize {
        (self.cycle() / CALL_EVERY).max(1) as usize
    }
}
