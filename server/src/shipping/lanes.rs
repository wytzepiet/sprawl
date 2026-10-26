//! Lanes: the water a line's ways are routed over, reserved on the map
//! with the way ships go on it (docs/shipping.md §The sea, the player's
//! design). A lane is one-way in open water. The way back is routed
//! beside the way out: against it is dear and a tile clear of it, with it
//! on the left, is cheap, so it runs a lane over and ships pass port to
//! port. A later way going a lane's way finds it cheap, so trunks form.
//!
//! Where lanes meet is a junction, a connected patch of tiles of one
//! kind: a berth's approach, always shared; narrow water, where a way had
//! to run against a lane because there was no room for a second (a
//! strait, a canal); and a crossing. Lanes run between junctions as roads
//! run between road nodes, and a ship takes a junction as a car takes a
//! road junction (`intersection`), by the junction's own rule (`Kind`).

use fixed::HashMap;

use crate::intersection::{paths_conflict, Dir, Rule};
use crate::protocol::{Lane, LaneKind};

use super::water::{Water, BERTH, NARROW};
use crate::world::sea::FERRY_LENGTH;

/// The eight ways off a tile, clockwise on the map (y runs down): a way's
/// right is two on, its opposite four, its left six.
pub const WAYS: [(i32, i32); 8] = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)];
/// A tile's mark: a bit for each way a lane leaves it by, and what kind
/// of junction it is, if it is one.
const BERTHS: u16 = 1 << 8;
const TWO_WAY: u16 = 1 << 9;
const CROSS: u16 = 1 << 10;
/// What a step costs beyond the water's own, in tenths of a tile: along a
/// lane its way, against one, onto a junction or across a lane, hard by a
/// lane going the other way, and beside one a tile clear, on the left
/// (keeping right, so ships pass port to port) or the right.
const ALONG: i32 = -5;
const AGAINST: i32 = 100;
const JUNCTION: i32 = 10;
const BESIDE: i32 = -3;
const WRONG_SIDE: i32 = 10;
const HARD_BY: i32 = 10;

/// What a junction is, which says who may be in it together.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A berth's approach: its ship holds it from the mouth to the ramp
    /// and back out, one at a time.
    Berth,
    /// Narrow water, one way at a time, as Suez runs: ships going one way
    /// go through together, a convoy; the other way waits at its mouth.
    /// Granted first come first served, so once a ship waits at the far
    /// mouth the ones behind the convoy wait behind it: it drains and
    /// flips. Nothing waits inside it, so it never deadlocks.
    TwoWay,
    /// Lanes crossing: ships whose paths cross take turns, as at a road
    /// junction; ships side by side go together.
    Crossing,
}

impl Kind {
    pub fn rule(self) -> Rule {
        match self {
            Kind::Berth => |_, _| true,
            Kind::TwoWay => one_way_at_a_time,
            Kind::Crossing => paths_conflict,
        }
    }
}

/// Narrow water: two ships are going opposite ways through it when one
/// comes in from where the other leaves.
fn one_way_at_a_time((w_from, w_to): (Dir, Dir), (p_from, p_to): (Dir, Dir)) -> bool {
    let dot = |a: Dir, b: Dir| a.0 * b.0 + a.1 * b.1;
    dot(w_from, p_to) > 0 || dot(w_to, p_from) > 0
}

/// A junction on a way: from `d0` to `d1` along it, which junction, the
/// arm a ship comes in from and the way it leaves by, and its kind.
#[derive(Debug, Clone)]
pub struct Gate {
    pub d0: f64,
    pub d1: f64,
    pub id: u64,
    pub from: Dir,
    pub to: Dir,
    pub kind: Kind,
}

/// The way, of the eight, nearest a heading.
pub fn way_of(heading: f64) -> usize {
    ((heading / (std::f64::consts::PI / 4.0)).round() as i32).rem_euclid(8) as usize
}

/// The ways within 45° of `way` turned by `k` eighths.
fn near(way: usize, k: usize) -> u16 {
    [7, 0, 1].iter().map(|j| 1u16 << ((way + k + j) % 8)).sum()
}

/// The tiles a way passes over, every quarter tile along it, with the
/// way it goes there.
pub fn under(way: &[[f64; 2]]) -> Vec<(f64, i32, i32, usize)> {
    let mut out = Vec::new();
    let mut along = 0.0;
    for w in way.windows(2) {
        let l = (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]);
        let heading = way_of((w[1][1] - w[0][1]).atan2(w[1][0] - w[0][0]));
        let n = (l * 4.0).ceil().max(1.0) as usize;
        out.extend((0..=n).map(|k| {
            let t = k as f64 / n as f64;
            (along + l * t, (w[0][0] + (w[1][0] - w[0][0]) * t).floor() as i32, (w[0][1] + (w[1][1] - w[0][1]) * t).floor() as i32, heading)
        }));
        along += l;
    }
    out
}

/// The lanes of a map, over the bounds of its water: each tile's mark,
/// and the junction each junction tile is part of, named by its least
/// tile.
pub struct Lanes {
    x0: i32,
    y0: i32,
    w: i32,
    h: i32,
    marks: Vec<u16>,
    junctions: HashMap<usize, (u64, Kind)>,
}

impl Lanes {
    pub fn new(water: &Water) -> Lanes {
        Lanes { x0: water.x0, y0: water.y0, w: water.w, h: water.h, marks: vec![0; water.clearance.len()], junctions: HashMap::default() }
    }

    fn index(&self, x: i32, y: i32) -> Option<usize> {
        let (i, j) = (x - self.x0, y - self.y0);
        (i >= 0 && j >= 0 && i < self.w && j < self.h).then(|| (j * self.w + i) as usize)
    }

    fn mark(&self, x: i32, y: i32) -> u16 {
        self.index(x, y).map_or(0, |i| self.marks[i])
    }

    fn kind(m: u16) -> Option<Kind> {
        if m & BERTHS != 0 {
            Some(Kind::Berth)
        } else if m & TWO_WAY != 0 {
            Some(Kind::TwoWay)
        } else if m & CROSS != 0 {
            Some(Kind::Crossing)
        } else {
            None
        }
    }

    /// What going `way` onto a tile costs beyond the water's own.
    pub fn step(&self, x: i32, y: i32, way: usize) -> i32 {
        let m = self.mark(x, y);
        // A diagonal step slips between the corners of a diagonal lane.
        let (dx, dy) = WAYS[way];
        let corners = if dx != 0 && dy != 0 { self.mark(x - dx, y) | self.mark(x, y - dy) } else { 0 };
        if Self::kind(m).is_some() {
            JUNCTION
        } else if m & near(way, 0) != 0 {
            ALONG
        } else if (m | corners) & near(way, 4) != 0 {
            AGAINST
        } else if m != 0 {
            JUNCTION
        } else {
            let ((lx, ly), (rx, ry)) = (WAYS[(way + 6) % 8], WAYS[(way + 2) % 8]);
            if (self.mark(x + lx, y + ly) | self.mark(x + rx, y + ry)) & near(way, 4) != 0 {
                HARD_BY
            } else if self.mark(x + 2 * lx, y + 2 * ly) & near(way, 4) != 0 {
                BESIDE
            } else if self.mark(x + 2 * rx, y + 2 * ry) & near(way, 4) != 0 {
                WRONG_SIDE
            } else {
                0
            }
        }
    }

    /// A way reserved as its lane: each tile it passes marked with the way
    /// it goes; a berth's approach for `BERTH` tiles at an end that is one
    /// (`berths`: its start, its end); two-way where a lane already runs
    /// against it in narrow water, there being no room for two; a
    /// crossing where one runs across it, or against it in open water,
    /// which the search made dear and so brief. Then the junctions are
    /// named afresh.
    pub fn lay(&mut self, water: &Water, way: &[[f64; 2]], berths: [bool; 2]) {
        let len = super::length(way);
        let approach = |d: f64| (berths[0] && d < BERTH as f64) || (berths[1] && d > len - BERTH as f64);
        let marks: Vec<(usize, u16)> = under(way)
            .into_iter()
            .filter_map(|(d, x, y, w)| {
                let i = self.index(x, y)?;
                let m = self.marks[i] & 0xff;
                let kind = if approach(d) {
                    BERTHS
                } else if m & near(w, 4) != 0 && water.clear(x, y) <= NARROW {
                    TWO_WAY
                } else if m & !near(w, 0) != 0 {
                    CROSS
                } else {
                    0
                };
                Some((i, kind | 1 << w))
            })
            .collect();
        for &(i, m) in &marks {
            self.marks[i] |= m;
        }
        // The approach runs on until the lanes part: where this way
        // crosses another by a berth's approach, that is the approach too.
        let mut grew = true;
        while grew {
            grew = false;
            for &(i, _) in &marks {
                let (x, y) = (self.x0 + i as i32 % self.w, self.y0 + i as i32 / self.w);
                if self.marks[i] & CROSS != 0 && WAYS.iter().any(|&(dx, dy)| self.mark(x + dx, y + dy) & BERTHS != 0) {
                    self.marks[i] = self.marks[i] & !CROSS | BERTHS;
                    grew = true;
                }
            }
        }
        self.name_junctions();
    }

    /// Each junction tile's junction, named by its least tile, and its
    /// kind: a berth's approach is the tiles of it that touch; other
    /// junctions closer together than a ship is long are one, narrow
    /// water if any of it is, so no ship waits in one for the next.
    fn name_junctions(&mut self) {
        self.junctions.clear();
        for i in 0..self.marks.len() {
            let Some(kind) = Self::kind(self.marks[i]) else { continue };
            if self.junctions.contains_key(&i) {
                continue;
            }
            let berth = kind == Kind::Berth;
            let reach = if berth { 1 } else { 2 };
            let mut tiles = vec![i];
            self.junctions.insert(i, (i as u64, kind));
            let mut k = 0;
            while k < tiles.len() {
                let (x, y) = (self.x0 + tiles[k] as i32 % self.w, self.y0 + tiles[k] as i32 / self.w);
                k += 1;
                for (dx, dy) in (-reach..=reach).flat_map(|dx| (-reach..=reach).map(move |dy| (dx, dy))) {
                    if let Some(j) = self.index(x + dx, y + dy).filter(|&j| Self::kind(self.marks[j]).is_some_and(|k| (k == Kind::Berth) == berth) && !self.junctions.contains_key(&j)) {
                        self.junctions.insert(j, (i as u64, kind));
                        tiles.push(j);
                    }
                }
            }
            if !berth && tiles.iter().any(|&j| Self::kind(self.marks[j]) == Some(Kind::TwoWay)) {
                for j in tiles {
                    self.junctions.insert(j, (i as u64, Kind::TwoWay));
                }
            }
        }
    }

    /// The junctions a way passes, in order, as distances along it, with
    /// the arm it comes in from and the way it leaves by, as a car's are
    /// at a road junction. A berth's approach at an end of the way runs
    /// to the end.
    pub fn gates(&self, way: &[[f64; 2]]) -> Vec<Gate> {
        let len = super::length(way);
        let mut gates: Vec<Gate> = Vec::new();
        for (d, x, y, _) in under(way) {
            let Some(&(id, kind)) = self.index(x, y).and_then(|i| self.junctions.get(&i)) else { continue };
            // A way that leaves a junction and comes back to it holds it
            // all the while.
            match gates.last_mut() {
                Some(g) if g.id == id => g.d1 = d,
                _ => gates.push(Gate { d0: d, d1: d, id, from: (0, 0), to: (0, 0), kind }),
            }
        }
        // A ship waits clear of a junction, its bow half its length short
        // of the first tile, and is out of it when its stern is: never
        // into the next one, though.
        let half = FERRY_LENGTH / 2.0;
        for k in 0..gates.len() {
            let (before, after) = (if k == 0 { 0.0 } else { (gates[k - 1].d1 + gates[k].d0) / 2.0 }, gates.get(k + 1).map_or(len, |n| (gates[k].d1 + n.d0) / 2.0));
            let g = &mut gates[k];
            (g.d0, g.d1) = ((g.d0 - half).max(before), (g.d1 + half).min(after));
            if g.kind == Kind::Berth {
                if g.d0 < BERTH as f64 {
                    g.d0 = 0.0;
                }
                if g.d1 > len - BERTH as f64 {
                    g.d1 = len;
                }
            }
            g.from = WAYS[(way_of(super::point_at(way, g.d0).1) + 4) % 8];
            g.to = WAYS[way_of(super::point_at(way, g.d1).1)];
        }
        gates
    }

    /// A way cut into its lanes and the junctions between them, for the
    /// map: a lane runs one way between junctions, as a street runs
    /// between road nodes.
    pub fn drawn(&self, way: &[[f64; 2]]) -> Vec<Lane> {
        let piece = |a: f64, b: f64, kind: LaneKind| Lane { path: super::voyage::part(way, a, b), kind };
        let mut out = Vec::new();
        let mut d = 0.0;
        for g in self.gates(way) {
            if g.d0 > d {
                out.push(piece(d, g.d0, LaneKind::OneWay));
            }
            out.push(piece(g.d0, g.d1, if g.kind == Kind::Crossing { LaneKind::Crossing } else { LaneKind::TwoWay }));
            d = g.d1;
        }
        let len = super::length(way);
        if d < len {
            out.push(piece(d, len, LaneKind::OneWay));
        }
        out
    }

    /// Does a tile hold a lane going within 45° of `way`.
    #[cfg(test)]
    pub fn holds(&self, x: i32, y: i32, way: usize) -> bool {
        self.mark(x, y) & near(way, 0) != 0
    }

    /// Is a tile a ship going `way` sails over its own: a junction, or no
    /// lane on it but going its way.
    #[cfg(test)]
    pub fn its_own(&self, x: i32, y: i32, way: usize) -> bool {
        self.junctions.contains_key(&self.index(x, y).unwrap_or(usize::MAX)) || self.mark(x, y) & 0xff & !near(way, 0) == 0
    }

    /// The junction a tile is part of, and its kind.
    pub fn junction_at(&self, x: i32, y: i32) -> Option<(u64, Kind)> {
        self.junctions.get(&self.index(x, y)?).copied()
    }

    /// The narrow water, tiles shared one way at a time, and how close
    /// each is to land.
    #[cfg(test)]
    pub fn two_way(&self, water: &Water) -> Vec<(i32, i32, u8)> {
        (0..self.marks.len())
            .filter(|&i| Self::kind(self.marks[i]) == Some(Kind::TwoWay))
            .map(|i| (self.x0 + i as i32 % self.w, self.y0 + i as i32 / self.w))
            .map(|(x, y)| (x, y, water.clear(x, y)))
            .collect()
    }

    /// The lanes within `r` tiles of a tile as text, a character a tile,
    /// for a test that fails: land `#`, a lane its way's arrow, a berth's
    /// approach `B`, narrow water `=`, a crossing `+`.
    #[cfg(test)]
    pub fn draw(&self, water: &Water, (cx, cy): (i32, i32), r: i32) -> String {
        let mut out = String::new();
        for y in (cy - r).max(self.y0)..(cy + r + 1).min(self.y0 + self.h) {
            for x in (cx - r).max(self.x0)..(cx + r + 1).min(self.x0 + self.w) {
                let m = self.mark(x, y);
                out.push(if water.clear(x, y) == 0 {
                    '#'
                } else if let Some(k) = Self::kind(m) {
                    match k {
                        Kind::Berth => 'B',
                        Kind::TwoWay => '=',
                        Kind::Crossing => '+',
                    }
                } else if m == 0 {
                    '.'
                } else {
                    ['>', '\\', 'v', '/', '<', '\\', '^', '/'][m.trailing_zeros() as usize]
                });
            }
            out.push('\n');
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::GridCoord;
    use crate::shipping::water::{Berth, End};

    fn rows(spec: &[(&str, usize)]) -> Vec<String> {
        spec.iter().flat_map(|&(r, n)| std::iter::repeat_n(r.to_string(), n)).collect()
    }

    /// Out to the edge and back: the way back is a lane of its own, a
    /// tile clear of the way out on its left, and only the berth's
    /// approach is shared.
    #[test]
    fn the_way_back_is_its_own_lane() {
        let w = Water::from_rows(&rows(&[(&".".repeat(60), 3), (&"~".repeat(60), 50)]));
        let mut lanes = Lanes::new(&w);
        let berth = Berth { quay: GridCoord { x: 30, y: 3 }, out: (0, 1) };
        // Out over the south edge, which is far: the west is nearer.
        let out = w.route(&lanes, &berth, End::Edge, false).unwrap();
        lanes.lay(&w, &out, [true, false]);
        let back = w.route(&lanes, &berth, End::Edge, true).unwrap();
        lanes.lay(&w, &back, [false, true]);
        let map = lanes.draw(&w, (0, 0), 100);
        for (way, berths) in [(&out, [true, false]), (&back, [false, true])] {
            let gates = lanes.gates(way);
            assert!(gates.len() == 1 && gates[0].kind == Kind::Berth, "{gates:?}\n{map}");
            let len = crate::shipping::length(way);
            assert!(if berths[0] { gates[0].d0 == 0.0 } else { gates[0].d1 == len }, "{gates:?}\n{map}");
        }
        assert!(lanes.two_way(&w).is_empty(), "{map}");
        // Out and back keep apart past the approach: a tile clear, a
        // lane over, as the search put them.
        let at = |w: &[[f64; 2]], d: f64| crate::shipping::point_at(w, d).0;
        let len = crate::shipping::length(&out);
        let gaps: Vec<f64> = (12..(len as usize - 1))
            .map(|k| at(&out, k as f64))
            .map(|p| (0..(crate::shipping::length(&back) * 4.0) as usize).map(|j| at(&back, j as f64 / 4.0)).map(|q| (p[0] - q[0]).hypot(p[1] - q[1])).fold(f64::INFINITY, f64::min))
            .collect();
        assert!(gaps.iter().all(|&g| g >= 1.5), "out and back {gaps:.2?} apart\n{map}");
        // Port to port: going out, the way back is on the left.
        let (p, heading) = crate::shipping::point_at(&out, len / 2.0);
        let left = [p[0] + 2.0 * heading.sin(), p[1] - 2.0 * heading.cos()];
        let near = |q: [f64; 2]| (0..(crate::shipping::length(&back) * 4.0) as usize).map(|j| at(&back, j as f64 / 4.0)).map(|b| (b[0] - q[0]).hypot(b[1] - q[1])).fold(f64::INFINITY, f64::min);
        assert!(near(left) < 1.0, "the way back is not on the left\n{map}");
    }

    /// A one-tile strait has no room for two lanes: it is narrow water,
    /// one junction both ways name alike, and the berths' approaches
    /// are their own.
    #[test]
    fn a_strait_is_two_way() {
        let w = Water::from_rows(&rows(&[(&".".repeat(41), 3), (&"~".repeat(41), 18), (&format!("{}~{}", ".".repeat(20), ".".repeat(20)), 6), (&"~".repeat(41), 18), (&".".repeat(41), 1)]));
        let mut lanes = Lanes::new(&w);
        let (a, b) = (Berth { quay: GridCoord { x: 20, y: 3 }, out: (0, 1) }, Berth { quay: GridCoord { x: 20, y: 44 }, out: (0, -1) });
        let out = w.route(&lanes, &a, End::Berth(b), false).unwrap();
        lanes.lay(&w, &out, [true, true]);
        let back = w.route(&lanes, &a, End::Berth(b), true).unwrap();
        lanes.lay(&w, &back, [true, true]);
        let map = lanes.draw(&w, (0, 0), 100);
        let (g, h) = (lanes.gates(&out), lanes.gates(&back));
        let kinds = |gs: &[Gate]| gs.iter().map(|g| g.kind).collect::<Vec<_>>();
        assert_eq!(kinds(&g), vec![Kind::Berth, Kind::TwoWay, Kind::Berth], "{g:?}\n{map}");
        assert_eq!(kinds(&h), vec![Kind::Berth, Kind::TwoWay, Kind::Berth], "{h:?}\n{map}");
        assert_eq!(g.iter().map(|g| g.id).collect::<Vec<_>>(), h.iter().rev().map(|g| g.id).collect::<Vec<_>>(), "{map}");
        assert!(one_way_at_a_time((g[1].from, g[1].to), (h[1].from, h[1].to)), "{g:?} {h:?}");
        assert!(!one_way_at_a_time((g[1].from, g[1].to), (g[1].from, g[1].to)));
    }

    /// Two lines whose ways cross: a crossing, where crossing ships
    /// conflict and ships going the same way do not.
    #[test]
    fn lanes_cross() {
        let w = Water::from_rows(&rows(&[(&"~".repeat(41), 41)]));
        let mut lanes = Lanes::new(&w);
        lanes.lay(&w, &[[0.0, 20.5], [41.0, 20.5]], [false, false]);
        lanes.lay(&w, &[[20.5, 0.0], [20.5, 41.0]], [false, false]);
        let map = lanes.draw(&w, (0, 0), 100);
        let (g, h) = (lanes.gates(&[[0.0, 20.5], [41.0, 20.5]]), lanes.gates(&[[20.5, 0.0], [20.5, 41.0]]));
        assert!(g.len() == 1 && h.len() == 1 && g[0].id == h[0].id && g[0].kind == Kind::Crossing, "{g:?} {h:?}\n{map}");
        let rule = g[0].kind.rule();
        assert!(rule((h[0].from, h[0].to), (g[0].from, g[0].to)));
        assert!(!rule((g[0].from, g[0].to), (g[0].from, g[0].to)));
    }
}
