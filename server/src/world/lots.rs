//! Where cars stand at a building: its lot.
//!
//! A lot is a piece of road. Its nodes have positions of their own, off the
//! grid, and are joined by edges cars drive like any other, so a trip ends
//! *in* a spot and starts from one, and the client only ever draws trips.
//! Nothing about a lot is streamed: a parked car carries its pose, a moving
//! one its route.
//!
//! Three shapes, each a building's own. A house parks two cars on its
//! drive, side by side: a car drives in nose first and backs out onto
//! the street. The drive is the lot's, not a road: from the street node
//! the building's door opens onto (`Building::door`) to its tile. A depot,
//! a farm and a port keep a yard: docks against its wall that a lorry
//! backs into. Everything else parks at the kerb before it: bays along
//! the streets its tiles front, two to a tile a side, a car pulling in
//! from the lane beside them and out ahead. A car that finds no place
//! stops at the door, unseen. See `docs/parking.md`.

use rand::{Rng, SeedableRng};
use rand::rngs::SmallRng;
use std::collections::HashMap;

use crate::blueprint::FACINGS;
use crate::engine::GameTime;
use crate::protocol::{EntityId, GameObject, GridCoord, Pose};
use serde_json::{json, Value};
use crate::world::World;
use crate::world::segments::EdgeSegment;

/// A driveway spot: how far out from the plot's centre a car's centre
/// stands, wholly before the house's front wall and short of the road, and
/// half the gap between the two cars (`DRIVE_OUT` and `DRIVE_LANE` in the
/// client's `dressing.ts`, which draws the drive).
const SPOT_OUT: f64 = 0.47;
const LANE: f64 = 0.11;
/// A kerb bay: how far a parked car's middle is from its street's middle
/// line, wholly off the road (`KERB` in the client's `dressing.ts`), and
/// how far along from a street node, two to a tile; and the middle of the
/// lane beside it (`LANE_OFFSET` in the client's `roadGeometry.ts`).
const KERB: f64 = 0.305;
const BAY_AT: f64 = 0.25;
const KERB_LANE: f64 = 0.1;

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

/// What a car holds at a lot: a spot, or the door.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Claim {
    Spot(usize),
    Door,
}

/// The way in and out of a lot, as node sequences the routes are made of.
enum Way {
    /// A drive's pair: in from the street to the spot nose first, out
    /// backing straight to the street; the door is the lot's node on the
    /// door's tile.
    Driveway { door: EntityId, street: EntityId },
    /// A depot's yard: a two-way lane from the door along the front,
    /// and docks against the building's wall, each a spot, entered by
    /// backing in from the stop point beyond its mouth and left forward.
    /// `lane` runs from the door outward; a bay is (mouth, stop) as
    /// indices on it.
    Yard { lane: Vec<EntityId>, bays: Vec<(usize, usize)>, street: EntityId },
    /// Bays at the kerb, a spot each; the door for a car with no bay.
    Kerb { door: EntityId, street: EntityId, bays: Vec<KerbWay> },
}

/// The way into a kerb bay and out: from the street node behind it, along
/// its lot nodes, the bay's last, the last `backs` edges in reverse; and
/// out forward to the street node ahead.
struct KerbWay {
    entry: EntityId,
    exit: EntityId,
    path: Vec<EntityId>,
    backs: usize,
}

/// A bay at the kerb, before one of a building's tiles: where a car in it
/// stands and faces; the street nodes it is driven in from and out to; and
/// where it is driven between. The bay three quarters along from its entry
/// is pulled into, straightening on the kerb's line; the one a quarter
/// along, too close to turn into, is parked in as a driver would: past it
/// on the lane, and backed in.
#[derive(Clone, PartialEq, Debug)]
pub struct KerbBay {
    pub pose: Pose,
    pub entry: EntityId,
    pub exit: EntityId,
    lead: Vec<[f64; 2]>,
    backs: usize,
}

/// The ways from a node to a building: the street route to its door, and
/// to the entry of each of its kerb bays.
pub struct Ways {
    pub street: Vec<EntityId>,
    bays: HashMap<EntityId, Vec<EntityId>>,
}

/// Docks are 0.3 wide against the wall, a margin of 0.4 at either end of
/// the yard, and a lorry stands with its tail at the wall, which is this
/// far inside the building's tile.
const BAY_W: f64 = 0.3;
const BAY_MARGIN: f64 = 0.4;
const WALL: f64 = 0.14;

pub struct Lot {
    /// Its door's tile and the street node it opens onto, and the
    /// building's tiles and facing: the lot is rebuilt when these no
    /// longer match the map.
    gate: (GridCoord, EntityId),
    shape: (Vec<GridCoord>, u8, Vec<KerbBay>),
    pub spots: Vec<Spot>,
    way: Way,
    /// Every node and edge this lot owns, for taking it down.
    nodes: Vec<EntityId>,
    edges: Vec<(EntityId, EntityId)>,
    /// The cars at the door.
    doorway: Vec<EntityId>,
    pub stats: Stats,
}

impl World {
    /// The building's lot, built or rebuilt to match the map. `None` where
    /// no road reaches it.
    pub fn lot_mut(&mut self, building: EntityId) -> Option<&mut Lot> {
        // Its door, and the street it opens onto: none for one no road
        // reaches, and none at the edge, a road running off the map, where
        // a car that gets there is gone, so nobody parks.
        let gate = self.door_of(building)?;
        let (tiles, kind, facing) = self.building_of(building)?;
        let kerb = if kerbed(kind) { self.kerb_bays(&tiles) } else { Vec::new() };
        let shape = (tiles, facing, kerb);
        if self.lots.get(&building).is_none_or(|l| l.gate != gate || l.shape != shape) {
            // Whatever it had goes; everyone who held something in it
            // holds it again in the new one.
            let stats = self.lots.get(&building).map_or_else(Stats::default, |l| l.stats);
            let held = self.drop_run(building);
            let mut lot = self.build_lot(building, gate)?;
            lot.stats = stats;
            lot.shape = shape;
            self.lots.insert(building, lot);
            self.reseat(building, held);
        }
        self.lots.get_mut(&building)
    }

    fn building_of(&self, id: EntityId) -> Option<(Vec<GridCoord>, crate::protocol::BuildingKind, u8)> {
        match self.objects.get(id)?.object {
            GameObject::Building(ref b) => Some((b.tiles.clone(), b.kind, b.facing)),
            _ => None,
        }
    }

    fn build_lot(&mut self, building: EntityId, gate: (GridCoord, EntityId)) -> Option<Lot> {
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
        let (tiles, kind, facing) = self.building_of(building)?;
        // The door: the lot's own node on the door's tile, where a car with
        // no spot stops, and a yard's lane begins; the drive to it from the
        // street.
        let (tile, street) = gate;
        let door = node(self, [tile.x as f64 + 0.5, tile.y as f64 + 0.5]);
        edge(self, street, door);
        edge(self, door, street);
        if is_yard(kind) {
            let mut lot = self.build_yard(gate, door, &tiles, kind, facing, node, edge)?;
            lot.nodes = nodes;
            lot.edges = edges;
            return Some(lot);
        }
        if kerbed(kind) {
            let mut bays = Vec::new();
            for bay in self.kerb_bays(&tiles) {
                let mut path = Vec::new();
                for at in bay.lead.iter().chain([&bay.pose.at]) {
                    let id = node(self, *at);
                    edge(self, path.last().copied().unwrap_or(bay.entry), id);
                    path.push(id);
                }
                let id = *path.last().unwrap();
                edge(self, id, bay.exit);
                spots.push(Spot { node: id, pose: bay.pose, windows: Vec::new() });
                bays.push(KerbWay { entry: bay.entry, exit: bay.exit, path, backs: bay.backs });
            }
            return Some(Lot { gate, shape: Default::default(), spots, way: Way::Kerb { door, street, bays }, nodes, edges, doorway: Vec::new(), stats: Stats::default() });
        }
        // A driveway pair, driven into nose first and backed out of.
        // Spot 0 is on the lane a car leaves by.
        let d = self.node_pos(door)?;
        let s = self.node_pos(street)?;
        let len = ((s[0] - d[0]).powi(2) + (s[1] - d[1]).powi(2)).sqrt();
        let out = [(s[0] - d[0]) / len, (s[1] - d[1]) / len];
        let heading = (-out[1]).atan2(-out[0]);
        for side in [1.0, -1.0] {
            let at = [d[0] + out[0] * SPOT_OUT - out[1] * LANE * side, d[1] + out[1] * SPOT_OUT + out[0] * LANE * side];
            let id = node(self, at);
            edge(self, street, id);
            edge(self, id, street);
            spots.push(Spot { node: id, pose: Pose { at, heading }, windows: Vec::new() });
        }
        Some(Lot { gate, shape: Default::default(), spots, way: Way::Driveway { door, street }, nodes, edges, doorway: Vec::new(), stats: Stats::default() })
    }

    /// The bays at the kerb before these tiles: on a street (not a through
    /// road) running straight past a tile, a quarter tile either side of
    /// the street node beside it, where the street runs straight on to
    /// the next node too: clear of junctions, bends and ends. A car is
    /// driven along the kerb on its right; on a one-way street, on
    /// whichever side it is.
    pub fn kerb_bays(&self, tiles: &[GridCoord]) -> Vec<KerbBay> {
        let mut bays = Vec::new();
        for &t in tiles {
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                // The street beside the tile, running along (ux, uy).
                let r = GridCoord { x: t.x + dx, y: t.y + dy };
                let (ux, uy) = (dy.abs(), dx.abs());
                let Some(here) = self.road_node_at(r).filter(|&n| self.runs_straight(n, (ux, uy))) else { continue };
                for s in [-1, 1] {
                    let Some(next) = self
                        .road_node_at(GridCoord { x: r.x + s * ux, y: r.y + s * uy })
                        .filter(|&n| self.runs_straight(n, (ux, uy)) && self.arms_of(here, false).contains(&n))
                    else {
                        continue;
                    };
                    // Driven the way that has this kerb on its right, if
                    // the street runs that way; ahead is `next` when that
                    // is the way from `here` to it.
                    let (mut vx, mut vy) = (-dy, dx);
                    let mut way = if (vx, vy) == (s * ux, s * uy) { (here, next) } else { (next, here) };
                    if !self.edges.contains_key(&way) {
                        (vx, vy, way) = (-vx, -vy, (way.1, way.0));
                    }
                    if !self.edges.contains_key(&way) {
                        continue;
                    }
                    // From the entry's middle: `along` it, `out` toward the kerb.
                    let e = if way.0 == here { r } else { GridCoord { x: r.x + s * ux, y: r.y + s * uy } };
                    let p = |along: f64, out: f64| [e.x as f64 + 0.5 + vx as f64 * along - dx as f64 * out, e.y as f64 + 0.5 + vy as f64 * along - dy as f64 * out];
                    let far = way.0 != here;
                    let d = if far { 1.0 - BAY_AT } else { BAY_AT };
                    let (lead, backs) = if far { (vec![p(d - 0.4, KERB)], 0) } else { (vec![p(d + 0.4, KERB_LANE), p(d + 0.25, KERB)], 2) };
                    bays.push(KerbBay { pose: Pose { at: p(d, KERB), heading: (vy as f64).atan2(vx as f64) }, entry: way.0, exit: way.1, lead, backs });
                }
            }
        }
        bays
    }

    /// A street node the street runs straight through along (ux, uy): its
    /// two arms the two nodes either side, and nothing else, and no
    /// building on it.
    fn runs_straight(&self, node: EntityId, (ux, uy): (i32, i32)) -> bool {
        let Some(p) = self.objects.get(node).and_then(|e| e.position) else { return false };
        let mut arms = self.arms_of(node, false);
        arms.sort_unstable();
        arms.dedup();
        self.is_street(node)
            && arms.len() == 2
            && arms.iter().all(|&a| self.objects.get(a).and_then(|e| e.position).is_some_and(|q| (q.x - p.x, q.y - p.y) == (ux, uy) || (q.x - p.x, q.y - p.y) == (-ux, -uy)))
    }

    /// A depot's yard, in its own frame: u along the frontage from the
    /// left end, v in from the street. The door's tile centre is on the
    /// lane; the lane runs from it past every dock's mouth and stop
    /// point; each dock is a node at the wall where a docked lorry's cab
    /// stands. The frame is mirrored when the door is at the right end,
    /// so a lorry always drives past its bay and backs in from beyond it.
    fn build_yard(
        &mut self,
        gate: (GridCoord, EntityId),
        door: EntityId,
        tiles: &[GridCoord],
        kind: crate::protocol::BuildingKind,
        facing: u8,
        mut node: impl FnMut(&mut World, [f64; 2]) -> EntityId,
        mut edge: impl FnMut(&mut World, EntityId, EntityId),
    ) -> Option<Lot> {
        let street = gate.1;
        let (pos, p) = World::lie(tiles, kind, facing);
        let ((lx, ly), (gw, gh)) = p.lot?;
        let lot = GridCoord { x: pos.x + lx as i32, y: pos.y + ly as i32 };
        let (dx, dy) = FACINGS[facing as usize % 4];
        let along_x = dx == 0;
        let (w, d) = if along_x { (gw as f64, gh as f64) } else { (gh as f64, gw as f64) };
        // u along the frontage, v in from the street's edge of the lot.
        let grid_at = move |u: f64, v: f64| -> [f64; 2] {
            match (dx, dy) {
                (0, -1) => [lot.x as f64 + u, lot.y as f64 + v],
                (0, 1) => [lot.x as f64 + u, (lot.y + gh as i32) as f64 - v],
                (1, 0) => [(lot.x + gw as i32) as f64 - v, lot.y as f64 + u],
                _ => [lot.x as f64 + v, lot.y as f64 + u],
            }
        };
        let dpos = self.node_pos(door)?;
        let u_gate = if along_x { dpos[0] - lot.x as f64 } else { dpos[1] - lot.y as f64 };
        let mirrored = u_gate > w / 2.0;
        let world_at = move |u: f64, v: f64| grid_at(if mirrored { w - u } else { u }, v);
        let u_gate = if mirrored { w - u_gate } else { u_gate };

        let n = ((w - 2.0 * BAY_MARGIN) / BAY_W + 1e-9).floor() as usize;
        let us: Vec<f64> = (0..n).map(|i| BAY_MARGIN + BAY_W / 2.0 + i as f64 * BAY_W).collect();
        let lane_v = 0.5;
        let dock_v = d + WALL - crate::car::tail(crate::protocol::CarRole::Truck);
        // Stations along the lane, in order from the door: each dock's
        // mouth, and its stop point half a lorry beyond.
        let mut stations: Vec<(f64, usize, bool)> = Vec::new();
        for (i, &u) in us.iter().enumerate() {
            stations.push((u, i, true));
            stations.push((u + 0.5, i, false));
        }
        stations.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let mut lane = vec![door];
        let mut bays = vec![(0usize, 0usize); n];
        for &(u, i, mouth) in &stations {
            let id = node(self, world_at(u, lane_v));
            if mouth {
                bays[i].0 = lane.len();
            } else {
                bays[i].1 = lane.len();
            }
            lane.push(id);
        }
        let _ = u_gate;
        for pair in lane.windows(2) {
            edge(self, pair[0], pair[1]);
            edge(self, pair[1], pair[0]);
        }
        let mut spots = Vec::new();
        for (i, &u) in us.iter().enumerate() {
            let at = world_at(u, dock_v);
            let out = world_at(u, dock_v - 1.0);
            let id = node(self, at);
            edge(self, lane[bays[i].0], id);
            edge(self, id, lane[bays[i].0]);
            spots.push(Spot { node: id, pose: Pose { at, heading: (out[1] - at[1]).atan2(out[0] - at[0]) }, windows: Vec::new() });
        }
        Some(Lot { gate, shape: Default::default(), spots, way: Way::Yard { lane, bays, street }, nodes: Vec::new(), edges: Vec::new(), doorway: Vec::new(), stats: Stats::default() })
    }

    /// Take a building's lot out of the world; whoever was parked in it is
    /// parked nowhere.
    pub fn drop_lot(&mut self, building: EntityId) {
        for (car, ..) in self.drop_run(building) {
            self.set_spot(car, None);
        }
    }

    /// Take a lot down, and say who held what in it, and when.
    fn drop_run(&mut self, building: EntityId) -> Vec<(EntityId, Claim, GameTime, GameTime)> {
        let Some(lot) = self.lots.remove(&building) else { return Vec::new() };
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
        for &car in &lot.doorway {
            self.claims.remove(&car);
            held.push((car, Claim::Door, 0, GameTime::MAX));
        }
        held
    }

    /// After a lot is rebuilt: everyone who held something holds it again,
    /// the nearest spot free to where they stood, and parked cars are drawn
    /// where they now stand.
    fn reseat(&mut self, building: EntityId, held: Vec<(EntityId, Claim, GameTime, GameTime)>) {
        for (car, claim, from, to) in held {
            let (was, parked) = match self.objects.get(car).map(|e| &e.object) {
                Some(GameObject::Car(c)) => (c.spot, c.trip.is_none()),
                _ => continue,
            };
            let claim = match claim {
                Claim::Door => Claim::Door,
                Claim::Spot(_) => self.nearest_free(building, car, was, from, to).unwrap_or(Claim::Door),
            };
            self.hold(building, car, claim, from, to);
            if parked {
                let pose = self.pose_of(building, claim);
                self.set_spot(car, pose);
            }
        }
    }

    /// The spot nearest a pose that is clear over a window.
    fn nearest_free(&self, building: EntityId, car: EntityId, near: Option<Pose>, from: GameTime, to: GameTime) -> Option<Claim> {
        self.lots[&building]
            .spots
            .iter()
            .enumerate()
            .filter(|(_, s)| s.clear_from(car, from, to.saturating_sub(from)) == from)
            .min_by(|(_, a), (_, b)| dist(a.pose, near).total_cmp(&dist(b.pose, near)))
            .map(|(i, _)| Claim::Spot(i))
    }

    fn hold(&mut self, building: EntityId, car: EntityId, claim: Claim, from: GameTime, to: GameTime) {
        let lot = self.lots.get_mut(&building).unwrap();
        match claim {
            Claim::Spot(i) => {
                let ws = &mut lot.spots[i].windows;
                let at = ws.partition_point(|w| w.from <= from);
                ws.insert(at, Window { car, from, to });
            }
            Claim::Door => lot.doorway.push(car),
        }
        self.claims.insert(car, building);
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

    /// Where a claim stands: a spot's own pose. A door is not drawn.
    fn pose_of(&self, building: EntityId, claim: Claim) -> Option<Pose> {
        match claim {
            Claim::Spot(i) => Some(self.lots.get(&building)?.spots[i].pose),
            Claim::Door => None,
        }
    }

    fn claim_of(&self, building: EntityId, car: EntityId) -> Option<Claim> {
        let lot = self.lots.get(&building)?;
        if lot.doorway.contains(&car) {
            return Some(Claim::Door);
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
    /// already holds; the door in a yard for anything but a lorry; else a
    /// spot clear for the whole window, and one it can drive into, near the
    /// door with some looseness, as people park; else the door. `None` only where a
    /// yard's docks are all taken: the lorry's trip does not start, and it
    /// waits where it is, honestly, and tries again.
    pub fn claim_spot(&mut self, building: EntityId, car: EntityId, from: GameTime, to: GameTime, usable: impl Fn(usize) -> bool) -> Option<Claim> {
        self.lot_mut(building)?;
        let lot = &self.lots[&building];
        let yard = matches!(lot.way, Way::Yard { .. });
        // A yard has docks, not car spots: a lorry takes one, its own
        // depot's included, and anything else stops at the door.
        let door_only = yard && !self.is_lorry(car);
        let len = to.saturating_sub(from);
        // The spot in front of the door is the one wanted, but not by
        // everyone: each free spot's distance to the door is stretched by
        // up to a spot's worth, drawn per visit.
        let door = Some([lot.gate.0.x as f64 + 0.5, lot.gate.0.y as f64 + 0.5]);
        let mut rng = SmallRng::seed_from_u64(self.terrain_seed as u64 ^ car.rotate_left(32) ^ from);
        let mut appeal = |i: usize| -> f64 {
            let at = lot.spots[i].pose.at;
            let d = door.map_or(0.0, |[x, y]| ((at[0] - x).powi(2) + (at[1] - y).powi(2)).sqrt());
            d + rng.random::<f64>() * 2.0 * LANE
        };
        let claim = self
            .claim_of(building, car)
            .or_else(|| door_only.then_some(Claim::Door))
            .or_else(|| {
                (0..lot.spots.len())
                    .filter(|&i| usable(i) && lot.spots[i].clear_from(car, from, len) == from)
                    .map(|i| (i, appeal(i)))
                    .min_by(|a, b| a.1.total_cmp(&b.1))
                    .map(|(i, _)| Claim::Spot(i))
            })
            .or_else(|| (!yard).then_some(Claim::Door));
        let Some(claim) = claim else {
            self.lots.get_mut(&building).unwrap().stats.refused += 1;
            return None;
        };
        // Only now, with the new place found, is the old one let go of.
        if self.claims.get(&car) != Some(&building) || self.claim_of(building, car) != Some(claim) {
            self.release_spot(car);
            self.hold(building, car, claim, from, to);
        }
        Some(claim)
    }

    /// A depot's own vehicle, lorry or van: what takes a dock.
    fn is_lorry(&self, car: EntityId) -> bool {
        matches!(self.objects.get(car).map(|e| &e.object), Some(GameObject::Car(c)) if c.role != crate::protocol::CarRole::Private)
    }

    /// Let go of whatever the car holds.
    pub fn release_spot(&mut self, car: EntityId) {
        if let Some(building) = self.claims.remove(&car)
            && let Some(lot) = self.lots.get_mut(&building)
        {
            for s in &mut lot.spots {
                s.windows.retain(|w| w.car != car);
            }
            lot.doorway.retain(|&c| c != car);
        }
        self.set_spot(car, None);
    }

    /// Stand the car in its place at the building. It usually holds one
    /// from setting out; if not it takes one now, open-ended. A spot still
    /// taken on arrival, by a car that stayed longer than it planned, is
    /// swapped for any free one, or the car is squeezed to the door.
    pub fn park_in_lot(&mut self, building: EntityId, car: EntityId, now: GameTime) {
        let Some(claim) = self.claim_spot(building, car, now, GameTime::MAX, |_| true) else {
            // Nothing here to hold: the edge, which has no lot at all, or a
            // yard with no dock left. Either way the car is here now, so
            // whatever it was still holding somewhere else is let go of —
            // or it would leave by that lot's way out, from a building it
            // is not at.
            self.release_spot(car);
            return;
        };
        if let Claim::Spot(i) = claim {
            let taken = self.lots[&building].spots[i].windows.iter().any(|w| w.car != car && self.parked_here(w.car));
            if taken {
                let to = self.lots[&building].spots[i].holder(car).map_or(GameTime::MAX, |w| w.to);
                self.release_spot(car);
                let lot = self.lots.get_mut(&building).unwrap();
                let free = (0..lot.spots.len()).find(|&j| lot.spots[j].clear_from(car, now, to.saturating_sub(now)) == now);
                match free {
                    Some(j) => self.hold(building, car, Claim::Spot(j), now, to),
                    None => {
                        lot.stats.squeezed += 1;
                        self.hold(building, car, Claim::Door, now, to);
                    }
                }
            }
        }
        let claim = self.claim_of(building, car).unwrap();
        let pose = self.pose_of(building, claim);
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
        let parked = lot.spots.iter().filter(|s| s.windows.iter().any(|w| w.from <= now && now < w.to)).count();
        json!({
            "now": hhmm(now),
            "door": [lot.gate.0.x, lot.gate.0.y],
            "spots": spots.len(),
            "held_now": parked,
            "at_doors": lot.doorway.len(),
            "refused": lot.stats.refused,
            "squeezed": lot.stats.squeezed,
            "spot_windows": spots,
        })
    }


    /// The way from where the car stands to the street: its lot nodes in
    /// order, and the street node last.
    pub fn way_out(&self, car: EntityId) -> Option<Vec<EntityId>> {
        let building = *self.claims.get(&car)?;
        let lot = self.lots.get(&building)?;
        let claim = self.claim_of(building, car)?;
        Some(match (&lot.way, claim) {
            (Way::Driveway { street, .. }, Claim::Spot(i)) => vec![lot.spots[i].node, *street],
            (Way::Driveway { door, street }, Claim::Door) => vec![*door, *street],
            // Out of the dock forward, back along the lane to the door.
            (Way::Yard { lane, bays, street }, Claim::Spot(i)) => {
                let mut v = vec![lot.spots[i].node];
                v.extend(lane[..=bays[i].0].iter().rev());
                v.push(*street);
                v
            }
            (Way::Yard { lane, street, .. }, Claim::Door) => vec![lane[0], *street],
            (Way::Kerb { bays, .. }, Claim::Spot(i)) => vec![lot.spots[i].node, bays[i].exit],
            (Way::Kerb { door, street, .. }, Claim::Door) => vec![*door, *street],
        })
    }

    /// The ways from a node to a building, claiming nothing: the street
    /// route to its door, and to the entry of each kerb bay. `None` where
    /// no road leads there.
    pub fn ways_to(&mut self, building: EntityId, from: EntityId) -> Option<Ways> {
        let to = self.approach(building)?;
        let entries: Vec<EntityId> = match self.lots.get(&building).map(|l| &l.way) {
            Some(Way::Kerb { bays, .. }) => bays.iter().map(|b| b.entry).collect(),
            _ => Vec::new(),
        };
        let mut routes = crate::world::pathfinding::Routes::from(self, from);
        let street = routes.route_to(to).filter(|r| r.len() >= 2)?;
        let bays = entries.into_iter().filter_map(|e| Some((e, routes.route_to(e).filter(|r| r.len() >= 2)?))).collect();
        Some(Ways { street, bays })
    }

    /// The whole way into a place at the building for this car, claiming
    /// one: the street route, then the lot nodes to the place, and how many
    /// of those there are. A kerb bay is taken only where the street route
    /// to it arrives from behind it, not turning back from the node ahead.
    /// `None` when there is no place, and the trip does not start.
    pub fn way_in(&mut self, building: EntityId, car: EntityId, ways: &Ways, from: GameTime, to: GameTime) -> Option<(Vec<EntityId>, usize)> {
        // Nothing to pull into: the road is the whole of it. That is the
        // edge; for anything the road never reached it is no way in at all,
        // and the trip is refused as before.
        if self.lot_mut(building).is_none() {
            return Some((ways.street.clone(), 0));
        }
        let kerb: Vec<(EntityId, EntityId)> = match &self.lots[&building].way {
            Way::Kerb { bays, .. } => bays.iter().map(|b| (b.entry, b.exit)).collect(),
            _ => Vec::new(),
        };
        let usable = |i: usize| kerb.get(i).is_none_or(|&(e, x)| ways.bays.get(&e).is_some_and(|r| r[r.len() - 2] != x));
        let claim = self.claim_spot(building, car, from, to, usable)?;
        let lot = self.lots.get(&building)?;
        let (path, lot_nodes): (&[EntityId], Vec<EntityId>) = match (&lot.way, claim) {
            (Way::Driveway { .. }, Claim::Spot(i)) => (&ways.street, vec![lot.spots[i].node]),
            (Way::Driveway { door, .. } | Way::Kerb { door, .. }, Claim::Door) => (&ways.street, vec![*door]),
            // Along the lane past the mouth to the stop point, then back
            // to the mouth and into the dock: the last two edges in reverse.
            (Way::Yard { lane, bays, .. }, Claim::Spot(i)) => {
                let (mouth, stop) = bays[i];
                let mut v: Vec<EntityId> = lane[..=stop].to_vec();
                v.push(lane[mouth]);
                v.push(lot.spots[i].node);
                (&ways.street, v)
            }
            (Way::Yard { lane, .. }, Claim::Door) => (&ways.street, vec![lane[0]]),
            (Way::Kerb { bays, .. }, Claim::Spot(i)) => (ways.bays.get(&bays[i].entry)?, bays[i].path.clone()),
        };
        let n = lot_nodes.len();
        Some((path.iter().copied().chain(lot_nodes).collect(), n))
    }

    /// The node a street route to this building ends at: the street node
    /// its door opens onto — and for something with no lot at all, the
    /// road it stands on.
    pub fn approach(&mut self, building: EntityId) -> Option<EntityId> {
        match self.lot_mut(building) {
            Some(Lot { way: Way::Driveway { street, .. } | Way::Yard { street, .. } | Way::Kerb { street, .. }, .. }) => Some(*street),
            None => self.street_of(building),
        }
    }

    /// How many edges at the start of the car's way out are driven
    /// backwards: one off a drive, onto the street; none anywhere else.
    pub fn backs_out(&self, car: EntityId) -> usize {
        let Some(&building) = self.claims.get(&car) else { return 0 };
        match (self.lots.get(&building).map(|l| &l.way), self.claim_of(building, car)) {
            (Some(Way::Driveway { .. }), Some(Claim::Spot(_))) => 1,
            _ => 0,
        }
    }

    /// How many edges at the end of the car's way in are driven backwards:
    /// two into a dock, or into a kerb bay too close to its entry to pull
    /// into; none anywhere else.
    pub fn reverse_tail(&self, car: EntityId) -> usize {
        let Some(&building) = self.claims.get(&car) else { return 0 };
        match (self.lots.get(&building).map(|l| &l.way), self.claim_of(building, car)) {
            (Some(Way::Yard { .. }), Some(Claim::Spot(_))) => 2,
            (Some(Way::Kerb { bays, .. }), Some(Claim::Spot(i))) => bays[i].backs,
            _ => 0,
        }
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
    /// a pose at a yard is at its door.
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
            let claim = match pose {
                Some(_) => self.nearest_free(building, car, pose, 0, GameTime::MAX),
                None => matches!(self.lots[&building].way, Way::Yard { .. }).then_some(Claim::Door),
            };
            match claim {
                Some(claim) => {
                    self.hold(building, car, claim, 0, GameTime::MAX);
                    let pose = self.pose_of(building, claim);
                    self.set_spot(car, pose);
                }
                None => self.set_spot(car, None),
            }
        }
    }
}

/// A kind with a yard (`Blueprint::lot`): its lorries' docks.
fn is_yard(kind: crate::protocol::BuildingKind) -> bool {
    crate::blueprint::blueprint(kind).lot.1 > 0
}

/// A kind that parks at the kerb: anything with neither a yard nor a
/// house's drive.
fn kerbed(kind: crate::protocol::BuildingKind) -> bool {
    kind != crate::protocol::BuildingKind::House && !is_yard(kind)
}

fn dist(a: Pose, b: Option<Pose>) -> f64 {
    match b {
        Some(b) => (a.at[0] - b.at[0]).powi(2) + (a.at[1] - b.at[1]).powi(2),
        None => f64::MAX,
    }
}

/// Every building's lot, by the building.
pub type Lots = HashMap<EntityId, Lot>;

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

    /// A car that finds the drive full stops at the door, unseen, rather
    /// than not setting out: until the kerb has bays, that is where the
    /// rest of a building's visitors stand.
    #[test]
    fn a_full_drive_leaves_the_rest_at_the_door() {
        let mut world = street();
        let house = world.place_on_street(GridCoord { x: 2, y: 1 }, BuildingKind::House).unwrap();
        assert_eq!(world.lot_mut(house).unwrap().spots.len(), 2);
        let car = |world: &mut World| world.insert_at(GameObject::Car(crate::protocol::Car::new(0, Default::default())), None);
        let (a, b, c) = (car(&mut world), car(&mut world), car(&mut world));
        assert!(matches!(world.claim_spot(house, a, 10_000, 12_000, |_| true), Some(Claim::Spot(_))));
        assert!(matches!(world.claim_spot(house, b, 10_000, 12_000, |_| true), Some(Claim::Spot(_))));
        assert_eq!(world.claim_spot(house, c, 10_000, 11_000, |_| true), Some(Claim::Door), "the third stops at the door");
        world.release_spot(c);
        assert!(matches!(world.claim_spot(house, c, 12_000, 13_000, |_| true), Some(Claim::Spot(_))), "and after them, it has a spot");
    }

    /// A shop parks at the kerb before it: two bays, a quarter tile either
    /// side of the street node beside it, wholly off the road on its side,
    /// facing the way the lane beside them runs. A car coming along that
    /// lane pulls into one; a car coming the other way would have to turn
    /// back into it, and takes the other kerb's or the door.
    #[test]
    fn a_shop_parks_at_the_kerb_before_it() {
        let mut world = street();
        let shop = world.place_on_street(GridCoord { x: 2, y: 1 }, BuildingKind::Shop).unwrap();
        let mut at: Vec<[f64; 2]> = world.lot_mut(shop).unwrap().spots.iter().map(|s| s.pose.at).collect();
        at.sort_by(|a, b| a[0].total_cmp(&b[0]));
        assert_eq!(at.len(), 2, "two bays to a tile: {at:?}");
        for (bay, x) in at.iter().zip([2.25, 2.75]) {
            assert!((bay[0] - x).abs() < 1e-9 && (bay[1] - (0.5 + KERB)).abs() < 1e-9, "a bay at {bay:?}");
        }
        assert!(world.lot_mut(shop).unwrap().spots.iter().all(|s| s.pose.heading.abs() < 1e-9), "facing east, the way the lane on that side runs");

        let car = |world: &mut World| world.insert_at(GameObject::Car(crate::protocol::Car::new(0, Default::default())), None);
        let (west, east) = (world.road_node_at(GridCoord { x: -2, y: 0 }).unwrap(), world.road_node_at(GridCoord { x: 20, y: 0 }).unwrap());
        // From the west, along the lane beside the bays: into each, from
        // the street node behind it. The far bay is pulled into, along the
        // kerb's line at the last; the near one, a quarter tile on, backed
        // into from the lane past it.
        let mut bays = Vec::new();
        let mut first = None;
        for _ in 0..2 {
            let a = car(&mut world);
            first.get_or_insert(a);
            let ways = world.ways_to(shop, west).unwrap();
            let (route, to_lot) = world.way_in(shop, a, &ways, 0, GameTime::MAX).unwrap();
            let (entry, bay) = (world.node_pos(route[route.len() - 1 - to_lot]).unwrap(), world.node_pos(route[route.len() - 1]).unwrap());
            assert!(entry[0] < bay[0] && (entry[1] - 0.5).abs() < 1e-9, "driven into from behind: {entry:?} to {bay:?}");
            let lead = world.node_pos(route[route.len() - 2]).unwrap();
            if bay[0] - entry[0] > 0.5 {
                assert_eq!((to_lot, world.reverse_tail(a)), (2, 0));
                assert!(lead[0] < bay[0] && (lead[1] - bay[1]).abs() < 1e-9, "straightening on the kerb: {lead:?}");
            } else {
                assert_eq!((to_lot, world.reverse_tail(a)), (3, 2));
                let past = world.node_pos(route[route.len() - 3]).unwrap();
                assert!(past[0] > bay[0] && past[1] < bay[1] - 0.15, "past it on the lane: {past:?}");
            }
            bays.push(bay);
        }
        bays.sort_by(|a, b| a[0].total_cmp(&b[0]));
        assert_eq!(bays, at, "one car in each bay");
        let a = first.unwrap();
        // From the east, the bays are across the road and behind a turn:
        // the door.
        let b = car(&mut world);
        let ways = world.ways_to(shop, east).unwrap();
        let (route, _) = world.way_in(shop, b, &ways, 0, GameTime::MAX).unwrap();
        assert_eq!(world.claim_of(shop, b), Some(Claim::Door), "the far kerb's bays are not this shop's: {route:?}");
        // Out of the bay, forward, onto the street node ahead of it.
        world.park_in_lot(shop, a, 0);
        let out = world.way_out(a).unwrap();
        assert_eq!(out.len(), 2);
        let parked = world.node_pos(out[0]).unwrap();
        assert!(world.node_pos(out[1]).unwrap()[0] > parked[0], "out ahead");
        assert_eq!(world.backs_out(a), 0);
    }

    /// A depot's lot is a yard: docks against the wall, a lorry backing
    /// into its own from beyond its mouth and leaving forward, and nothing
    /// beside it joins its slab.
    #[test]
    fn a_depot_has_docks_a_lorry_backs_into() {
        let mut world = street();
        let depot = world.place_on_street(GridCoord { x: 4, y: 1 }, BuildingKind::Warehouse).unwrap();
        let shop = world.place_on_street(GridCoord { x: 6, y: 1 }, BuildingKind::Shop).unwrap();
        assert_eq!(world.lot_mut(depot).unwrap().spots.len(), 4, "four docks across two tiles");
        world.lot_mut(shop).unwrap();
        // One of the depot's own lorries, in its dock since the depot was reached.
        let lorry = world.objects.iter().find(|e| matches!(e.object, GameObject::Car(ref c) if c.owner == depot && c.role == crate::protocol::CarRole::Truck)).map(|e| e.id).unwrap();
        world.release_spot(lorry);
        let ways = world.ways_to(depot, world.road_node_at(GridCoord { x: 30, y: 0 }).unwrap()).unwrap();
        let (way, _) = world.way_in(depot, lorry, &ways, 0, GameTime::MAX).unwrap();
        assert_eq!(world.reverse_tail(lorry), 2, "the last two edges are driven backwards");
        let n = way.len();
        let (stop, mouth, dock) = (world.node_pos(way[n - 3]).unwrap(), world.node_pos(way[n - 2]).unwrap(), world.node_pos(way[n - 1]).unwrap());
        assert!((stop[1] - mouth[1]).abs() < 1e-9 && (stop[0] - mouth[0]).abs() > 0.4, "the stop point is on the lane beyond the mouth: {stop:?} {mouth:?}");
        assert!((dock[0] - mouth[0]).abs() < 1e-9 && dock[1] > mouth[1] + 0.5, "the dock is straight in from the mouth: {dock:?}");
        world.park_in_lot(depot, lorry, 0);
        let out = world.way_out(lorry).unwrap();
        assert_eq!(out[0], way[n - 1], "out of the dock");
        assert_eq!(out[1], way[n - 2], "forward to the mouth");
        assert_eq!(world.reverse_tail(lorry), 2);
        // Staff at a depot stop at the door: a yard has no car spots.
        let car = world.insert_at(GameObject::Car(crate::protocol::Car::new(0, Default::default())), None);
        assert_eq!(world.claim_spot(depot, car, 0, GameTime::MAX, |_| true), Some(Claim::Door));
    }

    /// A house's car drives onto its driveway nose first, stands facing the
    /// house, and backs out onto the street when it leaves: the first edge
    /// of the trip out is driven backwards, and then it drives on.
    #[test]
    fn a_car_backs_out_of_its_driveway() {
        let mut world = street();
        let house = world.place_on_street(GridCoord { x: 6, y: 1 }, BuildingKind::House).unwrap();
        let depot = world.place_on_street(GridCoord { x: 20, y: 1 }, BuildingKind::Warehouse).unwrap();
        let car = world.insert_at(GameObject::Car(crate::protocol::Car::new(0, Default::default())), None);
        let ways = world.ways_to(house, world.road_node_at(GridCoord { x: 30, y: 0 }).unwrap()).unwrap();
        let (way, _) = world.way_in(house, car, &ways, 0, GameTime::MAX).unwrap();
        let door = world.door_of(house).unwrap().0;
        let driveway = [door.x as f64 + 0.5, door.y as f64 + 0.5];
        let spot = world.node_pos(way[way.len() - 1]).unwrap();
        world.park_in_lot(house, car, 0);
        let pose = match world.objects.get(car).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.spot.unwrap(),
            _ => unreachable!(),
        };
        let (dx, dy) = (driveway[0] - spot[0], driveway[1] - spot[1]);
        assert!(pose.heading.cos() * dx + pose.heading.sin() * dy > 0.0, "parked facing the house, the way it drove in");
        assert_eq!(world.backs_out(car), 1, "backed off the driveway");
        let mut events = crate::engine::event_queue::EventQueue::new();
        let street = world.approach(house).unwrap();
        assert!(crate::car::spawn::start_trip(&mut world, &mut events, car, street, depot, 0, GameTime::MAX));
        let trip = match world.objects.get(car).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.trip.clone().unwrap(),
            _ => unreachable!(),
        };
        assert_eq!(trip.backing, vec![[0, 1]], "the first edge backwards, the rest forward");
    }

}
