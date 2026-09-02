use std::collections::HashSet;

use crate::protocol::{Draft, EntityId, GameObject, GridCoord, RoadNode};
use crate::world::World;

impl World {
    fn road_nodes_at(&self, coord: GridCoord) -> impl Iterator<Item = EntityId> + '_ {
        self.ids_at(coord).into_iter().filter(|&id| {
            self.objects
                .get(id)
                .is_some_and(|e| matches!(e.object, GameObject::RoadNode(_)))
        })
    }

    /// The road that will stand on this tile once pending work is committed.
    ///
    /// A draft splits the world in two: *now* is committed plus everything
    /// staged for demolition, and that is what traffic drives on; *after* is
    /// committed plus everything drafted, and that is what you build against.
    ///
    /// Where the two disagree the tile holds one node for each, so a new road
    /// can cross one being demolished without either borrowing the other's
    /// shape. This is the one everything that plans wants — placement,
    /// geometry, access, occupancy.
    pub fn road_node_at(&self, coord: GridCoord) -> Option<EntityId> {
        self.road_nodes_at(coord).find(|&id| !self.is_going_away(id))
    }

    /// Place a road node at coord. Idempotent within a world: returns the node
    /// already standing here if one will still be here after the commit.
    ///
    /// A road staged for demolition is not that node, so drawing across one
    /// lays a second node on the tile rather than taking the old one over. The
    /// two never share an arm, which is what lets a new road cross a doomed one
    /// without drawing a junction that belongs to neither.
    fn place_road(&mut self, coord: GridCoord) -> EntityId {
        if let Some(id) = self.road_node_at(coord) {
            return id;
        }

        self.insert_at(
            GameObject::RoadNode(RoadNode { outgoing: vec![], incoming: vec![] }),
            Some(coord),
        )
    }

    /// The neighbours a node shares a world with.
    ///
    /// A node only ever reaches for nodes on its own side of a draft: what is
    /// arriving does not reach for what is leaving, and vice versa. That is
    /// what lets a road be demolished up to a point and the survivor turn a
    /// corner it could not have turned before — the arm toward the demolished
    /// half is simply not there to be too sharp against, and the survivor stops
    /// being drawn curved toward it.
    ///
    /// The doomed node keeps its own arms, so it still draws through to
    /// everything it used to reach. It is its own record of what was there;
    /// nothing has to be unlinked, which is what keeps discard free.
    pub fn arms_of(&self, id: EntityId, outgoing_only: bool) -> Vec<EntityId> {
        let Some(entry) = self.objects.get(id) else { return Vec::new() };
        let GameObject::RoadNode(ref node) = entry.object else { return Vec::new() };
        let leaving = self.is_going_away(id);
        let same_world = |&&n: &&EntityId| match self.draft_of(n) {
            Some(Draft::Removed(_)) => leaving,
            Some(Draft::Added(_)) => !leaving,
            None => true,
        };
        if outgoing_only {
            node.outgoing.iter().filter(same_world).copied().collect()
        } else {
            node.outgoing.iter().chain(node.incoming.iter()).filter(same_world).copied().collect()
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
    fn are_connected(&self, a: GridCoord, b: GridCoord) -> bool {
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
    pub fn handle_place_road(&mut self, from: GridCoord, to: GridCoord, one_way: bool) {
        let dx = to.x - from.x;
        let dy = to.y - from.y;

        // A road may end on a plot — that is all a driveway is — but never start
        // on one, or it would run in one side and out the other. A proposal
        // counts: it is a plot spoken for, and the road drawn to it now is the
        // driveway of the building accepted later.
        if self.claimed_plot_at(from).is_some() {
            return;
        }
        let into_building = self.claimed_plot_at(to).is_some();
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
        // a road into it is how you move the old one.
        if into_building {
            self.clear_driveway(to);
        }

        let from_id = self.place_road(from);
        let to_id = self.place_road(to);

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

    /// Place road nodes along a path and connect consecutive nodes bidirectionally.
    /// Used by procedural road generation — skips player-input validation.
    pub fn place_road_path(&mut self, path: &[GridCoord]) {
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
        let ids: Vec<_> = expanded.iter().map(|&c| self.place_road(c)).collect();
        // A road laid for real reaches whatever dormant building stands
        // beside it. A drafted one reaches nothing until it commits.
        if self.acting_as.is_none() {
            self.attach_driveways_along(&expanded);
        }
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

    /// Remove the road node standing at `pos`, if the commit would leave one.
    pub fn handle_demolish_road(&mut self, pos: GridCoord) {
        if let Some(id) = self.road_node_at(pos) {
            self.demolish_node(id);
        }
    }

    /// Remove a road node by id and clean up every reference to it.
    ///
    /// By id rather than by tile: a tile can hold two nodes while a new road
    /// crosses one being demolished, and only one of them is going.
    pub fn demolish_node(&mut self, id: EntityId) {
        let Some(pos) = self.objects.get(id).and_then(|e| e.position) else { return };
        let (neighbor_ids, incoming_ids) = match self.objects.get(id) {
            Some(entry) => {
                if let GameObject::RoadNode(ref node) = entry.object {
                    (node.outgoing.clone(), node.incoming.clone())
                } else {
                    return;
                }
            }
            None => return,
        };

        for nid in neighbor_ids.iter().chain(incoming_ids.iter()) {
            if let Some(entry) = self.objects.get_mut(*nid)
                && let GameObject::RoadNode(ref mut node) = entry.object {
                    node.outgoing.retain(|&x| x != id);
                    node.incoming.retain(|&x| x != id);
                }
        }

        self.objects.remove(id);
        self.unindex(id, pos);
    }

    /// Check if a node is an intersection (>2 unique connections).
    pub fn is_intersection(&self, node_id: EntityId) -> bool {
        self.unique_connection_count(node_id) > 2
    }

    /// Counts only arms in this node's own world: a drafted road carries no
    /// cars, so it cannot make a junction the simulation has to arbitrate.
    pub(super) fn unique_connection_count(&self, node_id: EntityId) -> usize {
        let unique: HashSet<EntityId> = self.arms_of(node_id, false).into_iter().collect();
        unique.len()
    }
}
