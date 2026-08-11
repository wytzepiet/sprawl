use crate::protocol::{
    Building, BuildingKind, EntityId, GameObject, GridCoord, Rotation, TerrainType,
};
use crate::world::World;

impl World {
    /// Tiles a footprint of this size covers when placed at `pos` facing `rotation`.
    ///
    /// Sizes are stored unrotated, so a quarter turn swaps the axes. `pos` is
    /// always the min corner of the result, which keeps every caller — spatial
    /// index, occupancy, rendering — reading the same rectangle.
    pub fn footprint(
        pos: GridCoord,
        size: (u8, u8),
        rotation: Rotation,
    ) -> impl Iterator<Item = GridCoord> {
        let (w, h) = if rotation.swaps_axes() {
            (size.1 as i32, size.0 as i32)
        } else {
            (size.0 as i32, size.1 as i32)
        };
        (0..h).flat_map(move |dy| {
            (0..w).map(move |dx| GridCoord { x: pos.x + dx, y: pos.y + dy })
        })
    }

    pub fn has_building_at(&self, coord: GridCoord) -> bool {
        self.occupied.contains_key(&(coord.x, coord.y))
    }

    /// Land a building can stand on. Water and mountain are out; roads and other
    /// buildings already hold their tiles.
    pub fn is_buildable(&self, coord: GridCoord) -> bool {
        if self.has_building_at(coord) || self.road_node_at(coord).is_some() {
            return false;
        }
        matches!(
            self.terrain.get(&(coord.x, coord.y)),
            Some(TerrainType::Grass | TerrainType::Beach | TerrainType::Forest)
        )
    }

    /// The tile the entrance sits on: the middle of the front edge.
    pub fn door_tile(&self, building_id: EntityId) -> Option<GridCoord> {
        let entry = self.objects.get(building_id)?;
        let pos = entry.position?;
        let GameObject::Building(ref b) = entry.object else { return None };

        let (w, h) = if b.rotation.swaps_axes() {
            (b.size.1 as i32, b.size.0 as i32)
        } else {
            (b.size.0 as i32, b.size.1 as i32)
        };
        // Walk to the middle of whichever edge faces out.
        Some(match b.rotation {
            Rotation::North => GridCoord { x: pos.x + (w - 1) / 2, y: pos.y + h - 1 },
            Rotation::South => GridCoord { x: pos.x + (w - 1) / 2, y: pos.y },
            Rotation::East => GridCoord { x: pos.x + w - 1, y: pos.y + (h - 1) / 2 },
            Rotation::West => GridCoord { x: pos.x, y: pos.y + (h - 1) / 2 },
        })
    }

    /// The road a building's traffic uses.
    ///
    /// Derived from the door rather than stored, so it cannot go stale: demolish
    /// the road and the building is simply orphaned, with no reference to clean
    /// up and no trips able to start or end there.
    pub fn road_node_for_building(&self, building_id: EntityId) -> Option<EntityId> {
        let entry = self.objects.get(building_id)?;
        let GameObject::Building(ref b) = entry.object else { return None };
        let door = self.door_tile(building_id)?;
        let (dx, dy) = b.rotation.facing();
        self.road_node_at(GridCoord { x: door.x + dx, y: door.y + dy })
    }

    /// Every building, as (id, position).
    pub fn all_buildings(&self) -> Vec<(EntityId, GridCoord)> {
        self.objects
            .all_entries()
            .iter()
            .filter(|e| matches!(e.object, GameObject::Building(_)))
            .filter_map(|e| e.position.map(|p| (e.id, p)))
            .collect()
    }

    /// A rotation whose door lands against a road, if any. Tried in a fixed
    /// order so the same plot always produces the same building.
    pub fn rotation_facing_road(&self, pos: GridCoord, size: (u8, u8)) -> Option<Rotation> {
        Rotation::ALL.into_iter().find(|&rotation| {
            let (w, h) = if rotation.swaps_axes() {
                (size.1 as i32, size.0 as i32)
            } else {
                (size.0 as i32, size.1 as i32)
            };
            let door = match rotation {
                Rotation::North => GridCoord { x: pos.x + (w - 1) / 2, y: pos.y + h - 1 },
                Rotation::South => GridCoord { x: pos.x + (w - 1) / 2, y: pos.y },
                Rotation::East => GridCoord { x: pos.x + w - 1, y: pos.y + (h - 1) / 2 },
                Rotation::West => GridCoord { x: pos.x, y: pos.y + (h - 1) / 2 },
            };
            let (dx, dy) = rotation.facing();
            self.road_node_at(GridCoord { x: door.x + dx, y: door.y + dy }).is_some()
        })
    }

    /// The one way a building comes into existence.
    ///
    /// Everything that has to happen per building — occupancy, spatial indexing
    /// across every chunk it touches, revealing the map — happens here, so none
    /// of it can be forgotten at a call site.
    pub fn spawn_building(
        &mut self,
        pos: GridCoord,
        kind: BuildingKind,
        size: (u8, u8),
        rotation: Rotation,
    ) -> Option<EntityId> {
        let tiles: Vec<GridCoord> = Self::footprint(pos, size, rotation).collect();
        if !tiles.iter().all(|&t| self.is_buildable(t)) {
            return None;
        }

        let id = self.insert_at(
            GameObject::Building(Building { kind, size, rotation }),
            Some(pos),
        );

        for tile in &tiles {
            self.occupied.insert((tile.x, tile.y), id);
            // A footprint can straddle a chunk border, and clients subscribe by
            // chunk — indexed only at its origin, a building would vanish for
            // anyone looking at the other half.
            self.spatial.entry(crate::world::chunk_of(*tile)).or_default().insert(id);
        }
        self.reveal_around(pos);
        Some(id)
    }

    /// The one way a building leaves.
    pub fn remove_building(&mut self, id: EntityId) {
        let Some(entry) = self.objects.get(id) else { return };
        let Some(pos) = entry.position else { return };
        let GameObject::Building(ref b) = entry.object else { return };
        let tiles: Vec<GridCoord> = Self::footprint(pos, b.size, b.rotation).collect();

        for tile in tiles {
            self.occupied.remove(&(tile.x, tile.y));
            self.unindex(id, tile);
        }
        self.objects.remove(id);
    }

    /// Rebuild the tile→building index from the stored buildings.
    pub fn rebuild_occupied(&mut self) {
        self.occupied.clear();
        let placed: Vec<(EntityId, GridCoord, (u8, u8), Rotation)> = self
            .objects
            .all_entries()
            .iter()
            .filter_map(|e| match &e.object {
                GameObject::Building(b) => e.position.map(|p| (e.id, p, b.size, b.rotation)),
                _ => None,
            })
            .collect();
        for (id, pos, size, rotation) in placed {
            for tile in Self::footprint(pos, size, rotation) {
                self.occupied.insert((tile.x, tile.y), id);
                self.spatial.entry(crate::world::chunk_of(tile)).or_default().insert(id);
            }
        }
    }
}
