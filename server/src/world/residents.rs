use std::collections::{BTreeMap, HashMap};

use crate::economy::{self, EDGE_WAGE, SWITCH};
use crate::protocol::{BuildingKind, Car, EntityId, GameObject, GridCoord, Resident, DAY_MS};
use crate::world::World;

/// A vacancy on offer: where, what it pays, and how long the shift is.
#[derive(Clone, Copy)]
struct Opening {
    at: GridCoord,
    wage: f64,
    hours: f64,
    free: u32,
}

impl Opening {
    /// What a shift here is worth to someone living at `home`: its pay in
    /// the edge's wage, over the commute and the shift together. The
    /// reservation wage is the commute. docs/economy.md §6.3.
    fn score(&self, home: GridCoord) -> f64 {
        let day_s = DAY_MS as f64 / 1000.0;
        let commute_h = walk(home, self.at) as f64 * 1.4 / crate::car::CRUISE_SPEED / (day_s / 24.0);
        self.hours * (self.wage / EDGE_WAGE) / (commute_h + self.hours)
    }
}

impl World {
    /// House everyone who has a home, and employ everyone who can be employed.
    ///
    /// Derived from what is standing rather than remembered: a home with a
    /// spare room gains residents, a resident whose home was demolished stops
    /// existing, and anyone without a job takes the one that scores best
    /// by wage over commute — and anyone with one moves for a raise. So this
    /// can be run after any commit and at startup without keeping a record of
    /// what it did last time, and it settles the same way either way.
    ///
    /// Returns everyone whose situation changed — moved in, hired, or laid
    /// off. They are the ones with a new decision to make, so the caller
    /// wakes them.
    pub fn settle(&mut self) -> Vec<EntityId> {
        // The doors onto the rest of the world stand where the roads run off
        // the map, and they move with the frontier. They are buildings like
        // any other from here on: they house people and they employ them.
        self.stand_edges();
        // A save from before a need existed owes it from now on; one from
        // before purses gets its shelf, prices and float.
        for id in self.resident_ids() {
            if let Some(e) = self.objects.get_mut(id)
                && let GameObject::Resident(ref mut r) = e.object
            {
                crate::needs::Bucket::top_up(&mut r.buckets);
            }
        }
        let buildings: Vec<EntityId> = self.objects.iter().filter(|e| matches!(e.object, GameObject::Building(_))).map(|e| e.id).collect();
        for id in buildings {
            economy::open(self, id);
        }
        let entries = self.objects.all_entries();

        // Spare capacity, counted down as the people already living and working
        // in the city are accounted for. A building that cannot pay its way
        // offers no work (docs/economy.md §9).
        let mut rooms: HashMap<EntityId, u32> = HashMap::new();
        let mut vacancies: BTreeMap<EntityId, Opening> = BTreeMap::new();
        let mut where_is: HashMap<EntityId, GridCoord> = HashMap::new();
        for e in &entries {
            let GameObject::Building(ref b) = e.object else { continue };
            let Some(pos) = e.position else { continue };
            // Built but not reached: nobody lives or works where no road goes.
            if self.road_node_for_building(e.id).is_none() {
                continue;
            }
            where_is.insert(e.id, pos);
            let bp = crate::blueprint::blueprint(b.kind);
            if bp.homes > 0 {
                rooms.insert(e.id, bp.homes);
            }
            if bp.jobs > 0 && economy::solvent(self, e.id) {
                let hours = if b.kind == BuildingKind::Edge { 8.0 } else { economy::shift_hours(b.kind) };
                vacancies.insert(e.id, Opening { at: pos, wage: economy::wage_of(self, e.id), hours, free: bp.jobs });
            }
        }

        let mut jobless: Vec<EntityId> = Vec::new();
        let mut evicted: Vec<EntityId> = Vec::new();
        let mut laid_off: Vec<EntityId> = Vec::new();
        for e in &entries {
            let GameObject::Resident(ref r) = e.object else { continue };
            // Home gone: so is the household. Nobody commutes from a hole
            // in the ground, and nothing else holds a reference to them.
            if !where_is.contains_key(&r.home) {
                evicted.push(e.id);
                continue;
            }
            if let Some(free) = rooms.get_mut(&r.home) {
                *free = free.saturating_sub(1);
            }
            match r.work {
                // Work beyond the edge is what there is until the city
                // offers something. Whoever is doing it is still looking,
                // and takes a job in town the day one beats it — otherwise
                // the first thing anyone does is drive off the map, and
                // where you put the factory stops mattering.
                Some(w) if self.edge.contains(&w) => jobless.push(e.id),
                _ => match r.work.and_then(|w| vacancies.get_mut(&w)) {
                    Some(o) => o.free = o.free.saturating_sub(1),
                    // Someone who lives off the map is here for the job and
                    // nothing else: when it goes, so do they. Everyone else
                    // stays and looks for another.
                    None if self.edge.contains(&r.home) => evicted.push(e.id),
                    None => {
                        if r.work.is_some() {
                            laid_off.push(e.id);
                        }
                        jobless.push(e.id);
                    }
                },
            }
        }
        for id in evicted {
            self.objects.remove(id);
        }
        let mut touched = laid_off.clone();
        for id in laid_off {
            if let Some(entry) = self.objects.get_mut(id)
                && let GameObject::Resident(ref mut r) = entry.object
            {
                r.work = None;
            }
        }

        // By id, so a world settles the same way however the map iterated.
        let mut spare: Vec<(EntityId, u32)> = rooms.into_iter().filter(|&(_, n)| n > 0).collect();
        spare.sort_unstable();

        // New residents are not here yet: `at: None` is off-map, and their
        // first wake drives them in from beyond the frontier. Nobody
        // materialises out of thin air — they arrive the way everyone
        // arrives, by road.
        for (home, free) in spare {
            for _ in 0..free {
                let id = self.objects.insert(
                    GameObject::Resident(Resident {
                        home,
                        work: None,
                        at: None,
                        car: 0,
                        buckets: crate::needs::Bucket::fresh(),
                        selected: None,
                        last_update: 0,
                        wallet: economy::RESIDENT_FLOAT,
                        tab: 0.0,
                    }),
                    None,
                );
                touched.push(id);
                jobless.push(id);
            }
        }

        // The best opening for someone living here, by wage over commute.
        // Strictly better wins, and by id at a tie, so a world settles the
        // same way however the map iterated.
        let best_for = |vacancies: &BTreeMap<EntityId, Opening>, home: GridCoord| -> Option<(EntityId, f64)> {
            vacancies
                .iter()
                .filter(|(_, o)| o.free > 0)
                .map(|(&b, o)| (b, o.score(home)))
                .fold(None, |best: Option<(EntityId, f64)>, (b, s)| match best {
                    Some((_, bs)) if bs >= s => best,
                    _ => Some((b, s)),
                })
        };

        jobless.sort_unstable();
        for id in jobless {
            let Some(home) = self.home_of(id).and_then(|h| where_is.get(&h).copied()) else {
                continue;
            };
            // This is the rule that makes where you zone matter: put the
            // factory across town and its workers drive across town, every
            // morning, on whatever road you gave them — or past the edge,
            // if the factory does not pay for the drive.
            let Some((work, _)) = best_for(&vacancies, home) else {
                break; // no vacancy anywhere; the rest are jobless too
            };
            vacancies.get_mut(&work).unwrap().free -= 1;
            if let Some(entry) = self.objects.get_mut(id)
                && let GameObject::Resident(ref mut r) = entry.object
                && r.work != Some(work)
            {
                r.work = Some(work);
                touched.push(id);
            }
        }

        // Anyone employed in town ranks the openings too, and moves for a
        // raise: the new score has to beat the old by the switching
        // threshold. Tenure is what falls out. docs/economy.md §6.3.
        let mut movers: Vec<(EntityId, EntityId, EntityId)> = Vec::new(); // who, from, to
        for e in &entries {
            let GameObject::Resident(ref r) = e.object else { continue };
            // Someone from beyond the edge is here for the job, not looking.
            if self.edge.contains(&r.home) {
                continue;
            }
            let (Some(work), Some(&home)) = (r.work, where_is.get(&r.home)) else { continue };
            let Some(current) = vacancies.get(&work).filter(|_| !self.edge.contains(&work)) else { continue };
            if let Some((to, score)) = best_for(&vacancies, home)
                && to != work
                && score > current.score(home) * (1.0 + SWITCH)
            {
                movers.push((e.id, work, to));
            }
        }
        movers.sort_unstable();
        for (id, from, to) in movers {
            let Some(o) = vacancies.get_mut(&to).filter(|o| o.free > 0) else { continue };
            o.free -= 1;
            vacancies.get_mut(&from).unwrap().free += 1;
            if let Some(entry) = self.objects.get_mut(id)
                && let GameObject::Resident(ref mut r) = entry.object
            {
                r.work = Some(to);
                touched.push(id);
            }
        }

        // A job the city cannot fill from among its own is filled from
        // beyond the map: someone whose home is the nearest road exit, who
        // commutes in and lives where nobody can watch them. As derived as
        // everyone else — the job is the whole reason they exist, and when
        // it goes, so do they.
        //
        // The edge's own vacancies are not among them: it is where the
        // people come from, never a place that is short of any.
        let unfilled: Vec<(EntityId, u32)> =
            vacancies.into_iter().filter(|&(b, o)| o.free > 0 && !self.edge.contains(&b)).map(|(b, o)| (b, o.free)).collect();
        for (work, free) in unfilled {
            let Some(home) = where_is.get(&work).and_then(|&p| self.nearest_edge(p)) else { continue };
            for _ in 0..free {
                let id = self.objects.insert(
                    GameObject::Resident(Resident {
                        home,
                        work: Some(work),
                        at: Some(home),
                        car: 0,
                        buckets: crate::needs::Bucket::fresh(),
                        selected: None,
                        last_update: 0,
                        wallet: economy::RESIDENT_FLOAT,
                        tab: 0.0,
                    }),
                    None,
                );
                touched.push(id);
            }
        }

        // Everyone owns a car, derived like everything else: a resident
        // without one gets one parked at home, and a parked car whose owner
        // is gone is scrap. A car still driving when its owner leaves finishes
        // its trip and is collected here the next time around. A facility's
        // trucks are its own for as long as it stands.
        let mut owners: HashMap<EntityId, EntityId> = HashMap::new(); // car -> resident
        let mut carless: Vec<EntityId> = Vec::new();
        for e in self.objects.all_entries() {
            let GameObject::Resident(ref r) = e.object else { continue };
            match self.objects.get(r.car).map(|c| &c.object) {
                Some(GameObject::Car(_)) => {
                    owners.insert(r.car, e.id);
                }
                _ => carless.push(e.id),
            }
        }
        let scrap: Vec<EntityId> = self
            .objects
            .all_entries()
            .iter()
            .filter(|e| match e.object {
                GameObject::Car(ref c) => {
                    c.trip.is_none()
                        && !owners.contains_key(&e.id)
                        && !(c.role != crate::protocol::CarRole::Private && self.objects.get(c.owner).is_some())
                }
                _ => false,
            })
            .map(|e| e.id)
            .collect();
        for id in scrap {
            self.despawn_car(id);
        }
        carless.sort_unstable();
        for id in carless {
            // The car is parked wherever its owner is standing — and an
            // owner still off-map has it with them, position-less until
            // they drive in.
            let at = self.objects.get(id).and_then(|e| match e.object {
                GameObject::Resident(ref r) => r.at,
                _ => None,
            });
            let tile = at.and_then(|b| self.objects.get(b).and_then(|e| e.position));
            let car = self.objects.insert(GameObject::Car(Car { owner: id, trip: None, role: Default::default(), spot: None, away: 0, fuel: crate::needs::Bucket::tank() }), tile);
            if let Some(tile) = tile {
                self.spatial.entry(crate::world::chunk_of(tile)).or_default().insert(car);
            }
            if let Some(at) = at {
                self.park_in_lot(at, car, 0);
            }
            if let Some(entry) = self.objects.get_mut(id)
                && let GameObject::Resident(ref mut r) = entry.object
            {
                r.car = car;
            }
        }

        touched.sort_unstable();
        touched.dedup();
        touched
    }

    pub fn resident_ids(&self) -> Vec<EntityId> {
        let mut ids: Vec<EntityId> = self
            .objects
            .iter()
            .filter(|e| matches!(e.object, GameObject::Resident(_)))
            .map(|e| e.id)
            .collect();
        ids.sort_unstable();
        ids
    }

    /// How many of a building's staff live beyond the edge: the desks the
    /// town's wage did not fill.
    pub fn staff_from_the_edge(&self, building: EntityId) -> u32 {
        self.objects
            .iter()
            .filter(|e| matches!(e.object, GameObject::Resident(ref r) if r.work == Some(building) && self.edge.contains(&r.home)))
            .count() as u32
    }

    fn home_of(&self, resident: EntityId) -> Option<EntityId> {
        let entry = self.objects.get(resident)?;
        let GameObject::Resident(ref r) = entry.object else { return None };
        Some(r.home)
    }
}

/// Distance as the road runs, roughly. Chebyshev rather than straight-line
/// because the network is a grid with diagonals — and it is only ever used to
/// rank one workplace against another, never to predict a journey.
fn walk(a: GridCoord, b: GridCoord) -> i32 {
    (a.x - b.x).abs().max((a.y - b.y).abs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{BuildingKind, TerrainType};

    /// Grass, one long street, and whatever gets built beside it.
    fn town() -> World {
        let mut world = World::new();
        for y in -4..4 {
            for x in -4..40 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        let street: Vec<GridCoord> = (-2..40).map(|x| GridCoord { x, y: 0 }).collect();
        world.place_road_path(&street);
        world
    }

    fn build(world: &mut World, x: i32, kind: BuildingKind) -> EntityId {
        world
            .place_on_street(GridCoord { x, y: 1 }, kind)
            .expect("the street should give it a driveway")
    }

    fn residents(world: &World) -> Vec<Resident> {
        world
            .objects
            .all_entries()
            .iter()
            .filter_map(|e| match e.object {
                GameObject::Resident(ref r) => Some(r.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_house_fills_up_and_stays_full() {
        let mut world = town();
        let home = build(&mut world, 0, BuildingKind::House);

        assert_eq!(world.settle().len(), crate::blueprint::blueprint(BuildingKind::House).homes as usize);
        assert!(residents(&world).iter().all(|r| r.home == home));

        // Run again: nothing is standing that was not standing before, so
        // nobody new moves in. This is the property that lets it run on
        // every commit.
        assert!(world.settle().is_empty(), "settling twice must not double the town");
    }

    #[test]
    fn everyone_takes_the_nearest_job_with_room() {
        let mut world = town();
        build(&mut world, 0, BuildingKind::Apartment); // 7 residents
        let near = build(&mut world, 4, BuildingKind::Shop); // 2 jobs
        let far = build(&mut world, 30, BuildingKind::Office); // 12 jobs

        world.settle();
        let jobs = residents(&world);
        assert_eq!(jobs.iter().filter(|r| r.work == Some(near)).count(), 2);
        assert_eq!(jobs.iter().filter(|r| r.work == Some(far)).count(), 5);
    }

    #[test]
    fn a_town_with_no_work_is_not_a_town_with_no_people() {
        let mut world = town();
        build(&mut world, 0, BuildingKind::House);
        world.settle();
        assert_eq!(residents(&world).len(), 2);
        assert!(residents(&world).iter().all(|r| r.work.is_none()));
    }

    /// A job that appears later gets taken, without anyone having tracked that
    /// these two were waiting for one.
    #[test]
    fn a_new_workplace_employs_whoever_was_waiting() {
        let mut world = town();
        build(&mut world, 0, BuildingKind::House);
        world.settle();

        let shop = build(&mut world, 4, BuildingKind::Shop);
        let hired = world.settle();
        assert_eq!(hired.len(), 2, "both waiting residents get the new jobs");
        assert_eq!(residents(&world).len(), 2, "hired, not moved in");
        assert!(residents(&world).iter().all(|r| r.work == Some(shop)));
    }

    #[test]
    fn demolishing_a_home_takes_its_residents_with_it() {
        let mut world = town();
        let home = build(&mut world, 0, BuildingKind::House);
        build(&mut world, 4, BuildingKind::Shop);
        world.settle();
        assert_eq!(residents(&world).len(), 2);

        world.remove_building(home);
        world.settle();
        assert!(residents(&world).is_empty());
    }

    /// Losing your job is not losing your home: the household stays, and picks
    /// up whatever work turns up next.
    #[test]
    fn demolishing_a_workplace_leaves_its_staff_looking() {
        let mut world = town();
        build(&mut world, 0, BuildingKind::House);
        let shop = build(&mut world, 4, BuildingKind::Shop);
        world.settle();

        world.remove_building(shop);
        world.settle();
        assert_eq!(residents(&world).len(), 2);
        assert!(residents(&world).iter().all(|r| r.work.is_none()));
    }

    /// A car is part of the household: issued parked at home when someone
    /// moves in, scrapped when they go.
    #[test]
    fn every_resident_owns_a_parked_car_until_they_leave() {
        let mut world = town();
        let home = build(&mut world, 0, BuildingKind::House);
        world.settle();

        let cars: Vec<_> = world
            .objects
            .all_entries()
            .into_iter()
            .filter(|e| matches!(e.object, GameObject::Car(_)))
            .collect();
        assert_eq!(cars.len(), residents(&world).len());
        // The household has not driven in yet, and the car is with them:
        // off-map, position-less, invisible until the first trip.
        assert!(cars.iter().all(|e| e.position.is_none()), "still off-map with its owner");
        assert!(residents(&world).iter().all(|r| r.car != 0), "the link points back");

        world.remove_building(home);
        world.settle();
        let leftover = world
            .objects
            .all_entries()
            .iter()
            .filter(|e| matches!(e.object, GameObject::Car(_)))
            .count();
        assert_eq!(leftover, 0, "an evicted household takes its car with it");
    }

    /// The same street, with its far end left beyond the survey: a road
    /// exit, and so a door onto everything the town has not built.
    fn town_with_a_way_out() -> World {
        let mut world = World::new();
        for y in -4..4 {
            for x in -4..400 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        world.place_road_path(&(-2..400).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>());
        world
    }

    /// Nobody moves to the edge for its own sake: it has unlimited room and
    /// draws not one person into it. Its households are made by the jobs the
    /// town cannot fill, and unmade when those go.
    #[test]
    fn the_edge_houses_the_staff_the_town_cannot() {
        let mut world = town_with_a_way_out();
        build(&mut world, 0, BuildingKind::House); // two people
        world.settle();
        assert!(!world.edge.is_empty(), "the road runs off the map");
        assert_eq!(residents(&world).len(), 2, "an empty town is two people, not a queue at the door");

        let office = build(&mut world, 40, BuildingKind::Office);
        world.settle();
        let jobs = crate::blueprint::blueprint(BuildingKind::Office).jobs as usize;
        assert_eq!(residents(&world).len(), jobs, "every desk has someone at it");
        let commuters: Vec<Resident> =
            residents(&world).into_iter().filter(|r| world.edge.contains(&r.home)).collect();
        assert_eq!(commuters.len(), jobs - 2, "the ten the town cannot house live off the map");
        assert!(commuters.iter().all(|r| r.work == Some(office)), "they are here for the job");
        assert!(commuters.iter().all(|r| r.at == Some(r.home)), "and they are already out there");

        // Settling again adds nobody: the vacancies are all spoken for.
        world.settle();
        assert_eq!(residents(&world).len(), jobs);

        // The office goes, and so do they — but the town's own two stay,
        // and take what work there is: the job beyond the edge.
        world.remove_building(office);
        world.settle();
        assert_eq!(residents(&world).len(), 2);
        assert!(residents(&world).iter().all(|r| !world.edge.contains(&r.home)));
        assert!(residents(&world).iter().all(|r| r.work.is_some_and(|w| world.edge.contains(&w))));

        // And a shop in town wins them straight back off it: nobody keeps
        // driving off the map once there is something here to do.
        let shop = build(&mut world, 6, BuildingKind::Shop);
        world.settle();
        assert!(
            residents(&world).iter().all(|r| r.work == Some(shop)),
            "someone kept the job beyond the edge with one next door",
        );
    }

    /// A building no road reaches is not somewhere anyone can go, so it is
    /// not a candidate. It used to be: with no route to lengthen it, the
    /// crow-flies estimate came out cheaper than anywhere real, so a shop
    /// stranded off the street beat the edge, the drive was refused, and
    /// the search chose it again at every retry.
    #[test]
    fn a_shop_no_road_reaches_loses_to_the_edge() {
        let mut world = town_with_a_way_out();
        for y in -8..8 {
            for x in -4..400 {
                world.terrain.insert((x, y), crate::protocol::TerrainType::Grass);
            }
        }
        let home = build(&mut world, 0, BuildingKind::House);
        // Three tiles off the street, so no driveway forms.
        let orphan = world
            .place_building(GridCoord { x: 4, y: 3 }, BuildingKind::Shop, 2)
            .expect("land is land");
        assert!(world.road_node_for_building(orphan).is_none(), "the point of the test");
        world.settle();

        let who = world.resident_ids()[0];
        let edge = *world.edge.iter().next().unwrap();
        // Stood at home with an evening owed, rather than off-map with nothing.
        if let Some(e) = world.objects.get_mut(who)
            && let GameObject::Resident(ref mut r) = e.object
        {
            r.at = Some(home);
            for b in &mut r.buckets {
                b.stock.level = 0.4 * b.need.cap();
            }
        }
        let noon = 12 * (crate::protocol::DAY_MS as u64) / 24;
        let v = crate::resident::inspect(&world, who, noon);
        let leisure = v["buckets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["need"] == "Leisure")
            .expect("a Leisure bucket");
        assert_eq!(
            leisure["option"]["building"].as_u64(),
            Some(edge as u64),
            "an evening out should be at the edge, not at {orphan}: {}",
            leisure["option"],
        );
    }

    /// A building the road has not reached stands dormant: it houses nobody
    /// until a road lands beside it, and then the driveway forms on its own.
    #[test]
    fn a_house_off_the_road_waits_for_one() {
        let mut world = town();
        // Three tiles off the street: nothing to drive on.
        let home = world
            .place_building(GridCoord { x: 10, y: 3 }, BuildingKind::House, 2)
            .expect("land is land");
        assert!(world.road_node_for_building(home).is_none(), "dormant");
        assert!(world.settle().is_empty(), "nobody moves in off the road");

        // A side street beside it reaches the house, and the household arrives.
        world.place_road_path(&[GridCoord { x: 10, y: 0 }, GridCoord { x: 10, y: 2 }]);
        assert!(world.road_node_for_building(home).is_some(), "the driveway formed itself");
        assert_eq!(world.settle().len(), 2);
        assert!(residents(&world).iter().all(|r| r.home == home));
    }
}
