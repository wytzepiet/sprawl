//! Fire: now and then a house catches fire, more often the bigger the
//! town, and the nearest fire station with its engine home sends it. There
//! within `FIRE_MS`, the fire is out; else the house burns down and its
//! family leaves. A hamlet never burns; the first fire a village has
//! brings a station to hand, and burns slow enough to place it.

use traffic::event_queue::EventQueue;
use model::{BuildingKind, EntityId, GameTime};
use crate::world::World;
use super::errands::{self, Errand};
use super::{apart, of_kind};

/// How long a house burns before it is lost.
pub const FIRE_MS: GameTime = 90_000;
/// How much longer the town's first fire burns: time to place a station.
const FIRST_MS: GameTime = 150_000;
/// Houses to a fire a day.
const HOUSES_A_FIRE: f64 = 40.0;

/// The town's look round, for fire: one breaks out, by chance; a house
/// burnt through comes down; an engine home goes to a fire nobody is
/// going to.
pub fn look(world: &mut World, events: &mut EventQueue, now: GameTime, every: GameTime) {
    let houses: Vec<EntityId> = of_kind(&world.map, BuildingKind::House).into_iter().map(|(id, _)| id).filter(|&id| world.map.street_of(id).is_some()).collect();
    if world.town.status >= 1 && !houses.is_empty() && world.town.roll() < houses.len() as f64 / HOUSES_A_FIRE * every as f64 / model::DAY_MS as f64 {
        let id = houses[(world.town.roll() * houses.len() as f64) as usize];
        let first = !world.town.met.contains(&BuildingKind::FireStation);
        if let Some(b) = world.map.building_mut(id).filter(|b| b.fire.is_none()) {
            b.fire = Some(if first { now + FIRST_MS } else { now });
            world.news.push(model::News { text: "A house is on fire".into(), sub: if first { "a fire station's engine puts it out".into() } else { "the nearest fire engine is called".into() }, at: id });
            super::picks::unlock(world, BuildingKind::FireStation);
        }
    }
    let burning: Vec<(EntityId, GameTime)> = world.map.objects.iter().filter_map(|e| match e.object {
        model::GameObject::Building(ref b) => b.fire.map(|t| (e.id, t)),
        _ => None,
    }).collect();
    for (house, since) in burning {
        if now >= since + FIRE_MS {
            burn(world, house);
            continue;
        }
        if world.town.errands.values().any(|e| matches!(e, Errand::Fire { to } if *to == house)) {
            continue;
        }
        let mut engines: Vec<(i32, EntityId, EntityId)> = of_kind(&world.map, BuildingKind::FireStation)
            .into_iter()
            .flat_map(|(s, _)| world.map.objects.fleet(s).map(move |c| (s, c)).collect::<Vec<_>>())
            .filter(|&(s, c)| !world.town.errands.contains_key(&c) && world.map.car(c).is_some_and(|car| car.trip.is_none()) && world.map.claims.get(&c) == Some(&s))
            .map(|(s, c)| (apart(&world.map, s, house), s, c))
            .collect();
        engines.sort();
        for (_, station, engine) in engines {
            if errands::trip(world, events, engine, station, house, GameTime::MAX, now) {
                world.town.errands.insert(engine, Errand::Fire { to: house });
                break;
            }
        }
    }
}

/// The engine is there: the fire is out, and it goes home.
pub fn doused(world: &mut World, house: EntityId) {
    if let Some(b) = world.map.building_mut(house) {
        b.fire = None;
    }
    world.news.push(model::News { text: "The fire is out".into(), sub: "the engine got there in time".into(), at: house });
}

/// Burnt through: the house comes down and its family leaves.
fn burn(world: &mut World, house: EntityId) {
    let level = world.map.building(house).and_then(|b| b.home.as_ref()).map_or(1, |h| h.level);
    world.town.left += super::homes::LEVELS[level as usize].people;
    world.town.left_since += 1;
    errands::forget(world, house);
    world.map.remove_building(house);
    world.news.push(model::News { text: "A house burnt down".into(), sub: "no fire engine got there in time".into(), at: 0 });
}
