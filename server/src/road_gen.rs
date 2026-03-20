use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, HashMap, HashSet};

use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};

use crate::protocol::{GridCoord, TerrainType};
use crate::world::World;

#[derive(PartialEq, Clone, Copy)]
struct F(f64);
impl Eq for F {}
impl PartialOrd for F {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for F {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.total_cmp(&other.0)
    }
}

const CHUNK_SIZE: i32 = 32;
const CHUNKS_PER_AXIS: i32 = 6;
const WIDTH: i32 = 200;
const ORIGIN: i32 = -(WIDTH / 2);

pub fn is_edge_chunk_tile(x: i32, y: i32) -> bool {
    let cx = (x - ORIGIN) / CHUNK_SIZE;
    let cy = (y - ORIGIN) / CHUNK_SIZE;
    cx == 0 || cx == CHUNKS_PER_AXIS - 1 || cy == 0 || cy == CHUNKS_PER_AXIS - 1
}

pub fn generate(world: &mut World, seed: u32, terrain: &HashMap<(i32, i32), TerrainType>) -> Vec<GridCoord> {
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

    let mut road_edges: HashSet<((i32, i32), (i32, i32))> = HashSet::new();

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
            if let Some(path) = astar(a, b, terrain, &road_edges) {
                for w in path.windows(2) {
                    road_edges.insert((w[0], w[1]));
                    road_edges.insert((w[1], w[0]));
                }
                let coords: Vec<GridCoord> =
                    path.iter().map(|&(x, y)| GridCoord { x, y }).collect();
                world.place_road_path(&coords);
            }
        }
    }

    // Collect edge anchors
    anchors
        .iter()
        .filter(|&(&(cx, cy), _)| cx == 0 || cx == CHUNKS_PER_AXIS - 1 || cy == 0 || cy == CHUNKS_PER_AXIS - 1)
        .map(|(_, &(x, y))| GridCoord { x, y })
        .collect()
}

const SQRT2: f64 = std::f64::consts::SQRT_2;

fn tile_cost(
    from: (i32, i32),
    to: (i32, i32),
    terrain: &HashMap<(i32, i32), TerrainType>,
    road_edges: &HashSet<((i32, i32), (i32, i32))>,
) -> Option<f64> {
    if road_edges.contains(&(from, to)) {
        return Some(1.0);
    }
    // Forbid cells that sit between two diagonally-connected road cells.
    // The 4 pairs of cardinal neighbors that are diagonal to each other:
    let (tx, ty) = to;
    for &(a, b) in &[
        ((tx - 1, ty), (tx, ty - 1)),
        ((tx + 1, ty), (tx, ty - 1)),
        ((tx - 1, ty), (tx, ty + 1)),
        ((tx + 1, ty), (tx, ty + 1)),
    ] {
        if road_edges.contains(&(a, b)) {
            return None;
        }
    }
    match terrain.get(&to)? {
        TerrainType::Mountain => None,
        TerrainType::Water => Some(20.0),
        _ => Some(4.0),
    }
}

fn astar(
    start: (i32, i32),
    goal: (i32, i32),
    terrain: &HashMap<(i32, i32), TerrainType>,
    road_edges: &HashSet<((i32, i32), (i32, i32))>,
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
        let prev = came_from.get(&pos).copied();
        for &(dx, dy) in &DIRS {
            // Reject sharp turns relative to our own path
            if let Some(p) = prev {
                let pdx = x - p.0;
                let pdy = y - p.1;
                if pdx * dx + pdy * dy < 0 {
                    continue;
                }
            }
            let next = (x + dx, y + dy);
            let base_cost = match tile_cost(pos, next, terrain, road_edges) {
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
