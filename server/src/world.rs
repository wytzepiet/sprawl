use std::collections::{HashMap, HashSet};

use crate::intersection::IntersectionRegistry;
use crate::protocol::{Building, BuildingType, EntityId, GameObject, GridCoord, RoadNode};
use crate::tracked::Tracked;

pub struct World {
    pub objects: Tracked,
    spatial: HashMap<GridCoord, HashSet<EntityId>>,
    pub intersections: IntersectionRegistry,
}

impl World {
    pub fn new() -> Self {
        Self {
            objects: Tracked::new(),
            spatial: HashMap::new(),
            intersections: IntersectionRegistry::new(),
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
    pub fn road_node_at(&self, coord: GridCoord) -> Option<EntityId> {
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
        self.intersections.clear();
    }

    /// A node is an intersection if it has 3+ unique connections (neighbors + incoming).
    pub fn is_intersection(&self, node_id: EntityId) -> bool {
        if let Some(entry) = self.objects.get(node_id) {
            if let GameObject::RoadNode(ref node) = entry.object {
                let mut unique: HashSet<EntityId> = HashSet::new();
                unique.extend(&node.neighbors);
                unique.extend(&node.incoming);
                return unique.len() >= 3;
            }
        }
        false
    }

    /// Update intersection manager status for a node: create or remove manager as needed.
    fn update_intersection_status(&mut self, node_id: EntityId) {
        if self.is_intersection(node_id) {
            self.intersections.ensure_manager(node_id);
        } else {
            self.intersections.remove_manager(node_id);
        }
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

        // Update intersection status for both endpoints
        self.update_intersection_status(from_id);
        self.update_intersection_status(to_id);
    }

    /// Find the road node at the same position as a building.
    pub fn road_node_for_building(&self, building_id: EntityId) -> Option<EntityId> {
        let entry = self.objects.get(building_id)?;
        let pos = entry.position?;
        self.road_node_at(pos)
    }

    /// Return all Car Spawner buildings as (id, position) pairs.
    pub fn all_car_spawners(&self) -> Vec<(EntityId, GridCoord)> {
        let mut result = Vec::new();
        for entry in self.objects.all_entries() {
            if let GameObject::Building(ref b) = entry.object {
                if b.building_type == BuildingType::CarSpawner {
                    if let Some(pos) = entry.position {
                        result.push((entry.id, pos));
                    }
                }
            }
        }
        result
    }

    /// Despawn a car, unregistering it from any intersection it's waiting at.
    pub fn despawn_car(&mut self, car_id: EntityId) -> Option<EntityId> {
        let waiting_at = if let Some(entry) = self.objects.get(car_id) {
            if let GameObject::Car(ref car) = entry.object {
                car.waiting_at_intersection
            } else {
                None
            }
        } else {
            None
        };
        if let Some(node_id) = waiting_at {
            self.intersections.remove_car(car_id, node_id);
        }
        self.objects.remove(car_id);
        waiting_at
    }

    /// Find all car IDs whose current segment touches the given node.
    pub fn cars_on_node(&self, node_id: EntityId) -> Vec<EntityId> {
        let mut result = Vec::new();
        for entry in self.objects.all_entries() {
            if let GameObject::Car(ref car) = entry.object {
                let from = car.route[car.route_index - 1];
                let to = car.route[car.route_index];
                if from == node_id || to == node_id {
                    result.push(entry.id);
                }
            }
        }
        result
    }

    /// Compute the cosine of the turn angle at route[node_index].
    /// Returns 1.0 (straight) for route endpoints (first/last node).
    pub fn turn_cos_angle(&self, route: &[EntityId], node_index: usize) -> f64 {
        if node_index == 0 || node_index >= route.len() - 1 {
            return 1.0;
        }
        let prev_pos = self.objects.get(route[node_index - 1]).and_then(|e| e.position);
        let curr_pos = self.objects.get(route[node_index]).and_then(|e| e.position);
        let next_pos = self.objects.get(route[node_index + 1]).and_then(|e| e.position);

        match (prev_pos, curr_pos, next_pos) {
            (Some(p), Some(c), Some(n)) => {
                let dx1 = (c.x - p.x) as f64;
                let dy1 = (c.y - p.y) as f64;
                let dx2 = (n.x - c.x) as f64;
                let dy2 = (n.y - c.y) as f64;
                let len1 = (dx1 * dx1 + dy1 * dy1).sqrt();
                let len2 = (dx2 * dx2 + dy2 * dy2).sqrt();
                if len1 < 1e-9 || len2 < 1e-9 {
                    return 1.0;
                }
                (dx1 * dx2 + dy1 * dy2) / (len1 * len2)
            }
            _ => 1.0,
        }
    }

    /// Get the Euclidean distance between two road nodes (used for A* pathfinding).
    pub fn segment_length(&self, from: EntityId, to: EntityId) -> f64 {
        let a = self.objects.get(from).and_then(|e| e.position);
        let b = self.objects.get(to).and_then(|e| e.position);
        match (a, b) {
            (Some(a), Some(b)) => {
                let dx = (b.x - a.x) as f64;
                let dy = (b.y - a.y) as f64;
                (dx * dx + dy * dy).sqrt()
            }
            _ => 1.0,
        }
    }

    /// Collect world positions (tile center) for each node in a route.
    pub fn route_positions(&self, route: &[EntityId]) -> Vec<[f64; 2]> {
        route
            .iter()
            .filter_map(|&id| {
                self.objects.get(id).and_then(|e| {
                    e.position.map(|p| [p.x as f64 + 0.5, p.y as f64 + 0.5])
                })
            })
            .collect()
    }

    /// Get the path length for a route segment (straight + bezier corners).
    /// `route_index` is 1-based (matches Car.route_index).
    pub fn spline_segment_length(&self, route: &[EntityId], route_index: usize) -> f64 {
        self.segment_geometry(route, route_index).total()
    }

    /// Get the geometry (straight + corner arc) for a route segment.
    /// `route_index` is 1-based (matches Car.route_index).
    pub fn segment_geometry(&self, route: &[EntityId], route_index: usize) -> crate::bezier::SegmentGeometry {
        let positions = self.route_positions(route);
        if positions.len() < 2 || route_index == 0 || route_index >= positions.len() {
            return crate::bezier::SegmentGeometry { straight: 1.0, corner_arc: 0.0 };
        }
        let seg_idx = route_index - 1;
        crate::bezier::segment_geometry(&positions, seg_idx)
    }

    /// Place a building at the given position. Returns the building ID if placed.
    /// Only allowed on empty squares or dead-end roads (exactly 1 unique connection).
    pub fn handle_place_building(&mut self, pos: GridCoord, building_type: BuildingType) -> Option<EntityId> {
        if let Some(ids) = self.spatial.get(&pos) {
            for &id in ids {
                if let Some(entry) = self.objects.get(id) {
                    match &entry.object {
                        GameObject::Building(_) => return None,
                        GameObject::RoadNode(node) => {
                            let mut unique: HashSet<EntityId> = HashSet::new();
                            unique.extend(&node.neighbors);
                            unique.extend(&node.incoming);
                            if unique.len() != 1 {
                                return None;
                            }
                        }
                        GameObject::Car(_) => {}
                    }
                }
            }
        }

        let id = self.objects.insert(
            GameObject::Building(Building { building_type }),
            Some(pos),
        );
        self.spatial.entry(pos).or_default().insert(id);
        Some(id)
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

        // Remove intersection manager for this node
        self.intersections.remove_manager(id);

        // Remove the node itself
        self.objects.remove(id);
        self.spatial.get_mut(&pos).map(|ids| ids.remove(&id));

        // Re-check intersection status for neighbors (they may no longer be intersections)
        for nid in neighbor_ids.iter().chain(incoming_ids.iter()) {
            self.update_intersection_status(*nid);
        }
    }
}
