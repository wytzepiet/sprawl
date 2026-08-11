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

    /// Perimeter tiles of a footprint, in a fixed order. Every one can host a
    /// door by default; a kind that wants a single gate narrows this later.
    fn perimeter(pos: GridCoord, size: (u8, u8), rotation: Rotation) -> Vec<GridCoord> {
        let (w, h) = Self::extent(size, rotation);
        Self::footprint(pos, size, rotation)
            .filter(move |t| {
                let (dx, dy) = (t.x - pos.x, t.y - pos.y);
                dx == 0 || dy == 0 || dx == w - 1 || dy == h - 1
            })
            .collect()
    }

    /// Footprint width and height after rotation.
    pub fn extent(size: (u8, u8), rotation: Rotation) -> (i32, i32) {
        if rotation.swaps_axes() {
            (size.1 as i32, size.0 as i32)
        } else {
            (size.0 as i32, size.1 as i32)
        }
    }

    /// The road a plot's traffic would use, if any.
    ///
    /// Straight-on neighbours are tried before corners, so a building touching
    /// both takes the road it faces squarely. Diagonals are only checked at the
    /// four corners: anywhere else along an edge, the diagonal tile is already
    /// orthogonally adjacent to the next perimeter tile along, so allowing it
    /// would just find the same road twice.
    pub fn road_for_plot(&self, pos: GridCoord, size: (u8, u8), rotation: Rotation) -> Option<EntityId> {
        const ORTHOGONAL: [(i32, i32); 4] = [(0, 1), (1, 0), (0, -1), (-1, 0)];
        let tiles = Self::perimeter(pos, size, rotation);

        for tile in &tiles {
            for (dx, dy) in ORTHOGONAL {
                let n = GridCoord { x: tile.x + dx, y: tile.y + dy };
                if Self::building_covers(pos, size, rotation, n) {
                    continue;
                }
                if let Some(id) = self.road_node_at(n) {
                    return Some(id);
                }
            }
        }

        let (w, h) = Self::extent(size, rotation);
        for (cx, cy, dx, dy) in [
            (0, 0, -1, -1),
            (w - 1, 0, 1, -1),
            (0, h - 1, -1, 1),
            (w - 1, h - 1, 1, 1),
        ] {
            let n = GridCoord { x: pos.x + cx + dx, y: pos.y + cy + dy };
            if let Some(id) = self.road_node_at(n) {
                return Some(id);
            }
        }
        None
    }

    fn building_covers(pos: GridCoord, size: (u8, u8), rotation: Rotation, t: GridCoord) -> bool {
        let (w, h) = Self::extent(size, rotation);
        t.x >= pos.x && t.y >= pos.y && t.x < pos.x + w && t.y < pos.y + h
    }

    /// The road this building's traffic uses.
    ///
    /// Derived rather than stored, so it cannot go stale — and if the road it
    /// was using is demolished, it simply falls back to another one it touches.
    pub fn road_node_for_building(&self, building_id: EntityId) -> Option<EntityId> {
        let entry = self.objects.get(building_id)?;
        let pos = entry.position?;
        let GameObject::Building(ref b) = entry.object else { return None };
        self.road_for_plot(pos, b.size, b.rotation)
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

    /// Which way to face a building so it looks at the road it uses. Appearance
    /// only — access does not depend on it.
    pub fn rotation_toward(&self, pos: GridCoord, size: (u8, u8), road: EntityId) -> Rotation {
        let Some(rp) = self.objects.get(road).and_then(|e| e.position) else {
            return Rotation::North;
        };
        let (w, h) = Self::extent(size, Rotation::North);
        let (cx, cy) = (pos.x as f64 + w as f64 / 2.0, pos.y as f64 + h as f64 / 2.0);
        let (dx, dy) = (rp.x as f64 + 0.5 - cx, rp.y as f64 + 0.5 - cy);
        if dx.abs() > dy.abs() {
            if dx > 0.0 { Rotation::East } else { Rotation::West }
        } else if dy > 0.0 {
            Rotation::North
        } else {
            Rotation::South
        }
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
        // A building nobody can drive to would be a purchase with no feedback.
        self.road_for_plot(pos, size, rotation)?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Rotation;

    /// A world with nothing in it but the given road path.
    fn world_with_road(path: &[(i32, i32)]) -> World {
        let mut world = World::new();
        let coords: Vec<GridCoord> = path.iter().map(|&(x, y)| GridCoord { x, y }).collect();
        world.place_road_path(&coords);
        world
    }

    #[test]
    fn takes_a_road_straight_on() {
        let world = world_with_road(&[(0, 1), (1, 1)]);
        assert!(world.road_for_plot(GridCoord { x: 0, y: 0 }, (1, 1), Rotation::North).is_some());
    }

    /// The case the corner rule exists for: no perimeter tile is orthogonally
    /// adjacent to this road, only the corner touches it.
    #[test]
    fn takes_a_road_off_its_corner() {
        let world = world_with_road(&[(1, 1), (2, 2)]);
        assert!(world.road_for_plot(GridCoord { x: 0, y: 0 }, (1, 1), Rotation::North).is_some());
    }

    #[test]
    fn corner_rule_reaches_past_a_wide_footprint() {
        // Footprint covers (0,0) and (1,0); the road only meets its far corner.
        let world = world_with_road(&[(2, 1), (3, 2)]);
        assert!(world.road_for_plot(GridCoord { x: 0, y: 0 }, (2, 1), Rotation::North).is_some());
    }

    #[test]
    fn no_road_in_reach_is_no_access() {
        let world = world_with_road(&[(5, 5), (6, 5)]);
        assert!(world.road_for_plot(GridCoord { x: 0, y: 0 }, (1, 1), Rotation::North).is_none());
    }

    /// A road two tiles out is not access, diagonally or otherwise.
    #[test]
    fn diagonals_do_not_reach_two_tiles() {
        let world = world_with_road(&[(2, 2), (3, 3)]);
        assert!(world.road_for_plot(GridCoord { x: 0, y: 0 }, (1, 1), Rotation::North).is_none());
    }

    #[test]
    fn footprint_covers_every_tile_and_rotation_swaps_axes() {
        let pos = GridCoord { x: 10, y: 10 };
        let north: Vec<_> = World::footprint(pos, (2, 3), Rotation::North).collect();
        assert_eq!(north.len(), 6);
        assert_eq!(World::extent((2, 3), Rotation::North), (2, 3));
        assert_eq!(World::extent((2, 3), Rotation::East), (3, 2));
    }
}
