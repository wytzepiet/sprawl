//! The harbour, the ferry and the tug: the door everything comes in and
//! goes out by (docs/shipping.md §Harbours).
//!
//! A harbour stands with its back to the sea. The tile of sea behind the
//! middle of its back face is the quay; the ferry berths at it with its
//! ramp on the quay edge, lying straight out to sea, so a harbour needs
//! `BERTH` tiles of sea in a line behind it. On the street side is the
//! trailer park, which is the yard's docks (`lots.rs`): a box stands in a
//! dock where a lorry backed in would have its trailer, and a lorry backs
//! into a free dock to drop one or under one to hook it.
//!
//! The ferry is the world's, one to a harbour, on a timetable: it leaves
//! the world with what was booked for it and the settlers waiting to come,
//! sails in over the horizon, berths for `DWELL`, and casts off on time
//! with whatever the tug got aboard, back out of sight. The world pays for
//! what went out as it casts off; the town pays for what came in as each
//! box lands in the park. It is double-ended, as small island ferries
//! are: it never turns, it sails in one end first and out the other.
//!
//! The tug shunts boxes between the deck and the park, one move at a time
//! (`Shunt`): to a box, then with it. Off the ferry it tows a box down the
//! ramp and into a dock from the quay side, ending in the lane with the
//! box's hitch toward it, where a lorry backs under it; onto the ferry it
//! backs a box out of its dock and up the ramp, the box leading. It only
//! starts what it can finish before the ferry sails.

use std::collections::{HashMap, VecDeque};

use crate::blueprint::FACINGS;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::protocol::{BuildingKind, Car, CarRole, EntityId, GameObject, Good, GridCoord, Job, Place, Pose, Run, Shunt, TerrainType, Trailer, DAY_MS};
use crate::world::World;

/// How long a ship takes to cross a tile: 1.2 seconds of the clock, a
/// ship at twenty knots on twelve-metre tiles, a little under a car.
pub const PACE: GameTime = DAY_MS as GameTime / 1000;
/// How far out over the water a ship is still in sight: a minute of its
/// sailing, about what the town's view takes in.
pub const HORIZON: usize = 48;
/// Tiles of sea in a line behind a harbour: the ferry's length at the
/// berth, and room to come straight in.
pub const BERTH: i32 = 6;
/// The ferry, in tiles: long and broad, bigger than true to the map, as
/// `FERRY` in the client's `dressing.ts`.
pub const FERRY_LENGTH: f64 = 3.2;
/// The deck: three lanes of five boxes, the land end first. A slot holds
/// a box, or two settlers' cars.
pub const LANES: usize = 3;
pub const ROWS: usize = 5;
pub const DECK: usize = LANES * ROWS;
const LANE_GAP: f64 = 0.27;
const ROW_FIRST: f64 = 0.45;
const ROW_GAP: f64 = 0.6;
/// From casting off to berthing again: two and a half hours, the voyage
/// out and back included.
pub const TURN: GameTime = DAY_MS as GameTime * 5 / 48;
/// At the ramp: an hour and a quarter.
pub const DWELL: GameTime = DAY_MS as GameTime * 5 / 96;
/// The first call at a new harbour: half an hour after it is built.
pub const FIRST_CALL: GameTime = DAY_MS as GameTime / 48;
/// A settler's car rolls off every few seconds.
pub const ROLL_MS: GameTime = 4_000;
/// The tug: a little over a tile a second, and a few seconds to hitch or
/// drop a box.
const TUG_SPEED: f64 = 1.2 / 1000.0;
const HITCH_MS: GameTime = 2_500;
/// A box's middle behind the tug's, and behind a docked lorry's cab: half
/// of each and the coupling.
pub const TUG_BOX: f64 = 0.32;
pub const CAB_BOX: f64 = 0.262;

/// The four ways off a tile.
const AROUND: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

/// Empties the world keeps standing in a harbour's park.
pub const EMPTIES: usize = 2;

/// The starter pack's order: the world's gift, paid for by nobody.
pub const GIFT: u64 = 0;

fn ahead(heading: f64, d: f64) -> [f64; 2] {
    [heading.cos() * d, heading.sin() * d]
}

fn plus(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [a[0] + b[0], a[1] + b[1]]
}

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

fn length(path: &[[f64; 2]]) -> f64 {
    path.windows(2).map(|w| ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt()).sum()
}

/// A box on deck slot `k` of a ferry standing at `ship`: across its lanes
/// and along its rows from the end its heading points to, the land end at
/// the berth, facing it, hitch first.
pub fn deck_pose(ship: Pose, k: usize) -> Pose {
    let (lane, row) = (k % LANES, k / LANES);
    let end = plus(ship.at, ahead(ship.heading, FERRY_LENGTH / 2.0));
    let along = plus(end, ahead(ship.heading, -(ROW_FIRST + row as f64 * ROW_GAP)));
    let across = ahead(ship.heading + std::f64::consts::FRAC_PI_2, (lane as f64 - 1.0) * LANE_GAP);
    Pose { at: plus(along, across), heading: ship.heading }
}

/// The berth of a harbour: its quay tile and the way out to sea from it.
#[derive(Debug, Clone, Copy)]
pub struct Berth {
    pub quay: GridCoord,
    pub out: (i32, i32),
}

impl Berth {
    fn tile(&self, n: i32) -> GridCoord {
        GridCoord { x: self.quay.x + self.out.0 * n, y: self.quay.y + self.out.1 * n }
    }
    /// The middle of the quay's edge, where the ramp comes down.
    pub fn ramp(&self) -> [f64; 2] {
        [self.quay.x as f64 + 0.5 - self.out.0 as f64 * 0.5, self.quay.y as f64 + 0.5 - self.out.1 as f64 * 0.5]
    }
    /// Toward the land, from the sea.
    fn landward(&self) -> f64 {
        (-self.out.1 as f64).atan2(-self.out.0 as f64)
    }
    /// On the quay apron, half a tile in from the ramp.
    fn apron(&self) -> [f64; 2] {
        plus(self.ramp(), ahead(self.landward(), 0.5))
    }
    /// The ferry at the berth: its land end on the ramp, facing the land.
    pub fn moored(&self) -> Pose {
        Pose { at: plus(self.ramp(), ahead(self.landward(), -FERRY_LENGTH / 2.0)), heading: self.landward() }
    }
    /// Where the tug waits: on the apron beside the ramp.
    fn rest(&self) -> Pose {
        Pose { at: plus(self.apron(), ahead(self.landward() + std::f64::consts::FRAC_PI_2, 0.8)), heading: self.landward() }
    }
}

impl World {
    /// The berth a kind's plot would have here this way round: a tile of
    /// the sea behind its building's back face, the middle one first, with
    /// `BERTH` tiles of sea straight out from it. None where the back is
    /// on land, on a lake, or on water too narrow for the ferry.
    pub fn berth_at(&self, tiles: &[GridCoord], kind: BuildingKind, facing: u8) -> Option<Berth> {
        // The building as it lies on the grid, its size already turned
        // with the facing.
        let (pos, p) = World::lie(tiles, kind, facing);
        let ((bx, by), (gw, gh)) = p.building;
        let (dx, dy) = FACINGS[facing as usize % 4];
        let building = GridCoord { x: pos.x + bx as i32, y: pos.y + by as i32 };
        // The back face is the row of the building furthest from the lot,
        // and the quay is one step further out from it.
        let mut back: Vec<GridCoord> = if dx == 0 {
            let y = if dy < 0 { building.y + gh as i32 } else { building.y - 1 };
            (0..gw as i32).map(|i| GridCoord { x: building.x + i, y }).collect()
        } else {
            let x = if dx < 0 { building.x + gw as i32 } else { building.x - 1 };
            (0..gh as i32).map(|i| GridCoord { x, y: building.y + i }).collect()
        };
        let mid = back[back.len() / 2];
        back.sort_by_key(|t| ((t.x - mid.x).abs() + (t.y - mid.y).abs(), t.x, t.y));
        let out = (-dx, -dy);
        back.into_iter()
            .map(|quay| Berth { quay, out })
            .find(|b| (0..BERTH).all(|n| self.terrain.get(&(b.tile(n).x, b.tile(n).y)) == Some(&TerrainType::Sea)))
    }

    /// A standing harbour's berth.
    pub fn berth(&self, harbour: EntityId) -> Option<Berth> {
        let GameObject::Building(ref b) = self.objects.get(harbour)?.object else { return None };
        self.berth_at(&b.tiles, b.kind, b.facing)
    }

    /// The way from a tile of the sea to the horizon: the shortest over
    /// the sea to the map's edge, cut at the horizon, since a ship further
    /// out is out of sight either way. None from a tile not on the sea, or
    /// on a sea with no way out.
    fn horizon(&self, from: GridCoord) -> Option<Vec<GridCoord>> {
        let sea = |t: (i32, i32)| self.terrain.get(&t) == Some(&TerrainType::Sea);
        let off = |t: GridCoord| AROUND.iter().any(|d| !self.terrain.contains_key(&(t.x + d.0, t.y + d.1)));
        let mut came: HashMap<(i32, i32), (i32, i32)> = HashMap::from([((from.x, from.y), (from.x, from.y))]);
        let mut queue = VecDeque::from([from]);
        let mut edge = None;
        while let Some(t) = queue.pop_front() {
            if off(t) || came.len() > 40_000 {
                edge = Some(t);
                break;
            }
            for (dx, dy) in AROUND {
                let n = GridCoord { x: t.x + dx, y: t.y + dy };
                if sea((n.x, n.y)) && !came.contains_key(&(n.x, n.y)) {
                    came.insert((n.x, n.y), (t.x, t.y));
                    queue.push_back(n);
                }
            }
        }
        let mut path = vec![edge?];
        while path.last().unwrap() != &from {
            let at = came[&(path.last().unwrap().x, path.last().unwrap().y)];
            path.push(GridCoord { x: at.0, y: at.1 });
        }
        path.reverse();
        path.truncate(HORIZON);
        Some(path)
    }

    /// Out from the berth to the horizon: straight out from the quay, then
    /// the shortest way off.
    fn voyage_out(&self, berth: Berth) -> Option<Vec<GridCoord>> {
        let mut path: Vec<GridCoord> = (2..BERTH).map(|n| berth.tile(n)).collect();
        path.extend(self.horizon(berth.tile(BERTH - 1))?.into_iter().skip(1));
        path.truncate(HORIZON);
        Some(path)
    }

    /// A harbour is built: the world's ferry is put on its line, due half
    /// an hour later. The first harbour's first sailing brings the starter
    /// pack, the world's gift: timber for the first houses, crates for the
    /// first shop, fuel, every box the town's (docs/game.md §The opening).
    pub fn commission(&mut self, harbour: EntityId, now: GameTime) {
        let first = !self.objects.iter().any(|e| matches!(e.object, GameObject::Car(ref c) if c.role == CarRole::Ferry));
        if self.ferry_of(harbour).is_some() || self.berth(harbour).is_none() {
            return;
        }
        let mut ferry = Car::new(harbour, CarRole::Ferry);
        ferry.due = now + FIRST_CALL;
        if first {
            for good in [Good::Timber, Good::Timber, Good::Timber, Good::Crates, Good::Fuel] {
                let id = self.objects.reserve_id();
                ferry.booked.push(Trailer { id, good: Some(good), units: good.per_box(), to: None, outbound: false, order: Some(GIFT) });
            }
        }
        self.insert_at(GameObject::Car(ferry), None);
    }

    /// A harbour's ferry.
    pub fn ferry_of(&self, harbour: EntityId) -> Option<EntityId> {
        self.objects.iter().find(|e| matches!(e.object, GameObject::Car(ref c) if c.role == CarRole::Ferry && c.owner == harbour)).map(|e| e.id)
    }

    /// A harbour's tug.
    pub fn tug_of(&self, harbour: EntityId) -> Option<EntityId> {
        self.objects.iter().find(|e| matches!(e.object, GameObject::Car(ref c) if c.role == CarRole::Tug && c.owner == harbour)).map(|e| e.id)
    }

    /// When a box booked now for a harbour would berth: on the ferry's
    /// next sailing from the world, the one it has not yet left on.
    pub fn next_call(&self, ferry: EntityId) -> Option<GameTime> {
        let Some(GameObject::Car(c)) = self.objects.get(ferry).map(|e| &e.object) else { return None };
        let away = c.run.is_none() && c.spot.is_none();
        Some(if away { c.due } else if c.spot.is_some() { c.due + TURN } else { c.due + DWELL + TURN })
    }

    /// The ferry woke: time to leave the world, to cast off, or to roll
    /// the next settler off; or it is at the next tile of its voyage.
    pub fn ferry_wake(&mut self, events: &mut EventQueue, ferry: EntityId, now: GameTime) {
        let Some(GameObject::Car(c)) = self.objects.get(ferry).map(|e| &e.object) else { return };
        let (harbour, due, run, moored) = (c.owner, c.due, c.run.clone(), c.spot.is_some());
        if self.objects.get(harbour).is_none() {
            self.despawn_car(ferry);
            return;
        }
        let Some(berth) = self.berth(harbour) else { return };
        if let Some(run) = run {
            self.voyage_step(events, ferry, run, berth, now);
        } else if moored {
            if now >= due {
                self.cast_off(events, ferry, berth, now);
            } else {
                self.roll_off(events, ferry, harbour, now);
                let next = if self.passengers(ferry) > 0 { ROLL_MS } else { due - now };
                events.wake(next.min(due - now).max(1), ferry);
            }
        } else {
            let Some(mut path) = self.voyage_out(berth) else { return };
            path.reverse();
            let sailing = path.len() as GameTime * PACE;
            if now + sailing < due {
                events.wake(due - sailing - now, ferry);
                return;
            }
            self.board(ferry, harbour);
            self.update_position(ferry, path[0]);
            if let Some(GameObject::Car(c)) = self.objects.get_mut(ferry).map(|e| &mut e.object) {
                c.run = Some(Run { job: Job::Sail, path, started: now, pace: PACE });
            }
            events.wake(PACE, ferry);
        }
    }

    /// Leaving the world: the booked boxes that fit go on the deck; then
    /// empties, enough that the park will have `EMPTIES` standing, for the
    /// town's lorries to fill with what it sells, as lines bring empties
    /// to where the exports are; and the settlers waiting to come take
    /// what room is left, two cars a slot.
    fn board(&mut self, ferry: EntityId, harbour: EntityId) {
        let waiting: Vec<EntityId> = self.waiting_settlers(harbour);
        let parked = match self.objects.get(harbour).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.park.iter().filter(|s| s.trailer.is_some_and(|t| t.empty())).count(),
            _ => 0,
        };
        let ids: Vec<u64> = (0..EMPTIES).map(|_| self.objects.reserve_id()).collect();
        let Some(GameObject::Car(c)) = self.objects.get_mut(ferry).map(|e| &mut e.object) else { return };
        c.deck.resize(DECK, None);
        let aboard = c.deck.iter().flatten().filter(|t| t.empty() && !t.outbound).count();
        let empties = ids.into_iter().take(EMPTIES.saturating_sub(parked + aboard)).map(|id| Trailer { id, good: None, units: 0.0, to: None, outbound: false, order: None });
        let mut boxes = std::mem::take(&mut c.booked).into_iter().chain(empties);
        for slot in c.deck.iter_mut().filter(|s| s.is_none()) {
            match boxes.next() {
                Some(t) => *slot = Some(t),
                None => break,
            }
        }
        c.booked = boxes.filter(|t| !t.empty()).collect();
        let room = 2 * c.deck.iter().filter(|s| s.is_none()).count();
        c.passengers = waiting.into_iter().take(room).collect();
    }

    /// Households moved into the town and not yet in it: their cars are
    /// nowhere, waiting for a ferry, and none is aboard one. With more than
    /// one harbour, each comes in by the nearest to their home.
    pub fn waiting_settlers(&self, harbour: EntityId) -> Vec<EntityId> {
        let aboard: std::collections::HashSet<EntityId> = self
            .objects
            .iter()
            .filter_map(|e| match e.object {
                GameObject::Car(ref c) if c.role == CarRole::Ferry => Some(c.passengers.iter().copied()),
                _ => None,
            })
            .flatten()
            .collect();
        let here = self.objects.get(harbour).and_then(|e| e.position);
        let harbours: Vec<(EntityId, GridCoord)> = self.harbours.keys().filter_map(|&h| Some((h, self.objects.get(h)?.position?))).collect();
        let mut cars: Vec<EntityId> = self
            .objects
            .iter()
            .filter_map(|e| match e.object {
                GameObject::Resident(ref r) if r.at.is_none() && r.car != 0 => Some((r.car, r.home)),
                _ => None,
            })
            .filter(|&(car, _)| !aboard.contains(&car) && self.objects.get(car).is_some_and(|e| e.position.is_none()))
            .filter(|&(_, home)| {
                let Some(h) = self.objects.get(home).and_then(|e| e.position) else { return false };
                let d = |p: GridCoord| (p.x - h.x).abs() + (p.y - h.y).abs();
                harbours.iter().min_by_key(|(id, p)| (d(*p), *id)).map(|&(id, _)| id) == Some(harbour) || here.is_none()
            })
            .map(|(car, _)| car)
            .collect();
        cars.sort_unstable();
        cars
    }

    fn passengers(&self, ferry: EntityId) -> usize {
        match self.objects.get(ferry).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.passengers.len(),
            _ => 0,
        }
    }

    /// The next settler drives off the ramp and home.
    fn roll_off(&mut self, events: &mut EventQueue, ferry: EntityId, harbour: EntityId, now: GameTime) {
        let Some(street) = self.street_of(harbour) else { return };
        let Some(GameObject::Car(c)) = self.objects.get(ferry).map(|e| &e.object) else { return };
        let Some(&car) = c.passengers.first() else { return };
        let home = match self.objects.get(car).map(|e| &e.object) {
            Some(GameObject::Car(c)) => self.objects.get(c.owner).and_then(|e| match e.object {
                GameObject::Resident(ref r) => Some(r.home),
                _ => None,
            }),
            _ => None,
        };
        // Off the deck once it is away, or at once if home is gone; one the
        // street does not let out yet tries again with the next. Whoever is
        // still aboard when the ferry sails waits for the next sailing.
        let drove = home.is_some_and(|home| crate::car::spawn::start_trip(self, events, car, street, home, now, GameTime::MAX));
        if drove || home.is_none() {
            if let Some(GameObject::Car(c)) = self.objects.get_mut(ferry).map(|e| &mut e.object) {
                c.passengers.remove(0);
            }
        }
    }

    /// The next tile of a voyage. In at the berth it moors; out at the
    /// horizon it is away, and back at the berth a turn after it cast off.
    fn voyage_step(&mut self, events: &mut EventQueue, ferry: EntityId, run: Run, berth: Berth, now: GameTime) {
        let k = ((now - run.started) / run.pace) as usize;
        let Some(&here) = run.path.get(k) else { return };
        self.update_position(ferry, here);
        if k + 1 < run.path.len() {
            events.wake(PACE, ferry);
            return;
        }
        let inbound = here == berth.tile(2);
        let harbour = match self.objects.get(ferry).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.owner,
            _ => return,
        };
        if let Some(GameObject::Car(c)) = self.objects.get_mut(ferry).map(|e| &mut e.object) {
            c.run = None;
            if inbound {
                c.spot = Some(berth.moored());
                c.due = now + DWELL;
            }
        }
        if inbound {
            events.wake(0, ferry);
            if let Some(tug) = self.tug_of(harbour) {
                events.wake(0, tug);
            }
        } else {
            self.unplace(ferry, here);
            events.wake(1, ferry);
        }
    }

    /// Time to sail: what went out on the deck is the world's, and paid
    /// for, as it casts off; the empties go back for nothing. Settlers
    /// still aboard ride back to wait for the next.
    fn cast_off(&mut self, events: &mut EventQueue, ferry: EntityId, berth: Berth, now: GameTime) {
        let Some(path) = self.voyage_out(berth) else { return };
        let Some(GameObject::Car(c)) = self.objects.get_mut(ferry).map(|e| &mut e.object) else { return };
        let harbour = c.owner;
        let mut sold = Vec::new();
        for slot in c.deck.iter_mut() {
            if slot.is_some_and(|t| t.outbound) {
                let t = slot.take().unwrap();
                if let Some(good) = t.good.filter(|_| t.units > 0.0) {
                    sold.push((good, t.units));
                }
            }
        }
        c.passengers.clear();
        c.spot = None;
        c.due = now + TURN;
        c.run = Some(Run { job: Job::Sail, path: path.clone(), started: now, pace: PACE });
        for (good, units) in sold {
            crate::economy::exported(self, harbour, good, units, now);
        }
        self.update_position(ferry, path[0]);
        events.wake(PACE, ferry);
    }

    /// Take an entity off the map: no position, out of every chunk.
    fn unplace(&mut self, id: EntityId, at: GridCoord) {
        self.unindex(id, at);
        if let Some(e) = self.objects.get_mut(id) {
            e.position = None;
        }
    }

    /// The ferry at the ramp, and when it sails.
    fn berthed(&self, harbour: EntityId) -> Option<(EntityId, GameTime)> {
        let ferry = self.ferry_of(harbour)?;
        match self.objects.get(ferry).map(|e| &e.object) {
            Some(GameObject::Car(c)) if c.spot.is_some() && c.run.is_none() => Some((ferry, c.due)),
            _ => None,
        }
    }

    /// The docks of the park with no box in them and nobody holding them.
    fn free_docks(&self, harbour: EntityId) -> Vec<usize> {
        let Some(GameObject::Building(b)) = self.objects.get(harbour).map(|e| &e.object) else { return Vec::new() };
        (0..b.park.len()).filter(|&i| b.park[i].trailer.is_none() && !self.dock_held(harbour, i)).collect()
    }

    fn free_dock(&self, harbour: EntityId) -> Option<usize> {
        self.free_docks(harbour).first().copied()
    }

    /// The tug woke: its move is done, or there may be work. At the end of
    /// a move it hitches what it came for or drops what it brought, and
    /// with a box on the hitch goes straight on with it; empty, it takes
    /// the next box: one off the ferry while one is on it and a dock is
    /// free, then one onto it while one waits in the park and the deck has
    /// room, each only if it is done before the ferry sails; else it goes
    /// back to its place by the ramp.
    pub fn tug_wake(&mut self, events: &mut EventQueue, tug: EntityId, now: GameTime) {
        let Some(GameObject::Car(c)) = self.objects.get(tug).map(|e| &e.object) else { return };
        let (harbour, shunt) = (c.owner, c.shunt.clone());
        // The park is the yard's docks, laid with the lot.
        self.lot_mut(harbour);
        if let Some(s) = shunt {
            if now < s.ends {
                events.wake(s.ends - now, tug);
                return;
            }
            if let Some(GameObject::Car(c)) = self.objects.get_mut(tug).map(|e| &mut e.object) {
                c.spot = Some(end_pose(&s));
                c.shunt = None;
            }
            self.arrive(events, tug, harbour, s.to, now);
        }
        let Some(berth) = self.berth(harbour) else { return };
        let next = match self.hitched_of(tug) {
            Some(_) => self.onward(tug, harbour, berth, now),
            None => self.next_move(tug, harbour, berth, now),
        };
        let Some(s) = next else { return };
        if let Place::Park(i) = s.to {
            self.hold_dock(harbour, tug, i, now, s.ends);
        }
        let ends = s.ends;
        if let Some(GameObject::Car(c)) = self.objects.get_mut(tug).map(|e| &mut e.object) {
            c.shunt = Some(s);
        }
        events.wake(ends - now, tug);
    }

    /// A move: along a path, a tile and a bit a second, with the time to
    /// hitch or drop at the end.
    fn shunt(path: Vec<[f64; 2]>, backs_from: usize, to: Place, now: GameTime) -> Shunt {
        let ms = (length(&path) / TUG_SPEED) as GameTime + HITCH_MS;
        Shunt { path, started: now, ends: now + ms, backs_from, to }
    }

    /// With a box off the ferry, down the ramp and into a free dock from
    /// the quay side; with one out of the park, backing it up the ramp
    /// onto the deck, the sea end first so the land end stays clear. None
    /// where there is nowhere to take it yet: it waits with it.
    fn onward(&self, tug: EntityId, harbour: EntityId, berth: Berth, now: GameTime) -> Option<Shunt> {
        let here = self.spot_of(tug)?;
        let GameObject::Building(ref h) = self.objects.get(harbour)?.object else { return None };
        let ship = berth.moored();
        let tug_at = |p: Pose| plus(p.at, ahead(p.heading, TUG_BOX));
        let behind = |p: Pose| plus(p.at, ahead(p.heading, -0.5));
        let outbound = self.hitched_of(tug)?.outbound;
        if !outbound {
            let i = self.free_dock(harbour)?;
            let p = h.park[i].pose;
            return Some(Self::shunt(vec![here.at, berth.ramp(), berth.apron(), behind(p), tug_at(p)], usize::MAX, Place::Park(i), now));
        }
        let (ferry, _) = self.berthed(harbour)?;
        let k = self.deck_room(ferry)?;
        let p = h.park.iter().map(|s| s.pose).min_by(|a, b| dist(a.at, here.at).total_cmp(&dist(b.at, here.at)))?;
        Some(Self::shunt(vec![here.at, behind(p), berth.apron(), berth.ramp(), tug_at(deck_pose(ship, k))], 0, Place::Deck(k), now))
    }

    /// The tug's next box, and the move to it.
    fn next_move(&self, tug: EntityId, harbour: EntityId, berth: Berth, now: GameTime) -> Option<Shunt> {
        let here = self.spot_of(tug).unwrap_or(berth.rest());
        let GameObject::Building(ref h) = self.objects.get(harbour)?.object else { return None };
        let ship = berth.moored();
        let tug_at = |p: Pose| plus(p.at, ahead(p.heading, TUG_BOX));
        // A box and its tow there and on: the way to it and the way on,
        // about as long again.
        let done_by = |s: &Shunt| s.ends + (s.ends - now) + 2 * HITCH_MS;
        if let Some((ferry, due)) = self.berthed(harbour) {
            let deck = match self.objects.get(ferry).map(|e| &e.object) {
                Some(GameObject::Car(c)) => c.deck.clone(),
                _ => Vec::new(),
            };
            // Off the ferry while that leaves a dock free, so a lorry
            // bringing a box out always has somewhere to drop it.
            let off = (0..deck.len()).find(|&k| deck[k].is_some_and(|t| !t.outbound));
            if let (Some(k), true) = (off, self.free_docks(harbour).len() >= 2) {
                let s = Self::shunt(vec![here.at, berth.apron(), berth.ramp(), tug_at(deck_pose(ship, k))], 1, Place::Deck(k), now);
                if done_by(&s) <= due {
                    return Some(s);
                }
            }
            let out = (0..h.park.len()).find(|&i| h.park[i].trailer.is_some_and(|t| t.outbound) && !self.dock_held(harbour, i));
            if let (Some(i), Some(_)) = (out, self.deck_room(ferry)) {
                let p = h.park[i].pose;
                let front = plus(p.at, ahead(p.heading, TUG_BOX + 0.6));
                let s = Self::shunt(vec![here.at, front, tug_at(p)], 1, Place::Park(i), now);
                if done_by(&s) <= due {
                    return Some(s);
                }
            }
        }
        let rest = berth.rest();
        (dist(here.at, rest.at) > 0.05).then(|| Self::shunt(vec![here.at, rest.at], usize::MAX, Place::Rest, now))
    }

    /// The deck's free slot nearest the sea end.
    fn deck_room(&self, ferry: EntityId) -> Option<usize> {
        let Some(GameObject::Car(c)) = self.objects.get(ferry).map(|e| &e.object) else { return None };
        (0..DECK).rev().find(|&k| c.deck.get(k).is_none_or(|s| s.is_none()))
    }

    fn spot_of(&self, car: EntityId) -> Option<Pose> {
        match self.objects.get(car).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.spot,
            _ => None,
        }
    }

    /// The tug is where its move ends: it hitches the box there, or drops
    /// the one on its hitch.
    fn arrive(&mut self, events: &mut EventQueue, tug: EntityId, harbour: EntityId, place: Place, now: GameTime) {
        let hitched = self.hitched_of(tug);
        let ferry = self.ferry_of(harbour);
        match (place, hitched) {
            (Place::Deck(k), None) => {
                let t = ferry.and_then(|f| match self.objects.get_mut(f).map(|e| &mut e.object) {
                    Some(GameObject::Car(c)) => c.deck.get_mut(k).and_then(Option::take),
                    _ => None,
                });
                self.set_hitch(tug, t);
            }
            (Place::Deck(k), Some(t)) => {
                // The ferry sailed without it: it goes back to the park.
                let Some(GameObject::Car(c)) = ferry.filter(|&f| self.berthed(harbour).is_some_and(|(b, _)| b == f)).and_then(|f| self.objects.get_mut(f)).map(|e| &mut e.object) else { return };
                c.deck.resize(DECK, None);
                c.deck[k] = Some(t);
                self.set_hitch(tug, None);
            }
            (Place::Park(i), None) => {
                let t = match self.objects.get_mut(harbour).map(|e| &mut e.object) {
                    Some(GameObject::Building(b)) => b.park.get_mut(i).and_then(|s| s.trailer.take()),
                    _ => None,
                };
                self.unhold_dock(harbour, tug);
                self.set_hitch(tug, t);
            }
            (Place::Park(i), Some(t)) => {
                if let Some(GameObject::Building(b)) = self.objects.get_mut(harbour).map(|e| &mut e.object) {
                    b.park[i].trailer = Some(t);
                }
                self.unhold_dock(harbour, tug);
                self.set_hitch(tug, None);
                // A box from the world landed: the town pays for what is in
                // it, unless it is the world's gift; and the lorries that
                // fetch for the town hear of it.
                if let Some(good) = t.good.filter(|_| t.units > 0.0 && !t.outbound) {
                    if t.order != Some(GIFT) {
                        crate::economy::landed(self, harbour, good, t.units, now);
                    }
                    crate::haul::call_lorries(self, events);
                }
            }
            (Place::Rest, _) => {}
        }
    }

    fn hitched_of(&self, car: EntityId) -> Option<Trailer> {
        match self.objects.get(car).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.hitched,
            _ => None,
        }
    }

    pub fn set_hitch(&mut self, car: EntityId, t: Option<Trailer>) {
        if let Some(GameObject::Car(c)) = self.objects.get_mut(car).map(|e| &mut e.object) {
            c.hitched = t;
        }
    }
}

/// Where a tug stands at the end of a move: at its last point, facing the
/// way it went, or back the way it came if it was backing.
fn end_pose(s: &Shunt) -> Pose {
    let n = s.path.len();
    let (a, b) = (s.path[n.saturating_sub(2)], s.path[n - 1]);
    let heading = (b[1] - a[1]).atan2(b[0] - a[0]);
    Pose { at: b, heading: if s.backs_from < n - 1 { heading + std::f64::consts::PI } else { heading } }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::TerrainType;

    /// Grass either side of a street along y = 0, and the sea from y = 5
    /// south of it; the map ends at y = 41, a chunk and more out, and
    /// further than that to the sides.
    fn coast() -> World {
        let mut world = World::new();
        for y in -8..41 {
            for x in -60..100 {
                world.terrain.insert((x, y), if y >= 4 { TerrainType::Sea } else { TerrainType::Grass });
            }
        }
        world.place_road_path(&(-4..40).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>());
        world
    }

    #[test]
    fn a_harbour_stands_with_its_back_to_the_sea() {
        let mut world = coast();
        // North of the street the back is on grass: no way round fits.
        assert!(world.place_on_street(GridCoord { x: 10, y: -1 }, BuildingKind::Harbour).is_none());
        let harbour = world.place_on_street(GridCoord { x: 10, y: 1 }, BuildingKind::Harbour).expect("the coast takes a harbour");
        let berth = world.berth(harbour).unwrap();
        assert_eq!((berth.quay.y, berth.out), (4, (0, 1)), "the quay is the water behind the back face: {berth:?}");
        // The way out is straight out and then to the edge.
        let path = world.voyage_out(berth).expect("a way to the sea");
        assert_eq!(path[0], berth.tile(2));
        assert!(path.windows(2).all(|w| (w[0].x - w[1].x).abs() + (w[0].y - w[1].y).abs() == 1));
        assert!(path.iter().all(|t| world.terrain[&(t.x, t.y)] == TerrainType::Sea), "the ship sailed over land");
        // Moored, its land end is on the ramp.
        let m = berth.moored();
        let end = plus(m.at, ahead(m.heading, FERRY_LENGTH / 2.0));
        assert!((end[0] - berth.ramp()[0]).abs() < 1e-9 && (end[1] - berth.ramp()[1]).abs() < 1e-9);
    }

    #[test]
    fn a_lake_takes_no_harbour() {
        let mut world = coast();
        for t in world.terrain.values_mut() {
            if *t == TerrainType::Sea {
                *t = TerrainType::Water;
            }
        }
        assert!(world.place_on_street(GridCoord { x: 10, y: 1 }, BuildingKind::Harbour).is_none(), "a harbour stood on a lake");
    }

    /// Every deck slot is on the hull, and no two overlap.
    #[test]
    fn the_deck_holds_its_slots_on_the_hull() {
        let ship = Pose { at: [0.0, 0.0], heading: 0.0 };
        for k in 0..DECK {
            let p = deck_pose(ship, k);
            assert!(p.at[0].abs() + 0.23 <= FERRY_LENGTH / 2.0, "slot {k} hangs off the end: {:?}", p.at);
            assert!(p.at[1].abs() <= 0.4, "slot {k} hangs off the side");
            for j in 0..k {
                let q = deck_pose(ship, j);
                assert!((p.at[0] - q.at[0]).abs() >= 0.46 || (p.at[1] - q.at[1]).abs() >= 0.17, "slots {j} and {k} overlap");
            }
        }
    }
}
