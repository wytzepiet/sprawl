use crate::protocol::{
    Building, BuildingKind, Category, Draft, EntityId, GameObject, GridCoord, Rotation, TerrainType,
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
    ///
    /// Anything staged for demolition does not hold anything: the planner sees
    /// the world as it will be after the commit. That is what lets an artery be
    /// rerouted and built over in one go — pull up the old road, draw the new
    /// one, drop a factory on the old alignment, and commit the lot, so the
    /// traffic never sees a gap.
    pub fn is_buildable(&self, coord: GridCoord) -> bool {
        // A building staged for demolition holds nothing; road_node_at already
        // answers for the world after the commit, so it needs no such check.
        if let Some(id) = self.occupied.get(&(coord.x, coord.y)).copied()
            && !self.is_going_away(id)
        {
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
        rotation: Rotation,
    ) -> Option<EntityId> {
        let tiles: Vec<GridCoord> = Self::footprint(pos, size).collect();
        if !tiles.iter().all(|&t| self.is_buildable(t)) {
            return None;
        }
        let id = self.insert_at(GameObject::Building(Building { kind, size, rotation }), Some(pos));
        for tile in &tiles {
            self.occupied.insert((tile.x, tile.y), id);
            // A footprint can straddle a chunk border, and clients subscribe by
            // chunk — indexed only at its origin, a building would vanish for
            // anyone looking at the other half.
            self.spatial.entry(crate::world::chunk_of(*tile)).or_default().insert(id);
        }
        // A draft has not been built yet, so it has not seen anything either;
        // the survey widens when it commits.
        if self.acting_as.is_none() {
            self.reveal_around(pos);
        }
        Some(id)
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
        let rotation = self.rotation_toward(pos, size, street);
        if let Some(entry) = self.objects.get_mut(id)
            && let GameObject::Building(ref mut b) = entry.object
        {
            b.rotation = rotation;
        }
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
        rotation: Rotation,
    ) -> Option<EntityId> {
        self.road_for_plot(pos, size)?;
        let id = self.place_building(pos, kind, size, rotation)?;
        self.attach_driveway(id);
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

        // A stroke replaces your own drafts that it covers rather than laying
        // around them. That is the whole growth mechanic: widen a stroke and
        // the client re-sends the larger set, so a lone house is torn up and
        // laid again as half an apartment. Committed buildings — and other
        // people's drafts — are never disturbed.
        self.clear_own_drafts_on(tiles);

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

    /// Tear up this owner's uncommitted buildings standing on any of `tiles`.
    fn clear_own_drafts_on(&mut self, tiles: &[GridCoord]) {
        let Some(owner) = self.acting_as else { return };
        let mut doomed: Vec<EntityId> = tiles
            .iter()
            .filter_map(|t| self.occupied.get(&(t.x, t.y)).copied())
            .filter(|&id| self.draft_of(id) == Some(Draft::Added(owner)))
            .collect();
        doomed.sort_unstable();
        doomed.dedup();
        for id in doomed {
            // Takes the driveway with it: that road stands on one of the
            // building's own tiles, which is what makes it the building's.
            self.remove_building(id);
            self.drafts.entry(owner).or_default().remove(&id);
        }
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
            // Only if this tile is still ours. A building staged for demolition
            // can already have its replacement drafted over it, and that one
            // has since claimed the tile — tearing down the old one must not
            // take the new one's occupancy with it.
            if self.occupied.get(&(tile.x, tile.y)) == Some(&id) {
                self.occupied.remove(&(tile.x, tile.y));
            }
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

    const ME: crate::protocol::OwnerId = 1;
    const SOMEONE_ELSE: crate::protocol::OwnerId = 2;

    fn painted(xs: std::ops::Range<i32>, ys: std::ops::Range<i32>) -> Vec<GridCoord> {
        ys.flat_map(|y| xs.clone().map(move |x| GridCoord { x, y })).collect()
    }

    /// The rule the whole feature rests on: a draft is drawn but not driven on.
    #[test]
    fn a_drafted_road_carries_no_traffic_until_committed() {
        let mut world = world_with_road(&[(0, 0), (1, 0)]);
        let before = world.edges.len();

        world.acting_as = Some(ME);
        world.place_road_path(&[GridCoord { x: 1, y: 0 }, GridCoord { x: 2, y: 0 }]);
        assert_eq!(world.edges.len(), before, "a draft must not reach the traffic index");

        world.commit_drafts(ME);
        world.acting_as = None;
        assert!(world.edges.len() > before, "committing is what wires it up");
    }

    /// Discard restores nothing because it destroyed nothing.
    #[test]
    fn discarding_leaves_the_committed_world_untouched() {
        let mut world = world_with_road(&[(0, 1), (1, 1), (2, 1)]);
        let edges = world.edges.len();
        let roads = world.all_buildings().len();

        world.acting_as = Some(ME);
        world.paint_area(&painted(0..3, 0..1), Category::Residential);
        assert!(!world.all_buildings().is_empty(), "the stroke should have drafted something");
        world.discard_drafts(ME);
        world.acting_as = None;

        assert_eq!(world.all_buildings().len(), roads);
        assert_eq!(world.edges.len(), edges);
    }

    /// Widening a stroke re-lays it, which is how a house becomes an apartment.
    #[test]
    fn painting_again_replaces_your_own_drafts() {
        let mut world = world_with_road(&[(0, 1), (1, 1), (2, 1)]);
        world.acting_as = Some(ME);

        world.paint_area(&painted(0..1, 0..1), Category::Residential);
        let first: Vec<_> = world.all_buildings();
        assert_eq!(first.len(), 1);

        // The same tile again, with more beside it: the original is torn up
        // rather than left standing in the way of a wider plot.
        world.paint_area(&painted(0..3, 0..1), Category::Residential);
        let ids: Vec<_> = world.all_buildings().iter().map(|(id, _)| *id).collect();
        assert!(!ids.contains(&first[0].0), "the first draft should have been replaced");
    }

    #[test]
    fn another_players_draft_is_not_yours_to_replace() {
        let mut world = world_with_road(&[(0, 1), (1, 1), (2, 1)]);

        world.acting_as = Some(SOMEONE_ELSE);
        world.paint_area(&painted(0..1, 0..1), Category::Residential);
        let theirs = world.all_buildings();
        assert_eq!(theirs.len(), 1);

        world.acting_as = Some(ME);
        world.paint_area(&painted(0..3, 0..1), Category::Commercial);
        let ids: Vec<_> = world.all_buildings().iter().map(|(id, _)| *id).collect();
        assert!(ids.contains(&theirs[0].0), "their draft must survive my stroke");
    }

    /// Rerouting an artery and building over its old alignment, in one commit,
    /// so the traffic never sees a gap. The old road keeps carrying cars the
    /// whole time it is staged; only the commit takes it away.
    #[test]
    fn an_artery_can_be_moved_and_built_over_in_one_go() {
        // The artery runs east along y=2, with room to redraw it along y=4.
        let mut world = world_with_road(&[(0, 2), (1, 2), (2, 2), (3, 2), (4, 2)]);
        let old: Vec<EntityId> = (1..4)
            .map(|x| world.road_node_at(GridCoord { x, y: 2 }).unwrap())
            .collect();
        let carrying = world.edges.len();

        world.acting_as = Some(ME);
        for &id in &old {
            world.draft_remove(id);
        }
        // Still carrying traffic while it is only staged.
        assert_eq!(world.edges.len(), carrying, "a staged road must keep its traffic");

        // The new alignment, and a factory on the old one.
        world.place_road_path(&[
            GridCoord { x: 0, y: 2 },
            GridCoord { x: 1, y: 3 },
            GridCoord { x: 2, y: 3 },
            GridCoord { x: 3, y: 3 },
            GridCoord { x: 4, y: 2 },
        ]);
        world.paint_area(&painted(1..4, 2..3), Category::Industrial);
        let factory = world.all_buildings();
        assert!(!factory.is_empty(), "the old alignment should now be buildable");

        let committed = world.commit_drafts(ME);
        // By id, as the game loop does: the tile may hold a node for each world.
        for id in committed.removed {
            world.demolish_node(id);
        }
        world.acting_as = None;

        // The factory stands, the new alignment carries, and the old one is
        // gone — except for the one tile the factory kept as its way in.
        assert!(world.objects.get(factory[0].0).is_some(), "the factory survived the commit");
        assert!(world.road_node_at(GridCoord { x: 2, y: 3 }).is_some(), "new alignment laid");

        let driveway = world.road_node_for_building(factory[0].0);
        assert!(driveway.is_some(), "the factory kept a way in");
        for id in old {
            assert!(
                world.objects.get(id).is_none() || Some(id) == driveway,
                "old alignment is lifted, bar the tile that became the driveway",
            );
        }
    }

    /// A road on its way out and a road arriving belong to different worlds —
    /// one to *now*, one to *after* — so they must never form a junction.
    #[test]
    fn a_new_road_does_not_junction_with_one_being_demolished() {
        let mut world = world_with_road(&[(0, 0), (1, 0), (2, 0)]);
        let doomed = world.road_node_at(GridCoord { x: 1, y: 0 }).unwrap();

        world.acting_as = Some(ME);
        world.draft_remove(doomed);
        // Straight past it, one tile north.
        world.place_road_path(&[GridCoord { x: 0, y: 1 }, GridCoord { x: 1, y: 1 }, GridCoord { x: 2, y: 1 }]);
        let fresh = world.road_node_at(GridCoord { x: 1, y: 1 }).unwrap();

        let arms = |id| match &world.objects.get(id).unwrap().object {
            GameObject::RoadNode(n) => {
                n.outgoing.iter().chain(n.incoming.iter()).copied().collect::<Vec<_>>()
            }
            _ => unreachable!(),
        };
        assert!(!arms(fresh).contains(&doomed), "the new road reached for one that is leaving");
        assert!(!arms(doomed).contains(&fresh), "the leaving road reached for a new one");
    }

    /// A tile where the two worlds disagree holds a node for each: the one
    /// being demolished, still carrying traffic, and the one arriving. Neither
    /// borrows the other's shape, which is what stops a crossing drawing a
    /// junction that belongs to neither.
    #[test]
    fn a_crossing_gives_the_tile_a_node_for_each_world() {
        let mut world = world_with_road(&[(0, 0), (1, 0), (2, 0)]);
        let doomed = world.road_node_at(GridCoord { x: 1, y: 0 }).unwrap();

        world.acting_as = Some(ME);
        world.draft_remove(doomed);
        // A new road crossing it at right angles, straight through the tile.
        world.place_road_path(&[
            GridCoord { x: 1, y: -1 },
            GridCoord { x: 1, y: 0 },
            GridCoord { x: 1, y: 1 },
        ]);

        let fresh = world.road_node_at(GridCoord { x: 1, y: 0 }).unwrap();
        assert_ne!(fresh, doomed, "the crossing must not take over the doomed node");
        assert_eq!(
            world.objects.get(doomed).and_then(|e| e.position),
            Some(GridCoord { x: 1, y: 0 }),
            "the doomed node still stands on the same tile",
        );

        let arms = |id| match &world.objects.get(id).unwrap().object {
            GameObject::RoadNode(n) => {
                n.outgoing.iter().chain(n.incoming.iter()).copied().collect::<Vec<_>>()
            }
            _ => unreachable!(),
        };
        assert!(!arms(fresh).contains(&doomed), "the two worlds shared an arm");
        assert!(!arms(doomed).contains(&fresh), "the two worlds shared an arm");

        // The old artery keeps running through the tile until the commit.
        let west = world.road_node_at(GridCoord { x: 0, y: 0 }).unwrap();
        assert!(world.edges.contains_key(&(west, doomed)), "traffic still uses it");
    }

    /// Demolish half a straight road and the survivor is a dead end, free to
    /// turn a corner it could never have turned while the other half stood.
    ///
    /// The demolished half keeps carrying traffic and keeps its own shape; it
    /// is simply no longer something the surviving road reaches for.
    #[test]
    fn a_road_demolished_up_to_a_point_frees_the_survivor_to_turn() {
        let mut world = world_with_road(&[(0, 0), (1, 0), (2, 0), (3, 0)]);
        let survivor = world.road_node_at(GridCoord { x: 1, y: 0 }).unwrap();
        let doomed = world.road_node_at(GridCoord { x: 2, y: 0 }).unwrap();

        // While the whole road stands, turning back on itself is too sharp.
        assert!(world.would_be_too_sharp(GridCoord { x: 1, y: 0 }, 1, 1, false));

        world.acting_as = Some(ME);
        world.draft_remove(doomed);
        world.draft_remove(world.road_node_at(GridCoord { x: 3, y: 0 }).unwrap());

        assert!(
            !world.would_be_too_sharp(GridCoord { x: 1, y: 0 }, 1, 1, false),
            "the arm toward the demolished half should no longer be in the way",
        );
        assert!(
            !world.arms_of(survivor, false).contains(&doomed),
            "the survivor still reaches for what is leaving",
        );
        assert!(
            world.arms_of(doomed, false).contains(&survivor),
            "the demolished road should still draw through to where it reached",
        );

        // And the turn can actually be laid.
        world.place_road_path(&[GridCoord { x: 1, y: 0 }, GridCoord { x: 2, y: 1 }]);
        assert!(world.road_node_at(GridCoord { x: 2, y: 1 }).is_some());
    }

    /// A driveway is not a street. Without this a plot behind a house takes its
    /// access off that house's driveway, and you get a road running into one
    /// building and straight on into the next.
    #[test]
    fn a_plot_cannot_front_onto_someone_elses_driveway() {
        let mut world = world_with_road(&[(0, 1), (1, 1), (2, 1)]);

        // A house on the street, which lays a driveway on its own tile.
        let house = world
            .spawn_building(GridCoord { x: 1, y: 0 }, BuildingKind::House, (1, 1), Rotation::North)
            .unwrap();
        let driveway = world.road_node_for_building(house).unwrap();
        assert_eq!(
            world.objects.get(driveway).and_then(|e| e.position),
            Some(GridCoord { x: 1, y: 0 }),
            "the driveway stands on the house's own tile",
        );

        // The plot behind it touches that driveway and nothing else.
        assert!(
            world.road_for_plot(GridCoord { x: 1, y: -1 }, (1, 1)).is_none(),
            "a driveway is spoken for; it cannot be another plot's street",
        );
        // And the street one row further along still serves normally.
        assert!(world.road_for_plot(GridCoord { x: 2, y: 0 }, (1, 1)).is_some());
    }

    /// Painting a deep block, not just a frontage strip: no driveway may ever
    /// run into a building and on into the next one.
    #[test]
    fn no_driveway_chains_through_a_painted_block() {
        let mut world = world_with_road(&[(0, 1), (1, 1), (2, 1), (3, 1), (4, 1), (5, 1)]);
        world.acting_as = Some(ME);
        // Several rows deep, so the back rows can only reach the street through
        // the front row's driveways.
        world.paint_area(&painted(0..6, -4..1), Category::Residential);

        let occupied_tiles: HashSet<(i32, i32)> = world.occupied.keys().copied().collect();
        for (id, _) in world.all_buildings() {
            let Some(drive) = world.road_node_for_building(id) else { continue };
            for arm in world.arms_of(drive, false) {
                let pos = world.objects.get(arm).and_then(|e| e.position).unwrap();
                assert!(
                    !occupied_tiles.contains(&(pos.x, pos.y)),
                    "a driveway reaches into another building at {pos:?}",
                );
            }
        }
    }

    /// A plot will not take a driveway onto a road that is on its way out.
    #[test]
    fn a_road_staged_for_removal_is_not_access() {
        let mut world = world_with_road(&[(0, 1), (1, 1)]);
        let road = world.road_node_at(GridCoord { x: 0, y: 1 }).unwrap();

        world.acting_as = Some(ME);
        world.draft_remove(road);
        let other = world.road_node_at(GridCoord { x: 1, y: 1 }).unwrap();
        world.draft_remove(other);

        assert!(world.road_for_plot(GridCoord { x: 0, y: 0 }, (1, 1)).is_none());
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
        world.paint_area(&painted(0..2, 0..1), Category::Residential);
        agrees_with_the_edges(&world);

        let house = world.all_buildings()[0].0;
        let door = world.road_node_for_building(house).unwrap();
        let street = world.road_node_at(GridCoord { x: 2, y: 1 }).unwrap();
        assert!(world.network.connected(door, street), "a driveway is part of the network");
    }

    #[test]
    fn demolishing_a_building_takes_its_driveway_out_of_the_network() {
        let mut world = world_with_road(&[(0, 1), (1, 1), (2, 1)]);
        world.paint_area(&painted(0..2, 0..1), Category::Residential);
        let house = world.all_buildings()[0].0;
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
        world.paint_area(&painted(0..1, 0..1), Category::Residential);
        world.paint_area(&painted(4..5, 0..1), Category::Commercial);
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
        world.paint_area(&painted(1..2, 0..1), Category::Residential);
        let house = world.all_buildings()[0].0;
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
