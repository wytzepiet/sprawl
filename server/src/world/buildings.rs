use std::collections::HashSet;

use crate::protocol::{Building, BuildingType, EntityId, GameObject, GridCoord};
use crate::world::World;

impl World {
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
            if let GameObject::Building(ref b) = entry.object
                && b.building_type == BuildingType::CarSpawner
                    && let Some(pos) = entry.position {
                        result.push((entry.id, pos));
                    }
        }
        result
    }

    /// Place a building at the given position. Returns the building ID if placed.
    pub fn handle_place_building(&mut self, pos: GridCoord, building_type: BuildingType) -> Option<EntityId> {
        if let Some(ids) = self.spatial.get(&pos) {
            for &id in ids {
                if let Some(entry) = self.objects.get(id) {
                    match &entry.object {
                        GameObject::Building(_) => return None,
                        GameObject::RoadNode(node) => {
                            let mut unique: HashSet<EntityId> = HashSet::new();
                            unique.extend(&node.outgoing);
                            unique.extend(&node.incoming);
                            if unique.len() != 1 {
                                return None;
                            }
                        }
                        GameObject::Car(_) | GameObject::Terrain(_) => {}
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
}
