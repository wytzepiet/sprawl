//! A ship on a leg: its way, the junctions on it (`lanes::Gate`), and how
//! it takes them, as a car takes a road junction (`intersection`): it
//! asks for passage a braking distance before a junction's mouth, sails
//! on if it has it, and otherwise slows to a stop at the mouth and stands
//! there, in sight, until it is let through; it gives passage back as it
//! leaves. Its motion is the one law (`covered`), in pieces: a piece runs
//! from rest or full speed to rest or full speed, so a stop is a piece
//! ending at a mouth, and a ship stands where its last piece ended. A
//! berth's approach is held from the moment a ship is let into it until
//! it has sailed out again; a ship early for its berth stands at the
//! approach's mouth, the anchorage, until its time, and asks then.

use crate::engine::GameTime;
use crate::intersection::IntersectionRegistry;
use crate::protocol::{EntityId, Sail};

use super::lanes::{Gate, Kind};
use super::{covered, length, point_at, GATHER, SEA_PACE};

/// A ship coming in may be at the ramp this soon before the one there
/// casts off: a minute of the clock.
const SLACK: GameTime = 1_000;
/// How far a ship at full speed takes to stop, and a tile to spare.
pub const BRAKE: f64 = GATHER as f64 / SEA_PACE as f64 / 2.0 + 1.0;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Pass {
    Ahead,
    /// Asked, and not let through yet: it stops at the mouth.
    Waiting,
    /// At its berth's mouth before its time: it asks then.
    Early,
    Through,
    Past,
}

/// A ship's leg and where it is in it.
#[derive(Debug, Clone)]
pub struct Voyage {
    way: Vec<[f64; 2]>,
    len: f64,
    ease: [bool; 2],
    astern: bool,
    gates: Vec<Gate>,
    pass: Vec<Pass>,
    /// Where along the way the piece it sails now starts.
    from: f64,
    /// Since when it has waited at the gate ahead, while it does.
    since: Option<GameTime>,
    /// How long it has waited at junctions on this leg, by whether the
    /// junction was a berth's approach.
    pub waited: [GameTime; 2],
    /// Not into the berth it sails to before this: the ships due there
    /// before it have it.
    not_before: GameTime,
    /// When the ship at that berth casts off, as its caller says.
    free: GameTime,
}

/// When a piece `len` long, eased so, has covered `x` of it.
fn time_at(len: f64, ease: [bool; 2], x: f64) -> GameTime {
    let (mut lo, mut hi) = (0, super::sail_ms(len, ease));
    while lo < hi {
        let mid = (lo + hi) / 2;
        if covered(len, ease, mid) < x { lo = mid + 1 } else { hi = mid }
    }
    lo
}

/// The part of a polyline from `a` to `b` along it; where that is no
/// length, a stub the way it runs there, so a ship standing faces on.
fn part(path: &[[f64; 2]], a: f64, b: f64) -> Vec<[f64; 2]> {
    let (p, heading) = point_at(path, a);
    if b - a < 1e-6 {
        return vec![p, [p[0] + heading.cos() * 1e-3, p[1] + heading.sin() * 1e-3]];
    }
    let mut out = vec![p];
    let mut along = 0.0;
    for w in path.windows(2) {
        along += (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]);
        if along > a + 1e-9 && along < b - 1e-9 {
            out.push(w[1]);
        }
    }
    out.push(point_at(path, b).0);
    out
}

impl Voyage {
    /// A ship sets out on a way, from rest at a berth or at speed over
    /// the edge (`ease`), its land end astern or not, due into the berth
    /// at its end `not_before` (`berth`: and the ship there casts off
    /// then); the piece it sails first, and the ships let into the berth
    /// it leaves, which is free as it casts off: a ship let into its
    /// approach now is a braking distance out.
    #[allow(clippy::too_many_arguments)]
    pub fn new(ship: EntityId, way: Vec<[f64; 2]>, ease: [bool; 2], astern: bool, gates: Vec<Gate>, berth: [GameTime; 2], now: GameTime, junctions: &mut IntersectionRegistry) -> (Voyage, Sail, Vec<EntityId>) {
        let mut pass = vec![Pass::Ahead; gates.len()];
        let mut woken = Vec::new();
        if let Some(g) = gates.first().filter(|g| g.kind == Kind::Berth && g.d0 <= 0.0) {
            pass[0] = Pass::Past;
            woken = junctions.clear_car(g.id, ship, now);
        }
        let len = length(&way);
        let mut v = Voyage { way, len, ease, astern, gates, pass, from: 0.0, since: None, waited: [0, 0], not_before: berth[0], free: berth[1] };
        let sail = v.piece(ship, 0.0, ease[0], now, junctions);
        (v, sail, woken)
    }

    /// When, setting out from rest at gate `k`'s mouth at `t`, it reaches
    /// the end of the way.
    fn from_mouth(&self, k: usize, t: GameTime) -> GameTime {
        t + super::sail_ms(self.len - self.gates[k].d0, [true, self.ease[1]])
    }

    /// Is gate `k` the berth at the end of the way, held on arrival.
    fn kept(&self, k: usize) -> bool {
        self.gates[k].kind == Kind::Berth && self.gates[k].d1 >= self.len - 1e-6
    }

    /// Ask for passage at gate `k`, reaching the end of the way at
    /// `arrives` if let through: let through, or wait for it. Early for
    /// its berth, it does not ask yet.
    fn ask(&mut self, k: usize, ship: EntityId, arrives: GameTime, now: GameTime, junctions: &mut IntersectionRegistry) -> bool {
        let g = &self.gates[k];
        // Early by less than stopping and setting out again would cost,
        // it comes in early.
        let early = self.kept(k) && arrives + GATHER < self.not_before;
        if !early {
            junctions.get_or_create_with(g.id, g.kind.rule()).register(ship, g.from, g.to, now);
        }
        if !early && junctions.has_passage(g.id, ship) {
            self.pass[k] = Pass::Through;
            if let Some(since) = self.since.take() {
                self.waited[(g.kind == Kind::Berth) as usize] += now.saturating_sub(since);
            }
            return true;
        }
        self.pass[k] = if early { Pass::Early } else { Pass::Waiting };
        // Waiting for its time is the timetable's, not the junction's.
        self.since.get_or_insert(now.max(if self.kept(k) { self.not_before.saturating_sub(arrives.saturating_sub(now)) } else { 0 }));
        false
    }

    fn sail(&self, a: f64, b: f64, ease: [bool; 2], started: GameTime) -> Sail {
        let path = part(&self.way, a, b);
        let ends = started + super::sail_ms(length(&path), ease);
        Sail { path, started, ends, ease, astern: self.astern }
    }

    /// The next junction it has not asked at, and where along the way it
    /// asks there, on a piece from rest or at speed: as late as it can
    /// still stop at the mouth, a braking distance before it; or, from
    /// rest close by, halfway there, where a stop at the mouth and going
    /// on part ways.
    fn next(&self, rest: bool) -> Option<(usize, f64)> {
        let k = self.pass.iter().position(|&p| p == Pass::Ahead)?;
        let d0 = self.gates[k].d0;
        Some((k, if rest { (d0 - BRAKE).max((self.from + d0) / 2.0) } else { d0 - BRAKE }))
    }

    /// A piece from `from` on, from rest or at speed: on to the end, or to
    /// the mouth of a junction it must ask at now, if it is not let
    /// through there.
    fn piece(&mut self, ship: EntityId, from: f64, rest: bool, now: GameTime, junctions: &mut IntersectionRegistry) -> Sail {
        self.from = from;
        let on = self.sail(from, self.len, [rest, self.ease[1]], now);
        while let Some((k, _)) = self.next(rest).filter(|&(_, at)| at <= from + 1e-6) {
            if !self.ask(k, ship, on.ends, now, junctions) && !self.sails_on(k, &on) {
                return self.sail(from, self.gates[k].d0.max(from), [rest, true], now);
            }
        }
        on
    }

    /// Not let into the berth at the end of the way, it sails on all the
    /// same if the ship there will have cast off by the time it is in: it
    /// may slip into the approach as that one leaves.
    fn sails_on(&mut self, k: usize, sail: &Sail) -> bool {
        let on = self.kept(k) && self.pass[k] == Pass::Waiting && sail.ends + SLACK >= self.free;
        if on {
            self.since = None;
        }
        on
    }

    /// Where along the way it is at `now`.
    fn at(&self, sail: &Sail, now: GameTime) -> f64 {
        self.from + covered(length(&sail.path), sail.ease, now.saturating_sub(sail.started)).min(length(&sail.path))
    }

    /// When along its piece it reaches `d` of the way.
    fn when(&self, sail: &Sail, d: f64) -> GameTime {
        sail.started + time_at(length(&sail.path), sail.ease, d - self.from)
    }

    /// The next moment it must think: where it asks at the next junction,
    /// off the end of one it is through, or the end of its piece. Waiting
    /// at a mouth, it thinks when it is let through, or, early for its
    /// berth, at its time.
    pub fn wake(&self, sail: &Sail) -> GameTime {
        let end = self.from + length(&sail.path);
        let think = match self.pass.iter().position(|&p| p == Pass::Waiting || p == Pass::Early) {
            Some(k) if self.pass[k] == Pass::Early => sail.ends.max(self.not_before - (self.from_mouth(k, self.not_before) - self.not_before)),
            // Sailing on for a berth that will be free by then, it is let
            // in on the way.
            Some(k) if end > self.gates[k].d0 + 0.01 => sail.ends.max(self.free),
            Some(_) => GameTime::MAX,
            None => self.next(sail.ease[0]).filter(|&(k, at)| at <= end && self.gates[k].d0 < end - 1e-6).map_or(sail.ends, |(_, at)| sail.ends.min(self.when(sail, at.max(self.from)))),
        };
        (0..self.gates.len())
            .filter(|&k| self.pass[k] == Pass::Through && !self.kept(k) && self.gates[k].d1 <= end)
            .map(|k| self.when(sail, self.gates[k].d1.max(self.from)))
            .fold(think, GameTime::min)
    }

    /// It woke at `now`: it gives back the junctions it has left, and asks
    /// at the one ahead; it stops at a mouth, or goes on from one. The
    /// ships its leaving lets through, which the caller wakes; and whether
    /// the leg is done. The ship at the berth it sails to, if any, casts
    /// off at `free`.
    pub fn step(&mut self, ship: EntityId, sail: &mut Sail, free: GameTime, now: GameTime, junctions: &mut IntersectionRegistry) -> (Vec<EntityId>, bool) {
        self.free = free;
        let d = self.at(sail, now);
        let mut woken = Vec::new();
        for k in 0..self.gates.len() {
            if self.pass[k] == Pass::Through && !self.kept(k) && self.gates[k].d1 <= d + 1e-6 {
                self.pass[k] = Pass::Past;
                woken.extend(junctions.clear_car(self.gates[k].id, ship, now));
            }
        }
        if let Some(k) = self.pass.iter().position(|&p| p == Pass::Waiting || p == Pass::Early) {
            // Let through while it still slows, it stops and goes on; at
            // the mouth of a berth that will not be free after all, it
            // stops there.
            let d0 = self.gates[k].d0;
            let on = self.from + length(&sail.path) > d0 + 0.01;
            let arrives = if on { sail.ends } else { self.from_mouth(k, sail.ends.max(now)) };
            if !self.ask(k, ship, arrives, now, junctions) && on {
                if !self.sails_on(k, sail) && d >= d0 - 1e-6 {
                    *sail = self.sail(d, d, [true, true], now);
                    self.from = d;
                    self.since = Some(now);
                }
            }
            if self.pass[k] != Pass::Through || now < sail.ends {
                return (woken, false);
            }
        } else {
            // Junctions past where the piece ends wait till it sets out
            // again.
            let end = self.from + length(&sail.path);
            while let Some((k, at)) = self.next(sail.ease[0]).filter(|&(k, at)| at <= d + 1e-6 && self.gates[k].d0 < end - 1e-6) {
                if self.ask(k, ship, sail.ends, now, junctions) {
                    continue;
                }
                // At speed it slows from here; from rest, the piece that
                // stops at the mouth has been the same so far.
                let d0 = self.gates[k].d0;
                if self.sails_on(k, sail) {
                    return (woken, false);
                }
                if sail.ease[0] && at > d0 - BRAKE {
                    *sail = self.sail(self.from, d0, [true, true], sail.started);
                } else {
                    *sail = self.sail(d, d0, [false, true], now);
                    self.from = d;
                }
                return (woken, false);
            }
        }
        if now >= sail.ends && d < self.len - 1e-6 {
            *sail = self.piece(ship, d, true, now, junctions);
        }
        (woken, now >= sail.ends && d >= self.len - 1e-6)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate(from: (i32, i32), kind: Kind) -> Gate {
        Gate { d0: 200.0, d1: 210.0, id: 1, from, to: (-from.0, -from.1), kind }
    }

    /// Ships through one junction, each on its own straight way, setting
    /// out at its time: how late each got through, the most ever in it at
    /// once, and whether ships from two arms ever were.
    fn run(ships: &[(Gate, GameTime)]) -> (Vec<GameTime>, usize, bool) {
        let mut junctions = IntersectionRegistry::new();
        let way = vec![[0.0, 0.0], [400.0, 0.0]];
        let mut v: Vec<Option<(Voyage, Sail)>> = vec![None; ships.len()];
        let mut done = vec![0; ships.len()];
        let (mut most, mut mixed) = (0, false);
        let mut woken = Vec::new();
        for now in (0..2_000_000).step_by(100) {
            for (i, w) in std::mem::take(&mut woken).into_iter().map(|w: u64| (w as usize, w)).chain((0..ships.len()).map(|i| (i, u64::MAX))) {
                if now == ships[i].1 && w == u64::MAX {
                    let (voyage, sail, _) = Voyage::new(i as u64, way.clone(), [false, false], false, vec![ships[i].0.clone()], [0, GameTime::MAX], now, &mut junctions);
                    v[i] = Some((voyage, sail));
                }
                let Some((voyage, sail)) = v[i].as_mut().filter(|_| done[i] == 0) else { continue };
                if now >= voyage.wake(sail) || w != u64::MAX {
                    let (w, end) = voyage.step(i as u64, sail, GameTime::MAX, now, &mut junctions);
                    woken.extend(w);
                    if end {
                        done[i] = now;
                    }
                }
            }
            let inside: Vec<usize> = (0..ships.len()).filter(|&i| v[i].as_ref().is_some_and(|(voyage, s)| done[i] == 0 && (200.5..209.5).contains(&voyage.at(s, now)))).collect();
            most = most.max(inside.len());
            mixed |= inside.iter().any(|&i| ships[i].0.from != ships[inside[0]].0.from);
        }
        assert!(done.iter().all(|&d| d > 0), "a ship never got through: {done:?}");
        (ships.iter().zip(&done).map(|((_, start), end)| end - start - super::super::sail_ms(400.0, [false, false])).collect(), most, mixed)
    }

    /// Crossing lanes: of two ships whose paths cross, the second waits;
    /// two side by side do not wait for each other.
    #[test]
    fn crossing_ships_take_turns_and_parallel_ones_do_not() {
        let (late, _, mixed) = run(&[(gate((-1, 0), Kind::Crossing), 0), (gate((0, -1), Kind::Crossing), 500)]);
        assert!(late[0] < 200 && late[1] > 0 && !mixed, "{late:?}");
        let (late, most, _) = run(&[(gate((-1, 0), Kind::Crossing), 0), (gate((-1, 0), Kind::Crossing), 500)]);
        assert!(late.iter().all(|&l| l < 200) && most == 2, "{late:?}");
    }

    /// Narrow water: a convoy goes through together; a ship from the
    /// other end waits, and once it does, a ship coming after the convoy
    /// waits behind it, so the water drains and flips. Never two ways in
    /// it at once, and all through.
    #[test]
    fn narrow_water_goes_one_way_at_a_time() {
        let (east, west) = (gate((-1, 0), Kind::TwoWay), gate((1, 0), Kind::TwoWay));
        let (late, most, mixed) = run(&[(east.clone(), 0), (east.clone(), 500), (west.clone(), 1_000), (east.clone(), 1_500)]);
        assert!(!mixed, "two ships met head on: {late:?}");
        assert!(late[0] < 200 && late[1] < 200 && most == 2, "the convoy waited: {late:?}");
        assert!(late[2] > 0, "it went head on: {late:?}");
        assert!(late[3] > late[2], "the late one jumped the queue: {late:?}");
    }

    /// A berth's approach: one ship in it at a time.
    #[test]
    fn a_berth_takes_one_at_a_time() {
        let berth = gate((-1, 0), Kind::Berth);
        let (late, most, _) = run(&[(berth.clone(), 0), (berth.clone(), 500)]);
        assert!(most == 1 && late[0] < 200 && late[1] > 0, "{late:?}");
    }
}
