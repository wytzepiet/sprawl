//! What each building waits on, for the client's pins: every trip that
//! should come to it, and which of them are late (`model::Wait`). Read
//! off the calls, the shelves, the seats and the quay; decides nothing.

use fixed::HashMap;
use model::blueprint::blueprint;
use model::{EntityId, GameTime, Wait, Wanted};
use crate::world::World;

/// The waits of every building whose trips changed (`World::waiting`),
/// written only where they changed. A wait late before keeps the moment
/// it fell late, so its ring goes on filling.
pub fn look(world: &mut World, now: GameTime) {
    if world.waiting.is_empty() {
        return;
    }
    let mut called: HashMap<EntityId, Vec<(model::Good, bool)>> = HashMap::default();
    for c in &world.calls {
        called.entry(c.at).or_default().push((c.good, c.answered_by.is_some()));
    }
    for id in std::mem::take(&mut world.waiting) {
        let Some(b) = world.map.building(id) else { continue };
        let mut waits = Vec::new();
        for &(good, answered) in called.get(&id).into_iter().flatten() {
            // A site cannot go on without any of its materials; a shelf or
            // a bin, once it is empty.
            let stuck = match &b.site {
                Some(_) => !answered,
                None => b.stocks.get(&good).is_none_or(|s| s.level <= 0.0),
            };
            waits.push((Wanted::Good(good), stuck));
        }
        // The quay: packages landed for a depot's lorry, and slots booked
        // out for one to fill.
        waits.extend(b.pad.iter().filter(|p| !p.outbound).chain(&b.outgoing).map(|p| (Wanted::Good(p.good), false)));
        if b.site.is_none() {
            let empty = blueprint(b.kind).jobs.saturating_sub(b.hands);
            waits.extend((0..empty).map(|_| (Wanted::Hands, true)));
        }
        // The k-th late wait for a thing keeps the k-th one's moment.
        let mut before: Vec<(Wanted, GameTime)> = b.waits.iter().filter_map(|w| Some((w.what, w.late?))).collect();
        let waits: Vec<Wait> = waits
            .into_iter()
            .map(|(what, stuck)| Wait {
                what,
                late: stuck.then(|| match before.iter().position(|&(w, _)| w == what) {
                    Some(i) => before.remove(i).1,
                    None => now,
                }),
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
    use model::{BuildingKind, Good, Wanted};

    /// A shop sold out with no depot in town waits on bread, late, and on
    /// hands for every seat nobody holds; once a depot answers, the bread
    /// is a dot, then nothing.
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
        assert!(waits.iter().any(|w| w.what == Wanted::Good(Good::Bread) && w.late == Some(5)), "{waits:?}");
        let seats = model::blueprint::blueprint(BuildingKind::Shop).jobs - game.world.map.building(shop).unwrap().hands;
        assert_eq!(waits.iter().filter(|w| w.what == Wanted::Hands).count() as u32, seats);
        // Looked at again later, the bread keeps the moment it fell late.
        game.world.waiting.insert(shop);
        crate::waits::look(&mut game.world, 99);
        assert!(game.world.map.building(shop).unwrap().waits.iter().any(|w| w.what == Wanted::Good(Good::Bread) && w.late == Some(5)));
    }
}
