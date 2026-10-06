use std::collections::HashMap;

use noise::{NoiseFn, Simplex};

use crate::protocol::{ChunkCoord, TerrainType, CHUNK_SIZE};

/// The map, in tiles and in chunks.
const WIDTH: i32 = 1024;
const HEIGHT: i32 = 1024;
pub const CHUNKS_MIN: i32 = -(WIDTH / 2) / CHUNK_SIZE;
pub const CHUNKS_MAX: i32 = (WIDTH / 2) / CHUNK_SIZE - 1;
/// Four layers of noise. A continental one, whose features are seas and
/// mountain ranges about `1 / COARSE` tiles across, and a fine one that
/// gives the coast its bays and the land its woods and hills. The third,
/// larger than either, says how rugged a region is: where it is high the
/// fine layer has its say and the heights are stretched, which makes
/// cliffs and a broken coast; where it is low the land rolls and flattens
/// into plains. The fourth is the ocean, as wide as the map, and it is a
/// step rather than a wave: its noise is squashed through a steep
/// S-curve, so nearly everywhere is either sea floor or continental
/// shelf, with the slope between them a narrow band. The floor lies
/// further under the tide line than the other three layers can raise, so
/// an island is the rare place where the coarse layer peaks in rugged
/// country; the shelf lifts the land only enough to drain most of its
/// low ground, and a lake is what is left in the rest.
const COARSE: f64 = 0.012;
const FINE: f64 = 0.05;
const RUGGED: f64 = 0.006;
const OCEAN: f64 = 0.002;
/// How steep the step is: the slope between floor and shelf is about
/// `1 / (OCEAN * OCEAN_GAIN)` tiles wide.
const OCEAN_GAIN: f64 = 5.0;
const SEA_FLOOR: f64 = 3.0;
const SHELF: f64 = 0.8;
/// The fine layer's share of the height, from the flattest region to the
/// most rugged.
const DETAIL: (f64, f64) = (0.1, 0.9);
/// How much the heights are stretched, likewise.
const RELIEF: (f64, f64) = (0.35, 2.2);
/// A mountain is ground above the hill line, in a region whose continental
/// layer, stretched, is over the range line.
const HILL: f64 = 0.4;
const RANGE: f64 = 0.6;
/// The ground is raised a little around the origin and the ocean is held
/// back from it: flat out to the survey's edge, then fading over as far
/// again. Simplex noise is exactly zero at the origin, which put every
/// seed's first town on the tide line, and an ocean there would put the
/// starting town under the sea or on a spit of beach with no room for
/// it. This puts the survey on land, with the coast where the ocean comes
/// close beyond it.
const START_LAND: f64 = 48.0;
const START_RAISE: f64 = 0.2;

fn elev(t: TerrainType) -> i32 {
    match t {
        TerrainType::Sea | TerrainType::Water => -1,
        TerrainType::Beach | TerrainType::Grass | TerrainType::Forest => 0,
        TerrainType::Mountain => 2,
    }
}

/// The four layers, seeded.
struct Layers {
    elevation: Simplex,
    moisture: Simplex,
    rugged: Simplex,
    ocean: Simplex,
}

impl Layers {
    fn new(seed: u32) -> Self {
        Layers { elevation: Simplex::new(seed), moisture: Simplex::new(seed.wrapping_add(1)), rugged: Simplex::new(seed.wrapping_add(2)), ocean: Simplex::new(seed.wrapping_add(3)) }
    }

    /// The height at a point of the map, and what the tile there is made
    /// of: the moisture, how far into range country, and the ocean's step.
    fn sample(&self, fx: f64, fy: f64) -> (f64, f64, f64, f64) {
        let span = |(lo, hi): (f64, f64), t: f64| lo + (hi - lo) * t;
        let r = 0.5 + 0.5 * self.rugged.get([fx * RUGGED, fy * RUGGED]);
        let detail = span(DETAIL, r);
        // Averaging two independent noises crowds the result toward zero,
        // which would leave almost nothing over the mountain line; scaled
        // back so the blend is spread as widely as either layer alone.
        let spread = ((1.0 - detail).powi(2) + detail.powi(2)).sqrt();
        let blend = |n: &Simplex| ((1.0 - detail) * n.get([fx * COARSE, fy * COARSE]) + detail * n.get([fx * FINE, fy * FINE])) / spread;
        let inland = 1.0 - (((fx * fx + fy * fy).sqrt() - START_LAND) / START_LAND).clamp(0.0, 1.0);
        let step = (OCEAN_GAIN * self.ocean.get([fx * OCEAN, fy * OCEAN])).tanh();
        let deep = step * if step < 0.0 { SEA_FLOOR } else { SHELF };
        let e = blend(&self.elevation) * span(RELIEF, r) + START_RAISE * inland + deep + inland * (-deep).max(0.0);
        let m = blend(&self.moisture);
        // A mountain is high ground in range country: the height above
        // says whether this is a hill, the continental layer alone says
        // whether the region is the kind that has ranges — the way
        // moisture says whether it has forest. Neither makes a peak by
        // itself, so ranges are contiguous and stand on high ground.
        let range = self.elevation.get([fx * COARSE, fy * COARSE]) * span(RELIEF, r);
        (e, m, range, step)
    }

    /// One tile's type from the layers alone, before smoothing.
    fn tile(&self, x: i32, y: i32) -> TerrainType {
        let (e, m, range, step) = self.sample(x as f64, y as f64);
        if e < -0.05 {
            // Water on the ocean's side of the step is the sea; water on
            // the shelf is a lake, whatever its size.
            if step < 0.0 { TerrainType::Sea } else { TerrainType::Water }
        } else if e < 0.05 {
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
            "seed {seed}: sea {:.0}%  lake {:.0}%  beach {:.0}%  grass {:.0}%  forest {:.0}%  mountain {:.0}%",
            share(TerrainType::Sea), share(TerrainType::Water), share(TerrainType::Beach), share(TerrainType::Grass), share(TerrainType::Forest), share(TerrainType::Mountain)
        );
    }

    /// Not an assertion: a picture, for whoever runs this with --nocapture.
    /// The whole map of `SPRAWL_SEED` (or 7), sixteen tiles to a character,
    /// with `+` at the origin; the sea `~`, a lake `:`.
    #[test]
    fn draw_the_land() {
        let seed = std::env::var("SPRAWL_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(7);
        let land = generate(seed);
        eprintln!("seed {seed}");
        for y in (-HEIGHT / 2..HEIGHT / 2).step_by(16) {
            let row: String = (-WIDTH / 2..WIDTH / 2)
                .step_by(16)
                .map(|x| {
                    if x.abs() < 16 && y.abs() < 16 {
                        return '+';
                    }
                    match land[&(x, y)] {
                        TerrainType::Sea => '~',
                        TerrainType::Water => ':',
                        TerrainType::Beach => '.',
                        TerrainType::Grass => ' ',
                        TerrainType::Forest => '^',
                        TerrainType::Mountain => 'M',
                    }
                })
                .collect();
            eprintln!("{row}");
        }
    }
}
