use std::collections::HashMap;

use noise::{NoiseFn, Simplex};

use crate::protocol::{GameObject, GridCoord, TerrainBorder, TerrainTile, TerrainType};
use crate::world::World;

const WIDTH: i32 = 100;
const HEIGHT: i32 = 100;
const FREQ: f64 = 0.06;

fn terrain_priority(t: TerrainType) -> u8 {
    match t {
        TerrainType::Water => 0,
        TerrainType::Grass => 1,
        TerrainType::Forest => 2,
        TerrainType::Mountain => 3,
    }
}

pub fn generate(world: &mut World, seed: u32) {
    let elevation = Simplex::new(seed);
    let moisture = Simplex::new(seed.wrapping_add(1));

    let origin_x = -(WIDTH / 2);
    let origin_y = -(HEIGHT / 2);

    // Step 1: Assign types from noise (biased for dilation)
    let mut types: HashMap<(i32, i32), TerrainType> = HashMap::new();
    for y in origin_y..(origin_y + HEIGHT) {
        for x in origin_x..(origin_x + WIDTH) {
            let e = elevation.get([x as f64 * FREQ, y as f64 * FREQ]);
            let m = moisture.get([x as f64 * FREQ, y as f64 * FREQ]);

            let terrain_type = if e < -0.05 {
                TerrainType::Water
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

    // Step 2: Cardinal-only dilation — each cell with a higher-priority
    // cardinal neighbor becomes a border cell.
    // Cardinal directions with bitmask: S=bit0, E=bit1, N=bit2, W=bit3
    let cardinal: [(i32, i32, u8); 4] = [(0, -1, 1), (1, 0, 2), (0, 1, 4), (-1, 0, 8)];
    let mut border_cells: HashMap<(i32, i32), (TerrainType, TerrainType, u8)> = HashMap::new();

    for y in origin_y..(origin_y + HEIGHT) {
        for x in origin_x..(origin_x + WIDTH) {
            let my_type = types[&(x, y)];
            let mut highest: Option<TerrainType> = None;

            for &(dx, dy, _) in &cardinal {
                if let Some(&nt) = types.get(&(x + dx, y + dy)) {
                    if terrain_priority(nt) > terrain_priority(my_type)
                        && highest.map_or(true, |h| terrain_priority(nt) > terrain_priority(h))
                    {
                        highest = Some(nt);
                    }
                }
            }

            if let Some(high) = highest {
                // Build bitmask: for each cardinal neighbor, check if its original type matches type_a
                let mut dirs: u8 = 0;
                for &(dx, dy, bit) in &cardinal {
                    if let Some(&nt) = types.get(&(x + dx, y + dy)) {
                        if nt == high {
                            dirs |= bit;
                        }
                    }
                }
                border_cells.insert((x, y), (high, my_type, dirs));
            }
        }
    }

    // Step 3: Insert entities
    for y in origin_y..(origin_y + HEIGHT) {
        for x in origin_x..(origin_x + WIDTH) {
            let coord = GridCoord { x, y };
            if let Some(&(type_a, type_b, type_a_dirs)) = border_cells.get(&(x, y)) {
                world.objects.insert(
                    GameObject::TerrainBorder(TerrainBorder { type_a, type_b, type_a_dirs }),
                    Some(coord),
                );
            } else {
                world.objects.insert(
                    GameObject::Terrain(TerrainTile {
                        terrain_type: types[&(x, y)],
                    }),
                    Some(coord),
                );
            }
        }
    }
}
