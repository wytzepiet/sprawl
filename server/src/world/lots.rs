//! Where cars stand at a building: its lot.
//!
//! A lot is a piece of road. Its nodes have positions of their own, off the
//! grid, and are joined by edges cars drive like any other, so a trip ends
//! *in* a spot and starts from one, and the client only ever draws trips.
//! Nothing about a lot is streamed: a parked car carries its pose, a moving
//! one its route.
//!
//! Two shapes. A kind with no lot parks two cars on its driveway, nose out,
//! one each lane: a car drives in past the driveway node, turns, and comes
//! out onto its lane. A kind with a lot has a ring: a one-way loop of lane
//! hugging the lot's edge, spots in the island inside it, each driven
//! through from the front lane to the back one. Lot tiles that touch along
//! one frontage are one lot: one ring under every building on the run, an
//! entrance per building, the spots shared. Staff drive the ring to a door
//! under their building and park there unseen. See `docs/parking.md`.

use rand::{Rng, SeedableRng};
use rand::rngs::SmallRng;
use std::collections::HashMap;

use crate::blueprint::{plot, FACINGS};
use crate::engine::GameTime;
use crate::protocol::{EntityId, GameObject, GridCoord, Pose};
use serde_json::{json, Value};
use crate::world::World;
use crate::world::segments::EdgeSegment;

/// A driveway spot: how far out from the plot's centre a car's centre stands,
/// half its length, and half the gap between the two lanes.
const SPOT_OUT: f64 = 0.35;
const LANE: f64 = 0.11;

/// The ring, in tiles: how far the lane's centre sits in from the lot's
/// edge (the slab's inset plus half a lane), the pitch of the spots across
/// the island, and how far the island's ends stay in from the side lanes.
const RING: f64 = 0.2;
const PITCH: f64 = 0.2;
const ISLAND_END: f64 = 0.3;
/// Where a car in a spot stands and faces: the island's middle, nose to
/// the back; and where a door is, under its building's front.
const SPOT_V: f64 = 0.5;
const DOOR_V: f64 = 1.05;

/// Which lot a building's tiles belong to: its own, or the run of lot tiles
/// it fronts the street with, named by the facing, the row the lot tiles
/// are in, and where along the frontage the run starts.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum RunKey {
    Solo(EntityId),
    Run(u8, i32, i32),
}

pub struct Spot {
    pub node: EntityId,
    pub pose: Pose,
    /// Who holds it and when: a car on its way books from the earliest it
    /// could arrive to when it plans to leave, and a car standing in it
    /// holds it until it goes. Sorted by `from`.
    pub windows: Vec<Window>,
}

#[derive(Clone, Copy, Debug)]
pub struct Window {
    pub car: EntityId,
    pub from: GameTime,
    pub to: GameTime,
}

impl Spot {
    /// The earliest time at or after `from` this spot is clear for `len`,
    /// for `car`: its own booking is no obstacle to itself.
    fn clear_from(&self, car: EntityId, from: GameTime, len: GameTime) -> GameTime {
        let mut t = from;
        for w in &self.windows {
            if w.car != car && w.from < t.saturating_add(len) && w.to > t {
                t = w.to;
            }
        }
        t
    }

    fn holder(&self, car: EntityId) -> Option<&Window> {
        self.windows.iter().find(|w| w.car == car)
    }
}

/// What a lot has seen, for the inspect panel and the debug endpoint.
#[derive(Default, Clone, Copy, Debug)]
pub struct Stats {
    /// Trips that could not start: no spot clear for the visit.
    pub refused: u32,
    /// Arrivals that found their spot still taken and were squeezed to the
    /// door, unseen.
    pub squeezed: u32,
}

/// How much longer a spot is held than the visit is planned to take.
pub const SLACK: GameTime = 10 * 60 * 1000;

/// What a car holds at a lot: a spot, or a building's door.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Claim {
    Spot(usize),
    Door(EntityId),
}

/// A building on a run: where each of its entrances joins the loop and the
/// street node beyond it, and where its door leaves the loop.
struct Member {
    building: EntityId,
    /// (driveway, street, index on the loop), in tile order.
    gates: Vec<(EntityId, EntityId, usize)>,
    door: EntityId,
    door_at: usize,
}

/// The way in and out of a lot, as node sequences the routes are made of.
enum Way {
    /// A driveway pair: in from the driveway node to the spot, out from the
    /// spot straight to the street; the door is the driveway node itself.
    Driveway { driveway: EntityId, street: EntityId },
    /// A ring, as its nodes in the order the flow takes them, cyclic, with
    /// each spot's entry and exit on it.
    Ring { loop_: Vec<EntityId>, gates: Vec<(usize, usize)> },
}

pub struct Lot {
    /// Which buildings this is the lot of, with their driveways, and how
    /// wide the run is: the run is rebuilt when this no longer matches
    /// the map.
    members: Vec<Member>,
    w: f64,
    pub spots: Vec<Spot>,
    way: Way,
    /// Every node and edge this lot owns, for taking it down.
    nodes: Vec<EntityId>,
    edges: Vec<(EntityId, EntityId)>,
    /// Who is parked at whose door.
    doorway: Vec<(EntityId, EntityId)>,
    pub stats: Stats,
}

/// A run of lot tiles along one frontage, as read off the map: the
/// members' tiles, the gaps of one tile between them, and one free tile
/// past each end where the land allows, all one ring.
struct Run {
    key: RunKey,
    w: f64,
    seats: Vec<Seat>,
}

/// A building's place on a run, as read off the map.
struct Seat {
    building: EntityId,
    /// Its driveways and the street each joins, in tile order.
    gates: Vec<(EntityId, EntityId)>,
    /// Its lot tiles along the frontage, from the run's start.
    u0: f64,
    u1: f64,
}

impl World {
    /// The building's lot, built or rebuilt to match the map. `None` where
    /// no road reaches it.
    pub fn lot_mut(&mut self, building: EntityId) -> Option<&mut Lot> {
        let run = self.run_of(building)?;
        let (key, seats) = (run.key, &run.seats);
        let current = self.lots.get(&key).is_some_and(|l| {
            l.w == run.w
                && l.members.len() == seats.len()
                && l.members.iter().zip(seats).all(|(m, s)| {
                    m.building == s.building && m.gates.len() == s.gates.len() && m.gates.iter().zip(&s.gates).all(|(a, b)| (a.0, a.1) == *b)
                })
        });
        if !current {
            // Whatever lots the members had, and this key's, go; everyone
            // who held something in them holds it again in the new one.
            let mut held = Vec::new();
            let mut stats = Stats::default();
            let mut keys: Vec<RunKey> = seats.iter().filter_map(|s| self.lot_of.get(&s.building).copied()).collect();
            keys.push(key);
            keys.dedup();
            for k in keys {
                if let Some(l) = self.lots.get(&k) {
                    stats = l.stats;
                }
                held.extend(self.drop_run(k));
            }
            let mut lot = self.build_lot(&run)?;
            lot.stats = stats;
            self.lots.insert(key, lot);
            for s in seats {
                self.lot_of.insert(s.building, key);
            }
            self.reseat(key, held);
        }
        self.lots.get_mut(&key)
    }

    /// How many can park at a building's lot, shared with whoever it fuses
    /// with: what a visitor's tap there serves at once. `None` without a
    /// lot.
    pub fn spots_at(&self, building: EntityId) -> Option<u32> {
        match self.run_of(building)? {
            Run { key: RunKey::Run(..), w, .. } => Some(spots_across(w) as u32),
            _ => None,
        }
    }

    /// The run this building's lot belongs to, and every building on it in
    /// order along the frontage. A kind with no lot is a run of one.
    fn run_of(&self, building: EntityId) -> Option<Run> {
        // Every driveway with the street it joins; a building with none
        // has no seat on the run.
        let gates_of = |b: EntityId| -> Option<Vec<(EntityId, EntityId)>> {
            let gates: Vec<(EntityId, EntityId)> = self
                .driveways_of(b)
                .into_iter()
                .filter_map(|d| match self.objects.get(d).map(|e| &e.object) {
                    Some(GameObject::RoadNode(n)) => n.outgoing.iter().chain(&n.incoming).copied().find(|&s| s != d).map(|s| (d, s)),
                    _ => None,
                })
                .collect();
            (!gates.is_empty()).then_some(gates)
        };
        let (pos, kind, facing) = self.building_of(building)?;
        let Some(((lx, ly), (gw, gh))) = plot(kind, facing).lot else {
            let gates = gates_of(building)?;
            return Some(Run { key: RunKey::Solo(building), w: 0.0, seats: vec![Seat { building, gates, u0: 0.0, u1: 0.0 }] });
        };
        let lot = GridCoord { x: pos.x + lx as i32, y: pos.y + ly as i32 };
        // The lot's extent along the frontage is its grid width or its grid
        // height, by which way it faces.
        let along_x = FACINGS[facing as usize % 4].0 == 0;
        let lw = if along_x { gw } else { gh };
        let (line, a0, a1) = if along_x { (lot.y, lot.x, lot.x + lw as i32) } else { (lot.x, lot.y, lot.y + lw as i32) };
        let (start, end, mut chain) = self.frontage(facing, line, a0, a1);
        let here = chain.iter().position(|n| n.1 > a0).unwrap_or(chain.len());
        chain.insert(here, (building, a0, a1));
        // The entrances are the run's, not a building's: one driveway serves
        // everyone on it, and a run no road reaches has no lot yet.
        let seats: Vec<Seat> = chain
            .into_iter()
            .map(|(b, s, e)| Seat { building: b, gates: gates_of(b).unwrap_or_default(), u0: (s - start) as f64, u1: (e - start) as f64 })
            .collect();
        if seats.iter().all(|s| s.gates.is_empty()) {
            return None;
        }
        Some(Run { key: RunKey::Run(facing, line, start), w: (end - start) as f64, seats })
    }

    /// The street node a run's entrance joins, for a building whose lot is
    /// served by a neighbour's driveway rather than its own.
    pub(super) fn run_gate(&self, building: EntityId) -> Option<EntityId> {
        let run = self.run_of(building)?;
        run.seats.iter().flat_map(|s| &s.gates).next().map(|&(driveway, _)| driveway)
    }

    /// The run a lot on this row, over `[a0, a1)` along the frontage,
    /// would be part of: its extent, and the other buildings on it in
    /// order.
    /// Neighbours' lot tiles join it, so does a neighbour across a gap of
    /// one free tile, and one free tile past each end is the run's too:
    /// a lot is bigger than its building while the land beside it is
    /// free.
    pub(super) fn frontage(&self, facing: u8, line: i32, a0: i32, a1: i32) -> (i32, i32, Vec<(EntityId, i32, i32)>) {
        let along_x = FACINGS[facing as usize % 4].0 == 0;
        let tile = |a: i32| if along_x { GridCoord { x: a, y: line } } else { GridCoord { x: line, y: a } };
        // A neighbour's lot tile at along-coordinate `a` on this row, same
        // facing: the building and its tile range.
        let lot_tile = |a: i32| -> Option<(EntityId, i32, i32)> {
            let t = tile(a);
            let &b = self.occupied.get(&(t.x, t.y))?;
            let (p, k, f) = self.building_of(b)?;
            if f != facing {
                return None;
            }
            let ((ox, oy), (w, h)) = plot(k, f).lot?;
            let l = GridCoord { x: p.x + ox as i32, y: p.y + oy as i32 };
            let (row, s, e) = if along_x { (l.y, l.x, l.x + w as i32) } else { (l.x, l.y, l.y + h as i32) };
            (row == line && a >= s && a < e).then_some((b, s, e))
        };
        let free = |a: i32| self.is_open_frontage(tile(a), facing);
        let mut chain: Vec<(EntityId, i32, i32)> = Vec::new();
        let (mut s, mut e) = (a0, a1);
        loop {
            match lot_tile(s - 1).or_else(|| (free(s - 1)).then(|| lot_tile(s - 2)).flatten()) {
                Some(n) => {
                    s = n.1;
                    chain.insert(0, n);
                }
                None => break,
            }
        }
        loop {
            match lot_tile(e).or_else(|| (free(e)).then(|| lot_tile(e + 1)).flatten()) {
                Some(n) => {
                    e = n.2;
                    chain.push(n);
                }
                None => break,
            }
        }
        if free(s - 1) {
            s -= 1;
        }
        if free(e) {
            e += 1;
        }
        (s, e, chain)
    }

    /// Free land on a frontage: buildable, with the street it would front
    /// right in front of it and room for a building behind it. What a lot
    /// spills over, and where the next building on the run can land.
    pub(super) fn is_open_frontage(&self, t: GridCoord, facing: u8) -> bool {
        let (dx, dy) = FACINGS[facing as usize % 4];
        self.is_buildable(t)
            && self.is_buildable(GridCoord { x: t.x - dx, y: t.y - dy })
            && self.road_node_at(GridCoord { x: t.x + dx, y: t.y + dy }).is_some_and(|id| self.is_street(id))
    }

    /// Is this free tile spill of a lot, and which way does that lot face?
    /// The tile beside a lot tile along its frontage, on the same row, is:
    /// it is that lot's ring while it stays free, and only a lot that
    /// would share the ring may build on it.
    pub fn spill_facing(&self, t: GridCoord) -> Option<u8> {
        (0..4u8).find(|&facing| {
            if !self.is_open_frontage(t, facing) {
                return false;
            }
            let along_x = FACINGS[facing as usize % 4].0 == 0;
            [-1, 1].into_iter().any(|d| {
                let n = if along_x { GridCoord { x: t.x + d, y: t.y } } else { GridCoord { x: t.x, y: t.y + d } };
                self.lot_facing_at(n) == Some(facing)
            })
        })
    }

    /// The facing of the lot whose tile this is.
    fn lot_facing_at(&self, t: GridCoord) -> Option<u8> {
        let &b = self.occupied.get(&(t.x, t.y))?;
        let (p, k, f) = self.building_of(b)?;
        let ((ox, oy), (w, h)) = plot(k, f).lot?;
        let (x, y) = (t.x - p.x - ox as i32, t.y - p.y - oy as i32);
        (x >= 0 && y >= 0 && x < w as i32 && y < h as i32).then_some(f)
    }

    fn building_of(&self, id: EntityId) -> Option<(GridCoord, crate::protocol::BuildingKind, u8)> {
        let e = self.objects.get(id)?;
        match e.object {
            GameObject::Building(ref b) => Some((e.position?, b.kind, b.facing)),
            _ => None,
        }
    }

    fn build_lot(&mut self, run: &Run) -> Option<Lot> {
        let (key, seats) = (run.key, run.seats.as_slice());
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut spots = Vec::new();
        let mut node = |world: &mut World, at: [f64; 2]| {
            let id = world.objects.reserve_id();
            world.lot_nodes.insert(id, at);
            nodes.push(id);
            id
        };
        let mut edge = |world: &mut World, a: EntityId, b: EntityId| {
            let (pa, pb) = (world.node_pos(a).unwrap(), world.node_pos(b).unwrap());
            let len = ((pa[0] - pb[0]).powi(2) + (pa[1] - pb[1]).powi(2)).sqrt();
            world.edges.insert((a, b), EdgeSegment::new(len));
            edges.push((a, b));
        };

        let RunKey::Run(facing, line, start) = key else {
            // A driveway pair. Spot 0 is on the lane a car leaves by.
            let seat = &seats[0];
            let (driveway, street) = seat.gates[0];
            let d = self.node_pos(driveway)?;
            let s = self.node_pos(street)?;
            let len = ((s[0] - d[0]).powi(2) + (s[1] - d[1]).powi(2)).sqrt();
            let out = [(s[0] - d[0]) / len, (s[1] - d[1]) / len];
            let heading = out[1].atan2(out[0]);
            for side in [1.0, -1.0] {
                let at = [d[0] + out[0] * SPOT_OUT - out[1] * LANE * side, d[1] + out[1] * SPOT_OUT + out[0] * LANE * side];
                let id = node(self, at);
                edge(self, driveway, id);
                edge(self, id, street);
                spots.push(Spot { node: id, pose: Pose { at, heading }, windows: Vec::new() });
            }
            let members = vec![Member { building: seat.building, gates: vec![(driveway, street, 0)], door: driveway, door_at: 0 }];
            return Some(Lot { members, w: 0.0, spots, way: Way::Driveway { driveway, street }, nodes, edges, doorway: Vec::new(), stats: Stats::default() });
        };

        // The ring, in the run's own frame: u along the frontage from the
        // run's start, v in from the street. One tile deep.
        let w = run.w;
        let grid_at = move |u: f64, v: f64| -> [f64; 2] {
            match facing % 4 {
                2 => [start as f64 + u, (line + 1) as f64 - v],
                0 => [start as f64 + u, line as f64 + v],
                1 => [(line + 1) as f64 - v, start as f64 + u],
                _ => [line as f64 + v, start as f64 + u],
            }
        };
        let grid_u = |p: [f64; 2]| -> f64 {
            let g = grid_at(0.0, 0.0);
            let along = grid_at(1.0, 0.0);
            (p[0] - g[0]) * (along[0] - g[0]) + (p[1] - g[1]) * (along[1] - g[1])
        };
        // The loop turns the way that puts the most front lane ahead of the
        // entrances: a car in at the left end sees every spot before it has
        // gone round once. So the frame's u runs away from the entrances,
        // which is a mirror of the grid's when they sit in the right half.
        let mut gate_us: Vec<(usize, usize, f64)> = Vec::new();
        for (m, seat) in seats.iter().enumerate() {
            for (g, &(driveway, _)) in seat.gates.iter().enumerate() {
                gate_us.push((m, g, grid_u(self.node_pos(driveway)?)));
            }
        }
        let mean = gate_us.iter().map(|g| g.2).sum::<f64>() / gate_us.len().max(1) as f64;
        let mirrored = mean > w / 2.0;
        let flip = move |u: f64| if mirrored { w - u } else { u };
        let world_at = move |u: f64, v: f64| grid_at(flip(u), v);
        let back = world_at(0.0, 1.0);
        let front = world_at(0.0, 0.0);
        let heading = (back[1] - front[1]).atan2(back[0] - front[0]);
        let n = spots_across(w);
        let first = ISLAND_END + ((w - 2.0 * ISLAND_END) - n as f64 * PITCH) / 2.0 + PITCH / 2.0;
        let us: Vec<f64> = (0..n).map(|i| first + i as f64 * PITCH).collect();

        // Stations along each lane: a spot's entry or exit, a member's gate
        // or door, in the order the flow passes them.
        enum Station {
            Spot(usize),
            Gate(usize, usize),
            Door(usize),
        }
        let mut front_stations: Vec<(f64, Station)> = us.iter().enumerate().map(|(i, &u)| (u, Station::Spot(i))).collect();
        let mut back_stations: Vec<(f64, Station)> = us.iter().enumerate().map(|(i, &u)| (u, Station::Spot(i))).collect();
        for &(m, g, u) in &gate_us {
            front_stations.push((flip(u), Station::Gate(m, g)));
        }
        for (m, seat) in seats.iter().enumerate() {
            back_stations.push((flip((seat.u0 + seat.u1) / 2.0), Station::Door(m)));
        }
        front_stations.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        back_stations.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());

        let mut loop_ = Vec::new();
        let mut gates = vec![(0usize, 0usize); n];
        let mut member_gates: Vec<Vec<usize>> = seats.iter().map(|s| vec![0; s.gates.len()]).collect();
        let mut member_door_at = vec![0usize; seats.len()];
        loop_.push(node(self, world_at(RING, RING)));
        for (u, station) in &front_stations {
            let id = node(self, world_at(*u, RING));
            match station {
                Station::Spot(i) => gates[*i].0 = loop_.len(),
                Station::Gate(m, g) => member_gates[*m][*g] = loop_.len(),
                Station::Door(_) => unreachable!(),
            }
            loop_.push(id);
        }
        loop_.push(node(self, world_at(w - RING, RING)));
        loop_.push(node(self, world_at(w - RING, 1.0 - RING)));
        for (u, station) in &back_stations {
            let id = node(self, world_at(*u, 1.0 - RING));
            match station {
                Station::Spot(i) => gates[*i].1 = loop_.len(),
                Station::Door(m) => member_door_at[*m] = loop_.len(),
                Station::Gate(..) => unreachable!(),
            }
            loop_.push(id);
        }
        loop_.push(node(self, world_at(RING, 1.0 - RING)));
        for i in 0..loop_.len() {
            edge(self, loop_[i], loop_[(i + 1) % loop_.len()]);
        }
        for (i, &u) in us.iter().enumerate() {
            let at = world_at(u, SPOT_V);
            let id = node(self, at);
            edge(self, loop_[gates[i].0], id);
            edge(self, id, loop_[gates[i].1]);
            spots.push(Spot { node: id, pose: Pose { at, heading }, windows: Vec::new() });
        }
        let mut members = Vec::new();
        for (m, seat) in seats.iter().enumerate() {
            let mut mgates = Vec::new();
            for (g, &(driveway, street)) in seat.gates.iter().enumerate() {
                let gate = member_gates[m][g];
                edge(self, street, loop_[gate]);
                edge(self, loop_[gate], street);
                mgates.push((driveway, street, gate));
            }
            let door_at = member_door_at[m];
            let door = node(self, world_at((seat.u0 + seat.u1) / 2.0, DOOR_V));
            edge(self, loop_[door_at], door);
            edge(self, door, loop_[door_at]);
            members.push(Member { building: seat.building, gates: mgates, door, door_at });
        }
        Some(Lot { members, w, spots, way: Way::Ring { loop_, gates }, nodes, edges, doorway: Vec::new(), stats: Stats::default() })
    }

    /// Take a building's lot out of the world, edges and all. Its
    /// neighbours on the run get theirs back at once, rebuilt without it,
    /// and whoever was parked on the run is reseated in one of those.
    pub fn drop_lot(&mut self, building: EntityId) {
        let Some(key) = self.lot_of.get(&building).copied() else { return };
        let others: Vec<EntityId> = self.lots[&key].members.iter().map(|m| m.building).filter(|&b| b != building).collect();
        let held = self.drop_run(key);
        let mut keys = Vec::new();
        for b in others {
            if self.lot_mut(b).is_some() && !keys.contains(&self.lot_of[&b]) {
                keys.push(self.lot_of[&b]);
            }
        }
        for (car, claim, from, to) in held {
            let (was, parked) = match self.objects.get(car).map(|e| &e.object) {
                Some(GameObject::Car(c)) => (c.spot, c.trip.is_none()),
                _ => continue,
            };
            let place = match claim {
                Claim::Door(b) => keys.iter().find(|k| self.lots[k].members.iter().any(|m| m.building == b)).map(|&k| (k, Claim::Door(b))),
                Claim::Spot(_) => keys
                    .iter()
                    .filter_map(|&k| self.nearest_free(k, car, was, from, to).map(|c| (k, c)))
                    .min_by(|(ka, ca), (kb, cb)| {
                        let d = |k: &RunKey, c: &Claim| self.pose_of(*k, *c).map_or(f64::MAX, |p| dist(p, was));
                        d(ka, ca).total_cmp(&d(kb, cb))
                    }),
            };
            match place {
                Some((k, claim)) => {
                    self.hold(k, car, claim, from, to);
                    if parked {
                        let pose = self.pose_of(k, claim);
                        self.set_spot(car, pose);
                    }
                }
                None => self.set_spot(car, None),
            }
        }
    }

    /// Take a run down, and say who held what in it, and when.
    fn drop_run(&mut self, key: RunKey) -> Vec<(EntityId, Claim, GameTime, GameTime)> {
        let Some(lot) = self.lots.remove(&key) else { return Vec::new() };
        for m in &lot.members {
            self.lot_of.remove(&m.building);
        }
        for id in &lot.nodes {
            self.lot_nodes.remove(id);
        }
        for e in &lot.edges {
            self.edges.remove(e);
        }
        let mut held = Vec::new();
        for (i, spot) in lot.spots.iter().enumerate() {
            for w in &spot.windows {
                self.claims.remove(&w.car);
                held.push((w.car, Claim::Spot(i), w.from, w.to));
            }
        }
        for &(car, building) in &lot.doorway {
            self.claims.remove(&car);
            held.push((car, Claim::Door(building), 0, GameTime::MAX));
        }
        held
    }

    /// After a lot is rebuilt: everyone who held something holds it again,
    /// the nearest spot free to where they stood, and parked cars are drawn
    /// where they now stand.
    fn reseat(&mut self, key: RunKey, held: Vec<(EntityId, Claim, GameTime, GameTime)>) {
        for (car, claim, from, to) in held {
            let (was, parked) = match self.objects.get(car).map(|e| &e.object) {
                Some(GameObject::Car(c)) => (c.spot, c.trip.is_none()),
                _ => continue,
            };
            let claim = match claim {
                Claim::Door(b) if self.lots[&key].members.iter().any(|m| m.building == b) => Some(Claim::Door(b)),
                Claim::Door(_) => None,
                Claim::Spot(_) => self.nearest_free(key, car, was, from, to),
            };
            let Some(claim) = claim else {
                self.set_spot(car, None);
                continue;
            };
            self.hold(key, car, claim, from, to);
            if parked {
                let pose = self.pose_of(key, claim);
                self.set_spot(car, pose);
            }
        }
    }

    /// The spot nearest a pose that is clear over a window.
    fn nearest_free(&self, key: RunKey, car: EntityId, near: Option<Pose>, from: GameTime, to: GameTime) -> Option<Claim> {
        self.lots[&key]
            .spots
            .iter()
            .enumerate()
            .filter(|(_, s)| s.clear_from(car, from, to.saturating_sub(from)) == from)
            .min_by(|(_, a), (_, b)| dist(a.pose, near).total_cmp(&dist(b.pose, near)))
            .map(|(i, _)| Claim::Spot(i))
    }

    fn hold(&mut self, key: RunKey, car: EntityId, claim: Claim, from: GameTime, to: GameTime) {
        let lot = self.lots.get_mut(&key).unwrap();
        match claim {
            Claim::Spot(i) => {
                let ws = &mut lot.spots[i].windows;
                let at = ws.partition_point(|w| w.from <= from);
                ws.insert(at, Window { car, from, to });
            }
            Claim::Door(b) => lot.doorway.push((car, b)),
        }
        self.claims.insert(car, key);
    }

    /// A visit running long, or cut short: the car's window ends when its
    /// owner now plans to leave.
    pub fn restate(&mut self, car: EntityId, to: GameTime) {
        if let Some(&key) = self.claims.get(&car)
            && let Some(lot) = self.lots.get_mut(&key)
        {
            for s in &mut lot.spots {
                for w in &mut s.windows {
                    if w.car == car {
                        w.to = to;
                    }
                }
            }
        }
    }

    /// The earliest a visit by `car` to this building from `from` to `to`
    /// could have a spot, at or after `from`. `None` where the building
    /// has no lot, or one not built yet: nothing to wait for.
    pub fn spot_window(&self, building: EntityId, car: EntityId, from: GameTime, to: GameTime) -> Option<GameTime> {
        let lot = self.lots.get(self.lot_of.get(&building)?)?;
        if lot.spots.is_empty() {
            return None;
        }
        let len = to.saturating_sub(from);
        lot.spots.iter().map(|s| s.clear_from(car, from, len)).min()
    }

    fn pose_of(&self, key: RunKey, claim: Claim) -> Option<Pose> {
        match claim {
            Claim::Spot(i) => self.lots.get(&key).map(|l| l.spots[i].pose),
            Claim::Door(_) => None,
        }
    }

    fn claim_of(&self, key: RunKey, car: EntityId) -> Option<Claim> {
        let lot = self.lots.get(&key)?;
        if let Some(&(_, b)) = lot.doorway.iter().find(|&&(c, _)| c == car) {
            return Some(Claim::Door(b));
        }
        lot.spots.iter().position(|s| s.holder(car).is_some()).map(Claim::Spot)
    }

    /// Where a route node is: a road node's tile centre, or a lot node's own
    /// position.
    pub fn node_pos(&self, id: EntityId) -> Option<[f64; 2]> {
        if let Some(&p) = self.lot_nodes.get(&id) {
            return Some(p);
        }
        self.objects.get(id)?.position.map(|p| [p.x as f64 + 0.5, p.y as f64 + 0.5])
    }

    /// Hold a place at a building for a car over a window: the one it
    /// already holds, the door if the car's owner works there or it is a
    /// facility's vehicle, else a spot clear for the whole window, near the
    /// building's door with some looseness, as people park. `None` when
    /// there is none, and the trip does not start: the car waits where it
    /// is, honestly, and tries again.
    pub fn claim_spot(&mut self, building: EntityId, car: EntityId, from: GameTime, to: GameTime) -> Option<Claim> {
        let staff = self.works_at(car, building);
        self.lot_mut(building)?;
        let key = self.lot_of[&building];
        let lot = &self.lots[&key];
        let len = to.saturating_sub(from);
        // The spot in front of the door is the one wanted, but not by
        // everyone: each free spot's distance to the door is stretched by
        // up to two or three spots' worth, drawn per visit, so the cars of
        // one building bunch in front of it without filling it in order.
        let door = lot.members.iter().find(|m| m.building == building).and_then(|m| self.lot_nodes.get(&m.door)).copied();
        let mut rng = SmallRng::seed_from_u64(self.terrain_seed as u64 ^ car.rotate_left(32) ^ from);
        let mut appeal = |i: usize| -> f64 {
            let at = lot.spots[i].pose.at;
            let d = door.map_or(0.0, |[x, y]| ((at[0] - x).powi(2) + (at[1] - y).powi(2)).sqrt());
            d + rng.random::<f64>() * 2.5 * PITCH
        };
        let claim = lot
            .spots
            .iter()
            .position(|s| s.holder(car).is_some())
            .map(Claim::Spot)
            .or_else(|| lot.doorway.iter().find(|&&(c, b)| c == car && b == building).map(|&(_, b)| Claim::Door(b)))
            .or_else(|| staff.then_some(Claim::Door(building)))
            .or_else(|| {
                (0..lot.spots.len())
                    .filter(|&i| lot.spots[i].clear_from(car, from, len) == from)
                    .map(|i| (i, appeal(i)))
                    .min_by(|a, b| a.1.total_cmp(&b.1))
                    .map(|(i, _)| Claim::Spot(i))
            });
        let Some(claim) = claim else {
            self.lots.get_mut(&key).unwrap().stats.refused += 1;
            return None;
        };
        // Only now, with the new place found, is the old one let go of.
        if self.claim_of(key, car) != Some(claim) {
            self.release_spot(car);
            self.hold(key, car, claim, from, to);
        }
        Some(claim)
    }

    /// Does the car's owner work at the building? Staff park unseen, and so
    /// do a facility's own vehicles and vehicles on a call.
    fn works_at(&self, car: EntityId, building: EntityId) -> bool {
        let owner = match self.objects.get(car).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.owner,
            _ => return false,
        };
        match self.objects.get(owner).map(|e| &e.object) {
            Some(GameObject::Resident(r)) => r.work == Some(building),
            Some(GameObject::Building(_)) => true,
            _ => false,
        }
    }

    /// Let go of whatever the car holds.
    pub fn release_spot(&mut self, car: EntityId) {
        if let Some(key) = self.claims.remove(&car)
            && let Some(lot) = self.lots.get_mut(&key)
        {
            for s in &mut lot.spots {
                s.windows.retain(|w| w.car != car);
            }
            lot.doorway.retain(|&(c, _)| c != car);
        }
        self.set_spot(car, None);
    }

    /// Stand the car in its place at the building. It usually holds one
    /// from setting out; if not it takes one now, open-ended. A spot still
    /// taken on arrival, by a car that stayed longer than it planned, is
    /// swapped for any free one, or the car is squeezed to the door.
    pub fn park_in_lot(&mut self, building: EntityId, car: EntityId, now: GameTime) {
        let Some(claim) = self.claim_spot(building, car, now, GameTime::MAX) else {
            self.set_spot(car, None);
            return;
        };
        let key = self.lot_of[&building];
        if let Claim::Spot(i) = claim {
            let taken = self.lots[&key].spots[i].windows.iter().any(|w| w.car != car && self.parked_here(w.car));
            if taken {
                let to = self.lots[&key].spots[i].holder(car).map_or(GameTime::MAX, |w| w.to);
                self.release_spot(car);
                let lot = self.lots.get_mut(&key).unwrap();
                let free = (0..lot.spots.len()).find(|&j| lot.spots[j].clear_from(car, now, to.saturating_sub(now)) == now);
                match free {
                    Some(j) => self.hold(key, car, Claim::Spot(j), now, to),
                    None => {
                        lot.stats.squeezed += 1;
                        self.hold(key, car, Claim::Door(building), now, to);
                    }
                }
            }
        }
        let claim = self.claim_of(key, car).unwrap();
        let pose = self.pose_of(key, claim);
        self.set_spot(car, pose);
    }

    fn parked_here(&self, car: EntityId) -> bool {
        matches!(self.objects.get(car).map(|e| &e.object), Some(GameObject::Car(c)) if c.trip.is_none())
    }

    /// The lot a building is on, as the debug endpoint shows it.
    pub fn inspect_lot(&mut self, building: EntityId, now: GameTime) -> Value {
        let Some(lot) = self.lot_mut(building) else { return json!({ "lot": null }) };
        let hhmm = |t: GameTime| {
            if t == GameTime::MAX {
                "open".to_string()
            } else {
                let day = crate::protocol::DAY_MS as u64;
                format!("d{} {:02}:{:02}", t / day, (t % day) / (day / 24), (t % (day / 24)) / (day / 24 / 60))
            }
        };
        let spots: Vec<Value> = lot
            .spots
            .iter()
            .map(|s| json!({
                "at": s.pose.at,
                "windows": s.windows.iter().map(|w| json!({ "car": w.car, "from": hhmm(w.from), "to": hhmm(w.to) })).collect::<Vec<_>>(),
            }))
            .collect();
        let members: Vec<Value> = lot.members.iter().map(|m| json!({ "building": m.building, "entrances": m.gates.len() })).collect();
        let parked = lot.spots.iter().filter(|s| s.windows.iter().any(|w| w.from <= now && now < w.to)).count();
        json!({
            "now": hhmm(now),
            "members": members,
            "spots": spots.len(),
            "held_now": parked,
            "at_doors": lot.doorway.len(),
            "refused": lot.stats.refused,
            "squeezed": lot.stats.squeezed,
            "spot_windows": spots,
        })
    }


    /// The way from where the car stands to the street: its lot nodes in
    /// order, and the street node last. Off a ring, out by the nearest
    /// entrance ahead.
    pub fn way_out(&self, car: EntityId) -> Option<Vec<EntityId>> {
        let key = *self.claims.get(&car)?;
        let lot = self.lots.get(&key)?;
        let claim = self.claim_of(key, car)?;
        Some(match (&lot.way, claim) {
            (Way::Driveway { street, .. }, Claim::Spot(i)) => vec![lot.spots[i].node, *street],
            (Way::Driveway { driveway, street }, Claim::Door(_)) => vec![*driveway, *street],
            (Way::Ring { loop_, gates }, claim) => {
                let (first, from) = match claim {
                    Claim::Spot(i) => (lot.spots[i].node, gates[i].1),
                    Claim::Door(b) => {
                        let m = lot.members.iter().find(|m| m.building == b)?;
                        (m.door, m.door_at)
                    }
                };
                let n = loop_.len();
                let &(_, street, gate) = lot.members.iter().flat_map(|m| &m.gates).min_by_key(|g| (g.2 + n - from) % n)?;
                let mut v = vec![first];
                v.extend(cyclic(loop_, from, gate));
                v.push(street);
                v
            }
        })
    }

    /// The way into a place at the building for this car, claiming one: the
    /// node the street route ends at, then the lot nodes to the place. `None`
    /// when there is no place, and the trip does not start.
    pub fn way_in(&mut self, building: EntityId, car: EntityId, from: GameTime, to: GameTime) -> Option<Vec<EntityId>> {
        let claim = self.claim_spot(building, car, from, to)?;
        let key = *self.claims.get(&car)?;
        let lot = self.lots.get(&key)?;
        let m = lot.members.iter().find(|m| m.building == building)?;
        Some(match (&lot.way, claim) {
            (Way::Driveway { driveway, .. }, Claim::Spot(i)) => vec![*driveway, lot.spots[i].node],
            (Way::Driveway { driveway, .. }, Claim::Door(_)) => vec![*driveway],
            (Way::Ring { loop_, gates }, claim) => {
                let (to, last) = match claim {
                    Claim::Spot(i) => (gates[i].0, lot.spots[i].node),
                    Claim::Door(_) => (m.door_at, m.door),
                };
                let (_, street, gate) = entrance(lot, m);
                let mut v = vec![street];
                v.extend(cyclic(loop_, gate, to));
                v.push(last);
                v
            }
        })
    }

    /// The node a street route to this building ends at: its driveway, or
    /// for a ring the street node its entrance joins.
    pub fn approach(&mut self, building: EntityId) -> Option<EntityId> {
        let lot = self.lot_mut(building)?;
        Some(match lot.way {
            Way::Driveway { driveway, .. } => driveway,
            Way::Ring { .. } => entrance(lot, lot.members.iter().find(|m| m.building == building)?).1,
        })
    }

    fn set_spot(&mut self, car: EntityId, pose: Option<Pose>) {
        if let Some(entry) = self.objects.get_mut(car)
            && let GameObject::Car(ref mut c) = entry.object
        {
            c.spot = pose;
        }
    }

    /// After a load: every parked car with a pose stands in the spot it was
    /// saved in, or, if the lot has moved, the nearest one free; one without
    /// a pose at a building with a ring is at its door.
    pub fn restore_spots(&mut self) {
        let parked: Vec<(EntityId, Option<Pose>, GridCoord)> = self
            .objects
            .iter()
            .filter_map(|e| match e.object {
                GameObject::Car(ref c) if c.trip.is_none() => Some((e.id, c.spot, e.position?)),
                _ => None,
            })
            .collect();
        for (car, pose, tile) in parked {
            let Some(&building) = self.occupied.get(&(tile.x, tile.y)) else {
                self.set_spot(car, None);
                continue;
            };
            if self.lot_mut(building).is_none() {
                self.set_spot(car, None);
                continue;
            }
            let key = self.lot_of[&building];
            let claim = match pose {
                Some(_) => self.nearest_free(key, car, pose, 0, GameTime::MAX),
                None => matches!(self.lots[&key].way, Way::Ring { .. }).then_some(Claim::Door(building)),
            };
            match claim {
                Some(claim) => {
                    self.hold(key, car, claim, 0, GameTime::MAX);
                    let pose = self.pose_of(key, claim);
                    self.set_spot(car, pose);
                }
                None => self.set_spot(car, None),
            }
        }
    }
}

/// How many spots fit across the island of a ring w tiles wide.
fn spots_across(w: f64) -> usize {
    ((w - 2.0 * ISLAND_END) / PITCH + 1e-9).floor().max(0.0) as usize
}

/// The nodes of a loop from index `from` to index `to` inclusive, going
/// round the flow's way.
fn cyclic(loop_: &[EntityId], from: usize, to: usize) -> Vec<EntityId> {
    let n = loop_.len();
    let mut out = Vec::new();
    let mut i = from;
    loop {
        out.push(loop_[i]);
        if i == to {
            break;
        }
        i = (i + 1) % n;
    }
    out
}

/// The entrance a building's visitors come in by: of the run's gates, the
/// one with the shortest drive round to its door.
fn entrance(lot: &Lot, m: &Member) -> (EntityId, EntityId, usize) {
    let n = match &lot.way {
        Way::Ring { loop_, .. } => loop_.len(),
        Way::Driveway { .. } => 1,
    };
    *lot.members.iter().flat_map(|o| &o.gates).min_by_key(|g| (m.door_at + n - g.2) % n).unwrap()
}

fn dist(a: Pose, b: Option<Pose>) -> f64 {
    match b {
        Some(b) => (a.at[0] - b.at[0]).powi(2) + (a.at[1] - b.at[1]).powi(2),
        None => f64::MAX,
    }
}

pub type Lots = HashMap<RunKey, Lot>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{BuildingKind, TerrainType};

    /// Open land with one street along y = 0.
    fn street() -> World {
        let mut world = World::new();
        for y in -4..8 {
            for x in -4..40 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        let path: Vec<GridCoord> = (-4..40).map(|x| GridCoord { x, y: 0 }).collect();
        world.place_road_path(&path);
        world
    }

    /// Two shops side by side share one lot, four tiles with the spill,
    /// seventeen spots and an entrance each; apart, a shop has three
    /// tiles and twelve.
    #[test]
    fn touching_lots_fuse_into_one_run() {
        let mut world = street();
        let a = world.spawn_building(GridCoord { x: 2, y: 1 }, BuildingKind::Shop).unwrap();
        let b = world.spawn_building(GridCoord { x: 3, y: 1 }, BuildingKind::Shop).unwrap();
        let apart = world.spawn_building(GridCoord { x: 10, y: 1 }, BuildingKind::Shop).unwrap();
        assert_eq!(world.lot_mut(a).unwrap().spots.len(), 17, "a pair parks seventeen");
        assert_eq!(world.lot_of[&a], world.lot_of[&b], "one lot between them");
        assert_eq!(world.lot_mut(apart).unwrap().spots.len(), 12, "alone parks twelve");
        let lot = &world.lots[&world.lot_of[&a]];
        assert_eq!(lot.members.len(), 2);
        assert_eq!(lot.members.iter().map(|m| m.gates.len()).sum::<usize>(), 1, "one entrance serves the run");
        assert_eq!(world.road_node_for_building(b), world.road_node_for_building(a), "b is reached by a's driveway");
        world.remove_building(a);
        assert!(world.road_node_for_building(b).is_some(), "b gets an entrance of its own when a goes");
    }

    /// The loop turns to suit the entrance: in at the right end of a lot,
    /// a spot by the door is a few nodes on, not a lap away.
    #[test]
    fn the_loop_turns_toward_the_entrance() {
        let mut world = street();
        // A two-wide lot whose street lies to its right (x = 10), so the
        // driveway lands on its right-hand tile.
        let path: Vec<GridCoord> = (1..8).map(|y| GridCoord { x: 10, y }).collect();
        world.place_road_path(&path);
        let a = world.spawn_building(GridCoord { x: 8, y: 2 }, BuildingKind::Apartment).unwrap();
        let car = world.insert_at(GameObject::Car(crate::protocol::Car { owner: 0, trip: None, role: Default::default(), spot: None }), None);
        let way = world.way_in(a, car, 0, GameTime::MAX).unwrap();
        let lot = &world.lots[&world.lot_of[&a]];
        let d = world.node_pos(lot.members[0].door).unwrap();
        let spot = world.node_pos(*way.last().unwrap()).unwrap();
        assert!((d[0] - spot[0]).abs() + (d[1] - spot[1]).abs() < 1.0, "the spot taken is by the door: {d:?} vs {spot:?}");
        assert!(way.len() <= 8, "a few nodes in, not a lap: {}", way.len());
    }

    /// A lot spills one free tile past each end, and that spill is a
    /// lot's alone: a house may not land on it, a shop may and shares the
    /// ring, and a shop hemmed in to one tile may not land at all.
    #[test]
    fn a_lot_spills_over_free_frontage_and_keeps_it() {
        let mut world = street();
        let a = world.spawn_building(GridCoord { x: 4, y: 1 }, BuildingKind::Shop).unwrap();
        assert_eq!(world.lot_mut(a).unwrap().w, 3.0, "one tile of its own and one each side");
        assert!(world.site_for(GridCoord { x: 3, y: 1 }, BuildingKind::House).is_none(), "the spill is not a house's");
        assert!(world.site_for(GridCoord { x: 2, y: 1 }, BuildingKind::House).is_some(), "past the spill it is");
        assert!(world.site_for(GridCoord { x: 3, y: 1 }, BuildingKind::Shop).is_some(), "a shop shares the ring");
        // Across a gap of one free tile, two lots are one ring.
        let b = world.spawn_building(GridCoord { x: 6, y: 1 }, BuildingKind::Shop).unwrap();
        world.lot_mut(b).unwrap();
        assert_eq!(world.lot_of[&a], world.lot_of[&b], "one lot across the gap");
        assert_eq!(world.lots[&world.lot_of[&a]].w, 5.0);
        // Roads either side of a would-be shop leave it one tile: no.
        world.place_road_path(&[GridCoord { x: 20, y: 0 }, GridCoord { x: 20, y: 1 }]);
        world.place_road_path(&[GridCoord { x: 22, y: 0 }, GridCoord { x: 22, y: 1 }]);
        assert!(world.site_for(GridCoord { x: 21, y: 1 }, BuildingKind::Shop).is_none(), "a ring is never one tile wide");
    }

    /// A road drawn into a lot tile is one more entrance, not the old one
    /// moved, and a car leaves by whichever is nearer.
    #[test]
    fn a_lot_takes_more_than_one_driveway() {
        let mut world = street();
        let a = world.spawn_building(GridCoord { x: 2, y: 1 }, BuildingKind::Apartment).unwrap();
        assert_eq!(world.driveways_of(a).len(), 1);
        // The driveway landed on (2, 1); a second road drawn into (3, 1).
        world.handle_place_road(GridCoord { x: 3, y: 0 }, GridCoord { x: 3, y: 1 }, false, false, 0);
        assert_eq!(world.driveways_of(a).len(), 2, "both driveways stand");
        let lot = world.lot_mut(a).unwrap();
        assert_eq!(lot.members[0].gates.len(), 2);
    }

    /// A spot booked for a visit is clear again after it, so the next
    /// visit is told to come then, not refused.
    #[test]
    fn a_full_lot_says_when_it_frees() {
        let mut world = street();
        let shop = world.spawn_building(GridCoord { x: 2, y: 1 }, BuildingKind::Shop).unwrap();
        // Roads on either side take the spill away: a ring of one tile, two spots.
        world.place_road_path(&[GridCoord { x: 1, y: 0 }, GridCoord { x: 1, y: 1 }]);
        world.place_road_path(&[GridCoord { x: 3, y: 0 }, GridCoord { x: 3, y: 1 }]);
        assert_eq!(world.lot_mut(shop).unwrap().spots.len(), 2);
        let car = |world: &mut World| world.insert_at(GameObject::Car(crate::protocol::Car { owner: 0, trip: None, role: Default::default(), spot: None }), None);
        let (a, b, c) = (car(&mut world), car(&mut world), car(&mut world));
        // Two spots: two visits from 10 to 12 fill it.
        assert!(world.claim_spot(shop, a, 10_000, 12_000).is_some());
        assert!(world.claim_spot(shop, b, 10_000, 12_000).is_some());
        assert_eq!(world.spot_window(shop, c, 10_000, 11_000), Some(12_000), "a third visit is told to come at twelve");
        assert_eq!(world.spot_window(shop, c, 13_000, 14_000), Some(13_000), "and a later one is fine as planned");
        assert_eq!(world.spot_window(shop, a, 10_000, 11_000), Some(10_000), "a's own booking is no obstacle to a");
        assert!(world.claim_spot(shop, c, 10_000, 11_000).is_none(), "nothing is clear for it now");
        assert_eq!(world.lots[&world.lot_of[&shop]].stats.refused, 1);
        assert!(world.claim_spot(shop, c, 12_000, 13_000).is_some(), "at twelve it has a spot");
        // A visit running long moves everyone after it.
        world.restate(a, 15_000);
        world.release_spot(c);
        assert_eq!(world.spot_window(shop, c, 12_000, 13_000), Some(12_000), "b's spot is still clear at twelve");
        world.release_spot(b);
        assert_eq!(world.spot_window(shop, c, 12_000, 13_000), Some(12_000));
    }

    /// A lot facing east or west runs along y, and its run is read that
    /// way: the walk along it ends, and it parks as many as a lot along x.
    #[test]
    fn a_lot_along_y_is_read_along_y() {
        let mut world = street();
        let path: Vec<GridCoord> = (1..8).map(|y| GridCoord { x: 10, y }).collect();
        world.place_road_path(&path);
        let lot = world.spawn_building(GridCoord { x: 8, y: 2 }, BuildingKind::Lot).unwrap();
        assert_eq!(world.lot_mut(lot).unwrap().spots.len(), 22, "three tiles and the spill");
    }

    /// A shop arriving beside one already parked in keeps the parked car in
    /// a spot of the new, bigger lot; a shop leaving shrinks it back.
    #[test]
    fn a_run_grows_and_shrinks_around_its_cars() {
        let mut world = street();
        let a = world.spawn_building(GridCoord { x: 2, y: 1 }, BuildingKind::Shop).unwrap();
        let car = world.insert_at(GameObject::Car(crate::protocol::Car { owner: a, trip: None, role: Default::default(), spot: None }), Some(GridCoord { x: 2, y: 1 }));
        // Not staff: a visitor's car, so it takes a spot.
        world.objects.get_mut(car).map(|e| if let GameObject::Car(ref mut c) = e.object { c.owner = 0 });
        world.park_in_lot(a, car, 0);
        assert!(matches!(world.objects.get(car).map(|e| &e.object), Some(GameObject::Car(c)) if c.spot.is_some()));
        let b = world.spawn_building(GridCoord { x: 3, y: 1 }, BuildingKind::Shop).unwrap();
        assert_eq!(world.lot_mut(b).unwrap().spots.len(), 17);
        assert_eq!(world.claims.get(&car), Some(&world.lot_of[&a]), "the car holds a spot in the run");
        assert!(matches!(world.objects.get(car).map(|e| &e.object), Some(GameObject::Car(c)) if c.spot.is_some()));
        world.remove_building(b);
        assert_eq!(world.lot_mut(a).unwrap().spots.len(), 12);
        assert_eq!(world.claims.get(&car), Some(&world.lot_of[&a]));
    }
}
