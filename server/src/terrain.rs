use std::collections::HashMap;

use noise::{NoiseFn, Simplex};

use crate::protocol::TerrainType;

const WIDTH: i32 = 512;
const HEIGHT: i32 = 512;
/// Three layers of noise. A continental one, whose features are oceans and
/// mountain ranges about `1 / COARSE` tiles across, and a fine one that
/// gives the coast its bays and the land its woods and hills. The third,
/// larger than either, says how rugged a region is: where it is high the
/// fine layer has its say and the heights are stretched, which makes
/// cliffs and a broken coast; where it is low the land rolls and flattens
/// into plains.
const COARSE: f64 = 0.012;
const FINE: f64 = 0.05;
const RUGGED: f64 = 0.006;
/// The fine layer's share of the height, from the flattest region to the
/// most rugged.
const DETAIL: (f64, f64) = (0.1, 0.9);
/// How much the heights are stretched, likewise.
const RELIEF: (f64, f64) = (0.35, 2.2);
/// A mountain is ground above the hill line, in a region whose continental
/// layer, stretched, is over the range line.
const HILL: f64 = 0.4;
const RANGE: f64 = 0.6;
/// The ground is raised a little around the origin, fading out over this
/// many tiles. Simplex noise is exactly zero at the origin, which put every
/// seed's first town on the tide line; this puts it on a plot of land.
const START_LAND: f64 = 64.0;
const START_RAISE: f64 = 0.2;

fn elev(t: TerrainType) -> i32 {
    match t {
        TerrainType::Water => -1,
        TerrainType::Beach | TerrainType::Grass | TerrainType::Forest => 0,
        TerrainType::Mountain => 2,
    }
}

/// Terrain is derived state: deterministic in the seed, never persisted,
/// and never an entity. Returns the tile types for the whole world.
pub fn generate(seed: u32) -> HashMap<(i32, i32), TerrainType> {
    let elevation = Simplex::new(seed);
    let moisture = Simplex::new(seed.wrapping_add(1));
    let rugged = Simplex::new(seed.wrapping_add(2));
    let span = |(lo, hi): (f64, f64), t: f64| lo + (hi - lo) * t;

    let origin_x = -(WIDTH / 2);
    let origin_y = -(HEIGHT / 2);

    // Pass 1: assign terrain types from noise
    let mut types: HashMap<(i32, i32), TerrainType> = HashMap::new();
    for y in origin_y..(origin_y + HEIGHT) {
        for x in origin_x..(origin_x + WIDTH) {
            let (fx, fy) = (x as f64, y as f64);
            let r = 0.5 + 0.5 * rugged.get([fx * RUGGED, fy * RUGGED]);
            let detail = span(DETAIL, r);
            // Averaging two independent noises crowds the result toward zero,
            // which would leave almost nothing over the mountain line; scaled
            // back so the blend is spread as widely as either layer alone.
            let spread = ((1.0 - detail).powi(2) + detail.powi(2)).sqrt();
            let blend = |n: &Simplex| ((1.0 - detail) * n.get([fx * COARSE, fy * COARSE]) + detail * n.get([fx * FINE, fy * FINE])) / spread;
            let inland = 1.0 - (((x * x + y * y) as f64).sqrt() / START_LAND).min(1.0);
            let e = blend(&elevation) * span(RELIEF, r) + START_RAISE * inland;
            let m = blend(&moisture);
            // A mountain is high ground in range country: the height above
            // says whether this is a hill, the continental layer alone says
            // whether the region is the kind that has ranges — the way
            // moisture says whether it has forest. Neither makes a peak by
            // itself, so ranges are contiguous and stand on high ground.
            let range = elevation.get([fx * COARSE, fy * COARSE]) * span(RELIEF, r);

            let terrain_type = if e < -0.05 {
                TerrainType::Water
            } else if e < 0.05 {
                TerrainType::Beach
            } else if e > HILL && range > RANGE {
                TerrainType::Mountain
            } else if m > 0.15 {
                TerrainType::Forest
            } else {
                TerrainType::Grass
            };

            types.insert((x, y), terrain_type);
        }
    }

    // Pass 1b: smooth — if 3+ cardinal neighbors have a different elevation, adopt most common neighbor type
    let cardinal: [(i32, i32); 4] = [(0, 1), (0, -1), (1, 0), (-1, 0)];
    let mut flips: Vec<((i32, i32), TerrainType)> = Vec::new();
    for y in origin_y..(origin_y + HEIGHT) {
        for x in origin_x..(origin_x + WIDTH) {
            let my_elev = elev(types[&(x, y)]);
            let neighbors: Vec<TerrainType> = cardinal
                .iter()
                .filter_map(|&(dx, dy)| types.get(&(x + dx, y + dy)).copied())
                .collect();
            let diff_count = neighbors.iter().filter(|&&nt| elev(nt) != my_elev).count();
            if diff_count >= 3 {
                let replacement = neighbors.iter().find(|&&nt| elev(nt) != my_elev).unwrap();
                flips.push(((x, y), *replacement));
            }
        }
    }
    for ((x, y), t) in flips {
        types.insert((x, y), t);
    }

    types
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
            "seed {seed}: water {:.0}%  beach {:.0}%  grass {:.0}%  forest {:.0}%  mountain {:.0}%",
            share(TerrainType::Water), share(TerrainType::Beach), share(TerrainType::Grass), share(TerrainType::Forest), share(TerrainType::Mountain)
        );
    }

    /// Not an assertion: a picture, for whoever runs this with --nocapture.
    /// The middle 256×128 tiles of `SPRAWL_SEED` (or 7), four to a character.
    #[test]
    fn draw_the_land() {
        let seed = std::env::var("SPRAWL_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(7);
        let land = generate(seed);
        eprintln!("seed {seed}");
        for y in (-64..64).step_by(4) {
            let row: String = (-128..128)
                .step_by(4)
                .map(|x| {
                    if x == 0 && y == 0 {
                        return '+';
                    }
                    match land[&(x, y)] {
                        TerrainType::Water => '~',
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
