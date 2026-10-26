//! The water and the ways over it. A map's sea is read once into a flat
//! grid of clearance, how far each tile is from land; a way between two
//! places is an A* search over its tiles, eight ways, dearer close to the
//! coast and at a turn, so it runs along rows, columns and diagonals as a
//! road does and bends in steps of 45°; its bends are rounded as a car
//! rounds a street corner, wide as a ship turns, and bends close together
//! are one sweep. The sea does not change, so a way is found once and kept
//! (docs/plan-sea.md §Decisions).

use std::cmp::Reverse;

use super::lanes::{Lanes, WAYS};
use std::collections::BinaryHeap;
use fixed::HashMap;

use model::{GridCoord, Pose};
use land::TerrainType;
use crate::world::sea::FERRY_LENGTH;

/// Tiles of sea in a line behind a harbour: the ferry's length at the
/// berth, and room to come straight in.
pub const BERTH: i32 = 6;
/// Clearance is counted to here: further out is open water all the same.
const FAR: u8 = 15;
/// What a step costs, in tenths of a tile: straight, diagonal, and more on
/// a tile this close to land (one tile, two), so a way keeps off the coast
/// where there is room and hugs it where there is not.
const STEP: u32 = 10;
const DIAGONAL: u32 = 14;
const COAST: [u32; 3] = [0, 30, 10];
/// What a turn costs by its angle (docs/shipping.md §The sea), in tenths
/// of a tile an eighth: a 45° bend a tile, so a way runs straight rather
/// than zig-zag; a turn sharper than 90° is none a ship makes.
const BEND: u32 = 10;
/// How tight a ship turns at a bend, in tiles, where there is room: a
/// ferry's length and more. Never tighter than `TURN`: the class limit
/// (docs/shipping.md §The sea), a turn in half its own length.
pub const ROUNDING: f64 = 4.0;
/// Bends with less than this straight between them, in tiles, are one
/// sweep.
const APART: f64 = 2.0;
pub const TURN: f64 = FERRY_LENGTH / 2.0;
/// Water this close to land, under about two ships' widths each side, is
/// narrow: the only water where a lane may run both ways.
pub const NARROW: u8 = 2;

/// The berth of a harbour: its quay tile and the way out to sea from it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Berth {
    pub quay: GridCoord,
    pub out: (i32, i32),
}

impl Berth {
    pub fn tile(&self, n: i32) -> GridCoord {
        GridCoord { x: self.quay.x + self.out.0 * n, y: self.quay.y + self.out.1 * n }
    }
    /// The middle of the quay's edge, where the ramp comes down.
    pub fn ramp(&self) -> [f64; 2] {
        [self.quay.x as f64 + 0.5 - self.out.0 as f64 * 0.5, self.quay.y as f64 + 0.5 - self.out.1 as f64 * 0.5]
    }
    /// Toward the land, from the sea.
    pub fn landward(&self) -> f64 {
        (-self.out.1 as f64).atan2(-self.out.0 as f64)
    }
    /// The ferry at the berth: its land end on the ramp, facing the land.
    pub fn moored(&self) -> Pose {
        let d = FERRY_LENGTH / 2.0;
        Pose { at: [self.ramp()[0] + self.out.0 as f64 * d, self.ramp()[1] + self.out.1 as f64 * d], heading: self.landward() }
    }
}

/// Where a way ends: at a berth, or off the map's edge, to the world.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum End {
    Berth(Berth),
    Edge,
}

/// A map's sea: its bounds, in tiles, and each tile's clearance, how many
/// steps (eight ways) it is from the nearest tile that is not sea, up to
/// `FAR`; land is 0. Past the map's edge is open sea.
pub struct Water {
    pub x0: i32,
    pub y0: i32,
    pub w: i32,
    pub h: i32,
    pub clearance: Vec<u8>,
}

impl Water {
    /// A map from rows of text, as the fixtures key it: `≈` or `~` sea,
    /// anything else land.
    #[cfg(test)]
    pub fn from_rows(rows: &[impl AsRef<str>]) -> Water {
        let rows: Vec<Vec<char>> = rows.iter().map(|r| r.as_ref().chars().collect()).collect();
        Water::new(0, 0, rows[0].len() as i32, rows.len() as i32, |x, y| matches!(rows[y as usize][x as usize], '≈' | '~'))
    }

    /// A map's water, from whether each tile in its bounds is sea.
    pub fn new(x0: i32, y0: i32, w: i32, h: i32, sea: impl Fn(i32, i32) -> bool) -> Water {
        let mut c: Vec<u8> = (0..w * h).map(|i| if sea(x0 + i % w, y0 + i / w) { FAR } else { 0 }).collect();
        // Two passes, each taking the least of its neighbours already
        // passed, plus one: the distance to land, eight ways.
        let at = |c: &[u8], x: i32, y: i32| if x < 0 || y < 0 || x >= w || y >= h { FAR } else { c[(y * w + x) as usize] };
        for y in 0..h {
            for x in 0..w {
                let n = [at(&c, x - 1, y), at(&c, x - 1, y - 1), at(&c, x, y - 1), at(&c, x + 1, y - 1)].into_iter().min().unwrap();
                let i = (y * w + x) as usize;
                c[i] = c[i].min(n.saturating_add(1));
            }
        }
        for y in (0..h).rev() {
            for x in (0..w).rev() {
                let n = [at(&c, x + 1, y), at(&c, x + 1, y + 1), at(&c, x, y + 1), at(&c, x - 1, y + 1)].into_iter().min().unwrap();
                let i = (y * w + x) as usize;
                c[i] = c[i].min(n.saturating_add(1));
            }
        }
        Water { x0, y0, w, h, clearance: c }
    }

    /// The game's terrain's water: its sea, in the bounds of its tiles.
    pub fn of(terrain: &HashMap<(i32, i32), TerrainType>) -> Water {
        let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        for &(x, y) in terrain.keys() {
            (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
        }
        if x0 > x1 {
            return Water::new(0, 0, 0, 0, |_, _| false);
        }
        Water::new(x0, y0, x1 - x0 + 1, y1 - y0 + 1, |x, y| terrain.get(&(x, y)) == Some(&TerrainType::Sea))
    }

    fn index(&self, x: i32, y: i32) -> Option<usize> {
        let (i, j) = (x - self.x0, y - self.y0);
        (i >= 0 && j >= 0 && i < self.w && j < self.h).then(|| (j * self.w + i) as usize)
    }

    /// A tile's clearance; past the edge, open sea.
    pub fn clear(&self, x: i32, y: i32) -> u8 {
        self.index(x, y).map_or(FAR, |i| self.clearance[i])
    }

    /// The clearance under a point.
    pub fn clear_at(&self, p: [f64; 2]) -> u8 {
        self.clear(p[0].floor() as i32, p[1].floor() as i32)
    }

    /// The tiles of the cheapest way from a tile, going `ahead`, to the
    /// goal, by A*: eight ways over the sea, never cutting a corner of
    /// land, dearer near the coast and at a turn (by the way the tile was
    /// reached, so a guide, not a bound), never sharper than 90°. The goal
    /// says which tiles end it, by the way it comes onto them. `toward`
    /// is a lower bound on the cost left, in tenths of a tile.
    fn search(&self, lanes: &Lanes, sign: i32, from: GridCoord, ahead: (i32, i32), goal: impl Fn(i32, i32, (i32, i32)) -> bool, toward: impl Fn(i32, i32) -> u32) -> Option<Vec<GridCoord>> {
        let start = self.index(from.x, from.y).filter(|&i| self.clearance[i] > 0)?;
        let mut cost = vec![u32::MAX; self.clearance.len()];
        let mut came = vec![u32::MAX; self.clearance.len()];
        let mut open = BinaryHeap::new();
        cost[start] = 0;
        // Ties go to the way further along, so a straight run over open
        // water opens a line of tiles, not a fan.
        open.push(Reverse((toward(from.x, from.y), Reverse(0u32), start as u32)));
        // The cheapest way onto the goal found so far: its cost, the tile
        // it ends on and the one before.
        let mut done: Option<(u32, usize, usize)> = None;
        while let Some(Reverse((f, Reverse(g), i))) = open.pop() {
            if let Some((_, end, before)) = done.filter(|d| d.0 <= f) {
                let mut path = vec![end, before];
                while *path.last().unwrap() != start {
                    path.push(came[*path.last().unwrap()] as usize);
                }
                return Some(path.into_iter().rev().map(|at| GridCoord { x: self.x0 + at as i32 % self.w, y: self.y0 + at as i32 / self.w }).collect());
            }
            let i = i as usize;
            if g > cost[i] {
                continue;
            }
            let (x, y) = (self.x0 + i as i32 % self.w, self.y0 + i as i32 / self.w);
            let came_by = if i == start { ahead } else { (x - (self.x0 + came[i] as i32 % self.w), y - (self.y0 + came[i] as i32 / self.w)) };
            let came_by = WAYS.iter().position(|&w| w == came_by).unwrap();
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
                let Some(j) = self.index(x + dx, y + dy) else { continue };
                let c = self.clearance[j];
                if c == 0 || (dx != 0 && dy != 0 && (self.clear(x + dx, y) == 0 || self.clear(x, y + dy) == 0)) {
                    continue;
                }
                // Dearer by the coast, and with the coast close on the
                // left, where a lane the other way would run.
                let eighths = (WAYS.iter().position(|&w| w == (dx, dy)).unwrap() + 8 - came_by) % 8;
                let eighths = eighths.min(8 - eighths) as u32;
                if eighths > 2 {
                    continue;
                }
                let way = WAYS.iter().position(|&w| w == (dx * sign, dy * sign)).unwrap();
                let (lx, ly) = WAYS[(way + 6) % 8];
                let coast = |c: u8| COAST.get(c.max(1) as usize).copied().unwrap_or(0);
                let step = (if dx != 0 && dy != 0 { DIAGONAL } else { STEP } + coast(c) + coast(self.clear(x + dx + 2 * lx, y + dy + 2 * ly)) + BEND * eighths) as i32 + lanes.step(x + dx, y + dy, way);
                let g = g + step as u32;
                if goal(x + dx, y + dy, (dx, dy)) {
                    if done.is_none_or(|d| g < d.0) {
                        done = Some((g, j, i));
                        open.push(Reverse((g, Reverse(g), j as u32)));
                    }
                } else if g < cost[j] {
                    cost[j] = g;
                    came[j] = i as u32;
                    open.push(Reverse((g + toward(x + dx, y + dy), Reverse(g), j as u32)));
                }
            }
        }
        None
    }

    /// Does a polyline keep to the water all the way: every tile it
    /// passes over, sampled finely enough not to miss a corner.
    pub fn afloat(&self, path: &[[f64; 2]]) -> bool {
        path.windows(2).all(|w| {
            let n = ((w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]) * 8.0).ceil().max(1.0) as usize;
            (0..=n).all(|k| {
                let t = k as f64 / n as f64;
                self.clear_at([w[0][0] + (w[1][0] - w[0][0]) * t, w[0][1] + (w[1][1] - w[0][1]) * t]) > 0
            })
        })
    }

    /// A way's bends, each a corner of a line along rows, columns and
    /// diagonals, rounded as a car rounds a street corner
    /// (`drawnPath.ts`): a curve from a point on the leg in to one on the
    /// leg out, as far from the corner each side, drawn toward the corner
    /// (a quadratic Bézier, the corner its control), so it leaves and
    /// joins each leg along it. As far out as makes it no tighter than
    /// `ROUNDING` where the legs have room and it stays on the water,
    /// tighter where not; a corner no curve of `TURN` fits stays sharp,
    /// and `tightest` finds it. Bends too close for a straight between
    /// them are one sweep: turning the same way, one bend at the corner
    /// where their outer legs meet; turning back, a jog, one S from the
    /// leg in to the leg out. So a way sweeps round, never in a staircase.
    fn round(&self, corners: &[[f64; 2]]) -> Vec<[f64; 2]> {
        let mut p = corners.to_vec();
        loop {
            let merge = (2..p.len().saturating_sub(1)).find_map(|i| {
                let (a, b) = (turn(&p, i - 1), turn(&p, i));
                let leg = dist(p[i - 1], p[i]);
                if a * b <= 0.0 || (a + b).abs() > 0.51 * std::f64::consts::PI || reach(a) + reach(b) + APART <= leg {
                    return None;
                }
                let mut q = p.clone();
                q.splice(i - 1..=i, [meet(p[i - 2], p[i - 1], p[i], p[i + 1])]);
                self.afloat(&sweep(&q, i - 1, i - 1, room(&q, i - 1, i - 1).0)).then_some(q)
            });
            match merge {
                Some(q) => p = q,
                None => break,
            }
        }
        let mut out = vec![p[0]];
        let mut i = 1;
        while i + 1 < p.len() {
            let jog = i + 2 < p.len() && (turn(&p, i) + turn(&p, i + 1)).abs() < 1e-6 && 2.0 * reach(turn(&p, i)) + APART > dist(p[i], p[i + 1]);
            let j = if jog { i + 1 } else { i };
            let (t, floor) = room(&p, i, j);
            // Never back behind where the last bend ended.
            let mut t = t.min(dist(*out.last().unwrap(), p[i]));
            loop {
                if turn(&p, i).abs() < 1e-3 || t < (floor / 2.0).max(0.01) {
                    out.extend(&p[i..=j]);
                    break;
                }
                let pts = sweep(&p, i, j, t);
                if self.afloat(&pts) && self.afloat(&[*out.last().unwrap(), pts[0]]) {
                    out.extend(pts);
                    break;
                }
                // Down to the class limit, then under it only if it must.
                t = if t > floor { (t / 2.0).max(floor) } else { t / 2.0 };
            }
            i = j + 1;
        }
        out.push(*p.last().unwrap());
        out.dedup_by(|a, b| dist(*a, *b) < 1e-6);
        out
    }

    /// The way between a berth and another berth, or the map's edge,
    /// over the lanes laid so far: out from the berth straight along its
    /// line, the cheapest way over the water along rows, columns and
    /// diagonals, its bends rounded, and straight in to the other berth along its line, or on to
    /// the edge itself. Sailed out from the berth, or, `toward_berth`, the
    /// other way: then lanes are read as a ship going that way meets them,
    /// so the way back runs beside the way out. Points in tiles, in the
    /// order a ship sails them, the ferry's middle at a berth. None where
    /// the water does not join.
    pub fn route(&self, lanes: &Lanes, berth: &Berth, other: End, toward_berth: bool) -> Option<Vec<[f64; 2]>> {
        let start = berth.tile(BERTH - 1);
        let (x1, y1) = (self.x0 + self.w - 1, self.y0 + self.h - 1);
        let sign = if toward_berth { -1 } else { 1 };
        let tiles = match other {
            End::Berth(b) => {
                let goal = b.tile(BERTH - 1);
                // Onto the berth's line no sharper than a ship turns in.
                let into = (-b.out.0, -b.out.1);
                self.search(lanes, sign, start, berth.out, |x, y, (dx, dy)| x == goal.x && y == goal.y && dx * into.0 + dy * into.1 >= 0, |x, y| {
                    let (dx, dy) = ((x - goal.x).unsigned_abs(), (y - goal.y).unsigned_abs());
                    STEP * dx.max(dy) + (DIAGONAL - STEP) * dx.min(dy)
                })?
            }
            End::Edge => self.search(lanes, sign, start, berth.out, |x, y, _| x == self.x0 || y == self.y0 || x == x1 || y == y1, |x, y| STEP * (x - self.x0).min(x1 - x).min(y - self.y0).min(y1 - y) as u32)?,
        };
        // A corner where the way turns: along a row, a column or a
        // diagonal between.
        let centre = |t: &GridCoord| [t.x as f64 + 0.5, t.y as f64 + 0.5];
        let mut corners = vec![berth.moored().at];
        corners.extend(tiles.iter().map(centre));
        match other {
            End::Berth(b) => corners.push(b.moored().at),
            // On over the edge, the way it came.
            End::Edge => {
                let n = tiles.len();
                let (dx, dy) = if n > 1 { (tiles[n - 1].x - tiles[n - 2].x, tiles[n - 1].y - tiles[n - 2].y) } else { berth.out };
                let last = centre(&tiles[n - 1]);
                corners.push([last[0] + dx as f64 / 2.0, last[1] + dy as f64 / 2.0]);
            }
        }
        corners.dedup_by(|a, b| dist(*a, *b) < 1e-9);
        let mut k = 1;
        while k + 1 < corners.len() {
            if turn(&corners, k).abs() < 1e-9 {
                corners.remove(k);
            } else {
                k += 1;
            }
        }
        let mut way = self.round(&corners);
        if toward_berth {
            way.reverse();
        }
        Some(way)
    }
}

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    (b[0] - a[0]).hypot(b[1] - a[1])
}

/// The unit way from `a` to `b`.
fn unit(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    let l = dist(a, b);
    [(b[0] - a[0]) / l, (b[1] - a[1]) / l]
}

/// How far a polyline turns at its point `i`, radians, left negative.
fn turn(p: &[[f64; 2]], i: usize) -> f64 {
    let (u, v) = (unit(p[i - 1], p[i]), unit(p[i], p[i + 1]));
    (u[0] * v[1] - u[1] * v[0]).atan2(u[0] * v[0] + u[1] * v[1])
}

/// How far back from its corner along each leg a bend through `turn`
/// starts, to be no tighter than `ROUNDING` anywhere: the curve is
/// tightest at its middle, where its radius is the reach times
/// cos²(turn / 2) / sin(turn / 2).
fn reach(turn: f64) -> f64 {
    let h = turn.abs() / 2.0;
    ROUNDING * h.sin() / (h.cos() * h.cos())
}

/// Where the line through `a` and `b` meets the line through `c` and `d`.
fn meet(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> [f64; 2] {
    let (u, v) = (unit(a, b), unit(c, d));
    let s = ((c[0] - b[0]) * v[1] - (c[1] - b[1]) * v[0]) / (u[0] * v[1] - u[1] * v[0]);
    [b[0] + u[0] * s, b[1] + u[1] * s]
}

/// How far back along the legs a sweep over corners `i` to `j` may
/// start, and the least that keeps it within the class limit: its reach,
/// or what the legs either side give it, a leg shared with the next bend
/// by what each wants, all of the first and last. A jog's S is gentle
/// when it is long beside how far it steps over: its radius is the
/// square of its length over six times the step.
fn room(p: &[[f64; 2]], i: usize, j: usize) -> (f64, f64) {
    let want = |k: usize| reach(turn(p, k));
    let (u, step) = (unit(p[i - 1], p[i]), [p[j][0] - p[i][0], p[j][1] - p[i][1]]);
    let (over, along) = ((step[0] * u[1] - step[1] * u[0]).abs(), step[0] * u[0] + step[1] * u[1]);
    let s_back = |r: f64| ((6.0 * over * r).sqrt() - along).max(0.0) / 2.0;
    let (wants, floor) = if i == j { (want(i), want(i) * TURN / ROUNDING) } else { (s_back(ROUNDING), s_back(TURN)) };
    let before = dist(p[i - 1], p[i]) * if i == 1 { 1.0 } else { wants / (want(i - 1) + wants) };
    let after = dist(p[j], p[j + 1]) * if j + 2 == p.len() { 1.0 } else { wants / (want(j + 1) + wants) };
    (wants.min(before).min(after), floor)
}

/// The sweep over corners `i` to `j`, starting `t` back along the leg in
/// and ending as far along the leg out: points along it, a tenth of a
/// radian of turn apart at most. One corner's is drawn toward the corner
/// (its handles two thirds of the way there); a jog's runs on along the
/// leg in and comes in along the leg out (its handles a third of its
/// length each).
fn sweep(p: &[[f64; 2]], i: usize, j: usize, t: f64) -> Vec<[f64; 2]> {
    let (u, v) = (unit(p[i - 1], p[i]), unit(p[j], p[j + 1]));
    let (a, d) = ([p[i][0] - u[0] * t, p[i][1] - u[1] * t], [p[j][0] + v[0] * t, p[j][1] + v[1] * t]);
    let h = if i == j { 2.0 * t / 3.0 } else { ((d[0] - a[0]) * u[0] + (d[1] - a[1]) * u[1]) / 3.0 };
    let (b, c) = ([a[0] + u[0] * h, a[1] + u[1] * h], [d[0] - v[0] * h, d[1] - v[1] * h]);
    let n = ((turn(p, i).abs() + turn(p, j).abs()) / 0.1).ceil().max(1.0) as usize * 2;
    (0..=n)
        .map(|k| {
            let s = k as f64 / n as f64;
            let w = [(1.0 - s).powi(3), 3.0 * s * (1.0 - s).powi(2), 3.0 * s * s * (1.0 - s), s.powi(3)];
            [w[0] * a[0] + w[1] * b[0] + w[2] * c[0] + w[3] * d[0], w[0] * a[1] + w[1] * b[1] + w[2] * c[1] + w[3] * d[1]]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shipping::lanes::Kind;

    /// The tightest turn along a way at sea, as a radius in tiles: at each
    /// point, the legs either side over the angle between them. Within
    /// `BERTH` tiles of a berth the ferry turns on its thrusters, at a crawl,
    /// and is not counted.
    fn tightest(way: &[[f64; 2]]) -> f64 {
        let len = crate::shipping::length(way);
        let mut along = 0.0;
        let mut at_sea = Vec::new();
        for (i, p) in way.iter().enumerate() {
            if i > 0 {
                along += (p[0] - way[i - 1][0]).hypot(p[1] - way[i - 1][1]);
            }
            if along >= BERTH as f64 && along <= len - BERTH as f64 {
                at_sea.push(*p);
            }
        }
        turns(&at_sea)
    }

    fn turns(path: &[[f64; 2]]) -> f64 {
        path.windows(3)
            .map(|w| {
                let (u, v) = ([w[1][0] - w[0][0], w[1][1] - w[0][1]], [w[2][0] - w[1][0], w[2][1] - w[1][1]]);
                let angle = (u[0] * v[1] - u[1] * v[0]).atan2(u[0] * v[0] + u[1] * v[1]).abs();
                let reach = (u[0].hypot(u[1]) + v[0].hypot(v[1])) / 2.0;
                if angle < 1e-6 { f64::INFINITY } else { reach / angle }
            })
            .fold(f64::INFINITY, f64::min)
    }

    #[test]
    fn clearance_is_the_steps_to_land() {
        let w = Water::from_rows(&["......", "~~~~~~", "~~~~~~", "~~~~~~", "~~~~~~"]);
        assert_eq!((0..5).map(|y| w.clear(2, y)).collect::<Vec<_>>(), vec![0, 1, 2, 3, 4]);
    }

    /// Round a headland: the way never crosses land, keeps off it, turns
    /// no tighter than the class limit, and ends over the edge.
    #[test]
    fn a_way_round_a_headland() {
        let mut rows = vec!["........................................"; 3];
        for _ in 0..8 {
            rows.push("~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~");
        }
        for _ in 0..14 {
            rows.push("~~~~~~~~~~~~~~~~~~~~~~~~~~.......~~~~~~~");
        }
        for _ in 0..20 {
            rows.push("~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~");
        }
        let w = Water::from_rows(&rows);
        let from = Berth { quay: GridCoord { x: 5, y: 3 }, out: (0, 1) };
        let to = Berth { quay: GridCoord { x: 34, y: 3 }, out: (0, 1) };
        let lanes = Lanes::new(&w);
        for end in [End::Berth(to), End::Edge] {
            let way = w.route(&lanes, &from, end, false).expect("a way");
            assert!(w.afloat(&way), "it crossed land: {way:?}");
            assert!(tightest(&way) >= TURN, "it turned in {:.2} tiles", tightest(&way));
            assert_eq!(way[0], from.moored().at);
        }
        let edge = w.route(&lanes, &from, End::Edge, false).unwrap();
        let last = edge.last().unwrap();
        assert!(last[0] == 0.0 || last[1] == rows.len() as f64 || last[0] == 40.0, "it ended at {last:?}");
    }

    /// On seeds 0 to 19, from the home island's harbour site nearest the
    /// origin, a way to the map's edge and to every other island, and the
    /// way back beside it, laid as lanes: none crosses land, one in
    /// twenty-five at most turns tighter than the class limit, each is
    /// found within the budget, 50 ms, and in open water the two are
    /// one-way lanes, shared only on the berths' approaches and where they
    /// cross. Twenty maps
    /// take a while, so this runs with `every_seed` on request.
    #[test]
    #[ignore]
    fn every_seed_has_ways_over_the_sea() {
        // How far a ship may stray off the tiles its lane reserves: those
        // are the tiles under it a quarter tile apart, so a bend's arc may
        // clip the corner of a tile between two of them, by an eighth of
        // a tile at most; a quarter is that and room to spare, and still
        // well inside the tile's width beside a lane where the next lane
        // runs (docs/plan-sea.md, keep right).
        const SLACK: f64 = 0.25;
        let mut wrong = Vec::new();
        let mut kinked = Vec::new();
        let mut times = Vec::new();
        let (mut off_grid, mut off_lane) = (0, 0);
        // The tiles a way passes over, a quarter tile apart.
        let under = |w: &[[f64; 2]]| -> Vec<(i32, i32)> { crate::shipping::lanes::under(w).into_iter().map(|(_, x, y, _)| (x, y)).collect() };
        for seed in 0..20 {
            let started = std::time::Instant::now();
            let water = Water::of(&land::terrain::generate(seed));
            let built = started.elapsed().as_secs_f64() * 1000.0;
            // Every berth there is: sea with land behind it and room
            // straight out; and each tile's island, by flooding the land.
            let land = |x: i32, y: i32| water.index(x, y).is_some_and(|i| water.clearance[i] == 0);
            let mut island = vec![u32::MAX; water.clearance.len()];
            let mut sizes = Vec::new();
            for i in 0..island.len() {
                if water.clearance[i] != 0 || island[i] != u32::MAX {
                    continue;
                }
                let n = sizes.len() as u32;
                let mut todo = vec![i];
                island[i] = n;
                let mut size = 0;
                while let Some(j) = todo.pop() {
                    size += 1;
                    let (x, y) = (water.x0 + j as i32 % water.w, water.y0 + j as i32 / water.w);
                    for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                        if let Some(k) = water.index(x + dx, y + dy).filter(|&k| water.clearance[k] == 0 && island[k] == u32::MAX) {
                            island[k] = n;
                            todo.push(k);
                        }
                    }
                }
                sizes.push(size);
            }
            let berths: Vec<(Berth, u32)> = (0..water.h)
                .flat_map(|j| (0..water.w).map(move |i| (water.x0 + i, water.y0 + j)))
                .filter(|&(x, y)| water.clear(x, y) == 1)
                .flat_map(|(x, y)| [(0, 1), (0, -1), (1, 0), (-1, 0)].map(|out| Berth { quay: GridCoord { x, y }, out }))
                .filter(|b| land(b.quay.x - b.out.0, b.quay.y - b.out.1) && (0..BERTH).all(|n| water.clear(b.tile(n).x, b.tile(n).y) > 0))
                .map(|b| (b, island[water.index(b.quay.x - b.out.0, b.quay.y - b.out.1).unwrap()]))
                .collect();
            let d2 = |b: &Berth, x: i32, y: i32| ((b.quay.x - x) as i64).pow(2) + ((b.quay.y - y) as i64).pow(2);
            let home = berths.iter().min_by_key(|(b, _)| d2(b, 0, 0)).copied().expect("a berth on the home island");
            let mut ends = vec![("edge".to_string(), End::Edge)];
            for (n, &size) in sizes.iter().enumerate() {
                if n as u32 == home.1 || size < 1000 {
                    continue;
                }
                if let Some((b, _)) = berths.iter().filter(|(_, i)| *i == n as u32).min_by_key(|(b, _)| d2(b, home.0.quay.x, home.0.quay.y)) {
                    ends.push((format!("island {n}"), End::Berth(*b)));
                }
            }
            let mut line = format!("seed {seed}: water in {built:.0} ms;");
            for (name, end) in ends {
                // Out, and back beside it, laid as lanes.
                let mut lanes = Lanes::new(&water);
                let berths = [true, end != End::Edge];
                let mut ways = Vec::new();
                for toward_berth in [false, true] {
                    // The best of three: the machine may be busy.
                    let mut ms = f64::INFINITY;
                    let mut way = None;
                    for _ in 0..3 {
                        let started = std::time::Instant::now();
                        way = water.route(&lanes, &home.0, end, toward_berth);
                        ms = ms.min(started.elapsed().as_secs_f64() * 1000.0);
                    }
                    times.push(ms);
                    if ms > 50.0 {
                        wrong.push(format!("seed {seed}: the way to {name} took {ms:.0} ms"));
                    }
                    let Some(way) = way else { break };
                    lanes.lay(&water, &way, if toward_berth { [berths[1], berths[0]] } else { berths });
                    // Its straights run along rows, columns and diagonals
                    // through the tiles' middles, as roads do; and all of
                    // it, every sixteenth of a tile, is over its own lane.
                    for w in way.windows(2) {
                        let (dx, dy) = (w[1][0] - w[0][0], w[1][1] - w[0][1]);
                        let l = dx.hypot(dy);
                        let whole = |v: f64| (v - v.round()).abs() < 1e-6;
                        let (mx, my) = (w[0][0] - 0.5, w[0][1] - 0.5);
                        let on_grid = if dy.abs() < 1e-9 { whole(my) } else if dx.abs() < 1e-9 { whole(mx) } else { (dx.abs() - dy.abs()).abs() < 1e-9 && whole(mx) && whole(my) || (dx.abs() - dy.abs()).abs() < 1e-9 && whole(if dx * dy > 0.0 { mx - my } else { mx + my }) };
                        if l > 1.0 && !on_grid {
                            off_grid += 1;
                            wrong.push(format!("seed {seed}: a way to {name} runs off the grid from {:?} to {:?}", w[0], w[1]));
                        }
                        let way = crate::shipping::lanes::way_of(dy.atan2(dx));
                        let n = (l * 16.0).ceil().max(1.0) as usize;
                        let near = |p: [f64; 2]| {
                            let tiles = |v: f64| (v - SLACK).floor() as i32..=(v + SLACK).floor() as i32;
                            tiles(p[0]).flat_map(|x| tiles(p[1]).map(move |y| (x, y))).any(|(x, y)| {
                                let gap = |v: f64, t: i32| (t as f64 - v).max(v - t as f64 - 1.0).max(0.0);
                                gap(p[0], x).hypot(gap(p[1], y)) <= SLACK && lanes.holds(x, y, way)
                            })
                        };
                        if let Some(p) = (0..=n).map(|k| [w[0][0] + dx * k as f64 / n as f64, w[0][1] + dy * k as f64 / n as f64]).filter(|p| water.index(p[0].floor() as i32, p[1].floor() as i32).is_some()).find(|&p| !near(p)) {
                            off_lane += 1;
                            wrong.push(format!("seed {seed}: a way to {name} sails off its lane at {p:?}"));
                        }
                    }
                    let tight = tightest(&way);
                    if !water.afloat(&way) || tight < TURN / 2.0 {
                        wrong.push(format!("seed {seed}: a way to {name} crosses land or turns in {tight:.2} tiles"));
                    } else if tight < TURN {
                        kinked.push(format!("seed {seed}: {} {name} turns in {tight:.2} tiles", if toward_berth { "back from" } else { "out to" }));
                    }
                    ways.push(way);
                }
                let [way, back] = &ways[..] else {
                    wrong.push(format!("seed {seed}: no way to {name}, or back"));
                    continue;
                };
                // Out of a junction, neither sails over the other's lane.
                for w in [way, back] {
                    if let Some((_, x, y, _)) = crate::shipping::lanes::under(w).into_iter().find(|&(_, x, y, h)| !lanes.its_own(x, y, h)) {
                        wrong.push(format!("seed {seed}: a way to {name} sails over another lane at {x},{y}\n{}", lanes.draw(&water, (x, y), 12)));
                    }
                }
                // Lanes are one-way in open water: past the berths'
                // approaches the way back runs over none of the way out's
                // water, but to cross it, where the two change sides.
                let out: fixed::HashSet<(i32, i32)> = under(way).into_iter().collect();
                let (mut run, mut longest, mut crossings) = (0, 0, 0);
                for t in under(back) {
                    let shared = out.contains(&t) && water.clear(t.0, t.1) > NARROW && !matches!(lanes.junction_at(t.0, t.1), Some((_, Kind::Berth)));
                    run = if shared { run + 1 } else { 0 };
                    crossings += (run == 1) as u32;
                    longest = longest.max(run);
                }
                if longest > 12 {
                    wrong.push(format!("seed {seed}: the ways to {name} and back share {:.1} tiles of open water", longest as f64 / 4.0));
                }
                let len = crate::shipping::length(way);
                line += &format!(" {name} {len:.0} tiles {:.1} h{};", crate::shipping::sail_ms(len, berths) as f64 / crate::shipping::HOUR as f64, if crossings > 0 { format!(", lanes cross {crossings}") } else { String::new() });
                // The world's line from here calls as often as the old
                // ferry's 6.4 a day, with as many ferries as that takes.
                if end == End::Edge {
                    let ferry = crate::shipping::lines::Line { legs: [way.clone(), back.clone()] };
                    let calls = ferry.every_call() as f64 * model::DAY_MS as f64 / ferry.cycle() as f64;
                    line += &format!(" {} ferries, {calls:.1} calls a day;", ferry.every_call());
                    if calls < 6.0 {
                        wrong.push(format!("seed {seed}: {calls:.1} calls a day"));
                    }
                }
            }
            eprintln!("{line}");
        }
        times.sort_by(f64::total_cmp);
        eprintln!("{} ways: median {:.1} ms, p90 {:.1} ms, worst {:.1} ms", times.len(), times[times.len() / 2], times[times.len() * 9 / 10], times[times.len() - 1]);
        // A way pressed between a lane and the coast may kink: a few, and
        // never under the router's own floor.
        eprintln!("{} ways turn tighter than the class: {kinked:#?}", kinked.len());
        eprintln!("{off_grid} legs off the grid, {off_lane} off their lanes");
        assert!(wrong.is_empty() && kinked.len() * 25 <= times.len(), "{wrong:#?}");
    }
}
