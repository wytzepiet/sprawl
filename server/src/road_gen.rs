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

/// Chunks per axis in the starting network, centred on the origin. The world
/// itself is unbounded from the player's side — this is only how much road
/// exists before anyone builds.
const START_CHUNKS: i32 = 3;
/// How far past the surveyed edge road is laid. Deep enough that a run in from
/// off the map is a journey, not a step over the frontier.
const RING: i32 = 3;
const START_MIN: i32 = -(START_CHUNKS / 2);
const START_MAX: i32 = START_MIN + START_CHUNKS;

use crate::protocol::{ChunkCoord, CHUNK_SIZE};

/// Half the chunks carry an anchor, in a checkerboard.
///
/// The diagonal neighbours of a chunk share its parity, so the anchors form
/// their own grid turned through 45 degrees and every link lands on another
/// anchor. Half as many anchors, longer runs between them, and whole chunks
/// with no through road in them — which is where there is room to build.
fn has_anchor(chunk: ChunkCoord) -> bool {
    (chunk.cx + chunk.cy).rem_euclid(2) == 0
}

/// One tile of open ground per anchor chunk, for roads to run between.
///
/// A pure function of the seed and the chunk, deliberately: chunks are laid
/// out as the map is revealed, in whatever order the player explores, and a
/// chunk has to come out the same however late it is reached. Drawing from a
/// shared sequence would make the network depend on the route taken to it.
fn anchor_for(
    seed: u32,
    chunk: ChunkCoord,
    terrain: &HashMap<(i32, i32), TerrainType>,
) -> Option<(i32, i32)> {
    if !has_anchor(chunk) {
        return None;
    }
    let mut h = seed as u64 ^ 0x9e37_79b9_7f4a_7c15;
    h = h.wrapping_mul(0x100_0000_01b3) ^ (chunk.cx as i64 as u64);
    h = h.wrapping_mul(0x100_0000_01b3) ^ (chunk.cy as i64 as u64);
    let mut rng = SmallRng::seed_from_u64(h);

    let base_x = chunk.cx * CHUNK_SIZE;
    let base_y = chunk.cy * CHUNK_SIZE;
    for _ in 0..CHUNK_SIZE {
        let x = base_x + rng.random_range(0..CHUNK_SIZE);
        let y = base_y + rng.random_range(0..CHUNK_SIZE);
        if matches!(
            terrain.get(&(x, y)),
            Some(TerrainType::Grass | TerrainType::Beach | TerrainType::Forest)
        ) {
            return Some((x, y));
        }
    }
    None
}

/// Lay the roads belonging to `chunk`: the shortest run from its anchor to the
/// two anchors diagonally above it.
///
/// A diagonal pair always differs in `cy`, so the lower of the two owns the
/// link and no ground is laid twice, however the map is uncovered.
fn link_chunk(
    world: &mut World,
    seed: u32,
    terrain: &HashMap<(i32, i32), TerrainType>,
    chunk: ChunkCoord,
    road_edges: &mut HashSet<((i32, i32), (i32, i32))>,
) {
    let Some(a) = anchor_for(seed, chunk, terrain) else { return };
    for neighbour in [
        ChunkCoord { cx: chunk.cx + 1, cy: chunk.cy + 1 },
        ChunkCoord { cx: chunk.cx - 1, cy: chunk.cy + 1 },
    ] {
        let Some(b) = anchor_for(seed, neighbour, terrain) else { continue };
        if let Some(path) = astar(a, b, terrain, road_edges) {
            // Fed back in so the next path prefers running along this one
            // rather than beside it, which is what makes a network of it.
            for w in path.windows(2) {
                road_edges.insert((w[0], w[1]));
                road_edges.insert((w[1], w[0]));
            }
            let coords: Vec<GridCoord> = path.iter().map(|&(x, y)| GridCoord { x, y }).collect();
            world.place_road_path(&coords);
        }
    }
}

/// Lay road through every chunk in `bounds`, and RING chunks beyond it.
///
/// The ring is the point. Roads have to run past the edge of what has been
/// surveyed, or there is no way in from off the map. It reaches well past the
/// frontier rather than just over it, so that arriving from off the map is a
/// long haul rather than a step across the line.
pub fn extend_to(
    world: &mut World,
    seed: u32,
    terrain: &HashMap<(i32, i32), TerrainType>,
    bounds: crate::protocol::ChunkBounds,
) {
    // Read once, not per link: this walks every entity, and the world only
    // gets bigger.
    let mut road_edges = world.road_edge_set();
    for cy in (bounds.min_cy - RING)..=(bounds.max_cy + RING) {
        for cx in (bounds.min_cx - RING)..=(bounds.max_cx + RING) {
            let chunk = ChunkCoord { cx, cy };
            if world.roads_generated.insert(chunk) {
                link_chunk(world, seed, terrain, chunk, &mut road_edges);
            }
        }
    }
}

/// Lay the starting network and return where to put the first buildings.
///
/// Buildings reveal the map, so only the middle chunk gets one — seeding every
/// chunk we lay road through would unfog the lot.
pub fn generate(world: &mut World, seed: u32, terrain: &HashMap<(i32, i32), TerrainType>) -> Vec<GridCoord> {
    let start = crate::protocol::ChunkBounds {
        min_cx: START_MIN,
        min_cy: START_MIN,
        max_cx: START_MAX - 1,
        max_cy: START_MAX - 1,
    };
    extend_to(world, seed, terrain, start);

    (START_MIN..START_MAX)
        .flat_map(|cy| (START_MIN..START_MAX).map(move |cx| ChunkCoord { cx, cy }))
        .filter_map(|c| anchor_for(seed, c, terrain))
        .map(|(x, y)| GridCoord { x, y })
        .collect()
}

const SQRT2: f64 = std::f64::consts::SQRT_2;
/// What a step over open ground costs. Water is dearer, existing road cheaper.
const LAND_COST: f64 = 4.0;

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
        _ => Some(LAND_COST),
    }
}

fn astar(
    start: (i32, i32),
    goal: (i32, i32),
    terrain: &HashMap<(i32, i32), TerrainType>,
    road_edges: &HashSet<((i32, i32), (i32, i32))>,
) -> Option<Vec<(i32, i32)>> {
    // Scaled to what a step over open ground actually costs. Left at 1.0 the
    // heuristic underestimates every move fourfold, and A* spreads out like
    // Dijkstra instead of heading for the goal.
    let heuristic = |p: (i32, i32)| {
        let dx = (p.0 - goal.0).abs() as f64;
        let dy = (p.1 - goal.1).abs() as f64;
        let diag = dx.min(dy);
        let straight = dx.max(dy) - diag;
        (diag * SQRT2 + straight) * LAND_COST
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Half the chunks carry an anchor, and every link lands on another one:
    /// the diagonal neighbours of a chunk share its parity.
    #[test]
    fn anchors_checkerboard_and_diagonals_meet_them() {
        assert!(has_anchor(ChunkCoord { cx: 0, cy: 0 }));
        assert!(!has_anchor(ChunkCoord { cx: 1, cy: 0 }));
        assert!(has_anchor(ChunkCoord { cx: 1, cy: 1 }));
        // Negative coordinates keep the same pattern rather than mirroring it.
        assert!(!has_anchor(ChunkCoord { cx: -1, cy: 0 }));
        assert!(has_anchor(ChunkCoord { cx: -1, cy: -1 }));

        for c in [(0, 0), (4, -2), (-3, 5)] {
            let chunk = ChunkCoord { cx: c.0, cy: c.1 };
            if !has_anchor(chunk) {
                continue;
            }
            for d in [(1, 1), (-1, 1), (1, -1), (-1, -1)] {
                assert!(
                    has_anchor(ChunkCoord { cx: chunk.cx + d.0, cy: chunk.cy + d.1 }),
                    "a diagonal link would run to a chunk with no anchor",
                );
            }
        }
    }

    /// An anchor must not depend on when its chunk was reached. Explore east
    /// first or north first and the same road has to end up in the same place.
    #[test]
    fn anchors_do_not_depend_on_the_order_chunks_are_reached() {
        let terrain = crate::terrain::generate(7);
        for c in [(0, 0), (4, -2), (-4, 4)] {
            let chunk = ChunkCoord { cx: c.0, cy: c.1 };
            assert_eq!(anchor_for(7, chunk, &terrain), anchor_for(7, chunk, &terrain));
        }
        // And a different seed is a different world.
        let other = crate::terrain::generate(8);
        let a = anchor_for(7, ChunkCoord { cx: 0, cy: 0 }, &terrain);
        let b = anchor_for(8, ChunkCoord { cx: 0, cy: 0 }, &other);
        assert_ne!(a, b);
    }

    /// The point of the ring: road has to run past the edge of what has been
    /// surveyed, or nothing can arrive from off the map.
    #[test]
    fn road_runs_out_past_the_surveyed_edge() {
        let terrain = crate::terrain::generate(7);
        let mut world = World::new();
        world.terrain = terrain.clone();
        generate(&mut world, 7, &terrain);

        // The starting network covers chunks -1..=1. Road must exist beyond it.
        let beyond = world
            .objects
            .all_entries()
            .iter()
            .filter(|e| matches!(e.object, crate::protocol::GameObject::RoadNode(_)))
            .filter_map(|e| e.position)
            .any(|p| {
                let c = crate::world::chunk_of(p);
                c.cx < START_MIN || c.cx >= START_MAX || c.cy < START_MIN || c.cy >= START_MAX
            });
        assert!(beyond, "no road leaves the surveyed area; nothing could arrive from off-map");
    }

    /// Laying the same ground twice must not double the road through it.
    #[test]
    fn extending_again_lays_nothing_new() {
        let terrain = crate::terrain::generate(7);
        let mut world = World::new();
        world.terrain = terrain.clone();
        generate(&mut world, 7, &terrain);
        let before = world.objects.all_entries().len();

        let bounds = crate::protocol::ChunkBounds {
            min_cx: START_MIN, min_cy: START_MIN,
            max_cx: START_MAX - 1, max_cy: START_MAX - 1,
        };
        extend_to(&mut world, 7, &terrain, bounds);
        assert_eq!(world.objects.all_entries().len(), before);
    }

    /// What a network over the whole map costs, in time and in entities.
    /// Roads are persisted and spatially indexed, so the count is the budget.
    #[test]
    #[ignore]
    fn measure_full_map_network() {
        let terrain = crate::terrain::generate(7);
        let mut world = World::new();
        world.terrain = terrain.clone();
        let t = std::time::Instant::now();
        let anchors = generate(&mut world, 7, &terrain);
        println!(
            "chunks={} anchors={} nodes={} in {:?}",
            (512 / CHUNK_SIZE) * (512 / CHUNK_SIZE),
            anchors.len(),
            world.objects.all_entries().len(),
            t.elapsed(),
        );
    }
}
