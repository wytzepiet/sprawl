use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, HashMap, HashSet};

use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};

use crate::protocol::{BuildingKind, ChunkCoord, GridCoord, TerrainType, CHUNK_SIZE};
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
            // The survey's network is roads: through routes between the
            // anchors that nothing fronts onto. Streets are the mayor's.
            let coords: Vec<GridCoord> = path.iter().map(|&(x, y)| GridCoord { x, y }).collect();
            world.place_road_path_of(&coords, true);
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

/// Lay the starting network and return where the first town goes: the
/// anchor nearest the middle of the map. The middle chunk itself may be a
/// lake (seed 7 is), so its neighbours are tried after it, nearest first.
pub fn generate(world: &mut World, seed: u32, terrain: &HashMap<(i32, i32), TerrainType>) -> Option<GridCoord> {
    let start = crate::protocol::ChunkBounds {
        min_cx: START_MIN,
        min_cy: START_MIN,
        max_cx: START_MAX - 1,
        max_cy: START_MAX - 1,
    };
    extend_to(world, seed, terrain, start);
    const NEAR_MIDDLE: [(i32, i32); 9] = [(0, 0), (1, 1), (-1, -1), (1, -1), (-1, 1), (2, 0), (0, 2), (-2, 0), (0, -2)];
    NEAR_MIDDLE
        .iter()
        .find_map(|&(cx, cy)| anchor_for(seed, ChunkCoord { cx, cy }, terrain))
        .map(|(x, y)| GridCoord { x, y })
}

/// How far from the anchor the first buildings stand, and how far apart.
const START_REACH: i32 = 8;
const START_GAP: i32 = 3;

/// The starting town: one building of each kind on open land near the
/// anchor, each joined to it by a street laid the way the survey lays its
/// roads — the same search, preferring road that is already there, so the
/// second street runs along the first and every junction is one the mayor
/// could have drawn. The street runs to the plot's front; the driveway is
/// the building's own, as for anything that arrives. A plot that will not
/// take its building takes its street away with it.
pub fn start_town(world: &mut World, terrain: &HashMap<(i32, i32), TerrainType>, anchor: GridCoord, kinds: &[BuildingKind]) {
    let far = |a: GridCoord, b: GridCoord| (a.x - b.x).abs().max((a.y - b.y).abs());
    let mut plots: Vec<GridCoord> = (-START_REACH..=START_REACH)
        .flat_map(|dx| (-START_REACH..=START_REACH).map(move |dy| GridCoord { x: anchor.x + dx, y: anchor.y + dy }))
        .filter(|&p| far(p, anchor) >= 2 && world.is_buildable(p))
        .collect();
    plots.sort_unstable_by_key(|&p| (far(p, anchor), p.x, p.y));
    let mut road_edges = world.road_edge_set();
    let mut built: Vec<GridCoord> = Vec::new();
    let mut kinds = kinds.iter().copied();
    let Some(mut kind) = kinds.next() else { return };
    for plot in plots {
        if built.iter().any(|&b| far(b, plot) < START_GAP) || !world.is_buildable(plot) {
            continue;
        }
        // Not up against the through road: a driveway would hang off it at
        // an angle, and nothing fronts a road.
        let by_road = (-1..=1).flat_map(|ddx| (-1..=1).map(move |ddy| GridCoord { x: plot.x + ddx, y: plot.y + ddy }))
            .any(|t| world.road_node_at(t).is_some_and(|id| !world.is_street(id)));
        if by_road {
            continue;
        }
        let Some(path) = astar((plot.x, plot.y), (anchor.x, anchor.y), terrain, &road_edges) else { continue };
        let street: Vec<GridCoord> = path[1..].iter().map(|&(x, y)| GridCoord { x, y }).collect();
        // The street reaches the plot squarely and runs a tile past it
        // each way: a frontage, not a spoke, so a lot can spread along it.
        let Some(&front) = street.first() else { continue };
        let (dx, dy) = (front.x - plot.x, front.y - plot.y);
        if dx != 0 && dy != 0 {
            continue;
        }
        let sides = [GridCoord { x: front.x + dy, y: front.y + dx }, GridCoord { x: front.x - dy, y: front.y - dx }];
        let mut fresh: Vec<GridCoord> = street.iter().copied().filter(|&t| world.road_node_at(t).is_none()).collect();
        world.place_road_path(&street);
        // A side tile touches the front tile and nothing else, or it would
        // fork acutely off whatever else is there.
        for side in sides {
            let alone = (-1..=1).flat_map(|ddx| (-1..=1).map(move |ddy| GridCoord { x: side.x + ddx, y: side.y + ddy }))
                .all(|t| t == front || world.road_node_at(t).is_none());
            if alone && world.is_buildable(side) {
                fresh.push(side);
                world.place_road_path(&[side, front]);
            }
        }
        if world.place_on_street(plot, kind).is_none() {
            for t in fresh {
                let Some(node) = world.road_node_at(t) else { continue };
                for (a, b) in world.edges_involving(node) {
                    world.remove_edge(a, b);
                }
                world.demolish_node(node);
            }
            continue;
        }
        road_edges = world.road_edge_set();
        built.push(plot);
        match kinds.next() {
            Some(k) => kind = k,
            None => return,
        }
    }
}

const SQRT2: f64 = std::f64::consts::SQRT_2;
/// What a step over open ground costs. Water is dearer, existing road cheaper.
const LAND_COST: f64 = 4.0;
/// What it costs to run along road that is already there.
///
/// Reusing R tiles of road saves (LAND_COST - ROAD_COST) * R, while detouring
/// D tiles to reach it costs LAND_COST * D — so the search will go up to
/// `1 - ROAD_COST/LAND_COST` of a road's length out of its way to join it.
/// That ratio approaches 1 and never reaches it however low this goes, so the
/// lever is weak and tires quickly: measured over a starting network at full
/// goal pull, 1.0 gives 2962 road tiles, 0.5 gives 2930, 0.1 gives 2847, and
/// 0.01 — a hundred times cheaper than where it started — gives 2841.
const ROAD_COST: f64 = 0.5;

/// How hard the search drives at the goal, as a share of LAND_COST.
///
/// This, not the road cost, is what decides how much road gets shared. At the
/// full land cost the heuristic is greedy and rarely looks at a detour, even
/// one that would pay for itself; lower it and the search considers going
/// round by way of an existing road. It is a straight trade against time —
/// over a starting network: 1.00 gives 2930 tiles in 1.6s, 0.75 gives 2649 in
/// 2.9s, 0.50 gives 2536 in 5.2s, and 0.25 (which is admissible, so optimal)
/// gives 2352 in 10.3s.
///
/// 0.75 is the knee. It matters that this stays quick: chunks are laid on the
/// game loop as the map is revealed, so a slow search is a stutter in a
/// running game, not just a longer first start.
const GOAL_PULL: f64 = 0.75;

fn tile_cost(
    from: (i32, i32),
    to: (i32, i32),
    terrain: &HashMap<(i32, i32), TerrainType>,
    road_edges: &HashSet<((i32, i32), (i32, i32))>,
) -> Option<f64> {
    if road_edges.contains(&(from, to)) {
        return Some(ROAD_COST);
    }
    // A new arm may not meet what already stands at either end at an acute
    // angle: the rule the mayor draws under, so the survey's junctions are
    // ones the mayor could have drawn.
    let acute = |at: (i32, i32), arm: (i32, i32)| {
        (-1..=1).flat_map(|dx| (-1..=1).map(move |dy| (dx, dy))).any(|(dx, dy)| {
            (dx, dy) != (0, 0) && road_edges.contains(&(at, (at.0 + dx, at.1 + dy))) && dx * arm.0 + dy * arm.1 > 0
        })
    };
    if acute(from, (to.0 - from.0, to.1 - from.1)) || acute(to, (from.0 - to.0, from.1 - to.1)) {
        return None;
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
    // A diagonal step past a road tile on either side would be laid as two
    // straight ones round it, and those may not be what was checked here.
    // Go round it in the search instead, where the rule holds.
    let touched = |t: (i32, i32)| (-1..=1).flat_map(|dx| (-1..=1).map(move |dy| (dx, dy))).any(|d| d != (0, 0) && road_edges.contains(&(t, (t.0 + d.0, t.1 + d.1))));
    if from.0 != to.0 && from.1 != to.1 && (touched((to.0, from.1)) || touched((from.0, to.1))) {
        return None;
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
    // Scaled to what a step over open ground costs, less a little: see
    // GOAL_PULL. Left at 1.0 it underestimates every move fourfold and the
    // search spreads like Dijkstra instead of heading anywhere.
    let heuristic = |p: (i32, i32)| {
        let dx = (p.0 - goal.0).abs() as f64;
        let dy = (p.1 - goal.1).abs() as f64;
        let diag = dx.min(dy);
        let straight = dx.max(dy) - diag;
        (diag * SQRT2 + straight) * LAND_COST * GOAL_PULL
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

    /// The contraction, checked against a map nobody designed for it: the real
    /// generated network on seed 7, with whatever curves, forks and loops the
    /// generator happens to produce.
    #[test]
    fn the_generated_map_contracts_cleanly() {
        use std::collections::HashMap as Map;
        let terrain = crate::terrain::generate(7);
        let mut world = World::new();
        world.terrain = terrain.clone();
        generate(&mut world, 7, &terrain);

        let key = |a, b| if a <= b { (a, b) } else { (b, a) };
        let mut links = HashSet::new();
        let mut arms: Map<_, HashSet<_>> = Map::new();
        for &(a, b) in world.edges.keys() {
            links.insert(key(a, b));
            arms.entry(a).or_default().insert(b);
            arms.entry(b).or_default().insert(a);
        }
        assert!(links.len() > 500, "seed 7 should lay a real network, got {}", links.len());

        let mut covered = HashSet::new();
        let mut segments = HashSet::new();
        let mut longest = 0;
        for &node in arms.keys() {
            for seg in world.network.segments_at(node) {
                segments.insert(seg.nodes.clone());
                longest = longest.max(seg.nodes.len());
                for pair in seg.nodes.windows(2) {
                    covered.insert(key(pair[0], pair[1]));
                }
                for interior in &seg.nodes[1..seg.nodes.len() - 1] {
                    assert_eq!(arms[interior].len(), 2, "a junction sits inside a segment");
                }
            }
        }
        assert_eq!(covered, links, "the segments do not cover the roads exactly");
        let spans: usize = segments.iter().map(|n| n.len() - 1).sum();
        assert_eq!(spans, links.len(), "a road is covered by two segments");

        println!(
            "seed 7: {} roads -> {} segments, longest {} tiles",
            links.len(),
            segments.len(),
            longest,
        );
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
        let anchor = generate(&mut world, 7, &terrain);
        println!(
            "chunks={} anchor={:?} nodes={} in {:?}",
            (512 / CHUNK_SIZE) * (512 / CHUNK_SIZE),
            anchor,
            world.objects.all_entries().len(),
            t.elapsed(),
        );
    }
}
