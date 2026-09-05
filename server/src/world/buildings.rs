use crate::protocol::{
    Building, BuildingKind, EntityId, GameObject, GridCoord, TerrainType,
};
use crate::world::World;

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
    ///
    pub fn is_buildable(&self, coord: GridCoord) -> bool {
        if self.occupied.contains_key(&(coord.x, coord.y)) {
            return false;
        }
        if self.road_node_at(coord).is_some() {
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

    /// May a plot take its access from this road?
    ///
    /// Today that reads as: is it a street rather than a driveway. A driveway
    /// stands on a building's own tile — that is exactly what makes it that
    /// building's — so it is already spoken for, and a plot fronting onto one
    /// would run its door through somebody else's hallway.
    ///
    /// This is where access rules about a road belong, and the only place they
    /// belong. More road types are coming, and a motorway that admits no
    /// frontage answers here too, rather than at each call site in turn.
    fn is_street(&self, id: EntityId) -> bool {
        let Some(pos) = self.objects.get(id).and_then(|e| e.position) else { return false };
        !self.occupied.contains_key(&(pos.x, pos.y))
    }

    /// Is the only thing standing here a road that dead-ends on this tile?
    ///
    /// A building may be raised over one, because that is what a driveway is:
    /// a road that ends inside the plot. A road carrying traffic through has
    /// two arms and is a street, and a street may not be built over.
    ///
    fn is_driveway_stub(&self, coord: GridCoord) -> bool {
        let Some(node) = self.road_node_at(coord) else { return false };
        if self.unique_connection_count(node) > 1 {
            return false;
        }
        if self.occupied.contains_key(&(coord.x, coord.y)) {
            return false;
        }
        matches!(
            self.terrain.get(&(coord.x, coord.y)),
            Some(TerrainType::Grass | TerrainType::Beach | TerrainType::Forest)
        )
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
                    && self.is_street(id)
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
                && self.is_street(id)
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

    /// Every building, as (id, position). Only tests still want the world
    /// flattened like this; the simulation itself always knows which building
    /// it means.
    #[cfg(test)]
    pub fn all_buildings(&self) -> Vec<(EntityId, GridCoord)> {
        self.objects
            .all_entries()
            .iter()
            .filter(|e| matches!(e.object, GameObject::Building(_)))
            .filter_map(|e| e.position.map(|p| (e.id, p)))
            .collect()
    }

    /// Put a building on the map, road or no road.
    ///
    /// Everything that has to happen per building — occupancy, spatial
    /// indexing across every chunk it touches, revealing the map — happens
    /// here, so none of it can be forgotten at a call site. A building with
    /// no road is dormant: it stands, and nothing serves it until one comes.
    pub fn place_building(
        &mut self,
        pos: GridCoord,
        kind: BuildingKind,
        size: (u8, u8),
    ) -> Option<EntityId> {
        let tiles: Vec<GridCoord> = Self::footprint(pos, size).collect();
        if !tiles.iter().all(|&t| self.is_buildable(t) || self.is_driveway_stub(t)) {
            return None;
        }
        let id = self.insert_at(GameObject::Building(Building { kind, size }), Some(pos));
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

    /// Take away whatever driveway serves the building on this tile, wherever
    /// on the plot it happens to stand.
    ///
    /// A building takes exactly one, so this is what makes drawing a new road
    /// into it *move* the driveway rather than give it a second.
    pub(super) fn clear_driveway(&mut self, tile: GridCoord) {
        let Some(claimed) = self.claimed_plot_at(tile) else { return };
        let Some((pos, size)) = self.plot_of(claimed) else { return };
        let doomed: Vec<EntityId> =
            Self::footprint(pos, size).filter_map(|t| self.road_node_at(t)).collect();
        for id in doomed {
            for edge in self.edges_involving(id) {
                self.remove_edge(edge.0, edge.1);
            }
            self.demolish_node(id);
        }
    }

    /// Where something stands and how much room it takes.
    fn plot_of(&self, id: EntityId) -> Option<(GridCoord, (u8, u8))> {
        let e = self.objects.get(id)?;
        let GameObject::Building(ref b) = e.object else { return None };
        Some((e.position?, b.size))
    }

    /// The building on this tile, if any.
    pub(super) fn claimed_plot_at(&self, tile: GridCoord) -> Option<EntityId> {
        self.occupied.get(&(tile.x, tile.y)).copied()
    }

    /// Give a building its driveway, if a street is adjacent. Already served,
    /// or nothing adjacent: nothing happens. The driveway is an ordinary road
    /// that happens to end inside the building: the car drives in and
    /// despawns there.
    pub fn attach_driveway(&mut self, id: EntityId) -> bool {
        if self.road_node_for_building(id).is_some() {
            return true;
        }
        let Some(entry) = self.objects.get(id) else { return false };
        let (Some(pos), GameObject::Building(b)) = (entry.position, &entry.object) else {
            return false;
        };
        let size = b.size;
        let Some((street, door)) = self.road_for_plot(pos, size) else { return false };
        let Some(street_pos) = self.objects.get(street).and_then(|e| e.position) else {
            return false;
        };
        self.place_road_path(&[street_pos, door]);
        true
    }

    /// Every dormant building beside any of these tiles gets its driveway.
    /// Called for every road laid for real, so a road reaching a building
    /// is all it takes.
    pub fn attach_driveways_along(&mut self, tiles: &[GridCoord]) {
        let mut near: Vec<EntityId> = tiles
            .iter()
            .flat_map(|t| {
                (-1..=1).flat_map(move |dx| (-1..=1).map(move |dy| (t.x + dx, t.y + dy)))
            })
            .filter_map(|t| self.occupied.get(&t).copied())
            .collect();
        near.sort_unstable();
        near.dedup();
        for id in near {
            self.attach_driveway(id);
        }
    }

    /// A building that can be driven to, or nothing. What painting and the
    /// starting town want: a purchase with no feedback is not a purchase.
    pub fn spawn_building(
        &mut self,
        pos: GridCoord,
        kind: BuildingKind,
        size: (u8, u8),
    ) -> Option<EntityId> {
        self.road_for_plot(pos, size)?;
        let id = self.place_building(pos, kind, size)?;
        self.attach_driveway(id);
        Some(id)
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
    use std::collections::HashSet;

    /// A world with nothing in it but grass and the given road path.
    fn world_with_road(path: &[(i32, i32)]) -> World {
        let mut world = World::new();
        for y in -8..8 {
            for x in -8..8 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        let coords: Vec<GridCoord> = path.iter().map(|&(x, y)| GridCoord { x, y }).collect();
        world.place_road_path(&coords);
        world
    }

    #[test]
    fn a_building_cannot_be_raised_over_a_street() {
        // Adjacent steps, so the middle tile really is a node with two arms.
        let mut world = world_with_road(&[(1, 0), (2, 0), (3, 0)]);
        assert!(
            world.place_building(GridCoord { x: 2, y: 0 }, BuildingKind::House, (1, 1)).is_none(),
            "the road runs through, so nothing may stand on it"
        );
    }

    /// A driveway is drawn, not granted. The player runs a road into the plot
    /// like any other, and that is the door.
    #[test]
    fn a_road_drawn_into_a_plot_becomes_its_driveway() {
        let mut world = world_with_road(&[(0, 2), (4, 2)]);
        let b = world
            .place_building(GridCoord { x: 2, y: 0 }, BuildingKind::House, (1, 1))
            .unwrap();

        world.handle_place_road(GridCoord { x: 2, y: 1 }, GridCoord { x: 2, y: 0 }, false);
        let door = world.road_node_at(GridCoord { x: 2, y: 0 });
        assert!(door.is_some(), "the road ran into the plot");
        assert_eq!(world.road_node_for_building(b), door);
    }

    /// The one thing that makes a driveway special: there is only ever one, and
    /// it is the one you drew last. Drawing a second moves it.
    #[test]
    fn a_second_driveway_replaces_the_first() {
        let mut world = world_with_road(&[(0, 2), (4, 2)]);
        world.place_road_path(&[GridCoord { x: 0, y: 2 }, GridCoord { x: 0, y: 0 }]);
        let b = world
            .place_building(GridCoord { x: 1, y: 0 }, BuildingKind::House, (2, 1))
            .unwrap();

        // In from below, then in from the left. Two different tiles of the plot.
        world.handle_place_road(GridCoord { x: 2, y: 1 }, GridCoord { x: 2, y: 0 }, false);
        assert!(world.road_node_at(GridCoord { x: 2, y: 0 }).is_some());

        world.handle_place_road(GridCoord { x: 0, y: 0 }, GridCoord { x: 1, y: 0 }, false);
        assert!(world.road_node_at(GridCoord { x: 1, y: 0 }).is_some(), "the new door is open");
        assert!(world.road_node_at(GridCoord { x: 2, y: 0 }).is_none(), "and the old one is gone");
        assert_eq!(world.road_node_for_building(b), world.road_node_at(GridCoord { x: 1, y: 0 }));
    }

    /// A road ends at a building. Letting one leave again would put a through
    /// road across somebody's hallway, and give the plot two doors besides.
    #[test]
    fn a_road_cannot_carry_on_out_of_a_building() {
        let mut world = world_with_road(&[(0, 2), (4, 2)]);
        world
            .place_building(GridCoord { x: 2, y: 0 }, BuildingKind::House, (1, 1))
            .unwrap();
        world.handle_place_road(GridCoord { x: 2, y: 1 }, GridCoord { x: 2, y: 0 }, false);

        world.handle_place_road(GridCoord { x: 2, y: 0 }, GridCoord { x: 3, y: 0 }, false);
        assert!(world.road_node_at(GridCoord { x: 3, y: 0 }).is_none(), "the road stops at the door");
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

    /// The reachability index is maintained edit by edit rather than rebuilt,
    /// so the thing worth testing is that it never drifts from the graph it
    /// claims to describe. Brute-forces the answer and demands agreement.
    fn agrees_with_the_edges(world: &World) {
        let mut adj: std::collections::HashMap<EntityId, Vec<EntityId>> =
            std::collections::HashMap::new();
        for &(a, b) in world.edges.keys() {
            adj.entry(a).or_default().push(b);
            adj.entry(b).or_default().push(a);
        }
        let nodes: Vec<EntityId> = adj.keys().copied().collect();
        for &from in &nodes {
            let mut seen = HashSet::from([from]);
            let mut stack = vec![from];
            while let Some(n) = stack.pop() {
                for &next in adj.get(&n).into_iter().flatten() {
                    if seen.insert(next) {
                        stack.push(next);
                    }
                }
            }
            for &to in &nodes {
                assert_eq!(
                    world.network.connected(from, to),
                    seen.contains(&to),
                    "index disagrees about {from} -> {to}",
                );
            }
        }
    }

    /// Demolition as the game loop does it: edges first, then the node.
    fn lift_road(world: &mut World, at: GridCoord) {
        let Some(id) = world.road_node_at(at) else { return };
        for edge in world.edges_involving(id) {
            world.remove_edge(edge.0, edge.1);
        }
        world.demolish_node(id);
    }

    /// One house on one tile, built.
    fn house(world: &mut World, x: i32, y: i32) -> EntityId {
        world
            .spawn_building(GridCoord { x, y }, BuildingKind::House, (1, 1))
            .expect("a road should be beside it")
    }

    #[test]
    fn the_index_follows_roads_being_laid() {
        let mut world = world_with_road(&[(0, 0), (1, 0), (2, 0)]);
        agrees_with_the_edges(&world);

        // A second road that touches nothing is a second network.
        world.place_road_path(&[GridCoord { x: 0, y: 5 }, GridCoord { x: 1, y: 5 }]);
        let a = world.road_node_at(GridCoord { x: 0, y: 0 }).unwrap();
        let b = world.road_node_at(GridCoord { x: 1, y: 5 }).unwrap();
        assert!(!world.network.connected(a, b), "roads that never meet are two networks");
        agrees_with_the_edges(&world);

        // Joining them makes one.
        world.place_road_path(&[
            GridCoord { x: 2, y: 0 },
            GridCoord { x: 2, y: 5 },
            GridCoord { x: 1, y: 5 },
        ]);
        assert!(world.network.connected(a, b), "a road between them joins them");
        agrees_with_the_edges(&world);
    }

    #[test]
    fn lifting_a_road_cuts_the_network_where_it_stood() {
        let mut world = world_with_road(&[(0, 0), (1, 0), (2, 0), (3, 0)]);
        let west = world.road_node_at(GridCoord { x: 0, y: 0 }).unwrap();
        let east = world.road_node_at(GridCoord { x: 3, y: 0 }).unwrap();
        assert!(world.network.connected(west, east));

        lift_road(&mut world, GridCoord { x: 2, y: 0 });
        assert!(!world.network.connected(west, east), "the cut severs the road");
        agrees_with_the_edges(&world);
    }

    #[test]
    fn lifting_one_road_of_a_loop_leaves_it_whole() {
        let mut world = world_with_road(&[(0, 0), (1, 0), (2, 0), (2, 1), (2, 2), (1, 2), (0, 2), (0, 1), (0, 0)]);
        let a = world.road_node_at(GridCoord { x: 0, y: 0 }).unwrap();
        let b = world.road_node_at(GridCoord { x: 2, y: 2 }).unwrap();

        lift_road(&mut world, GridCoord { x: 1, y: 0 });
        assert!(world.network.connected(a, b), "the long way round still joins them");
        agrees_with_the_edges(&world);
    }

    #[test]
    fn a_driveway_joins_its_building_to_the_street() {
        let mut world = world_with_road(&[(0, 1), (1, 1), (2, 1)]);
        house(&mut world, 0, 0);
        agrees_with_the_edges(&world);

        let house = world.all_buildings()[0].0;
        let door = world.road_node_for_building(house).unwrap();
        let street = world.road_node_at(GridCoord { x: 2, y: 1 }).unwrap();
        assert!(world.network.connected(door, street), "a driveway is part of the network");
    }

    #[test]
    fn demolishing_a_building_takes_its_driveway_out_of_the_network() {
        let mut world = world_with_road(&[(0, 1), (1, 1), (2, 1)]);
        let house = house(&mut world, 0, 0);
        let door = world.road_node_for_building(house).unwrap();

        world.remove_building(house);
        assert_eq!(world.network.component_of(door), None, "the driveway went with it");
        agrees_with_the_edges(&world);
    }

    /// The index refuses searches it knows will fail. The risk in that is
    /// refusing one that would have succeeded, which no amount of "nothing
    /// crashed" would show.
    #[test]
    fn a_search_across_one_network_still_finds_its_way() {
        let mut world = world_with_road(&[(0, 1), (1, 1), (2, 1), (3, 1), (4, 1)]);
        house(&mut world, 0, 0);
        house(&mut world, 4, 0);
        let buildings = world.all_buildings();
        assert_eq!(buildings.len(), 2);

        let from = world.road_node_for_building(buildings[0].0).unwrap();
        let to = world.road_node_for_building(buildings[1].0).unwrap();
        assert!(
            crate::world::pathfinding::find_path(&world, from, to).is_some(),
            "a road runs between them, so a car must be able to drive it",
        );
    }

    #[test]
    fn a_search_onto_an_island_is_refused() {
        let mut world = world_with_road(&[(0, 1), (1, 1), (2, 1)]);
        world.place_road_path(&[GridCoord { x: 0, y: 6 }, GridCoord { x: 1, y: 6 }]);
        let here = world.road_node_at(GridCoord { x: 0, y: 1 }).unwrap();
        let island = world.road_node_at(GridCoord { x: 1, y: 6 }).unwrap();
        assert!(crate::world::pathfinding::find_path(&world, here, island).is_none());
    }

    #[test]
    fn a_straight_street_is_one_segment_and_a_junction_splits_it() {
        let mut world = world_with_road(&[(0, 0), (1, 0), (2, 0), (3, 0), (4, 0)]);
        assert_eq!(world.network.segment_count(), 1, "an unbroken street is one run");

        // A side road off the middle: the street becomes two, plus the branch.
        world.place_road_path(&[GridCoord { x: 2, y: 0 }, GridCoord { x: 2, y: 1 }]);
        assert_eq!(world.network.segment_count(), 3, "a junction cuts the run");

        lift_road(&mut world, GridCoord { x: 2, y: 1 });
        assert_eq!(world.network.segment_count(), 1, "and the halves join back up");
    }

    #[test]
    fn a_driveway_is_a_segment_of_its_own() {
        let mut world = world_with_road(&[(0, 1), (1, 1), (2, 1)]);
        let house = house(&mut world, 1, 0);
        let door = world.road_node_for_building(house).unwrap();

        // The driveway hangs off the street, so the street is cut where it
        // joins and the driveway is its own short run.
        assert_eq!(world.network.segments_at(door).count(), 1, "a dead end has one run");
        assert_eq!(world.network.segment_count(), 3, "two halves of street, plus the driveway");
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
