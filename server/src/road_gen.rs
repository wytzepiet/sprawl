use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, HashMap, HashSet};

use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};

use crate::protocol::{GridCoord, TerrainType};
use crate::world::World;

#[derive(PartialEq, PartialOrd, Clone, Copy)]
struct F(f64);
impl Eq for F {}
impl Ord for F {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.total_cmp(&other.0)
    }
}

const CHUNK_SIZE: i32 = 32;
const CHUNKS_PER_AXIS: i32 = 3;
const WIDTH: i32 = 100;
const ORIGIN: i32 = -(WIDTH / 2);

pub fn generate(world: &mut World, seed: u32, terrain: &HashMap<(i32, i32), TerrainType>) {
    let mut rng = SmallRng::seed_from_u64(seed as u64);
    let mut anchors: HashMap<(i32, i32), (i32, i32)> = HashMap::new();

    // Pick one buildable anchor per chunk
    for cy in 0..CHUNKS_PER_AXIS {
        for cx in 0..CHUNKS_PER_AXIS {
            let base_x = ORIGIN + cx * CHUNK_SIZE;
            let base_y = ORIGIN + cy * CHUNK_SIZE;
            for _ in 0..CHUNK_SIZE {
                let x = base_x + rng.random_range(0..CHUNK_SIZE);
                let y = base_y + rng.random_range(0..CHUNK_SIZE);
                if let Some(t) = terrain.get(&(x, y)) {
                    if matches!(
                        t,
                        TerrainType::Grass | TerrainType::Beach | TerrainType::Forest
                    ) {
                        anchors.insert((cx, cy), (x, y));
                        break;
                    }
                }
            }
        }
    }

    let mut placed_roads: HashSet<(i32, i32)> = HashSet::new();

    // Connect each chunk to right and top neighbors
    let pairs: Vec<_> = anchors.keys().copied().collect();
    for &(cx, cy) in &pairs {
        let a = match anchors.get(&(cx, cy)) {
            Some(&a) => a,
            None => continue,
        };
        for &(ncx, ncy) in &[(cx + 1, cy), (cx, cy + 1)] {
            let b = match anchors.get(&(ncx, ncy)) {
                Some(&b) => b,
                None => continue,
            };
            if let Some(path) = astar(a, b, terrain, &placed_roads) {
                for &tile in &path {
                    placed_roads.insert(tile);
                }
                let coords: Vec<GridCoord> =
                    path.iter().map(|&(x, y)| GridCoord { x, y }).collect();
                world.place_road_path(&coords);
            }
        }
    }
}

const SQRT2: f64 = std::f64::consts::SQRT_2;

fn tile_cost(
    pos: (i32, i32),
    terrain: &HashMap<(i32, i32), TerrainType>,
    placed_roads: &HashSet<(i32, i32)>,
) -> Option<f64> {
    if placed_roads.contains(&pos) {
        return Some(0.5);
    }
    match terrain.get(&pos)? {
        TerrainType::Mountain => None,
        TerrainType::Water | TerrainType::Water2 | TerrainType::Water3 => Some(10.0),
        _ => Some(2.0),
    }
}

fn astar(
    start: (i32, i32),
    goal: (i32, i32),
    terrain: &HashMap<(i32, i32), TerrainType>,
    placed_roads: &HashSet<(i32, i32)>,
) -> Option<Vec<(i32, i32)>> {
    let heuristic = |p: (i32, i32)| {
        let dx = (p.0 - goal.0).abs() as f64;
        let dy = (p.1 - goal.1).abs() as f64;
        let diag = dx.min(dy);
        let straight = dx.max(dy) - diag;
        diag * SQRT2 + straight
    };

    let mut g: HashMap<(i32, i32), f64> = HashMap::new();
    let mut came_from: HashMap<(i32, i32), (i32, i32)> = HashMap::new();
    let mut open: BinaryHeap<Reverse<(F, i32, i32)>> = BinaryHeap::new();

    g.insert(start, 0.0);
    open.push(Reverse((F(heuristic(start)), start.0, start.1)));

    const DIRS: [(i32, i32); 8] = [
        (1, 0),
        (-1, 0),
        (0, 1),
        (0, -1),
        (1, 1),
        (1, -1),
        (-1, 1),
        (-1, -1),
    ];

    while let Some(Reverse((_, x, y))) = open.pop() {
        let pos = (x, y);
        if pos == goal {
            let mut path = vec![goal];
            let mut cur = goal;
            while let Some(&prev) = came_from.get(&cur) {
                path.push(prev);
                cur = prev;
            }
            path.reverse();
            return Some(path);
        }

        let current_g = g[&pos];
        let prev_dir = came_from.get(&pos).map(|&prev| (x - prev.0, y - prev.1));
        for &(dx, dy) in &DIRS {
            // Reject sharp turns (< 90°): dot product of prev and next direction must be >= 0
            if let Some((pdx, pdy)) = prev_dir {
                if pdx * dx + pdy * dy < 0 {
                    continue;
                }
            }
            let next = (x + dx, y + dy);
            let base_cost = match tile_cost(next, terrain, placed_roads) {
                Some(c) => c,
                None => continue,
            };
            let step = if dx != 0 && dy != 0 { SQRT2 } else { 1.0 };
            let new_g = current_g + base_cost * step;
            if new_g < *g.get(&next).unwrap_or(&f64::MAX) {
                g.insert(next, new_g);
                came_from.insert(next, pos);
                open.push(Reverse((F(new_g + heuristic(next)), next.0, next.1)));
            }
        }
    }
    None
}
