//! A farm's fields, and the track it lays to them. docs/economy.md §12.8.
//!
//! When a street reaches a farm it lays a track: a street of its own, from
//! the street tile at its plot's corner along its flank and on into open
//! grass, and claims the grass on either side as its fields — tiles on the
//! farm's own record, each with when its crop is ripe, and nothing else:
//! a day after the tractor last took it, by the clock. The track
//! dead-ends in the fields, so nothing routes over it whose destination is
//! not on it: private by construction, and an ordinary junction where it
//! meets the street. Forest, beach and anything already standing stop it,
//! so where the farm goes is the decision; and a field is ordinary grass
//! to the placer and the road brush, so building over one costs the farm
//! that field and nothing else.

use crate::blueprint::{plot, FACINGS};
use crate::economy;
use crate::engine::GameTime;
use crate::protocol::{EntityId, Field, GameObject, GridCoord, TerrainType};
use crate::world::World;

/// How far along its flank a track may run.
const TRACK: i32 = 10;

impl World {
    /// Open grass with nothing on it: what a track is laid over and a
    /// field claimed from, and what a field stays while it is one.
    fn is_grass(&self, t: GridCoord) -> bool {
        self.is_buildable(t) && self.terrain.get(&(t.x, t.y)) == Some(&TerrainType::Grass)
    }

    /// Lay a farm's track and claim its fields, once it stands on a street.
    /// Along whichever flank reaches the street and finds more grass; a
    /// farm with no such flank has no fields, and shows it.
    pub fn lay_fields(&mut self, farm: EntityId) {
        let Some(e) = self.objects.get(farm) else { return };
        let (Some(pos), GameObject::Building(b)) = (e.position, &e.object) else { return };
        let (kind, facing) = (b.kind, b.facing);
        let wanted = economy::fields(kind) as usize;
        if wanted == 0 || !b.fields.is_empty() {
            return;
        }
        let p = plot(kind, facing);
        let (fx, fy) = FACINGS[facing as usize % 4];
        let (w, h) = (p.size.0 as i32, p.size.1 as i32);
        // The plot's two corners on the street side, and the flank that
        // leads away from each.
        let corners: [(GridCoord, (i32, i32)); 2] = match (fx, fy) {
            (0, -1) => [(GridCoord { x: pos.x, y: pos.y }, (-1, 0)), (GridCoord { x: pos.x + w - 1, y: pos.y }, (1, 0))],
            (0, _) => [(GridCoord { x: pos.x, y: pos.y + h - 1 }, (-1, 0)), (GridCoord { x: pos.x + w - 1, y: pos.y + h - 1 }, (1, 0))],
            (-1, _) => [(GridCoord { x: pos.x, y: pos.y }, (0, -1)), (GridCoord { x: pos.x, y: pos.y + h - 1 }, (0, 1))],
            _ => [(GridCoord { x: pos.x + w - 1, y: pos.y }, (0, -1)), (GridCoord { x: pos.x + w - 1, y: pos.y + h - 1 }, (0, 1))],
        };
        let mut best: Option<(Vec<GridCoord>, Vec<GridCoord>)> = None;
        for (corner, (sx, sy)) in corners {
            // The street tile beside the corner, which the track leaves from.
            let start = GridCoord { x: corner.x + sx + fx, y: corner.y + sy + fy };
            if !self.road_node_at(start).is_some_and(|n| self.is_street(n)) {
                continue;
            }
            let mut track = vec![start];
            let mut fields = Vec::new();
            for i in 0..TRACK {
                let t = GridCoord { x: corner.x + sx - fx * i, y: corner.y + sy - fy * i };
                if !self.is_grass(t) || fields.len() >= wanted {
                    break;
                }
                track.push(t);
                for side in [1, -1] {
                    let f = GridCoord { x: t.x + sx * side, y: t.y + sy * side };
                    if fields.len() < wanted && self.is_grass(f) && !fields.contains(&f) {
                        fields.push(f);
                    }
                }
            }
            if !fields.is_empty() && best.as_ref().is_none_or(|(_, f)| fields.len() > f.len()) {
                best = Some((track, fields));
            }
        }
        let Some((track, fields)) = best else { return };
        self.place_road_path(&track);
        if let Some(GameObject::Building(b)) = self.objects.get_mut(farm).map(|e| &mut e.object) {
            b.fields = fields.into_iter().map(|at| Field { at, ripe: 0 }).collect();
            b.track = track;
        }
    }

    /// A field built over, or roaded over, is a field no more: the farm
    /// keeps only the tiles still grass.
    pub fn tend(&mut self, farm: EntityId) {
        let Some(GameObject::Building(b)) = self.objects.get(farm).map(|e| &e.object) else { return };
        let kept: Vec<Field> = b.fields.iter().copied().filter(|f| self.is_grass(f.at)).collect();
        if kept.len() != b.fields.len()
            && let Some(GameObject::Building(b)) = self.objects.get_mut(farm).map(|e| &mut e.object)
        {
            b.fields = kept;
        }
    }

    /// The tractor stands at a track node: the ripe field beside it is
    /// brought in, and starts again from now. Returns the crop.
    pub fn harvest(&mut self, farm: EntityId, node: EntityId, now: GameTime) -> f64 {
        let Some(at) = self.objects.get(node).and_then(|e| e.position) else { return 0.0 };
        let Some(GameObject::Building(b)) = self.objects.get_mut(farm).map(|e| &mut e.object) else { return 0.0 };
        let crop = economy::crop(b.kind);
        let ripe = b.fields.iter_mut().find(|f| (f.at.x - at.x).abs() + (f.at.y - at.y).abs() == 1 && economy::ripe(f, now));
        match ripe {
            Some(f) => {
                f.ripe = now + crate::protocol::DAY_MS as GameTime;
                crop
            }
            None => 0.0,
        }
    }

    /// A farm goes, and its track with it: the tiles it laid, not the
    /// street it left from.
    pub fn take_up_track(&mut self, farm: EntityId) {
        let Some(GameObject::Building(b)) = self.objects.get(farm).map(|e| &e.object) else { return };
        let track: Vec<GridCoord> = b.track.iter().skip(1).copied().collect();
        for t in track {
            if let Some(node) = self.road_node_at(t) {
                for edge in self.edges_involving(node) {
                    self.remove_edge(edge.0, edge.1);
                }
                self.demolish_node(node);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::BuildingKind;

    /// Grass either side of a street along y = 0, deep enough for a farm
    /// and its track.
    fn land() -> World {
        let mut world = World::new();
        for y in -12..12 {
            for x in -4..60 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        world.place_road_path(&(-2..60).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>());
        world
    }

    fn farm_at(world: &mut World, x: i32) -> (EntityId, Vec<Field>) {
        let farm = world.place_on_street(GridCoord { x, y: 1 }, BuildingKind::Farm).unwrap();
        let fields = match world.objects.get(farm).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.fields.clone(),
            _ => unreachable!(),
        };
        (farm, fields)
    }

    /// §12.8: a farm reached by a street lays a track from the street
    /// along its flank and claims eight fields of grass beside it, each
    /// touching the track, which is joined to the street; laid free, and
    /// again does nothing.
    #[test]
    fn a_farm_lays_a_track_and_claims_its_fields() {
        let mut world = land();
        let (farm, fields) = farm_at(&mut world, 10);
        assert_eq!(fields.len(), economy::fields(BuildingKind::Farm) as usize, "the farm claimed {} fields", fields.len());
        let door = world.road_node_for_building(farm).unwrap();
        for f in &fields {
            assert!(world.is_grass(f.at), "a field is not grass");
            let node = crate::calls::beside(&world, f.at).expect("a field touches no track");
            assert!(world.network.connected(door, node), "a field cannot be reached from the farm");
        }
        assert_eq!(world.laid, 0, "the track counted against the build");
        world.lay_fields(farm);
        assert_eq!(farm_at_fields(&world, farm).len(), fields.len(), "laid twice");
        // The track goes with the farm; the street stays.
        let track = match world.objects.get(farm).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.track.clone(),
            _ => unreachable!(),
        };
        assert!(track.len() > 2 && world.road_node_at(track[0]).is_some());
        world.remove_building(farm);
        assert!(world.road_node_at(track[0]).is_some() && track[1..].iter().all(|&t| world.road_node_at(t).is_none()), "the track was left behind");
    }

    fn farm_at_fields(world: &World, farm: EntityId) -> Vec<Field> {
        match world.objects.get(farm).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.fields.clone(),
            _ => Vec::new(),
        }
    }

    /// Forest and beach are not farmland: a farm standing in either, with
    /// no grass along its flanks, claims nothing and shows it.
    #[test]
    fn forest_and_beach_are_not_fields() {
        let mut world = land();
        for y in -12..12 {
            for x in -4..30 {
                world.terrain.insert((x, y), TerrainType::Forest);
            }
            for x in 30..60 {
                world.terrain.insert((x, y), TerrainType::Beach);
            }
        }
        let (_, woods) = farm_at(&mut world, 10);
        let (_, sands) = farm_at(&mut world, 40);
        assert!(woods.is_empty() && sands.is_empty(), "fields were claimed from forest or beach");
    }

    /// A field is ordinary grass to the mayor: build on it and the farm
    /// keeps the rest. A field is ripe a day after its harvest.
    #[test]
    fn a_field_built_over_is_a_field_no_more() {
        let mut world = land();
        let (farm, fields) = farm_at(&mut world, 10);
        let lost = fields[0].at;
        assert!(world.place_building(lost, BuildingKind::House, 2).is_some(), "a field could not be built on");
        world.tend(farm);
        let kept = farm_at_fields(&world, farm);
        assert_eq!(kept.len(), fields.len() - 1);
        assert!(kept.iter().all(|f| f.at != lost));
        // Harvest the first: its crop is the row's, and it is not ripe again
        // until tomorrow.
        let node = crate::calls::beside(&world, kept[0].at).unwrap();
        let day = crate::protocol::DAY_MS as u64;
        assert_eq!(world.harvest(farm, node, 5 * day), economy::crop(BuildingKind::Farm));
        assert_eq!(world.harvest(farm, node, 5 * day + 1000), 0.0, "harvested twice");
        assert_eq!(world.harvest(farm, node, 6 * day), economy::crop(BuildingKind::Farm), "not ripe a day on");
    }
}
