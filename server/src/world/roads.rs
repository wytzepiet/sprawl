use crate::protocol::{EntityId, GameObject, GridCoord, RoadNode};
use crate::world::World;

impl World {
    /// The road on this tile.
    pub fn road_node_at(&self, coord: GridCoord) -> Option<EntityId> {
        self.roads.get(&(coord.x, coord.y)).copied()
    }

    /// Place a road node at coord. Idempotent: returns the node already
    /// standing here, whatever kind it is. `laid` is the mayor's own hand,
    /// counted to be paid for; a fixture's or a level's roads and
    /// driveways are streets, laid by nobody, and free.
    fn place_road_of(&mut self, coord: GridCoord, laid: bool) -> EntityId {
        if let Some(id) = self.road_node_at(coord) {
            return id;
        }

        let id = self.insert_at(
            GameObject::RoadNode(RoadNode {
                outgoing: vec![],
                incoming: vec![],
                joined: false,
                road: vec![],
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
    /// ninety degrees of it. A driveway may not (`driveway_reaches`).
    /// `arriving`: cars come in to `coord` along the new arm; `leaving`:
    /// they go out along it.
    pub(super) fn would_turn_sharply(&self, coord: GridCoord, dx: i32, dy: i32, arriving: bool, leaving: bool) -> bool {
        let Some(id) = self.road_node_at(coord) else { return false };
        self.arms_of(id, false).into_iter().any(|nid| {
            let Some(npos) = self.objects.get(nid).and_then(|n| n.position) else { return false };
            // An arm to the tile the new one goes to: going back, which no
            // car does (`pathfinding::may_turn`).
            if (npos.x - coord.x, npos.y - coord.y) == (dx, dy) {
                return false;
            }
            let ahead = (npos.x - coord.x) * dx + (npos.y - coord.y) * dy > 0;
            ahead && ((arriving && self.edges.contains_key(&(id, nid))) || (leaving && self.edges.contains_key(&(nid, id))))
        })
    }

    /// Would a new arm at node `id`, toward (dx, dy), lead nowhere: its
    /// cars, coming in along it (`arriving`) or going out along it
    /// (`leaving`), with roads to turn onto there and every one of them a
    /// turn sharper than a right angle, which no car makes
    /// (`pathfinding::may_turn`). A road may meet another at any angle as
    /// long as its cars can go on the shallow way; a hairpin, they cannot.
    /// `on`: the way the drag goes on from there, if it does: its cars go
    /// on along it, if that is no sharp turn.
    pub(super) fn leads_nowhere(&self, id: EntityId, (dx, dy): (i32, i32), arriving: bool, leaving: bool, on: Option<(i32, i32)>) -> bool {
        let Some(at) = self.objects.get(id).and_then(|e| e.position) else { return false };
        let new = GridCoord { x: at.x + dx, y: at.y + dy };
        let shallow = |p: GridCoord| super::pathfinding::shallow(p, at, new);
        if on.is_some_and(|(x, y)| shallow(GridCoord { x: at.x + x, y: at.y + y })) {
            return false;
        }
        let arms: Vec<(EntityId, bool)> = self.arms_of(id, false).into_iter().filter_map(|nid| Some((nid, shallow(self.objects.get(nid)?.position?)))).collect();
        let none = |out: bool| {
            let ways: Vec<bool> = arms.iter().filter(|&&(n, _)| if out { self.edges.contains_key(&(id, n)) } else { self.edges.contains_key(&(n, id)) }).map(|&(_, shallow)| shallow).collect();
            !ways.is_empty() && !ways.contains(&true)
        };
        (arriving && none(true)) || (leaving && none(false))
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

    /// The lane a car enters each stretch of a route by, on the edge into
    /// each node of it, where the road has two: off a road of two, the lane
    /// it was in, bend as the road may; in from a road of one beside it,
    /// the lane on that side, as a car joining a road takes the near lane,
    /// or where roads of one join into it, its own (`branch_lane`);
    /// setting out, the emptier. It keeps it until it changes lanes
    /// (`car::simulation`), never inside a junction.
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
                let side = match (k.checked_sub(2).map(|p| pos(route[p])), pos(route[k - 1]), pos(route[k])) {
                    (Some(Some(p)), Some(at), Some(n)) => {
                        // Toward the side the lanes keep to, (-dy, dx), is right.
                        let (dx, dy) = (n.x - at.x, n.y - at.y);
                        Some(-dy * (p.x - at.x) + dx * (p.y - at.y))
                    }
                    _ => None,
                };
                let lane = match side {
                    _ if k >= 2 && wide(k - 1) => lanes[k - 1],
                    _ if let Some(l) = k.checked_sub(2).and_then(|p| self.branch_lane(route[p], route[k - 1], route[k])) => l,
                    Some(s) if s > 0 => 0,
                    Some(s) if s < 0 => 1,
                    Some(_) => lanes[k - 1],
                    None => {
                        let first = (k..=j).find(|&i| wide(i)).unwrap();
                        let seg = &self.edges[&(route[first - 1], route[first])];
                        u8::from(seg.lane(1).count() < seg.lane(0).count())
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

    /// The lane of a road of two that a road of one goes on from, where
    /// the road of two splits into roads of one at `at` (`from` on it), or
    /// they join into it (`to` on it): each its own lane, as far as two go
    /// round. Ranked from the right, the right lane takes the right half of
    /// them, the left the rest: of three, the right lane the right and the
    /// straight on, the left lane the left, as a road of two comes to a
    /// crossroads. None where it is not such a node.
    pub fn branch_lane(&self, from: EntityId, at: EntityId, to: EntityId) -> Option<u8> {
        let pos = |id: EntityId| self.objects.get(id).and_then(|e| e.position);
        let lanes = |a: EntityId, b: EntityId| self.edges.get(&(a, b)).map(|s| s.lanes);
        let turn = |p: EntityId, n: EntityId| {
            let (a, b, c) = (pos(p)?, pos(at)?, pos(n)?);
            let (ix, iy, ox, oy) = ((b.x - a.x) as f64, (b.y - a.y) as f64, (c.x - b.x) as f64, (c.y - b.y) as f64);
            Some((ix * oy - iy * ox).atan2(ix * ox + iy * oy))
        };
        let arms = self.arms_of(at, false);
        // Each branch and how far right it lies, seen along the road of two.
        let (mine, branches): (EntityId, Vec<(EntityId, f64)>) = if lanes(from, at) == Some(2) {
            (to, arms.iter().filter(|&&o| o != from && self.edges.contains_key(&(at, o))).map(|&o| Some((o, turn(from, o)?))).collect::<Option<_>>()?)
        } else if lanes(at, to) == Some(2) {
            (from, arms.iter().filter(|&&o| o != to && self.edges.contains_key(&(o, at))).map(|&o| Some((o, turn(o, to)?))).collect::<Option<_>>()?)
        } else {
            return None;
        };
        let wide = |&(o, _): &(EntityId, f64)| if mine == to { lanes(at, o) } else { lanes(o, at) } != Some(1);
        if branches.len() < 2 || branches.iter().any(wide) {
            return None;
        }
        let rank = branches.iter().filter(|&&(o, r)| o != mine && r > branches.iter().find(|b| b.0 == mine).map_or(0.0, |b| b.1)).count();
        Some(u8::from(rank >= branches.len().div_ceil(2)))
    }

    /// The lane the way out at node `j` of a route asks for, coming to it
    /// on a road of two, where the road splits there: the right lane for
    /// the way out furthest right, the left for the one furthest left. Not
    /// where it only bends or others join it, nor onto a road of two where
    /// the others are roads of one, as staying on a motorway past a ramp
    /// off it is from either lane; nor at the route's end. A bend asked for
    /// a lane, and cars stood waiting for one that took them nowhere else.
    pub fn turn_lane(&self, route: &[EntityId], j: usize) -> Option<u8> {
        let pos = |id: EntityId| self.objects.get(id).and_then(|e| e.position);
        let (from, at, to) = (*route.get(j.checked_sub(1)?)?, route[j], *route.get(j + 1)?);
        if let Some(l) = self.branch_lane(from, at, to) {
            return Some(l);
        }
        let (a, b) = (pos(from)?, pos(at)?);
        let wide = |o: EntityId| self.edges.get(&(at, o)).is_some_and(|s| s.lanes > 1);
        // How far round to the right a way out turns, as the lanes count
        // them: lane 0 the right.
        let right = |o: EntityId| {
            let c = pos(o)?;
            let (ix, iy, ox, oy) = ((b.x - a.x) as f64, (b.y - a.y) as f64, (c.x - b.x) as f64, (c.y - b.y) as f64);
            Some((ix * oy - iy * ox).atan2(ix * ox + iy * oy))
        };
        let others: Vec<EntityId> = self.arms_of(at, true).into_iter().filter(|&o| o != from && o != to).collect();
        if others.is_empty() || (wide(to) && !others.iter().any(|&o| wide(o))) {
            return None;
        }
        let (mine, theirs) = (right(to)?, others.iter().filter_map(|&o| right(o)).collect::<Vec<_>>());
        if theirs.iter().all(|&t| mine > t) {
            Some(0)
        } else if theirs.iter().all(|&t| mine < t) {
            Some(1)
        } else {
            None
        }
    }

    /// The way between two nodes made a through road's, or a street's.
    pub fn set_priority(&mut self, a: EntityId, b: EntityId, road: bool) {
        for (n, other) in [(a, b), (b, a)] {
            if let Some(GameObject::RoadNode(node)) = self.objects.get_mut(n).map(|e| &mut e.object) {
                node.road.retain(|&x| x != other);
                if road {
                    node.road.push(other);
                }
            }
        }
    }

    /// The way between two nodes is a through road, which has priority over
    /// the streets that meet it.
    pub fn is_road_between(&self, a: EntityId, b: EntityId) -> bool {
        matches!(self.objects.get(a).map(|e| &e.object), Some(GameObject::RoadNode(n)) if n.road.contains(&b))
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

    /// May a road be laid from one tile to the next: the one rule, which the
    /// mayor's hand is refused by and the map of where a road may go is
    /// drawn from.
    #[cfg(test)]
    pub fn may_lay(&self, from: GridCoord, to: GridCoord, one_way: bool) -> bool {
        self.may_lay_on(from, to, one_way, None)
    }

    /// `may_lay`, a drag going on from `to` that way, if it does
    /// (`leads_nowhere`).
    pub fn may_lay_on(&self, from: GridCoord, to: GridCoord, one_way: bool, on: Option<(i32, i32)>) -> bool {
        let (dx, dy) = (to.x - from.x, to.y - from.y);
        if (dx, dy) == (0, 0) || dx.abs() > 1 || dy.abs() > 1 {
            return false;
        }
        // Not over water, down onto a beach or up a mountain: a road
        // already there may be carried on from.
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
        // Out of `from` and in to `to`, and the other way too unless it is
        // one way. Into a building, nothing stands on its tile to turn from.
        !self.road_node_at(from).is_some_and(|id| self.leads_nowhere(id, (dx, dy), !one_way, true, None))
            && (into_building || !self.road_node_at(to).is_some_and(|id| self.leads_nowhere(id, (-dx, -dy), true, !one_way, on)))
    }

    pub fn handle_place_road(&mut self, from: GridCoord, to: GridCoord, one_way: bool, road: bool) {
        // Into a building is its door, moved here: the street it runs
        // from is laid, and nothing on the building's tile.
        if let Some(id) = self.claimed_plot_at(to) {
            self.place_road_of(from, true);
            self.door_through(id, from, to);
            // Reached, as by any street: a depot's fleet and a farm's
            // land come with the door, not with the first call.
            self.orient(id);
            return;
        }

        let from_id = self.place_road_of(from, true);
        let to_id = self.place_road_of(to, true);
        if road {
            self.set_priority(from_id, to_id, true);
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
        let ids: Vec<_> = expanded.iter().map(|&c| self.place_road_of(c, false)).collect();
        for pair in ids.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            if road {
                self.set_priority(a, b, true);
            }
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
    pub(super) fn place_ground(&mut self, coord: GridCoord) -> EntityId {
        self.place_road_of(coord, true)
    }

    /// Lay a one-way along a path, the way it runs, with no player-input
    /// checks: a level's gates. Free, as a fixture's roads are.
    pub fn place_one_way_of(&mut self, path: &[GridCoord], road: bool) {
        let ids: Vec<_> = path.iter().map(|&c| self.place_road_of(c, false)).collect();
        for pair in ids.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            if road {
                self.set_priority(a, b, true);
            }
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
                n.road.retain(|&r| r != y);
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
                    node.road.retain(|&x| x != id);
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

    /// Whether ways meet at a node: more than two roads, or more lanes in
    /// than out, as where two lanes become one. There who goes first is
    /// the junction's and the merge's to say, as anywhere ways meet.
    pub fn is_intersection(&self, node_id: EntityId) -> bool {
        let Some(GameObject::RoadNode(node)) = self.objects.get(node_id).map(|e| &e.object) else { return false };
        let arms = || node.outgoing.iter().chain(&node.incoming).copied();
        let lanes = |edge| self.edges.get(&edge).map_or(0, |s| s.lanes as usize);
        let distinct = arms().enumerate().filter(|&(i, n)| !arms().take(i).any(|m| m == n)).count();
        distinct > 2 || arms().map(|n| lanes((n, node_id))).sum::<usize>() > arms().map(|n| lanes((node_id, n))).sum::<usize>()
    }

    /// Count what the mayor has laid, from the nodes' own flags.
    pub fn rebuild_laid(&mut self) {
        self.laid = self
            .objects
            .roads()
            .filter(|e| matches!(e.object, GameObject::RoadNode(ref n) if n.laid))
            .count() as u32;
    }
}

#[cfg(test)]
pub(super) mod tests {
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

    /// A road may join another at a shallow angle as long as its cars can
    /// go on the shallow way: a one-way on-ramp from behind, an off-ramp
    /// ahead, a one-way onto a two-way street, turning the shallow way. Not
    /// one whose cars could only turn back, sharper than a right angle: a
    /// ramp against the traffic, or a two-way ramp, whose way out no car
    /// could reach.
    #[test]
    fn a_one_way_may_merge_at_a_shallow_angle() {
        let world = eastward();
        assert!(world.may_lay(at(4, -1), at(5, 0), true), "an on-ramp from behind");
        assert!(!world.may_lay(at(4, -1), at(5, 0), false), "a two-way ramp offers the turn back");
        assert!(world.may_lay(at(5, 0), at(6, -1), true), "an off-ramp ahead");
        assert!(!world.may_lay(at(6, -1), at(5, 0), true), "a ramp joining against the traffic");
        assert!(!world.may_lay(at(5, 0), at(4, -1), true), "a ramp leaving back the way the road came");
        // Onto a two-way street, a one-way, its cars turning the shallow way.
        let mut both = World::new();
        both.terrain = world.terrain.clone();
        both.place_road_path(&(0..10).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>());
        assert!(both.may_lay(at(4, -1), at(5, 0), true));
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
        assert!(!world.may_lay_at(at(6, 0), 0, NORTH, at(5, 0), 0, SOUTH, true), "not across it from side to side");
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
        // From a junction back along a one-way that came into it: beside it.
        let mut back = eastward();
        back.place_road_path(&(1..4).map(|y| at(9, y)).collect::<Vec<_>>());
        let (e9, s9) = (back.road_node_at(at(9, 0)).unwrap(), back.road_node_at(at(9, 1)).unwrap());
        back.insert_edge(e9, s9);
        back.insert_edge(s9, e9);
        if let Some(GameObject::RoadNode(n)) = back.objects.get_mut(e9).map(|e| &mut e.object) {
            n.outgoing.push(s9);
        }
        if let Some(GameObject::RoadNode(n)) = back.objects.get_mut(s9).map(|e| &mut e.object) {
            n.outgoing.push(e9);
        }
        assert!(back.may_lay_at(at(9, 0), 0, MIDDLE, at(8, 0), 0, NORTH, true), "back along the road it came in by");
        // Round a bend: east, then south; and back beside it all the way,
        // outside the bend, the one there moving in.
        let mut bend = World::new();
        bend.terrain = world.terrain.clone();
        bend.place_one_way_of(&[at(0, 0), at(1, 0), at(2, 0), at(3, 0), at(3, 1), at(3, 2), at(3, 3)], false);
        let (east, out): (Side, Side) = ([1, 0], [1, -1]);
        let back = [(at(3, 3), east), (at(3, 2), east), (at(3, 1), east), (at(3, 0), out), (at(2, 0), NORTH), (at(1, 0), NORTH), (at(0, 0), NORTH)];
        for w in back.windows(2) {
            let ((a, sa), (b, sb)) = (w[0], w[1]);
            assert!(bend.may_lay_at(a, 0, sa, b, 0, sb, true), "back beside it from {a:?} to {b:?}");
            bend.place_road_at(a, 0, sa, b, 0, sb, true, false);
        }
        assert!(bend.road_node_at(at(3, 0)).is_none(), "the corner is two roads");
        assert!(bend.node_in(at(3, 0), 0, [-1, 1]).is_some(), "the first inside the bend");
        let r = |w: &World, from, to| crate::world::pathfinding::Routes::from(w, from).route_to(to);
        assert!(r(&bend, bend.node_in(at(3, 3), 0, east).unwrap(), bend.node_in(at(0, 0), 0, NORTH).unwrap()).is_some(), "the way back drives");
        assert!(r(&bend, bend.node_in(at(0, 0), 0, SOUTH).unwrap(), bend.node_in(at(3, 3), 0, [-1, 0]).unwrap()).is_some(), "and the way out");
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
    /// The reachability index is maintained edit by edit rather than rebuilt,
    /// so the thing worth testing is that it never drifts from the graph it
    /// claims to describe. Brute-forces the answer and demands agreement.
    pub(in crate::world) fn agrees_with_the_edges(world: &World) {
        let mut adj: crate::fixed::HashMap<EntityId, Vec<EntityId>> =
            crate::fixed::HashMap::default();
        for &(a, b) in world.edges.keys() {
            adj.entry(a).or_default().push(b);
            adj.entry(b).or_default().push(a);
        }
        let nodes: Vec<EntityId> = adj.keys().copied().collect();
        for &from in &nodes {
            let mut seen = crate::fixed::HashSet::from_iter([from]);
            let mut stack = vec![from];
            while let Some(n) = stack.pop() {
                for &next in adj.get(&n).into_iter().flatten() {
                    if seen.insert(next) {
                        stack.push(next);
                    }
                }
            }
            for &to in &nodes {
                assert_eq!(
                    world.network.connected(from, to),
                    seen.contains(&to),
                    "index disagrees about {from} -> {to}",
                );
            }
        }
    }

    /// Demolition as the game loop does it: edges first, then the node.
    pub(in crate::world) fn lift_road(world: &mut World, at: GridCoord) {
        let Some(id) = world.road_node_at(at) else { return };
        for edge in world.edges_involving(id) {
            world.remove_edge(edge.0, edge.1);
        }
        world.demolish_node(id);
    }

    /// The world tells its network index (`network.rs`) of every road laid
    /// and lifted: a churn of streets on a small grid, by the world's own
    /// calls, and after each, which roads it says are joined is what the
    /// edges say, through cuts, rings and islands.
    #[test]
    fn the_network_follows_the_roads_laid_and_lifted() {
        let mut world = World::new();
        for y in -2..8 {
            for x in -2..8 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        let mut rng: u64 = 0x5eed;
        let mut roll = move |n: i32| {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((rng >> 33) % n as u64) as i32
        };
        // How many networks there are, by what the index says.
        let parts = |world: &World| {
            let nodes: Vec<EntityId> = world.objects.roads().map(|e| e.id).collect();
            nodes.iter().enumerate().filter(|&(i, &n)| !nodes[..i].iter().any(|&m| world.network.connected(m, n))).count()
        };
        let (mut cut, mut joined) = (false, false);
        for _ in 0..400 {
            let a = at(roll(5), roll(5));
            let b = if roll(2) == 0 { at(a.x + 1, a.y) } else { at(a.x, a.y + 1) };
            let linked = world.road_node_at(a).zip(world.road_node_at(b)).is_some_and(|(m, n)| world.edges.contains_key(&(m, n)));
            let before = parts(&world);
            if linked {
                lift_road(&mut world, if roll(2) == 0 { a } else { b });
                cut |= parts(&world) > before;
            } else if b.x < 5 && b.y < 5 {
                world.place_road_path(&[a, b]);
                joined |= parts(&world) < before;
            }
            agrees_with_the_edges(&world);
        }
        assert!(cut && joined, "the churn should both cut networks apart and join them");
    }
}
