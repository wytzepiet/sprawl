//! A new town: a fishery on the shore nearest the island's middle, by a
//! wood, with a
//! short street inland, two cottages a little way off, a shop in hand and
//! road enough to join them. Everything else the town asks for.

use std::collections::BTreeMap;

use model::{BuildingKind, EntityId, GameTime, GridCoord};
use map::Map;
use crate::world::World;
use super::START_ROADS;

/// The street a new town's fishery comes with, in tiles.
const LANE: i32 = 6;

pub fn found(world: &mut World, now: GameTime) {
    world.town.allowance = START_ROADS;
    world.town.hand = BTreeMap::from([(BuildingKind::Shop, 1)]);
    world.town.met.extend([BuildingKind::Shop, BuildingKind::Fishery]);
    world.town.roll = world.map.terrain_seed as u64;
    let Some((at, end)) = shore(&mut world.map) else { return };
    world.town.start = Some(GridCoord { x: (at.x + end.x) / 2, y: (at.y + end.y) / 2 });
    super::standing(world);
    // Two cottages a little inland, open grass all round, apart.
    let mut homes: Vec<GridCoord> = Vec::new();
    'out: for r in 5..14 {
        for i in 0..8 * r {
            let (dx, dy) = ring(r, i);
            let p = GridCoord { x: end.x + dx, y: end.y + dy };
            let dry = (-2..=2).all(|ex| (-2..=2).all(|ey| world.map.terrain.get(&(p.x + ex, p.y + ey)) == Some(&land::TerrainType::Grass)));
            if dry && homes.iter().all(|h| (h.x - p.x).abs().max((h.y - p.y).abs()) >= 3) && super::homes::house(world, p, now).is_some() {
                homes.push(p);
                if homes.len() == 2 {
                    break 'out;
                }
            }
        }
    }
}

/// A short street from the fishery's yard straight inland over open
/// grass, never cut through a wood, laid free, so
/// the first shop has somewhere to stand: its far end.
fn lane(map: &mut Map, fishery: EntityId) -> Option<GridCoord> {
    let b = map.building(fishery)?;
    let (dx, dy) = model::blueprint::FACINGS[b.facing as usize % 4];
    let front: Vec<GridCoord> = b.tiles.iter().copied().filter(|t| !b.tiles.contains(&GridCoord { x: t.x + dx, y: t.y + dy })).collect();
    let m = *front.get(front.len() / 2)?;
    let mut path = Vec::new();
    for k in 1..=LANE {
        let p = GridCoord { x: m.x + k * dx, y: m.y + k * dy };
        let dry = map.terrain.get(&(p.x, p.y)) == Some(&land::TerrainType::Grass);
        if !dry || map.occupied.contains_key(&(p.x, p.y)) {
            break;
        }
        path.push(p);
    }
    if path.len() < 4 {
        return None;
    }
    // Laid free: the town's road starts whole.
    map.place_road_path(&path);
    map.open_exit(map.road_node_at(path[0])?);
    path.last().copied()
}

/// The first place on a shore, out from the island's middle, with a wood
/// near enough for the town's first woodcutter, where a fishery stands
/// with its yard to the land; on an island with none, the first place
/// at all. Its tile, and the far end of the lane it comes with.
fn shore(map: &mut Map) -> Option<(GridCoord, GridCoord)> {
    for wood in [true, false] {
        for r in 0..200 {
            for i in 0..(8 * r).max(1) {
                let (x, y) = ring(r, i);
                for facing in 0..4 {
                    let tiles: Vec<GridCoord> = Map::footprint(GridCoord { x, y }, model::blueprint::plot(BuildingKind::Fishery, facing)).collect();
                    if !map.may_stand_on(&tiles, BuildingKind::Fishery, facing) || !map.on_shore(&tiles, facing) || (wood && !wooded(map, GridCoord { x, y })) {
                        continue;
                    }
                    let id = map.raise(BuildingKind::Fishery, tiles, facing);
                    match lane(map, id) {
                        Some(end) => {
                            map.orient(id);
                            return Some((GridCoord { x, y }, end));
                        }
                        None => map.remove_building(id),
                    }
                }
            }
        }
    }
    None
}

/// How near a wood the town begins, and how big a wood, in tiles.
const WOOD_NEAR: i32 = 14;
const WOOD: usize = 40;

fn wooded(map: &Map, at: GridCoord) -> bool {
    (-WOOD_NEAR..=WOOD_NEAR).flat_map(|dx| (-WOOD_NEAR..=WOOD_NEAR).map(move |dy| (at.x + dx, at.y + dy))).filter(|t| map.terrain.get(t) == Some(&land::TerrainType::Forest)).count() >= WOOD
}

/// The `i`th tile round the square ring `r` tiles out from the middle.
fn ring(r: i32, i: i32) -> (i32, i32) {
    if r == 0 {
        return (0, 0);
    }
    let side = 2 * r;
    let (k, t) = (i / side, i % side);
    match k {
        0 => (-r + t, -r),
        1 => (r, -r + t),
        2 => (r - t, r),
        _ => (-r, r - t),
    }
}
