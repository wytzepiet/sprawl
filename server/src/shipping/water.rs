//! The water and the ways over it. A map's sea is read once into a flat
//! grid of clearance, how far each tile is from land; a way between two
//! places is an A* search over its tiles, eight ways, dearer close to the
//! coast, pulled tight along lines of sight into a few waypoints, and its
//! corners rounded to the ship's turn. The sea does not change, so a way
//! is found once and kept (docs/plan-sea.md §Decisions).

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

use crate::protocol::{GridCoord, Pose, TerrainType};
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
/// A line of sight keeps as far off the land as the tiles it replaces
/// did, up to this: three tiles is open water.
const OFFING: u8 = 3;
/// How tight a ship turns at a corner, in tiles, where there is room: a
/// ferry's length and a bit. Never tighter than `TURN`: the class limit
/// (docs/shipping.md §The sea), a turn in half its own length.
pub const ROUNDING: f64 = 4.0;
pub const TURN: f64 = FERRY_LENGTH / 2.0;
/// A run of a way through water this close to land on both sides, under
/// two ships' widths, is narrow: a block ships take one way at a time.
const NARROW: u8 = 1;

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

    /// The tiles of the cheapest way from a tile to the goal, by A*: eight
    /// ways over the sea, never cutting a corner of land, dearer near the
    /// coast. `toward` is a lower bound on the cost left, in tenths of a
    /// tile.
    fn search(&self, from: GridCoord, goal: impl Fn(i32, i32) -> bool, toward: impl Fn(i32, i32) -> u32) -> Option<Vec<GridCoord>> {
        let start = self.index(from.x, from.y).filter(|&i| self.clearance[i] > 0)?;
        let mut cost = vec![u32::MAX; self.clearance.len()];
        let mut came = vec![u32::MAX; self.clearance.len()];
        let mut open = BinaryHeap::new();
        cost[start] = 0;
        // Ties go to the way further along, so a straight run over open
        // water opens a line of tiles, not a fan.
        open.push(Reverse((toward(from.x, from.y), Reverse(0u32), start as u32)));
        while let Some(Reverse((_, Reverse(g), i))) = open.pop() {
            let i = i as usize;
            if g > cost[i] {
                continue;
            }
            let (x, y) = (self.x0 + i as i32 % self.w, self.y0 + i as i32 / self.w);
            if goal(x, y) {
                let mut path = vec![GridCoord { x, y }];
                let mut at = i;
                while at != start {
                    at = came[at] as usize;
                    path.push(GridCoord { x: self.x0 + at as i32 % self.w, y: self.y0 + at as i32 / self.w });
                }
                path.reverse();
                return Some(path);
            }
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
                let Some(j) = self.index(x + dx, y + dy) else { continue };
                let c = self.clearance[j];
                if c == 0 || (dx != 0 && dy != 0 && (self.clear(x + dx, y) == 0 || self.clear(x, y + dy) == 0)) {
                    continue;
                }
                let step = if dx != 0 && dy != 0 { DIAGONAL } else { STEP } + COAST.get(c as usize).copied().unwrap_or(0);
                let g = g + step;
                if g < cost[j] {
                    cost[j] = g;
                    came[j] = i as u32;
                    open.push(Reverse((g + toward(x + dx, y + dy), Reverse(g), j as u32)));
                }
            }
        }
        None
    }

    /// Does a polyline keep to the water all the way.
    pub fn afloat(&self, path: &[[f64; 2]]) -> bool {
        path.windows(2).all(|w| self.sight(w[0], w[1], 1))
    }

    /// Can a ship sail straight from `a` to `b` and keep `off` tiles of
    /// clearance all the way: every tile the line passes over, sampled
    /// finely enough not to miss a corner.
    fn sight(&self, a: [f64; 2], b: [f64; 2], off: u8) -> bool {
        let n = ((b[0] - a[0]).hypot(b[1] - a[1]) * 8.0).ceil().max(1.0) as usize;
        (0..=n).all(|k| {
            let t = k as f64 / n as f64;
            self.clear_at([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]) >= off
        })
    }

    /// The tiles pulled tight: from each corner, as far along as a line of
    /// sight reaches while it keeps as far off the land as the tiles it
    /// passes over did (up to `OFFING`), and a corner there.
    fn pull(&self, tiles: &[GridCoord]) -> Vec<[f64; 2]> {
        let centre = |t: GridCoord| [t.x as f64 + 0.5, t.y as f64 + 0.5];
        let mut out = vec![centre(tiles[0])];
        let mut from = 0;
        let mut j = 1;
        while j < tiles.len() {
            let off = tiles[from..=j].iter().map(|t| self.clear(t.x, t.y)).min().unwrap().min(OFFING);
            if j > from + 1 && !self.sight(centre(tiles[from]), centre(tiles[j]), off) {
                from = j - 1;
                out.push(centre(tiles[from]));
            } else {
                j += 1;
            }
        }
        out.push(centre(*tiles.last().unwrap()));
        out
    }

    /// A polyline's corners rounded: each an arc of `ROUNDING` tiles'
    /// radius where the legs either side have room and the arc stays on
    /// the water, tighter where not; a corner no arc of `TURN` fits stays
    /// sharp, and `turns_within` finds it.
    fn round(&self, p: &[[f64; 2]]) -> Vec<[f64; 2]> {
        let mut out = vec![p[0]];
        for i in 1..p.len().saturating_sub(1) {
            let (a, b, c) = (p[i - 1], p[i], p[i + 1]);
            let (l1, l2) = ((b[0] - a[0]).hypot(b[1] - a[1]), (c[0] - b[0]).hypot(c[1] - b[1]));
            let (u1, u2) = ([(b[0] - a[0]) / l1, (b[1] - a[1]) / l1], [(c[0] - b[0]) / l2, (c[1] - b[1]) / l2]);
            let turn = (u1[0] * u2[1] - u1[1] * u2[0]).atan2(u1[0] * u2[0] + u1[1] * u2[1]);
            let arc = |r: f64| -> Vec<[f64; 2]> {
                let t = r * (turn.abs() / 2.0).tan();
                let start = [b[0] - u1[0] * t, b[1] - u1[1] * t];
                // The centre is off to the side the ship turns to.
                let side = turn.signum();
                let centre = [start[0] - u1[1] * r * side, start[1] + u1[0] * r * side];
                let a0 = (start[1] - centre[1]).atan2(start[0] - centre[0]);
                let n = (turn.abs() / 0.15).ceil().max(1.0) as usize;
                (0..=n).map(|k| {
                    let a = a0 + turn * k as f64 / n as f64;
                    [centre[0] + r * a.cos(), centre[1] + r * a.sin()]
                }).collect()
            };
            // The most each leg can give: half, so the next corner has the
            // other half; all of the run out of a berth or into one.
            let (g1, g2) = (if i == 1 { l1 } else { l1 / 2.0 }, if i + 2 == p.len() { l2 } else { l2 / 2.0 });
            let room = g1.min(g2) / (turn.abs() / 2.0).tan();
            let mut r = ROUNDING.min(room);
            let fits = |pts: &[[f64; 2]]| pts.windows(2).all(|w| self.sight(w[0], w[1], 1));
            loop {
                if turn.abs() < 1e-3 || r < TURN / 2.0 {
                    out.push(b);
                    break;
                }
                let pts = arc(r);
                if fits(&pts) && self.sight(*out.last().unwrap(), pts[0], 1) {
                    out.extend(pts);
                    break;
                }
                r /= 2.0;
            }
        }
        out.push(*p.last().unwrap());
        out.dedup_by(|a, b| (a[0] - b[0]).hypot(a[1] - b[1]) < 1e-6);
        out
    }

    /// The way from a berth to a berth, or to the map's edge: out from the
    /// berth straight along its line, the cheapest way over the water,
    /// pulled tight and its corners rounded, and straight in to the other
    /// berth along its line, or on to the edge itself. Points in tiles,
    /// from the ferry's middle at the first berth. None where the water
    /// does not join.
    pub fn route(&self, from: &Berth, to: End) -> Option<Vec<[f64; 2]>> {
        let start = from.tile(BERTH - 1);
        let (x1, y1) = (self.x0 + self.w - 1, self.y0 + self.h - 1);
        let tiles = match to {
            End::Berth(b) => {
                let goal = b.tile(BERTH - 1);
                self.search(start, |x, y| x == goal.x && y == goal.y, |x, y| {
                    let (dx, dy) = ((x - goal.x).unsigned_abs(), (y - goal.y).unsigned_abs());
                    STEP * dx.max(dy) + (DIAGONAL - STEP) * dx.min(dy)
                })?
            }
            End::Edge => self.search(start, |x, y| x == self.x0 || y == self.y0 || x == x1 || y == y1, |x, y| STEP * (x - self.x0).min(x1 - x).min(y - self.y0).min(y1 - y) as u32)?,
        };
        let mut corners = vec![from.moored().at];
        corners.extend(self.pull(&tiles));
        match to {
            End::Berth(b) => corners.push(b.moored().at),
            End::Edge => {
                // On out over the edge, the way the edge lies.
                let last = *tiles.last().unwrap();
                let (cx, cy) = (last.x as f64 + 0.5, last.y as f64 + 0.5);
                let over = if last.x == self.x0 { [self.x0 as f64, cy] } else if last.x == x1 { [x1 as f64 + 1.0, cy] } else if last.y == self.y0 { [cx, self.y0 as f64] } else { [cx, y1 as f64 + 1.0] };
                corners.push(over);
            }
        }
        corners.dedup_by(|a, b| (a[0] - b[0]).hypot(a[1] - b[1]) < 1e-9);
        Some(self.round(&corners))
    }

    /// The runs of a way through narrow water, as distances along it: a
    /// block, held by ships going one way at a time. The berths' own
    /// approaches, which only their ship uses, are not.
    pub fn narrows(&self, route: &[[f64; 2]]) -> Vec<(f64, f64)> {
        let len = super::length(route);
        let mut out: Vec<(f64, f64)> = Vec::new();
        let mut d = BERTH as f64;
        while d < len - BERTH as f64 {
            if self.clear_at(super::point_at(route, d).0) <= NARROW {
                match out.last_mut() {
                    Some(run) if d - run.1 <= 0.5 => run.1 = d,
                    _ => out.push((d, d)),
                }
            }
            d += 0.25;
        }
        out.retain(|r| r.1 - r.0 >= 1.0);
        out
    }
}

/// The tightest turn along a way at sea, as a radius in tiles: at each
/// point, the legs either side over the angle between them. Within
/// `BERTH` tiles of a berth the ferry turns on its thrusters, at a crawl,
/// and is not counted.
pub fn tightest(way: &[[f64; 2]]) -> f64 {
    let len = super::length(way);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A map from rows of text: `~` sea, anything else land.
    pub fn water(rows: &[&str]) -> Water {
        let h = rows.len() as i32;
        let w = rows[0].len() as i32;
        Water::new(0, 0, w, h, |x, y| rows[y as usize].as_bytes()[x as usize] == b'~')
    }

    #[test]
    fn clearance_is_the_steps_to_land() {
        let w = water(&["......", "~~~~~~", "~~~~~~", "~~~~~~", "~~~~~~"]);
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
        let w = water(&rows);
        let from = Berth { quay: GridCoord { x: 5, y: 3 }, out: (0, 1) };
        let to = Berth { quay: GridCoord { x: 34, y: 3 }, out: (0, 1) };
        for end in [End::Berth(to), End::Edge] {
            let way = w.route(&from, end).expect("a way");
            assert!(w.afloat(&way), "it crossed land: {way:?}");
            assert!(tightest(&way) >= TURN, "it turned in {:.2} tiles", tightest(&way));
            assert_eq!(way[0], from.moored().at);
        }
        let edge = w.route(&from, End::Edge).unwrap();
        let last = edge.last().unwrap();
        assert!(last[0] == 0.0 || last[1] == rows.len() as f64 || last[0] == 40.0, "it ended at {last:?}");
    }

    #[test]
    fn a_strait_is_narrow() {
        let mut rows = vec!["....................."; 3];
        for _ in 0..8 {
            rows.push("~~~~~~~~~~~~~~~~~~~~~");
        }
        for _ in 0..6 {
            rows.push("..........~..........");
        }
        for _ in 0..8 {
            rows.push("~~~~~~~~~~~~~~~~~~~~~");
        }
        rows.push(".....................");
        let w = water(&rows);
        let a = Berth { quay: GridCoord { x: 10, y: 3 }, out: (0, 1) };
        let b = Berth { quay: GridCoord { x: 10, y: 24 }, out: (0, -1) };
        let way = w.route(&a, End::Berth(b)).expect("through the strait");
        let narrows = w.narrows(&way);
        assert_eq!(narrows.len(), 1, "{narrows:?}");
        assert!(narrows[0].1 - narrows[0].0 >= 5.0, "{narrows:?}");
    }

    /// On seeds 0 to 19, from the home island's harbour site nearest the
    /// origin, a way to the map's edge and to every other island: none
    /// crosses land or turns tighter than the class limit, and each is
    /// found within the budget, 50 ms. Twenty maps take a while, so this
    /// runs with `every_seed` on request.
    #[test]
    #[ignore]
    fn every_seed_has_ways_over_the_sea() {
        let mut wrong = Vec::new();
        let mut times = Vec::new();
        for seed in 0..20 {
            let started = std::time::Instant::now();
            let water = Water::of(&crate::terrain::generate(seed));
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
                let started = std::time::Instant::now();
                let way = water.route(&home.0, end);
                let ms = started.elapsed().as_secs_f64() * 1000.0;
                times.push(ms);
                let Some(way) = way else {
                    wrong.push(format!("seed {seed}: no way to {name}"));
                    continue;
                };
                let (len, tight) = (crate::shipping::length(&way), tightest(&way));
                line += &format!(" {name} {len:.0} tiles {:.1} h {ms:.0} ms;", crate::shipping::sail_ms(len, [true, end != End::Edge]) as f64 / crate::shipping::HOUR as f64);
                if !water.afloat(&way) {
                    wrong.push(format!("seed {seed}: the way to {name} crosses land"));
                }
                if tight < TURN {
                    wrong.push(format!("seed {seed}: the way to {name} turns in {tight:.2} tiles"));
                }
                if ms > 50.0 {
                    wrong.push(format!("seed {seed}: the way to {name} took {ms:.0} ms"));
                }
            }
            eprintln!("{line}");
        }
        times.sort_by(f64::total_cmp);
        eprintln!("{} ways: median {:.1} ms, p90 {:.1} ms, worst {:.1} ms", times.len(), times[times.len() / 2], times[times.len() * 9 / 10], times[times.len() - 1]);
        assert!(wrong.is_empty(), "{wrong:#?}");
    }
}
