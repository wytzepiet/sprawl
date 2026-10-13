use std::collections::HashSet;

use crate::protocol::{EntityId, GameObject, GridCoord, RoadNode};
use crate::world::World;

impl World {
    /// The road on this tile.
    pub fn road_node_at(&self, coord: GridCoord) -> Option<EntityId> {
        self.roads.get(&(coord.x, coord.y)).copied()
    }

    /// Place a road node at coord. Idempotent: returns the node already
    /// standing here, whatever kind it is. `laid` is the mayor's own hand,
    /// counted against the build; the survey's roads and driveways are
    /// streets, laid by nobody, and free.
    fn place_road_of(&mut self, coord: GridCoord, road: bool, laid: bool) -> EntityId {
        if let Some(id) = self.road_node_at(coord) {
            return id;
        }

        let id = self.insert_at(
            GameObject::RoadNode(RoadNode {
                outgoing: vec![],
                incoming: vec![],
                joined: false,
                road,
                laid,
                height: 0,
                light: None,
                wide: vec![],
                side: super::decks::MIDDLE,
            }),
            Some(coord),
        );
        self.roads.insert((coord.x, coord.y), id);
        self.laid += laid as u32;
        self.unsettle_round(coord);
        id
    }

    /// A node's neighbours.
    pub fn arms_of(&self, id: EntityId, outgoing_only: bool) -> Vec<EntityId> {
        let Some(entry) = self.objects.get(id) else { return Vec::new() };
        let GameObject::RoadNode(ref node) = entry.object else { return Vec::new() };
        if outgoing_only {
            node.outgoing.clone()
        } else {
            node.outgoing.iter().chain(node.incoming.iter()).copied().collect()
        }
    }

    /// Would a new arm at `coord`, toward (dx, dy), give a car a turn
    /// sharper than a right angle: in by one arm and out by another within
    /// ninety degrees of it. Only the turns a car can make count, so a
    /// one-way may join a road at a shallow angle, a merge, as long as
    /// nothing could turn back along it. `arriving`: cars come in to
    /// `coord` along the new arm; `leaving`: they go out along it.
    pub(super) fn would_turn_sharply(&self, coord: GridCoord, dx: i32, dy: i32, arriving: bool, leaving: bool) -> bool {
        let Some(id) = self.road_node_at(coord) else { return false };
        self.arms_of(id, false).into_iter().any(|nid| {
            let Some(npos) = self.objects.get(nid).and_then(|n| n.position) else { return false };
            let ahead = (npos.x - coord.x) * dx + (npos.y - coord.y) * dy > 0;
            ahead && ((arriving && self.edges.contains_key(&(id, nid))) || (leaving && self.edges.contains_key(&(nid, id))))
        })
    }

    /// Does the road from `a` to `b` have two lanes?
    pub fn is_wide(&self, a: EntityId, b: EntityId) -> bool {
        matches!(self.objects.get(a).map(|e| &e.object), Some(GameObject::RoadNode(n)) if n.wide.contains(&b))
    }

    /// The road from `a` to `b` has two lanes (or not).
    pub fn set_wide(&mut self, a: EntityId, b: EntityId, wide: bool) {
        if let Some(GameObject::RoadNode(n)) = self.objects.get_mut(a).map(|e| &mut e.object) {
            n.wide.retain(|&x| x != b);
            if wide {
                n.wide.push(b);
            }
        }
        if let Some(seg) = self.edges.get_mut(&(a, b)) {
            seg.lanes = if wide { 2 } else { 1 };
        }
    }

    /// The lane a car keeps on the edge into each node of a route. On a
    /// road of two lanes it is chosen for the stretch's end: the right lane
    /// for a right turn at the junction there, the left for a left, the
    /// emptier going straight on; where the road has one lane, that one.
    /// Kept the length of the stretch: a car changes lanes at junctions.
    pub fn lanes_for(&self, route: &[EntityId]) -> Vec<u8> {
        let mut lanes = vec![0u8; route.len()];
        let wide = |k: usize| self.edges.get(&(route[k - 1], route[k])).is_some_and(|s| s.lanes > 1);
        let pos = |id: EntityId| self.objects.get(id).and_then(|e| e.position);
        let mut k = 1;
        while k < route.len() {
            let mut j = k;
            while j + 1 < route.len() && !self.network.is_junction(route[j]) {
                j += 1;
            }
            if (k..=j).any(wide) {
                let turn = (j + 1 < route.len()).then(|| (pos(route[j - 1]), pos(route[j]), pos(route[j + 1]))).and_then(|p| match p {
                    (Some(a), Some(b), Some(c)) => Some((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)),
                    _ => None,
                });
                // Toward the side the lanes keep to, (-dy, dx), is right.
                let lane = match turn {
                    Some(t) if t > 0 => 0,
                    Some(t) if t < 0 => 1,
                    _ => {
                        let first = (k..=j).find(|&i| wide(i)).unwrap();
                        let seg = &self.edges[&(route[first - 1], route[first])];
                        let count = |l: usize| seg.all().filter(|&c| seg.lane_of(c) == Some(l)).count();
                        u8::from(count(1) < count(0))
                    }
                };
                for i in k..=j {
                    if wide(i) {
                        lanes[i] = lane;
                    }
                }
            }
            k = j + 1;
        }
        lanes
    }

    /// The road between two nodes given priority, or its priority taken:
    /// both ends made through road's, or each end that no other through
    /// road reaches made a street's, so the rest of a priority road it
    /// runs off keeps it.
    pub fn set_priority(&mut self, a: EntityId, b: EntityId, road: bool) {
        for (n, other) in [(a, b), (b, a)] {
            let kept = road || self.arms_of(n, false).into_iter().any(|m| m != other && self.is_road(m));
            if let Some(GameObject::RoadNode(node)) = self.objects.get_mut(n).map(|e| &mut e.object) {
                node.road = kept && (road || node.road);
            }
        }
    }

    /// A through road, which has priority over the streets that meet it.
    pub fn is_road(&self, id: EntityId) -> bool {
        matches!(self.objects.get(id).map(|e| &e.object), Some(GameObject::RoadNode(n)) if n.road)
    }

    /// Check if two nodes at the given coords are connected as outgoing.
    pub fn are_connected(&self, a: GridCoord, b: GridCoord) -> bool {
        let a_id = match self.road_node_at(a) {
            Some(id) => id,
            None => return false,
        };
        let b_id = match self.road_node_at(b) {
            Some(id) => id,
            None => return false,
        };
        if let Some(entry) = self.objects.get(a_id)
            && let GameObject::RoadNode(ref node) = entry.object {
                return node.outgoing.contains(&b_id) || node.incoming.contains(&b_id);
            }
        false
    }

    /// Place road nodes at `from` and `to`, and connect them as outgoing.
    /// The mayor's own hand: what it lays is counted against the build.
    /// May a road be laid from one tile to the next: the one rule, which the
    /// mayor's hand is refused by and the map of where a road may go is
    /// drawn from.
    pub fn may_lay(&self, from: GridCoord, to: GridCoord, one_way: bool) -> bool {
        let (dx, dy) = (to.x - from.x, to.y - from.y);
        if (dx, dy) == (0, 0) || dx.abs() > 1 || dy.abs() > 1 {
            return false;
        }
        // Not over water, down onto a beach or up a mountain: a road
        // already there, a bridge the survey laid, may be carried on from.
        let wet = |t: GridCoord| {
            self.road_node_at(t).is_none()
                && matches!(self.terrain.get(&(t.x, t.y)), Some(crate::protocol::TerrainType::Water | crate::protocol::TerrainType::Sea | crate::protocol::TerrainType::Beach | crate::protocol::TerrainType::Mountain))
        };
        if wet(from) || wet(to) {
            return false;
        }
        // A road may end on a building — that is its door — but never start
        // on one, or it would run in one side and out the other.
        if self.claimed_plot_at(from).is_some() {
            return false;
        }
        let into_building = self.claimed_plot_at(to).is_some();
        // A building is entered where its entry rule allows, whatever the angle.
        if into_building && !self.may_enter_plot(from, to) {
            return false;
        }
        if self.are_connected(from, to) {
            return false;
        }
        if dx.abs() == 1 && dy.abs() == 1 && self.are_connected(GridCoord { x: from.x + dx, y: from.y }, GridCoord { x: from.x, y: from.y + dy }) {
            return false;
        }
        // Out of `from` and in to `to`, and the other way too unless it is
        // one way. Into a building, nothing stands on its tile to turn from.
        !self.would_turn_sharply(from, dx, dy, !one_way, true) && (into_building || !self.would_turn_sharply(to, -dx, -dy, true, !one_way))
    }

    pub fn handle_place_road(&mut self, from: GridCoord, to: GridCoord, one_way: bool, road: bool) {
        if !self.may_lay(from, to, one_way) {
            return;
        }
        // Into a building is its door, moved here: the street it runs
        // from is laid, and nothing on the building's tile.
        if let Some(id) = self.claimed_plot_at(to) {
            self.place_road_of(from, road, true);
            self.door_through(id, from, to);
            // Reached, as by a survey road: a depot's fleet and a farm's
            // land come with the door, not with the first call.
            self.orient(id);
            return;
        }

        let from_id = self.place_road_of(from, road, true);
        let to_id = self.place_road_of(to, road, true);
        // A through road drawn across a street makes the tiles it crosses
        // its own, so it keeps its priority there; unless a building stands
        // beside the street, which fronts it.
        if road {
            for (id, at) in [(from_id, from), (to_id, to)] {
                let fronted = (-1..=1).any(|dy| (-1..=1).any(|dx| self.occupied.contains_key(&(at.x + dx, at.y + dy))));
                if !fronted
                    && let Some(GameObject::RoadNode(node)) = self.objects.get_mut(id).map(|e| &mut e.object)
                {
                    node.road = true;
                }
            }
        }

        if let Some(entry) = self.objects.get_mut(from_id)
            && let GameObject::RoadNode(ref mut node) = entry.object
                && !node.outgoing.contains(&to_id) {
                    node.outgoing.push(to_id);
                }

        if one_way {
            if let Some(entry) = self.objects.get_mut(to_id)
                && let GameObject::RoadNode(ref mut node) = entry.object
                    && !node.incoming.contains(&from_id) {
                        node.incoming.push(from_id);
                    }
        } else if let Some(entry) = self.objects.get_mut(to_id)
        && let GameObject::RoadNode(ref mut node) = entry.object
            && !node.outgoing.contains(&from_id) {
                node.outgoing.push(from_id);
            }
        // A new arm on a door's street may make its drive a hairpin.
        self.unsettle_round(from);
        self.unsettle_round(to);
    }

    /// Lay a street along a path, both ways, with no player-input checks:
    /// test worlds.
    #[cfg(test)]
    pub fn place_road_path(&mut self, path: &[GridCoord]) {
        self.place_road_path_of(path, false);
    }

    /// Lay a street or a road along a path and connect consecutive nodes
    /// both ways. Free: a fixture's roads are not the mayor's tiles.
    pub fn place_road_path_of(&mut self, path: &[GridCoord], road: bool) {
        if path.len() < 2 {
            return;
        }
        // Expand diagonal steps through existing road nodes to avoid triangles
        let mut expanded: Vec<GridCoord> = vec![path[0]];
        for pair in path.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            if dx != 0 && dy != 0 {
                let mid1 = GridCoord { x: a.x + dx, y: a.y };
                let mid2 = GridCoord { x: a.x, y: a.y + dy };
                if self.road_node_at(mid1).is_some() {
                    expanded.push(mid1);
                } else if self.road_node_at(mid2).is_some() {
                    expanded.push(mid2);
                }
            }
            expanded.push(b);
        }
        let ids: Vec<_> = expanded.iter().map(|&c| self.place_road_of(c, road, false)).collect();
        for pair in ids.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            // Add outgoing a→b
            if let Some(entry) = self.objects.get_mut(a)
                && let GameObject::RoadNode(ref mut node) = entry.object
                    && !node.outgoing.contains(&b) {
                        node.outgoing.push(b);
                    }
            // Add outgoing b→a
            if let Some(entry) = self.objects.get_mut(b)
                && let GameObject::RoadNode(ref mut node) = entry.object
                    && !node.outgoing.contains(&a) {
                        node.outgoing.push(a);
                    }
            self.insert_edge(a, b);
            self.insert_edge(b, a);
        }
        // A street reaches whatever dormant building stands beside it — once
        // the nodes are joined, since a building reached stables its fleet
        // in a lot read off its door and the street it joins.
        self.open_doors_along(&expanded);
    }

    /// A ground node for the mayor's road, or the one there.
    pub(super) fn place_ground(&mut self, coord: GridCoord, road: bool) -> EntityId {
        self.place_road_of(coord, road, true)
    }

    /// Lay a one-way along a path, the way it runs, with no player-input
    /// checks: a level's gates. Free, as a fixture's roads are.
    pub fn place_one_way_of(&mut self, path: &[GridCoord], road: bool) {
        let ids: Vec<_> = path.iter().map(|&c| self.place_road_of(c, road, false)).collect();
        for pair in ids.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            if let Some(GameObject::RoadNode(node)) = self.objects.get_mut(a).map(|e| &mut e.object)
                && !node.outgoing.contains(&b)
            {
                node.outgoing.push(b);
            }
            if let Some(GameObject::RoadNode(node)) = self.objects.get_mut(b).map(|e| &mut e.object)
                && !node.incoming.contains(&a)
            {
                node.incoming.push(a);
            }
            self.insert_edge(a, b);
        }
    }

    /// Two road nodes let go of each other, both ways: the link and the
    /// edges along it.
    pub fn unlink_roads(&mut self, a: EntityId, b: EntityId) {
        for (x, y) in [(a, b), (b, a)] {
            if let Some(GameObject::RoadNode(n)) = self.objects.get_mut(x).map(|e| &mut e.object) {
                n.outgoing.retain(|&o| o != y);
                n.incoming.retain(|&i| i != y);
            }
        }
        for (x, y) in [(a, b), (b, a)] {
            if self.edges.contains_key(&(x, y)) {
                self.remove_edge(x, y);
            }
        }
        for n in [a, b] {
            if let Some(at) = self.objects.get(n).and_then(|e| e.position) {
                self.unsettle_round(at);
            }
        }
    }

    /// Remove a road node by id and clean up every reference to it. A tile
    /// the mayor laid is refunded.
    pub fn demolish_node(&mut self, id: EntityId) {
        let Some(pos) = self.objects.get(id).and_then(|e| e.position) else { return };
        let (neighbor_ids, incoming_ids, laid) = match self.objects.get(id) {
            Some(entry) => {
                if let GameObject::RoadNode(ref node) = entry.object {
                    (node.outgoing.clone(), node.incoming.clone(), node.laid)
                } else {
                    return;
                }
            }
            None => return,
        };
        self.laid -= laid as u32;

        for nid in neighbor_ids.iter().chain(incoming_ids.iter()) {
            if let Some(entry) = self.objects.get_mut(*nid)
                && let GameObject::RoadNode(ref mut node) = entry.object {
                    node.outgoing.retain(|&x| x != id);
                    node.incoming.retain(|&x| x != id);
                }
        }

        let middle = self.height_of(id) == 0 && self.side_of(id) == super::decks::MIDDLE;
        self.objects.remove(id);
        self.unindex(id, pos);
        if middle {
            self.roads.remove(&(pos.x, pos.y));
        } else if let Some(v) = self.decks.get_mut(&(pos.x, pos.y)) {
            v.retain(|&n| n != id);
        }
        self.settle_sides(pos);
        self.unsettle_round(pos);
    }

    /// Check if a node is an intersection (>2 unique connections).
    pub fn is_intersection(&self, node_id: EntityId) -> bool {
        self.unique_connection_count(node_id) > 2
    }

    /// Count what the mayor has laid, from the nodes' own flags.
    pub fn rebuild_laid(&mut self) {
        self.laid = self
            .objects
            .roads()
            .filter(|e| matches!(e.object, GameObject::RoadNode(ref n) if n.laid))
            .count() as u32;
    }

    pub(super) fn unique_connection_count(&self, node_id: EntityId) -> usize {
        let unique: HashSet<EntityId> = self.arms_of(node_id, false).into_iter().collect();
        unique.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::TerrainType;

    /// Grass, and a one-way street east along y = 0.
    fn eastward() -> World {
        let mut world = World::new();
        for y in -4..5 {
            for x in -2..12 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        world.place_one_way_of(&(0..10).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>(), false);
        world
    }

    const fn at(x: i32, y: i32) -> GridCoord {
        GridCoord { x, y }
    }

    /// A one-way may join a road at a shallow angle, an on-ramp, where
    /// nothing could turn back along it; and leave one so, an off-ramp.
    /// A two-way may not: a car could turn back along it, sharper than a
    /// right angle. Nor may a one-way that could only be joined by such a
    /// turn.
    #[test]
    fn a_one_way_may_merge_at_a_shallow_angle() {
        let world = eastward();
        assert!(world.may_lay(at(4, -1), at(5, 0), true), "an on-ramp from behind");
        assert!(!world.may_lay(at(4, -1), at(5, 0), false), "a two-way ramp offers the turn back");
        assert!(world.may_lay(at(5, 0), at(6, -1), true), "an off-ramp ahead");
        assert!(!world.may_lay(at(6, -1), at(5, 0), true), "a ramp joining against the traffic");
        assert!(!world.may_lay(at(5, 0), at(4, -1), true), "a ramp leaving back the way the road came");
        // On a two-way street, no ramp at all: a turn back is always there.
        let mut both = World::new();
        both.terrain = world.terrain.clone();
        both.place_road_path(&(0..10).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>());
        assert!(!both.may_lay(at(4, -1), at(5, 0), true));
        // Square on, any road joins any.
        assert!(both.may_lay(at(5, -1), at(5, 0), false));
    }

    /// A one-way laid back along a one-way goes beside it, the other on the
    /// other side of their tiles: two thin roads side by side. A street
    /// joins the one on its own side, in and out to the right; the other
    /// is out of its reach. Either side may run either way; and when the
    /// one goes, the other is back in the middle.
    #[test]
    fn one_ways_go_side_by_side() {
        use super::super::decks::{MIDDLE, Side};
        let mut world = eastward();
        const NORTH: Side = [0, -1];
        const SOUTH: Side = [0, 1];
        assert!(!world.may_lay(at(6, 0), at(5, 0), true), "not into the same middles");
        for x in (1..10).rev() {
            assert!(world.may_lay_at(at(x, 0), 0, NORTH, at(x - 1, 0), 0, NORTH, true), "westward at {x}, beside it");
            world.place_road_at(at(x, 0), 0, NORTH, at(x - 1, 0), 0, NORTH, true, false);
        }
        assert!(world.road_node_at(at(5, 0)).is_none(), "nothing in the middle");
        let east = |w: &World, x| w.node_in(at(x, 0), 0, SOUTH).unwrap();
        let west = |w: &World, x| w.node_in(at(x, 0), 0, NORTH).unwrap();
        assert!(world.edges.contains_key(&(east(&world, 4), east(&world, 5))), "the eastward road, moved over, still runs");
        assert!(!world.may_lay_at(at(5, 1), 0, MIDDLE, at(5, 0), 0, NORTH, false), "not across the near road to the far one");
        assert!(!world.may_lay_at(at(5, 0), 0, SOUTH, at(6, 0), 0, NORTH, true), "not from one side to the other");
        // A street from the south, onto the near side.
        world.place_road_path(&(1..4).map(|y| at(5, y)).collect::<Vec<_>>());
        assert!(world.may_lay_at(at(5, 1), 0, MIDDLE, at(5, 0), 0, SOUTH, false));
        world.place_road_at(at(5, 1), 0, MIDDLE, at(5, 0), 0, SOUTH, false, false);
        let street = world.road_node_at(at(5, 3)).unwrap();
        let route = |w: &World, from, to| crate::world::pathfinding::Routes::from(w, from).route_to(to);
        assert!(route(&world, east(&world, 0), street).is_some(), "right off it");
        assert!(route(&world, street, east(&world, 9)).is_some(), "right onto it");
        assert!(route(&world, west(&world, 9), street).is_none(), "the far side has no way to it");
        assert!(route(&world, street, west(&world, 0)).is_none(), "nor it to the far side");
        // On the wrong side: a pair that keeps left is still a pair.
        let mut left = eastward();
        for x in (1..10).rev() {
            assert!(left.may_lay_at(at(x, 0), 0, SOUTH, at(x - 1, 0), 0, SOUTH, true));
            left.place_road_at(at(x, 0), 0, SOUTH, at(x - 1, 0), 0, SOUTH, true, false);
        }
        assert_eq!(left.side_of(left.nodes_on(at(5, 0)).into_iter().map(|(_, id)| id).find(|&id| left.arms_of(id, true).iter().any(|&n| left.objects.get(n).and_then(|e| e.position) == Some(at(6, 0)))).unwrap()), NORTH);
        // One side gone: the other is back in the middle.
        let gone = west(&world, 2);
        world.demolish_node(gone);
        assert!(world.road_node_at(at(2, 0)).is_some(), "the eastward road back in the middle");
        assert!(world.node_in(at(2, 0), 0, SOUTH).is_none());
    }
}
