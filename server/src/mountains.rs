//! The mountains' heights, eroded. Each range on its own: the map's own
//! height there (`terrain::Ground`), stretched, raised towards the range's
//! spine and kept at the ground at its foot, at `SAMPLES` points to a
//! tile's side; then rained on, drop by drop, each drop running downhill,
//! cutting where it is quick and leaving its load where it slows, so the
//! range wears into valleys that drain to its own edges, and ridges
//! between them. Done once, the first time it is asked for, from the
//! terrain alone, and sent to the client a chunk at a time
//! (`TerrainChunk::heights`).

use std::collections::{HashMap, HashSet};

use crate::protocol::{ChunkCoord, TerrainType, CHUNK_SIZE};
use crate::terrain::Ground;

/// Points to a tile's side.
pub const SAMPLES: i32 = 8;
/// A height on the wire is this many to a tile.
pub const UNIT: f32 = 1024.0;
/// A chunk's heights reach a tile past it on every side, so its edge can
/// be lit as the next chunk's is.
pub const APRON: i32 = 1;
/// Points to a chunk's heights' side.
pub const SIDE: i32 = (CHUNK_SIZE + APRON * 2) * SAMPLES + 1;

/// How high a range stands at its heart, in tiles, before it is worn; how
/// far in, in tiles, its first climb out of the ground has come most of
/// the way, and how far in it goes on rising, slowly, to its heart, so a
/// range drains outwards from its middle, never into it; how much of its
/// height is each; how much the map's height raises or lowers it there;
/// and how much fine detail the rain finds to start on.
const PEAK: f32 = 8.0;
const SPINE: f32 = 2.0;
const HEART: f32 = 10.0;
const CLIMB: f32 = 0.55;
const STRETCH: f32 = 0.8;
const DETAIL: f32 = 0.06;
/// How far in from the edge, in tiles, the foot is kept at the ground.
const FOOT: f32 = 0.4;

/// The rain: drops a point; how long a drop runs; how much it keeps going
/// its way; how much it can carry, at least; how readily it cuts and drops
/// its load; how fast it dries; how hard it falls; and how wide, in
/// points, it cuts.
const DROPS: f32 = 0.3;
const STEPS: usize = 48;
const INERTIA: f32 = 0.05;
const CAPACITY: f32 = 4.0;
const LEAST: f32 = 0.01;
const ERODE: f32 = 0.3;
const DEPOSIT: f32 = 0.3;
const DRY: f32 = 0.02;
const GRAVITY: f32 = 4.0;
const BRUSH: i32 = 4;
/// How many times the worn land is softened after, a point at a time with
/// those round it, so the finest grooves go and the valleys stay.
const SOFTEN: usize = 2;

/// Every mountain chunk's heights, `SIDE` by `SIDE`, a row of x at a time
/// from a tile short of its corner, in `UNIT`s.
#[derive(Default)]
pub struct Peaks {
    chunks: HashMap<ChunkCoord, Vec<u16>>,
}

impl Peaks {
    /// The heights of a chunk; none off the mountains.
    pub fn chunk(&self, c: ChunkCoord) -> Vec<u16> {
        self.chunks.get(&c).cloned().unwrap_or_default()
    }

    /// The map's mountains, raised and worn, range by range.
    pub fn new(terrain: &HashMap<(i32, i32), TerrainType>, seed: u32) -> Self {
        let ground = Ground::new(seed);
        let mut peaks = Peaks::default();
        let rock = |x: i32, y: i32| terrain.get(&(x, y)) == Some(&TerrainType::Mountain);
        let mut seen: HashSet<(i32, i32)> = HashSet::new();
        let mut tiles: Vec<(i32, i32)> = terrain.iter().filter(|(_, t)| **t == TerrainType::Mountain).map(|(&p, _)| p).collect();
        tiles.sort();
        let mut ranges: Vec<Vec<(i32, i32)>> = Vec::new();
        for start in tiles {
            if !seen.insert(start) {
                continue;
            }
            // The range: every tile of rock touching it, across corners too.
            let mut range = vec![start];
            let mut k = 0;
            while k < range.len() {
                let (x, y) = range[k];
                k += 1;
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        let n = (x + dx, y + dy);
                        if rock(n.0, n.1) && seen.insert(n) {
                            range.push(n);
                        }
                    }
                }
            }
            ranges.push(range);
        }
        // The ranges worn side by side, the biggest first, a thread a core.
        ranges.sort_by_key(|r| std::cmp::Reverse(r.len()));
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
        let next = std::sync::atomic::AtomicUsize::new(0);
        let worn: Vec<Peaks> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..threads)
                .map(|_| {
                    scope.spawn(|| {
                        let mut mine = Peaks::default();
                        loop {
                            let k = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            let Some(range) = ranges.get(k) else { break };
                            mine.raise(range, &rock, &ground);
                        }
                        mine
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().expect("a range worn")).collect()
        });
        for part in worn {
            for (c, grid) in part.chunks {
                match peaks.chunks.get_mut(&c) {
                    Some(have) => have.iter_mut().zip(grid).for_each(|(a, b)| *a = (*a).max(b)),
                    None => {
                        peaks.chunks.insert(c, grid);
                    }
                }
            }
        }
        peaks
    }

    /// One range raised, worn and laid into its chunks.
    fn raise(&mut self, range: &[(i32, i32)], rock: &impl Fn(i32, i32) -> bool, ground: &Ground) {
        let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        for &(x, y) in range {
            (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
        }
        // A tile of ground round it.
        let (x0, y0, x1, y1) = (x0 - 1, y0 - 1, x1 + 2, y1 + 2);
        let (tw, th) = (x1 - x0, y1 - y0);

        // How far into the range each tile's middle is: a sweep, forward
        // and back.
        let mut depth: Vec<f32> = (0..tw * th).map(|k| if rock(x0 + k % tw, y0 + k / tw) { f32::MAX } else { 0.0 }).collect();
        let diagonal = std::f32::consts::SQRT_2;
        for back in [false, true] {
            for i in 0..tw * th {
                let k = if back { tw * th - 1 - i } else { i };
                let (x, y) = (k % tw, k / tw);
                for (dx, dy, cost) in [(-1, 0, 1.0), (0, -1, 1.0), (-1, -1, diagonal), (1, -1, diagonal)] {
                    let (nx, ny) = if back { (x - dx, y - dy) } else { (x + dx, y + dy) };
                    let through = if nx < 0 || ny < 0 || nx >= tw || ny >= th { cost } else { depth[(ny * tw + nx) as usize] + cost };
                    if through < depth[k as usize] {
                        depth[k as usize] = through;
                    }
                }
            }
        }
        // At a point: the four by four tiles' middles round it, blended by a
        // smooth curve (a cubic B-spline), so the foot rounds past the tiles
        // instead of stepping with them; from the edge.
        let spline = |t: f32| [(1.0 - t).powi(3) / 6.0, (3.0 * t.powi(3) - 6.0 * t * t + 4.0) / 6.0, (-3.0 * t.powi(3) + 3.0 * t * t + 3.0 * t + 1.0) / 6.0, t.powi(3) / 6.0];
        let depth_at = |px: f32, py: f32| {
            let (u, v) = (px - x0 as f32 - 0.5, py - y0 as f32 - 0.5);
            let (tx, ty) = (u.floor() as i32, v.floor() as i32);
            let (wx, wy) = (spline(u - tx as f32), spline(v - ty as f32));
            let d = |x: i32, y: i32| if x < 0 || y < 0 || x >= tw || y >= th { 0.0 } else { depth[(y * tw + x) as usize] };
            let mut sum = 0.0;
            for j in 0..4 {
                for i in 0..4 {
                    sum += wx[i] * wy[j] * d(tx - 1 + i as i32, ty - 1 + j as i32);
                }
            }
            (sum - 0.5).max(0.0)
        };

        // The heights before the rain, normalised to the spine.
        let (w, h) = (tw * SAMPLES + 1, th * SAMPLES + 1);
        let at = |i: i32, j: i32| (x0 as f32 + i as f32 / SAMPLES as f32, y0 as f32 + j as f32 / SAMPLES as f32);
        let mut land: Vec<f32> = (0..w * h)
            .map(|k| {
                let (px, py) = at(k % w, k / w);
                let d = depth_at(px, py);
                let rise = CLIMB * (1.0 - (-d / SPINE).exp()) + (1.0 - CLIMB) * (d / HEART).min(1.0);
                let lift = (0.8 + STRETCH * (ground.height(px as f64, py as f64) as f32 - 0.6)).clamp(0.55, 1.1);
                rise * (lift + DETAIL * ground.fine(px as f64, py as f64) as f32)
            })
            .collect();

        erode(&mut land, w, h, (x0, y0));
        for _ in 0..SOFTEN {
            soften(&mut land, w, h);
        }

        // Kept at the ground at the foot, and laid into the chunks.
        let chunk_of = |v: i32| v.div_euclid(CHUNK_SIZE);
        for cy in chunk_of(y0 - APRON)..=chunk_of(y1 + APRON) {
            for cx in chunk_of(x0 - APRON)..=chunk_of(x1 + APRON) {
                let grid = self.chunks.entry(ChunkCoord { cx, cy }).or_insert_with(|| vec![0; (SIDE * SIDE) as usize]);
                let (gx, gy) = ((cx * CHUNK_SIZE - APRON - x0) * SAMPLES, (cy * CHUNK_SIZE - APRON - y0) * SAMPLES);
                for j in 0..SIDE {
                    for i in 0..SIDE {
                        let (li, lj) = (gx + i, gy + j);
                        if li < 0 || lj < 0 || li >= w || lj >= h {
                            continue;
                        }
                        let (px, py) = at(li, lj);
                        let foot = (depth_at(px, py) / FOOT).min(1.0);
                        let tiles = (land[(lj * w + li) as usize].max(0.0) * foot * PEAK * UNIT).round().min(u16::MAX as f32) as u16;
                        let cell = &mut grid[(j * SIDE + i) as usize];
                        *cell = (*cell).max(tiles);
                    }
                }
            }
        }
        self.chunks.retain(|_, g| g.iter().any(|&v| v > 0));
    }
}

/// A height field softened once: each point a blend of itself and the
/// eight round it, itself the most.
fn soften(land: &mut [f32], w: i32, h: i32) {
    let was = land.to_vec();
    for y in 0..h {
        for x in 0..w {
            let (mut sum, mut weight) = (0.0, 0.0);
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let (nx, ny) = (x + dx, y + dy);
                    if nx < 0 || ny < 0 || nx >= w || ny >= h {
                        continue;
                    }
                    let wt = if dx == 0 && dy == 0 { 4.0 } else if dx == 0 || dy == 0 { 2.0 } else { 1.0 };
                    sum += was[(ny * w + nx) as usize] * wt;
                    weight += wt;
                }
            }
            land[(y * w + x) as usize] = sum / weight;
        }
    }
}

/// The rain on a height field `w` by `h`, drop by drop, each starting
/// somewhere on the range and running downhill, cutting and leaving its
/// load as it goes. The same every time for the same range.
fn erode(land: &mut [f32], w: i32, h: i32, salt: (i32, i32)) {
    let mut seed = (salt.0 as u32).wrapping_mul(0x9e3779b1) ^ (salt.1 as u32).wrapping_mul(0x85ebca77) | 1;
    let mut rand = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed as f32 / u32::MAX as f32
    };
    // The cut, spread over the points within BRUSH, nearer more.
    let brush: Vec<(i32, i32, f32)> = {
        let mut b = Vec::new();
        for dy in -BRUSH..=BRUSH {
            for dx in -BRUSH..=BRUSH {
                let d = ((dx * dx + dy * dy) as f32).sqrt();
                if d <= BRUSH as f32 {
                    b.push((dx, dy, 1.0 - d / (BRUSH as f32 + 1.0)));
                }
            }
        }
        let sum: f32 = b.iter().map(|b| b.2).sum();
        b.into_iter().map(|(x, y, wt)| (x, y, wt / sum)).collect()
    };
    let get = |land: &[f32], x: i32, y: i32| land[(y.clamp(0, h - 1) * w + x.clamp(0, w - 1)) as usize];
    // The height at a point between points, and its slope.
    let sample = |land: &[f32], px: f32, py: f32| {
        let (ix, iy) = (px.floor() as i32, py.floor() as i32);
        let (fx, fy) = (px - ix as f32, py - iy as f32);
        let (a, b, c, d) = (get(land, ix, iy), get(land, ix + 1, iy), get(land, ix, iy + 1), get(land, ix + 1, iy + 1));
        let height = a * (1.0 - fx) * (1.0 - fy) + b * fx * (1.0 - fy) + c * (1.0 - fx) * fy + d * fx * fy;
        let slope = ((b - a) * (1.0 - fy) + (d - c) * fy, (c - a) * (1.0 - fx) + (d - b) * fx);
        (height, slope)
    };
    let drops = (w as f32 * h as f32 * DROPS) as usize;
    for _ in 0..drops {
        let (mut px, mut py) = (rand() * (w - 1) as f32, rand() * (h - 1) as f32);
        // Only on the range, not the ground round it.
        if sample(land, px, py).0 <= 0.0 {
            continue;
        }
        let (mut dx, mut dy) = (0.0f32, 0.0f32);
        let (mut speed, mut water, mut load) = (1.0f32, 1.0f32, 0.0f32);
        for _ in 0..STEPS {
            let (ix, iy) = (px.floor() as i32, py.floor() as i32);
            let (fx, fy) = (px - ix as f32, py - iy as f32);
            let (height, (gx, gy)) = sample(land, px, py);
            dx = dx * INERTIA - gx * (1.0 - INERTIA);
            dy = dy * INERTIA - gy * (1.0 - INERTIA);
            let len = (dx * dx + dy * dy).sqrt();
            if len < 1e-6 {
                break;
            }
            (dx, dy) = (dx / len, dy / len);
            px += dx;
            py += dy;
            if px < 0.0 || py < 0.0 || px >= (w - 1) as f32 || py >= (h - 1) as f32 {
                break;
            }
            let drop = sample(land, px, py).0 - height;
            let capacity = (-drop * speed * water * CAPACITY).max(LEAST);
            if load > capacity || drop > 0.0 {
                // Left where it slowed, or to fill the dip it ran into.
                let left = if drop > 0.0 { drop.min(load) } else { (load - capacity) * DEPOSIT };
                load -= left;
                for (cx, cy, share) in [(ix, iy, (1.0 - fx) * (1.0 - fy)), (ix + 1, iy, fx * (1.0 - fy)), (ix, iy + 1, (1.0 - fx) * fy), (ix + 1, iy + 1, fx * fy)] {
                    land[(cy * w + cx) as usize] += left * share;
                }
            } else {
                // Cut where it is quick, no deeper than it fell.
                let cut = ((capacity - load) * ERODE).min(-drop);
                for &(bx, by, share) in &brush {
                    let (cx, cy) = (ix + bx, iy + by);
                    if cx < 0 || cy < 0 || cx >= w || cy >= h {
                        continue;
                    }
                    let k = (cy * w + cx) as usize;
                    let taken = (cut * share).min(land[k]);
                    land[k] -= taken;
                    load += taken;
                }
            }
            // Quicker for falling, slower for climbing.
            speed = (speed * speed - drop * GRAVITY).max(0.0).sqrt();
            water *= 1.0 - DRY;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A block of rock rises in its middle and is at the ground off it.
    #[test]
    fn a_range_rises_in_its_middle() {
        let mut terrain = HashMap::new();
        for y in -12i32..12 {
            for x in -12i32..12 {
                terrain.insert((x, y), if x.abs() < 8 && y.abs() < 8 { TerrainType::Mountain } else { TerrainType::Grass });
            }
        }
        let peaks = Peaks::new(&terrain, 7);
        let grid = peaks.chunk(ChunkCoord { cx: -1, cy: -1 });
        assert_eq!(grid.len(), (SIDE * SIDE) as usize);
        // A tile short of the chunk's corner (32, 32) at -1, -1 is (-33, -33):
        // the point at map (x, y) is ((x + 33) * SAMPLES, (y + 33) * SAMPLES).
        let at = |x: f32, y: f32| grid[(((y + 33.0) * SAMPLES as f32) as i32 * SIDE + ((x + 33.0) * SAMPLES as f32) as i32) as usize] as f32 / UNIT;
        assert!(at(-3.0, -3.0) > 1.0, "high inside: {}", at(-3.0, -3.0));
        assert_eq!(at(-10.0, -10.0), 0.0, "ground outside");
        assert_eq!(at(-8.0, -3.0), 0.0, "ground at the foot");
    }

    /// How long a real map's mountains take, and how high they stand.
    #[test]
    #[ignore]
    fn how_long() {
        let terrain = crate::terrain::generate(7);
        let rock = terrain.values().filter(|t| **t == TerrainType::Mountain).count();
        let started = std::time::Instant::now();
        let peaks = Peaks::new(&terrain, 7);
        let highest = peaks.chunks.values().flat_map(|g| g.iter()).max().copied().unwrap_or(0) as f32 / UNIT;
        println!("{rock} tiles of rock, {} chunks, highest {highest:.2} tiles, in {:?}", peaks.chunks.len(), started.elapsed());
    }
}
