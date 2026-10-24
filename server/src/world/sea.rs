//! The harbour, the ferry and the tug: the door everything comes in and
//! goes out by (docs/shipping.md §Harbours).
//!
//! A harbour stands half on the water, with its back to the sea: the
//! middle of its back row is over the sea, its quay built out on it, and
//! the tile of sea behind that is the berth's; the ferry berths there with
//! its ramp on the quay edge, lying straight out to sea, so a harbour
//! needs `BERTH` tiles of sea in a line behind it. On the street side is the
//! trailer park, which is the yard's docks (`lots.rs`): a box stands in a
//! dock where a lorry backed in would have its trailer, and a lorry backs
//! into a free dock to drop one or under one to hook it.
//!
//! The ferry is the world's, one to a harbour, on a timetable: it leaves
//! the world with what was booked for it and the settlers waiting to come,
//! sails in from the map's edge along its line's way (`shipping/`),
//! berths for `DWELL`, and casts off on time with whatever the tug got
//! aboard, back out over the edge. The world pays for
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

use crate::blueprint::FACINGS;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::protocol::{BuildingKind, Car, CarRole, EntityId, GameObject, Good, GridCoord, Place, Pose, Shunt, TerrainType, Trailer, DAY_MS};
use crate::shipping::lanes::{Gate, Kind, Lanes};
use crate::shipping::lines::Line;
use crate::shipping::DWELL;
use crate::shipping::voyage::Voyage;
use crate::shipping::water::{End, Water};
use crate::world::World;
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
/// The first call at a new harbour: half an hour after it is built.
pub const FIRST_CALL: GameTime = DAY_MS as GameTime / 48;
/// A settler's car rolls off every few seconds.
pub const ROLL_MS: GameTime = 4_000;
/// The tug: a tile a second on a run forward, under half that backing,
/// gathering way and losing it at an even push, so it stops where it
/// changes gear and stands there a moment (`car::CUSP_MS`); and a moment
/// to couple or drop a box at the end (`haul::COUPLE_MS`). The client
/// plays a move on the same terms (`shunting` in `sea.ts`).
pub const TUG_FORWARD: f64 = 1.0;
pub const TUG_BACKING: f64 = 0.4;
pub const TUG_PUSH: f64 = 0.6;
const HITCH_MS: GameTime = crate::haul::COUPLE_MS;
/// A box's middle behind the tug's, and behind a docked lorry's cab: half
/// of each and the coupling.
pub const TUG_BOX: f64 = 0.32;
pub const CAB_BOX: f64 = 0.262;

/// The starter pack's order: the world's gift, paid for by nobody.
pub const GIFT: u64 = 0;
/// The starter pack, the first harbour's first sailing: timber for the
/// first houses, stone for the first streets, crates for the first shop,
/// fuel; a box of each.
pub const STARTER: [Good; 6] = [Good::Timber, Good::Timber, Good::Timber, Good::Stone, Good::Crates, Good::Fuel];

fn ahead(heading: f64, d: f64) -> [f64; 2] {
    [heading.cos() * d, heading.sin() * d]
}

fn plus(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [a[0] + b[0], a[1] + b[1]]
}

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
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

pub use crate::shipping::water::{Berth, BERTH};

/// Where a settler's car stands in deck slot `k`, two to a slot, one
/// either side of its middle along it, facing the land (`aboard` in the
/// client's `motion.ts`).
pub fn seats(ship: Pose, k: usize) -> [Pose; 2] {
    let p = deck_pose(ship, k);
    [-0.15, 0.15].map(|d| Pose { at: plus(p.at, ahead(p.heading, d)), heading: p.heading })
}

use crate::world::lots::{DOCK_OUT, PAST};

impl Berth {
    /// A point `s` in from the ramp up the lane, and `side` out from its
    /// middle (positive to the terminal's side).
    fn at(&self, s: f64, side: f64) -> [f64; 2] {
        plus(plus(self.ramp(), ahead(self.landward(), s)), ahead(self.landward() + std::f64::consts::FRAC_PI_2, side))
    }
    /// How far a point is in from the ramp, up the lane.
    fn up(&self, p: [f64; 2]) -> f64 {
        let r = self.ramp();
        let l = self.landward();
        (p[0] - r[0]) * l.cos() + (p[1] - r[1]) * l.sin()
    }
    /// In the lane, half a tile in from the ramp.
    fn apron(&self) -> [f64; 2] {
        self.at(0.5, 0.0)
    }
    /// Where the tug waits: in the corner on the quay across the lane
    /// from the terminal, clear of the docks, facing the land.
    fn rest(&self) -> Pose {
        Pose { at: self.at(0.2, -DOCK_OUT), heading: self.landward() }
    }
    /// The point in the lane a dock's row is backed into from, going
    /// toward the gate: past its mouth, short of the street.
    fn past(&self, s: f64) -> [f64; 2] {
        self.at((s + PAST).min(1.9), 0.0)
    }
    /// The harbour's park as its yard lays it (`lots::park`), in from the
    /// ramp: the lane from the gate down to the ramp, and the trailer park
    /// either side of it. Nothing stands in the lane: what comes off the
    /// ferry drives up it to the gate.
    pub fn park(&self) -> (Vec<[f64; 2]>, Vec<(Pose, usize, usize)>) {
        crate::world::lots::park(|s, side| self.at(s, side), &[1.0, -1.0])
    }
}

impl World {
    /// The berth a kind's plot would have here this way round: the tile of
    /// the sea behind the middle of its back, in line with its lane, with
    /// `BERTH` tiles of sea straight out from it, and the middle of its
    /// back row on the sea too, the quay built out over it. None where
    /// that is land, a lake, or water too narrow for the ferry.
    pub fn berth_at(&self, tiles: &[GridCoord], kind: BuildingKind, facing: u8) -> Option<Berth> {
        let (dx, dy) = FACINGS[facing as usize % 4];
        let gate = World::gate_of(tiles, kind, facing)?;
        // Straight back from the gate, through the plot, to the water.
        let (_, (w, h)) = World::bounds(tiles);
        let deep = if dx == 0 { h } else { w } as i32;
        let b = Berth { quay: GridCoord { x: gate.x - dx * deep, y: gate.y - dy * deep }, out: (-dx, -dy) };
        (-1..BERTH).all(|n| self.terrain.get(&(b.tile(n).x, b.tile(n).y)) == Some(&TerrainType::Sea)).then_some(b)
    }

    /// A standing harbour's berth.
    pub fn berth(&self, harbour: EntityId) -> Option<Berth> {
        let GameObject::Building(ref b) = self.objects.get(harbour)?.object else { return None };
        self.berth_at(&b.tiles, b.kind, b.facing)
    }

    /// A harbour's line to the world: out from its berth to the map's
    /// edge (`shipping::water::route`) and back in its own lane beside the
    /// way out, both laid on the map as lanes (`shipping::lanes`), on the
    /// clock-face timetable (`Line::cycle`). Found once, when the harbour
    /// is commissioned, and kept; rebuilt from nothing on load, harbour by
    /// harbour in the same order. None where the water does not reach the
    /// edge.
    fn line_to_world(&mut self, harbour: EntityId) -> Option<Line> {
        let berth = self.berth(harbour)?;
        let water = self.water.get_or_init(|| Water::of(&self.terrain));
        let lanes = self.lanes.get_or_insert_with(|| Lanes::new(water));
        let out = water.route(lanes, &berth, End::Edge, false)?;
        lanes.lay(water, &out, [true, false]);
        let back = water.route(lanes, &berth, End::Edge, true)?;
        lanes.lay(water, &back, [false, true]);
        Some(Line { legs: [out, back] })
    }

    /// The junction a ferry holds while it is at a harbour's ramp: the
    /// berth's approach at the end of the way in.
    fn berth_gate(&self, harbour: EntityId) -> Option<Gate> {
        let way = &self.lines.get(&harbour)?.legs[1];
        self.lanes.as_ref()?.gates(way).pop().filter(|g| g.kind == Kind::Berth && g.d1 >= crate::shipping::length(way) - 1e-6)
    }

    /// A ferry sets out on a leg of its line: in from the edge, or out
    /// from the berth (`astern`), which it holds as it leaves.
    fn set_out(&mut self, events: &mut EventQueue, ferry: EntityId, way: Vec<[f64; 2]>, astern: bool, now: GameTime) {
        let ease = if astern { [true, false] } else { [false, true] };
        let Some(gates) = self.lanes.as_ref().map(|l| l.gates(&way)) else { return };
        let (voyage, sail, woken) = Voyage::new(ferry, way, ease, astern, gates, [0, self.berth_free(ferry)], now, &mut self.junctions);
        for w in woken {
            events.wake(0, w);
        }
        self.voyages.insert(ferry, voyage);
        if let Some(c) = self.car_mut(ferry) {
            c.sail = Some(sail);
        }
        self.sailing(events, ferry, now);
    }

    /// When the ferry at the ramp a ferry sails to casts off.
    fn berth_free(&self, ferry: EntityId) -> GameTime {
        self.car(ferry).and_then(|c| self.berthed(c.owner)).filter(|&(f, _)| f != ferry).map_or(GameTime::MAX, |(_, due)| due)
    }

    /// From casting off to berthing again, by the harbour's line.
    pub fn turn(&self, harbour: EntityId) -> Option<GameTime> {
        Some(self.lines.get(&harbour)?.cycle() - DWELL)
    }

    /// A harbour is built: the world's ferry is put on its line, due half
    /// an hour later. The first harbour's first sailing brings the starter
    /// pack, the world's gift: timber for the first houses, stone for the
    /// first streets, crates for the first shop, fuel, every box the
    /// town's (docs/game.md §The opening).
    pub fn commission(&mut self, harbour: EntityId, now: GameTime) {
        // No ferry yet on any line, its harbour standing or not.
        let first = !self.lines.keys().any(|&h| !self.ferries_of(h).is_empty());
        if !self.lines.contains_key(&harbour)
            && self.berth(harbour).is_some()
            && let Some(line) = self.line_to_world(harbour)
        {
            self.lines.insert(harbour, line);
        }
        // Its tug stands by the ramp from the first.
        // Asked every settle: only a tug with no place is touched, or every
        // tick would send it to the clients again.
        if let Some(tug) = self.tug_of(harbour).filter(|&t| self.spot_of(t).is_none())
            && let Some(rest) = self.berth(harbour).map(|b| b.rest())
            && let Some(c) = self.car_mut(tug)
        {
            c.spot = Some(rest);
        }
        // Its ferries, one a call every `CALL_EVERY` at most: where the
        // edge is far, two pass each other at sea, evenly spaced.
        let Some(line) = self.lines.get(&harbour) else { return };
        let (n, gap) = (line.every_call(), line.cycle() / line.every_call() as GameTime);
        for k in self.ferries_of(harbour).len()..n {
            let mut ferry = Car::new(harbour, CarRole::Ferry);
            ferry.due = now + FIRST_CALL + k as GameTime * gap;
            if first && k == 0 {
                for good in STARTER {
                    let id = self.objects.reserve_id();
                    ferry.booked.push(Trailer { id, good, units: good.per_box(), to: None, outbound: false, order: GIFT, partner: None, price: 0.0 });
                }
            }
            self.insert_at(GameObject::Car(ferry), None);
        }
    }

    /// A harbour's ferries, by id.
    pub fn ferries_of(&self, harbour: EntityId) -> Vec<EntityId> {
        self.objects.fleet(harbour).filter(|&f| self.car(f).is_some_and(|c| c.role == CarRole::Ferry)).collect()
    }

    /// The harbour's ferry next at the ramp: the one there, or the one
    /// that berths soonest.
    pub fn ferry_of(&self, harbour: EntityId) -> Option<EntityId> {
        self.berthed(harbour).map(|(f, _)| f).or_else(|| self.ferries_of(harbour).into_iter().min_by_key(|&f| (self.car(f).map_or(GameTime::MAX, |c| c.due), f)))
    }

    /// The ferry a box booked now rides: the next to leave the world.
    pub fn next_ferry(&self, harbour: EntityId) -> Option<EntityId> {
        self.ferries_of(harbour).into_iter().min_by_key(|&f| (self.next_call(f).unwrap_or(GameTime::MAX), f))
    }

    /// A harbour's tug.
    pub fn tug_of(&self, harbour: EntityId) -> Option<EntityId> {
        self.objects.fleet(harbour).find(|&t| self.car(t).is_some_and(|c| c.role == CarRole::Tug))
    }

    /// When a box booked now for a harbour would berth: on the ferry's
    /// next sailing from the world, the one it has not yet left on.
    pub fn next_call(&self, ferry: EntityId) -> Option<GameTime> {
        let Some(c) = self.car(ferry) else { return None };
        let turn = self.turn(c.owner)?;
        // Coming in, it has left the world already: the sailing after it.
        // Going out, or away, `due` is its next berthing, which is the one.
        let inbound = c.sail.as_ref().is_some_and(|s| !s.astern);
        Some(if inbound { c.due + DWELL + turn } else if c.spot.is_some() { c.due + turn } else { c.due })
    }

    /// The ferry woke: time to leave the world, to cast off, or to roll
    /// the next settler off; or it is crossing into another chunk, or at
    /// the end of its leg.
    pub fn ferry_wake(&mut self, events: &mut EventQueue, ferry: EntityId, now: GameTime) {
        let Some(c) = self.car(ferry) else { return };
        let (harbour, due, sail, moored) = (c.owner, c.due, c.sail.clone(), c.spot.is_some());
        if self.objects.get(harbour).is_none() {
            self.junctions.remove_car_from_all(ferry, now);
            self.voyages.remove(&ferry);
            self.despawn_car(ferry);
            return;
        }
        let Some(line) = self.lines.get(&harbour) else { return };
        if sail.is_some() {
            self.sailing(events, ferry, now);
        } else if moored {
            // At the ramp it holds the berth's approach: asked again after
            // a load, when nothing remembers it.
            if let Some(g) = self.berth_gate(harbour).filter(|g| !self.junctions.has_passage(g.id, ferry)) {
                self.junctions.get_or_create_with(g.id, g.kind.rule()).register(ferry, g.from, g.to, now);
            }
            if now >= due {
                self.cast_off(events, ferry, now);
            } else {
                self.roll_off(events, ferry, harbour, now);
                let next = if self.passengers(ferry) > 0 { ROLL_MS } else { due - now };
                events.wake(next.min(due - now).max(1), ferry);
            }
        } else {
            // It leaves the world a leg before it is due at the ramp, and
            // is wherever that puts it now: the first call, half an hour
            // after a harbour stands, finds it already well on its way. If
            // the berth is taken when it gets near, it waits at the mouth
            // of its approach, in sight.
            let leg = line.leg_ms(1);
            if now + leg < due {
                events.wake(due - leg - now, ferry);
                return;
            }
            // Out of sight it has come as far as the time left says: the
            // last of the way, from where a ship that is due then is now;
            // held up on its way out, it comes in late, over the edge.
            let way = &line.legs[1];
            let len = crate::shipping::length(way);
            let left = if now < due { crate::shipping::covered(len, [true, false], due - now) } else { len };
            let way = crate::shipping::last(way, left);
            self.board(ferry, harbour);
            self.set_out(events, ferry, way, false, now);
        }
    }

    /// Leaving the world: the booked boxes that fit go on the deck, and
    /// the settlers waiting to come take what room is left, two cars a
    /// slot.
    fn board(&mut self, ferry: EntityId, harbour: EntityId) {
        let waiting: Vec<EntityId> = self.waiting_settlers(harbour);
        let Some(c) = self.car_mut(ferry) else { return };
        c.deck.resize(DECK, None);
        let mut boxes = std::mem::take(&mut c.booked).into_iter();
        for slot in c.deck.iter_mut().filter(|s| s.is_none()) {
            match boxes.next() {
                Some(t) => *slot = Some(t),
                None => break,
            }
        }
        c.booked = boxes.collect();
        let room = 2 * c.deck.iter().filter(|s| s.is_none()).count();
        c.passengers = waiting.into_iter().take(room).collect();
    }

    /// Households moved into the town and not yet in it: their cars are
    /// nowhere, waiting for a ferry, and none is aboard one. With more than
    /// one harbour, each comes in by the nearest to their home.
    pub fn waiting_settlers(&self, harbour: EntityId) -> Vec<EntityId> {
        let aboard: crate::fixed::HashSet<EntityId> = self
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

    /// The next settler drives off the ramp and home: from its seat on the
    /// deck, the free slots' from the sea end, two to a slot, counted from
    /// the last aboard, so the first is at the land end and nobody moves
    /// as those before them leave.
    fn roll_off(&mut self, events: &mut EventQueue, ferry: EntityId, harbour: EntityId, now: GameTime) {
        let Some(street) = self.street_of(harbour) else { return };
        let Some(berth) = self.berth(harbour) else { return };
        let Some(c) = self.car(ferry) else { return };
        let Some(&car) = c.passengers.first() else { return };
        let j = c.passengers.len() - 1;
        let free: Vec<usize> = (0..DECK).rev().filter(|&k| c.deck.get(k).is_none_or(|s| s.is_none())).collect();
        let seat = free.get(j >> 1).map(|&k| (k, seats(berth.moored(), k)[j & 1]));
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
        let off = seat.and_then(|(k, at)| Some((self.way_off(harbour, 2 * k + (j & 1))?, at)));
        let drove = home.is_some_and(|home| match off {
            Some((out, at)) => {
                self.update_position(car, GridCoord { x: at.at[0].floor() as i32, y: at.at[1].floor() as i32 });
                crate::car::spawn::depart(self, events, car, out, Some(at), street, home, now, GameTime::MAX)
            }
            None => crate::car::spawn::start_trip(self, events, car, street, home, now, GameTime::MAX),
        });
        if drove || home.is_none() {
            if let Some(c) = self.car_mut(ferry) {
                c.passengers.remove(0);
            }
        }
    }

    /// On a leg: on the map where the leg has it, and awake again as it
    /// crosses into another chunk, for the views that watch one, and as
    /// its voyage must think at a junction (`shipping::voyage`): it may
    /// stop at a mouth and stand there, and the ships it lets through as
    /// it leaves one are woken. At the end, in at the berth it moors; out
    /// over the edge it is away, back at the berth a turn after it cast
    /// off.
    fn sailing(&mut self, events: &mut EventQueue, ferry: EntityId, now: GameTime) {
        let Some(mut sail) = self.car(ferry).and_then(|c| c.sail.clone()) else { return };
        let Some(mut voyage) = self.voyages.remove(&ferry) else { return };
        let (woken, done) = voyage.step(ferry, &mut sail, self.berth_free(ferry), now, &mut self.junctions);
        for w in woken {
            events.wake(0, w);
        }
        let tile = |t: GameTime| {
            let p = sail.pose(t).at;
            GridCoord { x: p[0].floor() as i32, y: p[1].floor() as i32 }
        };
        if !done {
            if let Some(c) = self.car_mut(ferry)
                && c.sail.as_ref() != Some(&sail)
            {
                c.sail = Some(sail.clone());
            }
            self.update_position(ferry, tile(now));
            let next = voyage.wake(&sail).min(if now < sail.ends { sail.next_crossing(now) } else { GameTime::MAX });
            if next < GameTime::MAX {
                events.wake(next.saturating_sub(now).max(1), ferry);
            }
            self.voyages.insert(ferry, voyage);
            return;
        }
        let Some(c) = self.car_mut(ferry) else { return };
        c.sail = None;
        let harbour = c.owner;
        if !sail.astern {
            c.spot = Some(sail.pose(sail.ends));
            c.due = now + DWELL;
            self.update_position(ferry, tile(sail.ends));
            // The post comes with it.
            crate::orders::post(self, harbour, now);
            events.wake(0, ferry);
            if let Some(tug) = self.tug_of(harbour) {
                events.wake(0, tug);
            }
        } else {
            if let Some(at) = self.objects.get(ferry).and_then(|e| e.position) {
                self.unplace(ferry, at);
            }
            events.wake(1, ferry);
        }
    }

    /// Time to sail: what went out on the deck is the world's, and paid
    /// for, as it casts off. Settlers
    /// still aboard ride back to wait for the next.
    fn cast_off(&mut self, events: &mut EventQueue, ferry: EntityId, now: GameTime) {
        let Some(c) = self.car(ferry) else { return };
        let harbour = c.owner;
        let (Some(line), Some(turn)) = (self.lines.get(&harbour), self.turn(harbour)) else { return };
        let way = line.legs[0].clone();
        let Some(c) = self.car_mut(ferry) else { return };
        let mut sold = Vec::new();
        for slot in c.deck.iter_mut() {
            if slot.is_some_and(|t| t.outbound) {
                sold.push(slot.take().unwrap());
            }
        }
        c.passengers.clear();
        c.spot = None;
        c.due = now + turn;
        // Each box is paid for at its slot's price, by its partner; one
        // for a letter counts to it.
        for t in sold {
            crate::orders::sailed(self, &t);
            crate::economy::exported(self, harbour, t.good, t.price * t.units, now);
        }
        self.set_out(events, ferry, way, true, now);
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
        self.ferries_of(harbour).into_iter().find_map(|f| self.car(f).filter(|c| c.spot.is_some() && c.sail.is_none()).map(|c| (f, c.due)))
    }

    /// The docks of the park with no box in them and nobody holding them.
    fn free_docks(&self, harbour: EntityId) -> Vec<usize> {
        let Some(b) = self.building(harbour) else { return Vec::new() };
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
        let Some(c) = self.car(tug) else { return };
        let (harbour, shunt) = (c.owner, c.shunt.clone());
        // The park is the yard's docks, laid with the lot.
        self.lot_mut(harbour);
        if let Some(s) = shunt {
            if now < s.ends {
                events.wake(s.ends - now, tug);
                return;
            }
            if let Some(c) = self.car_mut(tug) {
                c.spot = Some(s.stands);
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
        if let Some(c) = self.car_mut(tug) {
            c.shunt = Some(s);
        }
        events.wake(ends - now, tug);
    }

    /// A move: along a path, forward and then backing from `backs_from`,
    /// to stand at its end facing `heading`, with the time to hitch or drop
    /// there. From the ferry's deck it drives off by the ramp first.
    fn shunt(berth: Berth, mut path: Vec<[f64; 2]>, mut backs_from: usize, heading: f64, to: Place, now: GameTime) -> Shunt {
        if berth.up(path[0]) < -0.05 && path.get(1) != Some(&berth.ramp()) {
            path.insert(1, berth.ramp());
            if backs_from >= 1 && backs_from != usize::MAX {
                backs_from += 1;
            }
        }
        // Each run one way, and how long it takes: gathering way and
        // losing it, a moment standing between.
        let mut runs: Vec<(f64, bool)> = Vec::new();
        for (i, w) in path.windows(2).enumerate() {
            let (l, back) = (dist(w[0], w[1]), i >= backs_from);
            match runs.last_mut() {
                Some(r) if r.1 == back => r.0 += l,
                _ => runs.push((l, back)),
            }
        }
        let secs: f64 = runs.iter().map(|&(l, back)| run_secs(l, if back { TUG_BACKING } else { TUG_FORWARD })).sum();
        let ms = (secs * 1000.0) as GameTime + runs.len().saturating_sub(1) as GameTime * crate::car::CUSP_MS + HITCH_MS;
        let stands = Pose { at: *path.last().unwrap(), heading };
        Shunt { path, started: now, ends: now + ms, backs_from, to, stands }
    }

    /// With a box off the ferry, down the ramp and up the lane past a
    /// free dock, and backing it in; with one out of the park, pulling it
    /// out into the lane toward the gate and backing it down the lane and
    /// up the ramp onto the deck, the sea end first so the land end stays
    /// clear. None where there is nowhere to take it yet: it waits with it.
    fn onward(&self, tug: EntityId, harbour: EntityId, berth: Berth, now: GameTime) -> Option<Shunt> {
        let here = self.spot_of(tug)?;
        let GameObject::Building(ref h) = self.objects.get(harbour)?.object else { return None };
        let ship = berth.moored();
        let tug_at = |p: Pose| plus(p.at, ahead(p.heading, TUG_BOX));
        let outbound = self.hitched_of(tug)?.outbound;
        if !outbound {
            let i = self.free_dock(harbour)?;
            let p = h.park[i].pose;
            return Some(Self::shunt(berth, vec![here.at, berth.ramp(), berth.past(berth.up(p.at)), tug_at(p)], 2, p.heading, Place::Park(i), now));
        }
        let (ferry, _) = self.berthed(harbour)?;
        let k = self.deck_room(ferry)?;
        let p = h.park.iter().map(|s| s.pose).min_by(|a, b| dist(a.at, here.at).total_cmp(&dist(b.at, here.at)))?;
        Some(Self::shunt(berth, vec![here.at, berth.past(berth.up(p.at)), berth.apron(), berth.ramp(), tug_at(deck_pose(ship, k))], 1, ship.heading, Place::Deck(k), now))
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
                let s = Self::shunt(berth, vec![here.at, berth.apron(), berth.ramp(), tug_at(deck_pose(ship, k))], 1, ship.heading, Place::Deck(k), now);
                if done_by(&s) <= due {
                    return Some(s);
                }
            }
            let out = (0..h.park.len()).find(|&i| h.park[i].trailer.is_some_and(|t| t.outbound) && !self.dock_held(harbour, i));
            if let (Some(i), Some(_)) = (out, self.deck_room(ferry)) {
                let p = h.park[i].pose;
                let front = plus(p.at, ahead(p.heading, TUG_BOX + 0.6));
                let s = Self::shunt(berth, vec![here.at, front, tug_at(p)], 1, p.heading, Place::Park(i), now);
                if done_by(&s) <= due {
                    return Some(s);
                }
            }
        }
        // Back to its corner, facing the land: up the lane past it and
        // backed in.
        let rest = berth.rest();
        (dist(here.at, rest.at) > 0.05).then(|| Self::shunt(berth, vec![here.at, berth.at(0.95, -0.45), berth.at(0.55, -DOCK_OUT), rest.at], 1, rest.heading, Place::Rest, now))
    }

    /// The deck's free slot nearest the sea end.
    fn deck_room(&self, ferry: EntityId) -> Option<usize> {
        let Some(c) = self.car(ferry) else { return None };
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
        let ferry = self.berthed(harbour).map(|(f, _)| f);
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
                if let Some(b) = self.building_mut(harbour) {
                    b.park[i].trailer = Some(t);
                }
                self.unhold_dock(harbour, tug);
                self.set_hitch(tug, None);
                // A box landed: the town pays its partner for it, unless it
                // is the world's gift; and the lorries that fetch for the
                // town hear of it.
                if !t.outbound {
                    if t.order != GIFT {
                        crate::economy::landed(self, harbour, t.good, t.price * t.units, now);
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
        if let Some(c) = self.car_mut(car) {
            c.hitched = t;
        }
    }
}

/// How long a run of `l` takes from a stand to a stand, at up to `top`,
/// gathering way and losing it at `TUG_PUSH`.
fn run_secs(l: f64, top: f64) -> f64 {
    if l < top * top / TUG_PUSH { 2.0 * (l / TUG_PUSH).sqrt() } else { l / top + top / TUG_PUSH }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::TerrainType;

    /// Grass either side of a street along y = 0, and the sea from y = 3
    /// south of it; the map ends at y = 41, a chunk and more out, and
    /// further than that to the sides.
    fn coast() -> World {
        let mut world = World::new();
        for y in -8..41 {
            for x in -60..100 {
                world.terrain.insert((x, y), if y >= 2 { TerrainType::Sea } else { TerrainType::Grass });
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
        assert_eq!((berth.quay.y, berth.out), (3, (0, 1)), "the quay is the water behind the back face: {berth:?}");
        // The way out is straight out from the moored ferry and on over the
        // map's edge, all of it on the water.
        world.commission(harbour, 0);
        let way = &world.lines[&harbour].legs[0];
        assert_eq!(way[0], berth.moored().at);
        assert_eq!(way[1][0], berth.tile(BERTH - 1).x as f64 + 0.5, "it turned off the berth's line: {way:?}");
        assert!(world.water.get().unwrap().afloat(way), "the ship sailed over land");
        assert_eq!(way.last().unwrap()[1], 41.0, "it did not sail off the map's edge: {way:?}");
        // Moored, its land end is on the ramp.
        let m = berth.moored();
        let end = plus(m.at, ahead(m.heading, FERRY_LENGTH / 2.0));
        assert!((end[0] - berth.ramp()[0]).abs() < 1e-9 && (end[1] - berth.ramp()[1]).abs() < 1e-9);
    }

    /// Every tile of the harbour is used and its lane is clear: its
    /// eight docks stand either side of the lane from the gate to the
    /// ramp, every box wholly on the harbour and wholly out of the lane,
    /// and the tug waits off it too.
    #[test]
    fn the_park_keeps_the_lane_to_the_ramp_clear() {
        let mut world = coast();
        let harbour = world.place_on_street(GridCoord { x: 10, y: 1 }, BuildingKind::Harbour).unwrap();
        let berth = world.berth(harbour).unwrap();
        let gate = world.door_of(harbour).unwrap().0;
        assert_eq!((gate.x, berth.quay.x), (11, 11), "the gate and the ramp are not in line");
        world.lot_mut(harbour).unwrap();
        let GameObject::Building(ref b) = world.objects.get(harbour).unwrap().object else { panic!() };
        assert_eq!(b.park.len(), 8);
        let lane = berth.ramp()[0];
        // A box, half its length and half its width, from its middle.
        let (l, w) = (0.23, 0.085);
        for slot in &b.park {
            let [x, y] = slot.pose.at;
            let (hx, hy) = (slot.pose.heading.cos().abs() * l + slot.pose.heading.sin().abs() * w, slot.pose.heading.sin().abs() * l + slot.pose.heading.cos().abs() * w);
            assert!(x - hx >= 10.0 && x + hx <= 13.0 && y - hy >= 1.0 && y + hy <= 3.0, "a box off the harbour at {:?}", slot.pose.at);
            assert!((x - lane).abs() - hx >= 0.5, "a box in the lane at {:?}", slot.pose.at);
        }
        assert!((berth.rest().at[0] - lane).abs() >= 0.5, "the tug waits in the lane");
    }

    /// On a coast running on the diagonal, the shore crosses the plot:
    /// its gate on the land, its quay out over the sea.
    #[test]
    fn a_harbour_fits_a_diagonal_coast() {
        let mut world = World::new();
        for y in -10..40 {
            for x in -10..40 {
                world.terrain.insert((x, y), if x + y >= 14 { TerrainType::Sea } else { TerrainType::Grass });
            }
        }
        let tiles = world.fit(BuildingKind::Harbour, GridCoord { x: 10, y: 4 }, 0).expect("the diagonal coast takes a harbour");
        let wet = tiles.iter().filter(|t| world.terrain[&(t.x, t.y)] == TerrainType::Sea).count();
        assert_eq!(wet, 3, "it stands half on the water: {tiles:?}");
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

