//! What each building waits on, for the client's pins: every trip that
//! should come to it, and which of them are late (`model::Wait`). Read
//! off the calls, the shelves, the seats, the quay and who at home is
//! hungry; decides nothing, but wakes the building when it would give
//! up (`World::give_up`).

use fixed::HashMap;
use model::blueprint::blueprint;
use model::needs::Need;
use model::{EntityId, GameTime, Good, Leg, Wait, Wanted, Why, LATE_MS};
use traffic::event_queue::EventQueue;
use crate::world::World;

/// The waits of every building whose trips changed (`World::waiting`),
/// written only where they changed. A wait late before keeps the moment
/// it fell late, so its ring goes on filling, and the building is woken
/// as it fills.
pub fn look(world: &mut World, events: &mut EventQueue, now: GameTime) {
    if world.waiting.is_empty() {
        return;
    }
    let mut called: HashMap<EntityId, Vec<(Good, Option<EntityId>)>> = HashMap::default();
    for c in &world.calls {
        called.entry(c.at).or_default().push((c.good, c.answered_by));
    }
    // What is coming by sea, and who is free to work: asked once a look,
    // and only if a late trip needs it.
    let mut coming: Option<Vec<(Good, EntityId)>> = None;
    let mut free: Option<bool> = None;
    for id in std::mem::take(&mut world.waiting) {
        let Some(b) = world.map.building(id) else { continue };
        let road = world.map.street_of(id).is_some();
        let household = world.map.household(id);
        let hungry = household.iter().any(|&r| world.map.resident(r).is_some_and(|r| r.buckets.iter().any(|b| b.need == Need::Eat && b.stock.level <= 0.0)));
        let mut waits = Vec::new();
        for &(good, van) in called.get(&id).into_iter().flatten() {
            let was = b.waits.iter().any(|w| w.what == Wanted::Good(good) && w.late.is_some());
            // A site cannot go on without any of its materials; a shelf or
            // a bin, once it is empty; a home's pantry, once it is empty
            // and someone there is too hungry to work, and once they left
            // for it, until it is filled.
            let empty = b.stocks.get(&good).is_none_or(|s| s.level <= 0.0);
            let stuck = match &b.site {
                Some(_) => van.is_none(),
                None if blueprint(b.kind).homes > 0 => empty && (hungry || (household.is_empty() && was)),
                None => empty,
            };
            let why = stuck.then(|| match van {
                _ if !road => Why::NoRoad,
                Some(van) => Why::OnTheWay(van),
                None => held(world, id, good, coming.get_or_insert_with(|| at_sea(world))),
            });
            waits.push((Wanted::Good(good), why));
        }
        // The quay: packages landed for a depot's lorry, and slots booked
        // out for one to fill.
        waits.extend(b.pad.iter().filter(|p| !p.outbound).chain(&b.outgoing).map(|p| (Wanted::Good(p.good), None)));
        if b.site.is_none() {
            let empty = blueprint(b.kind).jobs.saturating_sub(b.hands);
            let why = if !road {
                Why::NoRoad
            } else if *free.get_or_insert_with(|| world.map.people.values().flatten().any(|&r| world.map.resident(r).is_some_and(|r| r.work.is_none()))) {
                // Someone is free, and works nearer than here would be.
                Why::TooFar
            } else {
                Why::NoHands
            };
            waits.extend((0..empty).map(|_| (Wanted::Hands, Some(why))));
        }
        // The k-th late wait for a thing keeps the k-th one's moment.
        let mut before: Vec<(Wanted, GameTime)> = b.waits.iter().filter_map(|w| Some((w.what, w.late?))).collect();
        let waits: Vec<Wait> = waits
            .into_iter()
            .map(|(what, why)| Wait {
                what,
                late: why.map(|_| match before.iter().position(|&(w, _)| w == what) {
                    Some(i) => before.remove(i).1,
                    None => now,
                }),
                why,
            })
            .collect();
        for t in waits.iter().filter_map(|w| w.late).filter(|&t| t + LATE_MS > now) {
            events.wake(t + LATE_MS - now, id);
        }
        if waits != b.waits
            && let Some(b) = world.map.building_mut(id)
        {
            b.waits = waits;
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::game::tests::*;
    use model::{BuildingKind, Good, Wanted, Why};

    /// A shop sold out with no depot in town waits on bread, late, nobody
    /// having any, and on hands for every seat nobody holds.
    #[test]
    fn a_shop_sold_out_waits_on_bread_and_hands() {
        let mut world = street();
        let shop = build(&mut world, 20, BuildingKind::Shop);
        let mut game = game(world);
        if let Some(b) = game.world.map.building_mut(shop) {
            b.stocks.get_mut(&Good::Bread).unwrap().level = 0.0;
        }
        crate::calls::turn(&mut game.world, &mut game.events, shop, 0);
        crate::waits::look(&mut game.world, &mut game.events, 5);
        let waits = &game.world.map.building(shop).unwrap().waits;
        assert!(waits.iter().any(|w| w.what == Wanted::Good(Good::Bread) && w.late == Some(5) && w.why == Some(Why::Nobody)), "no depot, no ship: nobody has bread; {waits:?}");
        let seats = model::blueprint::blueprint(BuildingKind::Shop).jobs - game.world.map.building(shop).unwrap().hands;
        assert_eq!(waits.iter().filter(|w| w.what == Wanted::Hands).count() as u32, seats);
        // Looked at again later, the bread keeps the moment it fell late.
        game.world.waiting.insert(shop);
        crate::waits::look(&mut game.world, &mut game.events, 99);
        assert!(game.world.map.building(shop).unwrap().waits.iter().any(|w| w.what == Wanted::Good(Good::Bread) && w.late == Some(5)));
    }

    /// A house in a town with no bread anywhere: its pantry calls and
    /// nothing answers. While its two are fed it is a dot; once they are
    /// too hungry to work, a pin, late; a quarter of a day on, they have
    /// moved out, and nobody moves in at midnight while it stays late.
    #[test]
    fn a_hungry_house_pins_bread_and_is_given_up() {
        let mut world = street();
        let house = build(&mut world, 20, BuildingKind::House);
        let mut game = game(world);
        let people = game.world.map.household(house);
        assert_eq!(people.len(), 2, "nobody moved in");
        game.world.map.building_mut(house).unwrap().stocks.get_mut(&Good::Bread).unwrap().level = 0.0;
        crate::calls::turn(&mut game.world, &mut game.events, house, 0);
        crate::waits::look(&mut game.world, &mut game.events, 0);
        let bread = |game: &crate::game::Game| game.world.map.building(house).unwrap().waits.iter().find(|w| w.what == Wanted::Good(Good::Bread)).copied();
        assert_eq!(bread(&game).map(|w| w.late), Some(None), "an empty pantry with its people fed is not a dot");
        for &id in &people {
            let r = game.world.map.resident_mut(id).unwrap();
            r.buckets.iter_mut().find(|b| b.need == model::needs::Need::Eat).unwrap().stock.level = 0.0;
        }
        game.world.waiting.insert(house);
        game.step();
        let late = bread(&game).and_then(|w| w.late).expect("hungry, and the bread not late");
        game.run_to(late + model::LATE_MS - 1000);
        assert_eq!(game.world.map.household(house).len(), 2, "they left before the ring was full");
        game.run_to(late + model::LATE_MS + 1000);
        assert!(game.world.map.household(house).is_empty(), "they stayed hungry");
        assert!(people.iter().all(|&id| game.world.map.resident(id).is_none()));
        game.run_to(model::DAY_MS as u64 + 1000);
        assert!(game.world.map.household(house).is_empty(), "settlers came to a house with nothing to eat");
        assert!(bread(&game).is_some_and(|w| w.late == Some(late)), "the pin went out over an empty pantry");
    }
}

/// Why nothing could be sent: the nearest depot with some, its vans all
/// out; else where the nearest of what is coming is; else nobody has it.
fn held(world: &World, at: EntityId, good: Good, coming: &[(Good, EntityId)]) -> Why {
    let Some(here) = world.map.objects.get(at).and_then(|e| e.position) else { return Why::Nobody };
    let with = world.map.depots().into_iter().filter(|(_, b)| b.stocks.get(&good).is_some_and(|s| s.level > 0.0)).map(|(id, _)| id);
    if let Some(&(_, depot)) = world.map.nearest(here, with).first() {
        return Why::NoVan(depot);
    }
    let by = coming.iter().filter(|&&(g, _)| g == good).map(|&(_, carrier)| carrier);
    world.map.nearest(here, by).first().map_or(Why::Nobody, |&(_, carrier)| Why::Coming(carrier))
}

/// Every package on its way in, and what carries it now.
fn at_sea(world: &World) -> Vec<(Good, EntityId)> {
    crate::haul::packages(world).into_iter().filter(|(t, leg, _)| !t.outbound && !matches!(leg, Leg::Yard)).filter_map(|(t, _, by)| Some((t.good, by?))).collect()
}
