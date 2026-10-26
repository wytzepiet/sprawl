//! The tractor's day: the farm's turn sets it out on a run over the land
//! that wants a job, and each tile it reaches it works, the harvest landing
//! in the yard (docs/buildings.md, Making things). The land, and how a run
//! is laid over it, are the map's (`world::fields`).

use crate::economy;
use traffic::event_queue::EventQueue;
use map::fields::{PACE, RIPEN};
use crate::world::World;
use model::{CarRole, EntityId, GameObject, GameTime, Job, Run, Stage};

impl World {
    /// The farm's turn for its tractor: with a hand on shift, the tractor
    /// in its yard, and a batch wanting a job, it sets out on a run.
    pub fn farm_run(&mut self, events: &mut EventQueue, farm: EntityId, now: GameTime) {
        self.map.tend(farm);
        let Some(kind) = self.map.objects.get(farm).and_then(|e| match e.object {
            GameObject::Building(ref b) => Some(b.kind),
            _ => None,
        }) else {
            return;
        };
        let Some((job, batch)) = self.map.batch(farm, now) else {
            // A crop still ripening: the farm wakes when the last of it is.
            if let Some(b) = self.map.building(farm)
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
        let Some(tractor) = self.map
            .objects
            .iter()
            .find(|e| matches!(e.object, GameObject::Car(ref c) if c.owner == farm && c.role == CarRole::Tractor && c.trip.is_none() && c.run.is_none()))
            .map(|e| e.id)
        else {
            return;
        };
        let Some(yard) = self.map.yard_gate(farm, &batch) else { return };
        let Some((path, left)) = self.map.sweep(farm, yard, &batch, job) else { return };
        // A tile the tractor cannot work — a pocket it could not turn in,
        // or ground cut off by what was built since — is land no more:
        // the field is what the tractor can drive.
        if !left.is_empty()
            && let Some(b) = self.map.building_mut(farm)
        {
            b.land.retain(|t| !left.contains(&t.at));
        }
        // All of it left: nowhere to drive, and no run.
        if path.len() < 2 {
            return;
        }
        self.map.release_spot(tractor);
        self.map.update_position(tractor, yard);
        if let Some(c) = self.map.car_mut(tractor) {
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
        let Some(c) = self.map.car(tractor) else { return };
        let (farm, Some(run)) = (c.owner, c.run.clone()) else { return };
        // The tile is the clock's: the run began on the first, and reaches
        // one more every pace. Nothing on the car changes from step to
        // step, so nothing is resent until the run is over.
        let k = ((now - run.started) / run.pace) as usize;
        let Some(&here) = run.path.get(k) else { return };
        self.map.update_position(tractor, here);
        let crop = self.map.objects.get(farm).and_then(|e| match e.object {
            GameObject::Building(ref b) => Some(model::blueprint::crop(b.kind, b.land.len())),
            _ => None,
        });
        let mut cut = 0.0;
        if let Some(b) = self.map.building_mut(farm)
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
        if let Some(c) = self.map.car_mut(tractor) {
            c.run = None;
        }
        if let Some(b) = self.map.building_mut(farm) {
            b.ruts = run.path;
        }
        self.map.park_in_lot(farm, tractor, now);
        economy::refilled(self, tractor, now);
        crate::calls::turn(self, events, farm, now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use map::Map;
    use model::{BuildingKind, GridCoord, Tile, DAY_MS};

    fn farm_at(world: &mut World, x: i32) -> (EntityId, Vec<Tile>) {
        let farm = world.map.place_on_street(GridCoord { x, y: 1 }, BuildingKind::Farm).unwrap();
        (farm, tiles(world, farm))
    }

    fn tiles(world: &World, farm: EntityId) -> Vec<Tile> {
        world.map.building(farm).map_or(Vec::new(), |b| b.land.clone())
    }

    fn run_of(world: &World, tractor: EntityId) -> Option<Run> {
        world.map.car(tractor).and_then(|c| c.run.clone())
    }

    /// Whether a path turns sharper than a right angle anywhere.
    fn sharp(path: &[GridCoord]) -> bool {
        path.windows(3).any(|w| (w[1].x - w[0].x) * (w[2].x - w[1].x) + (w[1].y - w[0].y) * (w[2].y - w[1].y) < 0)
    }

    /// Drive a run to its end, one tile at a time.
    fn drive(world: &mut World, events: &mut EventQueue, tractor: EntityId, mut now: GameTime) -> GameTime {
        while run_of(world, tractor).is_some() {
            now += PACE;
            world.tractor_step(events, tractor, now);
        }
        now
    }

    /// The cycle: the tractor ploughs every tile in one run, seeds them in
    /// the next, and a day on harvests them, each tile's crop landing in
    /// the yard as it is cut; the run goes from the yard over the farm's
    /// own ground and back, every step a neighbour of the last, and its
    /// path stays on the farm's record. A yard with no room leaves the
    /// crop standing.
    #[test]
    fn the_tractor_ploughs_seeds_and_harvests_in_runs() {
        let mut world = World::from(Map::meadow(-4..60, -12..24).street(-4..60));
        let (farm, tiles) = farm_at(&mut world, 10);
        let mut events = EventQueue::new();
        let tractor = world.map.objects.fleet(farm).next().expect("a tractor in the yard");
        let yard = |world: &World| match world.map.objects.get(farm).unwrap().object {
            GameObject::Building(ref b) => b.stocks[&model::Good::Grain].level,
            _ => unreachable!(),
        };
        let stages = |world: &World| -> Vec<Stage> { self::tiles(world, farm).iter().map(|t| t.stage).collect() };
        // Nobody on shift: no run.
        world.farm_run(&mut events, farm, 0);
        assert!(run_of(&world, tractor).is_none(), "the tractor went out with nobody to drive it");
        // The plough.
        let now = 1_000;
        let (job, batch) = world.map.batch(farm, now).expect("a job");
        assert_eq!((job, batch.len()), (Job::Plough, tiles.len()));
        let pos = world.map.yard_gate(farm, &batch).unwrap();
        let (path, left) = world.map.sweep(farm, pos, &batch, job).expect("a sweep");
        assert!(left.is_empty(), "tiles left: {left:?}");
        assert_eq!((path[0], *path.last().unwrap()), (pos, pos), "the run does not start and end at the yard");
        assert!(path.windows(2).all(|w| (w[0].x - w[1].x).abs() + (w[0].y - w[1].y).abs() == 1), "a step of the run is not to a neighbour");
        assert!(!sharp(&path), "a turn sharper than a right angle");
        assert!(batch.iter().all(|t| path.contains(t)), "the sweep missed a tile");
        let ground = world.map.drivable(farm);
        assert!(path.iter().all(|t| ground.contains(&(t.x, t.y))), "the tractor left the farm's ground");
        // Turns: a sweep of a block is about one turn a row.
        let turns = path.windows(3).filter(|w| (w[1].x - w[0].x, w[1].y - w[0].y) != (w[2].x - w[1].x, w[2].y - w[1].y)).count();
        assert!(turns * 3 < path.len(), "{turns} turns over {} steps", path.len());
        if let Some(c) = world.map.car_mut(tractor) {
            c.run = Some(Run { job, path: path.clone(), started: now, pace: PACE });
        }
        let now = drive(&mut world, &mut events, tractor, now);
        assert!(stages(&world).iter().all(|&s| s == Stage::Ploughed), "not every tile was ploughed");
        assert_eq!(match world.map.objects.get(farm).unwrap().object { GameObject::Building(ref b) => b.ruts.clone(), _ => unreachable!() }, path, "the run's path was not kept");
        // The seed, then nothing until the crop is ripe.
        let (job, batch) = world.map.batch(farm, now).expect("a job");
        assert_eq!((job, batch.len()), (Job::Seed, tiles.len()));
        let (path, _) = world.map.sweep(farm, pos, &batch, job).unwrap();
        if let Some(c) = world.map.car_mut(tractor) {
            c.run = Some(Run { job, path, started: now, pace: PACE });
        }
        let sown_at = now;
        let now = drive(&mut world, &mut events, tractor, now);
        assert!(stages(&world).iter().all(|&s| s == Stage::Sown));
        assert!(world.map.batch(farm, now).is_none(), "a job before the crop is ripe");
        assert!(world.map.batch(farm, sown_at + DAY_MS as u64 / 2).is_none());
        // The harvest, once ripe: every tile's crop in the yard.
        let now = now + RIPEN;
        let (job, batch) = world.map.batch(farm, now).expect("a harvest");
        assert_eq!((job, batch.len()), (Job::Harvest, tiles.len()));
        let (path, _) = world.map.sweep(farm, pos, &batch, job).unwrap();
        if let Some(c) = world.map.car_mut(tractor) {
            c.run = Some(Run { job, path, started: now, pace: PACE });
        }
        let now = drive(&mut world, &mut events, tractor, now);
        assert!(stages(&world).iter().all(|&s| s == Stage::Cut));
        assert!((yard(&world) - 2600.0).abs() < 1e-9, "the harvest does not fill the yard: {}", yard(&world));
        // Round again: plough the stubble. And a full yard leaves the
        // crop standing.
        assert_eq!(world.map.batch(farm, now).map(|b| b.0), Some(Job::Plough));
        if let Some(b) = world.map.building_mut(farm) {
            for t in b.land.iter_mut() {
                (t.stage, t.since) = (Stage::Sown, 0);
            }
            let s = b.stocks.get_mut(&model::Good::Grain).unwrap();
            s.level = s.cap;
        }
        assert!(world.map.batch(farm, now).is_none(), "a harvest with no room in the yard");
    }
}
