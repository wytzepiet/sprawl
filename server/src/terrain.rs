use std::collections::HashMap;

use noise::{NoiseFn, Simplex};

use crate::protocol::{GameObject, GridCoord, TerrainTile, TerrainType};
use crate::world::World;

const WIDTH: i32 = 100;
const HEIGHT: i32 = 100;
const FREQ: f64 = 0.06;

// For each corner [BL, BR, TR, TL], the two cardinal neighbors to check.
const CORNER_NEIGHBORS: [[(i32, i32); 2]; 4] = [
    [(-1, 0), (0, -1)], // BL: left + below
    [(1, 0), (0, -1)],  // BR: right + below
    [(1, 0), (0, 1)],   // TR: right + above
    [(-1, 0), (0, 1)],  // TL: left + above
];

// For each corner i, edge connectivity checks:
// (neighbor_dx, neighbor_dy, their_corner_index) for edge A and edge B.
// Same-slope pairs: BL(slope -1) ↔ TR(slope -1), BR(slope +1) ↔ TL(slope +1).
const EDGE_CHECKS: [[(i32, i32, usize); 2]; 4] = [
    // BL(0): A=below TR(2), B=left TR(2)
    [(0, -1, 2), (-1, 0, 2)],
    // BR(1): A=right TL(3), B=below TL(3)
    [(1, 0, 3), (0, -1, 3)],
    // TR(2): A=above BL(0), B=right BL(0)
    [(0, 1, 0), (1, 0, 0)],
    // TL(3): A=left BR(1), B=above BR(1)
    [(-1, 0, 1), (0, 1, 1)],
];

pub fn generate(world: &mut World, seed: u32) {
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

            let terrain_type = if e < -0.55 {
                TerrainType::Water3
            } else if e < -0.35 {
                TerrainType::Water2
            } else if e < -0.05 {
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

    // Pass 1b: smooth — if 3+ cardinal neighbors share a type, convert the cell
    let cardinal: [(i32, i32); 4] = [(0, 1), (0, -1), (1, 0), (-1, 0)];
    let mut flips: Vec<((i32, i32), TerrainType)> = Vec::new();
    for y in origin_y..(origin_y + HEIGHT) {
        for x in origin_x..(origin_x + WIDTH) {
            let my_type = types[&(x, y)];
            let mut counts = [0u8; 7];
            for &(dx, dy) in &cardinal {
                if let Some(&nt) = types.get(&(x + dx, y + dy)) {
                    counts[nt as usize] += 1;
                }
            }
            for (i, &c) in counts.iter().enumerate() {
                if c >= 3 && i != my_type as usize {
                    flips.push(((x, y), match i {
                        0 => TerrainType::Water,
                        1 => TerrainType::Water2,
                        2 => TerrainType::Water3,
                        3 => TerrainType::Beach,
                        4 => TerrainType::Grass,
                        5 => TerrainType::Forest,
                        _ => TerrainType::Mountain,
                    }));
                    break;
                }
            }
        }
    }
    for ((x, y), t) in flips {
        types.insert((x, y), t);
    }

    // Pass 2: compute corners for each cell
    let mut all_corners: HashMap<(i32, i32), Vec<Option<TerrainType>>> = HashMap::new();
    for y in origin_y..(origin_y + HEIGHT) {
        for x in origin_x..(origin_x + WIDTH) {
            let my_type = types[&(x, y)];
            let corners: Vec<Option<TerrainType>> = CORNER_NEIGHBORS
                .iter()
                .map(|&[d1, d2]| {
                    let n1 = types.get(&(x + d1.0, y + d1.1)).copied();
                    let n2 = types.get(&(x + d2.0, y + d2.1)).copied();
                    match (n1, n2) {
                        (Some(t1), Some(t2)) if t1 == t2 && t1 != my_type => Some(t1),
                        _ => None,
                    }
                })
                .collect();
            all_corners.insert((x, y), corners);
        }
    }

    // Pass 3: compute edge connectivity mask and insert entities
    for y in origin_y..(origin_y + HEIGHT) {
        for x in origin_x..(origin_x + WIDTH) {
            let my_type = types[&(x, y)];
            let corners = &all_corners[&(x, y)];
            let mut corner_mask: u8 = 0;

            for (i, corner_type) in corners.iter().enumerate() {
                if corner_type.is_none() { continue; }
                let [edge_a, edge_b] = EDGE_CHECKS[i];

                if let Some(nc) = all_corners.get(&(x + edge_a.0, y + edge_a.1)) {
                    if nc[edge_a.2].is_some() {
                        corner_mask |= 1 << (i * 2);
                    }
                }
                if let Some(nc) = all_corners.get(&(x + edge_b.0, y + edge_b.1)) {
                    if nc[edge_b.2].is_some() {
                        corner_mask |= 1 << (i * 2 + 1);
                    }
                }
            }

            // Cardinal edges: [bottom, right, top, left]. Empty if tile has corners.
            const EDGE_DIRS: [(i32, i32); 4] = [(0, -1), (1, 0), (0, 1), (-1, 0)];
            let edges = if corners.iter().any(|c| c.is_some()) {
                vec![None; 4]
            } else {
                EDGE_DIRS.iter().map(|&(dx, dy)| {
                    types.get(&(x + dx, y + dy)).copied().filter(|&t| t != my_type)
                }).collect()
            };

            world.objects.insert(
                GameObject::Terrain(TerrainTile {
                    terrain_type: my_type,
                    corners: corners.clone(),
                    corner_mask,
                    edges,
                }),
                Some(GridCoord { x, y }),
            );
        }
    }
}
