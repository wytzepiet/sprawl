//! Lines, their timetables, and where a box goes next. A line is a ring
//! of calls its ships sail round; its timetable is every sailing from one
//! call to the next. A box carries no plan: wherever it stands, the
//! earliest journey from there (a Connection Scan over the timetable)
//! says which ship it boards, so a missed connection replans itself when
//! the next ship asks (docs/plan-sea.md §Decisions).
//!
//! The company's rule is here too. A harbour standing is linked at once
//! to the nearest of the player's own harbours by sea, its sailings sized
//! by what the two ends forecast; a backlog of boxes waiting for a pair
//! adds a sailing at the next departure. Each ship keeps its own time
//! round its line, so a sailing is added without moving the others.

use crate::engine::GameTime;

use super::{length, sail_ms, HOUR};

/// A box changing ship at a harbour: landed by the tug, loaded again.
pub const TRANSFER: GameTime = HOUR / 2;
/// A new line's first sailing leaves this soon after it is opened.
pub const FIRST_SAILING: GameTime = HOUR / 2;
/// Boxes waiting in a yard for one harbour, left behind by a sailing,
/// that add a sailing, or open a line where there is none.
pub const BACKLOG: usize = 6;
/// A new line's trial, in days: what it carries after it is its verdict.
pub const TRIAL: u64 = 2;
/// The tug's pace the company plans a line's dwell by, boxes an hour, and
/// the shortest dwell it plans: one berth serves every line calling, so
/// a line stands only as long as its boxes need.
pub const TUG: f64 = 4.0;
pub const MIN_DWELL: GameTime = HOUR / 2;
/// The clock the company times by: every line's round is this times a
/// power of two (an hour, two, four, eight), so of any two lines calling
/// at a harbour one's round divides the other's, their berth windows keep
/// their places on the clock, and a new line is slotted into a free one
/// once, for good, as a clock-face timetable is. Rounds that were whole
/// hours of different lengths (three and four) met at the berth every
/// twelve hours whatever their phase.
pub const TAKT: GameTime = HOUR;
/// How finely the company tries the times a new sailing could leave.
const TRY: GameTime = HOUR / 12;

/// A place a line calls: a harbour, or the world beyond the map's edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Call {
    Harbour(u64),
    World,
}

/// A line: the calls its ships make, in order and round again; the way
/// from each to the next (`legs[i]` from `calls[i]`); its ships, each
/// with when it first leaves `calls[0]`, and round again every cycle; how
/// many boxes a ship carries; how long it stands at a harbour, and at the
/// world beyond the edge.
#[derive(Debug, Clone)]
pub struct Line {
    pub calls: Vec<Call>,
    pub legs: Vec<Vec<[f64; 2]>>,
    pub ships: Vec<(u64, GameTime)>,
    pub slots: usize,
    pub dwell: GameTime,
    pub stay: GameTime,
    /// The least a ship's round may take, for sailings no more often
    /// than the forecast fills: 0 is as often as the ships can sail.
    pub every: GameTime,
}

/// One ship sailing from one call to the next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Connection {
    pub ship: u64,
    pub from: Call,
    pub to: Call,
    pub departs: GameTime,
    pub arrives: GameTime,
}

/// A box's way: each ship it rides, from where it boards to where it
/// leaves, and when it gets there.
#[derive(Debug, Clone, PartialEq)]
pub struct Journey {
    pub rides: Vec<Connection>,
    pub arrives: GameTime,
}

impl Line {
    /// How long a leg takes: eased at the berths, at full speed over the
    /// edge.
    pub fn leg_ms(&self, i: usize) -> GameTime {
        let n = self.calls.len();
        let ease = [self.calls[i] != Call::World, self.calls[(i + 1) % n] != Call::World];
        sail_ms(length(&self.legs[i]), ease)
    }

    /// Once round as fast as it goes: every leg and every stay.
    fn sailed(&self) -> GameTime {
        (0..self.calls.len()).map(|i| self.leg_ms(i) + if self.calls[i] == Call::World { self.stay } else { self.dwell }).sum()
    }

    /// Once round as timetabled: at least `every`, on the clock.
    pub fn cycle(&self) -> GameTime {
        self.sailed().max(self.every).div_ceil(TAKT).next_power_of_two() * TAKT
    }

    /// How long a ship stands at a call: the dwell at a harbour; beyond
    /// the edge the world's stay, and whatever the round has to spare. A
    /// line with no call at the world spares it at the anchorage, off its
    /// first call.
    pub fn stay(&self, call: Call) -> GameTime {
        if call == Call::World { self.stay + self.cycle() - self.sailed() } else { self.dwell }
    }

    /// When the leg from call `i` leaves, after a ship leaves call 0.
    pub fn offset(&self, i: usize) -> GameTime {
        (0..i).map(|j| self.leg_ms(j) + self.stay(self.calls[j + 1])).sum()
    }

    /// `n` ships evenly round the line, the first leaving `calls[0]` at
    /// `start`, numbered from `first`.
    pub fn spaced(&mut self, n: usize, first: u64, start: GameTime) {
        let cycle = self.cycle();
        self.ships = (0..n).map(|k| (first + k as u64, start + cycle * k as GameTime / n as GameTime)).collect();
    }

    /// Sailings enough each way for `per_day` boxes: ships round the line,
    /// at least one.
    pub fn sailings(&self, per_day: f64) -> usize {
        let per_ship = self.slots as f64 * crate::protocol::DAY_MS as f64 / self.sailed() as f64;
        ((per_day / per_ship).ceil() as usize).max(1)
    }

    /// A line opened from a forecast of `per_day` boxes each way: the
    /// ships it takes; their dwell, time for the tug to land and load a
    /// call's share, between `MIN_DWELL` and `ceiling`; and no more
    /// sailings than fill half a box each.
    pub fn sized(&mut self, per_day: f64, ceiling: GameTime) -> usize {
        let ships = self.sailings(per_day);
        // Both ways, and room for a call busier than the forecast.
        let per_call = per_day * self.sailed() as f64 / crate::protocol::DAY_MS as f64 / ships as f64;
        self.dwell = (((2.0 * per_call + 2.0) / TUG * HOUR as f64) as GameTime).clamp(MIN_DWELL, ceiling);
        self.every = (ships as f64 * crate::protocol::DAY_MS as f64 / (2.0 * per_day.max(1.0))) as GameTime;
        ships
    }
}

/// What a backlog changes on a line, at a departure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    /// The ships stand longer at the berth, for the tug.
    Dwell(GameTime),
    /// Another ship joins the line.
    Sailing,
}

/// A sailing left `left` boxes behind, its deck `full` or not. A full
/// deck says the line is short of ships; a deck with room says the tug
/// was short of time, so the dwell grows by what was left, up to
/// `ceiling`, and past that it takes another ship.
pub fn backlog(line: &Line, left: usize, full: bool, ceiling: GameTime) -> Option<Change> {
    if left < BACKLOG {
        return None;
    }
    if full || line.dwell >= ceiling {
        return Some(Change::Sailing);
    }
    Some(Change::Dwell((line.dwell + (left as f64 / TUG * HOUR as f64) as GameTime).min(ceiling)))
}

/// When a sailing of `line` could leave its call `at`, from `from` on,
/// that keeps its ships' berth windows clear of the other lines' at the
/// harbours it calls: the first time, tried every few minutes over a
/// round, that overlaps them least over the next two days.
pub fn slot(lines: &[Line], line: &Line, at: usize, from: GameTime) -> GameTime {
    let until = from as i64 + 2 * crate::protocol::DAY_MS as i64;
    // A line's windows at a harbour: from coming in to leaving.
    let windows = |l: &Line, phases: &[i64], h: Call| -> Vec<(i64, i64)> {
        let cycle = l.cycle() as i64;
        let mut out = Vec::new();
        for &phase in phases {
            for i in (0..l.calls.len()).filter(|&i| l.calls[i] == h) {
                let mut dep = phase + l.offset(i) as i64;
                while dep < until + cycle {
                    if dep >= from as i64 {
                        out.push((dep - l.dwell as i64, dep));
                    }
                    dep += cycle;
                }
            }
        }
        out
    };
    let harbours: Vec<Call> = line.calls.iter().copied().filter(|&c| c != Call::World).collect();
    let taken: Vec<Vec<(i64, i64)>> = harbours
        .iter()
        .map(|&h| lines.iter().flat_map(|l| windows(l, &l.ships.iter().map(|s| s.1 as i64).collect::<Vec<_>>(), h)).collect())
        .collect();
    let overlap = |dep: GameTime| -> i64 {
        let phase = dep as i64 - line.offset(at) as i64;
        harbours
            .iter()
            .zip(&taken)
            .flat_map(|(&h, taken)| windows(line, &[phase], h).into_iter().map(move |(a, b)| taken.iter().map(|&(c, d)| (b.min(d) - a.max(c)).max(0)).sum::<i64>()))
            .sum()
    };
    // A few minutes' overlap is a few minutes at the anchorage: soon is
    // better than perfect.
    (0..line.cycle().div_ceil(TRY)).map(|k| from + k * TRY).min_by_key(|&dep| ((overlap(dep) - (3 * TRY) as i64).max(0), dep)).unwrap_or(from)
}

/// How much faster than the road a sea leg must be, its loading at both
/// ends counted, to be worth a line: a third.
pub const SEA_GAIN: f64 = 1.0 / 3.0;

/// The way by sea between two harbours, its loading at both ends
/// counted, `sea` ms for a leg: is it worth a line over the road, if
/// there is one (`road` ms). You can drive from Spain to Morocco, but you
/// would ship.
pub fn by_sea(sea: GameTime, road: Option<GameTime>) -> bool {
    road.is_none_or(|r| (sea + 2 * TRANSFER) as f64 * (1.0 + SEA_GAIN) <= r as f64)
}

/// Does a pair of the player's harbours get a line: boxes would flow
/// between them (`flow` a day, forecast), and the sea beats the road.
pub fn worth_a_line(sea: GameTime, road: Option<GameTime>, flow: f64) -> bool {
    flow > 0.0 && by_sea(sea, road)
}

/// Which of the player's harbours a new one is linked to: the nearest by
/// sea, of those with a way to it (each with the length of the way).
pub fn prior(ways: &[(u64, f64)]) -> Option<u64> {
    ways.iter().min_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0))).map(|w| w.0)
}

/// Changing ship: at a harbour, the time for the tug to land and load a
/// box. Never at the world: it is where imports come from and exports go,
/// not a place the player's own boxes change ships.
fn transfer(at: Call) -> Option<GameTime> {
    (at != Call::World).then_some(TRANSFER)
}

/// Every sailing of the lines that leaves in `[from, until)`, by when it
/// leaves.
pub fn timetable(lines: &[Line], from: GameTime, until: GameTime) -> Vec<Connection> {
    let mut out = Vec::new();
    for line in lines {
        let cycle = line.cycle();
        let n = line.calls.len();
        for &(ship, phase) in &line.ships {
            for i in 0..n {
                let first = phase + line.offset(i);
                // The first round that leaves at or after `from`.
                let mut round = if from > first { (from - first).div_ceil(cycle) } else { 0 };
                loop {
                    let departs = first + round * cycle;
                    if departs >= until {
                        break;
                    }
                    out.push(Connection { ship, from: line.calls[i], to: line.calls[(i + 1) % n], departs, arrives: departs + line.leg_ms(i) });
                    round += 1;
                }
            }
        }
    }
    out.sort_by_key(|c| (c.departs, c.ship));
    out
}

/// The earliest journey from a call to another for a box ready there at
/// `ready`, by a Connection Scan over a timetable sorted by departure. A
/// box changing ship at a call needs `transfer` there between landing and
/// sailing on; staying aboard costs nothing.
pub fn earliest(conns: &[Connection], from: Call, to: Call, ready: GameTime) -> Option<Journey> {
    use std::collections::HashMap;
    // The earliest at each call, and the ride that got there: its ship's
    // first connection boarded, and the one it was left from.
    let mut at: HashMap<Call, (GameTime, Option<(usize, usize)>)> = HashMap::from([(from, (ready, None))]);
    let mut boarded: HashMap<u64, usize> = HashMap::new();
    for (k, c) in conns.iter().enumerate() {
        if c.departs < ready {
            continue;
        }
        if at.get(&to).is_some_and(|&(t, _)| t <= c.departs) {
            break;
        }
        if !boarded.contains_key(&c.ship) {
            let Some(&(t, _)) = at.get(&c.from) else { continue };
            let wait = if c.from == from { Some(0) } else { transfer(c.from) };
            if wait.is_none_or(|w| t + w > c.departs) {
                continue;
            }
            boarded.insert(c.ship, k);
        }
        let b = boarded[&c.ship];
        if at.get(&c.to).is_none_or(|&(t, _)| c.arrives < t) && c.to != from {
            at.insert(c.to, (c.arrives, Some((b, k))));
        }
    }
    let (arrives, _) = *at.get(&to)?;
    let mut rides = Vec::new();
    let mut here = to;
    while let Some(&(_, Some((b, e)))) = at.get(&here) {
        rides.push(Connection { from: conns[b].from, departs: conns[b].departs, ..conns[e] });
        here = conns[b].from;
    }
    rides.reverse();
    Some(Journey { rides, arrives })
}

/// Does a box at `at`, bound for `to`, board this ship now: is it the
/// first ride of the box's earliest journey from here.
pub fn boards(conns: &[Connection], ship: u64, at: Call, to: Call, now: GameTime) -> bool {
    earliest(conns, at, to, now).is_some_and(|j| j.rides.first().is_some_and(|r| r.ship == ship))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shipping::WORLD_STAY;

    fn line(calls: Vec<Call>, legs: &[f64], ship: u64) -> Line {
        let mut l = Line { calls, legs: legs.iter().map(|&l| vec![[0.0, 0.0], [l, 0.0]]).collect(), ships: Vec::new(), slots: 15, dwell: 1000, stay: WORLD_STAY, every: 0 };
        l.spaced(1, ship, 0);
        l
    }

    #[test]
    fn a_timetable_repeats_each_cycle() {
        let l = line(vec![Call::Harbour(1), Call::World], &[100.0, 100.0], 7);
        let t = timetable(std::slice::from_ref(&l), 0, 3 * l.cycle());
        assert_eq!(t.len(), 6);
        assert_eq!(t[2].departs - t[0].departs, l.cycle());
        assert_eq!(t[1].departs, t[0].arrives + l.stay(Call::World));
    }

    /// The player's own boxes never change ship at the world: with only
    /// the world's ferries there is no way between two harbours; with a
    /// hub, the way changes ship there; a direct line is one ride.
    #[test]
    fn the_earliest_journey_changes_ship_at_harbours_only() {
        let (a, b, h) = (Call::Harbour(1), Call::Harbour(2), Call::Harbour(3));
        let mut lines = vec![line(vec![a, Call::World], &[300.0, 300.0], 1), line(vec![b, Call::World], &[300.0, 300.0], 2)];
        assert_eq!(earliest(&timetable(&lines, 0, 100_000_000), a, b, 0), None, "a box changed ship at the world");
        assert!(earliest(&timetable(&lines, 0, 100_000_000), Call::World, b, 0).is_some(), "an import found no way in");
        lines.push(line(vec![a, h], &[100.0, 100.0], 3));
        lines.push(line(vec![h, b], &[100.0, 100.0], 4));
        let j = earliest(&timetable(&lines, 0, 100_000_000), a, b, 0).expect("a way through the hub");
        assert_eq!(j.rides.iter().map(|r| (r.ship, r.from, r.to)).collect::<Vec<_>>(), vec![(3, a, h), (4, h, b)]);
        assert!(j.rides[1].departs >= j.rides[0].arrives + TRANSFER);
        lines.push(line(vec![a, b], &[100.0, 100.0], 5));
        let k = earliest(&timetable(&lines, 0, 100_000_000), a, b, 0).unwrap();
        assert_eq!(k.rides.len(), 1);
        assert!(k.arrives < j.arrives);
    }

    /// Sailings for a forecast: one ship carries a deck a cycle.
    #[test]
    fn sailings_follow_the_forecast() {
        let l = line(vec![Call::Harbour(1), Call::Harbour(2)], &[100.0, 100.0], 1);
        let per_ship = 15.0 * crate::protocol::DAY_MS as f64 / l.cycle() as f64;
        assert_eq!(l.sailings(0.0), 1);
        assert_eq!(l.sailings(per_ship * 2.5), 3);
        assert_eq!(prior(&[(4, 90.0), (2, 40.0), (3, 40.0)]), Some(2));
        let h = HOUR;
        assert!(worth_a_line(h, None, 0.5) && !worth_a_line(h, None, 0.0));
        assert!(!worth_a_line(h, Some(h), 3.0), "a short coast road took a line");
        assert!(worth_a_line(h, Some(6 * h), 3.0), "a long detour round the bay got none");
    }
}
