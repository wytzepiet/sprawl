use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};

use crate::car::CRUISE_SPEED;
use crate::protocol::EntityId;
use crate::world::network::Segment;
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

/// A leg of a journey: a stretch of road with nothing joining it along the
/// way, named by where it comes out and the first step onto it — which is
/// what tells apart two stretches that share both ends. The tiles between
/// are the network's; nothing copies them until a route is laid out.
#[derive(Clone, Copy)]
struct Leg {
    to: EntityId,
    cost: f64,
    step: EntityId,
}

/// Every way out from one place, searched as far as anyone has asked.
///
/// Searched over whole stretches of road rather than tile by tile: a junction
/// is the only place a decision can be made, so everything between two of them
/// is one move. On seed 7 that is a search over 73 stretches instead of 2719
/// links.
///
/// Costed in time, not distance, which is what lets a longer fast road beat a
/// shorter slow one and lets a jam push traffic elsewhere. Time is half what a
/// road promises and half what it has been giving — see
/// `RoadNetwork::run_cost_ms`.
///
/// The search keeps what it has settled, so asking about a second
/// destination from the same place picks up where the first stopped. A
/// resident weighing every shop in town pays for one search, not one per
/// shop. It lives for one decision and reads live costs, so there is nothing
/// to invalidate.
pub struct Routes<'w> {
    world: &'w World,
    start: EntityId,
    /// Best cost known to each junction, and the leg that reached it: the
    /// junction before, and the first step out of it.
    cost: HashMap<EntityId, f64>,
    via: HashMap<EntityId, (EntityId, EntityId)>,
    settled: HashSet<EntityId>,
    open: BinaryHeap<Node>,
}

impl<'w> Routes<'w> {
    pub fn from(world: &'w World, start: EntityId) -> Self {
        let mut routes = Routes {
            world,
            start,
            cost: HashMap::new(),
            via: HashMap::new(),
            settled: HashSet::new(),
            open: BinaryHeap::new(),
        };
        // A car does not have to be standing at a junction — anyone arriving
        // from off the map joins wherever the road past the frontier reaches.
        // So the search starts at whichever junctions this stretch leads to,
        // already carrying the cost of reaching them.
        for leg in junctions_from(world, start) {
            routes.relax(start, leg);
        }
        routes
    }

    /// What the quickest way costs, in game milliseconds, as the roads have
    /// been giving it: what a trip is worth planning around. `None` where no
    /// road joins them.
    pub fn cost_to(&mut self, end: EntityId) -> Option<f64> {
        self.reach(end).map(|(cost, _, _)| cost)
    }

    /// The quickest way, tile by tile, both ends included.
    pub fn route_to(&mut self, end: EntityId) -> Option<Vec<EntityId>> {
        let (_, junction, exit) = self.reach(end)?;
        let mut legs: Vec<(EntityId, EntityId, EntityId)> = Vec::new();
        let mut at = junction;
        while at != self.start {
            let &(from, step) = self.via.get(&at)?;
            legs.push((from, step, at));
            at = from;
        }
        legs.reverse();
        let mut route = vec![self.start];
        for (from, step, to) in legs {
            extend_route(&mut route, &between(stretch(self.world, from, step)?, from, to));
        }
        if exit.to != end {
            extend_route(&mut route, &between(stretch(self.world, end, exit.step)?, exit.to, end));
        }
        Some(route)
    }

    /// The cost to `end`, the junction the last leg leaves from, and that
    /// leg — named from the far end, so the route can be laid out.
    fn reach(&mut self, end: EntityId) -> Option<(f64, EntityId, Leg)> {
        let world = self.world;
        if self.start == end {
            return None;
        }
        // Refused before it starts rather than after exhausting everything
        // reachable. Without this, someone stranded on an island retries every
        // ten seconds and each retry is a full search of their own component.
        if !world.network.connected(self.start, end) {
            return None;
        }
        // Both ends of one stretch: no junction is involved at all. Part of a
        // stretch has no record of its own, so it is charged its share of
        // the whole stretch's.
        if let Some((seg, a, b)) = same_stretch(world, self.start, end) {
            let share = run_length(world, &seg.nodes[a.min(b)..=a.max(b)]) / seg.length.max(1e-9);
            let cost = world.network.run_cost_ms(seg, a < b, CRUISE_SPEED) * share;
            let step = seg.nodes[if a < b { b - 1 } else { b + 1 }];
            return Some((cost, self.start, Leg { to: self.start, cost, step }));
        }

        // The last leg is a hop like any other: the far end of the
        // destination's stretch may be settled first and still be the dearer
        // way in, so the search runs on until nothing left in the queue could
        // beat the best way in found so far.
        let exits = junctions_from(world, end);
        let way_in = |settled: &HashSet<EntityId>, cost: &HashMap<EntityId, f64>| -> Option<(f64, Leg)> {
            exits
                .iter()
                .filter(|exit| settled.contains(&exit.to))
                .map(|exit| (cost[&exit.to] + exit.cost, *exit))
                .min_by(|a, b| a.0.total_cmp(&b.0))
        };
        while let Some(top) = self.open.peek() {
            if way_in(&self.settled, &self.cost).is_some_and(|(best, _)| top.f >= best) {
                break;
            }
            let current = self.open.pop().unwrap();
            if current.f > self.cost[&current.id] + 1e-9 {
                continue; // superseded by a cheaper way here
            }
            self.settled.insert(current.id);
            for leg in hops_from(world, current.id) {
                self.relax(current.id, leg);
            }
        }
        way_in(&self.settled, &self.cost).map(|(cost, exit)| (cost, exit.to, exit))
    }

    fn relax(&mut self, from: EntityId, leg: Leg) {
        let cost = self.cost.get(&from).copied().unwrap_or(0.0) + leg.cost;
        if self.cost.get(&leg.to).is_none_or(|&best| cost < best - 1e-9) {
            self.cost.insert(leg.to, cost);
            self.via.insert(leg.to, (from, leg.step));
            self.open.push(Node { id: leg.to, f: cost });
        }
    }
}

/// Legs meet at a junction, which therefore belongs to both. It is driven once.
fn extend_route(route: &mut Vec<EntityId>, leg: &[EntityId]) {
    let skip = usize::from(route.last() == leg.first() && !route.is_empty());
    route.extend_from_slice(&leg[skip..]);
}

/// Every stretch leading away from this junction, and where it comes out.
fn hops_from(world: &World, at: EntityId) -> Vec<Leg> {
    world
        .network
        .segments_at(at)
        .filter(|seg| !seg.is_ring() && seg.nodes.len() > 1)
        .filter_map(|seg| {
            let last = seg.nodes.len() - 1;
            let (to, step, forward) = if seg.nodes[0] == at {
                (seg.nodes[last], seg.nodes[1], true)
            } else if seg.nodes[last] == at {
                (seg.nodes[0], seg.nodes[last - 1], false)
            } else {
                return None;
            };
            Some(Leg { to, step, cost: world.network.run_cost_ms(seg, forward, CRUISE_SPEED) })
        })
        .collect()
}

/// The junctions this node's own stretch leads to, with what it costs to get
/// there from where it stands. A junction leads to itself, for nothing.
fn junctions_from(world: &World, from: EntityId) -> Vec<Leg> {
    if world.network.is_junction(from) {
        return vec![Leg { to: from, cost: 0.0, step: from }];
    }
    world
        .network
        .segments_at(from)
        .filter(|seg| !seg.is_ring())
        .flat_map(|seg| {
            let Some(i) = seg.nodes.iter().position(|&n| n == from) else { return Vec::new() };
            let last = seg.nodes.len() - 1;
            // Part of a stretch has no record of its own, so it is charged
            // its share of the whole stretch's — otherwise joining a road
            // halfway along would look like a way of dodging the traffic on
            // it.
            let part = |lo: usize, hi: usize, forward: bool| {
                let share = run_length(world, &seg.nodes[lo..=hi]) / seg.length.max(1e-9);
                world.network.run_cost_ms(seg, forward, CRUISE_SPEED) * share
            };
            let mut legs = Vec::new();
            if i > 0 {
                legs.push(Leg { to: seg.nodes[0], cost: part(0, i, false), step: seg.nodes[i - 1] });
            }
            if i < last {
                legs.push(Leg { to: seg.nodes[last], cost: part(i, last, true), step: seg.nodes[i + 1] });
            }
            legs
        })
        .collect()
}

/// The stretch that leaves `at` by `step`.
fn stretch(world: &World, at: EntityId, step: EntityId) -> Option<&Segment> {
    world.network.segments_at(at).filter(|seg| !seg.is_ring()).find(|seg| {
        let i = seg.nodes.iter().position(|&n| n == at);
        i.is_some_and(|i| (i > 0 && seg.nodes[i - 1] == step) || seg.nodes.get(i + 1) == Some(&step))
    })
}

/// Both on the same stretch, and where along it.
fn same_stretch(world: &World, a: EntityId, b: EntityId) -> Option<(&Segment, usize, usize)> {
    world.network.segments_at(a).filter(|s| !s.is_ring()).find_map(|seg| {
        let i = seg.nodes.iter().position(|&n| n == a)?;
        let j = seg.nodes.iter().position(|&n| n == b)?;
        Some((seg, i, j))
    })
}

/// The tiles of a stretch from one of its nodes to another, in that order.
fn between(seg: &Segment, from: EntityId, to: EntityId) -> Vec<EntityId> {
    let a = seg.nodes.iter().position(|&n| n == from).unwrap_or(0);
    let b = seg.nodes.iter().position(|&n| n == to).unwrap_or(0);
    if a <= b {
        seg.nodes[a..=b].to_vec()
    } else {
        seg.nodes[b..=a].iter().rev().copied().collect()
    }
}

fn run_length(world: &World, nodes: &[EntityId]) -> f64 {
    nodes.windows(2).map(|p| world.segment_length(p[0], p[1])).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{GameObject, GridCoord, TerrainType};

    fn find_path(world: &World, start: EntityId, end: EntityId) -> Option<Vec<EntityId>> {
        Routes::from(world, start).route_to(end)
    }

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
