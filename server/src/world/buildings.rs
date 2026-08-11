use crate::protocol::{
    Building, BuildingKind, Category, EntityId, GameObject, GridCoord, Rotation, TerrainType,
};
use crate::world::World;
use std::collections::HashSet;

impl World {
    /// Tiles a footprint of this size covers when placed at `pos`.
    ///
    /// `pos` is always the min corner, which keeps every caller — spatial
    /// index, occupancy, rendering — reading the same rectangle.
    pub fn footprint(pos: GridCoord, size: (u8, u8)) -> impl Iterator<Item = GridCoord> {
        let (w, h) = (size.0 as i32, size.1 as i32);
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
    fn perimeter(pos: GridCoord, size: (u8, u8)) -> Vec<GridCoord> {
        let (w, h) = (size.0 as i32, size.1 as i32);
        Self::footprint(pos, size)
            .filter(move |t| {
                let (dx, dy) = (t.x - pos.x, t.y - pos.y);
                dx == 0 || dy == 0 || dx == w - 1 || dy == h - 1
            })
            .collect()
    }

    /// Could a driveway run from this road node to this tile?
    ///
    /// A driveway is an ordinary road, so it answers to the same geometry as
    /// any other: it may not meet the road it joins at a hairpin. Off a
    /// straight run only the perpendicular is legal — which for a diagonal
    /// street is itself diagonal, so a plot squarely beside one cannot be
    /// connected at all.
    fn driveway_reaches(&self, from: GridCoord, to: GridCoord) -> bool {
        !self.would_be_too_sharp(from, to.x - from.x, to.y - from.y, false)
    }

    /// The road a plot's traffic would use, if any.
    ///
    /// Straight-on neighbours are tried before corners, so a building touching
    /// both takes the road it faces squarely. Diagonals are only checked at the
    /// four corners: anywhere else along an edge, the diagonal tile is already
    /// orthogonally adjacent to the next perimeter tile along, so allowing it
    /// would just find the same road twice.
    pub fn road_for_plot(&self, pos: GridCoord, size: (u8, u8)) -> Option<(EntityId, GridCoord)> {
        const ORTHOGONAL: [(i32, i32); 4] = [(0, 1), (1, 0), (0, -1), (-1, 0)];
        let tiles = Self::perimeter(pos, size);

        for tile in &tiles {
            for (dx, dy) in ORTHOGONAL {
                let n = GridCoord { x: tile.x + dx, y: tile.y + dy };
                if Self::building_covers(pos, size, n) {
                    continue;
                }
                if let Some(id) = self.road_node_at(n)
                    && self.driveway_reaches(n, *tile)
                {
                    return Some((id, *tile));
                }
            }
        }

        let (w, h) = (size.0 as i32, size.1 as i32);
        for (cx, cy, dx, dy) in [
            (0, 0, -1, -1),
            (w - 1, 0, 1, -1),
            (0, h - 1, -1, 1),
            (w - 1, h - 1, 1, 1),
        ] {
            let corner = GridCoord { x: pos.x + cx, y: pos.y + cy };
            let n = GridCoord { x: corner.x + dx, y: corner.y + dy };
            if let Some(id) = self.road_node_at(n)
                && self.driveway_reaches(n, corner)
            {
                return Some((id, corner));
            }
        }
        None
    }

    fn building_covers(pos: GridCoord, size: (u8, u8), t: GridCoord) -> bool {
        t.x >= pos.x && t.y >= pos.y && t.x < pos.x + size.0 as i32 && t.y < pos.y + size.1 as i32
    }

    /// The building's own driveway node — the road that runs into it.
    ///
    /// Derived rather than stored: it is simply the road node standing on one
    /// of the building's own tiles, so redrawing the driveway moves it with no
    /// bookkeeping, and demolishing it leaves the building visibly cut off
    /// rather than holding a dangling reference.
    pub fn road_node_for_building(&self, building_id: EntityId) -> Option<EntityId> {
        let entry = self.objects.get(building_id)?;
        let pos = entry.position?;
        let GameObject::Building(ref b) = entry.object else { return None };
        Self::footprint(pos, b.size).find_map(|t| self.road_node_at(t))
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
        let (cx, cy) = (
            pos.x as f64 + size.0 as f64 / 2.0,
            pos.y as f64 + size.1 as f64 / 2.0,
        );
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
        let tiles: Vec<GridCoord> = Self::footprint(pos, size).collect();
        if !tiles.iter().all(|&t| self.is_buildable(t)) {
            return None;
        }
        // A building nobody can drive to would be a purchase with no feedback.
        let (street, door) = self.road_for_plot(pos, size)?;
        let street_pos = self.objects.get(street).and_then(|e| e.position)?;

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
        // The driveway is an ordinary road that happens to end inside the
        // building: the car drives in and despawns there. Laid after the
        // footprint is claimed, since a road on the plot would fail is_buildable.
        self.place_road_path(&[street_pos, door]);

        self.reveal_around(pos);
        Some(id)
    }

    /// Fill a painted area with buildings, largest plots first.
    ///
    /// The stroke is a wish, not an instruction: a tile with no legal driveway
    /// simply stays empty, and anything already standing is left alone, so
    /// painting over a street twice does not churn the town.
    pub fn paint_area(&mut self, tiles: &[GridCoord], category: Category) -> Vec<EntityId> {
        // Widest first, so a run of frontage becomes a few big plots rather
        // than a row of huts. Both orientations of each are offered.
        const PLOTS: [(u8, u8); 6] = [(3, 2), (2, 3), (2, 2), (2, 1), (1, 2), (1, 1)];

        let mut free: HashSet<(i32, i32)> = tiles
            .iter()
            .filter(|&&t| self.is_buildable(t))
            .map(|t| (t.x, t.y))
            .collect();

        // Sorted rather than in stroke order: the same painted area must lay
        // out the same way however the mouse happened to cross it.
        let mut order: Vec<GridCoord> = free.iter().map(|&(x, y)| GridCoord { x, y }).collect();
        order.sort_by_key(|t| (t.y, t.x));

        let mut spawned = Vec::new();
        for origin in order {
            if !free.contains(&(origin.x, origin.y)) {
                continue;
            }
            for size in PLOTS {
                let plot: Vec<GridCoord> = Self::footprint(origin, size).collect();
                if !plot.iter().all(|t| free.contains(&(t.x, t.y))) {
                    continue;
                }
                let Some((road, _)) = self.road_for_plot(origin, size) else { continue };
                let kind = BuildingKind::for_plot(category, plot.len() as u32);
                let rotation = self.rotation_toward(origin, size, road);
                if let Some(id) = self.spawn_building(origin, kind, size, rotation) {
                    for t in &plot {
                        free.remove(&(t.x, t.y));
                    }
                    spawned.push(id);
                    break;
                }
            }
        }
        spawned
    }

    /// The one way a building leaves.
    pub fn remove_building(&mut self, id: EntityId) {
        let Some(entry) = self.objects.get(id) else { return };
        let Some(pos) = entry.position else { return };
        let GameObject::Building(ref b) = entry.object else { return };
        let tiles: Vec<GridCoord> = Self::footprint(pos, b.size).collect();

        for tile in &tiles {
            if let Some(node) = self.road_node_at(*tile) {
                for edge in self.edges_involving(node) {
                    self.remove_edge(edge.0, edge.1);
                }
                self.handle_demolish_road(*tile);
            }
            self.occupied.remove(&(tile.x, tile.y));
            self.unindex(id, *tile);
        }
        self.objects.remove(id);
    }

    /// Rebuild the tile→building index from the stored buildings.
    pub fn rebuild_occupied(&mut self) {
        self.occupied.clear();
        let placed: Vec<(EntityId, GridCoord, (u8, u8))> = self
            .objects
            .all_entries()
            .iter()
            .filter_map(|e| match &e.object {
                GameObject::Building(b) => e.position.map(|p| (e.id, p, b.size)),
                _ => None,
            })
            .collect();
        for (id, pos, size) in placed {
            for tile in Self::footprint(pos, size) {
                self.occupied.insert((tile.x, tile.y), id);
                self.spatial.entry(crate::world::chunk_of(tile)).or_default().insert(id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(world.road_for_plot(GridCoord { x: 0, y: 0 }, (1, 1)).is_some());
    }

    /// The case the corner rule exists for: no perimeter tile is orthogonally
    /// adjacent to this road, only the corner touches it.
    #[test]
    fn takes_a_road_off_its_corner() {
        let world = world_with_road(&[(1, 1), (2, 2)]);
        assert!(world.road_for_plot(GridCoord { x: 0, y: 0 }, (1, 1)).is_some());
    }

    #[test]
    fn corner_rule_reaches_past_a_wide_footprint() {
        // Footprint covers (0,0) and (1,0); the road only meets its far corner.
        let world = world_with_road(&[(2, 1), (3, 2)]);
        assert!(world.road_for_plot(GridCoord { x: 0, y: 0 }, (2, 1)).is_some());
    }

    #[test]
    fn no_road_in_reach_is_no_access() {
        let world = world_with_road(&[(5, 5), (6, 5)]);
        assert!(world.road_for_plot(GridCoord { x: 0, y: 0 }, (1, 1)).is_none());
    }

    /// A road two tiles out is not access, diagonally or otherwise.
    #[test]
    fn diagonals_do_not_reach_two_tiles() {
        let world = world_with_road(&[(2, 2), (3, 3)]);
        assert!(world.road_for_plot(GridCoord { x: 0, y: 0 }, (1, 1)).is_none());
    }

    fn diagonal_world() -> World {
        world_with_road(&[(0, 0), (1, 1), (2, 2)])
    }

    /// Adjacency is not access. A plot in a diagonal's elbow touches the road
    /// on two sides, but a driveway to either would be a hairpin, so it has no
    /// way to connect and cannot be built.
    #[test]
    fn plot_in_the_elbow_of_a_diagonal_cannot_connect() {
        let world = diagonal_world();
        assert!(world.road_for_plot(GridCoord { x: 1, y: 0 }, (1, 1)).is_none());
    }

    /// The perpendicular of a diagonal is diagonal, so this one connects.
    #[test]
    fn plot_offset_diagonally_from_a_diagonal_connects() {
        let world = diagonal_world();
        assert!(world.road_for_plot(GridCoord { x: 2, y: 0 }, (1, 1)).is_some());
    }

    #[test]
    fn footprint_covers_every_tile() {
        let pos = GridCoord { x: 10, y: 10 };
        let tiles: Vec<_> = World::footprint(pos, (2, 3)).collect();
        assert_eq!(tiles.len(), 6);
        assert_eq!(tiles[0], pos);
        assert_eq!(tiles[5], GridCoord { x: 11, y: 12 });
    }
}
