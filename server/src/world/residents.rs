use std::collections::{BTreeMap, HashMap};

use crate::economy::{self, HIRING};
use crate::protocol::{Car, EntityId, GameObject, GridCoord, Resident, DAY_MS};
use crate::world::World;

/// A line with desks to fill: where it stands, how long its shift is, and
/// how many it still needs.
struct Line {
    at: GridCoord,
    hours: f64,
    free: u32,
}

/// A seller of labour a line could take: a household in town, one already
/// beyond the edge, or the outside itself, which never runs out.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Seller {
    Household(EntityId),
    Outside,
}

impl World {
    /// House everyone who has a home, and employ everyone who can be employed.
    ///
    /// Derived from what is standing rather than remembered: a home with a
    /// spare room gains residents, a resident whose home was demolished stops
    /// existing, and every line fills its desks on its turn, cheapest
    /// delivered first (docs/economy.md §5.2, §6.2). So this can be run
    /// after any commit and at startup without keeping a record of what it
    /// did last time, and it settles the same way either way.
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
        // before prices gets its shelf and prices.
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

        // Spare rooms, counted down as the people already living in the
        // city are accounted for; and every line in town with desks.
        let mut rooms: HashMap<EntityId, u32> = HashMap::new();
        let mut lines: BTreeMap<EntityId, Line> = BTreeMap::new();
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
            if bp.jobs > 0 && !self.edge.contains(&e.id) {
                lines.insert(e.id, Line { at: pos, hours: economy::shift_hours(b.kind), free: bp.jobs });
            }
        }

        let mut evicted: Vec<EntityId> = Vec::new();
        let mut sellers: Vec<EntityId> = Vec::new();
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
            sellers.push(e.id);
        }
        for id in evicted {
            self.objects.remove(id);
        }
        let mut touched: Vec<EntityId> = Vec::new();

        // By id, so a world settles the same way however the map iterated.
        let mut spare: Vec<(EntityId, u32)> = rooms.into_iter().filter(|&(_, n)| n > 0).collect();
        spare.sort_unstable();

        // New residents are not here yet: `at: None` is off-map, and their
        // first wake drives them in from beyond the frontier. Nobody
        // materialises out of thin air — they arrive the way everyone
        // arrives, by road.
        for (home, free) in spare {
            for _ in 0..free {
                let id = self.objects.insert(GameObject::Resident(Resident { home, work: None, at: None, car: 0, buckets: crate::needs::Bucket::fresh(), selected: None, last_update: 0, wage: economy::EDGE_WAGE, tab: 0.0 }), None);
                touched.push(id);
                sellers.push(id);
            }
        }

        // Every line's turn at once: each seller of labour it could take,
        // at the delivered price — the household's ask plus the drive there
        // and back over the shift — and the cheapest fill the desks. A
        // household already at a desk keeps it unless a seller beats it by
        // the hiring threshold, which is what tenure is. The outside sells
        // at the edge wage plus the crossing from the nearest exit, and
        // never runs out, so no desk stays empty; what it costs is what a
        // town with no houses pays. docs/economy.md §5.2.
        let mut offers: Vec<(u64, EntityId, Seller, f64)> = Vec::new(); // (effective, line, seller, wage)
        let priced = |wage: f64, incumbent: bool| -> u64 { (wage / if incumbent { 1.0 + HIRING } else { 1.0 } * 1e6) as u64 };
        for (&at, line) in &lines {
            for &id in &sellers {
                let Some(GameObject::Resident(r)) = self.objects.get(id).map(|e| &e.object) else { continue };
                let Some(&home) = where_is.get(&r.home) else { continue };
                // Someone beyond the edge is here for a desk they hold, not looking.
                if self.edge.contains(&r.home) && r.work != Some(at) {
                    continue;
                }
                let wage = economy::delivered_wage(economy::ask(self, r.home), commute_h(home, line.at), line.hours);
                offers.push((priced(wage, r.work == Some(at)), at, Seller::Household(id), wage));
            }
            if let Some(exit) = self.nearest_edge(line.at).and_then(|e| where_is.get(&e).copied()) {
                let wage = economy::delivered_wage(economy::import(economy::EDGE_WAGE), commute_h(exit, line.at), line.hours);
                offers.push((priced(wage, false), at, Seller::Outside, wage));
            }
        }
        offers.sort_unstable_by(|a, b| (a.0, a.1, a.2).cmp(&(b.0, b.1, b.2)));
        let mut hired: HashMap<EntityId, (EntityId, f64)> = HashMap::new();
        for (_, at, seller, wage) in offers {
            let Some(line) = lines.get_mut(&at) else { continue };
            if line.free == 0 {
                continue;
            }
            match seller {
                Seller::Household(id) => {
                    if hired.contains_key(&id) {
                        continue;
                    }
                    hired.insert(id, (at, wage));
                    line.free -= 1;
                }
                Seller::Outside => {
                    // Households beyond the map, one per desk left: home is
                    // the nearest road exit, and the job is the whole reason
                    // they exist.
                    let Some(home) = self.nearest_edge(line.at) else { continue };
                    for _ in 0..line.free {
                        let id = self.objects.insert(GameObject::Resident(Resident { home, work: Some(at), at: Some(home), car: 0, buckets: crate::needs::Bucket::fresh(), selected: None, last_update: 0, wage, tab: 0.0 }), None);
                        touched.push(id);
                    }
                    line.free = 0;
                }
            }
        }

        // Everyone in town not hired works beyond the edge for their ask,
        // the drive being their own price; everyone beyond the edge not
        // hired goes home.
        let mut gone: Vec<EntityId> = Vec::new();
        for id in sellers {
            let Some(GameObject::Resident(r)) = self.objects.get(id).map(|e| &e.object) else { continue };
            let (home, was, was_paid) = (r.home, r.work, r.wage);
            let (work, wage) = match hired.get(&id) {
                Some(&(at, wage)) => (Some(at), wage),
                None if self.edge.contains(&home) => {
                    gone.push(id);
                    continue;
                }
                None => (where_is.get(&home).and_then(|&p| self.nearest_edge(p)), economy::ask(self, home)),
            };
            if let Some(entry) = self.objects.get_mut(id)
                && let GameObject::Resident(ref mut r) = entry.object
            {
                r.work = work;
                r.wage = wage;
            }
            if work != was || wage != was_paid {
                touched.push(id);
            }
        }
        for id in gone {
            self.objects.remove(id);
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

}

/// The drive between two buildings in hours, as the road roughly runs:
/// Chebyshev distance with a detour factor, because the network is a grid
/// with diagonals — only ever used to rank one seller against another,
/// never to predict a journey.
fn commute_h(a: GridCoord, b: GridCoord) -> f64 {
    let hour_s = DAY_MS as f64 / 1000.0 / 24.0;
    (a.x - b.x).abs().max((a.y - b.y).abs()) as f64 * 1.4 / crate::car::CRUISE_SPEED / hour_s
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
