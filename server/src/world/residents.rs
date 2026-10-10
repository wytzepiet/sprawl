use std::collections::{BTreeSet, HashSet};

use crate::blueprint::blueprint;
use crate::economy::{self, HIRING};
use crate::protocol::{Car, ChunkCoord, EntityId, GameObject, GridCoord, Resident, CHUNK_SIZE, DAY_MS};
use crate::world::World;

impl World {
    /// Everything as if it had just been built: at startup, for a world
    /// laid out fresh or loaded from a save. A save from before a need
    /// existed owes it from now on; one from before prices gets its shelf
    /// and prices; a household saved without a car gets one, and a parked
    /// car nobody owns is scrap. And every building is due to settle, and
    /// every one anybody lived or worked at: the doors are not saved, so a
    /// household from beyond one is gone with it. The one pass that reads
    /// the whole world, and it runs once.
    pub fn resettle(&mut self) {
        self.stand_edges();
        self.people.clear();
        let mut carless = Vec::new();
        for id in self.resident_ids() {
            let Some(GameObject::Resident(r)) = self.objects.get_mut(id).map(|e| &mut e.object) else { continue };
            crate::needs::Bucket::top_up(&mut r.buckets);
            let (home, work, car) = (r.home, r.work, r.car);
            self.tie(id, home);
            if let Some(w) = work {
                self.tie(id, w);
            }
            if !matches!(self.objects.get(car).map(|e| &e.object), Some(GameObject::Car(_))) {
                carless.push(id);
            }
        }
        let scrap: Vec<EntityId> = self
            .objects
            .iter()
            .filter(|e| matches!(e.object, GameObject::Car(ref c) if c.trip.is_none() && !self.owns(c.owner, e.id)))
            .map(|e| e.id)
            .collect();
        for id in scrap {
            self.despawn_car(id);
        }
        for id in carless {
            self.issue_car(id);
        }
        let buildings: Vec<EntityId> = self.objects.iter().filter(|e| matches!(e.object, GameObject::Building(_))).map(|e| e.id).collect();
        for id in buildings {
            economy::open(self, id);
            self.unsettled.insert(id);
        }
        self.unsettled.extend(self.people.keys());
    }

    /// House and employ around whatever changed: every building placed,
    /// reached, cut off or taken away since last time, and nothing else.
    /// A home with a spare room gains residents, a resident whose home is
    /// gone goes with it, and a line that gained a door or lost a worker
    /// fills its desks on its turn, cheapest delivered first
    /// (docs/economy.md §5.2, §6.2). What it costs is what changed, never
    /// the size of the town: every player's build shares the one loop.
    ///
    /// Returns everyone whose situation changed — moved in, hired, or laid
    /// off. They are the ones with a new decision to make, so the caller
    /// wakes them.
    pub fn settle(&mut self) -> Vec<EntityId> {
        let mut touched = Vec::new();
        let mut lines = BTreeSet::new();
        for b in std::mem::take(&mut self.unsettled) {
            let kind = match self.objects.get(b).map(|e| &e.object) {
                Some(GameObject::Building(b)) => Some(b.kind),
                _ => None,
            };
            // Built but not reached, or not built at all: nobody lives or
            // works where no road goes. Losing your job is not losing your
            // home; losing your home is leaving, and the desk you held is
            // a vacancy.
            let Some(kind) = kind.filter(|_| self.street_of(b).is_some()) else {
                for id in self.people.remove(&b).unwrap_or_default() {
                    let Some(GameObject::Resident(r)) = self.objects.get(id).map(|e| &e.object) else { continue };
                    if r.home == b {
                        lines.extend(r.work);
                        self.move_out(id);
                    } else {
                        self.lay_off(id, &mut touched);
                    }
                }
                continue;
            };
            if self.edge.contains(&b) {
                continue;
            }
            let bp = blueprint(kind);
            // New residents are not here yet: `at: None` is off-map, and
            // their first wake drives them in from beyond the frontier.
            // Nobody materialises out of thin air — they arrive the way
            // everyone arrives, by road.
            for _ in self.household(b).len()..bp.homes as usize {
                touched.push(self.move_in(b, None, None, economy::ask(self, b)));
            }
            if bp.jobs > 0 {
                lines.insert(b);
            }
        }
        // A line that loses a worker to a nearer one takes its turn after.
        let mut fresh = HashSet::new();
        while let Some(line) = lines.pop_first() {
            self.hire(line, &mut lines, &mut fresh, &mut touched);
        }
        touched.sort_unstable();
        touched.dedup();
        touched.retain(|&id| self.objects.get(id).is_some());
        // Everyone owns a car, issued once everyone has moved in, by id.
        for &id in &touched {
            if matches!(self.objects.get(id).map(|e| &e.object), Some(GameObject::Resident(r)) if r.car == 0) {
                self.issue_car(id);
            }
        }
        touched
    }

    /// One line's turn at the labour market. Every seller it could take, at
    /// the delivered price — the household's ask plus the drive there and
    /// back over the shift — and the cheapest fill the desks. Whoever is at
    /// a desk keeps it unless a seller beats them by the hiring threshold,
    /// which is what tenure is; a household working at another line is a
    /// seller only if this one is cheaper than that by as much, so it
    /// moves for a shorter drive and never for a penny — unless it was
    /// only hired in this same settling (`fresh`), and holds nothing yet:
    /// then cheaper is enough, and a town settled at once comes out as if
    /// every desk had been offered at once. The outside sells
    /// at the edge wage plus the crossing from the nearest exit, and never
    /// runs out, so no desk stays empty; what it costs is what a town with
    /// no houses pays. Households are looked for nearest first, and the
    /// search stops where nobody farther could be cheaper than what it has.
    /// docs/economy.md §5.2.
    fn hire(&mut self, line: EntityId, lines: &mut BTreeSet<EntityId>, fresh: &mut HashSet<EntityId>, touched: &mut Vec<EntityId>) {
        let Some(e) = self.objects.get(line).filter(|_| self.street_of(line).is_some()) else { return };
        let (Some(at), GameObject::Building(b)) = (e.position, &e.object) else { return };
        let (jobs, hours) = (blueprint(b.kind).jobs as usize, economy::shift_hours(b.kind));
        // (what it costs this line, who, what they would be paid)
        let mut offers: Vec<(f64, EntityId, f64)> = Vec::new();
        for id in self.staff(line) {
            if let Some(wage) = self.delivered(id, line) {
                offers.push((wage / (1.0 + HIRING), id, wage));
            }
        }
        // The outside sells labour to a town that can pay for it, like any
        // other good (docs/economy.md §8.2).
        let outside = (self.treasury > 0.0)
            .then(|| self.nearest_edge(at))
            .flatten()
            .and_then(|exit| Some((exit, self.objects.get(exit)?.position?)))
            .map(|(exit, p)| (exit, economy::delivered_wage(economy::import(economy::EDGE_WAGE), commute_h(p, at), hours)));
        let ceiling = outside.map_or(f64::INFINITY, |(_, wage)| wage);
        let rings = self.rings_from(crate::world::chunk_of(at));
        let mut seen = HashSet::new();
        for (k, ring) in rings.into_iter().enumerate() {
            // The nearest a home in this ring stands, and so the least
            // anyone there could cost.
            let floor = economy::delivered_wage(economy::export(economy::EDGE_WAGE), tiles_h((k as i32 - 1).max(0) * CHUNK_SIZE), hours);
            offers.sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
            let bar = jobs.checked_sub(1).and_then(|k| offers.get(k)).map_or(ceiling, |o| o.0.min(ceiling));
            if floor >= bar {
                break;
            }
            for chunk in ring {
                for home in self.buildings_in(chunk) {
                    if !seen.insert(home) || self.edge.contains(&home) {
                        continue;
                    }
                    for &id in self.people.get(&home).into_iter().flatten() {
                        let Some(GameObject::Resident(r)) = self.objects.get(id).map(|e| &e.object) else { continue };
                        if r.home != home || r.work == Some(line) {
                            continue;
                        }
                        let Some(wage) = self.delivered(id, line) else { continue };
                        let threshold = if fresh.contains(&id) { 1.0 } else { 1.0 + HIRING };
                        if r.work.and_then(|w| self.delivered(id, w)).is_none_or(|there| wage * threshold < there) {
                            offers.push((wage, id, wage));
                        }
                    }
                }
            }
        }
        offers.sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        offers.retain(|o| o.0 < ceiling);
        offers.truncate(jobs);
        let hired: HashSet<EntityId> = offers.iter().map(|o| o.1).collect();
        for id in self.staff(line) {
            if !hired.contains(&id) {
                self.lay_off(id, touched);
            }
        }
        for &(_, id, wage) in &offers {
            let was = match self.objects.get(id).map(|e| &e.object) {
                Some(GameObject::Resident(r)) => r.work,
                _ => continue,
            };
            if was != Some(line) {
                lines.extend(was);
                fresh.insert(id);
            }
            if self.employ(id, Some(line), wage) {
                touched.push(id);
            }
        }
        // Households beyond the map, one per desk left: home is the
        // nearest road exit, and the job is the whole reason they exist.
        if let Some((exit, wage)) = outside {
            for _ in offers.len()..jobs {
                touched.push(self.move_in(exit, Some(line), Some(exit), wage));
            }
        }
    }

    /// What a household's hours cost a line, delivered: the ask, with the
    /// drive there and back spread over the line's shift.
    fn delivered(&self, id: EntityId, line: EntityId) -> Option<f64> {
        let home = self.home_of(id)?;
        let from = self.objects.get(home)?.position?;
        let e = self.objects.get(line)?;
        let GameObject::Building(ref b) = e.object else { return None };
        Some(economy::delivered_wage(economy::ask(self, home), commute_h(from, e.position?), economy::shift_hours(b.kind)))
    }

    /// Chunks around one, a ring at a time, nearest first, as far as the
    /// survey goes: nothing stands beyond it.
    fn rings_from(&self, c: ChunkCoord) -> Vec<Vec<ChunkCoord>> {
        let b = self.revealed_bounds;
        let far = [c.cx - b.min_cx, b.max_cx - c.cx, c.cy - b.min_cy, b.max_cy - c.cy].into_iter().max().unwrap_or(0).max(0);
        (0..=far)
            .map(|k| {
                (-k..=k)
                    .flat_map(|dx| (-k..=k).map(move |dy| (dx, dy)))
                    .filter(|&(dx, dy)| dx.abs().max(dy.abs()) == k)
                    .map(|(dx, dy)| ChunkCoord { cx: c.cx + dx, cy: c.cy + dy })
                    .collect()
            })
            .collect()
    }

    /// A household, carless until the settle ends (`issue_car`).
    fn move_in(&mut self, home: EntityId, work: Option<EntityId>, at: Option<EntityId>, wage: f64) -> EntityId {
        let id = self.objects.insert(GameObject::Resident(Resident { home, work, at, car: 0, buckets: crate::needs::Bucket::fresh(), selected: None, last_update: 0, wage, tab: 0.0 }), None);
        self.tie(id, home);
        if let Some(w) = work {
            self.tie(id, w);
        }
        id
    }

    /// A car parked wherever its owner is standing — or, still off-map,
    /// with them, position-less until they drive in.
    fn issue_car(&mut self, id: EntityId) {
        let at = match self.objects.get(id).map(|e| &e.object) {
            Some(GameObject::Resident(r)) => r.at,
            _ => return,
        };
        let tile = at.and_then(|b| self.objects.get(b).and_then(|e| e.position));
        let car = self.insert_at(GameObject::Car(Car::new(id, Default::default())), tile);
        if let Some(at) = at {
            self.park_in_lot(at, car, 0);
        }
        if let Some(GameObject::Resident(r)) = self.objects.get_mut(id).map(|e| &mut e.object) {
            r.car = car;
        }
    }

    /// Nobody commutes from a hole in the ground, and nothing else holds a
    /// reference to them. Their car goes with them: now if it is parked,
    /// when it does if it is out (`park_car`).
    fn move_out(&mut self, id: EntityId) {
        let Some(GameObject::Resident(r)) = self.objects.get(id).map(|e| &e.object) else { return };
        let (home, work, car) = (r.home, r.work, r.car);
        self.untie(id, home);
        if let Some(w) = work {
            self.untie(id, w);
        }
        self.objects.remove(id);
        if matches!(self.objects.get(car).map(|e| &e.object), Some(GameObject::Car(c)) if c.trip.is_none()) {
            self.despawn_car(car);
        }
    }

    /// Out of a job: someone in town works beyond the edge for their ask,
    /// the drive being their own price; someone beyond the edge goes home.
    fn lay_off(&mut self, id: EntityId, touched: &mut Vec<EntityId>) {
        let Some(home) = self.home_of(id) else { return };
        if self.edge.contains(&home) {
            self.move_out(id);
        } else if self.employ(id, None, economy::ask(self, home)) {
            touched.push(id);
        }
    }

    /// Whether anything changed.
    fn employ(&mut self, id: EntityId, work: Option<EntityId>, wage: f64) -> bool {
        let Some(GameObject::Resident(r)) = self.objects.get_mut(id).map(|e| &mut e.object) else { return false };
        let was = r.work;
        let changed = was != work || r.wage != wage;
        r.work = work;
        r.wage = wage;
        if was != work {
            if let Some(w) = was {
                self.untie(id, w);
            }
            if let Some(w) = work {
                self.tie(id, w);
            }
        }
        changed
    }

    fn tie(&mut self, resident: EntityId, building: EntityId) {
        self.people.entry(building).or_default().insert(resident);
    }

    fn untie(&mut self, resident: EntityId, building: EntityId) {
        if let Some(p) = self.people.get_mut(&building) {
            p.remove(&resident);
        }
    }

    fn home_of(&self, id: EntityId) -> Option<EntityId> {
        match self.objects.get(id).map(|e| &e.object) {
            Some(GameObject::Resident(r)) => Some(r.home),
            _ => None,
        }
    }

    /// Who works at a building, by id.
    pub fn staff(&self, building: EntityId) -> Vec<EntityId> {
        self.people
            .get(&building)
            .into_iter()
            .flatten()
            .copied()
            .filter(|&id| matches!(self.objects.get(id).map(|e| &e.object), Some(GameObject::Resident(r)) if r.work == Some(building)))
            .collect()
    }

    /// Who lives at a building, by id.
    pub fn household(&self, building: EntityId) -> Vec<EntityId> {
        self.people.get(&building).into_iter().flatten().copied().filter(|&id| self.home_of(id) == Some(building)).collect()
    }

    /// Is this car one its owner still has: a resident's own, or a
    /// standing facility's fleet.
    pub fn owns(&self, owner: EntityId, car: EntityId) -> bool {
        match self.objects.get(owner).map(|e| &e.object) {
            Some(GameObject::Resident(r)) => r.car == car,
            Some(GameObject::Building(_)) => true,
            _ => false,
        }
    }

    pub fn resident_ids(&self) -> Vec<EntityId> {
        self.objects.iter().filter(|e| matches!(e.object, GameObject::Resident(_))).map(|e| e.id).collect()
    }
}

/// The drive between two buildings in hours, as the road roughly runs:
/// Chebyshev distance with a detour factor, because the network is a grid
/// with diagonals — only ever used to rank one seller against another,
/// never to predict a journey.
fn commute_h(a: GridCoord, b: GridCoord) -> f64 {
    tiles_h((a.x - b.x).abs().max((a.y - b.y).abs()))
}

fn tiles_h(tiles: i32) -> f64 {
    let hour_s = DAY_MS as f64 / 1000.0 / 24.0;
    tiles as f64 * 1.4 / crate::car::CRUISE_SPEED / hour_s
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
            .iter()
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
        // and take what work there is: no job in town, which is the job
        // beyond the edge.
        world.remove_building(office);
        world.settle();
        assert_eq!(residents(&world).len(), 2);
        assert!(residents(&world).iter().all(|r| !world.edge.contains(&r.home)));
        assert!(residents(&world).iter().all(|r| r.work.is_none()));

        // And a shop in town wins them straight back off it: nobody keeps
        // driving off the map once there is something here to do.
        let shop = build(&mut world, 6, BuildingKind::Shop);
        world.settle();
        assert!(
            residents(&world).iter().all(|r| r.work == Some(shop)),
            "someone kept the job beyond the edge with one next door",
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
        assert!(world.street_of(home).is_none(), "dormant");
        assert!(world.settle().is_empty(), "nobody moves in off the road");

        // A side street beside it reaches the house, and the household arrives.
        world.place_road_path(&[GridCoord { x: 10, y: 0 }, GridCoord { x: 10, y: 2 }]);
        assert!(world.street_of(home).is_some(), "the driveway formed itself");
        assert_eq!(world.settle().len(), 2);
        assert!(residents(&world).iter().all(|r| r.home == home));
    }
}
