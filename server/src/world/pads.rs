//! Where goods sit, and the forklifts that move them
//! (docs/plan-goods.md §Pads and handling).
//!
//! Every place goods sit is a pad of slots you can see: a depot's yard, a
//! maker's, a shop's back door, a site, the harbour's quay. A depot's,
//! a maker's and a buyer's pad is its stock, counted in whole packages
//! (`Good::per_package`); the quay's is the packages standing on it
//! (`Building::pad`). Moving packages between a pad and a vehicle standing
//! at it takes a forklift `HANDLE_MS` a package, and a building has so many
//! forklifts (`Blueprint::forklifts`): a vehicle waits its turn for one,
//! and stands until it is done (`Car::due`). That time is the one thing
//! the server simulates of it; the forklift driving to and fro is the
//! client's, from the run (`Lift`).

use model::blueprint::blueprint;
use model::GameTime;
use model::{CarRole, EntityId, Good, Lift};

use super::World;

/// A forklift lifts a package off a vehicle and sets it on the pad, or
/// back: a couple of minutes of the clock.
pub const HANDLE_MS: GameTime = 1_500;

impl World {
    /// A forklift of the building's lifts `n` packages of a good between
    /// its pad and a vehicle standing at it, onto the vehicle or off: the
    /// first free, from when it is free, one package at a time. The
    /// vehicle stands until the run is done, and later than any run it is
    /// already waiting for; a ferry keeps its timetable, and is only
    /// worked. When that is; `now` for none.
    pub fn lift(&mut self, building: EntityId, car: EntityId, good: Good, n: u32, onto: bool, now: GameTime) -> GameTime {
        let road = self.car(car).is_some_and(|c| c.role != CarRole::Ferry);
        let waits = if road { self.car(car).map_or(now, |c| c.due.max(now)) } else { now };
        if n == 0 {
            return waits;
        }
        let Some(b) = self.building_mut(building) else { return waits };
        let forklifts = blueprint(b.kind).forklifts.max(1);
        b.lifts.retain(|l| l.ends() > now);
        let free = |k: u8| b.lifts.iter().filter(|l| l.k == k).map(Lift::ends).max().unwrap_or(now);
        let k = (0..forklifts).min_by_key(|&k| (free(k), k)).unwrap_or(0);
        let start = free(k).max(waits);
        let lift = Lift { car, good, n, onto, start, every: HANDLE_MS, k };
        b.lifts.push(lift);
        let ends = lift.ends();
        if let Some(c) = self.car_mut(car).filter(|_| road) {
            c.due = ends;
        }
        ends
    }

    /// Is the vehicle still standing for a forklift: woken early, it waits.
    pub fn handled(&self, car: EntityId, now: GameTime) -> bool {
        self.car(car).is_none_or(|c| c.due <= now)
    }
}
