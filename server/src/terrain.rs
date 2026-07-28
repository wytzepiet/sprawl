use std::collections::HashMap;

use noise::{NoiseFn, Simplex};

use crate::protocol::{GameObject, GridCoord, TerrainTile, TerrainType};
use crate::road_gen;
use crate::world::World;

const WIDTH: i32 = 200;
const HEIGHT: i32 = 200;
const FREQ: f64 = 0.05;

fn elev(t: TerrainType) -> i32 {
    match t {
        TerrainType::Water => -1,
        TerrainType::Beach | TerrainType::Grass | TerrainType::Forest => 0,
        TerrainType::Mountain => 2,
    }
}

pub fn generate(world: &mut World, seed: u32) -> HashMap<(i32, i32), TerrainType> {
    let elevation = Simplex::new(seed);
    let moisture = Simplex::new(seed.wrapping_add(1));

    let origin_x = -(WIDTH / 2);
    let origin_y = -(HEIGHT / 2);

    // Pass 1: assign terrain types from noise
    let mut types: HashMap<(i32, i32), TerrainType> = HashMap::new();
    for y in origin_y..(origin_y + HEIGHT) {
        for x in origin_x..(origin_x + WIDTH) {
            let e = elevation.get([x as f64 * FREQ, y as f64 * FREQ]);
            let m = moisture.get([x as f64 * FREQ, y as f64 * FREQ]);

            let terrain_type = if e < -0.05 {
                TerrainType::Water
            } else if e < 0.05 {
                TerrainType::Beach
            } else if e > 0.55 {
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

    // Pass 2: insert tiles. Corner shapes are derived client-side from the
    // types of surrounding tiles, so only the type is stored.
    for y in origin_y..(origin_y + HEIGHT) {
        for x in origin_x..(origin_x + WIDTH) {
            if !road_gen::is_edge_chunk_tile(x, y) {
                world.insert_at(
                    GameObject::Terrain(TerrainTile { terrain_type: types[&(x, y)] }),
                    Some(GridCoord { x, y }),
                );
            }
        }
    }

    types
}
