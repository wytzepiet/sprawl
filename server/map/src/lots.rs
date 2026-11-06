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
//! the building's door opens onto (`Building::door`) to its tile. Every
//! other kind has a front: a gate in the middle of the side toward its
//! street, its loading docks notched into the wall there, a box truck
//! backing off the street into each, its tail at the loading door and its
//! nose on the pavement (`park::ways::square`). Its staff's and customers'
//! cars stand in square bays at the kerb either side, a car pulling in
//! from the lane beside them, or across the road coming the other way,
//! and out ahead. A car that finds no place
//! stops at the door, unseen. See `docs/parking.md`.

use rand::{Rng, SeedableRng};
use fixed::SmallRng;
use fixed::HashMap;

use model::GameTime;
use model::blueprint::fronted;
use model::{EntityId, GameObject, GridCoord, Pose};
use serde_json::{json, Value};
use crate::Map;
use crate::bezier::LANE_OFFSET;
use crate::segments::EdgeSegment;

/// A driveway spot: how far out from the plot's centre a car's centre
/// stands, wholly before the house's front wall and short of the road, and
/// half the gap between the two cars (`DRIVE_OUT` and `DRIVE_LANE` in the
/// client's `dressing.ts`, which draws the drive).
const SPOT_OUT: f64 = 0.47;
const LANE: f64 = 0.11;
/// A bay square to the kerb: its middle this far from the street's middle
/// line, the car's tail at the road's edge, so a strip of pavement is left
/// between it and the building; and how far apart, a car and a door's
/// swing (a bay's width). The client paves them from the same numbers
/// (`town/surface.ts`).
const SQUARE: f64 = 0.37;
const SQUARE_PITCH: f64 = 0.27;
/// Bays keep this far in from the ends of a building's side
/// (`BAY_INSET` in the client's `surface.ts`).
const WALL_INSET: f64 = 0.2;
/// The street a place sees: half its width (`ROAD_WIDTH` in the client's
/// `roadGeometry.ts`) and its lanes.
const ROAD: park::ways::Road = park::ways::Road { half: 0.22, lane: LANE_OFFSET };

/// The ways into a square bay and out, its neighbours either side taken,
/// in the bay's own frame (`park::ways::square`): the same for every bay,
/// so drawn once.
fn square_ways() -> &'static [Option<park::ways::Place>; 2] {
    static WAYS: std::sync::OnceLock<[Option<park::ways::Place>; 2]> = std::sync::OnceLock::new();
    WAYS.get_or_init(|| park::ways::square(&park::CAR, 0.0, SQUARE, None, &cars_at(&[(-SQUARE_PITCH, -SQUARE), (SQUARE_PITCH, -SQUARE)]), ROAD))
}

/// Cars standing square to the street, their middles at these points.
fn cars_at(at: &[(f64, f64)]) -> Vec<park::Rect> {
    at.iter().flat_map(|&(x, y)| park::bodies(&park::CAR, park::Pose::new(x, y, std::f64::consts::FRAC_PI_2).ahead(-park::CAR.cab.axle())).collect::<Vec<_>>()).collect()
}

/// The ways onto a drive's two spots, each beside the other, taken.
fn drive_ways() -> &'static [[Option<park::ways::Place>; 2]; 2] {
    static WAYS: std::sync::OnceLock<[[Option<park::ways::Place>; 2]; 2]> = std::sync::OnceLock::new();
    let depth = 1.0 - SPOT_OUT;
    WAYS.get_or_init(|| [LANE, -LANE].map(|x| park::ways::square(&park::CAR, x, depth, None, &cars_at(&[(-x, -depth)]), ROAD)))
}

/// Docks side by side at a gate: how far apart, and the `k`th's way from
/// the gate's middle, of `n`. A car's bay keeps `DOCK_CLEAR` past the
/// outer ones, where a truck's nose swings round as it backs in.
const DOCK_PITCH: f64 = 0.3;
const DOCK_CLEAR: f64 = 0.4;
fn dock_at(k: usize, n: usize) -> f64 {
    (k as f64 - (n as f64 - 1.0) / 2.0) * DOCK_PITCH
}
/// A docked truck's middle behind the street's middle line: its nose at
/// the road's edge, its tail in a notch in the building's front, a fifth
/// of a tile deep, at the loading door; the notch reaching `NOTCH` either
/// side of a dock's middle (`town/surface.ts` paves the same).
const DOCK: f64 = 0.465;
const NOTCH: f64 = 0.15;

/// How many bays a side `len` tiles long holds, within its walls.
fn bays_along(len: usize) -> usize {
    ((len as f64 - 2.0 * WALL_INSET) / SQUARE_PITCH + 1e-9).floor().max(0.0) as usize
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
    /// in it (`KerbWay::sides`), and which of that way's exits it leaves by
    /// (`KerbSide::outs`); 0 anywhere else.
    pub side: usize,
    pub exit: usize,
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
    /// Bays at the kerb or on a drive, a spot each; the door for a car with
    /// no bay.
    /// A front's docks first, `docks` of them, which only lorries take.
    Kerb { door: EntityId, street: EntityId, bays: Vec<KerbWay>, docks: usize },
}

/// A kerb bay's ways in, from either end of the stretch it stands on.
struct KerbWay {
    sides: Vec<KerbSide>,
}

/// One way into a kerb bay and out, by the moves a driver makes
/// (`park::ways`): from the street node behind it, `entry`, along its lot
/// nodes, `path`, the bay's last, each leg of the way in an edge, parked
/// facing `heading`; and out by one of its exits.
#[derive(Clone, PartialEq, Debug)]
pub struct KerbSide {
    entry: EntityId,
    /// The street node after the entry toward the bay: a route arriving
    /// at the entry from it would be turning back.
    ahead: EntityId,
    heading: f64,
    into: Vec<Leg>,
    path: Vec<EntityId>,
    /// On the way it came along first, then back the way it came.
    outs: Vec<Exit>,
}

/// A way out of a kerb bay: its legs, the lot nodes each ends at, and the
/// street node it joins the street by.
#[derive(Clone, PartialEq, Debug)]
pub struct Exit {
    node: EntityId,
    legs: Vec<Leg>,
    path: Vec<EntityId>,
}

/// A leg of a way into a place or out of it, laid on the map: its moves
/// from the rear axle (`from`), and the vehicle's middle where it starts
/// and ends, the lot nodes it runs between.
#[derive(Clone, PartialEq, Debug)]
pub struct Leg {
    from: Pose,
    back: bool,
    moves: Vec<model::Move>,
    start: [f64; 2],
    end: [f64; 2],
}

impl Leg {
    fn manoeuvre(&self, edge: usize) -> model::Manoeuvre {
        model::Manoeuvre { edge, from: self.from, moves: self.moves.clone() }
    }
}

/// A place's own frame laid on the map: x along the street, y out from the
/// kerb toward the street's middle, from the foot of the place on that
/// middle line. The map's y runs down the screen, so the frame is a mirror
/// of it: a turn left in it is a turn right on the map.
#[derive(Clone, Copy)]
struct Frame {
    o: [f64; 2],
    x: [f64; 2],
    y: [f64; 2],
}

impl Frame {
    fn at(&self, (u, v): (f64, f64)) -> [f64; 2] {
        [self.o[0] + self.x[0] * u + self.y[0] * v, self.o[1] + self.x[1] * u + self.y[1] * v]
    }

    fn heading(&self, h: f64) -> f64 {
        let (c, s) = (h.cos(), h.sin());
        (self.x[1] * c + self.y[1] * s).atan2(self.x[0] * c + self.y[0] * s)
    }

    fn leg(&self, rig: &park::Rig, l: &park::ways::Leg) -> Leg {
        let hand = (self.x[0] * self.y[1] - self.x[1] * self.y[0]).signum();
        let mid = |p: park::Pose| {
            let m = p.ahead(rig.cab.axle());
            self.at((m.x, m.y))
        };
        Leg {
            from: Pose { at: self.at((l.from.x, l.from.y)), heading: self.heading(l.from.heading) },
            back: l.back,
            moves: l.moves.iter().map(|m| model::Move { back: m.back, from: m.from * hand, to: m.to * hand, length: m.length }).collect(),
            start: mid(l.from),
            end: mid(l.end()),
        }
    }
}

/// A bay at the kerb, before one of a building's tiles, or on a drive:
/// where a car in it stands, and its ways in. Along the lane on its own
/// side first, past it and backed in, and then from the far side of the
/// road, as a driver does who comes the other way: across, nose in.
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

pub struct Lot {
    /// Its door's tile and the street node it opens onto, and the
    /// building's tiles and facing: the lot is rebuilt when these no
    /// longer match the map.
    gate: (GridCoord, EntityId),
    shape: (Vec<GridCoord>, u8, Vec<KerbBay>, Vec<EntityId>),
    pub spots: Vec<Spot>,
    way: Way,
    /// Every node and edge this lot owns, for taking it down.
    nodes: Vec<EntityId>,
    edges: Vec<(EntityId, EntityId)>,
    /// The cars at the door.
    doorway: Vec<EntityId>,
    /// The lorries refused a dock here, to be woken when one is let go of.
    refused: Vec<EntityId>,
    pub stats: Stats,
}

impl Lot {
    /// How many of its spots, the first, are a lorry's docks.
    pub fn docks(&self) -> usize {
        let Way::Kerb { docks, .. } = &self.way;
        *docks
    }
    /// Which way into spot `i` this car takes: its window's side.
    fn side(&self, i: usize, car: EntityId) -> usize {
        self.spots[i].holder(car).map_or(0, |w| w.side)
    }

    /// The way this car leaves spot `i` by: its side's exit it chose.
    fn exit<'a>(&self, bay: &'a KerbWay, i: usize, car: EntityId) -> &'a Exit {
        let side = &bay.sides[self.side(i, car)];
        let k = self.spots[i].holder(car).map_or(0, |w| w.exit);
        side.outs.get(k).unwrap_or(&side.outs[0])
    }
}

impl Map {
    /// The building's lot, built or rebuilt to match the map. `None` where
    /// no road reaches it.
    pub fn lot_mut(&mut self, building: EntityId) -> Option<&mut Lot> {
        // Its door, and the street it opens onto: none for one no road
        // reaches, and none at the edge, a road running off the map, where
        // a car that gets there is gone, so nobody parks.
        let gate = self.door_of(building)?;
        let (tiles, kind, facing) = self.building_of(building)?;
        let kerb = self.bays(gate, &tiles, kind);
        // A front's trucks back in off the street: the street's way on
        // from the gate either side.
        let ends = if fronted(kind) { self.arms_of(gate.1, false) } else { Vec::new() };
        let shape = (tiles, facing, kerb, ends);
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

    fn building_of(&self, id: EntityId) -> Option<(Vec<GridCoord>, model::BuildingKind, u8)> {
        match self.objects.get(id)?.object {
            GameObject::Building(ref b) => Some((b.tiles.clone(), b.kind, b.facing)),
            _ => None,
        }
    }

    fn build_lot(&mut self, building: EntityId, gate: (GridCoord, EntityId)) -> Option<Lot> {
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut spots = Vec::new();
        let mut node = |world: &mut Map, at: [f64; 2]| {
            let id = world.objects.reserve_id();
            world.lot_nodes.insert(id, at);
            nodes.push(id);
            id
        };
        let mut edge = |world: &mut Map, a: EntityId, b: EntityId| {
            world.edges.insert((a, b), EdgeSegment::new(1));
            edges.push((a, b));
        };
        let (tiles, kind, _) = self.building_of(building)?;
        // The door: the lot's own node on the door's tile, where a car with
        // no spot stops, and a front's lane begins; the drive to it from the
        // street.
        let (tile, street) = gate;
        let door = node(self, [tile.x as f64 + 0.5, tile.y as f64 + 0.5]);
        edge(self, street, door);
        edge(self, door, street);
        let cars = self.bays(gate, &tiles, kind);
        let mut found = if fronted(kind) { self.dock_bays(gate, kind, &cars) } else { Vec::new() };
        let docks = found.len();
        found.extend(cars);
        let mut bays = Vec::new();
        for mut bay in found {
            let id = node(self, bay.at);
            for side in &mut bay.sides {
                let mut at = side.entry;
                for (k, leg) in side.into.iter().enumerate() {
                    if k == 0 {
                        let start = node(self, leg.start);
                        edge(self, at, start);
                        side.path.push(start);
                        at = start;
                    }
                    let end = if k + 1 == side.into.len() { id } else { node(self, leg.end) };
                    edge(self, at, end);
                    side.path.push(end);
                    at = end;
                }
                for exit in &mut side.outs {
                    let mut at = id;
                    for leg in &exit.legs {
                        let end = node(self, leg.end);
                        edge(self, at, end);
                        exit.path.push(end);
                        at = end;
                    }
                    edge(self, at, exit.node);
                }
            }
            spots.push(Spot { node: id, pose: Pose { at: bay.at, heading: bay.sides[0].heading }, windows: Vec::new() });
            bays.push(KerbWay { sides: bay.sides });
        }
        Some(Lot { gate, shape: Default::default(), spots, way: Way::Kerb { door, street, bays, docks }, nodes, edges, doorway: Vec::new(), refused: Vec::new(), stats: Stats::default() })
    }

    /// The bays cars park in: a house's drive, or the kerb before anything
    /// else.
    fn bays(&self, gate: (GridCoord, EntityId), tiles: &[GridCoord], kind: model::BuildingKind) -> Vec<KerbBay> {
        match kind {
            model::BuildingKind::House => self.drive_bays(gate),
            _ if kerbed(kind) => self.kerb_bays(tiles, kind, self.door_way(gate), fronted(kind).then_some(gate.0)),
            _ => Vec::new(),
        }
    }

    /// A house's drive: two spots side by side, from the street node its
    /// door opens onto to its tile, turned into from the street as into a
    /// bay at the kerb, where that street runs on either side of it.
    fn drive_bays(&self, (tile, street): (GridCoord, EntityId)) -> Vec<KerbBay> {
        let Some(s) = self.node_pos(street) else { return Vec::new() };
        let d = [s[0] - (tile.x as f64 + 0.5), s[1] - (tile.y as f64 + 0.5)];
        let l = d[0].hypot(d[1]);
        if l < 1e-9 {
            return Vec::new();
        }
        let y = [d[0] / l, d[1] / l];
        let frame = Frame { o: s, x: [-y[1], y[0]], y };
        let Some(p) = self.objects.get(street).and_then(|e| e.position) else { return Vec::new() };
        let (ux, uy) = (frame.x[0].round() as i32, frame.x[1].round() as i32);
        let arm = |k: i32| self.road_node_at(GridCoord { x: p.x + k * ux, y: p.y + k * uy }).filter(|&n| self.arms_of(street, false).contains(&n));
        let ways = drive_ways();
        [LANE, -LANE]
            .iter()
            .zip(ways)
            .filter_map(|(&x, places)| {
                let sides = self.sides(frame, places, street, arm(-1), arm(1));
                (!sides.is_empty()).then(|| KerbBay { at: frame.at((x, -(1.0 - SPOT_OUT))), sides })
            })
            .collect()
    }

    /// The ways into a place and out, laid on the map from its frame: from
    /// along +x first, entering from `back`, and then from along -x,
    /// entering from `on`, each where the street is driven that way past
    /// `here`; and each one's exits that the street can be driven along.
    fn sides(&self, frame: Frame, places: &[Option<park::ways::Place>; 2], here: EntityId, back: Option<EntityId>, on: Option<EntityId>) -> Vec<KerbSide> {
        self.sides_of(&park::CAR, frame, places, here, back, on)
    }

    fn sides_of(&self, rig: &park::Rig, frame: Frame, places: &[Option<park::ways::Place>; 2], here: EntityId, back: Option<EntityId>, on: Option<EntityId>) -> Vec<KerbSide> {
        let rig = *rig;
        // Driven +x past `here`, and -x.
        let ways = [(back, on), (on, back)].map(|(a, b)| match (a, b) {
            (Some(a), Some(b)) => (self.edges.contains_key(&(a, here)) && self.edges.contains_key(&(here, b))).then_some((a, b)),
            _ => None,
        });
        (0..2)
            .filter_map(|k| {
                let place = places[k].as_ref()?;
                let (entry, _) = ways[k]?;
                let outs: Vec<Exit> = [(k, 0), (1 - k, 1)]
                    .into_iter()
                    .filter_map(|(w, o)| {
                        let (_, node) = ways[w]?;
                        (!place.outs[o].is_empty()).then(|| Exit { node, legs: place.outs[o].iter().map(|l| frame.leg(&rig, l)).collect(), path: Vec::new() })
                    })
                    .collect();
                // The first exit is on the way it came; without it, none.
                (ways[k].is_some_and(|_| outs.first().is_some_and(|e| Some(e.node) == ways[k].map(|w| w.1)))).then_some(())?;
                Some(KerbSide { entry, ahead: here, heading: frame.heading(place.stands.heading), into: place.into.iter().map(|l| frame.leg(&rig, l)).collect(), path: Vec::new(), outs })
            })
            .collect()
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

    pub fn kerb_bays(&self, tiles: &[GridCoord], kind: model::BuildingKind, door: Option<(i32, i32)>, gate: Option<GridCoord>) -> Vec<KerbBay> {
        let need = model::blueprint::blueprint(kind).bays();
        let docks = model::blueprint::blueprint(kind).docks();
        let mut sides: Vec<(bool, bool, Vec<KerbBay>)> = SIDES
            .iter()
            .map(|&d| {
                let run = side_of(tiles, d);
                // On the gate's side, clear of its docks.
                let keep = gate.filter(|_| door == Some(d)).and_then(|g| run.iter().position(|&t| t == g)).map(|k| (k as f64 + 0.5, docks));
                (door != Some(d), !self.street_along(&run, d), self.bays_on(&run, d, need, keep))
            })
            .collect();
        sides.sort_by_key(|(other, broken, bays)| (*other, *broken, std::cmp::Reverse(bays.len())));
        let mut bays = Vec::new();
        for (_, _, side) in sides {
            if bays.len() >= need {
                break;
            }
            let more = need - bays.len();
            bays.extend(side.into_iter().take(more));
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
    fn bays_on(&self, run: &[GridCoord], (dx, dy): (i32, i32), most: usize, docks: Option<(f64, usize)>) -> Vec<KerbBay> {
        let mut bays = Vec::new();
        let (ux, uy) = (dy.abs(), dx.abs());
        let len = run.len() as f64;
        let at: Vec<f64> = match docks {
            // Evenly along the side, about its middle.
            None => {
                let n = bays_along(run.len()).min(most);
                (0..n).map(|i| len / 2.0 + (i as f64 - (n as f64 - 1.0) / 2.0) * SQUARE_PITCH).collect()
            }
            // Out from the gate's docks either way, the nearest first, as
            // far from them as a truck needs to swing its nose round.
            Some((g, n)) => {
                let d0 = n.saturating_sub(1) as f64 * DOCK_PITCH / 2.0 + DOCK_CLEAR;
                (0..2 * run.len() * 4)
                    .map(|k| g + if k % 2 == 0 { 1.0 } else { -1.0 } * (d0 + (k / 2) as f64 * SQUARE_PITCH))
                    .filter(|&u| u >= WALL_INSET && u <= len - WALL_INSET)
                    .take(most)
                    .collect()
            }
        };
        for u in at {
            // Along the side from its start, and the tile it is before.
            let k = (u.floor() as usize).min(run.len() - 1);
            let a = u - k as f64 - 0.5;
            let t = run[k];
            // The street beside the tile, running along (ux, uy).
            let r = GridCoord { x: t.x + dx, y: t.y + dy };
            let Some(here) = self.road_node_at(r).filter(|&n| self.runs_straight(n, (ux, uy))) else { continue };
            // The bay's frame: along the way that has this kerb on its
            // right, out toward the street.
            let (vx, vy) = (-dy, dx);
            let frame = Frame { o: [r.x as f64 + 0.5 + ux as f64 * a, r.y as f64 + 0.5 + uy as f64 * a], x: [vx as f64, vy as f64], y: [dx as f64, dy as f64] };
            let arm = |s: i32| self.road_node_at(GridCoord { x: r.x + s * vx, y: r.y + s * vy }).filter(|&n| self.arms_of(here, false).contains(&n));
            let sides = self.sides(frame, square_ways(), here, arm(-1), arm(1));
            if !sides.is_empty() {
                bays.push(KerbBay { at: frame.at((0.0, -SQUARE)), sides });
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

    /// A fronted building's docks: square to the street at its gate, side
    /// by side, each a notch in its front a truck backs into from the
    /// street, its tail to the loading door, as a car backs into a bay at
    /// the kerb (`park::ways::square`), and leaves forward either way.
    /// Each way keeps clear of every other dock and car bay, all taken. A
    /// dock no way reaches is left out.
    fn dock_bays(&self, (tile, street): (GridCoord, EntityId), kind: model::BuildingKind, cars: &[KerbBay]) -> Vec<KerbBay> {
        let Some(r) = self.objects.get(street).and_then(|e| e.position) else { return Vec::new() };
        let (dx, dy) = (r.x - tile.x, r.y - tile.y);
        if dx.abs() + dy.abs() != 1 {
            return Vec::new();
        }
        let (ux, uy) = (dy.abs(), dx.abs());
        if !self.runs_straight(street, (ux, uy)) {
            return Vec::new();
        }
        // The street's frame at the gate: along it with the building on
        // its right, out toward the street; its middle line at y = 0.
        let (vx, vy) = (-dy, dx);
        let frame = Frame { o: [r.x as f64 + 0.5, r.y as f64 + 0.5], x: [vx as f64, vy as f64], y: [dx as f64, dy as f64] };
        let local = |p: [f64; 2]| {
            let q = [p[0] - frame.o[0], p[1] - frame.o[1]];
            (q[0] * frame.x[0] + q[1] * frame.x[1], q[0] * frame.y[0] + q[1] * frame.y[1])
        };
        let n = model::blueprint::blueprint(kind).docks();
        let truck = park::TRUCK;
        let parked_cars: Vec<park::Rect> = cars
            .iter()
            .flat_map(|c| {
                let (x, y) = local(c.at);
                park::bodies(&park::CAR, park::Pose::new(x, y, std::f64::consts::FRAC_PI_2).ahead(-park::CAR.cab.axle())).collect::<Vec<_>>()
            })
            .collect();
        let arm = |s: i32| self.road_node_at(GridCoord { x: r.x + s * vx, y: r.y + s * vy }).filter(|&a| self.arms_of(street, false).contains(&a));
        let mut bays = Vec::new();
        for i in 0..n {
            let x = dock_at(i, n);
            let parked: Vec<park::Rect> = (0..n)
                .filter(|&j| j != i)
                .flat_map(|j| park::bodies(&truck, park::Pose::new(dock_at(j, n), -DOCK, std::f64::consts::FRAC_PI_2).ahead(-truck.cab.axle())).collect::<Vec<_>>())
                .chain(parked_cars.iter().copied())
                .collect();
            let places = park::ways::square(&truck, x, DOCK, Some(NOTCH), &parked, ROAD);
            let sides = self.sides_of(&truck, frame, &places, street, arm(-1), arm(1));
            if !sides.is_empty() {
                bays.push(KerbBay { at: frame.at((x, -DOCK)), sides });
            }
        }
        bays
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
                ws.insert(at, Window { car, from, to, side: 0, exit: 0 });
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
            // A lorry at the door of a front its docks no way reaches stands
            // in it, facing the street; anyone else at a door is not drawn.
            (Way::Kerb { door, street, .. }, Claim::Door) if self.has_front(building) && self.is_lorry(car) => {
                let (d, s) = (self.node_pos(*door)?, self.node_pos(*street)?);
                Some(Pose { at: d, heading: (s[1] - d[1]).atan2(s[0] - d[0]) })
            }
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
    /// already holds; the door in a front for anything but a lorry; else a
    /// spot clear for the whole window, and one it can drive into, near the
    /// door with some looseness, as people park; else the door. `None` only where a
    /// front's docks are all taken: the lorry's trip does not start, and it
    /// waits where it is, honestly, and tries again.
    pub fn claim_spot(&mut self, building: EntityId, car: EntityId, from: GameTime, to: GameTime, usable: impl Fn(usize) -> bool) -> Option<Claim> {
        self.lot_mut(building)?;
        let lot = &self.lots[&building];
        let front = self.has_front(building);
        // A front's docks are for lorries, and its kerb bays for cars.
        let lorry = self.is_lorry(car);
        let docks = lot.docks();
        let usable = |i: usize| usable(i) && (i < docks) == lorry;
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
            .or_else(|| {
                (0..lot.spots.len())
                    .filter(|&i| usable(i) && lot.spots[i].clear_from(car, from, len) == from)
                    .map(|i| (i, appeal(i)))
                    .min_by(|a, b| a.1.total_cmp(&b.1))
                    .map(|(i, _)| Claim::Spot(i))
            })
            // A lorry stops at the door of a front whose docks no way reaches.
            .or_else(|| (!front || !lorry || docks == 0).then_some(Claim::Door));
        let Some(claim) = claim else {
            let lot = self.lots.get_mut(&building).unwrap();
            lot.stats.refused += 1;
            if !lot.refused.contains(&car) {
                lot.refused.push(car);
            }
            return None;
        };
        // Only now, with the new place found, is the old one let go of.
        if self.claims.get(&car) != Some(&building) || self.claim_of(building, car) != Some(claim) {
            self.release_spot(car);
            self.hold(building, car, claim, from, to);
        }
        Some(claim)
    }

    /// Whether a building has a front: docks, and a door for anyone who is
    /// not a lorry.
    fn has_front(&self, building: EntityId) -> bool {
        matches!(self.objects.get(building).map(|e| &e.object), Some(GameObject::Building(b)) if fronted(b.kind))
    }

    /// A depot's own vehicle, lorry or van: what takes a dock.
    fn is_lorry(&self, car: EntityId) -> bool {
        matches!(self.objects.get(car).map(|e| &e.object), Some(GameObject::Car(c)) if c.role != model::CarRole::Private)
    }

    /// Let go of whatever the car holds.
    pub fn release_spot(&mut self, car: EntityId) {
        if let Some(building) = self.claims.remove(&car)
            && let front = self.has_front(building)
            && let Some(lot) = self.lots.get_mut(&building)
        {
            let docked = front && lot.spots.iter().any(|s| s.holder(car).is_some());
            for s in &mut lot.spots {
                s.windows.retain(|w| w.car != car);
            }
            lot.doorway.retain(|&c| c != car);
            if docked {
                self.docks_freed.append(&mut lot.refused);
            }
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
            // front with no dock left. Either way the car is here now, so
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
                let day = model::DAY_MS as u64;
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
            (Way::Kerb { bays, .. }, Claim::Spot(i)) => {
                let exit = lot.exit(&bays[i], i, car);
                std::iter::once(lot.spots[i].node).chain(exit.path.iter().copied()).chain([exit.node]).collect()
            }
            (Way::Kerb { door, street, .. }, Claim::Door) => vec![*door, *street],
        })
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
        let mut routes = crate::pathfinding::Routes::from(self, from);
        // From its own door, a neighbour's lot on the same node is reached
        // with no street between: out of one lot and into the other.
        let street = if to == from && self.lots.contains_key(&building) { vec![from] } else { routes.route_to(to).filter(|r| r.len() >= 2)? };
        // A bay entered from where the car joins the street, across from its
        // own door, is a route of that node alone.
        let bays = entries.into_iter().filter_map(|e| Some((e, if e == from { vec![from] } else { routes.route_to(e).filter(|r| r.len() >= 2)? }))).collect();
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
        let Way::Kerb { bays, .. } = &self.lots[&building].way;
        let sides: Vec<Option<usize>> = bays.iter().map(|b| b.sides.iter().position(|s| ways.bays.get(&s.entry).is_some_and(|r| r.len() < 2 || r[r.len() - 2] != s.ahead))).collect();
        let claim = self.claim_spot(building, car, from, to, |i| sides.get(i).is_none_or(|s| s.is_some()))?;
        let side = |i: usize| sides.get(i).copied().flatten().unwrap_or(0);
        if let Claim::Spot(i) = claim
            && let Some(w) = self.lots.get_mut(&building).unwrap().spots[i].windows.iter_mut().find(|w| w.car == car)
        {
            w.side = side(i);
        }
        let lot = self.lots.get(&building)?;
        let (path, lot_nodes): (&[EntityId], Vec<EntityId>) = match (&lot.way, claim) {
            (Way::Kerb { door, .. }, Claim::Door) => (&ways.street, vec![*door]),
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
            Some(Lot { way: Way::Kerb { street, .. }, .. }) => Some(*street),
            None => self.street_of(building),
        }
    }

    /// The other exit of the way the car took into its kerb bay, back the
    /// way it came, which it may leave by as well, whichever way along
    /// the street it is going (`leave_by`).
    pub fn other_exit(&self, car: EntityId) -> Option<(usize, EntityId)> {
        let (lot, bay, i) = self.bay_of(car)?;
        let side = &bay.sides[lot.side(i, car)];
        side.outs.get(1).map(|e| (1, e.node))
    }

    /// Leave its kerb bay by this exit (`other_exit`).
    pub fn leave_by(&mut self, car: EntityId, exit: usize) {
        let Some(&building) = self.claims.get(&car) else { return };
        let Some(Claim::Spot(i)) = self.claim_of(building, car) else { return };
        if let Some(w) = self.lots.get_mut(&building).and_then(|l| l.spots[i].windows.iter_mut().find(|w| w.car == car)) {
            w.exit = exit;
        }
    }

    /// The lot, bay and spot a car holds a kerb bay by.
    fn bay_of(&self, car: EntityId) -> Option<(&Lot, &KerbWay, usize)> {
        let &building = self.claims.get(&car)?;
        let lot = self.lots.get(&building)?;
        match (&lot.way, self.claim_of(building, car)?) {
            (Way::Kerb { bays, .. }, Claim::Spot(i)) => Some((lot, &bays[i], i)),
            _ => None,
        }
    }

    /// The legs of the car's way into the place it holds, and out of it.
    fn legs_in(&self, car: EntityId) -> &[Leg] {
        self.bay_of(car).map_or(&[], |(lot, bay, i)| &bay.sides[lot.side(i, car)].into)
    }

    fn legs_out(&self, car: EntityId) -> &[Leg] {
        self.bay_of(car).map_or(&[], |(lot, bay, i)| &lot.exit(bay, i, car).legs)
    }

    /// How many edges at the start of the car's way out are driven
    /// backwards: its way out's first legs that back.
    pub fn backs_out(&self, car: EntityId) -> usize {
        self.legs_out(car).iter().take_while(|l| l.back).count()
    }

    /// The nodes a car holds while it turns between the street and its
    /// place, coming or going, besides where it leaves or joins the street:
    /// the street waits at all of them. A kerb bay's, the street nodes
    /// either side of where it turns. A front's lorry holds its door too: a
    /// front is one lorry moving at a time, so one coming in waits at the
    /// gate and one leaving in its dock until the front is clear.
    pub fn stretch(&self, car: EntityId) -> Vec<EntityId> {
        let Some((lot, bay, i)) = self.bay_of(car) else {
            return Vec::new();
        };
        let side = &bay.sides[lot.side(i, car)];
        let mut nodes = vec![side.entry, side.ahead, lot.exit(bay, i, car).node];
        if let Way::Kerb { door, .. } = lot.way
            && self.is_lorry(car)
            && self.has_front(self.claims[&car])
        {
            nodes.push(door);
        }
        nodes.sort_unstable();
        nodes.dedup();
        nodes
    }

    /// How many edges at the end of the car's way in are driven backwards:
    /// one into a dock of a harbour's front; its way in's last legs that
    /// back, at the kerb.
    pub fn reverse_tail(&self, car: EntityId) -> usize {
        self.legs_in(car).iter().rev().take_while(|l| l.back).count()
    }

    /// The moves of the car's way out of where it stands: an edge a leg,
    /// from its first.
    pub fn manoeuvres_out(&self, car: EntityId) -> Vec<model::Manoeuvre> {
        self.legs_out(car).iter().enumerate().map(|(k, l)| l.manoeuvre(k)).collect()
    }

    /// The moves of the car's way into the place it holds, on a route of
    /// `len` nodes: an edge a leg, to its last.
    pub fn manoeuvres_in(&self, car: EntityId, len: usize) -> Vec<model::Manoeuvre> {
        let legs = self.legs_in(car);
        let Some(first) = len.checked_sub(1 + legs.len()) else { return Vec::new() };
        legs.iter().enumerate().map(|(k, l)| l.manoeuvre(first + k)).collect()
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
    /// a pose at a front is at its door.
    pub fn restore_spots(&mut self) {
        let parked: Vec<(EntityId, Option<Pose>, GridCoord)> = self
            .objects
            .iter()
            .filter_map(|e| match e.object {
                // A ferry at its berth stands where it stands: it is in no lot.
                GameObject::Car(ref c) if c.trip.is_none() && c.role != model::CarRole::Ferry => Some((e.id, c.spot, e.position?)),
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
                None => self.has_front(building).then_some(Claim::Door),
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


/// A kind with bays at its kerb: its workers' and customers' cars.
pub fn kerbed(kind: model::BuildingKind) -> bool {
    kind != model::BuildingKind::House && model::blueprint::blueprint(kind).bays() > 0
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
    use model::BuildingKind;

    /// Open land with one street along y = 0.
    fn street() -> Map {
        Map::meadow(-4..40, -4..8).street(-4..40)
    }

    /// A car that finds the drive full stops at the door, unseen, rather
    /// than not setting out: until the kerb has bays, that is where the
    /// rest of a building's visitors stand.
    #[test]
    fn a_full_drive_leaves_the_rest_at_the_door() {
        let mut world = street();
        let house = world.place_on_street(GridCoord { x: 2, y: 1 }, BuildingKind::House).unwrap();
        assert_eq!(world.lot_mut(house).unwrap().spots.len(), 2);
        let car = |world: &mut Map| world.insert_at(GameObject::Car(model::Car::new(0, Default::default())), None);
        let (a, b, c) = (car(&mut world), car(&mut world), car(&mut world));
        assert!(matches!(world.claim_spot(house, a, 10_000, 12_000, |_| true), Some(Claim::Spot(_))));
        assert!(matches!(world.claim_spot(house, b, 10_000, 12_000, |_| true), Some(Claim::Spot(_))));
        assert_eq!(world.claim_spot(house, c, 10_000, 11_000, |_| true), Some(Claim::Door), "the third stops at the door");
        world.release_spot(c);
        assert!(matches!(world.claim_spot(house, c, 12_000, 13_000, |_| true), Some(Claim::Spot(_))), "and after them, it has a spot");
    }

    /// Anything but a home parks square to the kerb: two bays a tile
    /// within its walls, close to the road. A car coming along the lane
    /// beside them goes past and backs in, to leave forward either way; one
    /// coming the other way turns across the road nose in, and backs out
    /// the way it came. Every leg of either is a parking plan, driven
    /// exactly, from where the last one left the car.
    #[test]
    fn a_shop_parks_square_to_the_kerb() {
        let mut world = street();
        let shop = world.place_on_street(GridCoord { x: 2, y: 1 }, BuildingKind::Shop).unwrap();
        let docks = world.lot_mut(shop).unwrap().docks();
        let mut at: Vec<[f64; 2]> = world.lot_mut(shop).unwrap().spots.iter().skip(docks).map(|s| s.pose.at).collect();
        at.sort_by(|a, b| a[0].total_cmp(&b[0]));
        assert_eq!(at.len(), model::blueprint::blueprint(BuildingKind::Shop).bays(), "a bay for each customer, no more: {at:?}");
        for (bay, x) in at.iter().zip([2.41, 2.68, 2.95]) {
            assert!((bay[0] - x).abs() < 1e-9 && (bay[1] - (0.5 + SQUARE)).abs() < 1e-9, "a bay at {bay:?}");
        }
        let car = |world: &mut Map| world.insert_at(GameObject::Car(model::Car::new(0, Default::default())), None);
        for (from, sign) in [(GridCoord { x: -2, y: 0 }, 1.0), (GridCoord { x: 20, y: 0 }, -1.0)] {
            let a = car(&mut world);
            let ways = world.ways_to(shop, world.road_node_at(from).unwrap()).unwrap();
            let (route, to_lot) = world.way_in(shop, a, &ways, 0, GameTime::MAX).unwrap();
            let n = route.len();
            let entry = world.node_pos(route[n - 1 - to_lot]).unwrap();
            let bay = world.node_pos(route[n - 1]).unwrap();
            assert!(sign * (bay[0] - entry[0]) > 0.5, "turned into from behind it, either way: {entry:?} to {bay:?}");
            let into = world.manoeuvres_in(a, n);
            assert_eq!(into.len(), to_lot - 1, "a plan for every leg");
            assert_eq!(world.reverse_tail(a), if sign > 0.0 { 1 } else { 0 }, "backed in from its own lane, nose in from across");
            let start = world.node_pos(route[n - to_lot]).unwrap();
            assert!((start[1] - (0.5 + sign * LANE_OFFSET)).abs() < 1e-6, "starts in the lane it came along: {start:?}");
            world.park_in_lot(shop, a, 0);
            let pose = world.pose_held(a).unwrap();
            assert!((pose.heading + sign * std::f64::consts::FRAC_PI_2).abs() < 1e-6, "facing the street, or the shop: {}", pose.heading);
            // The plan ends where the car stands.
            let last = into.last().unwrap();
            let leg = park::ways::Leg {
                from: park::Pose { x: last.from.at[0], y: last.from.at[1], heading: last.from.heading },
                back: last.moves[0].back,
                moves: last.moves.iter().map(|m| park::Move { back: m.back, from: m.from, to: m.to, length: m.length }).collect(),
            };
            let end = leg.end().ahead(park::CAR.cab.axle());
            assert!((end.x - pose.at[0]).hypot(end.y - pose.at[1]) < 1e-6, "the plan ends in the bay: {end:?} {pose:?}");
            let out = world.way_out(a).unwrap();
            assert_eq!(world.backs_out(a), if sign > 0.0 { 0 } else { 1 }, "forward out, or backed out");
            let (lane, exit) = (world.node_pos(out[out.len() - 2]).unwrap(), world.node_pos(out[out.len() - 1]).unwrap());
            assert!(sign * (exit[0] - lane[0]) > 0.0, "on the way it came: {lane:?} to {exit:?}");
            assert_eq!(world.manoeuvres_out(a).len(), out.len() - 2);
            if sign > 0.0 {
                // Or forward out the other way.
                let (k, _) = world.other_exit(a).expect("either way out");
                world.leave_by(a, k);
                let out = world.way_out(a).unwrap();
                let (lane, exit) = (world.node_pos(out[out.len() - 2]).unwrap(), world.node_pos(out[out.len() - 1]).unwrap());
                assert!(exit[0] < lane[0], "the other way on: {lane:?} to {exit:?}");
            }
        }
    }

    /// A shop on a corner parks on one side, the one its door opens onto:
    /// it needs no more than its long side holds.
    #[test]
    fn a_shop_on_a_corner_parks_on_one_side() {
        let mut world = street();
        let cross: Vec<GridCoord> = (0..8).map(|y| GridCoord { x: 4, y }).collect();
        world.place_road_path(&cross);
        let shop = world.place_on_street(GridCoord { x: 1, y: 1 }, BuildingKind::Shop).unwrap();
        let docks = world.lot_mut(shop).unwrap().docks();
        let at: Vec<[f64; 2]> = world.lot_mut(shop).unwrap().spots.iter().skip(docks).map(|s| s.pose.at).collect();
        assert!(at.iter().all(|p| (p[1] - at[0][1]).abs() < 1e-9) || at.iter().all(|p| (p[0] - at[0][0]).abs() < 1e-9), "all on one side: {at:?}");
    }

    /// A maker's docks are notches in its front at its gate. A truck goes
    /// on past its dock along the street, stops, and backs round into it
    /// in one go, and leaves forward.
    #[test]
    fn a_maker_has_docks_a_truck_backs_into() {
        let mut world = street();
        let depot = world.place_on_street(GridCoord { x: 4, y: 1 }, BuildingKind::Sawmill).unwrap();
        let shop = world.place_on_street(GridCoord { x: 9, y: 1 }, BuildingKind::Shop).unwrap();
        assert_eq!(world.lot_mut(depot).unwrap().docks(), model::blueprint::blueprint(BuildingKind::Sawmill).docks(), "a dock for each lorry and each one waiting");
        let b = match world.objects.get(depot).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.clone(),
            _ => unreachable!(),
        };
        assert_eq!(world.door_of(depot).map(|d| d.0), Map::gate_of(&b.tiles, b.kind, b.facing), "the door is the gate");
        world.lot_mut(shop).unwrap();
        // One of the depot's own lorries, in its dock since the depot was reached.
        let lorry = world.objects.iter().find(|e| matches!(e.object, GameObject::Car(ref c) if c.owner == depot && c.role == model::CarRole::Truck)).map(|e| e.id).unwrap();
        world.release_spot(lorry);
        let ways = world.ways_to(depot, world.road_node_at(GridCoord { x: 30, y: 0 }).unwrap()).unwrap();
        let (way, to_lot) = world.way_in(depot, lorry, &ways, 0, GameTime::MAX).unwrap();
        let n = way.len();
        assert_eq!((to_lot, world.reverse_tail(lorry)), (2, 1), "backed in from the street");
        let into = world.manoeuvres_in(lorry, n);
        assert_eq!(into.len(), 1);
        assert!(into[0].moves.iter().all(|m| m.back), "backed in in one go: {into:?}");
        world.park_in_lot(depot, lorry, 0);
        let out = world.way_out(lorry).unwrap();
        assert_eq!(out[0], way[n - 1], "out of the dock");
        assert_eq!(world.backs_out(lorry), 0, "forward");
        let gate = world.door_of(depot).unwrap();
        let held = world.stretch(lorry);
        assert!(held.contains(&gate.1) || held.iter().any(|n| world.arms_of(gate.1, false).contains(n)), "the street waits while it turns");
    }

}
