//! A harbour's line to the world: a shuttle out from its berth over the
//! map's edge and back in, its round timed on a clock face so its
//! ferries keep their places on it.

use crate::engine::GameTime;

use super::{length, sail_ms, DWELL, HOUR, WORLD_STAY};

/// The clock a line times by: its round is this times a power of two (50
/// minutes, 1:40, 3:20, 6:40, 13:20), so its sailings keep their places
/// on the clock. Fifty minutes, not an hour: the season's ferry, its raw
/// round 2:44, would have waited out a four-hour one, and its town went
/// hungry; at 3:20 it does not.
pub const TAKT: GameTime = HOUR * 5 / 6;
/// The longest a harbour waits between calls of its line: as often as
/// the old ferry came, on the clock (four `TAKT`s, 3:20).
pub const CALL_EVERY: GameTime = 4 * TAKT;

/// A line's two legs: out from the berth to the edge, and back in.
#[derive(Debug, Clone)]
pub struct Line {
    pub legs: [Vec<[f64; 2]>; 2],
}

impl Line {
    /// How long a leg takes: eased at the berth, at full speed over the
    /// edge.
    pub fn leg_ms(&self, i: usize) -> GameTime {
        sail_ms(length(&self.legs[i]), [i == 0, i == 1])
    }

    /// Once round as timetabled: out, the world's stay, back, and the
    /// dwell at the ramp, on the clock.
    pub fn cycle(&self) -> GameTime {
        (self.leg_ms(0) + WORLD_STAY + self.leg_ms(1) + DWELL).div_ceil(TAKT).next_power_of_two() * TAKT
    }

    /// Ships enough that one calls every `CALL_EVERY` at most, evenly
    /// round the line: a round of a power of two `TAKT`s divides into a
    /// power of two of them, each on the clock.
    pub fn every_call(&self) -> usize {
        (self.cycle() / CALL_EVERY).max(1) as usize
    }
}
