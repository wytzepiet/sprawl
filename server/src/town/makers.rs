//! Makers: a crate every so often at a full crew, at half the pace with
//! nobody in, from what its lorry fetched; stacked in its yard until someone
//! comes for it. A farm's crates are its tractor's harvest
//! (`tractor.rs`).

use traffic::event_queue::EventQueue;
use model::blueprint::blueprint;
use model::{EntityId, GameTime};
use crate::world::World;

/// How often a maker looks at its work.
const TURN_MS: GameTime = 1_000;

pub fn turn(world: &mut World, events: &mut EventQueue, id: EntityId, now: GameTime) {
    let Some(b) = world.map.building(id) else { return };
    let row = blueprint(b.kind);
    if row.farm {
        world.farm_run(events, id, now);
        events.wake(TURN_MS * 3, id);
        return;
    }
    events.wake(TURN_MS, id);
    let Some(good) = row.makes else { return };
    if world.map.street_of(id).is_none() {
        return;
    }
    // Some work gets done with nobody in: the owner's own.
    let crew = (b.present as f64 / row.seats.max(1) as f64).min(1.0);
    let ground = (world.map.in_reach(b.kind, &b.tiles) * 2.0).min(1.0);
    let full = b.stocks.get(&good).is_none_or(|s| s.short() < 1.0);
    let fed = row.takes.iter().all(|&(g, n)| b.stocks.get(&g).is_some_and(|s| s.level + 1e-9 >= n as f64));
    if full || !fed || ground == 0.0 {
        return;
    }
    let pace = TURN_MS as f64 / row.every as f64 * (0.5 + 0.5 * crew) * ground;
    let Some(b) = world.map.building_mut(id) else { return };
    b.work += pace;
    if b.work < 1.0 {
        return;
    }
    b.work -= 1.0;
    for &(g, n) in row.takes {
        if let Some(s) = b.stocks.get_mut(&g) {
            s.level -= n as f64;
        }
    }
    if let Some(s) = b.stocks.get_mut(&good) {
        s.level += 1.0;
    }
    *world.town.tally.entry(("made", good)).or_default() += 1;
}
