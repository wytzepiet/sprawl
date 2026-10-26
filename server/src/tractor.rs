//! The tractor's day: the farm's turn sets it out on a run over the land
//! that wants a job, and each tile it reaches it works, the harvest landing
//! in the yard (docs/buildings.md, Making things). The land, and how a run
//! is laid over it, are the map's (`world::fields`).

use crate::economy;
use crate::engine::event_queue::EventQueue;
use crate::world::fields::{PACE, RIPEN};
use crate::world::World;
use model::{CarRole, EntityId, GameObject, GameTime, Job, Run, Stage};

impl World {
    /// The farm's turn for its tractor: with a hand on shift, the tractor
    /// in its yard, and a batch wanting a job, it sets out on a run.
    pub fn farm_run(&mut self, events: &mut EventQueue, farm: EntityId, now: GameTime) {
        self.tend(farm);
        let Some(kind) = self.objects.get(farm).and_then(|e| match e.object {
            GameObject::Building(ref b) => Some(b.kind),
            _ => None,
        }) else {
            return;
        };
        let Some((job, batch)) = self.batch(farm, now) else {
            // A crop still ripening: the farm wakes when the last of it is.
            if let Some(b) = self.building(farm)
                && let Some(ripe) = b.land.iter().filter(|t| t.stage == Stage::Sown).map(|t| t.since + RIPEN).max()
                && ripe > now
            {
                events.wake(ripe - now, farm);
            }
            return;
        };
        // The hands set out on a job only with half of it inside their
        // shift: a job finished late in the day leaves the next for the
        // morning.
        let half = now + batch.len() as GameTime * PACE / 2;
        let on_shift = model::blueprint::blueprint(kind).taps.iter().any(|t| t.need == model::needs::Need::Work && t.curve.integral(now, now + 1_000) > 0.0 && t.curve.integral(half, half + 1_000) > 0.0);
        if !on_shift || !crate::calls::staffed(self, farm) {
            return;
        }
        let Some(tractor) = self
            .objects
            .iter()
            .find(|e| matches!(e.object, GameObject::Car(ref c) if c.owner == farm && c.role == CarRole::Tractor && c.trip.is_none() && c.run.is_none()))
            .map(|e| e.id)
        else {
            return;
        };
        let Some(yard) = self.yard_gate(farm, &batch) else { return };
        let Some((path, left)) = self.sweep(farm, yard, &batch, job) else { return };
        // A tile the tractor cannot work — a pocket it could not turn in,
        // or ground cut off by what was built since — is land no more:
        // the field is what the tractor can drive.
        if !left.is_empty()
            && let Some(b) = self.building_mut(farm)
        {
            b.land.retain(|t| !left.contains(&t.at));
        }
        // All of it left: nowhere to drive, and no run.
        if path.len() < 2 {
            return;
        }
        self.release_spot(tractor);
        self.update_position(tractor, yard);
        if let Some(c) = self.car_mut(tractor) {
            c.spot = None;
            c.run = Some(Run { job, path, started: now, pace: PACE });
        }
        events.wake(PACE, tractor);
    }

    /// The tractor arrives at the tile of its run the clock names and does its job to
    /// it: the plough turns grass or stubble to bare ground, the seed
    /// starts a crop, the harvest lands a crop in the yard and leaves
    /// stubble — or, with no room left in the yard, leaves the crop
    /// standing. At the end of the run it is home, its path is the field
    /// as drawn, and the farm takes its turn for the next run.
    pub fn tractor_step(&mut self, events: &mut EventQueue, tractor: EntityId, now: GameTime) {
        let Some(c) = self.car(tractor) else { return };
        let (farm, Some(run)) = (c.owner, c.run.clone()) else { return };
        // The tile is the clock's: the run began on the first, and reaches
        // one more every pace. Nothing on the car changes from step to
        // step, so nothing is resent until the run is over.
        let k = ((now - run.started) / run.pace) as usize;
        let Some(&here) = run.path.get(k) else { return };
        self.update_position(tractor, here);
        let crop = self.objects.get(farm).and_then(|e| match e.object {
            GameObject::Building(ref b) => Some(model::blueprint::crop(b.kind, b.land.len())),
            _ => None,
        });
        let mut cut = 0.0;
        if let Some(b) = self.building_mut(farm)
            && let Some(tile) = b.land.iter_mut().find(|t| t.at == here)
        {
            match (run.job, tile.stage) {
                (Job::Plough, Stage::Grass | Stage::Cut) => (tile.stage, tile.since) = (Stage::Ploughed, now),
                (Job::Seed, Stage::Ploughed) => (tile.stage, tile.since) = (Stage::Sown, now),
                (Job::Harvest, Stage::Sown) => {
                    let room = model::blueprint::blueprint(b.kind).makes.and_then(|m| b.stocks.get(&m)).is_some_and(|s| s.short() + 1e-6 >= crop.unwrap_or(0.0));
                    if room {
                        (tile.stage, tile.since) = (Stage::Cut, now);
                        cut = crop.unwrap_or(0.0);
                    }
                }
                _ => {}
            }
        }
        if cut > 0.0 {
            economy::harvested(self, farm, cut, now);
        }
        if k + 1 < run.path.len() {
            events.wake(PACE, tractor);
            return;
        }
        if let Some(c) = self.car_mut(tractor) {
            c.run = None;
        }
        if let Some(b) = self.building_mut(farm) {
            b.ruts = run.path;
        }
        self.park_in_lot(farm, tractor, now);
        economy::refilled(self, tractor, now);
        crate::calls::turn(self, events, farm, now);
    }
}
