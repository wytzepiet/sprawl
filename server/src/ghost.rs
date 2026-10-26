//! Where the guide shows a building going: the best place in the town for
//! a kind a step asks for, drawn as a ghost the hand can take, and the
//! street it would need, drawn dashed, when none runs there yet. Found by
//! the rules the hand places by (`World::lies`, `World::fit`), so the
//! ghost always fits once its street is in.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::fixed::HashMap;
use crate::protocol::{BuildingKind, GridCoord, TerrainType};
use crate::world::World;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Ghost {
    pub kind: BuildingKind,
    /// Where the hand would hold it, and which way round (`World::fit`).
    pub at: GridCoord,
    pub facing: u8,
    pub tiles: Vec<GridCoord>,
    /// The street to draw first, from the nearest one to its door, a tile
    /// at a time; empty when one runs there already.
    pub road: Vec<GridCoord>,
}

/// How far from what a kind is best near its ghost may stand, in tiles
/// each way: past this, the guide shows nothing.
const FAR: u32 = 30;

/// How much a tile of street to draw weighs against a tile further from
/// what the kind is best near.
const STREET: f64 = 2.0;

/// The best place for a kind: on the fewest tiles of new street, near
/// what it is best near (`near`), and for a sawmill or a quarry with its
/// ground in reach at least half.
pub fn best(world: &World, kind: BuildingKind) -> Option<Ghost> {
    let near = near(world, kind)?;
    let (to, from) = streets_from(world, near);
    let maker = crate::blueprint::blueprint(kind).makes.and_then(crate::economy::ground).is_some();
    // Nearest first: a place is never better than its distance, so the
    // search ends at the first farther than the best so far.
    let gap = |&(x, y): &(i32, i32)| (x as f64 - near.0).hypot(y as f64 - near.1);
    let mut tiles_near: Vec<(i32, i32)> = to.keys().copied().collect();
    tiles_near.sort_by(|a, b| gap(a).total_cmp(&gap(b)).then(a.cmp(b)));
    let mut found: Option<(f64, Ghost)> = None;
    for (x, y) in tiles_near {
        // Nor better than the street to its door, a few tiles short of
        // the street to the tile held.
        let floor = |s: f64| gap(&(x, y)) - 2.0 + STREET * to[&(x, y)].saturating_sub(4) as f64 > s;
        if found.as_ref().is_some_and(|(s, _)| gap(&(x, y)) - 2.0 > *s) {
            break;
        }
        if found.as_ref().is_some_and(|(s, _)| floor(*s)) {
            continue;
        }
        let at = GridCoord { x, y };
        for facing in 0..4 {
            let Ok(tiles) = world.lies(kind, at, facing) else { continue };
            let fits = world.fit(kind, at, facing).is_ok();
            let door = (!fits).then(|| door(&tiles, kind, facing, &to)).flatten();
            if !fits && door.is_none() {
                continue;
            }
            let streets = door.map_or(0, |d| to[&(d.x, d.y)]);
            let (o, (w, h)) = World::bounds(&tiles);
            let score = STREET * streets as f64 + gap(&(o.x + w as i32 / 2, o.y + h as i32 / 2));
            if found.as_ref().is_some_and(|(s, _)| score >= *s) || (maker && crate::economy::reach_of(world, kind, &tiles) < 0.5) {
                continue;
            }
            let road = door.map(|d| path(d, &from)).unwrap_or_default();
            found = Some((score, Ghost { kind, at, facing, tiles, road }));
        }
    }
    found.map(|(_, g)| g)
}

/// What a kind is best near: a house the work, the rest the harbour.
fn near(world: &World, kind: BuildingKind) -> Option<(f64, f64)> {
    let by = |k: BuildingKind| {
        world.objects.iter().find_map(|e| match &e.object {
            crate::protocol::GameObject::Building(b) if b.kind == k => e.position.map(|p| (p.x as f64, p.y as f64)),
            _ => None,
        })
    };
    (kind == BuildingKind::House).then(|| by(BuildingKind::Sawmill)).flatten().or_else(|| by(BuildingKind::Harbour))
}

/// How many tiles of new street reach each tile of open land from the
/// town's streets, within `FAR` of `near` each way, and the tile each was
/// reached from.
fn streets_from(world: &World, near: (f64, f64)) -> (HashMap<(i32, i32), u32>, HashMap<(i32, i32), (i32, i32)>) {
    let inside = |(x, y): (i32, i32)| (x as f64 - near.0).abs() <= FAR as f64 && (y as f64 - near.1).abs() <= FAR as f64;
    let mut roads: Vec<(i32, i32)> = world.roads.keys().copied().filter(|&t| inside(t)).collect();
    roads.sort();
    let mut to: HashMap<(i32, i32), u32> = roads.iter().map(|&r| (r, 0)).collect();
    let mut from: HashMap<(i32, i32), (i32, i32)> = HashMap::default();
    let mut queue: VecDeque<(i32, i32)> = roads.into();
    let open = |t: (i32, i32)| matches!(world.terrain.get(&t), Some(TerrainType::Grass | TerrainType::Forest)) && !world.occupied.contains_key(&t) && inside(t);
    while let Some((x, y)) = queue.pop_front() {
        let d = to[&(x, y)];
        // Straight first, so a street runs straight where it can, and
        // across a corner only where both sides of it are open.
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
            let n = (x + dx, y + dy);
            if open(n) && (dx == 0 || dy == 0 || (open((x + dx, y)) && open((x, y + dy)))) && !to.contains_key(&n) {
                to.insert(n, d + 1);
                from.insert(n, (x, y));
                queue.push_back(n);
            }
        }
    }
    (to, from)
}

/// The tile before a plot's door with the fewest tiles of street to it.
fn door(tiles: &[GridCoord], kind: BuildingKind, facing: u8, to: &HashMap<(i32, i32), u32>) -> Option<GridCoord> {
    let steps = (-1..=1).flat_map(|dx| (-1..=1).map(move |dy| (dx, dy)));
    tiles
        .iter()
        .flat_map(|&t| steps.clone().map(move |(dx, dy)| (t, GridCoord { x: t.x + dx, y: t.y + dy })))
        .filter(|&(t, n)| (n.x == t.x || n.y == t.y) && World::enters(tiles, kind, facing, n, t))
        .filter_map(|(_, n)| to.get(&(n.x, n.y)).map(|&d| (d, n)))
        .min_by_key(|&(d, n)| (d, n.x, n.y))
        .map(|(_, n)| n)
}

/// The new street from the town's to `door`, its first tile the one off
/// the street, its last the door's.
fn path(door: GridCoord, from: &HashMap<(i32, i32), (i32, i32)>) -> Vec<GridCoord> {
    let mut tiles = vec![door];
    let mut at = (door.x, door.y);
    while let Some(&prev) = from.get(&at) {
        tiles.push(GridCoord { x: prev.0, y: prev.1 });
        at = prev;
    }
    tiles.reverse();
    tiles
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A new town's sawmill is shown by the woods, its street dashed from
    /// the harbour's; with that street drawn it fits where it was shown.
    #[test]
    fn a_new_towns_sawmill_is_shown_by_the_woods() {
        let mut world = crate::hand::town(7, 0);
        let started = std::time::Instant::now();
        let ghost = best(&world, BuildingKind::Sawmill).expect("no ghost");
        let ms = started.elapsed().as_millis();
        assert!(ms < 50, "the ghost took {ms} ms");
        assert!(!ghost.road.is_empty(), "the woods are by the harbour's street");
        assert!(world.road_node_at(ghost.road[0]).is_some(), "its street starts off the town's: {:?}", ghost.road[0]);
        assert!(crate::economy::reach_of(&world, ghost.kind, &ghost.tiles) >= 0.5);
        world.place_road_path(&ghost.road);
        assert!(world.fit(ghost.kind, ghost.at, ghost.facing).is_ok(), "it does not fit on its street: {:?}", world.fit(ghost.kind, ghost.at, ghost.facing));
        let again = best(&world, BuildingKind::Sawmill).expect("no ghost on its street");
        assert!(again.road.is_empty(), "a street to draw again");
    }
}
