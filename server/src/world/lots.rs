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
//! through from the front lane to the back one. Staff drive the ring to a
//! door under the building and park there unseen. See `docs/parking.md`.

use std::collections::HashMap;

use crate::blueprint::plot;
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
/// the back; and where the door is, under the building's front.
const SPOT_V: f64 = 0.5;
const DOOR_V: f64 = 1.05;

pub struct Spot {
    pub node: EntityId,
    pub pose: Pose,
    /// Who holds it: standing in it, or on the way.
    pub car: Option<EntityId>,
}

/// What a car holds at a building.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Claim {
    Spot(usize),
    Door,
}

/// The way in and out of a lot, as node sequences the routes are made of.
enum Way {
    /// A driveway pair: in from the driveway node to the spot, out from the
    /// spot straight to the street.
    Driveway,
    /// A ring, as its nodes in the order the flow takes them, cyclic;
    /// which of them is where the driveway joins, and where the door is.
    Ring {
        loop_: Vec<EntityId>,
        gate: usize,
        /// Each spot's entry and exit on the loop.
        gates: Vec<(usize, usize)>,
        door: EntityId,
        door_at: usize,
    },
}

pub struct Lot {
    /// The road node on the plot the lot hangs off.
    pub driveway: EntityId,
    /// The street node the driveway joins; where the street route ends.
    pub street: EntityId,
    pub spots: Vec<Spot>,
    way: Way,
    /// Every node this lot owns, for taking it down.
    nodes: Vec<EntityId>,
    /// Every edge this lot owns.
    edges: Vec<(EntityId, EntityId)>,
    /// Who is parked at the door.
    doorway: Vec<EntityId>,
}

impl World {
    /// The building's lot, built or rebuilt to match its driveway. `None`
    /// where no road reaches it.
    pub fn lot_mut(&mut self, building: EntityId) -> Option<&mut Lot> {
        let driveway = self.road_node_for_building(building)?;
        let street = match self.objects.get(driveway).map(|e| &e.object) {
            Some(GameObject::RoadNode(n)) => n.outgoing.iter().chain(&n.incoming).copied().find(|&s| s != driveway)?,
            _ => return None,
        };
        let current = self.lots.get(&building).is_some_and(|l| l.driveway == driveway && l.street == street);
        if !current {
            let held = self.drop_lot(building);
            let lot = self.build_lot(building, driveway, street)?;
            self.lots.insert(building, lot);
            self.reseat(building, held);
        }
        self.lots.get_mut(&building)
    }

    fn build_lot(&mut self, building: EntityId, driveway: EntityId, street: EntityId) -> Option<Lot> {
        let (pos, kind, facing) = match self.objects.get(building) {
            Some(e) => match e.object {
                GameObject::Building(ref b) => (e.position?, b.kind, b.facing),
                _ => return None,
            },
            None => return None,
        };
        let d = self.node_pos(driveway)?;
        let s = self.node_pos(street)?;
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
            let (pa, pb) = (world.lot_nodes.get(&a).copied().or_else(|| world.node_pos(a)).unwrap(), world.lot_nodes.get(&b).copied().or_else(|| world.node_pos(b)).unwrap());
            let len = ((pa[0] - pb[0]).powi(2) + (pa[1] - pb[1]).powi(2)).sqrt();
            world.edges.insert((a, b), EdgeSegment::new(len));
            edges.push((a, b));
        };

        let lie = plot(kind, facing);
        let Some(((lx, ly), (lw, ld))) = lie.lot else {
            // A driveway pair. Spot 0 is on the lane a car leaves by.
            let len = ((s[0] - d[0]).powi(2) + (s[1] - d[1]).powi(2)).sqrt();
            let out = [(s[0] - d[0]) / len, (s[1] - d[1]) / len];
            let heading = out[1].atan2(out[0]);
            for side in [1.0, -1.0] {
                let at = [d[0] + out[0] * SPOT_OUT - out[1] * LANE * side, d[1] + out[1] * SPOT_OUT + out[0] * LANE * side];
                let id = node(self, at);
                edge(self, driveway, id);
                edge(self, id, street);
                spots.push(Spot { node: id, pose: Pose { at, heading }, car: None });
            }
            return Some(Lot { driveway, street, spots, way: Way::Driveway, nodes, edges, doorway: Vec::new() });
        };

        // The ring, in the lot's own frame: u along the frontage, v in from
        // the street. One tile deep for now: the front row of the lot.
        let lot = GridCoord { x: pos.x + lx as i32, y: pos.y + ly as i32 };
        let w = lw as f64;
        // World position of local (u, v).
        let world_at = move |u: f64, v: f64| -> [f64; 2] {
            match facing % 4 {
                2 => [lot.x as f64 + u, (lot.y + ld as i32) as f64 - v],
                0 => [lot.x as f64 + u, lot.y as f64 + v],
                1 => [(lot.x + ld as i32) as f64 - v, lot.y as f64 + u],
                _ => [lot.x as f64 + v, lot.y as f64 + u],
            }
        };
        // The heading of a car standing nose to the back, in world radians.
        let back = world_at(0.0, 1.0);
        let front = world_at(0.0, 0.0);
        let heading = (back[1] - front[1]).atan2(back[0] - front[0]);
        // Where the driveway crosses the front lane: at its own tile.
        let du = {
            let g = world_at(0.0, 0.0);
            let along = world_at(1.0, 0.0);
            let ax = along[0] - g[0];
            let ay = along[1] - g[1];
            (d[0] - g[0]) * ax + (d[1] - g[1]) * ay
        };
        let n = ((w - 2.0 * ISLAND_END) / PITCH + 1e-9).floor().max(0.0) as usize;
        let start = ISLAND_END + ((w - 2.0 * ISLAND_END) - n as f64 * PITCH) / 2.0 + PITCH / 2.0;
        let us: Vec<f64> = (0..n).map(|i| start + i as f64 * PITCH).collect();

        // The loop in flow order: along the front lane from the near corner,
        // down the far side, back along the back lane, up the near side.
        let mut loop_ = Vec::new();
        let mut gates = vec![(0usize, 0usize); n];
        let mut gate = usize::MAX;
        let mut front_stations: Vec<(f64, Option<usize>)> = us.iter().enumerate().map(|(i, &u)| (u, Some(i))).collect();
        front_stations.push((du, None));
        front_stations.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        loop_.push(node(self, world_at(RING, RING)));
        for &(u, spot) in &front_stations {
            let id = node(self, world_at(u, RING));
            match spot {
                Some(i) => gates[i].0 = loop_.len(),
                None => gate = loop_.len(),
            }
            loop_.push(id);
        }
        loop_.push(node(self, world_at(w - RING, RING)));
        loop_.push(node(self, world_at(w - RING, 1.0 - RING)));
        let door_u = w / 2.0;
        let mut back_stations: Vec<(f64, Option<usize>)> = us.iter().enumerate().map(|(i, &u)| (u, Some(i))).collect();
        back_stations.push((door_u, None));
        back_stations.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        let mut door_at = usize::MAX;
        for &(u, spot) in &back_stations {
            let id = node(self, world_at(u, 1.0 - RING));
            match spot {
                Some(i) => gates[i].1 = loop_.len(),
                None => door_at = loop_.len(),
            }
            loop_.push(id);
        }
        loop_.push(node(self, world_at(RING, 1.0 - RING)));
        for i in 0..loop_.len() {
            edge(self, loop_[i], loop_[(i + 1) % loop_.len()]);
        }
        // The driveway joins the front lane both ways.
        edge(self, street, loop_[gate]);
        edge(self, loop_[gate], street);
        // Spots across the island, and the door under the building.
        for (i, &u) in us.iter().enumerate() {
            let at = world_at(u, SPOT_V);
            let id = node(self, at);
            edge(self, loop_[gates[i].0], id);
            edge(self, id, loop_[gates[i].1]);
            spots.push(Spot { node: id, pose: Pose { at, heading }, car: None });
        }
        let door = node(self, world_at(door_u, DOOR_V));
        edge(self, loop_[door_at], door);
        edge(self, door, loop_[door_at]);
        Some(Lot { driveway, street, spots, way: Way::Ring { loop_, gate, gates, door, door_at }, nodes, edges, doorway: Vec::new() })
    }

    /// Take a building's lot out of the world, edges and all, and say who
    /// held what.
    pub fn drop_lot(&mut self, building: EntityId) -> Vec<(EntityId, Claim)> {
        let Some(lot) = self.lots.remove(&building) else { return Vec::new() };
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
        for &car in &lot.doorway {
            self.claims.remove(&car);
            held.push((car, Claim::Door));
        }
        held
    }

    /// After a lot is rebuilt: everyone who held something holds it again,
    /// the nearest spot free to where they stood, and parked cars are drawn
    /// where they now stand.
    fn reseat(&mut self, building: EntityId, held: Vec<(EntityId, Claim)>) {
        for (car, claim) in held {
            let was = self.objects.get(car).and_then(|e| match e.object {
                GameObject::Car(ref c) => c.spot,
                _ => None,
            });
            let parked = matches!(self.objects.get(car).map(|e| &e.object), Some(GameObject::Car(c)) if c.trip.is_none());
            let claim = match (claim, was) {
                (Claim::Door, _) => Some(Claim::Door),
                (Claim::Spot(_), _) => {
                    let lot = self.lots.get(&building).unwrap();
                    lot.spots
                        .iter()
                        .enumerate()
                        .filter(|(_, s)| s.car.is_none())
                        .min_by(|(_, a), (_, b)| dist(a.pose, was).total_cmp(&dist(b.pose, was)))
                        .map(|(i, _)| Claim::Spot(i))
                }
            };
            let Some(claim) = claim else {
                self.set_spot(car, None);
                continue;
            };
            self.hold(building, car, claim);
            if parked {
                let pose = self.pose_of(building, claim);
                self.set_spot(car, pose);
            }
        }
    }

    fn hold(&mut self, building: EntityId, car: EntityId, claim: Claim) {
        let lot = self.lots.get_mut(&building).unwrap();
        match claim {
            Claim::Spot(i) => lot.spots[i].car = Some(car),
            Claim::Door => lot.doorway.push(car),
        }
        self.claims.insert(car, building);
    }

    fn pose_of(&self, building: EntityId, claim: Claim) -> Option<Pose> {
        match claim {
            Claim::Spot(i) => self.lots.get(&building).map(|l| l.spots[i].pose),
            Claim::Door => None,
        }
    }

    fn claim_of(&self, building: EntityId, car: EntityId) -> Option<Claim> {
        let lot = self.lots.get(&building)?;
        if lot.doorway.contains(&car) {
            return Some(Claim::Door);
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
        let lot = self.lot_mut(building)?;
        let claim = lot
            .spots
            .iter()
            .position(|s| s.car == Some(car))
            .map(Claim::Spot)
            .or_else(|| lot.doorway.contains(&car).then_some(Claim::Door))
            .or_else(|| staff.then_some(Claim::Door))
            .or_else(|| lot.spots.iter().position(|s| s.car.is_none()).map(Claim::Spot))?;
        // Only now, with the new place found, is the old one let go of.
        if self.claims.get(&car).is_some_and(|&b| b != building) {
            self.release_spot(car);
        }
        if self.claim_of(building, car) != Some(claim) {
            self.hold(building, car, claim);
        }
        Some(claim)
    }

    /// Does the car's owner work at the building? Staff park unseen.
    fn works_at(&self, car: EntityId, building: EntityId) -> bool {
        let owner = match self.objects.get(car).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.owner,
            _ => return false,
        };
        match self.objects.get(owner).map(|e| &e.object) {
            Some(GameObject::Resident(r)) => r.work == Some(building),
            // A facility's own vehicles, and vehicles on a call, unload at the door.
            Some(GameObject::Building(_)) => true,
            _ => false,
        }
    }

    /// Let go of whatever the car holds.
    pub fn release_spot(&mut self, car: EntityId) {
        if let Some(building) = self.claims.remove(&car)
            && let Some(lot) = self.lots.get_mut(&building)
        {
            for s in &mut lot.spots {
                if s.car == Some(car) {
                    s.car = None;
                }
            }
            lot.doorway.retain(|&c| c != car);
        }
        self.set_spot(car, None);
    }

    /// Stand the car in its place at the building, if it has one.
    pub fn park_in_lot(&mut self, building: EntityId, car: EntityId) {
        let pose = self.claim_spot(building, car).and_then(|c| self.pose_of(building, c));
        if !self.claims.contains_key(&car) {
            self.set_spot(car, None);
            return;
        }
        self.set_spot(car, pose);
    }

    /// The way from where the car stands to the street: its lot nodes in
    /// order, and the street node last.
    pub fn way_out(&self, car: EntityId) -> Option<Vec<EntityId>> {
        let building = *self.claims.get(&car)?;
        let lot = self.lots.get(&building)?;
        let claim = self.claim_of(building, car)?;
        let mut way = match (&lot.way, claim) {
            (Way::Driveway, Claim::Spot(i)) => vec![lot.spots[i].node],
            // Parked unseen on the driveway itself.
            (Way::Driveway, Claim::Door) => vec![lot.driveway],
            (Way::Ring { loop_, gate, gates, door, door_at }, claim) => {
                let (first, from) = match claim {
                    Claim::Spot(i) => (lot.spots[i].node, gates[i].1),
                    Claim::Door => (*door, *door_at),
                };
                let mut v = vec![first];
                v.extend(cyclic(loop_, from, *gate));
                v
            }
        };
        way.push(lot.street);
        Some(way)
    }

    /// The way into a place at the building for this car, claiming one: the
    /// node the street route ends at, then the lot nodes to the place. `None`
    /// when there is no place, and the trip does not start.
    pub fn way_in(&mut self, building: EntityId, car: EntityId) -> Option<Vec<EntityId>> {
        let driveway = self.road_node_for_building(building)?;
        let claim = self.claim_spot(building, car)?;
        let lot = self.lots.get(&building)?;
        Some(match (&lot.way, claim) {
            (Way::Driveway, Claim::Spot(i)) => vec![driveway, lot.spots[i].node],
            (Way::Driveway, Claim::Door) => vec![driveway],
            (Way::Ring { loop_, gate, gates, door, door_at }, claim) => {
                let (to, last) = match claim {
                    Claim::Spot(i) => (gates[i].0, lot.spots[i].node),
                    Claim::Door => (*door_at, *door),
                };
                let mut v = vec![lot.street];
                v.extend(cyclic(loop_, *gate, to));
                v.push(last);
                v
            }
        })
    }

    /// The node a street route to this building ends at: its driveway, or
    /// for a ring the street node the driveway joins, from which the ring's
    /// own edge leads in.
    pub fn approach(&mut self, building: EntityId) -> Option<EntityId> {
        let lot = self.lot_mut(building)?;
        Some(match lot.way {
            Way::Driveway => lot.driveway,
            Way::Ring { .. } => lot.street,
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
    /// a pose at a building with a door is at the door.
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
            let claim = match (self.lot_mut(building), pose) {
                (Some(lot), Some(pose)) => lot
                    .spots
                    .iter()
                    .enumerate()
                    .filter(|(_, s)| s.car.is_none())
                    .min_by(|(_, a), (_, b)| dist(a.pose, Some(pose)).total_cmp(&dist(b.pose, Some(pose))))
                    .map(|(i, _)| Claim::Spot(i)),
                (Some(lot), None) => matches!(lot.way, Way::Ring { .. }).then_some(Claim::Door),
                (None, _) => None,
            };
            match claim {
                Some(claim) => {
                    self.hold(building, car, claim);
                    let pose = self.pose_of(building, claim);
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

pub type Lots = HashMap<EntityId, Lot>;
