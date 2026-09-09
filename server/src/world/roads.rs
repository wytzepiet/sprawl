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
            }),
            Some(coord),
        );
        self.roads.insert((coord.x, coord.y), id);
        self.laid += laid as u32;
        let beyond = !self.revealed.contains(&crate::world::chunk_of(coord));
        self.network.set_exit(id, beyond);
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

    /// Check if adding a connection in direction (dx, dy) at `coord` would create
    /// an angle sharper than 90° with existing connections.
    pub(super) fn would_be_too_sharp(&self, coord: GridCoord, dx: i32, dy: i32, outgoing_only: bool) -> bool {
        let id = match self.road_node_at(coord) {
            Some(id) => id,
            None => return false,
        };
        for nid in self.arms_of(id, outgoing_only) {
            if let Some(neighbor) = self.objects.get(nid)
                && let Some(npos) = neighbor.position {
                    let ndx = npos.x - coord.x;
                    let ndy = npos.y - coord.y;
                    if ndx * dx + ndy * dy > 0 {
                        return true;
                    }
                }
        }
        false
    }

    /// Check if two nodes at the given coords are connected as outgoing.
    pub(super) fn are_connected(&self, a: GridCoord, b: GridCoord) -> bool {
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
    pub fn handle_place_road(&mut self, from: GridCoord, to: GridCoord, one_way: bool, road: bool) {
        let dx = to.x - from.x;
        let dy = to.y - from.y;

        // A road may end on a plot — that is all a driveway is — but never start
        // on one, or it would run in one side and out the other.
        if self.claimed_plot_at(from).is_some() {
            return;
        }
        let into_building = self.claimed_plot_at(to).is_some();
        // A plot with a lot is entered through the lot, never through the
        // building: a road drawn at the building is refused, whatever its angle.
        if into_building && !self.may_enter_plot(from, to) {
            return;
        }
        if self.are_connected(from, to) {
            return;
        }
        if dx.abs() == 1 && dy.abs() == 1 {
            let cross_a = GridCoord { x: from.x + dx, y: from.y };
            let cross_b = GridCoord { x: from.x, y: from.y + dy };
            if self.are_connected(cross_a, cross_b) {
                return;
            }
        }
        if one_way {
            if self.would_be_too_sharp(from, dx, dy, true) {
                return;
            }
        } else if self.would_be_too_sharp(from, dx, dy, false)
            // Whatever driveway stands here is about to be replaced, so its arm
            // is not something the new one has to turn away from.
            || (!into_building && self.would_be_too_sharp(to, -dx, -dy, false))
        {
            return;
        }

        // A building takes exactly one driveway, and it is the newest: drawing
        // a road into it is how you move the old one. A lot takes any number
        // of entrances, and keeps the ones it has.
        if into_building && !self.is_lot_tile(to) {
            self.clear_driveway(to);
        }

        let from_id = self.place_road_of(from, road, true);
        let to_id = self.place_road_of(to, road, true);

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
    }

    /// Lay a street along a path, both ways, with no player-input checks:
    /// driveways and test worlds.
    pub fn place_road_path(&mut self, path: &[GridCoord]) {
        self.place_road_path_of(path, false);
    }

    /// Lay a street or a road along a path and connect consecutive nodes
    /// both ways. Free: the survey's roads are not the mayor's tiles.
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
        // A street reaches whatever dormant building stands beside it.
        self.attach_driveways_along(&expanded);
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
    }

    /// Remove the road node standing at `pos`.
    pub fn handle_demolish_road(&mut self, pos: GridCoord) {
        if let Some(id) = self.road_node_at(pos) {
            self.demolish_node(id);
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

        self.objects.remove(id);
        self.unindex(id, pos);
        self.roads.remove(&(pos.x, pos.y));
    }

    /// Check if a node is an intersection (>2 unique connections).
    pub fn is_intersection(&self, node_id: EntityId) -> bool {
        self.unique_connection_count(node_id) > 2
    }

    /// Count what the mayor has laid, from the nodes' own flags.
    pub fn rebuild_laid(&mut self) {
        self.laid = self
            .objects
            .all_entries()
            .iter()
            .filter(|e| matches!(e.object, GameObject::RoadNode(ref n) if n.laid))
            .count() as u32;
    }

    pub(super) fn unique_connection_count(&self, node_id: EntityId) -> usize {
        let unique: HashSet<EntityId> = self.arms_of(node_id, false).into_iter().collect();
        unique.len()
    }
}
