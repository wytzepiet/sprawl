//! What the town may build, and the labs that open the rest
//! (docs/core.md §Unlocks).
//!
//! The kinds stand on a ladder. The first rung is open from the start;
//! each after it opens a kind at a time, once the rung before it is all
//! open, by researcher-hours: an hour of one hand at a lab's desk. The
//! mayor picks the kind, and every lab works at it. Materials still gate
//! every building, open or not.

use std::collections::BTreeSet;

use model::{BuildingKind, GameObject};
use serde::{Deserialize, Serialize};

use crate::world::World;

use BuildingKind::*;

/// The ladder, a rung a row, and the researcher-hours each kind of it takes.
const LADDER: [(&[BuildingKind], f64); 3] = [
    (&[Harbour, House, Depot, Sawmill, Lab], 0.0),
    (&[Farm, Shop, Quarry, Office], 24.0),
    (&[Apartment, GasStation, Supermarket, Factory], 96.0),
];

/// The town's research, as it saves it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Research {
    pub open: BTreeSet<BuildingKind>,
    pub at: Option<BuildingKind>,
    pub done: f64,
}

impl Default for Research {
    /// A new town's: the first rung.
    fn default() -> Self {
        Self { open: LADDER[0].0.iter().copied().collect(), at: None, done: 0.0 }
    }
}

impl Research {
    /// Everything open: a test's town, the fixtures', or a bottomless treasury's.
    pub fn all() -> Self {
        Self { open: BuildingKind::ALL.into_iter().collect(), ..Self::default() }
    }

    /// The first rung not all open, and what each of its kinds takes.
    fn rung(&self) -> Option<(&'static [BuildingKind], f64)> {
        LADDER.into_iter().find(|(kinds, _)| kinds.iter().any(|k| !self.open.contains(k)))
    }

    /// What the clients are sent.
    pub fn shown(&self) -> model::Research {
        let (next, cost) = self.rung().map_or((Vec::new(), 0.0), |(kinds, cost)| (kinds.iter().copied().filter(|k| !self.open.contains(k)).collect(), cost));
        model::Research { open: self.open.iter().copied().collect(), next, at: self.at, done: self.done, of: cost, cost }
    }
}

/// The labs set to a kind, if it is the next rung's and not yet open.
/// What was put into another is kept for nothing: one thing at a time.
pub fn choose(world: &mut World, kind: BuildingKind) {
    let r = &mut world.research;
    if r.at != Some(kind) && r.rung().is_some_and(|(kinds, _)| kinds.contains(&kind) && !r.open.contains(&kind)) {
        r.at = Some(kind);
        r.done = 0.0;
    }
}

/// An hour gone: every hand at a lab's desk puts an hour into what the labs
/// are learning, and once it has all it takes it is open.
pub fn hour(world: &mut World) {
    let Some(kind) = world.research.at else { return };
    let at_desk = world.map.resident_ids().into_iter().filter_map(|id| world.map.resident(id)).filter(|r| r.at.is_some() && r.at == r.work).filter(|r| matches!(r.at.and_then(|b| world.map.objects.get(b)).map(|e| &e.object), Some(GameObject::Building(b)) if b.kind == Lab && b.site.is_none())).count();
    let r = &mut world.research;
    r.done += at_desk as f64;
    let cost = r.rung().map_or(0.0, |(_, cost)| cost);
    if r.done >= cost {
        r.open.insert(kind);
        r.at = None;
        r.done = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The first rung is open; the second's kinds may be learned one at a
    /// time, the third's only once the second's are all open, and nothing
    /// is learned without hands at a lab.
    #[test]
    fn the_ladder_opens_a_rung_at_a_time() {
        let mut world = World::new();
        assert!(world.research.open.contains(&House) && !world.research.open.contains(&Farm));
        assert_eq!(world.research.shown().next, [Farm, Shop, Quarry, Office]);
        choose(&mut world, Apartment);
        assert_eq!(world.research.at, None, "a kind two rungs up was taken up");
        choose(&mut world, Farm);
        assert_eq!(world.research.at, Some(Farm));
        hour(&mut world);
        assert_eq!(world.research.done, 0.0, "learned with nobody at a lab");
        world.research.done = 23.5;
        world.research.open.extend([Shop, Quarry, Office]);
        world.research.done += 0.5;
        hour(&mut world);
        assert!(world.research.open.contains(&Farm), "a full day's hours did not open the farm");
        assert_eq!(world.research.shown().next, [Apartment, GasStation, Supermarket, Factory]);
        assert_eq!(world.research.shown().cost, 96.0);
    }

    /// A lab staffed from the flats beside it learns the farm, the hands
    /// at its desks putting in their hours: within two days of the town's.
    #[test]
    fn a_staffed_lab_learns_the_farm() {
        use crate::game::tests::*;
        let mut world = street();
        build(&mut world, 0, Apartment);
        build(&mut world, 6, Lab);
        let mut game = game(world);
        game.world.research = Research::default();
        choose(&mut game.world, Farm);
        let day = model::DAY_MS as u64;
        while !game.world.research.open.contains(&Farm) && game.step_to(2 * day) {}
        assert!(game.world.research.open.contains(&Farm), "the farm unlearned after two days, {} hours in", game.world.research.done);
        println!("the farm learned at {:.2} days", game.now as f64 / day as f64);
    }
}
