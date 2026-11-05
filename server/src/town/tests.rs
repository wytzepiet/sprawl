//! The town's rules, end to end, on small worlds.

use super::*;
use crate::game::Game;
use crate::game::tests::{build, street};

fn homes(world: &World) -> Vec<&model::Home> {
    world.map.objects.iter().filter_map(|e| match e.object {
        GameObject::Building(ref b) => b.home.as_ref(),
        _ => None,
    }).collect()
}

/// A street of houses, a shop, and a fishery at its end on the shore.
fn fishing_street() -> World {
    let mut world = street();
    for x in 30..60 {
        for y in -30..30 {
            world.map.terrain.insert((x, y), land::TerrainType::Sea);
        }
    }
    // The street runs out to the shore at x = 29.
    world.town.hand.clear();
    world
}

/// The loop, end to end: families want fish and drive to the shop for
/// it; the shop's lorry fetches it from the fishery; nobody waits long
/// enough to leave.
#[test]
fn a_shop_stocked_from_the_fishery_feeds_its_street() {
    let mut world = fishing_street();
    let fishery = world.map.place_on_street(GridCoord { x: 26, y: 1 }, BuildingKind::Fishery).or_else(|| world.map.place_on_street(GridCoord { x: 25, y: 1 }, BuildingKind::Fishery)).expect("a fishery on the shore");
    let shop = build(&mut world, 0, BuildingKind::Shop);
    let first: Vec<EntityId> = [-12, -8, -4, 6, 10].into_iter().map(|x| homes::house(&mut world, GridCoord { x, y: -1 }, 0).expect("a house on the street")).collect();
    world.town.picked = u32::MAX / 2;
    // Nobody else moves in.
    world.town.start = None;
    let mut game = Game::new(world, 0, 1, Box::new(World::new));
    game.run_to(DAY_MS as GameTime * 2);
    let world = &game.world;
    assert!(world.map.building(fishery).is_some() && world.map.building(shop).is_some());
    let stayed: Vec<&model::Home> = first.iter().filter_map(|&h| world.map.building(h)?.home.as_ref()).collect();
    assert_eq!(stayed.len(), 5, "a family left");
}

/// A family nobody brings fish to leaves.
#[test]
fn a_family_kept_waiting_leaves() {
    let mut world = street();
    world.town.hand.clear();
    let h = homes::house(&mut world, GridCoord { x: 0, y: -1 }, 0).unwrap();
    world.town.picked = u32::MAX / 2;
    let mut game = Game::new(world, 0, 1, Box::new(World::new));
    game.run_to(DAY_MS as GameTime * 2);
    assert!(game.world.map.building(h).is_none(), "the family stayed");
    assert!(game.world.town.left >= 2);
}

/// A new town is a fishery on the shore with a street, two cottages near
/// it, and a shop in hand.
#[test]
fn a_town_begins_by_the_water() {
    let mut world = World::from(Map::meadow(-40..40, -30..30));
    for x in 14..40 {
        for y in -30..30 {
            world.map.terrain.insert((x, y), land::TerrainType::Sea);
        }
    }
    let game = Game::new(world, 0, 1, Box::new(World::new));
    let world = &game.world;
    assert_eq!(world.map.objects.of_kind(BuildingKind::Fishery).count(), 1);
    assert_eq!(homes(world).len(), 2);
    assert!(world.town.has(BuildingKind::Shop));
}

/// Wanting what the town has never made brings its chain to hand from
/// the raw end: planks wanted, a woodcutter comes; once it stands, the
/// sawmill.
#[test]
fn a_chain_comes_to_hand_from_its_raw_end() {
    let mut world = street();
    world.town.hand.clear();
    picks::unlock(&mut world, BuildingKind::Sawmill);
    assert!(world.town.has(BuildingKind::Woodcutter) && !world.town.has(BuildingKind::Sawmill));
    for x in -30..-20 {
        for y in 2..12 {
            world.map.terrain.insert((x, y), land::TerrainType::Forest);
        }
    }
    world.map.place_on_street(GridCoord { x: -20, y: 1 }, BuildingKind::Woodcutter).expect("a woodcutter by the wood");
    picks::release(&mut world);
    assert!(world.town.has(BuildingKind::Sawmill));
}
