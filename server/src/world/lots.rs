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
//! a farm and a port keep a yard, laid alike (`park`): a lane straight in
//! from a gate in the middle of its front, and docks either side that a
//! lorry backs into. Everything else parks at the kerb before it: bays along
//! the streets its tiles front, two to a tile a side, a car pulling in
//! from the lane beside them, or across the road coming the other way,
//! and out ahead. A car that finds no place
//! stops at the door, unseen. See `docs/parking.md`.

use rand::{Rng, SeedableRng};
use crate::fixed::SmallRng;
use crate::fixed::HashMap;

use crate::blueprint::FACINGS;
use crate::engine::GameTime;
use crate::protocol::{EntityId, GameObject, GridCoord, Pose};
use serde_json::{json, Value};
use crate::world::World;
use crate::world::bezier::LANE_OFFSET;
use crate::world::segments::EdgeSegment;

/// A driveway spot: how far out from the plot's centre a car's centre
/// stands, wholly before the house's front wall and short of the road, and
/// half the gap between the two cars (`DRIVE_OUT` and `DRIVE_LANE` in the
/// client's `dressing.ts`, which draws the drive).
const SPOT_OUT: f64 = 0.47;
const LANE: f64 = 0.11;
/// A kerb bay along the kerb: how far a parked car's middle is from its
/// street's middle line, wholly off the road, and how far apart the bays
/// are along it, a car and room to get in and out (a bay's length). The
/// client paves them from the same numbers (`town/surface.ts`).
const KERB: f64 = 0.305;
const ALONG_PITCH: f64 = 0.42;
/// A bay square to the kerb: its middle this far from the street's middle
/// line, the car's tail at the road's edge, so a strip of pavement is left
/// between it and the building; how far apart, a car and a door's swing (a bay's width); and the
/// radius a car turns into it on, the tightest it turns (`TIGHTEST` in
/// `paths.ts`).
const SQUARE: f64 = 0.37;
const SQUARE_PITCH: f64 = 0.27;
const TURN: f64 = 0.45;
/// Bays keep this far in from the ends of a building's side
/// (`BAY_INSET` in the client's `surface.ts`).
const WALL_INSET: f64 = 0.2;

/// How many bays a side `len` tiles long holds, within its walls.
fn bays_along(len: usize, square: bool) -> usize {
    let pitch = if square { SQUARE_PITCH } else { ALONG_PITCH };
    ((len as f64 - 2.0 * WALL_INSET) / pitch + 1e-9).floor().max(0.0) as usize
}

/// The four ways out of a building.
pub const SIDES: [(i32, i32); 4] = [(0, -1), (1, 0), (0, 1), (-1, 0)];

/// A building's tiles that face the way (dx, dy), nothing of its own
/// beyond them, in order along that side.
pub fn side_of(tiles: &[GridCoord], (dx, dy): (i32, i32)) -> Vec<GridCoord> {
    let mut run: Vec<GridCoord> = tiles.iter().copied().filter(|t| !tiles.contains(&GridCoord { x: t.x + dx, y: t.y + dy })).collect();
    run.sort_by_key(|t| t.x * dy.abs() + t.y * dx.abs());
    run
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
    /// Which way into a kerb bay the car takes, and so which way it faces
    /// in it and leaves it (`KerbWay::sides`); 0 anywhere else.
    pub side: usize,
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
    /// A yard (`park`): a two-way lane straight in from the door, its
    /// gate, and docks either side of it, each a spot, entered by backing
    /// in from where a lorry pulls up for it and left forward. `lane`
    /// runs from the door inward; a bay is its mouth, an index on it, and
    /// the node where a lorry pulls up for it. A harbour's lane runs down to its ramp, and on
    /// from it onto the moored ferry's deck: `seats` are where a settler's
    /// car stands aboard, two to a slot, each with the node at the land
    /// end of its deck lane it drives off by.
    Yard { lane: Vec<EntityId>, bays: Vec<(usize, EntityId)>, street: EntityId, seats: Vec<[EntityId; 2]> },
    /// Bays at the kerb, a spot each; the door for a car with no bay.
    Kerb { door: EntityId, street: EntityId, bays: Vec<KerbWay> },
}

/// A kerb bay's ways in, from either end of the stretch it stands on.
struct KerbWay {
    sides: Vec<KerbSide>,
}

/// One way into a kerb bay and out: from the street node behind it, along
/// its lot nodes, the bay's last, the last `backs` edges in reverse; parked
/// facing `heading`; and out along its lot nodes, the first `out_backs`
/// edges in reverse, to the street node ahead.
#[derive(Clone, PartialEq, Debug)]
pub struct KerbSide {
    entry: EntityId,
    /// The street node after the entry toward the exit: a route arriving
    /// at the entry from it would be turning back.
    ahead: EntityId,
    exit: EntityId,
    lead: Vec<[f64; 2]>,
    backs: usize,
    heading: f64,
    out: Vec<[f64; 2]>,
    out_backs: usize,
    path: Vec<EntityId>,
    out_path: Vec<EntityId>,
}

/// A bay at the kerb, before one of a building's tiles: where a car in it
/// stands, and its ways in. Along the lane on its own side first, and then
/// from the far side of the road, as a driver does who comes the other way
/// on a quiet street: across, and parked facing against the traffic. A bay
/// three quarters along from where it is driven in from is pulled into,
/// straightening on the kerb's line; one a quarter along, too close to turn
/// into, is parked in as a driver would: past it, in the lane beside it, and
/// backed in.
#[derive(Clone, PartialEq, Debug)]
pub struct KerbBay {
    pub at: [f64; 2],
    pub sides: Vec<KerbSide>,
}

/// The ways from a node to a building: the street route to its door, and
/// to the entry of each of its kerb bays.
pub struct Ways {
    pub street: Vec<EntityId>,
    bays: HashMap<EntityId, Vec<EntityId>>,
}

/// A yard's docks, in rows in from its back up the lane, a flatbed's
/// width apart, the last just in from the gate: a yard is two tiles deep, so the
/// gate's middle is 1.5 in.
pub const DOCK_ROWS: [f64; 4] = [0.55, 0.85, 1.15, 1.45];
/// A docked lorry's cab, out from the lane's middle: its flatbed behind
/// it reaches to the yard's side, and the cab stands clear of the lane.
pub const DOCK_OUT: f64 = 0.9;
/// How far out from the lane's middle a docked flatbed reaches: a side of
/// the yard narrower than this has no docks.
const DOCK_REACH: f64 = 1.4;
/// How far past a dock's mouth, toward the back, a lorry pulls up to back
/// in.
pub const PAST: f64 = 0.5;
/// How far across the lane, away from its dock, a lorry swings as it pulls
/// up: it backs in from an angle, round a wide arc, not square from the
/// lane's middle.
const SWING: f64 = 0.4;

/// A yard's park, a harbour's and a depot's alike: a lane straight in
/// from the gate to the yard's back, and off it, on each of `sides`, a
/// row of docks, a docked lorry's cab facing the lane and its flatbed
/// behind it out to the yard's side. A lorry drives in to a dock's mouth,
/// swings across the lane away from it as it pulls up `PAST` beyond, and
/// backs in round a wide arc, as a driver sets up a lorry to back; it
/// leaves forward, up the lane to the gate. `at(s, side)` is a point `s`
/// in from the back and `side` out from the lane's middle. The lane's
/// points in order from the gate, each row's mouth and, last, the back
/// row's stop; and the docks, both sides of each row, with the lane point
/// of their mouth and where a lorry pulls up to back into them.
pub fn park(at: impl Fn(f64, f64) -> [f64; 2], sides: &[f64]) -> (Vec<[f64; 2]>, Vec<(Pose, usize, [f64; 2])>) {
    let back = DOCK_ROWS.iter().copied().fold(f64::MAX, f64::min) - PAST;
    let mut lane: Vec<[f64; 2]> = DOCK_ROWS.iter().rev().map(|&s| at(s, 0.0)).collect();
    lane.push(at(back, 0.0));
    let docks = DOCK_ROWS
        .iter()
        .rev()
        .enumerate()
        .flat_map(|(mouth, &s)| {
            let at = &at;
            sides.iter().map(move |&side| {
                let p = at(s, side * DOCK_OUT);
                let toward = at(s, 0.0);
                (Pose { at: p, heading: (toward[1] - p[1]).atan2(toward[0] - p[0]) }, mouth, at(s - PAST, -side * SWING))
            })
        })
        .collect();
    (lane, docks)
}

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

impl Lot {
    /// Which way into spot `i` this car takes: its window's side.
    fn side(&self, i: usize, car: EntityId) -> usize {
        self.spots[i].holder(car).map_or(0, |w| w.side)
    }
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
        let kerb = if kerbed(kind) { self.kerb_bays(&tiles, kind, self.door_way(gate)) } else { Vec::new() };
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
            world.edges.insert((a, b), EdgeSegment::new(1));
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
            for mut bay in self.kerb_bays(&tiles, kind, self.door_way(gate)) {
                let id = node(self, bay.at);
                for side in &mut bay.sides {
                    for at in &side.lead {
                        let lead = node(self, *at);
                        edge(self, side.path.last().copied().unwrap_or(side.entry), lead);
                        side.path.push(lead);
                    }
                    edge(self, side.path.last().copied().unwrap_or(side.entry), id);
                    side.path.push(id);
                    for at in &side.out {
                        let back = node(self, *at);
                        edge(self, side.out_path.last().copied().unwrap_or(id), back);
                        side.out_path.push(back);
                    }
                    edge(self, side.out_path.last().copied().unwrap_or(id), side.exit);
                }
                spots.push(Spot { node: id, pose: Pose { at: bay.at, heading: bay.sides[0].heading }, windows: Vec::new() });
                bays.push(KerbWay { sides: bay.sides });
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

    /// The bays at the kerb before a building, as many as it needs: as many
    /// as its long side holds (`bays_along`), on the side its door opens
    /// onto first, then on the sides with a street all along them, the
    /// fullest first, until it has them. A side's bays lie evenly along it,
    /// within the building's walls, each on a street (not a through road)
    /// running straight past the tile it is before: clear of junctions,
    /// bends and ends. Flats park along the kerb; everything else nose in,
    /// square to the street, close to the road, a strip of pavement between
    /// the bays and the building, where a car can turn into it from the
    /// street: swung out to the middle of the road, a quarter turn in, and
    /// backed out round the same way. A car is driven along the kerb on its
    /// right first, and then from the far side of the road, as a driver does
    /// who comes the other way. The client lays the same (`baysAt` in
    /// `town/surface.ts`) and paves them.
    /// The side a door opens onto: the way from its tile to its street,
    /// if that is beside it.
    fn door_way(&self, (tile, street): (GridCoord, EntityId)) -> Option<(i32, i32)> {
        let s = self.objects.get(street)?.position?;
        Some((s.x - tile.x, s.y - tile.y)).filter(|&(dx, dy)| dx == 0 || dy == 0)
    }

    pub fn kerb_bays(&self, tiles: &[GridCoord], kind: crate::protocol::BuildingKind, door: Option<(i32, i32)>) -> Vec<KerbBay> {
        let square = kind != crate::protocol::BuildingKind::Apartment;
        let (w, h) = crate::blueprint::blueprint(kind).size;
        let need = bays_along(w.max(h) as usize, square);
        let mut sides: Vec<(bool, bool, Vec<KerbBay>)> = SIDES
            .iter()
            .map(|&d| {
                let run = side_of(tiles, d);
                (door != Some(d), !self.street_along(&run, d), self.bays_on(&run, d, square))
            })
            .collect();
        sides.sort_by_key(|(other, broken, bays)| (*other, *broken, std::cmp::Reverse(bays.len())));
        let mut bays = Vec::new();
        for (_, _, side) in sides {
            if bays.len() >= need {
                break;
            }
            bays.extend(side);
        }
        bays
    }

    /// Does a street run all along these tiles on the side (dx, dy), one
    /// street tile before each, each joined to the next?
    pub fn street_along(&self, run: &[GridCoord], (dx, dy): (i32, i32)) -> bool {
        let nodes: Vec<Option<EntityId>> = run.iter().map(|t| self.road_node_at(GridCoord { x: t.x + dx, y: t.y + dy }).filter(|&n| self.is_street(n))).collect();
        !run.is_empty() && nodes.iter().all(Option::is_some) && nodes.windows(2).all(|p| self.arms_of(p[0].unwrap(), false).contains(&p[1].unwrap()))
    }

    /// The bays along one side of a building, its tiles `run` in order
    /// along it, the street on the side (dx, dy).
    fn bays_on(&self, run: &[GridCoord], (dx, dy): (i32, i32), square: bool) -> Vec<KerbBay> {
        let mut bays = Vec::new();
        let (ux, uy) = (dy.abs(), dx.abs());
        let pitch = if square { SQUARE_PITCH } else { ALONG_PITCH };
        let n = bays_along(run.len(), square);
        for i in 0..n {
            // Along the side from its start, and the tile it is before.
            let u = run.len() as f64 / 2.0 + (i as f64 - (n as f64 - 1.0) / 2.0) * pitch;
            let k = (u.floor() as usize).min(run.len() - 1);
            let a = u - k as f64 - 0.5;
            let t = run[k];
            // The street beside the tile, running along (ux, uy).
            let r = GridCoord { x: t.x + dx, y: t.y + dy };
            let Some(here) = self.road_node_at(r).filter(|&n| self.runs_straight(n, (ux, uy))) else { continue };
            let along = |s: i32| self.road_node_at(GridCoord { x: r.x + s * ux, y: r.y + s * uy }).filter(|&n| self.arms_of(here, false).contains(&n));
            // The way that has this kerb on its right.
            let (vx, vy) = (-dy, dx);
            // The street node behind the bay and ahead of it, driven the way
            // with the kerb on its right.
            let (e0, x0) = if square {
                let (Some(back), Some(on)) = (along(-1), along(1)) else { continue };
                if (vx, vy) == (ux, uy) { (back, on) } else { (on, back) }
            } else {
                let s = if a >= 0.0 { 1 } else { -1 };
                let Some(next) = along(s).filter(|&n| self.runs_straight(n, (ux, uy))) else { continue };
                if (vx, vy) == (s * ux, s * uy) { (here, next) } else { (next, here) }
            };
            let out = if square { SQUARE } else { KERB };
            let at = [r.x as f64 + 0.5 + ux as f64 * a - dx as f64 * out, r.y as f64 + 0.5 + uy as f64 * a - dy as f64 * out];
            let sides: Vec<KerbSide> = [((e0, x0), false), ((x0, e0), true)]
                .into_iter()
                .filter(|((e, x), _)| square || self.edges.contains_key(&(*e, *x)))
                .filter(|((e, x), _)| !square || (self.edges.contains_key(&(*e, here)) && self.edges.contains_key(&(here, *x))))
                .map(|((entry, exit), across)| {
                    let (e, x) = (self.node_pos(entry).unwrap(), self.node_pos(exit).unwrap());
                    let n = ((x[0] - e[0]).abs() + (x[1] - e[1]).abs()).max(1.0);
                    let (wx, wy) = ((x[0] - e[0]) / n, (x[1] - e[1]) / n);
                    // From the entry's middle: `along` toward the
                    // exit, `out` toward the kerb.
                    let p = |along: f64, out: f64| [e[0] + wx * along - dx as f64 * out, e[1] + wy * along - dy as f64 * out];
                    let d = (at[0] - e[0]) * wx + (at[1] - e[1]) * wy;
                    if square {
                        // In: out to the road's middle, round, and in
                        // nose first. Out: backed round into the lane.
                        let arc = |lane: f64, t: f64| p(d - TURN + TURN * t.sin(), lane + TURN - TURN * t.cos());
                        let third = |k: usize| (k as f64 / 3.0) * std::f64::consts::FRAC_PI_2;
                        let mut lead = vec![p(d - TURN - 0.25, -LANE_OFFSET)];
                        lead.extend((1..3).map(|k| arc(-LANE_OFFSET, third(k))));
                        lead.push(p(d, TURN - LANE_OFFSET));
                        let mut back: Vec<[f64; 2]> = (1..3).rev().map(|k| arc(LANE_OFFSET, third(k))).collect();
                        back.push(p(d - TURN, LANE_OFFSET));
                        let out_backs = back.len();
                        return KerbSide { entry, ahead: here, exit, lead, backs: 0, heading: (-dy as f64).atan2(-dx as f64), out: back, out_backs, path: Vec::new(), out_path: Vec::new() };
                    }
                    let (lead, backs) = match (d > 0.5, across) {
                        (true, _) => (vec![p(d - 0.4, KERB)], 0),
                        (false, false) => (vec![p(d + 0.4, LANE_OFFSET), p(d + 0.25, KERB)], 2),
                        (false, true) => (vec![p(d + 0.7, LANE_OFFSET), p(d + 0.15, KERB)], 2),
                    };
                    KerbSide { entry, ahead: exit, exit, lead, backs, heading: wy.atan2(wx), out: Vec::new(), out_backs: 0, path: Vec::new(), out_path: Vec::new() }
                })
                .collect();
            if !sides.is_empty() {
                bays.push(KerbBay { at, sides });
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
        // The lane's middle along the frontage: the gate's, the door's tile.
        let dpos = self.node_pos(door)?;
        let u_gate = if along_x { dpos[0] - lot.x as f64 } else { dpos[1] - lot.y as f64 };

        // The park (`park`): a harbour's down its lane to the ramp
        // (`Berth::park`); anything else's in from the gate to the hall,
        // docks on each side the yard reaches far enough.
        let (points, docks) = match self.berth_at(tiles, kind, facing) {
            Some(berth) => berth.park(),
            None => {
                let sides: Vec<f64> = [1.0, -1.0].into_iter().filter(|&s| (if s > 0.0 { w - u_gate } else { u_gate }) >= DOCK_REACH).collect();
                let (lane, mut docks) = park(|s, side| grid_at(u_gate + side, d - s), &sides);
                // The docks nearest the building are the last.
                docks.drain(..docks.len().saturating_sub(crate::blueprint::blueprint(kind).docks));
                (lane, docks)
            }
        };
        let mut lane = vec![door];
        for &p in &points {
            let id = node(self, p);
            lane.push(id);
        }
        for pair in lane.windows(2) {
            edge(self, pair[0], pair[1]);
            edge(self, pair[1], pair[0]);
        }
        // Aboard: each seat, along its deck lane to the land end, and off
        // over the ramp onto the lane's end.
        let mut seats = Vec::new();
        if let Some(berth) = self.berth_at(tiles, kind, facing) {
            let ship = berth.moored();
            let ends: Vec<EntityId> = (0..crate::world::sea::LANES)
                .map(|l| {
                    let p = crate::world::sea::deck_pose(ship, l);
                    let id = node(self, [p.at[0] + p.heading.cos() * 0.35, p.at[1] + p.heading.sin() * 0.35]);
                    edge(self, id, *lane.last().unwrap());
                    id
                })
                .collect();
            for k in 0..crate::world::sea::BAYS {
                for at in crate::world::sea::seats(ship, k) {
                    let id = node(self, at.at);
                    edge(self, id, ends[k % crate::world::sea::LANES]);
                    seats.push([id, ends[k % crate::world::sea::LANES]]);
                }
            }
        }
        let mut spots = Vec::new();
        let mut bays = Vec::new();
        for (pose, mouth, stop) in docks {
            let mouth = mouth + 1;
            let id = node(self, pose.at);
            let stop = node(self, stop);
            edge(self, lane[mouth], id);
            edge(self, id, lane[mouth]);
            for k in mouth - 1..=mouth + 1 {
                edge(self, lane[k], stop);
            }
            edge(self, stop, id);
            spots.push(Spot { node: id, pose, windows: Vec::new() });
            bays.push((mouth, stop));
        }
        Some(Lot { gate, shape: Default::default(), spots, way: Way::Yard { lane, bays, street, seats }, nodes: Vec::new(), edges: Vec::new(), doorway: Vec::new(), stats: Stats::default() })
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
                let pose = self.pose_of(building, car, claim);
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
                ws.insert(at, Window { car, from, to, side: 0 });
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
    fn pose_of(&self, building: EntityId, car: EntityId, claim: Claim) -> Option<Pose> {
        let lot = self.lots.get(&building)?;
        match (&lot.way, claim) {
            (Way::Kerb { bays, .. }, Claim::Spot(i)) => Some(Pose { at: lot.spots[i].pose.at, heading: bays[i].sides[lot.side(i, car)].heading }),
            (_, Claim::Spot(i)) => Some(lot.spots[i].pose),
            (_, Claim::Door) => None,
        }
    }

    /// Where the car will stand at the place it holds: its spot's pose.
    pub fn pose_held(&self, car: EntityId) -> Option<Pose> {
        let building = *self.claims.get(&car)?;
        self.pose_of(building, car, self.claim_of(building, car)?)
    }

    fn claim_of(&self, building: EntityId, car: EntityId) -> Option<Claim> {
        let lot = self.lots.get(&building)?;
        if lot.doorway.contains(&car) {
            return Some(Claim::Door);
        }
        lot.spots.iter().position(|s| s.holder(car).is_some()).map(Claim::Spot)
    }

    /// Where a route node is: a road node's tile centre, moved to its side
    /// if it stands on one (`decks.rs`), or a lot node's own position.
    pub fn node_pos(&self, id: EntityId) -> Option<[f64; 2]> {
        if let Some(&p) = self.lot_nodes.get(&id) {
            return Some(p);
        }
        let [sx, sy] = self.side_of(id).map(f64::from);
        let by = if sx == 0.0 && sy == 0.0 { 0.0 } else { super::decks::SIDE_OFFSET / (sx * sx + sy * sy).sqrt() };
        self.objects.get(id)?.position.map(|p| [p.x as f64 + 0.5 + sx * by, p.y as f64 + 0.5 + sy * by])
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
        let pose = self.pose_of(building, car, claim);
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
            (Way::Yard { lane, bays, street, .. }, Claim::Spot(i)) => {
                let mut v = vec![lot.spots[i].node];
                v.extend(lane[..=bays[i].0].iter().rev());
                v.push(*street);
                v
            }
            (Way::Yard { lane, street, .. }, Claim::Door) => vec![lane[0], *street],
            (Way::Kerb { bays, .. }, Claim::Spot(i)) => {
                let side = &bays[i].sides[lot.side(i, car)];
                std::iter::once(lot.spots[i].node).chain(side.out_path.iter().copied()).chain([side.exit]).collect()
            }
            (Way::Kerb { door, street, .. }, Claim::Door) => vec![*door, *street],
        })
    }

    /// The way off a harbour's moored ferry from a seat on its deck: along
    /// its deck lane, over the ramp, up the lane to the gate, and the
    /// street node last.
    pub fn way_off(&mut self, harbour: EntityId, seat: usize) -> Option<Vec<EntityId>> {
        let Lot { way: Way::Yard { lane, street, seats, .. }, .. } = self.lot_mut(harbour)? else { return None };
        let [at, end] = *seats.get(seat)?;
        Some([at, end].into_iter().chain(lane.iter().rev().copied()).chain([*street]).collect())
    }

    /// The ways from a node to a building, claiming nothing: the street
    /// route to its door, and to the entry of each kerb bay. `None` where
    /// no road leads there.
    pub fn ways_to(&mut self, building: EntityId, from: EntityId) -> Option<Ways> {
        let to = self.approach(building)?;
        let entries: Vec<EntityId> = match self.lots.get(&building).map(|l| &l.way) {
            Some(Way::Kerb { bays, .. }) => bays.iter().flat_map(|b| b.sides.iter().map(|s| s.entry)).collect(),
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
        // The first way into each bay the street route arrives at from
        // behind, not turning back from the node ahead of it.
        let sides: Vec<Option<usize>> = match &self.lots[&building].way {
            Way::Kerb { bays, .. } => bays
                .iter()
                .map(|b| b.sides.iter().position(|s| ways.bays.get(&s.entry).is_some_and(|r| r[r.len() - 2] != s.ahead)))
                .collect(),
            _ => Vec::new(),
        };
        let claim = self.claim_spot(building, car, from, to, |i| sides.get(i).is_none_or(|s| s.is_some()))?;
        let side = |i: usize| sides.get(i).copied().flatten().unwrap_or(0);
        if let Claim::Spot(i) = claim
            && let Some(w) = self.lots.get_mut(&building).unwrap().spots[i].windows.iter_mut().find(|w| w.car == car)
        {
            w.side = side(i);
        }
        let lot = self.lots.get(&building)?;
        let (path, lot_nodes): (&[EntityId], Vec<EntityId>) = match (&lot.way, claim) {
            (Way::Driveway { .. }, Claim::Spot(i)) => (&ways.street, vec![lot.spots[i].node]),
            (Way::Driveway { door, .. } | Way::Kerb { door, .. }, Claim::Door) => (&ways.street, vec![*door]),
            // Along the lane, swinging across it from short of the mouth to
            // pull up, and backed into the dock: the last edge in reverse.
            (Way::Yard { lane, bays, .. }, Claim::Spot(i)) => {
                let (mouth, stop) = bays[i];
                let mut v: Vec<EntityId> = lane[..mouth].to_vec();
                v.extend([stop, lot.spots[i].node]);
                (&ways.street, v)
            }
            (Way::Yard { lane, .. }, Claim::Door) => (&ways.street, vec![lane[0]]),
            (Way::Kerb { bays, .. }, Claim::Spot(i)) => {
                let s = &bays[i].sides[side(i)];
                (ways.bays.get(&s.entry)?, s.path.clone())
            }
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
    /// backwards: one off a drive, onto the street; a square kerb bay's
    /// way back round into the lane; none anywhere else.
    pub fn backs_out(&self, car: EntityId) -> usize {
        let Some(&building) = self.claims.get(&car) else { return 0 };
        let Some(lot) = self.lots.get(&building) else { return 0 };
        match (&lot.way, self.claim_of(building, car)) {
            (Way::Driveway { .. }, Some(Claim::Spot(_))) => 1,
            (Way::Kerb { bays, .. }, Some(Claim::Spot(i))) => bays[i].sides[lot.side(i, car)].out_backs,
            _ => 0,
        }
    }

    /// The nodes a car holds while it turns between the street and its
    /// place, coming or going, besides where it leaves or joins the street:
    /// the street waits at all of them. A kerb bay's, the stretch it turns
    /// across. A dock's, the yard's door: a yard is one lorry moving at a
    /// time, so one coming in waits at the gate and one leaving in its
    /// dock until the lane is clear, never meeting in it.
    pub fn stretch(&self, car: EntityId) -> Vec<EntityId> {
        let Some(&building) = self.claims.get(&car) else { return Vec::new() };
        let Some(lot) = self.lots.get(&building) else { return Vec::new() };
        match (&lot.way, self.claim_of(building, car)) {
            (Way::Kerb { bays, .. }, Some(Claim::Spot(i))) => {
                let side = &bays[i].sides[lot.side(i, car)];
                let mut nodes = vec![side.entry, side.ahead, side.exit];
                nodes.dedup();
                nodes
            }
            (Way::Yard { lane, .. }, Some(Claim::Spot(_))) => vec![lane[0]],
            _ => Vec::new(),
        }
    }

    /// How many edges at the end of the car's way in are driven backwards:
    /// one into a dock, or into a kerb bay too close to its entry to pull
    /// into; none anywhere else.
    pub fn reverse_tail(&self, car: EntityId) -> usize {
        let Some(&building) = self.claims.get(&car) else { return 0 };
        match (self.lots.get(&building).map(|l| &l.way), self.claim_of(building, car)) {
            (Some(Way::Yard { .. }), Some(Claim::Spot(_))) => 1,
            (Some(Way::Kerb { bays, .. }), Some(Claim::Spot(i))) => bays[i].sides[self.lots[&building].side(i, car)].backs,
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
                // A ferry at its berth stands where it stands: it is in no lot.
                GameObject::Car(ref c) if c.trip.is_none() && c.role != crate::protocol::CarRole::Ferry => Some((e.id, c.spot, e.position?)),
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
                    let pose = self.pose_of(building, car, claim);
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
pub fn kerbed(kind: crate::protocol::BuildingKind) -> bool {
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
    use crate::protocol::BuildingKind;

    /// Open land with one street along y = 0.
    fn street() -> World {
        World::meadow(-4..40, -4..8).street(-4..40)
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

    /// Flats park along the kerb before them: evenly along it within their
    /// walls, three along two tiles, wholly off the
    /// road on its side, facing the way the lane beside them runs. A car
    /// coming along that lane pulls into the far one and backs into the
    /// near one; a car coming the other way parks across the road in one,
    /// facing against the traffic on that side.
    #[test]
    fn flats_park_along_the_kerb() {
        let mut world = street();
        let flats = world.place_on_street(GridCoord { x: 2, y: 1 }, BuildingKind::Apartment).unwrap();
        let mut at: Vec<[f64; 2]> = world.lot_mut(flats).unwrap().spots.iter().map(|s| s.pose.at).collect();
        at.sort_by(|a, b| a[0].total_cmp(&b[0]));
        assert_eq!(at.len(), 3, "three along two tiles, within its walls: {at:?}");
        for (bay, x) in at.iter().zip([2.58, 3.0, 3.42]) {
            assert!((bay[0] - x).abs() < 1e-9 && (bay[1] - (0.5 + KERB)).abs() < 1e-9, "a bay at {bay:?}");
        }
        assert!(world.lot_mut(flats).unwrap().spots.iter().all(|s| s.pose.heading.abs() < 1e-9), "facing east, the way the lane on that side runs");
        let shop = flats;

        let car = |world: &mut World| world.insert_at(GameObject::Car(crate::protocol::Car::new(0, Default::default())), None);
        let (west, east) = (world.road_node_at(GridCoord { x: -2, y: 0 }).unwrap(), world.road_node_at(GridCoord { x: 20, y: 0 }).unwrap());
        // From the west, along the lane beside the bays: into each, from
        // the street node behind it. The far bay is pulled into, along the
        // kerb's line at the last; the near one, a quarter tile on, backed
        // into from the lane past it.
        let mut bays = Vec::new();
        let mut cars = Vec::new();
        for _ in 0..at.len() {
            let a = car(&mut world);
            cars.push(a);
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
        let a = cars[0];
        // Out of the bay, forward, onto the street node ahead of it.
        world.park_in_lot(shop, a, 0);
        let out = world.way_out(a).unwrap();
        assert_eq!(out.len(), 2);
        let parked = world.node_pos(out[0]).unwrap();
        assert!(world.node_pos(out[1]).unwrap()[0] > parked[0], "out ahead");
        // From the east, with a bay free: across the road into it, from the
        // street node to its east, parked facing west, against the traffic
        // on that side, and out west.
        world.release_spot(cars[1]);
        let b = car(&mut world);
        let ways = world.ways_to(shop, east).unwrap();
        let (route, to_lot) = world.way_in(shop, b, &ways, 0, GameTime::MAX).unwrap();
        let (entry, bay) = (world.node_pos(route[route.len() - 1 - to_lot]).unwrap(), world.node_pos(route[route.len() - 1]).unwrap());
        assert!(entry[0] > bay[0], "driven into from the east: {entry:?} to {bay:?}");
        world.park_in_lot(shop, b, 0);
        let pose = match world.objects.get(b).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.spot.unwrap(),
            _ => unreachable!(),
        };
        assert!(pose.heading.cos() < -0.99, "facing west: {}", pose.heading);
        let out = world.way_out(b).unwrap();
        assert!(world.node_pos(out[1]).unwrap()[0] < bay[0], "out to the west");
        assert_eq!(world.backs_out(a), 0);
    }

    /// Anything but a home parks nose in, square to the kerb: two bays a
    /// tile within its walls, close to the road. A car swings out to
    /// the road's middle and turns in round the tightest a car turns, from
    /// either way along the street, and backs out round into the lane and
    /// drives on.
    #[test]
    fn a_shop_parks_square_to_the_kerb() {
        let mut world = street();
        let shop = world.place_on_street(GridCoord { x: 2, y: 1 }, BuildingKind::Shop).unwrap();
        let mut at: Vec<[f64; 2]> = world.lot_mut(shop).unwrap().spots.iter().map(|s| s.pose.at).collect();
        at.sort_by(|a, b| a[0].total_cmp(&b[0]));
        assert_eq!(at.len(), 2, "two bays to a tile, within its walls: {at:?}");
        for (bay, x) in at.iter().zip([2.365, 2.635]) {
            assert!((bay[0] - x).abs() < 1e-9 && (bay[1] - (0.5 + SQUARE)).abs() < 1e-9, "a bay at {bay:?}");
        }
        let car = |world: &mut World| world.insert_at(GameObject::Car(crate::protocol::Car::new(0, Default::default())), None);
        for (from, sign) in [(GridCoord { x: -2, y: 0 }, 1.0), (GridCoord { x: 20, y: 0 }, -1.0)] {
            let a = car(&mut world);
            let ways = world.ways_to(shop, world.road_node_at(from).unwrap()).unwrap();
            let (route, to_lot) = world.way_in(shop, a, &ways, 0, GameTime::MAX).unwrap();
            let entry = world.node_pos(route[route.len() - 1 - to_lot]).unwrap();
            let (last, bay) = (world.node_pos(route[route.len() - 2]).unwrap(), world.node_pos(route[route.len() - 1]).unwrap());
            assert!(sign * (bay[0] - entry[0]) > 0.5, "turned into from behind it, either way: {entry:?} to {bay:?}");
            assert!((last[0] - bay[0]).abs() < 1e-9 && last[1] < bay[1], "straight in at the last: {last:?}");
            assert_eq!(world.reverse_tail(a), 0, "nose in");
            world.park_in_lot(shop, a, 0);
            let pose = match world.objects.get(a).map(|e| &e.object) {
                Some(GameObject::Car(c)) => c.spot.unwrap(),
                _ => unreachable!(),
            };
            assert!((pose.heading - std::f64::consts::FRAC_PI_2).abs() < 1e-9, "facing the shop: {}", pose.heading);
            let out = world.way_out(a).unwrap();
            assert_eq!(world.backs_out(a), out.len() - 2, "backed out round into the lane");
            let (lane, exit) = (world.node_pos(out[out.len() - 2]).unwrap(), world.node_pos(out[out.len() - 1]).unwrap());
            assert!((lane[1] - (0.5 + LANE_OFFSET)).abs() < 1e-9 && sign * (exit[0] - lane[0]) > 0.0, "in the lane, and on: {lane:?} to {exit:?}");
        }
    }

    /// A shop on a corner parks on one side, the one its door opens onto:
    /// it needs no more than its long side holds.
    #[test]
    fn a_shop_on_a_corner_parks_on_one_side() {
        let mut world = street();
        let cross: Vec<GridCoord> = (0..8).map(|y| GridCoord { x: 5, y }).collect();
        world.place_road_path(&cross);
        let shop = world.place_on_street(GridCoord { x: 4, y: 1 }, BuildingKind::Shop).unwrap();
        let at: Vec<[f64; 2]> = world.lot_mut(shop).unwrap().spots.iter().map(|s| s.pose.at).collect();
        assert_eq!(at.len(), 2, "one side's bays: {at:?}");
        assert!(at.iter().all(|p| (p[1] - at[0][1]).abs() < 1e-9) || at.iter().all(|p| (p[0] - at[0][0]).abs() < 1e-9), "all on one side: {at:?}");
    }

    /// Anything that parks at the kerb is placed only where a street runs
    /// all along one of its sides, for its bays: an office whose street
    /// ends half way along it is refused, one a tile on is placed.
    #[test]
    fn a_kerb_parker_needs_a_street_along_a_whole_side() {
        let world = World::meadow(-4..12, -4..8).street(-4..3);
        assert_eq!(world.fit(BuildingKind::Office, GridCoord { x: 3, y: 1 }, 0).err(), Some("No street along a whole side, for its parking"));
        assert!(world.fit(BuildingKind::Office, GridCoord { x: 2, y: 1 }, 0).is_ok());
    }

    /// A depot's lot is a yard, laid as a harbour's park: a gate in the
    /// middle of its front, a lane straight in from it, docks either side,
    /// a lorry backing into its own from beyond its mouth, deeper in, and
    /// leaving forward; and nothing beside it joins its slab.
    #[test]
    fn a_depot_has_docks_a_lorry_backs_into() {
        let mut world = street();
        let depot = world.place_on_street(GridCoord { x: 4, y: 1 }, BuildingKind::Depot).unwrap();
        let shop = world.place_on_street(GridCoord { x: 7, y: 1 }, BuildingKind::Shop).unwrap();
        assert_eq!(world.lot_mut(depot).unwrap().spots.len(), 8, "four rows of docks either side of the lane");
        let b = match world.objects.get(depot).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.clone(),
            _ => unreachable!(),
        };
        assert_eq!(world.door_of(depot).map(|d| d.0), World::gate_of(&b.tiles, b.kind, b.facing), "the door is the gate");
        world.lot_mut(shop).unwrap();
        // One of the depot's own lorries, in its dock since the depot was reached.
        let lorry = world.objects.iter().find(|e| matches!(e.object, GameObject::Car(ref c) if c.owner == depot && c.role == crate::protocol::CarRole::Truck)).map(|e| e.id).unwrap();
        world.release_spot(lorry);
        let ways = world.ways_to(depot, world.road_node_at(GridCoord { x: 30, y: 0 }).unwrap()).unwrap();
        let (way, _) = world.way_in(depot, lorry, &ways, 0, GameTime::MAX).unwrap();
        assert_eq!(world.reverse_tail(lorry), 1, "the last edge is driven backwards");
        let n = way.len();
        let (before, stop, dock) = (world.node_pos(way[n - 3]).unwrap(), world.node_pos(way[n - 2]).unwrap(), world.node_pos(way[n - 1]).unwrap());
        let gate = world.door_of(depot).unwrap().0;
        assert!((before[0] - gate.x as f64 - 0.5).abs() < 1e-9, "the lane runs straight in from the gate: {before:?}");
        let mouth = [before[0], dock[1]];
        assert!(stop[1] > mouth[1] + 0.4, "the lorry pulls up beyond the mouth, deeper in: {stop:?} {mouth:?}");
        assert!((dock[1] - mouth[1]).abs() < 1e-9 && (dock[0] - mouth[0]).abs() > 0.5, "the dock is straight out from the mouth: {dock:?}");
        assert!((stop[0] - mouth[0]) * (dock[0] - mouth[0]) < 0.0 && (stop[0] - mouth[0]).abs() > 0.3, "it swings across the lane, away from the dock: {stop:?} {dock:?}");
        world.park_in_lot(depot, lorry, 0);
        let out = world.way_out(lorry).unwrap();
        assert_eq!(out[0], way[n - 1], "out of the dock");
        assert!((world.node_pos(out[1]).unwrap()[1] - dock[1]).abs() < 1e-9, "forward to the mouth");
        assert_eq!(world.stretch(lorry), vec![out[out.len() - 2]], "one lorry in the lane at a time: it holds the yard's door");
        assert_eq!(world.reverse_tail(lorry), 1);
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
        let depot = world.place_on_street(GridCoord { x: 20, y: 1 }, BuildingKind::Depot).unwrap();
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
