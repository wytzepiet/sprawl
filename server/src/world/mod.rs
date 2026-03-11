pub mod bezier;
mod buildings;
mod geometry;
pub mod pathfinding;
mod roads;
pub mod segments;

use std::collections::{HashMap, HashSet};

use crate::protocol::{EdgeKey, EntityId, GameObject};
use crate::engine::tracked::Tracked;
use crate::world::segments::EdgeSegment;

pub struct World {
    pub objects: Tracked,
    pub(super) spatial: HashMap<GridCoord, HashSet<EntityId>>,
    pub edges: HashMap<EdgeKey, EdgeSegment>,
    /// Maps node_id → set of car_ids whose route passes through that node.
    pub node_cars: HashMap<EntityId, HashSet<EntityId>>,
}

use crate::protocol::GridCoord;

impl World {
    pub fn new() -> Self {
        Self {
            objects: Tracked::new(),
            spatial: HashMap::new(),
            edges: HashMap::new(),
            node_cars: HashMap::new(),
        }
    }

    pub fn from_loaded(objects: Tracked) -> Self {
        let mut world = Self {
            spatial: HashMap::new(),
            edges: HashMap::new(),
            node_cars: HashMap::new(),
            objects,
        };
        // Rebuild spatial index from loaded objects
        for entry in world.objects.all_entries() {
            if let Some(pos) = entry.position {
                world.spatial.entry(pos).or_default().insert(entry.id);
            }
        }
        world
    }

    /// Rebuild edges from the road graph. Only needed when loading saved state.
    pub fn rebuild_edges(&mut self) {
        self.edges.clear();
        let entries: Vec<_> = self.objects.all_entries().iter()
            .filter_map(|e| {
                if let GameObject::RoadNode(ref node) = e.object {
                    Some((e.id, node.outgoing.clone()))
                } else {
                    None
                }
            })
            .collect();
        for (id, outgoing) in entries {
            for neighbor in outgoing {
                let len = self.segment_length(id, neighbor);
                self.edges.insert((id, neighbor), EdgeSegment::new(len));
            }
        }
    }

    pub fn despawn_car(&mut self, car_id: EntityId) {
        if let Some(entry) = self.objects.get(car_id)
            && let GameObject::Car(ref car) = entry.object
        {
            let ri = car.route_index;
            // Remove from current edge
            if ri >= 1 {
                let edge = (car.route[ri - 1], car.route[ri]);
                if let Some(seg) = self.edges.get_mut(&edge) {
                    seg.cars.retain(|&id| id != car_id);
                }
            }
            // Remove from next edge (pre-registration)
            if ri + 1 < car.route.len() {
                let next_edge = (car.route[ri], car.route[ri + 1]);
                if let Some(seg) = self.edges.get_mut(&next_edge) {
                    seg.cars.retain(|&id| id != car_id);
                }
            }
        }
        self.objects.remove(car_id);
    }

    /// Find the car behind a given car on the same edge.
    pub fn car_behind_on_edge(&self, edge: EdgeKey, car_id: EntityId) -> Option<EntityId> {
        let seg = self.edges.get(&edge)?;
        let pos = seg.car_position(car_id)?;
        if pos + 1 < seg.cars.len() {
            Some(seg.cars[pos + 1])
        } else {
            None
        }
    }

    /// Insert an edge for a directed connection between two nodes.
    pub fn insert_edge(&mut self, from: EntityId, to: EntityId) {
        let len = self.segment_length(from, to);
        self.edges.insert((from, to), EdgeSegment::new(len));
    }

    /// Remove an edge.
    pub fn remove_edge(&mut self, from: EntityId, to: EntityId) {
        self.edges.remove(&(from, to));
    }

    /// Collect all edge keys involving a node (as from or to).
    pub fn edges_involving(&self, node_id: EntityId) -> Vec<EdgeKey> {
        self.edges.keys()
            .filter(|&&(from, to)| from == node_id || to == node_id)
            .copied()
            .collect()
    }

    pub fn register_car_route(&mut self, car_id: EntityId, route: &[EntityId]) {
        for &node in route {
            self.node_cars.entry(node).or_default().insert(car_id);
        }
    }

    pub fn unregister_car_route(&mut self, car_id: EntityId, route: &[EntityId]) {
        for &node in route {
            if let Some(set) = self.node_cars.get_mut(&node) {
                set.remove(&car_id);
            }
        }
    }

    /// Rebuild node_cars index from all existing cars.
    pub fn rebuild_node_cars(&mut self) {
        self.node_cars.clear();
        let routes: Vec<(EntityId, Vec<EntityId>)> = self.objects.all_entries()
            .iter()
            .filter_map(|e| {
                if let GameObject::Car(ref car) = e.object {
                    Some((e.id, car.route.clone()))
                } else {
                    None
                }
            })
            .collect();
        for (car_id, route) in routes {
            self.register_car_route(car_id, &route);
        }
    }
}
