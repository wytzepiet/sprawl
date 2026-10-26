//! The ferry's day: put on its line when a harbour is built, in from the
//! world on its timetable, berthed while the harbour's forklifts work its
//! deck and its settlers roll off, and out again on time with whatever
//! got aboard (docs/shipping.md §Harbours). Where a harbour and its berth
//! stand, and the ferry's deck, are the map's (`world::sea`).

use crate::engine::event_queue::EventQueue;
use model::{Car, CarRole, EntityId, GameObject, GameTime, Good, GridCoord, Package, DAY_MS};
use crate::shipping::lanes::{Gate, Kind, Lanes};
use crate::shipping::lines::Line;
use crate::shipping::DWELL;
use crate::shipping::voyage::Voyage;
use crate::shipping::water::{End, Water};
use crate::world::sea::{seats, BAYS, DECK, PER_BAY, QUAY};
use crate::world::World;

/// The first call at a new harbour: half an hour after it is built.
pub const FIRST_CALL: GameTime = DAY_MS as GameTime / 48;
/// A settler's car rolls off every few seconds.
pub const ROLL_MS: GameTime = 4_000;
/// The starter pack's order: the world's gift, paid for by nobody.
pub const GIFT: u64 = 0;
/// The starter pack, the first harbour's first sailing: timber for the
/// first houses, stone for the first streets, crates for the first shop,
/// fuel; so many packages of each.
pub const STARTER: [(Good, u32); 4] = [(Good::Timber, 15), (Good::Stone, 5), (Good::Crates, 4), (Good::Fuel, 5)];

impl World {
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
    /// first streets, crates for the first shop, fuel, every package the
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
        // Its ferries, one a call every `CALL_EVERY` at most: where the
        // edge is far, two pass each other at sea, evenly spaced.
        let Some(line) = self.lines.get(&harbour) else { return };
        let (n, gap) = (line.every_call(), line.cycle() / line.every_call() as GameTime);
        for k in self.ferries_of(harbour).len()..n {
            let mut ferry = Car::new(harbour, CarRole::Ferry);
            ferry.due = now + FIRST_CALL + k as GameTime * gap;
            if first && k == 0 {
                for (good, n) in STARTER {
                    for _ in 0..n {
                        let id = self.objects.reserve_id();
                        ferry.booked.push(Package { id, good, to: None, outbound: false, order: GIFT, partner: None, price: 0.0 });
                    }
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

    /// The ferry a package booked now rides: the next to leave the world.
    pub fn next_ferry(&self, harbour: EntityId) -> Option<EntityId> {
        self.ferries_of(harbour).into_iter().min_by_key(|&f| (self.next_call(f).unwrap_or(GameTime::MAX), f))
    }

    /// When a package booked now for a harbour would berth: on the ferry's
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
                self.work_deck(events, ferry, harbour, now);
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

    /// Leaving the world: the booked packages that fit go on the deck, from
    /// the land end, and the settlers waiting to come take the bays left
    /// empty, two cars a bay.
    fn board(&mut self, ferry: EntityId, harbour: EntityId) {
        let waiting: Vec<EntityId> = self.waiting_settlers(harbour);
        let Some(c) = self.car_mut(ferry) else { return };
        c.deck.resize(DECK, None);
        let mut booked = std::mem::take(&mut c.booked).into_iter();
        for place in c.deck.iter_mut().filter(|s| s.is_none()) {
            match booked.next() {
                Some(t) => *place = Some(t),
                None => break,
            }
        }
        c.booked = booked.collect();
        let room = 2 * empty_bays(&c.deck).len();
        c.passengers = waiting.into_iter().take(room).collect();
    }

    /// Households moved into the town and not yet in it: their cars are
    /// nowhere, waiting for a ferry, and none is aboard one. With more than
    /// one harbour, each comes in by the nearest to their home.
    pub fn waiting_settlers(&self, harbour: EntityId) -> Vec<EntityId> {
        let aboard: fixed::HashSet<EntityId> = self
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
    /// deck, the empty bays' from the sea end, two to a bay, counted from
    /// the last aboard, so the first is at the land end and nobody moves
    /// as those before them leave.
    fn roll_off(&mut self, events: &mut EventQueue, ferry: EntityId, harbour: EntityId, now: GameTime) {
        let Some(street) = self.street_of(harbour) else { return };
        let Some(berth) = self.berth(harbour) else { return };
        let Some(c) = self.car(ferry) else { return };
        let Some(&car) = c.passengers.first() else { return };
        let j = c.passengers.len() - 1;
        let free = empty_bays(&c.deck);
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
            let p = crate::shipping::pose(&sail, t).at;
            GridCoord { x: p[0].floor() as i32, y: p[1].floor() as i32 }
        };
        if !done {
            if let Some(c) = self.car_mut(ferry)
                && c.sail.as_ref() != Some(&sail)
            {
                c.sail = Some(sail.clone());
            }
            self.update_position(ferry, tile(now));
            let next = voyage.wake(&sail).min(if now < sail.ends { crate::shipping::next_crossing(&sail, now) } else { GameTime::MAX });
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
            c.spot = Some(crate::shipping::pose(&sail, sail.ends));
            c.due = now + DWELL;
            self.update_position(ferry, tile(sail.ends));
            // The post comes with it.
            crate::orders::post(self, harbour, now);
            events.wake(0, ferry);
        } else {
            if let Some(at) = self.objects.get(ferry).and_then(|e| e.position) {
                self.unplace(ferry, at);
            }
            events.wake(1, ferry);
        }
    }

    /// Time to sail: what went out on the deck is the world's, and paid
    /// for, as it casts off; what it could not land rides round again.
    /// Settlers still aboard ride back to wait for the next.
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
        // Each package is paid for at its slot's price, by its partner;
        // one for a letter counts to it.
        for t in sold {
            crate::orders::sailed(self, &t);
            crate::economy::exported(self, harbour, t.good, t.value(), now);
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

    /// The harbour's forklifts work the deck of the ferry at its ramp:
    /// what came for the town is lifted off onto the quay, the land end
    /// first, as far as the quay has room, each paid for as it lands; then
    /// what waits on the quay to go out is lifted onto the deck's empty
    /// places from the sea end, each only if it is aboard before the ferry
    /// sails. A run is a lorry's worth of one good, so the forklifts share
    /// the work, and the lorries wait their turn among it.
    fn work_deck(&mut self, events: &mut EventQueue, ferry: EntityId, harbour: EntityId, now: GameTime) {
        let Some(due) = self.car(ferry).map(|c| c.due) else { return };
        let quay = self.building(harbour).map_or(0, |b| b.pad.len());
        let deck = self.car(ferry).map_or(Vec::new(), |c| c.deck.clone());
        let mut off: Vec<(usize, Package)> = deck.iter().enumerate().filter_map(|(k, t)| t.filter(|t| !t.outbound).map(|t| (k, t))).collect();
        off.truncate(QUAY.saturating_sub(quay));
        let mut landed = false;
        for run in runs(&off) {
            let good = run[0].1.good;
            self.lift(harbour, ferry, good, run.len() as u32, false, now);
            for &(k, t) in run {
                if let Some(c) = self.car_mut(ferry) {
                    c.deck[k] = None;
                }
                if let Some(b) = self.building_mut(harbour) {
                    b.pad.push(t);
                }
                // A package landed: the town pays its partner for it, unless
                // it is the world's gift.
                if t.order != GIFT {
                    crate::economy::landed(self, harbour, t.good, t.value(), now);
                }
            }
            landed = true;
        }
        if landed {
            crate::haul::call_lorries(self, events);
        }
        let deck = self.car(ferry).map_or(Vec::new(), |c| c.deck.clone());
        let mut room: Vec<usize> = (0..DECK).rev().filter(|&k| deck.get(k).is_none_or(|s| s.is_none())).collect();
        let pad = self.building(harbour).map_or(Vec::new(), |b| b.pad.clone());
        let mut on: Vec<(usize, Package)> = pad.iter().enumerate().filter(|(_, t)| t.outbound).map(|(i, &t)| (i, t)).collect();
        on.truncate(room.len());
        let mut gone: Vec<usize> = Vec::new();
        for run in runs(&on) {
            let good = run[0].1.good;
            // Only what is done before it sails: a run that is not, cut short.
            let ends = self.lift(harbour, ferry, good, run.len() as u32, true, now);
            let late = (ends.saturating_sub(due)).div_ceil(crate::world::HANDLE_MS) as usize;
            let n = run.len().saturating_sub(late);
            if late > 0
                && let Some(l) = self.building_mut(harbour).and_then(|b| b.lifts.last_mut())
            {
                l.n = n as u32;
            }
            for &(i, t) in &run[..n] {
                let k = room.remove(0);
                if let Some(c) = self.car_mut(ferry) {
                    c.deck[k] = Some(t);
                }
                gone.push(i);
            }
        }
        if let Some(b) = self.building_mut(harbour) {
            gone.sort_unstable();
            for &i in gone.iter().rev() {
                b.pad.remove(i);
            }
            b.lifts.retain(|l| l.n > 0);
        }
    }
}

/// Packages in runs a forklift lifts at once: of one good, a lorry's
/// worth at most, in the order they stand.
fn runs(packages: &[(usize, Package)]) -> Vec<&[(usize, Package)]> {
    let mut out = Vec::new();
    let mut start = 0;
    for i in 1..=packages.len() {
        if i == packages.len() || packages[i].1.good != packages[start].1.good || i - start == crate::haul::LOAD as usize {
            out.push(&packages[start..i]);
            start = i;
        }
    }
    out
}

/// A deck's bays with no pallet in them, from the sea end.
fn empty_bays(deck: &[Option<Package>]) -> Vec<usize> {
    (0..BAYS).rev().filter(|&k| (k * PER_BAY..(k + 1) * PER_BAY).all(|p| deck.get(p).is_none_or(|s| s.is_none()))).collect()
}
