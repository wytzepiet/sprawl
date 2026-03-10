use std::collections::HashSet;

use crate::protocol::{EntityId, GameObject, GridCoord, RoadNode};
use crate::world::World;

impl World {
    /// Check if a building exists at the given coordinate.
    pub fn has_building_at(&self, coord: GridCoord) -> bool {
        if let Some(ids) = self.spatial.get(&coord) {
            for &id in ids {
                if let Some(entry) = self.objects.get(id)
                    && matches!(entry.object, GameObject::Building(_)) {
                        return true;
                    }
            }
        }
        false
    }

    /// Check if a building at this coord already has a road connection.
    fn building_has_road(&self, coord: GridCoord) -> bool {
        if !self.has_building_at(coord) {
            return false;
        }
        if let Some(ids) = self.spatial.get(&coord) {
            for &id in ids {
                if let Some(entry) = self.objects.get(id)
                    && let GameObject::RoadNode(ref node) = entry.object
                        && (!node.outgoing.is_empty() || !node.incoming.is_empty()) {
                            return true;
                        }
            }
        }
        false
    }

    /// Find the road node entity ID at a coord, if any.
    pub fn road_node_at(&self, coord: GridCoord) -> Option<EntityId> {
        let ids = self.spatial.get(&coord)?;
        for &id in ids {
            if let Some(entry) = self.objects.get(id)
                && matches!(entry.object, GameObject::RoadNode(_)) {
                    return Some(id);
                }
        }
        None
    }

    /// Place a road node at coord. Idempotent: returns existing ID if one exists.
    fn place_road(&mut self, coord: GridCoord) -> EntityId {
        if let Some(id) = self.road_node_at(coord) {
            return id;
        }

        let id = self.objects.insert(
            GameObject::RoadNode(RoadNode { outgoing: vec![], incoming: vec![] }),
            Some(coord),
        );
        self.spatial.entry(coord).or_default().insert(id);
        id
    }

    /// Check if adding a connection in direction (dx, dy) at `coord` would create
    /// an angle sharper than 90° with existing connections.
    fn would_be_too_sharp(&self, coord: GridCoord, dx: i32, dy: i32, outgoing_only: bool) -> bool {
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

        if self.building_has_road(from) || self.building_has_road(to) {
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

    /// Remove the road node at `pos` and clean up all references to it from outgoing.
    pub fn handle_demolish_road(&mut self, pos: GridCoord) {
        let id = match self.road_node_at(pos) {
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
        self.spatial.get_mut(&pos).map(|ids| ids.remove(&id));
    }

    /// Check if a node is an intersection (>2 unique connections).
    pub fn is_intersection(&self, node_id: EntityId) -> bool {
        self.unique_connection_count(node_id) > 2
    }

    /// Junction = dead-end (0-1 connections) or intersection (3+). Pass-throughs have exactly 2.
    pub fn is_junction(&self, node_id: EntityId) -> bool {
        self.unique_connection_count(node_id) != 2
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
