//! What every test of the game starts from.

use model::{BuildingKind, EntityId, GridCoord};
use map::Map;
use crate::world::World;

/// Open grass, a street along y = 0, and a town that may lay what it
/// likes, use every tool, and has every kind in hand.
pub fn street() -> World {
    let mut world = World::from(Map::meadow(-40..60, -30..30).street(-30..50));
    world.town.start = Some(GridCoord { x: 0, y: 0 });
    world.town.boundless();
    for kind in BuildingKind::ALL {
        world.town.hand.insert(kind, 100);
    }
    world
}

/// A building of a kind standing on the street, its corner at `x`.
pub fn build(world: &mut World, x: i32, kind: BuildingKind) -> EntityId {
    world.map.place_on_street(GridCoord { x, y: 1 }, kind).unwrap_or_else(|| panic!("no room for a {kind:?} at {x}"))
}
