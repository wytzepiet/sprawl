use std::collections::HashSet;

use crate::protocol::{EntityId, GameObject, GridCoord, RoadNode};
use crate::world::World;

impl World {
    /// Whatever road node physically stands on this tile, including one staged
    /// for demolition.
    ///
    /// Only demolition itself and driveway adoption want this. Everything that
    /// plans wants `road_node_at`, or it will reason about a road that is on
    /// its way out.
    pub fn any_road_node_at(&self, coord: GridCoord) -> Option<EntityId> {
        self.ids_at(coord).into_iter().find(|&id| {
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
    /// Nothing belongs to both, so a road on its way out is simply not here as
    /// far as planning is concerned — a new road must not junction with it, a
    /// plot must not take access from it, and a building may stand on it.
    ///
    /// It keeps carrying its traffic all the same. That runs off `edges`, which
    /// this does not touch.
    pub fn road_node_at(&self, coord: GridCoord) -> Option<EntityId> {
        self.any_road_node_at(coord).filter(|&id| !self.is_going_away(id))
    }

    /// Place a road node at coord. Idempotent: returns existing ID if one exists.
    ///
    /// Drawing over a demolition that was staged here calls it off — you have
    /// decided there is a road on this tile after all. That keeps the rule that
    /// a tile holds at most one road node, which every by-tile lookup depends
    /// on, and it is also how a building adopts the road on its door tile as a
    /// driveway.
    fn place_road(&mut self, coord: GridCoord) -> EntityId {
        if let Some(id) = self.any_road_node_at(coord) {
            if self.is_going_away(id) {
                self.unstage(id);
            }
            return id;
        }

        self.insert_at(
            GameObject::RoadNode(RoadNode { outgoing: vec![], incoming: vec![] }),
            Some(coord),
        )
    }

    /// Check if adding a connection in direction (dx, dy) at `coord` would create
    /// an angle sharper than 90° with existing connections.
    pub(super) fn would_be_too_sharp(&self, coord: GridCoord, dx: i32, dy: i32, outgoing_only: bool) -> bool {
        let id = match self.road_node_at(coord) {
            Some(id) => id,
            None => return false,
        };
        let entry = match self.objects.get(id) {
            Some(e) => e,
            None => return false,
        };
        let GameObject::RoadNode(ref node) = entry.object else { return false };
        let check_ids: Vec<EntityId> = if outgoing_only {
            node.outgoing.clone()
        } else {
            node.outgoing.iter().chain(node.incoming.iter()).copied().collect()
        };
        for nid in check_ids {
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

        // Buildings sit beside roads now, never on them.
        if self.has_building_at(from) || self.has_building_at(to) {
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
            || self.would_be_too_sharp(to, -dx, -dy, false)
        {
            return;
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

    /// Remove the road node at `pos` and clean up all references to it from outgoing.
    pub fn handle_demolish_road(&mut self, pos: GridCoord) {
        let id = match self.any_road_node_at(pos) {
            Some(id) => id,
            None => return,
        };

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

    fn unique_connection_count(&self, node_id: EntityId) -> usize {
        if let Some(entry) = self.objects.get(node_id)
            && let GameObject::RoadNode(ref node) = entry.object {
                let mut unique: HashSet<EntityId> = HashSet::new();
                unique.extend(&node.outgoing);
                unique.extend(&node.incoming);
                return unique.len();
            }
        0
    }
}
