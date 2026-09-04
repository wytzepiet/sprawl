use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use crate::car::CRUISE_SPEED;
use crate::protocol::EntityId;
use crate::world::World;

struct Node {
    id: EntityId,
    f: f64,
}

impl PartialEq for Node {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}
impl Eq for Node {}

impl Ord for Node {
    fn cmp(&self, other: &Self) -> Ordering {
        other.f.partial_cmp(&self.f).unwrap_or(Ordering::Equal)
    }
}

impl PartialOrd for Node {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// A leg of a journey: a stretch of road with nothing joining it along the way,
/// and what it costs to drive.
struct Hop {
    to: EntityId,
    cost: f64,
    /// Every tile of it, in the order they are driven, both ends included.
    nodes: Vec<EntityId>,
}

/// A route from one road node to another, tile by tile.
///
/// Searched over whole stretches of road rather than tile by tile: a junction
/// is the only place a decision can be made, so everything between two of them
/// is one move. On seed 7 that is a search over 73 stretches instead of 2719
/// links.
///
/// Costed in time, not distance, which is what lets a longer fast road beat a
/// shorter slow one and lets a jam push traffic elsewhere. Time is half what a
/// road promises and half what it has been giving, so a busy road is dearer
/// but never as dear as it looks — see `RoadNetwork::travel_ms`.
pub fn find_path(world: &World, start: EntityId, end: EntityId) -> Option<Vec<EntityId>> {
    if start == end {
        return None;
    }
    // Refused before it starts rather than after exhausting everything
    // reachable. Without this, someone stranded on an island retries every ten
    // seconds and each retry is a full search of their own component.
    if !world.network.connected(start, end) {
        return None;
    }

    // Both ends of one stretch: no junction is involved at all.
    if let Some(direct) = straight_through(world, start, end) {
        return Some(direct);
    }

    // A car does not have to be standing at a junction — anyone arriving from
    // off the map joins wherever the road past the frontier reaches. So the
    // search starts at whichever junctions this stretch leads to, already
    // carrying the cost of reaching them, and ends the same way.
    let entrances = junctions_from(world, start);
    let exits: HashMap<EntityId, Hop> = junctions_from(world, end)
        .into_iter()
        .map(|mut hop| {
            hop.nodes.reverse();
            (hop.to, hop)
        })
        .collect();

    // As the crow flies at the cruising speed: nothing can beat that, since no
    // car exceeds the ceiling and no road is charged below what it promises. So
    // it never talks the search out of the quickest way round.
    let goal = world.objects.get(end).and_then(|e| e.position);
    let heuristic = |id: EntityId| -> f64 {
        match (world.objects.get(id).and_then(|e| e.position), goal) {
            (Some(a), Some(b)) => {
                let (dx, dy) = ((b.x - a.x) as f64, (b.y - a.y) as f64);
                (dx * dx + dy * dy).sqrt() / CRUISE_SPEED * 1000.0
            }
            _ => 0.0,
        }
    };

    let mut open = BinaryHeap::new();
    let mut g: HashMap<EntityId, f64> = HashMap::new();
    let mut came_from: HashMap<EntityId, (EntityId, Vec<EntityId>)> = HashMap::new();

    for hop in entrances {
        if g.get(&hop.to).is_none_or(|&best| hop.cost < best) {
            g.insert(hop.to, hop.cost);
            came_from.insert(hop.to, (start, hop.nodes));
            open.push(Node { id: hop.to, f: hop.cost + heuristic(hop.to) });
        }
    }

    while let Some(current) = open.pop() {
        let here = *g.get(&current.id).unwrap_or(&f64::INFINITY);
        if current.f - heuristic(current.id) > here + 1e-9 {
            continue; // superseded by a cheaper way here
        }
        if current.id == end {
            return Some(stitch(&came_from, start, end));
        }
        // The last leg is a hop like any other: the far end of the
        // destination's stretch may be popped first and still be the dearer
        // way in, so it competes in the queue rather than ending the search.
        if let Some(exit) = exits.get(&current.id) {
            let cost = here + exit.cost;
            if g.get(&end).is_none_or(|&best| cost < best - 1e-9) {
                g.insert(end, cost);
                came_from.insert(end, (current.id, exit.nodes.clone()));
                open.push(Node { id: end, f: cost });
            }
        }
        for hop in hops_from(world, current.id) {
            let cost = here + hop.cost;
            if g.get(&hop.to).is_none_or(|&best| cost < best - 1e-9) {
                g.insert(hop.to, cost);
                came_from.insert(hop.to, (current.id, hop.nodes));
                open.push(Node { id: hop.to, f: cost + heuristic(hop.to) });
            }
        }
    }
    None
}

/// Walk the trail of legs back to the start, then lay it out forwards.
fn stitch(
    came_from: &HashMap<EntityId, (EntityId, Vec<EntityId>)>,
    start: EntityId,
    end: EntityId,
) -> Vec<EntityId> {
    let mut legs: Vec<&Vec<EntityId>> = Vec::new();
    let mut at = end;
    while at != start {
        let Some((prev, nodes)) = came_from.get(&at) else { break };
        legs.push(nodes);
        at = *prev;
    }
    legs.reverse();

    let mut route: Vec<EntityId> = Vec::new();
    for leg in legs {
        extend_route(&mut route, leg);
    }
    route
}

/// Legs meet at a junction, which therefore belongs to both. It is driven once.
fn extend_route(route: &mut Vec<EntityId>, leg: &[EntityId]) {
    let skip = usize::from(route.last() == leg.first() && !route.is_empty());
    route.extend_from_slice(&leg[skip..]);
}

/// Every stretch leading away from this junction, and where it comes out.
fn hops_from(world: &World, at: EntityId) -> Vec<Hop> {
    world
        .network
        .segments_at(at)
        .filter(|seg| !seg.is_ring())
        .filter_map(|seg| {
            let nodes = oriented(&seg.nodes, at)?;
            let to = *nodes.last()?;
            let forward = seg.nodes.first() == Some(&at);
            let cost = world.network.run_cost_ms(seg, forward, CRUISE_SPEED);
            Some(Hop { to, cost, nodes })
        })
        .collect()
}

/// The junctions this node's own stretch leads to, with what it costs to get
/// there from where it stands. A junction leads to itself, for nothing.
fn junctions_from(world: &World, from: EntityId) -> Vec<Hop> {
    if world.network.is_junction(from) {
        return vec![Hop { to: from, cost: 0.0, nodes: vec![from] }];
    }
    world
        .network
        .segments_at(from)
        .filter(|seg| !seg.is_ring())
        .flat_map(|seg| {
            let Some(i) = seg.nodes.iter().position(|&n| n == from) else { return Vec::new() };
            let mut back: Vec<EntityId> = seg.nodes[..=i].to_vec();
            back.reverse();
            let on: Vec<EntityId> = seg.nodes[i..].to_vec();
            [back, on]
                .into_iter()
                .filter(|part| part.len() > 1)
                .map(|part| {
                    // Part of a stretch has no record of its own, so it is
                    // charged its share of the whole stretch's — otherwise
                    // joining a road halfway along would look like a way of
                    // dodging the traffic on it.
                    let to = part[part.len() - 1];
                    let share = run_length(world, &part) / seg.length.max(1e-9);
                    let forward = part.first() == seg.nodes.first();
                    let whole = world.network.run_cost_ms(seg, forward, CRUISE_SPEED);
                    Hop { to, cost: whole * share, nodes: part }
                })
                .collect()
        })
        .collect()
}

/// Both on the same stretch, so the road between them is the whole route and
/// no junction comes into it.
fn straight_through(world: &World, start: EntityId, end: EntityId) -> Option<Vec<EntityId>> {
    world.network.segments_at(start).filter(|s| !s.is_ring()).find_map(|seg| {
        let a = seg.nodes.iter().position(|&n| n == start)?;
        let b = seg.nodes.iter().position(|&n| n == end)?;
        let mut nodes: Vec<EntityId> = if a <= b {
            seg.nodes[a..=b].to_vec()
        } else {
            seg.nodes[b..=a].iter().rev().copied().collect()
        };
        nodes.dedup();
        Some(nodes)
    })
}

/// A run of nodes turned so it sets off from `at`.
fn oriented(nodes: &[EntityId], at: EntityId) -> Option<Vec<EntityId>> {
    match (nodes.first(), nodes.last()) {
        (Some(&a), _) if a == at => Some(nodes.to_vec()),
        (_, Some(&b)) if b == at => Some(nodes.iter().rev().copied().collect()),
        _ => None,
    }
}

fn run_length(world: &World, nodes: &[EntityId]) -> f64 {
    nodes.windows(2).map(|p| world.segment_length(p[0], p[1])).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{GameObject, GridCoord, TerrainType};

    /// The search this replaced: tile by tile, over the raw graph. Kept as the
    /// thing to be measured against — searching over stretches is only allowed
    /// to be quicker, never to arrive somewhere else.
    fn find_path_tile_by_tile(world: &World, start: EntityId, end: EntityId) -> Option<Vec<EntityId>> {
        if start == end {
            return None;
        }
        let heuristic = |id: EntityId| -> f64 {
            let a = world.objects.get(id).and_then(|e| e.position);
            let b = world.objects.get(end).and_then(|e| e.position);
            match (a, b) {
                (Some(a), Some(b)) => {
                    let (dx, dy) = ((b.x - a.x) as f64, (b.y - a.y) as f64);
                    (dx * dx + dy * dy).sqrt()
                }
                _ => 0.0,
            }
        };
        let mut open = BinaryHeap::new();
        let mut g: HashMap<EntityId, f64> = HashMap::new();
        let mut came_from: HashMap<EntityId, EntityId> = HashMap::new();
        g.insert(start, 0.0);
        open.push(Node { id: start, f: heuristic(start) });

        while let Some(current) = open.pop() {
            if current.id == end {
                let mut route = vec![end];
                let mut node = end;
                while let Some(&prev) = came_from.get(&node) {
                    route.push(prev);
                    node = prev;
                }
                route.reverse();
                return Some(route);
            }
            let here = *g.get(&current.id).unwrap_or(&f64::INFINITY);
            let outgoing = match world.objects.get(current.id) {
                Some(e) => match &e.object {
                    GameObject::RoadNode(node) => node.outgoing.clone(),
                    _ => continue,
                },
                None => continue,
            };
            for neighbour in outgoing {
                let cost = here + world.segment_length(current.id, neighbour);
                if g.get(&neighbour).is_none_or(|&best| cost < best) {
                    g.insert(neighbour, cost);
                    came_from.insert(neighbour, current.id);
                    open.push(Node { id: neighbour, f: cost + heuristic(neighbour) });
                }
            }
        }
        None
    }

    fn total(world: &World, route: &[EntityId]) -> f64 {
        run_length(world, route)
    }

    fn joined_up(world: &World, route: &[EntityId]) -> bool {
        route.windows(2).all(|p| {
            world.edges.contains_key(&(p[0], p[1])) || world.edges.contains_key(&(p[1], p[0]))
        })
    }

    fn seed_seven() -> World {
        let terrain = crate::terrain::generate(7);
        let mut world = World::new();
        world.terrain = terrain.clone();
        crate::road_gen::generate(&mut world, 7, &terrain);
        world
    }

    /// The claim in one test: over a real map, searching by stretches finds a
    /// route of the same length as searching tile by tile, and one a car can
    /// actually drive.
    #[test]
    fn it_finds_what_the_tile_search_finds() {
        let world = seed_seven();
        let mut nodes: Vec<EntityId> = world
            .objects
            .all_entries()
            .iter()
            .filter(|e| matches!(e.object, GameObject::RoadNode(_)))
            .map(|e| e.id)
            .collect();
        nodes.sort_unstable();
        assert!(nodes.len() > 500);

        // Spread across the map rather than clustered, and the same pairs every
        // run, so a failure can be gone back to.
        let picks: Vec<EntityId> = (0..40).map(|i| nodes[i * nodes.len() / 40]).collect();
        let mut compared = 0;
        for (i, &from) in picks.iter().enumerate() {
            let to = picks[(i + 17) % picks.len()];
            let (Some(mine), Some(theirs)) = (
                find_path(&world, from, to),
                find_path_tile_by_tile(&world, from, to),
            ) else {
                continue;
            };
            compared += 1;
            assert_eq!(mine.first(), Some(&from), "{from} -> {to}: wrong start");
            assert_eq!(mine.last(), Some(&to), "{from} -> {to}: wrong end");
            assert!(joined_up(&world, &mine), "{from} -> {to}: route has a gap in it");
            let (a, b) = (total(&world, &mine), total(&world, &theirs));
            assert!(
                (a - b).abs() < 1e-6,
                "{from} -> {to}: by stretches {a}, tile by tile {b}",
            );
        }
        assert!(compared > 20, "only {compared} pairs were reachable; test proves little");
    }

    fn straight_world() -> World {
        let mut world = World::new();
        for y in -4..8 {
            for x in -4..8 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        world
    }

    #[test]
    fn a_route_along_one_street_needs_no_junction() {
        let mut world = straight_world();
        let path: Vec<GridCoord> = (0..6).map(|x| GridCoord { x, y: 0 }).collect();
        world.place_road_path(&path);
        let from = world.road_node_at(GridCoord { x: 1, y: 0 }).unwrap();
        let to = world.road_node_at(GridCoord { x: 4, y: 0 }).unwrap();
        let route = find_path(&world, from, to).unwrap();
        assert_eq!(route.len(), 4, "four tiles from one to the other");
        assert!(joined_up(&world, &route));
    }

    /// Someone arriving from off the map joins partway along a stretch, which
    /// is the case a search over stretches has to be told about.
    #[test]
    fn a_route_can_begin_partway_along_a_street() {
        let mut world = straight_world();
        world.place_road_path(&(0..6).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>());
        world.place_road_path(&[GridCoord { x: 3, y: 0 }, GridCoord { x: 3, y: 4 }]);

        let from = world.road_node_at(GridCoord { x: 1, y: 0 }).unwrap();
        let to = world.road_node_at(GridCoord { x: 3, y: 4 }).unwrap();
        assert!(!world.network.is_junction(from), "the start is mid-street on purpose");

        let route = find_path(&world, from, to).unwrap();
        assert_eq!(route.first(), Some(&from));
        assert_eq!(route.last(), Some(&to));
        assert!(joined_up(&world, &route), "route has a gap in it");
        let tile_by_tile = find_path_tile_by_tile(&world, from, to).unwrap();
        assert!((total(&world, &route) - total(&world, &tile_by_tile)).abs() < 1e-6);
    }

    /// Two ways round, one short and one long, with a stub at each end so both
    /// junctions are real. The short way is taken until it jams.
    fn two_ways_round() -> (World, EntityId, EntityId) {
        let mut world = World::new();
        for y in -2..10 {
            for x in -2..10 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        let at = |x, y| GridCoord { x, y };
        // The short way: straight along the bottom.
        world.place_road_path(&(0..=6).map(|x| at(x, 0)).collect::<Vec<_>>());
        // The long way: up, across, and back down.
        let mut long: Vec<GridCoord> = (0..=3).map(|y| at(0, y)).collect();
        long.extend((1..=6).map(|x| at(x, 3)));
        long.extend((0..3).rev().map(|y| at(6, y)));
        world.place_road_path(&long);
        // Stubs, so each end really is a junction rather than a bend.
        world.place_road_path(&[at(0, 0), at(-1, 0)]);
        world.place_road_path(&[at(6, 0), at(7, 0)]);

        let from = world.road_node_at(at(-1, 0)).unwrap();
        let to = world.road_node_at(at(7, 0)).unwrap();
        (world, from, to)
    }

    #[test]
    fn the_short_way_is_taken_until_it_jams() {
        let (mut world, from, to) = two_ways_round();
        let short_way = world.road_node_at(GridCoord { x: 3, y: 0 }).unwrap();
        let long_way = world.road_node_at(GridCoord { x: 3, y: 3 }).unwrap();

        let quiet = find_path(&world, from, to).unwrap();
        assert!(quiet.contains(&short_way), "with nothing in the way, go the short way");
        assert!(!quiet.contains(&long_way));

        // The short way turns out to take five times what it promises. Half of
        // that is believed, which is enough to make the long way round cheaper.
        // Named by the first step out of the junction, since both ways round
        // share their two ends.
        let (a, first) = (
            world.road_node_at(GridCoord { x: 0, y: 0 }).unwrap(),
            world.road_node_at(GridCoord { x: 1, y: 0 }).unwrap(),
        );
        let promised = world.network.travel_via(a, first, CRUISE_SPEED).unwrap();
        world.network.observe_passage(a, first, promised * 5.0);

        let jammed = find_path(&world, from, to).unwrap();
        assert!(jammed.contains(&long_way), "a jam that bad should push traffic round");
        assert!(!jammed.contains(&short_way));
    }

    /// The jam is only half believed, so a road has to be genuinely worse than
    /// the alternative before anyone leaves it — not merely busy.
    #[test]
    fn a_little_traffic_does_not_empty_a_road() {
        let (mut world, from, to) = two_ways_round();
        let short_way = world.road_node_at(GridCoord { x: 3, y: 0 }).unwrap();
        let (a, first) = (
            world.road_node_at(GridCoord { x: 0, y: 0 }).unwrap(),
            world.road_node_at(GridCoord { x: 1, y: 0 }).unwrap(),
        );
        let promised = world.network.travel_via(a, first, CRUISE_SPEED).unwrap();
        world.network.observe_passage(a, first, promised * 1.5);

        let route = find_path(&world, from, to).unwrap();
        assert!(route.contains(&short_way), "half again is not a reason to go the long way");
    }

    #[test]
    fn there_is_no_route_onto_an_island() {
        let mut world = straight_world();
        world.place_road_path(&(0..3).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>());
        world.place_road_path(&[GridCoord { x: 0, y: 6 }, GridCoord { x: 1, y: 6 }]);
        let here = world.road_node_at(GridCoord { x: 0, y: 0 }).unwrap();
        let island = world.road_node_at(GridCoord { x: 1, y: 6 }).unwrap();
        assert!(find_path(&world, here, island).is_none());
    }
}
