use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};

use crate::car::CRUISE_SPEED;
use crate::protocol::EntityId;
use crate::world::network::Segment;
use crate::world::World;

/// Where a search stands: at a junction, come in from the node before it
/// (the junction itself where the search began). Turns are made at
/// junctions, and which way a car came in says which ways it may go out.
type At = (EntityId, EntityId);

struct Node {
    at: At,
    f: f64,
}

impl PartialEq for Node {
    fn eq(&self, other: &Self) -> bool {
        self.at == other.at
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
/// way, named by where it comes out, the first step onto it — which is
/// what tells apart two stretches that share both ends — and the last
/// node before its end, which says which way it comes in there. The tiles
/// between are the network's; nothing copies them until a route is laid
/// out.
#[derive(Clone, Copy)]
struct Leg {
    to: EntityId,
    cost: f64,
    step: EntityId,
    behind: EntityId,
}

/// May a car come in to `at` from `from` and go on to `to`? Never back the
/// way it came. Where the search begins it came from nowhere, and where it
/// ends it goes nowhere.
pub fn may_turn(world: &World, from: EntityId, at: EntityId, to: EntityId) -> bool {
    if from == at || to == at {
        return true;
    }
    // Never back the way it came: to the node it came from, or to the one
    // beside it on that tile, a road the other way side by side.
    let pos = |id: EntityId| world.objects.get(id).and_then(|e| e.position);
    from != to && pos(from) != pos(to)
}

/// Every way out from one place, searched as far as anyone has asked.
///
/// Searched over whole stretches of road rather than tile by tile: a junction
/// is the only place a decision can be made, so everything between two of them
/// is one move. On seed 7 that is a search over 73 stretches instead of 2719
/// links. A junction is searched once for each way into it, since the way in
/// says which turns are open (`may_turn`).
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
    /// Best cost known to each junction by each way in, and the leg that
    /// reached it: where that leg left from, and its first step.
    cost: HashMap<At, f64>,
    via: HashMap<At, (At, EntityId)>,
    settled: HashSet<At>,
    /// The ways in settled at each junction.
    settled_at: HashMap<EntityId, Vec<At>>,
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
            settled_at: HashMap::new(),
            open: BinaryHeap::new(),
        };
        // A car does not have to be standing at a junction — anyone arriving
        // from off the map joins wherever the road past the frontier reaches.
        // So the search starts at whichever junctions this stretch leads to,
        // already carrying the cost of reaching them.
        let here = (start, start);
        for leg in junctions_from(world, start) {
            if leg.to == start {
                routes.cost.insert(here, 0.0);
                routes.open.push(Node { at: here, f: 0.0 });
            } else {
                routes.relax(here, leg);
            }
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
        while at != (self.start, self.start) {
            let &(from, step) = self.via.get(&at)?;
            legs.push((from.0, step, at.0));
            at = from;
        }
        legs.reverse();
        let mut route = vec![self.start];
        for (from, step, to) in legs {
            extend_route(&mut route, &along(self.world, from, step, to)?);
        }
        if exit.to != end {
            let mut last = along(self.world, end, exit.step, exit.to)?;
            last.reverse();
            extend_route(&mut route, &last);
        }
        Some(route)
    }

    /// The cost to `end`, the junction the last leg leaves from with the
    /// way the search came in to it, and that leg — named from the far
    /// end, so the route can be laid out.
    fn reach(&mut self, end: EntityId) -> Option<(f64, At, Leg)> {
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
        // the whole stretch's. On a loop there is a second way, round the
        // other side through its junction, which the search finds.
        let here = (self.start, self.start);
        let mut direct = None;
        if let Some((seg, a, b)) = same_stretch(world, self.start, end)
            && seg.ways[usize::from(a > b)]
        {
            let share = run_length(world, &seg.nodes[a.min(b)..=a.max(b)]) / seg.length.max(1e-9);
            let cost = world.network.run_cost_ms(seg, a < b, CRUISE_SPEED) * share;
            let step = seg.nodes[if a < b { b - 1 } else { b + 1 }];
            direct = Some((cost, here, Leg { to: self.start, cost, step, behind: self.start }));
            if !seg.is_ring() {
                return direct;
            }
        }

        // The last leg is a hop like any other: the far end of the
        // destination's stretch may be settled first and still be the dearer
        // way in, so the search runs on until nothing left in the queue could
        // beat the best way in found so far.
        let exits = junctions_into(world, end);
        let way_in = |routes: &Routes| -> Option<(f64, At, Leg)> {
            exits
                .iter()
                .flat_map(|exit| {
                    routes.settled_at.get(&exit.to).into_iter().flatten().filter(|at| may_turn(world, at.1, at.0, exit.behind)).map(|&at| (routes.cost[&at] + exit.cost, at, *exit))
                })
                .min_by(|a, b| a.0.total_cmp(&b.0))
        };
        while let Some(top) = self.open.peek() {
            if way_in(self).is_some_and(|(best, _, _)| top.f >= best) {
                break;
            }
            let current = self.open.pop().unwrap();
            if current.f > self.cost[&current.at] + 1e-9 || !self.settled.insert(current.at) {
                continue; // superseded by a cheaper way here, or settled
            }
            self.settled_at.entry(current.at.0).or_default().push(current.at);
            for leg in hops_from(world, current.at.0) {
                if may_turn(world, current.at.1, current.at.0, leg.step) {
                    self.relax(current.at, leg);
                }
            }
        }
        let around = way_in(self);
        direct.into_iter().chain(around).min_by(|a, b| a.0.total_cmp(&b.0))
    }

    fn relax(&mut self, from: At, leg: Leg) {
        let cost = self.cost.get(&from).copied().unwrap_or(0.0) + leg.cost;
        let at = (leg.to, leg.behind);
        if self.cost.get(&at).is_none_or(|&best| cost < best - 1e-9) {
            self.cost.insert(at, cost);
            self.via.insert(at, (from, leg.step));
            self.open.push(Node { at, f: cost });
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
        .filter(|seg| seg.nodes.len() > 1)
        .filter_map(|seg| {
            let last = seg.nodes.len() - 1;
            let (to, step, behind, forward) = if seg.nodes[0] == at {
                (seg.nodes[last], seg.nodes[1], seg.nodes[last - 1], true)
            } else if seg.nodes[last] == at {
                (seg.nodes[0], seg.nodes[last - 1], seg.nodes[1], false)
            } else {
                return None;
            };
            if !seg.ways[usize::from(!forward)] {
                return None;
            }
            Some(Leg { to, step, behind, cost: world.network.run_cost_ms(seg, forward, CRUISE_SPEED) })
        })
        .collect()
}

/// The junctions this node's own stretch leads to, with what it costs to get
/// there from where it stands. A junction leads to itself, for nothing.
fn junctions_from(world: &World, from: EntityId) -> Vec<Leg> {
    stretch_ends(world, from, true)
}

/// The junctions this node's own stretch can be reached from, named from the
/// node's side as `junctions_from` names them, costed the way they are
/// driven: in.
fn junctions_into(world: &World, to: EntityId) -> Vec<Leg> {
    stretch_ends(world, to, false)
}

fn stretch_ends(world: &World, node: EntityId, leaving: bool) -> Vec<Leg> {
    if world.network.is_junction(node) {
        return vec![Leg { to: node, cost: 0.0, step: node, behind: node }];
    }
    world
        .network
        .segments_at(node)
        .flat_map(|seg| {
            let Some(i) = seg.nodes.iter().position(|&n| n == node) else { return Vec::new() };
            let last = seg.nodes.len() - 1;
            // Part of a stretch has no record of its own, so it is charged
            // its share of the whole stretch's — otherwise joining a road
            // halfway along would look like a way of dodging the traffic on
            // it.
            let part = |lo: usize, hi: usize, forward: bool| {
                let share = run_length(world, &seg.nodes[lo..=hi]) / seg.length.max(1e-9);
                world.network.run_cost_ms(seg, forward, CRUISE_SPEED) * share
            };
            // Toward the start is against the run when leaving, along it when
            // coming in; and the other way about.
            let mut legs = Vec::new();
            if i > 0 && seg.ways[usize::from(leaving)] {
                legs.push(Leg { to: seg.nodes[0], cost: part(0, i, !leaving), step: seg.nodes[i - 1], behind: seg.nodes[1] });
            }
            if i < last && seg.ways[usize::from(!leaving)] {
                legs.push(Leg { to: seg.nodes[last], cost: part(i, last, leaving), step: seg.nodes[i + 1], behind: seg.nodes[last - 1] });
            }
            legs
        })
        .collect()
}

/// The tiles from `at` to `to`, leaving by `step`, both ends included.
///
/// Walked by the step rather than looked up by where the two ends stand,
/// because a stretch can end where it began: a loop that leaves a junction
/// and comes back to it holds that junction at both ends, and only the step
/// says which.
fn along(world: &World, at: EntityId, step: EntityId, to: EntityId) -> Option<Vec<EntityId>> {
    world.network.segments_at(at).find_map(|seg| {
        let n = &seg.nodes;
        let (i, ahead) = (0..n.len()).find_map(|i| match (n[i] == at, n.get(i + 1) == Some(&step), i > 0 && n[i - 1] == step) {
            (true, true, _) => Some((i, true)),
            (true, _, true) => Some((i, false)),
            _ => None,
        })?;
        let run: Vec<EntityId> = if ahead { n[i..].to_vec() } else { n[..=i].iter().rev().copied().collect() };
        let end = run.iter().skip(1).position(|&x| x == to)? + 1;
        Some(run[..=end].to_vec())
    })
}

/// Both on the same stretch, and where along it.
fn same_stretch(world: &World, a: EntityId, b: EntityId) -> Option<(&Segment, usize, usize)> {
    world.network.segments_at(a).find_map(|seg| {
        let i = seg.nodes.iter().position(|&n| n == a)?;
        let j = seg.nodes.iter().position(|&n| n == b)?;
        Some((seg, i, j))
    })
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
        open.push(Node { at: (start, start), f: heuristic(start) });

        while let Some(current) = open.pop() {
            if current.at.0 == end {
                let mut route = vec![end];
                let mut node = end;
                while let Some(&prev) = came_from.get(&node) {
                    route.push(prev);
                    node = prev;
                }
                route.reverse();
                return Some(route);
            }
            let here = *g.get(&current.at.0).unwrap_or(&f64::INFINITY);
            let outgoing = match world.objects.get(current.at.0) {
                Some(e) => match &e.object {
                    GameObject::RoadNode(node) => node.outgoing.clone(),
                    _ => continue,
                },
                None => continue,
            };
            for neighbour in outgoing {
                let cost = here + world.segment_length(current.at.0, neighbour);
                if g.get(&neighbour).is_none_or(|&best| cost < best) {
                    g.insert(neighbour, cost);
                    came_from.insert(neighbour, current.at.0);
                    open.push(Node { at: (neighbour, neighbour), f: cost + heuristic(neighbour) });
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

    /// A town of streets: a grid of them nine tiles by seven, every other
    /// one broken off short, and two long diagonals across it, so a route
    /// has junctions of every kind to find its way through.
    fn a_town_of_streets() -> World {
        let mut world = World::new();
        for y in -2..100 {
            for x in -2..100 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        for (i, y) in (0..98).step_by(7).enumerate() {
            world.place_road_path(&(0..if i % 2 == 0 { 98 } else { 60 }).map(|x| GridCoord { x, y }).collect::<Vec<_>>());
        }
        for (i, x) in (0..98).step_by(9).enumerate() {
            world.place_road_path(&(if i % 2 == 0 { 0 } else { 30 }..98).map(|y| GridCoord { x, y }).collect::<Vec<_>>());
        }
        world.place_road_path(&(0..98).map(|k| GridCoord { x: k, y: k }).collect::<Vec<_>>());
        world.place_road_path(&(0..98).map(|k| GridCoord { x: k, y: 97 - k }).collect::<Vec<_>>());
        world
    }

    /// The claim in one test: over a town of streets, searching by
    /// stretches finds a route of the same length as searching tile by
    /// tile, and one a car can actually drive.
    #[test]
    fn it_finds_what_the_tile_search_finds() {
        let world = a_town_of_streets();
        let nodes: Vec<EntityId> = world
            .objects
            .roads()
            .filter(|e| matches!(e.object, GameObject::RoadNode(_)))
            .map(|e| e.id)
            .collect();
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

    /// Every other row of the town made one-way, eastward, the rows between
    /// left as they were: the search over stretches must keep to them as the
    /// tile search does, which reads only what each node lets out.
    #[test]
    fn it_keeps_to_one_ways_as_the_tile_search_does() {
        let mut world = a_town_of_streets();
        for y in (7..98).step_by(14) {
            for x in 0..97 {
                let (Some(a), Some(b)) = (
                    world.road_node_at(GridCoord { x, y }),
                    world.road_node_at(GridCoord { x: x + 1, y }),
                ) else {
                    continue;
                };
                if let Some(GameObject::RoadNode(n)) = world.objects.get_mut(b).map(|e| &mut e.object) {
                    n.outgoing.retain(|&o| o != a);
                }
                world.remove_edge(b, a);
            }
        }
        let nodes: Vec<EntityId> = world.objects.roads().map(|e| e.id).collect();
        let picks: Vec<EntityId> = (0..40).map(|i| nodes[i * nodes.len() / 40]).collect();
        let mut compared = 0;
        for (i, &from) in picks.iter().enumerate() {
            let to = picks[(i + 17) % picks.len()];
            let (mine, theirs) = (find_path(&world, from, to), find_path_tile_by_tile(&world, from, to));
            assert_eq!(mine.is_some(), theirs.is_some(), "{from} -> {to}: one search found a way, the other none");
            let (Some(mine), Some(theirs)) = (mine, theirs) else { continue };
            compared += 1;
            assert!(
                mine.windows(2).all(|p| world.edges.contains_key(&(p[0], p[1]))),
                "{from} -> {to}: the route runs the wrong way up a one-way",
            );
            let (a, b) = (total(&world, &mine), total(&world, &theirs));
            assert!((a - b).abs() < 1e-6, "{from} -> {to}: by stretches {a}, tile by tile {b}");
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

    /// A street that ends in a loop: out from one junction and back to it,
    /// with nothing else joining it, so the whole loop is one stretch that
    /// holds that junction at both ends. A door on the loop is reached, and
    /// left, like a door anywhere else.
    #[test]
    fn a_loop_off_one_junction_is_driven() {
        let mut world = straight_world();
        let at = |x, y| GridCoord { x, y };
        world.place_road_path(&(0..=3).map(|x| at(x, 0)).collect::<Vec<_>>());
        let mut ring: Vec<GridCoord> = (3..=6).map(|x| at(x, 0)).collect();
        ring.extend((1..=4).map(|y| at(6, y)));
        ring.extend((3..6).rev().map(|x| at(x, 4)));
        ring.extend((0..4).rev().map(|y| at(3, y)));
        world.place_road_path(&ring);
        let junction = world.road_node_at(at(3, 0)).unwrap();
        assert!(world.network.segments_at(junction).any(|s| s.is_ring()), "the loop is one stretch, both ends at the junction");

        let node = |x, y| world.road_node_at(at(x, y)).unwrap();
        for (from, to) in [(node(0, 0), node(6, 2)), (node(6, 2), node(0, 0)), (node(5, 4), node(6, 1)), (node(3, 2), node(5, 0)), (junction, node(4, 4))] {
            let route = find_path(&world, from, to).unwrap_or_else(|| panic!("{from} -> {to}: no way"));
            assert_eq!((route.first(), route.last()), (Some(&from), Some(&to)));
            assert!(joined_up(&world, &route), "{from} -> {to}: route has a gap in it");
            let tile_by_tile = find_path_tile_by_tile(&world, from, to).unwrap();
            assert!((total(&world, &route) - total(&world, &tile_by_tile)).abs() < 1e-6, "{from} -> {to}: the long way round");
        }
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
