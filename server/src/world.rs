use std::collections::{HashMap, HashSet};

use crate::protocol::{Building, EntityId, GameObject, GridCoord, RoadNode};
use crate::tracked::Tracked;

pub struct World {
    pub objects: Tracked,
    spatial: HashMap<GridCoord, HashSet<EntityId>>,
}

impl World {
    pub fn new() -> Self {
        Self {
            objects: Tracked::new(),
            spatial: HashMap::new(),
        }
    }

    /// Check if a building exists at the given coordinate.
    fn has_building(&self, coord: GridCoord) -> bool {
        if let Some(ids) = self.spatial.get(&coord) {
            for &id in ids {
                if let Some(entry) = self.objects.get(id) {
                    if matches!(entry.object, GameObject::Building(_)) {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// Check if a building at this coord already has a road connection.
    fn building_has_road(&self, coord: GridCoord) -> bool {
        if !self.has_building(coord) {
            return false;
        }
        if let Some(ids) = self.spatial.get(&coord) {
            for &id in ids {
                if let Some(entry) = self.objects.get(id) {
                    if let GameObject::RoadNode(ref node) = entry.object {
                        if !node.neighbors.is_empty() || !node.incoming.is_empty() {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    /// Find the road node entity ID at a coord, if any.
    fn road_node_at(&self, coord: GridCoord) -> Option<EntityId> {
        let ids = self.spatial.get(&coord)?;
        for &id in ids {
            if let Some(entry) = self.objects.get(id) {
                if matches!(entry.object, GameObject::RoadNode(_)) {
                    return Some(id);
                }
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
            GameObject::RoadNode(RoadNode { neighbors: vec![], incoming: vec![] }),
            Some(coord),
        );
        self.spatial.entry(coord).or_default().insert(id);
        id
    }

    pub fn reset(&mut self) {
        self.objects.clear();
        self.spatial.clear();
    }

    /// Check if adding a connection in direction (dx, dy) at `coord` would create
    /// an angle sharper than 90° with existing connections.
    /// If `outgoing_only` is true, only checks against outgoing neighbors (not incoming).
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
            node.neighbors.clone()
        } else {
            node.neighbors.iter().chain(node.incoming.iter()).copied().collect()
        };
        for nid in check_ids {
            if let Some(neighbor) = self.objects.get(nid) {
                if let Some(npos) = neighbor.position {
                    let ndx = npos.x - coord.x;
                    let ndy = npos.y - coord.y;
                    // dot product > 0 means angle < 90°
                    if ndx * dx + ndy * dy > 0 {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// Check if two nodes at the given coords are connected as neighbors.
    fn are_connected(&self, a: GridCoord, b: GridCoord) -> bool {
        let a_id = match self.road_node_at(a) {
            Some(id) => id,
            None => return false,
        };
        let b_id = match self.road_node_at(b) {
            Some(id) => id,
            None => return false,
        };
        if let Some(entry) = self.objects.get(a_id) {
            if let GameObject::RoadNode(ref node) = entry.object {
                return node.neighbors.contains(&b_id) || node.incoming.contains(&b_id);
            }
        }
        false
    }

    /// Place road nodes at `from` and `to`, and connect them as neighbors.
    pub fn handle_place_road(&mut self, from: GridCoord, to: GridCoord, one_way: bool) {
        let dx = to.x - from.x;
        let dy = to.y - from.y;

        // Reject if a building at either endpoint already has a road connection
        if self.building_has_road(from) || self.building_has_road(to) {
            return;
        }

        // Reject if any connection already exists between these two nodes
        if self.are_connected(from, to) {
            return;
        }

        // For diagonal roads, reject if the opposite diagonal already exists
        if dx.abs() == 1 && dy.abs() == 1 {
            let cross_a = GridCoord { x: from.x + dx, y: from.y };
            let cross_b = GridCoord { x: from.x, y: from.y + dy };
            if self.are_connected(cross_a, cross_b) {
                return;
            }
        }

        // Reject if this would create an angle < 90° at either endpoint.
        // For one-way: only check outgoing at source; merging at target is fine.
        // For two-way: check all connections at both endpoints.
        if one_way {
            if self.would_be_too_sharp(from, dx, dy, true) {
                return;
            }
        } else {
            if self.would_be_too_sharp(from, dx, dy, false)
                || self.would_be_too_sharp(to, -dx, -dy, false)
            {
                return;
            }
        }

        let from_id = self.place_road(from);
        let to_id = self.place_road(to);

        // Connect from -> to
        if let Some(entry) = self.objects.get_mut(from_id) {
            if let GameObject::RoadNode(ref mut node) = entry.object {
                if !node.neighbors.contains(&to_id) {
                    node.neighbors.push(to_id);
                }
            }
        }

        if one_way {
            // One-way: target gets source as incoming (for rendering, not pathfinding)
            if let Some(entry) = self.objects.get_mut(to_id) {
                if let GameObject::RoadNode(ref mut node) = entry.object {
                    if !node.incoming.contains(&from_id) {
                        node.incoming.push(from_id);
                    }
                }
            }
        } else {
            // Two-way: target gets source as neighbor
            if let Some(entry) = self.objects.get_mut(to_id) {
                if let GameObject::RoadNode(ref mut node) = entry.object {
                    if !node.neighbors.contains(&from_id) {
                        node.neighbors.push(from_id);
                    }
                }
            }
        }
    }

    /// Place a building at the given position.
    /// Only allowed on empty squares or dead-end roads (exactly 1 unique connection).
    pub fn handle_place_building(&mut self, pos: GridCoord, building_type: String) {
        if let Some(ids) = self.spatial.get(&pos) {
            for &id in ids {
                if let Some(entry) = self.objects.get(id) {
                    match &entry.object {
                        GameObject::Building(_) => return,
                        GameObject::RoadNode(node) => {
                            let mut unique: HashSet<EntityId> = HashSet::new();
                            unique.extend(&node.neighbors);
                            unique.extend(&node.incoming);
                            if unique.len() != 1 {
                                return;
                            }
                        }
                    }
                }
            }
        }

        let id = self.objects.insert(
            GameObject::Building(Building { building_type }),
            Some(pos),
        );
        self.spatial.entry(pos).or_default().insert(id);
    }

    /// Remove the road node at `pos` and clean up all references to it from neighbors.
    pub fn handle_demolish_road(&mut self, pos: GridCoord) {
        let id = match self.road_node_at(pos) {
            Some(id) => id,
            None => return,
        };

        // Collect neighbor/incoming IDs before removing
        let (neighbor_ids, incoming_ids) = match self.objects.get(id) {
            Some(entry) => {
                if let GameObject::RoadNode(ref node) = entry.object {
                    (node.neighbors.clone(), node.incoming.clone())
                } else {
                    return;
                }
            }
            None => return,
        };

        // Remove this node's ID from all neighbors' incoming and neighbor lists
        for nid in neighbor_ids.iter().chain(incoming_ids.iter()) {
            if let Some(entry) = self.objects.get_mut(*nid) {
                if let GameObject::RoadNode(ref mut node) = entry.object {
                    node.neighbors.retain(|&x| x != id);
                    node.incoming.retain(|&x| x != id);
                }
            }
        }

        // Remove the node itself
        self.objects.remove(id);
        self.spatial.get_mut(&pos).map(|ids| ids.remove(&id));
    }
}
