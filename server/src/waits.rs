//! What each building waits on, for the client's pins: every trip that
//! should come to it, and which of them are late (`model::Wait`). Read
//! off the calls, the shelves, the seats and the quay; decides nothing.

use fixed::HashMap;
use model::blueprint::blueprint;
use model::{EntityId, GameTime, Good, Leg, Wait, Wanted, Why};
use crate::world::World;

/// The waits of every building whose trips changed (`World::waiting`),
/// written only where they changed. A wait late before keeps the moment
/// it fell late, so its ring goes on filling.
pub fn look(world: &mut World, now: GameTime) {
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
        let mut waits = Vec::new();
        for &(good, van) in called.get(&id).into_iter().flatten() {
            // A site cannot go on without any of its materials; a shelf or
            // a bin, once it is empty.
            let stuck = match &b.site {
                Some(_) => van.is_none(),
                None => b.stocks.get(&good).is_none_or(|s| s.level <= 0.0),
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
        crate::waits::look(&mut game.world, 5);
        let waits = &game.world.map.building(shop).unwrap().waits;
        assert!(waits.iter().any(|w| w.what == Wanted::Good(Good::Bread) && w.late == Some(5) && w.why == Some(Why::Nobody)), "no depot, no ship: nobody has bread; {waits:?}");
        let seats = model::blueprint::blueprint(BuildingKind::Shop).jobs - game.world.map.building(shop).unwrap().hands;
        assert_eq!(waits.iter().filter(|w| w.what == Wanted::Hands).count() as u32, seats);
        // Looked at again later, the bread keeps the moment it fell late.
        game.world.waiting.insert(shop);
        crate::waits::look(&mut game.world, 99);
        assert!(game.world.map.building(shop).unwrap().waits.iter().any(|w| w.what == Wanted::Good(Good::Bread) && w.late == Some(5)));
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
