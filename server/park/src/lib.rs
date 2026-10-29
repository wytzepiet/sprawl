//! How a vehicle gets from where it stands to where it is going across a
//! lot: open ground, walls on it, and a pose to end in. A driver's way, not
//! a node graph's: it swings wide, backs, pulls forward and straightens, as
//! the room asks, and a lorry's trailer goes where its kinematics take it.
//!
//! The search is a hybrid A*, as self-parking cars do it: from a pose it
//! tries a short drive at a few turns of the wheel, forward and back, keeps
//! those whose bodies stay on the ground and off the walls, and goes on from
//! the cheapest. What it finds is a few moves, each one gear and the wheel
//! turning evenly from one curvature to another, so a vehicle's whole
//! manoeuvre is a handful of numbers that anyone can drive again exactly.
//!
//! No randomness and no hashing, so the same lot gives the same plan on
//! every machine.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap};

/// Where a vehicle stands: its cab's rear axle, the way the cab points, and
/// the way its trailer points, if it has one (the cab's heading if not).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    pub x: f64,
    pub y: f64,
    pub heading: f64,
    pub trailer: f64,
}

impl Pose {
    pub fn new(x: f64, y: f64, heading: f64) -> Pose {
        Pose { x, y, heading, trailer: heading }
    }
}

/// A body round its axle: how far it reaches ahead of it and behind, and
/// half its width.
#[derive(Clone, Copy, Debug)]
pub struct Body {
    pub ahead: f64,
    pub behind: f64,
    pub half: f64,
}

/// A trailer hitched on its cab's rear axle: how far behind the hitch its
/// axle is, its body round that axle, and the most it may fold against
/// the cab.
#[derive(Clone, Copy, Debug)]
pub struct Trailer {
    pub length: f64,
    pub body: Body,
    pub fold: f64,
}

/// A vehicle as it steers: the tightest its rear axle turns, as a
/// curvature, its cab, and its trailer.
#[derive(Clone, Copy, Debug)]
pub struct Rig {
    pub lock: f64,
    pub cab: Body,
    pub trailer: Option<Trailer>,
}

/// A car, 0.29 tiles long and 0.15 wide, its rear axle a third of its
/// length behind its middle; turning no tighter than 0.3 tiles.
pub const CAR: Rig = Rig { lock: 1.0 / 0.3, cab: Body { ahead: 0.145 + 0.29 / 3.0, behind: 0.145 - 0.29 / 3.0, half: 0.075 }, trailer: None };

/// A cab-over tractor, 0.17 long, and a semi-trailer 0.46 long hitched on
/// its rear axle: the trailer's axle 0.37 behind the hitch, its nose 0.025
/// ahead of the hitch and its tail 0.065 behind the axle (the client's
/// `CAB` and `TRAILER`). It folds no further than 75 degrees.
pub const LORRY: Rig = Rig {
    lock: 1.0 / 0.3,
    cab: Body { ahead: 0.085 + 0.17 / 3.0, behind: 0.085 - 0.17 / 3.0, half: 0.085 },
    trailer: Some(Trailer { length: 0.37, body: Body { ahead: 0.395, behind: 0.065, half: 0.085 }, fold: 1.3 }),
};

/// A rectangle, turned: its middle, half its length and half its width,
/// and the way its length runs.
#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub half_l: f64,
    pub half_w: f64,
    pub heading: f64,
}

impl Rect {
    /// From one corner to the other, square to the grid.
    pub fn span(x0: f64, y0: f64, x1: f64, y1: f64) -> Rect {
        Rect { x: (x0 + x1) / 2.0, y: (y0 + y1) / 2.0, half_l: (x1 - x0).abs() / 2.0, half_w: (y1 - y0).abs() / 2.0, heading: 0.0 }
    }

    fn holds(&self, (px, py): (f64, f64)) -> bool {
        let (c, s) = (self.heading.cos(), self.heading.sin());
        let (dx, dy) = (px - self.x, py - self.y);
        (dx * c + dy * s).abs() <= self.half_l + 1e-9 && (-dx * s + dy * c).abs() <= self.half_w + 1e-9
    }

    fn corners(&self) -> [(f64, f64); 4] {
        let (c, s) = (self.heading.cos(), self.heading.sin());
        let p = |l: f64, w: f64| (self.x + c * l - s * w, self.y + s * l + c * w);
        [p(self.half_l, self.half_w), p(-self.half_l, self.half_w), p(-self.half_l, -self.half_w), p(self.half_l, -self.half_w)]
    }
}

/// The ground a vehicle may drive on, as rectangles together, and what
/// stands on it: walls, buildings, and the vehicles parked there.
#[derive(Clone, Debug, Default)]
pub struct Lot {
    pub ground: Vec<Rect>,
    pub walls: Vec<Rect>,
}

/// One gear's drive: backwards or not, the wheel turning evenly from one
/// curvature to another (positive to the left), so far.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Move {
    pub back: bool,
    pub from: f64,
    pub to: f64,
    pub length: f64,
}

/// Where the search may stop: within `reach` of the pose across its
/// heading and `along` it, `turn` of its heading, and its trailer as
/// nearly in line.
#[derive(Clone, Copy, Debug)]
pub struct Goal {
    pub pose: Pose,
    pub reach: f64,
    pub along: f64,
    pub turn: f64,
}

use std::f64::consts::PI;

fn wrap(a: f64) -> f64 {
    (a + PI).rem_euclid(2.0 * PI) - PI
}

/// Driven `ds` along its heading (negative backing) with the wheel at
/// curvature `k`: the cab's axle on its arc, the trailer drawn after the
/// hitch on it.
fn step(rig: &Rig, p: Pose, k: f64, ds: f64) -> Pose {
    let h = p.heading + k * ds;
    let (x, y) = if k.abs() < 1e-9 {
        (p.x + p.heading.cos() * ds, p.y + p.heading.sin() * ds)
    } else {
        (p.x + (h.sin() - p.heading.sin()) / k, p.y - (h.cos() - p.heading.cos()) / k)
    };
    let trailer = match rig.trailer {
        // The trailer's axle follows the hitch: it turns toward the cab by
        // as much as the hitch moves across it.
        Some(t) => p.trailer + ds / t.length * wrap((p.heading + h) / 2.0 - p.trailer).sin(),
        None => h,
    };
    Pose { x, y, heading: h, trailer }
}

/// A plan driven from `from`, every hundredth of a tile or so: each pose,
/// with how far it has gone.
pub fn drive(rig: &Rig, from: Pose, moves: &[Move]) -> Vec<(f64, Pose)> {
    let mut out = vec![(0.0, from)];
    let (mut p, mut s) = (from, 0.0);
    for m in moves {
        let n = (m.length / SUB - 1e-6).ceil().max(1.0) as usize;
        let ds = m.length / n as f64;
        for i in 0..n {
            let k = m.from + (m.to - m.from) * (i as f64 + 0.5) / n as f64;
            p = step(rig, p, k, if m.back { -ds } else { ds });
            s += ds;
            out.push((s, p));
        }
    }
    out
}

/// The rectangles a vehicle stands in.
fn bodies(rig: &Rig, p: Pose) -> impl Iterator<Item = Rect> {
    let rect = |x: f64, y: f64, h: f64, b: &Body| {
        let mid = (b.ahead - b.behind) / 2.0;
        Rect { x: x + h.cos() * mid, y: y + h.sin() * mid, half_l: (b.ahead + b.behind) / 2.0, half_w: b.half, heading: h }
    };
    let cab = rect(p.x, p.y, p.heading, &rig.cab);
    let trailer = rig.trailer.map(|t| rect(p.x - p.trailer.cos() * t.length, p.y - p.trailer.sin() * t.length, p.trailer, &t.body));
    std::iter::once(cab).chain(trailer)
}

/// A lot as a fine grid: which points of it a body may cover, and how far
/// each is from where a search is going.
pub struct Field {
    x0: f64,
    y0: f64,
    w: usize,
    h: usize,
    free: Vec<bool>,
}

/// The grid's cell, in tiles.
const RES: f64 = 0.02;

impl Field {
    pub fn new(lot: &Lot) -> Field {
        let (x0, y0, x1, y1) = lot.ground.iter().flat_map(|g| g.corners()).fold((f64::MAX, f64::MAX, f64::MIN, f64::MIN), |(a, b, c, d), (x, y)| (a.min(x), b.min(y), c.max(x), d.max(y)));
        let (w, h) = (((x1 - x0) / RES).ceil() as usize + 1, ((y1 - y0) / RES).ceil() as usize + 1);
        let mut free = vec![false; w * h];
        for j in 0..h {
            for i in 0..w {
                let q = (x0 + i as f64 * RES, y0 + j as f64 * RES);
                free[j * w + i] = lot.ground.iter().any(|g| g.holds(q)) && !lot.walls.iter().any(|g| g.holds(q));
            }
        }
        Field { x0, y0, w, h, free }
    }

    fn open(&self, (x, y): (f64, f64)) -> bool {
        let (i, j) = (((x - self.x0) / RES).round(), ((y - self.y0) / RES).round());
        i >= 0.0 && j >= 0.0 && (i as usize) < self.w && (j as usize) < self.h && self.free[j as usize * self.w + i as usize]
    }

    /// Whether a vehicle stands here whole: every body over open ground,
    /// tested a few hundredths apart, and its trailer folded no further
    /// than it may.
    pub fn fits(&self, rig: &Rig, p: Pose) -> bool {
        if rig.trailer.is_some_and(|t| wrap(p.heading - p.trailer).abs() > t.fold) {
            return false;
        }
        bodies(rig, p).all(|b| {
            let (c, s) = (b.heading.cos(), b.heading.sin());
            let (nl, nw) = ((2.0 * b.half_l / 0.03).ceil() as usize, (2.0 * b.half_w / 0.03).ceil() as usize);
            (0..=nl).all(|a| {
                let l = -b.half_l + 2.0 * b.half_l * a as f64 / nl as f64;
                (0..=nw).all(|k| {
                    let w = -b.half_w + 2.0 * b.half_w * k as f64 / nw as f64;
                    self.open((b.x + c * l - s * w, b.y + s * l + c * w))
                })
            })
        })
    }

    /// How far each cell is from the goal for something that could go any
    /// way over open ground: never more than a vehicle drives, and round
    /// the walls, not through them.
    fn distances(&self, goal: (f64, f64)) -> Vec<f64> {
        let mut d = vec![f64::MAX; self.w * self.h];
        let (gi, gj) = (((goal.0 - self.x0) / RES).round().clamp(0.0, self.w as f64 - 1.0) as usize, ((goal.1 - self.y0) / RES).round().clamp(0.0, self.h as f64 - 1.0) as usize);
        let mut open = BinaryHeap::new();
        d[gj * self.w + gi] = 0.0;
        open.push(Reverse((0i64, gj * self.w + gi)));
        while let Some(Reverse((c, at))) = open.pop() {
            let here = c as f64 / 1e6;
            if here > d[at] {
                continue;
            }
            let (i, j) = ((at % self.w) as i64, (at / self.w) as i64);
            for (di, dj) in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
                let (ni, nj) = (i + di, j + dj);
                if ni < 0 || nj < 0 || ni >= self.w as i64 || nj >= self.h as i64 {
                    continue;
                }
                let n = nj as usize * self.w + ni as usize;
                let step = if di != 0 && dj != 0 { RES * std::f64::consts::SQRT_2 } else { RES };
                if self.free[n] && here + step < d[n] {
                    d[n] = here + step;
                    open.push(Reverse(((d[n] * 1e6) as i64, n)));
                }
            }
        }
        d
    }

    fn at(&self, d: &[f64], (x, y): (f64, f64)) -> f64 {
        let (i, j) = (((x - self.x0) / RES).round().clamp(0.0, self.w as f64 - 1.0) as usize, ((y - self.y0) / RES).round().clamp(0.0, self.h as f64 - 1.0) as usize);
        d[j * self.w + i]
    }
}

/// A step of the search, in tiles; and the finer steps each is checked in.
const STEP: f64 = 0.1;
const SUB: f64 = 0.02;
/// The cells two poses must differ by to be told apart: in tiles, in
/// radians of heading, and of the trailer's fold.
const CELL: f64 = 0.025;
const HEADING: f64 = PI / 36.0;
const FOLD: f64 = PI / 18.0;
/// What a search may look at before it gives up.
const LIMIT: usize = 200_000;
/// What driving costs besides its length: backing, for each tile of it;
/// a change of gear; turning the wheel, for each full lock of it; and a
/// trailer folded, for each radian of it, a tile.
const BACKING: f64 = 1.0;
const GEAR: f64 = 0.6;
const WHEEL: f64 = 0.5;
const BENT: f64 = 0.3;
/// How much more the search trusts its guess of the way left than what it
/// has driven: a little more finds a good way many times sooner than the
/// very best.
const GREED: f64 = 5.0;

struct Node {
    pose: Pose,
    g: f64,
    parent: usize,
    back: bool,
    k: f64,
    length: f64,
}

type Key = (i32, i32, i32, i32);

/// The cell a pose is in: where, which way, how folded.
fn key(rig: &Rig, p: &Pose) -> Key {
    let fold = if rig.trailer.is_some() { (wrap(p.heading - p.trailer) / FOLD).round() as i32 } else { 0 };
    ((p.x / CELL).round() as i32, (p.y / CELL).round() as i32, (p.heading.rem_euclid(2.0 * PI) / HEADING).round() as i32 % 72, fold)
}

/// A search's tree: every pose reached, the cheapest way to each cell, and
/// the poses still to go on from, cheapest guess first.
struct Tree<'a> {
    rig: &'a Rig,
    field: &'a Field,
    gears: &'a [bool],
    nodes: Vec<Node>,
    best: BTreeMap<Key, (f64, usize)>,
    open: BinaryHeap<Reverse<(i64, usize)>>,
}

fn cost(x: f64) -> i64 {
    (x * 1e6) as i64
}

impl<'a> Tree<'a> {
    fn new(rig: &'a Rig, field: &'a Field, from: Pose, gears: &'a [bool]) -> Tree<'a> {
        let mut open = BinaryHeap::new();
        if field.fits(rig, from) {
            open.push(Reverse((0, 0)));
        }
        let nodes = vec![Node { pose: from, g: 0.0, parent: usize::MAX, back: false, k: 0.0, length: 0.0 }];
        Tree { rig, field, gears, nodes, best: BTreeMap::from([(key(rig, &from), (0.0, 0))]), open }
    }

    /// The cheapest pose yet to go on from, and the poses a step on from it
    /// that are the cheapest way to their cells yet: `h` guesses the way
    /// left from each.
    fn grow(&mut self, h: impl Fn(&Pose) -> f64) -> Option<(usize, std::ops::Range<usize>)> {
        let Reverse((_, i)) = self.open.pop()?;
        let start = self.nodes.len();
        let here = &self.nodes[i];
        let (pose, g, first) = (here.pose, here.g, here.parent == usize::MAX);
        let (was_back, was_k) = (here.back, here.k);
        let rig = self.rig;
        for &back in self.gears {
            for k in [-1.0, -0.5, 0.0, 0.5, 1.0].map(|f| f * rig.lock) {
                // The step, checked as it goes, and cut short where it
                // would touch: in a tight spot a driver creeps.
                let mut p = pose;
                let mut length = 0.0;
                for _ in 0..(STEP / SUB).round() as usize {
                    let q = step(rig, p, k, if back { -SUB } else { SUB });
                    if !self.field.fits(rig, q) {
                        break;
                    }
                    (p, length) = (q, length + SUB);
                }
                if length == 0.0 {
                    continue;
                }
                let bent = rig.trailer.map_or(0.0, |_| wrap(p.heading - p.trailer).abs());
                let g = g
                    + length * (1.0 + if back { BACKING } else { 0.0 } + BENT * bent)
                    + if !first && back != was_back { GEAR } else { 0.0 }
                    + WHEEL * (k - was_k).abs() / rig.lock;
                let cell = key(rig, &p);
                if self.best.get(&cell).is_some_and(|&(b, _)| b <= g) {
                    continue;
                }
                self.best.insert(cell, (g, self.nodes.len()));
                self.nodes.push(Node { pose: p, g, parent: i, back, k, length });
                self.open.push(Reverse((cost(g + GREED * h(&p)), self.nodes.len() - 1)));
            }
        }
        Some((i, start..self.nodes.len()))
    }
}

/// The cheapest way from `from` to `goal` across the lot, as moves; or
/// none, if there is no way within the search's patience.
pub fn plan(rig: &Rig, field: &Field, from: Pose, goal: &Goal) -> Option<Vec<Move>> {
    let far = field.distances((goal.pose.x, goal.pose.y));
    let (c, sn) = (goal.pose.heading.cos(), goal.pose.heading.sin());
    let arrived = |p: &Pose| {
        let (dx, dy) = (p.x - goal.pose.x, p.y - goal.pose.y);
        (dx * c + dy * sn).abs() <= goal.along
            && (dy * c - dx * sn).abs() <= goal.reach
            && wrap(p.heading - goal.pose.heading).abs() <= goal.turn
            && wrap(p.trailer - goal.pose.trailer).abs() <= goal.turn
    };
    // The way left: at least as far as the ground's shortest way round the
    // walls, and as far as it takes to turn to the goal's heading at full
    // lock.
    let h = |p: &Pose| {
        let turn = |a: f64| (wrap(a - goal.pose.heading).abs() - goal.turn).max(0.0) / rig.lock;
        (field.at(&far, (p.x, p.y)).min(1e3) - goal.reach.max(goal.along)).max(0.0).max(turn(p.heading)).max(turn(p.trailer))
    };
    let mut tree = Tree::new(rig, field, from, &[false, true]);
    while tree.nodes.len() <= LIMIT {
        let (i, _) = tree.grow(&h)?;
        if arrived(&tree.nodes[i].pose) {
            return Some(moves(&tree.nodes, i));
        }
    }
    None
}

/// The steps back from the last node to the first, as moves: steps alike
/// run together.
fn moves(nodes: &[Node], mut i: usize) -> Vec<Move> {
    let mut out: Vec<Move> = Vec::new();
    while nodes[i].parent != usize::MAX {
        let n = &nodes[i];
        match out.last_mut() {
            Some(m) if m.back == n.back && m.from == n.k => m.length += n.length,
            _ => out.push(Move { back: n.back, from: n.k, to: n.k, length: n.length }),
        }
        i = n.parent;
    }
    out.reverse();
    out
}

/// How fast a driver turns the wheel while moving: curvature a tile.
pub const HAND: f64 = 30.0;

/// The plan with the wheel turned at a hand's pace: each change of turn
/// within a gear eased over a short stretch either side of where it was,
/// where the lot leaves room; at a change of gear the wheel is turned
/// standing, as before.
pub fn smooth(rig: &Rig, field: &Field, from: Pose, moves: &[Move]) -> Vec<Move> {
    let mut out: Vec<Move> = Vec::new();
    let mut i = 0;
    while i < moves.len() {
        let mut m = moves[i];
        if let Some(prev) = out.last_mut()
            && prev.back == m.back
            && prev.to != m.from
        {
            let ramp = ((m.from - prev.to).abs() / HAND).min(prev.length).min(m.length);
            let cut = Move { back: m.back, from: prev.to, to: m.from, length: ramp };
            prev.length -= ramp / 2.0;
            m.length -= ramp / 2.0;
            out.push(cut);
        }
        out.push(m);
        i += 1;
    }
    out.retain(|m| m.length > 1e-9);
    if drive(rig, from, &out).iter().all(|&(_, p)| field.fits(rig, p)) { out } else { moves.to_vec() }
}

#[cfg(test)]
mod tests;
