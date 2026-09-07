//! Where cars stand at a building: its lot.
//!
//! A lot hangs off the driveway. Its spots are nodes with positions of their
//! own, off the grid, joined to the road by edges cars drive like any other,
//! so a trip ends *in* a spot and starts from one, and the client only ever
//! draws trips. Nothing about a lot is streamed: a parked car carries its
//! pose, and a moving one its route.
//!
//! For now every building has the same lot, two spots on its driveway: a car
//! drives in past the driveway node, turns, and comes out nose first onto
//! its lane, and leaves straight for the street. See `docs/parking.md`.

use std::collections::HashMap;

use crate::protocol::{EntityId, GameObject, Pose};
use crate::world::World;
use crate::world::segments::EdgeSegment;

/// How far out along the driveway a car's centre stands: half a car, so it
/// is half in and half out.
const SPOT_OUT: f64 = 0.35;
/// Half the gap between the two lanes.
const LANE: f64 = 0.11;

pub struct Spot {
    pub node: EntityId,
    pub pose: Pose,
    /// Who holds it: standing in it, or on the way.
    pub car: Option<EntityId>,
}

pub struct Lot {
    /// The road node on the plot the spots hang off.
    pub driveway: EntityId,
    /// The street node the driveway joins; where a car leaving a spot goes.
    pub street: EntityId,
    pub spots: Vec<Spot>,
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
            let held: Vec<Option<EntityId>> = self.drop_lot(building).map(|l| l.spots.iter().map(|s| s.car).collect()).unwrap_or_default();
            let d = self.node_pos(driveway)?;
            let s = self.node_pos(street)?;
            let len = ((s[0] - d[0]).powi(2) + (s[1] - d[1]).powi(2)).sqrt();
            let out = [(s[0] - d[0]) / len, (s[1] - d[1]) / len];
            let heading = out[1].atan2(out[0]);
            let spots = [1.0, -1.0]
                .iter()
                .enumerate()
                .map(|(i, side)| {
                    let at = [
                        d[0] + out[0] * SPOT_OUT - out[1] * LANE * side,
                        d[1] + out[1] * SPOT_OUT + out[0] * LANE * side,
                    ];
                    let node = self.objects.reserve_id();
                    self.lot_nodes.insert(node, at);
                    self.edges.insert((driveway, node), EdgeSegment::new(SPOT_OUT));
                    self.edges.insert((node, street), EdgeSegment::new(len - SPOT_OUT));
                    let car = held.get(i).copied().flatten();
                    let pose = Pose { at, heading };
                    if let Some(car) = car {
                        self.claims.insert(car, building);
                        self.set_spot(car, Some(pose));
                    }
                    Spot { node, pose, car }
                })
                .collect();
            self.lots.insert(building, Lot { driveway, street, spots });
        }
        self.lots.get_mut(&building)
    }

    /// Take a building's lot out of the world, edges and all.
    pub fn drop_lot(&mut self, building: EntityId) -> Option<Lot> {
        let lot = self.lots.remove(&building)?;
        for spot in &lot.spots {
            self.lot_nodes.remove(&spot.node);
            self.edges.remove(&(lot.driveway, spot.node));
            self.edges.remove(&(spot.node, lot.street));
            if let Some(car) = spot.car {
                self.claims.remove(&car);
            }
        }
        Some(lot)
    }

    /// Where a route node is: a road node's tile centre, or a lot node's own
    /// position.
    pub fn node_pos(&self, id: EntityId) -> Option<[f64; 2]> {
        if let Some(&p) = self.lot_nodes.get(&id) {
            return Some(p);
        }
        self.objects.get(id)?.position.map(|p| [p.x as f64 + 0.5, p.y as f64 + 0.5])
    }

    /// Hold a spot at a building for a car: the one it already holds, or a
    /// free one. `None` when the lot is full or there is no lot, and the car
    /// is swallowed whole — parked, but nowhere to be seen.
    pub fn claim_spot(&mut self, building: EntityId, car: EntityId) -> Option<usize> {
        if self.claims.get(&car).is_some_and(|&b| b != building) {
            self.release_spot(car);
        }
        let lot = self.lot_mut(building)?;
        let i = lot.spots.iter().position(|s| s.car == Some(car)).or_else(|| lot.spots.iter().position(|s| s.car.is_none()))?;
        lot.spots[i].car = Some(car);
        self.claims.insert(car, building);
        Some(i)
    }

    /// Let go of whatever spot the car holds.
    pub fn release_spot(&mut self, car: EntityId) {
        if let Some(building) = self.claims.remove(&car)
            && let Some(lot) = self.lots.get_mut(&building)
        {
            for s in &mut lot.spots {
                if s.car == Some(car) {
                    s.car = None;
                }
            }
        }
        self.set_spot(car, None);
    }

    /// Stand the car in its spot at the building, if it has one.
    pub fn park_in_lot(&mut self, building: EntityId, car: EntityId) {
        let pose = self.claim_spot(building, car).and_then(|i| self.lots.get(&building).map(|l| l.spots[i].pose));
        if pose.is_none() {
            self.claims.remove(&car);
        }
        self.set_spot(car, pose);
    }

    /// The way from the car's spot to the street, if it holds one: the spot's
    /// node and then the street node it pulls out onto.
    pub fn way_out(&self, car: EntityId) -> Option<[EntityId; 2]> {
        let lot = self.lots.get(self.claims.get(&car)?)?;
        let spot = lot.spots.iter().find(|s| s.car == Some(car))?;
        Some([spot.node, lot.street])
    }

    /// The way into a spot at the building for this car, claiming one: the
    /// driveway node and then the spot's. Just the driveway when the lot is
    /// full, and the car parks unseen.
    pub fn way_in(&mut self, building: EntityId, car: EntityId) -> Option<Vec<EntityId>> {
        let driveway = self.road_node_for_building(building)?;
        Some(match self.claim_spot(building, car) {
            Some(i) => vec![driveway, self.lots[&building].spots[i].node],
            None => vec![driveway],
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
    /// saved in, or, if the lot has moved, the nearest one free.
    pub fn restore_spots(&mut self) {
        let parked: Vec<(EntityId, Pose, crate::protocol::GridCoord)> = self
            .objects
            .iter()
            .filter_map(|e| match e.object {
                GameObject::Car(ref c) if c.trip.is_none() => Some((e.id, c.spot?, e.position?)),
                _ => None,
            })
            .collect();
        for (car, pose, tile) in parked {
            let Some(&building) = self.occupied.get(&(tile.x, tile.y)) else {
                self.set_spot(car, None);
                continue;
            };
            let nearest = self.lot_mut(building).and_then(|lot| {
                lot.spots
                    .iter()
                    .enumerate()
                    .filter(|(_, s)| s.car.is_none())
                    .min_by(|(_, a), (_, b)| dist(a.pose, pose).total_cmp(&dist(b.pose, pose)))
                    .map(|(i, _)| i)
            });
            match nearest {
                Some(i) => {
                    let lot = self.lots.get_mut(&building).unwrap();
                    lot.spots[i].car = Some(car);
                    let pose = lot.spots[i].pose;
                    self.claims.insert(car, building);
                    self.set_spot(car, Some(pose));
                }
                None => self.set_spot(car, None),
            }
        }
    }
}

fn dist(a: Pose, b: Pose) -> f64 {
    (a.at[0] - b.at[0]).powi(2) + (a.at[1] - b.at[1]).powi(2)
}

pub type Lots = HashMap<EntityId, Lot>;
