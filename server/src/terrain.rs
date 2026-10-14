use std::collections::HashMap;
use std::f64::consts::{PI, TAU};

use noise::{NoiseFn, Simplex};
use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};

use crate::protocol::{ChunkCoord, TerrainType, CHUNK_SIZE};

/// The map, in tiles and in chunks.
const WIDTH: i32 = 1024;
const HEIGHT: i32 = 1024;
pub const CHUNKS_MIN: i32 = -(WIDTH / 2) / CHUNK_SIZE;
pub const CHUNKS_MAX: i32 = (WIDTH / 2) / CHUNK_SIZE - 1;
/// Islands in one ocean. A handful of them, each a centre and a radius
/// drawn from the seed: the first holds the origin, `HOME_IN` tiles in
/// from its coast; the rest share out the land that is left, unevenly,
/// scattered wherever they fit with open sea round each and between each
/// and the map's edge. An island's coast is its radius, varied by noise
/// read round its compass, so it closes on itself with headlands and
/// bays; the whole map is bent by two more noises, a broad one and a
/// fine one, before the islands are read from it, which makes the round
/// shapes ragged without tearing them. Inside a coast is land or a lake,
/// outside it the sea, so the sea is one, and every coast is on it.
///
/// Inland, three layers of noise make the land. A continental one, whose
/// features are about `1 / COARSE` tiles across, and a fine one that gives
/// the land its woods and hills. The third, larger than either, says how
/// rugged a region is: where it is high the fine layer has its say and
/// the heights are stretched, which makes ranges and lakes; where it is
/// low the land rolls and flattens into plains. The ground rises from the
/// coast over its first `SHELF_RISE` tiles, and no lake comes nearer the
/// sea than `BAND`. Each island has a character of its own, added to
/// those layers: most are grass with some wood, some are forest, some
/// mountain.
const COARSE: f64 = 0.012;
const FINE: f64 = 0.05;
const RUGGED: f64 = 0.006;
/// The bending, broad and fine: how far, in tiles, and at what frequency.
const WARP: (f64, f64) = (40.0, 0.005);
const WARP_FINE: (f64, f64) = (4.0, 0.03);
/// The coast round an island: how much of the radius it swings, at what
/// frequency along the coast, for the long swings and for the bays.
const SWING: (f64, f64) = (0.28, 0.012);
const BAYS: (f64, f64) = (0.1, 0.045);
/// How far past its radius an island's coast can reach, with the bending,
/// and how much open sea there is at least between two islands' reaches
/// and between one and the map's edge.
const REACH: f64 = 1.45;
const GAP: f64 = 36.0;
/// The share of the map that is land, roughly, and how many islands.
const LAND: (f64, f64) = (0.17, 0.23);
const ISLANDS: (u32, u32) = (4, 8);
/// The origin's island: its radius, and how far in from its coast the
/// origin lies.
const HOME_RADIUS: (f64, f64) = (110.0, 145.0);
const HOME_IN: f64 = 40.0;
const SHELF: f64 = 0.8;
const SHELF_RISE: f64 = 16.0;
const BAND: f64 = 5.0;
/// The fine layer's share of the height, from the flattest region to the
/// most rugged.
const DETAIL: (f64, f64) = (0.1, 0.9);
/// How much the heights are stretched, likewise.
const RELIEF: (f64, f64) = (0.35, 2.2);
/// A mountain is ground above the hill line, in a region whose continental
/// layer, stretched, is over the range line.
const HILL: f64 = 0.4;
const RANGE: f64 = 0.6;
/// The land stands on a cliff over the water; only in some stretches of
/// its shore, coves, has the sea left a beach at the cliff's foot: within
/// `BEACH` tiles of the coast, where a noise this fine is over this.
const COVES: f64 = 0.04;
const COVE: f64 = 0.05;
const BEACH: f64 = 3.0;
/// Round the origin the land is calmed, out to this far and fading over
/// as far again: no range, no lake, little wood, so the first town has
/// open grass between it and its coast.
const HOME: f64 = 48.0;

fn elev(t: TerrainType) -> i32 {
    match t {
        TerrainType::Sea | TerrainType::Water => -1,
        TerrainType::Beach | TerrainType::Grass | TerrainType::Forest => 0,
        TerrainType::Mountain => 2,
    }
}

/// One island: where, how big, and its character, added to the moisture,
/// to the layer the range line reads and to the ruggedness of its land.
struct Island {
    x: f64,
    y: f64,
    radius: f64,
    coast: Simplex,
    wood: f64,
    rock: f64,
    rough: f64,
}

impl Island {
    fn new(seed: u32, i: u32, radius: f64, rng: &mut SmallRng) -> Self {
        // Grass with some wood, mostly; now and then a forest, or a
        // mountain island. The first is grass.
        let (wood, rock, rough) = match if i == 0 { 0.0 } else { rng.random_range(0.0..1.0) } {
            r if r < 0.5 => (rng.random_range(-0.25..0.0), -0.4, 0.0),
            r if r < 0.7 => (rng.random_range(-0.1..0.1), 0.0, 0.15),
            r if r < 0.85 => (0.4, -0.3, 0.0),
            _ => (rng.random_range(-0.2..0.1), 0.4, 0.3),
        };
        Island { x: 0.0, y: 0.0, radius, coast: Simplex::new(seed.wrapping_add(16 + i)), wood, rock, rough }
    }

    /// How far out from the centre the coast lies at angle `a`.
    fn coast(&self, a: f64) -> f64 {
        let round = |(amount, frequency): (f64, f64), off: f64| {
            let k = self.radius * frequency;
            amount * self.coast.get([off + a.cos() * k, off + a.sin() * k])
        };
        self.radius * (1.0 + round(SWING, 0.0) + round(BAYS, 50.0)).max(0.4)
    }
}

/// The islands of a seed, the origin's first.
fn islands(seed: u32) -> Vec<Island> {
    let mut rng = SmallRng::seed_from_u64(seed as u64 ^ 0x1_51a_4d5);
    let count = rng.random_range(ISLANDS.0..=ISLANDS.1);
    let land = rng.random_range(LAND.0..LAND.1) * (WIDTH * HEIGHT) as f64;
    let mut home = Island::new(seed, 0, rng.random_range(HOME_RADIUS.0..HOME_RADIUS.1), &mut rng);
    let a = rng.random_range(0.0..TAU);
    let towards = home.coast(a) - HOME_IN;
    (home.x, home.y) = (-a.cos() * towards, -a.sin() * towards);
    let mut shares: Vec<f64> = (1..count).map(|_| rng.random_range(0.3..1.0f64).powi(2)).collect();
    shares.sort_by(|a, b| b.total_cmp(a));
    let rest = (land - PI * home.radius * home.radius) / shares.iter().sum::<f64>();
    let mut out = vec![home];
    let half = (WIDTH / 2) as f64;
    for (i, share) in shares.into_iter().enumerate() {
        let mut island = Island::new(seed, i as u32 + 1, (rest * share / PI).sqrt(), &mut rng);
        // Wherever it fits, smaller each time it does not.
        'fit: while island.radius > 30.0 {
            let room = half - island.radius * REACH - GAP;
            for _ in 0..if room > 0.0 { 100 } else { 0 } {
                (island.x, island.y) = (rng.random_range(-room..room), rng.random_range(-room..room));
                if out.iter().all(|o: &Island| (o.x - island.x).hypot(o.y - island.y) > (o.radius + island.radius) * REACH + GAP) {
                    out.push(island);
                    break 'fit;
                }
            }
            island.radius *= 0.9;
        }
    }
    out
}

/// The layers, seeded, and the islands.
struct Layers {
    elevation: Simplex,
    moisture: Simplex,
    rugged: Simplex,
    bend: [Simplex; 2],
    coves: Simplex,
    islands: Vec<Island>,
}

impl Layers {
    fn new(seed: u32) -> Self {
        Layers {
            elevation: Simplex::new(seed),
            moisture: Simplex::new(seed.wrapping_add(1)),
            rugged: Simplex::new(seed.wrapping_add(2)),
            bend: [Simplex::new(seed.wrapping_add(3)), Simplex::new(seed.wrapping_add(4))],
            coves: Simplex::new(seed.wrapping_add(5)),
            islands: islands(seed),
        }
    }

    /// The island a point is on, or nearest, and how many tiles in from
    /// its coast the point is: below zero, out at sea. Simplex noise is
    /// zero at the origin, so the bending leaves the origin where the
    /// first island was put round it.
    fn place(&self, fx: f64, fy: f64) -> (&Island, f64) {
        let bend = |(far, frequency): (f64, f64)| far * self.bend[0].get([fx * frequency, fy * frequency]);
        let bend_y = |(far, frequency): (f64, f64)| far * self.bend[1].get([fx * frequency, fy * frequency]);
        let (x, y) = (fx + bend(WARP) + bend(WARP_FINE), fy + bend_y(WARP) + bend_y(WARP_FINE));
        self.islands
            .iter()
            .map(|island| {
                let (dx, dy) = (x - island.x, y - island.y);
                let r = dx.hypot(dy);
                let reach = island.radius * REACH;
                (island, if r > reach { reach - r } else { island.coast(dy.atan2(dx)) - r })
            })
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .expect("a seed with no islands")
    }

    /// The height at a point of the map, and what the tile there is made
    /// of: the moisture, how far into range country, and how far inland.
    fn sample(&self, fx: f64, fy: f64) -> (f64, f64, f64, f64) {
        let (island, inland) = self.place(fx, fy);
        if inland <= 0.0 {
            return (inland / SHELF_RISE, 0.0, 0.0, inland);
        }
        let span = |(lo, hi): (f64, f64), t: f64| lo + (hi - lo) * t;
        let home = 1.0 - ((fx.hypot(fy) - HOME) / HOME).clamp(0.0, 1.0);
        let r = (0.5 + 0.5 * self.rugged.get([fx * RUGGED, fy * RUGGED]) + island.rough).clamp(0.0, 1.0) * (1.0 - home);
        let detail = span(DETAIL, r);
        // Averaging two independent noises crowds the result toward zero,
        // which would leave almost nothing over the mountain line; scaled
        // back so the blend is spread as widely as either layer alone.
        let spread = ((1.0 - detail).powi(2) + detail.powi(2)).sqrt();
        let blend = |n: &Simplex| ((1.0 - detail) * n.get([fx * COARSE, fy * COARSE]) + detail * n.get([fx * FINE, fy * FINE])) / spread;
        let e = (blend(&self.elevation) * span(RELIEF, r) + SHELF * (inland / SHELF_RISE).min(1.0)).max(home * 0.3);
        let m = blend(&self.moisture) + island.wood - 0.3 * home;
        // A mountain is high ground in range country: the height above
        // says whether this is a hill, the continental layer alone says
        // whether the region is the kind that has ranges — the way
        // moisture says whether it has forest. Neither makes a peak by
        // itself, so ranges are contiguous and stand on high ground.
        let range = self.elevation.get([fx * COARSE, fy * COARSE]) * span(RELIEF, r) + island.rock - 2.0 * home;
        (e, m, range, inland)
    }

    /// One tile's type from the layers alone, before smoothing.
    fn tile(&self, x: i32, y: i32) -> TerrainType {
        let (e, m, range, inland) = self.sample(x as f64, y as f64);
        if inland <= 0.0 {
            TerrainType::Sea
        } else if e < -0.05 && inland > BAND {
            TerrainType::Water
        } else if inland < BEACH && self.coves.get([x as f64 * COVES, y as f64 * COVES]) > COVE {
            TerrainType::Beach
        } else if e > HILL && range > RANGE {
            TerrainType::Mountain
        } else if m > 0.15 {
            TerrainType::Forest
        } else {
            TerrainType::Grass
        }
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
        self.0.sample(x, y).0
    }

    /// The fine layer alone, -1 to 1: for detail.
    pub fn fine(&self, x: f64, y: f64) -> f64 {
        self.0.elevation.get([x * FINE * 3.0, y * FINE * 3.0])
    }
}

/// One chunk of terrain, derived from the seed and nothing else. Terrain
/// is never persisted and never an entity. Smoothed against an apron of
/// its neighbours' tiles,
/// computed the same way, so the seams agree: a tile that three or more of
/// its four neighbours stand above or below takes their level.
pub fn chunk(seed: u32, c: ChunkCoord) -> Vec<((i32, i32), TerrainType)> {
    let layers = Layers::new(seed);
    let (x0, y0) = (c.cx * CHUNK_SIZE, c.cy * CHUNK_SIZE);
    let n = CHUNK_SIZE + 2;
    let raw: Vec<TerrainType> = (0..n * n).map(|i| layers.tile(x0 - 1 + i % n, y0 - 1 + i / n)).collect();
    let at = |x: i32, y: i32| raw[((y - y0 + 1) * n + (x - x0 + 1)) as usize];
    let mut out = Vec::with_capacity((CHUNK_SIZE * CHUNK_SIZE) as usize);
    for y in y0..y0 + CHUNK_SIZE {
        for x in x0..x0 + CHUNK_SIZE {
            let t = at(x, y);
            let around = [at(x + 1, y), at(x - 1, y), at(x, y + 1), at(x, y - 1)];
            let other = around.iter().filter(|&&a| elev(a) != elev(t)).count();
            let t = if other >= 3 { *around.iter().find(|&&a| elev(a) != elev(t)).unwrap() } else { t };
            out.push(((x, y), t));
        }
    }
    out
}

/// The whole map of a seed, chunk by chunk.
pub fn generate(seed: u32) -> HashMap<(i32, i32), TerrainType> {
    (CHUNKS_MIN..=CHUNKS_MAX).flat_map(|cy| (CHUNKS_MIN..=CHUNKS_MAX).map(move |cx| ChunkCoord { cx, cy })).flat_map(|c| chunk(seed, c)).collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    /// Not an assertion: the share of the map each type covers, for
    /// whoever runs this with --nocapture and a `SPRAWL_SEED`.
    #[test]
    fn count_the_land() {
        let seed = std::env::var("SPRAWL_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(7);
        let land = generate(seed);
        let n = land.len() as f64;
        let share = |t: TerrainType| 100.0 * land.values().filter(|&&v| v == t).count() as f64 / n;
        eprintln!(
            "seed {seed}: sea {:.1}%  lake {:.1}%  beach {:.1}%  grass {:.1}%  forest {:.1}%  mountain {:.1}%",
            share(TerrainType::Sea), share(TerrainType::Water), share(TerrainType::Beach), share(TerrainType::Grass), share(TerrainType::Forest), share(TerrainType::Mountain)
        );
    }

    /// Not an assertion: a picture, for whoever runs this with --nocapture.
    /// The whole map of `SPRAWL_SEED` (or 7), sixteen tiles to a character,
    /// with `+` at the origin; the sea `~`, a lake `:`.
    #[test]
    fn draw_the_land() {
        let seed = std::env::var("SPRAWL_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(7);
        eprintln!("seed {seed}\n{}", draw(&generate(seed)));
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

    /// Every seed's map is islands in one ocean: land well under a third
    /// of it, a handful of islands, each with coast on the open sea, no
    /// sea shut in by land and no lake on the sea; and the origin's
    /// island big, with open grass for a town near its coast. The first
    /// twenty seeds stand for all. Twenty maps take a while, so this
    /// runs on request; DRAW=1 draws the seeds that fail.
    #[test]
    #[ignore]
    fn every_seed_is_islands_in_one_ocean() {
        let mut wrong = Vec::new();
        for seed in 0..20 {
            let land = generate(seed);
            let sea = |t| t == TerrainType::Sea;
            let mut faults = Vec::new();
            let share = land.values().filter(|&&t| !sea(t)).count() as f64 / land.len() as f64;
            if !(0.15..=0.25).contains(&share) {
                faults.push(format!("land {:.0}%", share * 100.0));
            }
            let border: Vec<_> = land.keys().copied().filter(|&(x, y)| x.abs().max(y.abs()) >= WIDTH / 2 - 1 || x == -WIDTH / 2 || y == -HEIGHT / 2).collect();
            let ocean = flood(&land, border, sea);
            let shut_in = land.values().filter(|&&t| sea(t)).count() - ocean.len();
            if shut_in > 0 {
                faults.push(format!("{shut_in} tiles of sea shut in"));
            }
            let side = |&(x, y): &(i32, i32)| [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)];
            if land.iter().any(|(t, &v)| v == TerrainType::Water && side(t).iter().any(|n| land.get(n) == Some(&TerrainType::Sea))) {
                faults.push("a lake on the sea".into());
            }
            // Islands: everything not sea, lakes and all, joined.
            let mut counted: HashSet<(i32, i32)> = HashSet::new();
            let (mut islands, mut islets) = (0, 0);
            let mut tiles: Vec<_> = land.keys().copied().collect();
            tiles.sort();
            for t in tiles {
                if sea(land[&t]) || counted.contains(&t) {
                    continue;
                }
                let island = flood(&land, vec![t], |v| !sea(v));
                if !island.iter().any(|t| land[t] != TerrainType::Water && side(t).iter().any(|n| ocean.contains(n))) {
                    faults.push(format!("an island at {t:?} with no coast on the open sea"));
                }
                if island.contains(&(0, 0)) {
                    let (xs, ys) = (island.iter().map(|t| t.0), island.iter().map(|t| t.1));
                    let (w, h) = (xs.clone().max().unwrap() - xs.min().unwrap(), ys.clone().max().unwrap() - ys.min().unwrap());
                    if w < 120 || h < 120 {
                        faults.push(format!("the origin's island is {w} by {h}"));
                    }
                }
                // An islet the bending broke off a headland is not one.
                if island.len() >= 1000 {
                    islands += 1;
                } else {
                    islets += 1;
                }
                counted.extend(island);
            }
            if !(4..=8).contains(&islands) {
                faults.push(format!("{islands} islands"));
            }
            // Room for a town: twenty tiles square of grass within sixty
            // of the origin, with the sea within forty of it.
            let grass = |x0: i32, y0: i32| (x0..x0 + 20).all(|x| (y0..y0 + 20).all(|y| land[&(x, y)] == TerrainType::Grass));
            let near_sea = |x0: i32, y0: i32| (x0 - 40..x0 + 60).any(|x| (y0 - 40..y0 + 60).any(|y| ocean.contains(&(x, y))));
            let room = (-60..40).step_by(4).any(|x| (-60..40).step_by(4).any(|y| grass(x, y) && near_sea(x, y)));
            if !room {
                faults.push("no grass for a town by the coast near the origin".into());
            }
            eprintln!("seed {seed}: land {:.1}%, {islands} islands, {islets} islets{}", share * 100.0, faults.iter().map(|f| format!("; {f}")).collect::<String>());
            if !faults.is_empty() {
                if std::env::var("DRAW").is_ok() {
                    eprintln!("{}", draw(&land));
                }
                wrong.push((seed, faults));
            }
        }
        assert!(wrong.is_empty(), "seeds that are not islands in one ocean: {wrong:?}");
    }
}
