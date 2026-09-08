use std::collections::HashMap;

use crate::protocol::{Car, EntityId, GameObject, GridCoord, Resident};
use crate::world::World;

impl World {
    /// House everyone who has a home, and employ everyone who can be employed.
    ///
    /// Derived from what is standing rather than remembered: a home with a
    /// spare room gains residents, a resident whose home was demolished stops
    /// existing, and anyone without a job takes the nearest one going. So this
    /// can be run after any commit and at startup without keeping a record of
    /// what it did last time, and it settles the same way either way.
    ///
    /// Returns everyone whose situation changed — moved in, hired, or laid
    /// off. They are the ones with a new decision to make, so the caller
    /// wakes them.
    pub fn settle(&mut self) -> Vec<EntityId> {
        // A save from before a need existed owes it from now on.
        for id in self.resident_ids() {
            if let Some(e) = self.objects.get_mut(id)
                && let GameObject::Resident(ref mut r) = e.object
            {
                crate::needs::Bucket::top_up(&mut r.buckets);
            }
        }
        let entries = self.objects.all_entries();

        // Spare capacity, counted down as the people already living and working
        // in the city are accounted for.
        let mut rooms: HashMap<EntityId, u32> = HashMap::new();
        let mut vacancies: HashMap<EntityId, u32> = HashMap::new();
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
            if bp.jobs > 0 {
                vacancies.insert(e.id, bp.jobs);
            }
        }

        let mut jobless: Vec<EntityId> = Vec::new();
        let mut evicted: Vec<EntityId> = Vec::new();
        let mut laid_off: Vec<EntityId> = Vec::new();
        for e in &entries {
            let GameObject::Resident(ref r) = e.object else { continue };
            match rooms.get_mut(&r.home) {
                // Home gone: so is the household. Nobody commutes from a hole
                // in the ground, and nothing else holds a reference to them.
                None => {
                    evicted.push(e.id);
                    continue;
                }
                Some(free) => *free = free.saturating_sub(1),
            }
            match r.work.and_then(|w| vacancies.get_mut(&w)) {
                Some(free) => *free = free.saturating_sub(1),
                None => {
                    if r.work.is_some() {
                        laid_off.push(e.id);
                    }
                    jobless.push(e.id);
                }
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
                    }),
                    None,
                );
                touched.push(id);
                jobless.push(id);
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

        jobless.sort_unstable();
        for id in jobless {
            let Some(home) = self.home_of(id).and_then(|h| where_is.get(&h).copied()) else {
                continue;
            };
            // Nearest with a vacancy. This is the rule that makes where you zone
            // matter: put the factory across town and its workers drive across
            // town, every morning, on whatever road you gave them.
            let Some(work) = vacancies
                .iter()
                .filter(|&(_, &free)| free > 0)
                .filter_map(|(&b, _)| Some((b, walk(home, *where_is.get(&b)?))))
                .min_by_key(|&(b, d)| (d, b))
                .map(|(b, _)| b)
            else {
                break; // no vacancy anywhere; the rest are jobless too
            };
            *vacancies.get_mut(&work).unwrap() -= 1;
            if let Some(entry) = self.objects.get_mut(id)
                && let GameObject::Resident(ref mut r) = entry.object
            {
                r.work = Some(work);
                touched.push(id);
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
            .spawn_building(GridCoord { x, y: 1 }, kind)
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

        world.remove_building(home, 0);
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

        world.remove_building(shop, 0);
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

        world.remove_building(home, 0);
        world.settle();
        let leftover = world
            .objects
            .all_entries()
            .iter()
            .filter(|e| matches!(e.object, GameObject::Car(_)))
            .count();
        assert_eq!(leftover, 0, "an evicted household takes its car with it");
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
