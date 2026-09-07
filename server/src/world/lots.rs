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

use std::collections::HashMap;

use crate::blueprint::{plot, FACINGS};
use crate::protocol::{EntityId, GameObject, GridCoord, Pose};
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
    /// Who holds it: standing in it, or on the way.
    pub car: Option<EntityId>,
}

/// What a car holds at a lot: a spot, or a building's door.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Claim {
    Spot(usize),
    Door(EntityId),
}

/// A building on a run: where its entrance joins the loop and the street
/// node beyond it, and where its door leaves the loop.
struct Member {
    building: EntityId,
    driveway: EntityId,
    street: EntityId,
    gate: usize,
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
    /// Which buildings this is the lot of, with their driveways: the run
    /// is rebuilt when this no longer matches the map.
    members: Vec<Member>,
    pub spots: Vec<Spot>,
    way: Way,
    /// Every node and edge this lot owns, for taking it down.
    nodes: Vec<EntityId>,
    edges: Vec<(EntityId, EntityId)>,
    /// Who is parked at whose door.
    doorway: Vec<(EntityId, EntityId)>,
}

/// A building's place on a run, as read off the map.
struct Seat {
    building: EntityId,
    driveway: EntityId,
    street: EntityId,
    /// Its lot tiles along the frontage, from the run's start.
    u0: f64,
    u1: f64,
}

impl World {
    /// The building's lot, built or rebuilt to match the map. `None` where
    /// no road reaches it.
    pub fn lot_mut(&mut self, building: EntityId) -> Option<&mut Lot> {
        let (key, seats) = self.run_of(building)?;
        let current = self.lots.get(&key).is_some_and(|l| {
            l.members.len() == seats.len()
                && l.members.iter().zip(&seats).all(|(m, s)| m.building == s.building && m.driveway == s.driveway && m.street == s.street)
        });
        if !current {
            // Whatever lots the members had, and this key's, go; everyone
            // who held something in them holds it again in the new one.
            let mut held = Vec::new();
            let mut keys: Vec<RunKey> = seats.iter().filter_map(|s| self.lot_of.get(&s.building).copied()).collect();
            keys.push(key);
            keys.dedup();
            for k in keys {
                held.extend(self.drop_run(k));
            }
            let lot = self.build_lot(key, &seats)?;
            self.lots.insert(key, lot);
            for s in &seats {
                self.lot_of.insert(s.building, key);
            }
            self.reseat(key, held);
        }
        self.lots.get_mut(&key)
    }

    /// The run this building's lot belongs to, and every building on it in
    /// order along the frontage. A kind with no lot is a run of one.
    fn run_of(&self, building: EntityId) -> Option<(RunKey, Vec<Seat>)> {
        let seat_of = |b: EntityId| -> Option<(EntityId, EntityId)> {
            let driveway = self.road_node_for_building(b)?;
            let street = match self.objects.get(driveway).map(|e| &e.object) {
                Some(GameObject::RoadNode(n)) => n.outgoing.iter().chain(&n.incoming).copied().find(|&s| s != driveway)?,
                _ => return None,
            };
            Some((driveway, street))
        };
        let (pos, kind, facing) = self.building_of(building)?;
        let (driveway, street) = seat_of(building)?;
        let Some(((lx, ly), (lw, _))) = plot(kind, facing).lot else {
            return Some((RunKey::Solo(building), vec![Seat { building, driveway, street, u0: 0.0, u1: 0.0 }]));
        };
        let lot = GridCoord { x: pos.x + lx as i32, y: pos.y + ly as i32 };
        let along_x = FACINGS[facing as usize % 4].0 == 0;
        let (line, a0, a1) = if along_x { (lot.y, lot.x, lot.x + lw as i32) } else { (lot.x, lot.y, lot.y + lw as i32) };
        // A neighbour's lot tile at along-coordinate `a` on this row, same
        // facing: the building and its tile range.
        let lot_tile = |a: i32| -> Option<(EntityId, i32, i32)> {
            let t = if along_x { GridCoord { x: a, y: line } } else { GridCoord { x: line, y: a } };
            let &b = self.occupied.get(&(t.x, t.y))?;
            let (p, k, f) = self.building_of(b)?;
            if f != facing {
                return None;
            }
            let ((ox, oy), (w, _)) = plot(k, f).lot?;
            let l = GridCoord { x: p.x + ox as i32, y: p.y + oy as i32 };
            let (row, s, e) = if along_x { (l.y, l.x, l.x + w as i32) } else { (l.x, l.y, l.y + w as i32) };
            (row == line && a >= s && a < e).then_some((b, s, e))
        };
        let mut chain = vec![(building, a0, a1)];
        while let Some(n) = lot_tile(chain[0].1 - 1) {
            chain.insert(0, n);
        }
        while let Some(n) = lot_tile(chain[chain.len() - 1].2) {
            chain.push(n);
        }
        let start = chain[0].1;
        let seats = chain
            .into_iter()
            .filter_map(|(b, s, e)| {
                let (driveway, street) = seat_of(b)?;
                Some(Seat { building: b, driveway, street, u0: (s - start) as f64, u1: (e - start) as f64 })
            })
            .collect();
        Some((RunKey::Run(facing, line, start), seats))
    }

    fn building_of(&self, id: EntityId) -> Option<(GridCoord, crate::protocol::BuildingKind, u8)> {
        let e = self.objects.get(id)?;
        match e.object {
            GameObject::Building(ref b) => Some((e.position?, b.kind, b.facing)),
            _ => None,
        }
    }

    fn build_lot(&mut self, key: RunKey, seats: &[Seat]) -> Option<Lot> {
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
            let d = self.node_pos(seat.driveway)?;
            let s = self.node_pos(seat.street)?;
            let len = ((s[0] - d[0]).powi(2) + (s[1] - d[1]).powi(2)).sqrt();
            let out = [(s[0] - d[0]) / len, (s[1] - d[1]) / len];
            let heading = out[1].atan2(out[0]);
            for side in [1.0, -1.0] {
                let at = [d[0] + out[0] * SPOT_OUT - out[1] * LANE * side, d[1] + out[1] * SPOT_OUT + out[0] * LANE * side];
                let id = node(self, at);
                edge(self, seat.driveway, id);
                edge(self, id, seat.street);
                spots.push(Spot { node: id, pose: Pose { at, heading }, car: None });
            }
            let members = vec![Member { building: seat.building, driveway: seat.driveway, street: seat.street, gate: 0, door: seat.driveway, door_at: 0 }];
            return Some(Lot { members, spots, way: Way::Driveway { driveway: seat.driveway, street: seat.street }, nodes, edges, doorway: Vec::new() });
        };

        // The ring, in the run's own frame: u along the frontage from the
        // run's start, v in from the street. One tile deep.
        let w = seats.last().map_or(0.0, |s| s.u1);
        let world_at = move |u: f64, v: f64| -> [f64; 2] {
            match facing % 4 {
                2 => [start as f64 + u, (line + 1) as f64 - v],
                0 => [start as f64 + u, line as f64 + v],
                1 => [(line + 1) as f64 - v, start as f64 + u],
                _ => [line as f64 + v, start as f64 + u],
            }
        };
        let back = world_at(0.0, 1.0);
        let front = world_at(0.0, 0.0);
        let heading = (back[1] - front[1]).atan2(back[0] - front[0]);
        // Each entrance crosses the front lane at its driveway's tile; each
        // door leaves the back lane under its building's middle.
        let u_of = |p: [f64; 2]| -> f64 {
            let g = world_at(0.0, 0.0);
            let along = world_at(1.0, 0.0);
            (p[0] - g[0]) * (along[0] - g[0]) + (p[1] - g[1]) * (along[1] - g[1])
        };
        let n = ((w - 2.0 * ISLAND_END) / PITCH + 1e-9).floor().max(0.0) as usize;
        let first = ISLAND_END + ((w - 2.0 * ISLAND_END) - n as f64 * PITCH) / 2.0 + PITCH / 2.0;
        let us: Vec<f64> = (0..n).map(|i| first + i as f64 * PITCH).collect();

        // Stations along each lane: a spot's entry or exit, or a member's
        // gate or door, in the order the flow passes them.
        enum Station {
            Spot(usize),
            Member(usize),
        }
        let mut front_stations: Vec<(f64, Station)> = us.iter().enumerate().map(|(i, &u)| (u, Station::Spot(i))).collect();
        let mut back_stations: Vec<(f64, Station)> = us.iter().enumerate().map(|(i, &u)| (u, Station::Spot(i))).collect();
        for (m, seat) in seats.iter().enumerate() {
            let d = self.node_pos(seat.driveway)?;
            front_stations.push((u_of(d), Station::Member(m)));
            back_stations.push(((seat.u0 + seat.u1) / 2.0, Station::Member(m)));
        }
        front_stations.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        back_stations.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());

        let mut loop_ = Vec::new();
        let mut gates = vec![(0usize, 0usize); n];
        let mut member_gate = vec![0usize; seats.len()];
        let mut member_door_at = vec![0usize; seats.len()];
        loop_.push(node(self, world_at(RING, RING)));
        for (u, station) in &front_stations {
            let id = node(self, world_at(*u, RING));
            match station {
                Station::Spot(i) => gates[*i].0 = loop_.len(),
                Station::Member(m) => member_gate[*m] = loop_.len(),
            }
            loop_.push(id);
        }
        loop_.push(node(self, world_at(w - RING, RING)));
        loop_.push(node(self, world_at(w - RING, 1.0 - RING)));
        for (u, station) in &back_stations {
            let id = node(self, world_at(*u, 1.0 - RING));
            match station {
                Station::Spot(i) => gates[*i].1 = loop_.len(),
                Station::Member(m) => member_door_at[*m] = loop_.len(),
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
            spots.push(Spot { node: id, pose: Pose { at, heading }, car: None });
        }
        let mut members = Vec::new();
        for (m, seat) in seats.iter().enumerate() {
            let gate = member_gate[m];
            edge(self, seat.street, loop_[gate]);
            edge(self, loop_[gate], seat.street);
            let door_at = member_door_at[m];
            let door = node(self, world_at((seat.u0 + seat.u1) / 2.0, DOOR_V));
            edge(self, loop_[door_at], door);
            edge(self, door, loop_[door_at]);
            members.push(Member { building: seat.building, driveway: seat.driveway, street: seat.street, gate, door, door_at });
        }
        Some(Lot { members, spots, way: Way::Ring { loop_, gates }, nodes, edges, doorway: Vec::new() })
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
        for (car, claim) in held {
            let (was, parked) = match self.objects.get(car).map(|e| &e.object) {
                Some(GameObject::Car(c)) => (c.spot, c.trip.is_none()),
                _ => continue,
            };
            let place = match claim {
                Claim::Door(b) => keys.iter().find(|k| self.lots[k].members.iter().any(|m| m.building == b)).map(|&k| (k, Claim::Door(b))),
                Claim::Spot(_) => keys
                    .iter()
                    .filter_map(|&k| self.nearest_free(k, was).map(|c| (k, c)))
                    .min_by(|(ka, ca), (kb, cb)| {
                        let d = |k: &RunKey, c: &Claim| self.pose_of(*k, *c).map_or(f64::MAX, |p| dist(p, was));
                        d(ka, ca).total_cmp(&d(kb, cb))
                    }),
            };
            match place {
                Some((k, claim)) => {
                    self.hold(k, car, claim);
                    if parked {
                        let pose = self.pose_of(k, claim);
                        self.set_spot(car, pose);
                    }
                }
                None => self.set_spot(car, None),
            }
        }
    }

    /// Take a run down, and say who held what in it.
    fn drop_run(&mut self, key: RunKey) -> Vec<(EntityId, Claim)> {
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
            if let Some(car) = spot.car {
                self.claims.remove(&car);
                held.push((car, Claim::Spot(i)));
            }
        }
        for &(car, building) in &lot.doorway {
            self.claims.remove(&car);
            held.push((car, Claim::Door(building)));
        }
        held
    }

    /// After a lot is rebuilt: everyone who held something holds it again,
    /// the nearest spot free to where they stood, and parked cars are drawn
    /// where they now stand.
    fn reseat(&mut self, key: RunKey, held: Vec<(EntityId, Claim)>) {
        for (car, claim) in held {
            let (was, parked) = match self.objects.get(car).map(|e| &e.object) {
                Some(GameObject::Car(c)) => (c.spot, c.trip.is_none()),
                _ => continue,
            };
            let claim = match claim {
                Claim::Door(b) if self.lots[&key].members.iter().any(|m| m.building == b) => Some(Claim::Door(b)),
                Claim::Door(_) => None,
                Claim::Spot(_) => self.nearest_free(key, was),
            };
            let Some(claim) = claim else {
                self.set_spot(car, None);
                continue;
            };
            self.hold(key, car, claim);
            if parked {
                let pose = self.pose_of(key, claim);
                self.set_spot(car, pose);
            }
        }
    }

    fn nearest_free(&self, key: RunKey, to: Option<Pose>) -> Option<Claim> {
        self.lots[&key]
            .spots
            .iter()
            .enumerate()
            .filter(|(_, s)| s.car.is_none())
            .min_by(|(_, a), (_, b)| dist(a.pose, to).total_cmp(&dist(b.pose, to)))
            .map(|(i, _)| Claim::Spot(i))
    }

    fn hold(&mut self, key: RunKey, car: EntityId, claim: Claim) {
        let lot = self.lots.get_mut(&key).unwrap();
        match claim {
            Claim::Spot(i) => lot.spots[i].car = Some(car),
            Claim::Door(b) => lot.doorway.push((car, b)),
        }
        self.claims.insert(car, key);
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
        lot.spots.iter().position(|s| s.car == Some(car)).map(Claim::Spot)
    }

    /// Where a route node is: a road node's tile centre, or a lot node's own
    /// position.
    pub fn node_pos(&self, id: EntityId) -> Option<[f64; 2]> {
        if let Some(&p) = self.lot_nodes.get(&id) {
            return Some(p);
        }
        self.objects.get(id)?.position.map(|p| [p.x as f64 + 0.5, p.y as f64 + 0.5])
    }

    /// Hold a place at a building for a car: the one it already holds, the
    /// door if the car's owner works there or it is a facility's vehicle,
    /// else a free spot. `None` when the lot is full, and the trip does not
    /// start: the car waits where it is, honestly, and tries again.
    pub fn claim_spot(&mut self, building: EntityId, car: EntityId) -> Option<Claim> {
        let staff = self.works_at(car, building);
        self.lot_mut(building)?;
        let key = self.lot_of[&building];
        let lot = &self.lots[&key];
        let claim = lot
            .spots
            .iter()
            .position(|s| s.car == Some(car))
            .map(Claim::Spot)
            .or_else(|| lot.doorway.iter().find(|&&(c, b)| c == car && b == building).map(|&(_, b)| Claim::Door(b)))
            .or_else(|| staff.then_some(Claim::Door(building)))
            .or_else(|| lot.spots.iter().position(|s| s.car.is_none()).map(Claim::Spot))?;
        // Only now, with the new place found, is the old one let go of.
        if self.claim_of(key, car) != Some(claim) {
            self.release_spot(car);
            self.hold(key, car, claim);
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
                if s.car == Some(car) {
                    s.car = None;
                }
            }
            lot.doorway.retain(|&(c, _)| c != car);
        }
        self.set_spot(car, None);
    }

    /// Stand the car in its place at the building, if it has one.
    pub fn park_in_lot(&mut self, building: EntityId, car: EntityId) {
        let pose = match (self.claim_spot(building, car), self.claims.get(&car).copied()) {
            (Some(claim), Some(key)) => self.pose_of(key, claim),
            _ => None,
        };
        self.set_spot(car, pose);
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
                let m = lot.members.iter().min_by_key(|m| (m.gate + n - from) % n)?;
                let mut v = vec![first];
                v.extend(cyclic(loop_, from, m.gate));
                v.push(m.street);
                v
            }
        })
    }

    /// The way into a place at the building for this car, claiming one: the
    /// node the street route ends at, then the lot nodes to the place. `None`
    /// when there is no place, and the trip does not start.
    pub fn way_in(&mut self, building: EntityId, car: EntityId) -> Option<Vec<EntityId>> {
        let claim = self.claim_spot(building, car)?;
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
                let mut v = vec![m.street];
                v.extend(cyclic(loop_, m.gate, to));
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
            Way::Ring { .. } => lot.members.iter().find(|m| m.building == building)?.street,
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
                Some(_) => self.nearest_free(key, pose),
                None => matches!(self.lots[&key].way, Way::Ring { .. }).then_some(Claim::Door(building)),
            };
            match claim {
                Some(claim) => {
                    self.hold(key, car, claim);
                    let pose = self.pose_of(key, claim);
                    self.set_spot(car, pose);
                }
                None => self.set_spot(car, None),
            }
        }
    }
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

    /// Two shops side by side share one lot with seven spots and an
    /// entrance each; apart, each has two.
    #[test]
    fn touching_lots_fuse_into_one_run() {
        let mut world = street();
        let a = world.spawn_building(GridCoord { x: 2, y: 1 }, BuildingKind::Shop).unwrap();
        let b = world.spawn_building(GridCoord { x: 3, y: 1 }, BuildingKind::Shop).unwrap();
        let apart = world.spawn_building(GridCoord { x: 10, y: 1 }, BuildingKind::Shop).unwrap();
        assert_eq!(world.lot_mut(a).unwrap().spots.len(), 7, "a pair parks seven");
        assert_eq!(world.lot_of[&a], world.lot_of[&b], "one lot between them");
        assert_eq!(world.lot_mut(apart).unwrap().spots.len(), 2, "alone parks two");
        let lot = &world.lots[&world.lot_of[&a]];
        assert_eq!(lot.members.len(), 2);
        assert!(lot.members.iter().all(|m| m.gate > 0), "every member has its own entrance");
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
        world.park_in_lot(a, car);
        assert!(matches!(world.objects.get(car).map(|e| &e.object), Some(GameObject::Car(c)) if c.spot.is_some()));
        let b = world.spawn_building(GridCoord { x: 3, y: 1 }, BuildingKind::Shop).unwrap();
        assert_eq!(world.lot_mut(b).unwrap().spots.len(), 7);
        assert_eq!(world.claims.get(&car), Some(&world.lot_of[&a]), "the car holds a spot in the run");
        assert!(matches!(world.objects.get(car).map(|e| &e.object), Some(GameObject::Car(c)) if c.spot.is_some()));
        world.remove_building(b);
        assert_eq!(world.lot_mut(a).unwrap().spots.len(), 2);
        assert_eq!(world.claims.get(&car), Some(&world.lot_of[&a]));
    }
}
