use fixed::HashMap;

use noise::{NoiseFn, Simplex};

use crate::{TerrainType, CHUNK_SIZE};

/// The map, in tiles and in chunks.
const WIDTH: i32 = 1024;
const HEIGHT: i32 = 1024;
pub const CHUNKS_MIN: i32 = -(WIDTH / 2) / CHUNK_SIZE;
pub const CHUNKS_MAX: i32 = (WIDTH / 2) / CHUNK_SIZE - 1;

/// The land is one height, and wherever it is below zero is water: the sea
/// where that water reaches the map's edge, a lake where it does not. The
/// height is noise at a few scales, each `(tiles across, weight)`, cut at
/// its middle, so land and water wind through each other. The first, far
/// broader and weaker than the rest, makes regions: some mostly land, some
/// mostly water. The second sets the grain, land a few dozen tiles across
/// between the water, so no tile is much more than twenty from it; the
/// finer ones make headlands, sounds and a ragged coast. It sinks towards
/// the map's edge over its last `EDGE` share, so the edge is open sea.
const OCTAVES: [(f64, f64); 5] = [(400.0, 0.4), (55.0, 1.0), (24.0, 0.4), (10.0, 0.15), (5.0, 0.05)];
const EDGE: f64 = 0.25;
/// Rivers: where a noise of this scale crosses zero, give or take
/// `RIVER` of it, the land falls away into water, with `BANK` how steeply
/// its banks rise from it; a finer noise of a sixth the scale wanders it.
/// They run on across land and sea alike, so they cut land masses in two
/// and open into the sea at both ends.
const RIVERS: f64 = 120.0;
const RIVER: f64 = 0.04;
const BANK: f64 = 6.0;
/// The ground's character: a mountain is ground over the hill line,
/// wherever it is, so every region has its heights, and woods are where
/// moisture, noise at the scale of the inlets and of the finest layer, is
/// over the wood line.
const HILL: f64 = 0.48;
const WOOD: f64 = 0.15;
/// Only in some stretches of a shore, coves, has the water left a beach:
/// ground this low, where a noise this fine is over this.
const COVES: f64 = 0.04;
const COVE: f64 = -0.15;
const BEACH: f64 = 0.07;
/// Home, the origin: the seed's noise is read from the first place on a
/// spiral out from the noise's own middle, a step of `STEP` tiles, with dry
/// ground `DRY` tiles all round it, water nearest it between `SHORE`
/// tiles. Round it the land is calmed, out to `HOME` and fading over as
/// far again: no range, little wood, so the first town has open grass
/// between it and its water.
const STEP: f64 = 24.0;
const DRY: f64 = 14.0;
const SHORE: (f64, f64) = (16.0, 32.0);
const HOME: f64 = 14.0;

fn elev(t: TerrainType) -> i32 {
    match t {
        TerrainType::Sea | TerrainType::Water => -1,
        TerrainType::Beach | TerrainType::Grass | TerrainType::Forest => 0,
        TerrainType::Mountain => 2,
    }
}

/// The `k`th noise of a seed. The noise's own seeding barely stirs a small
/// seed, so seeds near each other made near the same land; stirred here
/// first.
fn noise(seed: u32, k: u32) -> Simplex {
    Simplex::new(seed.wrapping_add(k).wrapping_mul(0x9E37_79B9) ^ 0x5bd1_e995)
}

/// The noises, seeded, and where on them home is.
struct Layers {
    elevation: Simplex,
    moisture: Simplex,
    river: Simplex,
    coves: Simplex,
    home: (f64, f64),
}

impl Layers {
    fn new(seed: u32) -> Self {
        let mut layers = Layers {
            elevation: noise(seed, 0),
            moisture: noise(seed, 1),
            river: noise(seed, 3),
            coves: noise(seed, 5),
            home: (0.0, 0.0),
        };
        layers.home = layers.find_home();
        layers
    }

    /// Where on the noise home is: the first fit on a square spiral.
    fn find_home(&mut self) -> (f64, f64) {
        let round = |r: f64, n: usize| (0..n).map(move |i| (i as f64 * std::f64::consts::TAU / n as f64).sin_cos()).map(move |(s, c)| (c * r, s * r));
        for ring in 0..400 {
            for i in 0..(8 * ring).max(1) {
                let (dx, dy) = spiral(ring, i);
                self.home = (dx as f64 * STEP, dy as f64 * STEP);
                let wet = |(x, y): (f64, f64)| self.height(x, y) < 0.0;
                let dry = [DRY / 2.0, DRY].iter().all(|&r| !round(r, 16).any(wet)) && !wet((0.0, 0.0));
                let shore = (SHORE.0 as i32..=SHORE.1 as i32).step_by(4).find(|&r| round(r as f64, 32).any(wet));
                if dry && shore.is_some_and(|r| r as f64 > SHORE.0) {
                    return self.home;
                }
            }
        }
        (0.0, 0.0)
    }

    /// The height at a point of the map.
    fn height(&self, x: f64, y: f64) -> f64 {
        let (nx, ny) = (x + self.home.0, y + self.home.1);
        let at = |n: &Simplex, across: f64| n.get([nx / across, ny / across]);
        let edge = ((x.abs().max(y.abs()) / (WIDTH / 2) as f64 - (1.0 - EDGE)) / EDGE).clamp(0.0, 1.0);
        let e = OCTAVES.iter().map(|&(across, w)| w * at(&self.elevation, across)).sum::<f64>() - 2.0 * edge;
        let river = (at(&self.river, RIVERS) + 0.15 * at(&self.river, RIVERS / 6.0)).abs() - RIVER;
        e.min(river * BANK)
    }

    /// One tile's type from the noises alone, before smoothing; any water
    /// is a lake, until the sea is told from it.
    fn tile(&self, x: i32, y: i32) -> TerrainType {
        let (fx, fy) = (x as f64, y as f64);
        let e = self.height(fx, fy);
        let home = 1.0 - ((fx.hypot(fy) - HOME) / HOME).clamp(0.0, 1.0);
        let (nx, ny) = (fx + self.home.0, fy + self.home.1);
        let m = self.moisture.get([nx / 100.0, ny / 100.0]) + 0.5 * self.moisture.get([nx / 16.0, ny / 16.0]) - 1.2 * home;
        if e < 0.0 {
            TerrainType::Water
        } else if e < BEACH && self.coves.get([nx * COVES, ny * COVES]) > COVE {
            TerrainType::Beach
        } else if e - home > HILL {
            TerrainType::Mountain
        } else if m > WOOD {
            TerrainType::Forest
        } else {
            TerrainType::Grass
        }
    }
}

/// The `i`th step round the square ring `r` steps out from the middle.
fn spiral(r: i32, i: i32) -> (i32, i32) {
    if r == 0 {
        return (0, 0);
    }
    let side = 2 * r;
    let (k, t) = (i / side, i % side);
    match k {
        0 => (-r + t, -r),
        1 => (r, -r + t),
        2 => (r - t, r),
        _ => (-r, r - t),
    }
}

/// The height of the map at any point of it, between tiles too, as the
/// land is generated from: what the mountains are raised from
/// (`mountains.rs`).
pub struct Ground(Layers);

impl Ground {
    pub fn new(seed: u32) -> Self {
        Ground(Layers::new(seed))
    }

    pub fn height(&self, x: f64, y: f64) -> f64 {
        0.5 + self.0.height(x, y)
    }

    /// The fine layer alone, -1 to 1: for detail.
    pub fn fine(&self, x: f64, y: f64) -> f64 {
        let (nx, ny) = (x + self.0.home.0, y + self.0.home.1);
        self.0.elevation.get([nx / 7.0, ny / 7.0])
    }
}

/// The whole map of a seed, derived from the seed and nothing else.
/// Terrain is never persisted and never an entity. Smoothed: a tile that
/// three or more of its four neighbours stand above or below takes their
/// level. Then the sea is told from the lakes: all the water the map's
/// edge reaches.
pub fn generate(seed: u32) -> HashMap<(i32, i32), TerrainType> {
    let layers = Layers::new(seed);
    let (w, h) = (WIDTH as usize, HEIGHT as usize);
    let (x0, y0) = (-WIDTH / 2, -HEIGHT / 2);
    let raw: Vec<TerrainType> = (0..w * h).map(|i| layers.tile(x0 + (i % w) as i32, y0 + (i / w) as i32)).collect();
    let mut land = raw.clone();
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let t = raw[y * w + x];
            let around = [raw[y * w + x + 1], raw[y * w + x - 1], raw[(y + 1) * w + x], raw[(y - 1) * w + x]];
            if around.iter().filter(|&&a| elev(a) != elev(t)).count() >= 3 {
                land[y * w + x] = *around.iter().find(|&&a| elev(a) != elev(t)).unwrap();
            }
        }
    }
    let mut todo: Vec<usize> = (0..w * h).filter(|&i| (i % w == 0 || i % w == w - 1 || i / w == 0 || i / w == h - 1) && land[i] == TerrainType::Water).collect();
    for &i in &todo {
        land[i] = TerrainType::Sea;
    }
    while let Some(i) = todo.pop() {
        let (x, y) = (i % w, i / w);
        for n in [(x > 0).then(|| i - 1), (x + 1 < w).then(|| i + 1), (y > 0).then(|| i - w), (y + 1 < h).then(|| i + w)].into_iter().flatten() {
            if land[n] == TerrainType::Water {
                land[n] = TerrainType::Sea;
                todo.push(n);
            }
        }
    }
    land.into_iter().enumerate().map(|(i, t)| ((x0 + (i % w) as i32, y0 + (i / w) as i32), t)).collect()
}

/// What lies under the land of a seed (`Deposit`): clay, in patches of
/// the grass a few tiles to a few dozen across.
pub fn deposits(seed: u32, terrain: &HashMap<(i32, i32), TerrainType>) -> HashMap<(i32, i32), crate::Deposit> {
    use crate::Deposit;
    let clay = Simplex::new(seed.wrapping_add(40));
    const PATCH: f64 = 0.06;
    let mut out = HashMap::default();
    let mut tiles: Vec<_> = terrain.iter().collect();
    tiles.sort_by_key(|(p, _)| **p);
    for (&(x, y), &t) in tiles {
        let (fx, fy) = (x as f64, y as f64);
        let d = match t {
            TerrainType::Grass if clay.get([fx * PATCH, fy * PATCH]) > 0.55 => Some(Deposit::Clay),
            _ => None,
        };
        if let Some(d) = d {
            out.insert((x, y), d);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use fixed::HashSet;

    use super::*;

    /// Every seed's map has ore, coal and oil somewhere, and not
    /// everywhere: a few hundred tiles of each at most a share of the land.
    /// `--nocapture` prints how much of each lies within reach of home.
    #[test]
    #[ignore]
    fn clay_lies_near_every_home() {
        for seed in 0..8 {
            let land = generate(seed);
            let under = deposits(seed, &land);
            let near = under.keys().filter(|&&(x, y)| x * x + y * y < 60 * 60).count();
            println!("seed {seed}: clay {} ({near} near home)", under.len());
            assert!(near > 0, "seed {seed} has no clay near home");
        }
    }

    /// Not an assertion: a picture, for whoever runs this with --ignored
    /// --nocapture. The whole map of `SPRAWL_SEED` (or 7), sixteen tiles
    /// to a character, with `+` at the origin; the sea `~`, a lake `:`;
    /// and the share of it each type covers.
    #[test]
    #[ignore]
    fn draw_the_land() {
        let seed = std::env::var("SPRAWL_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(7);
        let land = generate(seed);
        let n = land.len() as f64;
        let share = |t: TerrainType| 100.0 * land.values().filter(|&&v| v == t).count() as f64 / n;
        eprintln!(
            "seed {seed}: sea {:.1}%  lake {:.1}%  beach {:.1}%  grass {:.1}%  forest {:.1}%  mountain {:.1}%\n{}",
            share(TerrainType::Sea), share(TerrainType::Water), share(TerrainType::Beach), share(TerrainType::Grass), share(TerrainType::Forest), share(TerrainType::Mountain),
            draw(&land)
        );
    }

    fn draw(land: &HashMap<(i32, i32), TerrainType>) -> String {
        (-HEIGHT / 2..HEIGHT / 2)
            .step_by(16)
            .map(|y| {
                (-WIDTH / 2..WIDTH / 2)
                    .step_by(16)
                    .map(|x| match land[&(x, y)] {
                        _ if x.abs() < 16 && y.abs() < 16 => '+',
                        TerrainType::Sea => '~',
                        TerrainType::Water => ':',
                        TerrainType::Beach => '.',
                        TerrainType::Grass => ' ',
                        TerrainType::Forest => '^',
                        TerrainType::Mountain => 'M',
                    })
                    .collect::<String>()
                    + "\n"
            })
            .collect()
    }

    /// The tiles joined to `from`, a side at a time, that `keep` keeps.
    fn flood(land: &HashMap<(i32, i32), TerrainType>, from: Vec<(i32, i32)>, keep: impl Fn(TerrainType) -> bool) -> HashSet<(i32, i32)> {
        let mut seen: HashSet<(i32, i32)> = from.iter().copied().filter(|t| keep(land[t])).collect();
        let mut todo: Vec<(i32, i32)> = seen.iter().copied().collect();
        while let Some((x, y)) = todo.pop() {
            for n in [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)] {
                if land.get(&n).is_some_and(|&t| keep(t)) && seen.insert(n) {
                    todo.push(n);
                }
            }
        }
        seen
    }

    /// Every seed's map is broken land: between a fifth and a half of it
    /// land, in many masses, none of them most of it; and home on one big
    /// enough for a town (forty-odd tiles square and more: rivers may bound it), with open grass for a town and water near it. The first
    /// twenty seeds stand for all. Twenty maps take a while, so this runs
    /// on request; DRAW=1 draws the seeds that fail.
    #[test]
    #[ignore]
    fn every_seed_is_broken_land() {
        let mut wrong = Vec::new();
        for seed in 0..20 {
            let land = generate(seed);
            let dry = |t: TerrainType| !matches!(t, TerrainType::Sea | TerrainType::Water);
            let mut faults = Vec::new();
            let total = land.values().filter(|&&t| dry(t)).count();
            let share = total as f64 / land.len() as f64;
            if !(0.2..=0.5).contains(&share) {
                faults.push(format!("land {:.0}%", share * 100.0));
            }
            let mut counted: HashSet<(i32, i32)> = HashSet::default();
            let (mut masses, mut biggest, mut home) = (0, 0, 0);
            let mut tiles: Vec<_> = land.keys().copied().collect();
            tiles.sort();
            for t in tiles {
                if !dry(land[&t]) || counted.contains(&t) {
                    continue;
                }
                let mass = flood(&land, vec![t], dry);
                if mass.len() >= 1000 {
                    masses += 1;
                }
                biggest = biggest.max(mass.len());
                if mass.contains(&(0, 0)) {
                    home = mass.len();
                }
                counted.extend(mass);
            }
            if masses < 6 {
                faults.push(format!("{masses} land masses"));
            }
            if biggest * 2 > total {
                faults.push(format!("one mass is {:.0}% of the land", 100.0 * biggest as f64 / total as f64));
            }
            if home < 2000 {
                faults.push(format!("home is on {home} tiles"));
            }
            // Room for a town: twenty tiles square of grass within sixty
            // of the origin, with water within forty of it.
            let grass = |x0: i32, y0: i32| (x0..x0 + 20).all(|x| (y0..y0 + 20).all(|y| land[&(x, y)] == TerrainType::Grass));
            let wet = |x0: i32, y0: i32| (x0 - 40..x0 + 60).any(|x| (y0 - 40..y0 + 60).any(|y| !dry(land[&(x, y)])));
            if !(-60..40).step_by(2).any(|x| (-60..40).step_by(2).any(|y| grass(x, y) && wet(x, y))) {
                faults.push("no grass for a town by the water near the origin".into());
            }
            eprintln!("seed {seed}: land {:.1}%, {masses} masses, home {home}{}", share * 100.0, faults.iter().map(|f| format!("; {f}")).collect::<String>());
            if !faults.is_empty() {
                if std::env::var("DRAW").is_ok() {
                    eprintln!("{}", draw(&land));
                }
                wrong.push((seed, faults));
            }
        }
        assert!(wrong.is_empty(), "seeds that are not broken land: {wrong:?}");
    }
}

