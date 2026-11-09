//! What everything in the game is: every thing it keeps and sends, and
//! the fixed rules of what each kind of thing does (`blueprint`).
//! Nothing here knows the world they are in.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use land::ChunkCoord;

pub mod blueprint;

/// Game time in milliseconds (monotonic, starts at 0).
pub type GameTime = u64;

pub type EntityId = u64;
pub type EdgeKey = (EntityId, EntityId);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Hash)]
#[ts(export)]
pub struct GridCoord {
    pub x: i32,
    pub y: i32,
}

/// A step of the mayor's road or demolisher: one tile to the next, or a
/// tap, from and to the same tile. A drag is its steps, each built as it
/// is sent.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Build {
    pub tool: Tool,
    pub from: GridCoord,
    pub to: GridCoord,
    /// How high each end stands, in half-levels (`RoadNode::height`);
    /// none, both on the ground.
    #[serde(default)]
    #[ts(optional)]
    pub up: Option<[u8; 2]>,
    /// Which side of its tile each end stands (`RoadNode::side`); none,
    /// both in the middle.
    #[serde(default)]
    #[ts(optional)]
    pub sides: Option<[[i8; 2]; 2]>,
    /// The road laid has priority (`RoadNode::road`): whoever joins or
    /// crosses it gives way. Along a road already there, it gains or loses
    /// it.
    #[serde(default)]
    pub road: bool,
}

/// A drag of road, the whole of it so far (`draw.rs`): sent again as it
/// goes on, and laid as a whole, the server keeping what it laid of it
/// before where that still stands as planned.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Stroke {
    /// Which drag this is: the same as the last sent, that drag drawn on;
    /// another, a new one.
    pub id: u32,
    /// Street, OneWay or Wide.
    pub tool: Tool,
    /// The road laid has priority (`RoadNode::road`).
    #[serde(default)]
    pub road: bool,
    /// The tiles the drag has been through, the first where it was
    /// pressed, each a step from the one before; and with each, the pen's
    /// height, in half-levels, as the drag reached it.
    pub tiles: Vec<Spot>,
    /// Where on the first tile it was pressed: the road there it starts
    /// on, its height and side; none, at the pen's height in the middle.
    #[serde(default)]
    #[ts(optional)]
    pub start: Option<Stand>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
pub struct Spot {
    pub at: GridCoord,
    pub want: u8,
}

/// Where on a tile a road stands: its height and side.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
pub struct Stand {
    pub h: u8,
    pub side: [i8; 2],
}

/// What the hand asks before it acts, to show where it may (`hint.rs`):
/// answered with a `Hint`, to the asking client alone.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", content = "data")]
pub enum Ask {
    /// Which tiles in this area a drag with the tool in hand may start
    /// from, or the building in hand stand round.
    Starts { hand: Holding, area: Area },
    /// Where a drag may go on from the last tile of this one: for a road,
    /// the drag as drawn so far; for the eraser, the tile it is on and
    /// where on it it stands (`Stroke::start`).
    Reach(Stroke),
    /// Where the building in hand, held over this tile, would be placed.
    Placing { kind: BuildingKind, at: GridCoord, facing: Option<u8> },
}

/// What the hand holds, for `Ask::Starts`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", content = "data")]
pub enum Holding {
    /// A tool, with priority or not, the pen at this height in half-levels.
    Tool { tool: Tool, road: bool, want: u8 },
    /// A building, turned this way, or left to find its way.
    Building { kind: BuildingKind, facing: Option<u8> },
}

/// Tiles from one corner to the other, both in.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Area {
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
}

/// The game's answer to an `Ask`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", content = "data")]
pub enum Hint {
    Starts { hand: Holding, area: Area, tiles: Vec<GridCoord> },
    /// For the drag `id`, `len` tiles long: the eight ways on from its
    /// last tile (east, then on round toward +y), each where it would
    /// stand on each tile straight on that way, as far as it may go, up
    /// to a few (`draw::RUN`); empty, where it may not go at all.
    Reach { id: u32, len: u32, ways: Vec<Vec<Stand>> },
    Placing(Placing),
}

/// A building held over the map: where letting go would place it, the
/// way it would face, its door if it has one, and, if it may not go
/// there, why, in words.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Placing {
    pub kind: BuildingKind,
    /// The tile it is placed round.
    pub at: GridCoord,
    pub tiles: Vec<GridCoord>,
    pub facing: u8,
    /// The tile its drive runs onto, and the street it runs from.
    pub door: Option<Door>,
    pub why: Option<String>,
    /// For a maker of what the land gives, how much of it is in reach,
    /// up to one (`Map::in_reach`): what it will make against its best.
    pub ground: Option<f64>,
}

/// What the mayor's hand holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Tool {
    /// A street, both ways: what buildings front.
    Street,
    /// A street one way, `from` to `to`.
    OneWay,
    /// Whatever stands on `to`, a building whole; a drag cuts the road
    /// between its tiles.
    Demolish,
    /// Traffic lights at the junction on `to`, or none where it has them.
    Light,
    /// A road of two lanes, one way, `from` to `to`.
    Wide,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RoadNode {
    #[ts(type = "Array<number>")]
    pub outgoing: Vec<EntityId>,
    #[ts(type = "Array<number>")]
    pub incoming: Vec<EntityId>,
    /// Part of a network that reaches a harbour, the door everything comes
    /// in and goes out by. Otherwise an island: drawn red, driven by nobody.
    #[serde(default)]
    pub joined: bool,
    /// The neighbours the way to is a road rather than a street: a through
    /// road, which the streets that meet it give way to. Both ends hold it.
    /// The mayor's buildings may front one as they do a street; the town's
    /// own families never settle beside one.
    #[serde(default)]
    #[ts(type = "Array<number>")]
    pub road: Vec<EntityId>,
    /// Laid by the mayor, so it was paid for. A fixture's or a level's
    /// roads, and driveways, are free.
    #[serde(default)]
    pub laid: bool,
    /// How high it stands, in half-levels: 0 the ground, 2 a level up, 4
    /// two, 6 three; odd, a slope between the level below and the one
    /// above (`map/decks.rs`).
    #[serde(default)]
    pub height: u8,
    /// Traffic lights, if the junction has them: which phase is green
    /// (`intersection::phases_of`), or `ALL_RED` between phases.
    #[serde(default)]
    pub light: Option<u8>,
    /// The neighbours the road out to has two lanes, one way: a two-lane
    /// one-way (`Tool::Wide`).
    #[serde(default)]
    #[ts(type = "Array<number>")]
    pub wide: Vec<EntityId>,
    /// Which side of its tile it stands: the step across its road it is
    /// moved by, or none, the middle. Two one-ways share a tile side by
    /// side, each a thin road beside the other (`map/decks.rs`).
    #[serde(default)]
    pub side: [i8; 2],
}

/// A junction's lights between phases, none green.
pub const ALL_RED: u8 = u8::MAX;

/// What stands on a plot: a home, a shop, or one of the makers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum BuildingKind {
    /// A family's home: a cottage that grows into a house, a townhouse and
    /// an apartment as its family is brought what it asks for
    /// (`Home::level`). Nobody places one: families settle by the roads.
    House,
    /// Where families buy what they want: its lorry fetches each good from
    /// whoever makes it, and they drive over to buy.
    Shop,
    /// A boat off the shore and a shed on it: fish.
    Fishery,
    /// Felling the forest round it: logs.
    Woodcutter,
    /// Logs sawn into planks.
    Sawmill,
    /// Wheat off the meadow its tractor works.
    Farm,
    /// Wheat baked into bread.
    Bakery,
    /// Clay dug out of the ochre ground it stands on.
    ClayPit,
    /// Clay fired into bricks over logs.
    Brickworks,
    /// Planks made into furniture.
    Workshop,
    /// Sand dug off the beach.
    SandPit,
    /// Sand melted into glass over logs.
    Glassworks,
    /// Sheep on the meadow: wool.
    SheepFarm,
    /// Wool sewn into clothes.
    Tailor,
    /// A fire engine, out to whatever house catches fire.
    FireStation,
}

impl BuildingKind {
    /// Every kind, in declaration order — the order of the blueprint table.
    pub const ALL: [BuildingKind; 15] = [
        BuildingKind::House,
        BuildingKind::Shop,
        BuildingKind::Fishery,
        BuildingKind::Woodcutter,
        BuildingKind::Sawmill,
        BuildingKind::Farm,
        BuildingKind::Bakery,
        BuildingKind::ClayPit,
        BuildingKind::Brickworks,
        BuildingKind::Workshop,
        BuildingKind::SandPit,
        BuildingKind::Glassworks,
        BuildingKind::SheepFarm,
        BuildingKind::Tailor,
        BuildingKind::FireStation,
    ];
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Building {
    pub kind: BuildingKind,
    /// The tiles it stands on, its lot's among them; the first is where it
    /// is, the tile it is known by.
    #[serde(default)]
    pub tiles: Vec<GridCoord>,
    /// Which side of the building the lot and the street are on; see
    /// `blueprint::FACINGS`. The client lays the building and the lot out
    /// within the footprint from this.
    pub facing: u8,
    /// Its goods, by good: a maker's yard of what it made and what it
    /// takes, a shop's shelves, in whole crates on its pad.
    #[serde(default)]
    pub stocks: std::collections::BTreeMap<Good, Stock>,
    /// Its forklifts' work: each a run of crates lifted between its pad
    /// and a vehicle standing at it, one at a time (`Map::lift`). The
    /// server moves the goods as a run starts; the client plays it.
    #[serde(default)]
    pub lifts: Vec<Lift>,
    /// A house's family: who lives here and what they want.
    #[serde(default)]
    pub home: Option<Home>,
    /// A maker's seats: the cars of the workers who hold them, whether at
    /// their post or on the road to it.
    #[serde(default)]
    #[ts(type = "Array<number>")]
    pub crew: Vec<EntityId>,
    /// Of the crew, how many are at their post now: what it works at.
    #[serde(default)]
    pub present: u32,
    /// How far through the crate it is making, 0 to 1.
    #[serde(default)]
    pub work: f64,
    /// A farm's land: the grass it claimed when a street reached it, each
    /// tile at a stage of the cycle the tractor drives it through
    /// (`map/fields.rs`). A tile built over is dropped.
    #[serde(default)]
    pub land: Vec<Tile>,
    /// Where the tractor last drove: one run's path, which the client
    /// draws the field along.
    #[serde(default)]
    pub ruts: Vec<GridCoord>,
    /// Where it is driven into: one of its tiles, and the street tile
    /// beside it the drive runs from.
    #[serde(default)]
    pub door: Option<Door>,
    /// Burning since when: a fire engine there by `FIRE_MS` puts it out,
    /// else the house burns down.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub fire: Option<GameTime>,
}

/// A family, and how it lives: its size, what it wants and since when,
/// and how it grows.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Home {
    /// 1 a cottage, 2 a house, 3 a townhouse, 4 an apartment.
    pub level: u8,
    /// What it wants now, each since when, and the car gone for it.
    pub wants: Vec<Want>,
    /// When it will next want each good it eats.
    #[ts(type = "Record<string, number>")]
    pub due: std::collections::BTreeMap<Good, GameTime>,
    /// Put by: what it bought beyond today's want, to last until the
    /// next trip (a pantry).
    #[serde(default)]
    #[ts(type = "Record<string, number>")]
    pub pantry: std::collections::BTreeMap<Good, u32>,
    /// Growing to the next level: each material it asked for, and how
    /// much has come.
    #[serde(default)]
    pub growing: Option<std::collections::BTreeMap<Good, Stock>>,
    /// Wants met since it last grew: a family well looked after grows.
    #[serde(default)]
    pub fed: u32,
}

/// Something a family wants: a good, since when, and the car out for it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Want {
    pub good: Good,
    #[ts(type = "number")]
    pub since: GameTime,
    #[ts(type = "number | null")]
    pub by: Option<EntityId>,
}

/// So much of a good held, of so much room.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Stock {
    pub level: f64,
    pub cap: f64,
}

impl Stock {
    pub fn short(&self) -> f64 {
        self.cap - self.level
    }
}

/// A building's door: its tile a drive runs onto, and the street tile the
/// drive runs from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Door {
    pub tile: GridCoord,
    pub street: GridCoord,
}

/// A tile of a farm's land, and where it is in the cycle: grass until the
/// tractor ploughs it, bare until it seeds it, growing from `since` until a
/// day on, cut after the harvest, and ploughed again.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Tile {
    pub at: GridCoord,
    pub stage: Stage,
    #[ts(type = "number")]
    pub since: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Stage {
    Grass,
    Ploughed,
    Sown,
    Cut,
}

/// What a tractor does to a tile as it drives over it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Job {
    Plough,
    Seed,
    Harvest,
}

/// A ship's leg over the water (`traffic::sea::water::route`): the way, in
/// tiles, from the ferry's middle at one end to the other, and when it
/// set out and arrives. It gathers way from a berth and comes into one
/// at an even push (`ease`: the start is a berth, the end is), at full
/// speed over the map's edge; `traffic::sea::covered` says how far along it
/// is at any moment, here and in the client. A leg is sailed in pieces
/// where it stops at a junction's mouth (`traffic::sea::voyage`); each piece
/// is sent once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Sail {
    pub path: Vec<[f64; 2]>,
    #[ts(type = "number")]
    pub started: u64,
    #[ts(type = "number")]
    pub ends: u64,
    pub ease: [bool; 2],
    /// Its land end trails: it is sailing out from a berth, as a
    /// double-ended ferry does, never turning.
    pub astern: bool,
}

/// A tractor's run off the roads, over its farm's land. The tiles it
/// drives in order, doing its job to each as it arrives, standing on the first at `started` and reaching one more
/// every `pace` milliseconds. No route, no claims, no queue — and nothing
/// that changes as it goes, so the run is sent once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Run {
    pub job: Job,
    pub path: Vec<GridCoord>,
    #[ts(type = "number")]
    pub started: u64,
    #[ts(type = "number")]
    pub pace: u64,
}

impl Building {
    /// One of a kind, placed, with nothing in it yet.
    pub fn new(kind: BuildingKind, tiles: Vec<GridCoord>, facing: u8) -> Building {
        Building { kind, tiles, facing, stocks: Default::default(), lifts: Vec::new(), home: None, crew: Vec::new(), present: 0, work: 0.0, land: Vec::new(), ruts: Vec::new(), door: None, fire: None }
    }
}

/// What a car is for, which is who drives it and what it looks like.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum CarRole {
    /// A family's own.
    #[default]
    Private,
    /// A lorry with a flatbed: a shop's or a maker's, fetching crates.
    Truck,
    /// A small van: unused for now.
    Van,
    /// A farm's: out along the track to a ripe field and home with the
    /// crop, driven by a hand on shift. On the road it is a slow car.
    Tractor,
    /// The world's ferry: in from the map's edge to a harbour's ramp on the
    /// timetable, settlers and pallets on its deck, and away again. Never
    /// on a road.
    Ferry,
}

/// Someone's car, or a building's lorry. It outlives its journeys: between
/// trips it sits parked at a building, and everything about the journey
/// it is on lives in `trip`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Car {
    /// The building it belongs to: a family's house, or the shop or maker
    /// whose lorry it is.
    #[ts(type = "number")]
    pub owner: EntityId,
    pub trip: Option<Trip>,
    #[serde(default)]
    pub role: CarRole,
    /// Where it stands while parked, if the lot had room: the spot's centre
    /// and the way its nose points, in radians. `None` is parked out of
    /// sight.
    #[serde(default)]
    pub spot: Option<Pose>,
    /// A tractor's run over its farm's land, while it is on one.
    #[serde(default)]
    pub run: Option<Run>,
    /// A ship's leg, while it sails one.
    #[serde(default)]
    pub sail: Option<Sail>,
    /// What it carries: crates on a lorry's bed, a family's shopping.
    #[serde(default)]
    pub cargo: Vec<Package>,
    /// Off to work or home from it: drawn in the commuters' blue.
    #[serde(default)]
    pub commuting: bool,
    /// When the forklift is done with it.
    #[serde(default)]
    #[ts(type = "number")]
    pub due: u64,
}

impl Car {
    /// A car as it arrives: parked out of sight, going nowhere, empty.
    pub fn new(owner: EntityId, role: CarRole) -> Car {
        Car { owner, trip: None, role, spot: None, run: None, sail: None, cargo: Vec::new(), commuting: false, due: 0 }
    }
}

/// A place to stand, and which way.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Pose {
    pub at: [f64; 2],
    pub heading: f64,
}

/// An edge of a trip between the street and a place to stand, the edge
/// from `route[edge]` on: the vehicle's middle from one pose to the other
/// along one smooth curve, leaving and arriving the way it moves, forward
/// or backing (`back`). Nothing about it is steered: what the server
/// measures, the client draws (`driver.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Manoeuvre {
    pub edge: usize,
    pub from: Pose,
    pub to: Pose,
    pub back: bool,
}

impl Manoeuvre {
    /// How many pieces the curve is drawn in (`STEPS` in `driver.ts`).
    pub const STEPS: usize = 24;

    /// The curve, a cubic Bézier: from `from` along the way it moves, to
    /// `to` along the way it moves, each end's arm two fifths of the
    /// chord, so a quarter turn is near a quarter circle.
    pub fn points(&self) -> Vec<[f64; 2]> {
        let (a, b) = (self.from.at, self.to.at);
        let arm = 0.4 * (b[0] - a[0]).hypot(b[1] - a[1]);
        let way = |h: f64| if self.back { h + std::f64::consts::PI } else { h };
        let (h0, h1) = (way(self.from.heading), way(self.to.heading));
        let c0 = [a[0] + h0.cos() * arm, a[1] + h0.sin() * arm];
        let c1 = [b[0] - h1.cos() * arm, b[1] - h1.sin() * arm];
        (0..=Self::STEPS)
            .map(|i| {
                let t = i as f64 / Self::STEPS as f64;
                let u = 1.0 - t;
                let (w0, w1, w2, w3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
                [w0 * a[0] + w1 * c0[0] + w2 * c1[0] + w3 * b[0], w0 * a[1] + w1 * c0[1] + w2 * c1[1] + w3 * b[1]]
            })
            .collect()
    }

    /// How long it is, as drawn.
    pub fn length(&self) -> f64 {
        self.points().windows(2).map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1])).sum()
    }
}

/// A good: what a yard, a shelf or a crate holds, and what a family
/// wants. Each is made by one kind (`blueprint::maker`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Good {
    Fish,
    Logs,
    Planks,
    Wheat,
    Bread,
    Clay,
    Bricks,
    Furniture,
    Sand,
    Glass,
    Wool,
    Clothes,
}

impl Good {
    /// Every good, in declaration order.
    pub const ALL: [Good; 12] = [Good::Fish, Good::Logs, Good::Planks, Good::Wheat, Good::Bread, Good::Clay, Good::Bricks, Good::Furniture, Good::Sand, Good::Glass, Good::Wool, Good::Clothes];

    pub fn name(self) -> &'static str {
        match self {
            Good::Fish => "fish",
            Good::Logs => "logs",
            Good::Planks => "planks",
            Good::Wheat => "wheat",
            Good::Bread => "bread",
            Good::Clay => "clay",
            Good::Bricks => "bricks",
            Good::Furniture => "furniture",
            Good::Sand => "sand",
            Good::Glass => "glass",
            Good::Wool => "wool",
            Good::Clothes => "clothes",
        }
    }
}

/// A crate: the unit everything is made, carried and stacked in, whole.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Package {
    /// Its number, for following it.
    #[ts(type = "number")]
    pub id: u64,
    pub good: Good,
}

/// A forklift's run at a building's pad: `n` crates of a good lifted
/// one at a time between the pad and a vehicle standing at it, onto it or
/// off it, the first from `start`, one every `every` ms, by the building's
/// forklift `k`. The client plays it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Lift {
    #[ts(type = "number")]
    pub car: EntityId,
    pub good: Good,
    pub n: u32,
    pub onto: bool,
    #[ts(type = "number")]
    pub start: u64,
    #[ts(type = "number")]
    pub every: u64,
    pub k: u8,
}

impl Lift {
    pub fn ends(&self) -> u64 {
        self.start + self.n as u64 * self.every
    }
}


/// One journey: born when the driver pulls out, gone on arrival.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Trip {
    /// The building this trip ends at.
    #[ts(type = "number")]
    pub destination: EntityId,
    /// When this trip would end on empty roads, fixed at departure. The gap
    /// between this and the actual arrival is time lost to traffic.
    #[ts(type = "number")]
    pub eta: u64,
    #[serde(skip)]
    #[ts(skip)]
    pub route: Vec<EntityId>,
    pub route_positions: Vec<[f64; 2]>,
    /// How high each node of the route stands (`RoadNode::height`): the
    /// client lifts the car over a deck, and finds which node it is on.
    #[serde(default)]
    pub route_heights: Vec<u8>,
    /// The lane kept on the edge into each node of the route
    /// (`World::lanes_for`): 0 the right, 1 the left of a road of two.
    #[serde(default)]
    pub lanes: Vec<u8>,
    /// How many nodes at either end of the route are in a lot rather than on
    /// the street: the spot pulled out of, the spot driven into. Lot nodes
    /// are drawn where they are, not offset onto a lane.
    pub from_lot: usize,
    pub to_lot: usize,
    /// The stretches driven backwards, as `[a, b]`: the edges from route[k]
    /// to route[k + 1] for a <= k < b. A car backing out of its driveway, a
    /// lorry backing into its dock. Each end of one is a change of gear.
    #[serde(default)]
    pub backing: Vec<[usize; 2]>,
    /// How far along the route, by `progress`, each change of gear and each
    /// end of a parking move is: the client drives each stretch between
    /// them to fit exactly.
    #[serde(default)]
    pub cusps: Vec<f64>,
    /// The edges driven by a parking plan, laid out across a lot.
    #[serde(default)]
    pub manoeuvres: Vec<Manoeuvre>,
    /// Where it stood when it set out, and where it will stand at the end:
    /// a spot's own pose, which a route's first and last edges need not
    /// point along. The client's drive starts from the one and ends on the
    /// other, so leaving and parking are no jump.
    #[serde(default)]
    pub leaves: Option<Pose>,
    #[serde(default)]
    pub stands: Option<Pose>,
    /// Cumulative distance along the route.
    pub progress: f64,
    pub speed: f64,
    pub acceleration: f64,
    /// Total arc length of the entire route.
    pub total_route_length: f64,
    #[ts(type = "number")]
    pub updated_at: u64,
    /// Current segment (1-based). The car is between route[ri-1] and route[ri].
    #[ts(skip)]
    pub route_index: usize,
    /// Precomputed arc length of each segment. segment_lengths[i] = length from
    /// route[i-1] to route[i]. Index 0 is unused (always 0.0).
    #[serde(skip)]
    #[ts(skip)]
    pub segment_lengths: Vec<f64>,
    /// How far along the route each node is: `along[k]` is
    /// `segment_lengths[1..=k]` summed (`car::spawn::along`).
    #[serde(skip)]
    #[ts(skip)]
    pub along: Vec<f64>,
    /// Where it joined the run of road it is on, which way it set off, and
    /// when: the direction names the run, since two runs can share both
    /// ends (`RoadNetwork::observe_passage`).
    #[serde(skip)]
    #[ts(skip)]
    pub joined: Option<(EntityId, EntityId, u64)>,
    /// Standing where its gear changes, until when.
    #[serde(skip)]
    #[ts(skip)]
    pub standing: Option<u64>,
    /// What it last slowed or stopped for, and how hard (`car::Cause`):
    /// for a replay to read, never the game.
    #[serde(skip)]
    #[ts(skip)]
    pub why: Option<(crate::Cause, f64)>,
    /// Its last change of lanes along a road of two (`car::simulation`):
    /// for the client to slide it across while it lasts.
    #[serde(default)]
    pub shift: Option<Shift>,
    /// Standing still on its way since when, and, stood past
    /// `car::GHOST_MS`, the route index it goes through everything to
    /// (`car::simulation`). Never saved.
    #[serde(skip)]
    #[ts(skip)]
    pub stood: Option<u64>,
    #[serde(skip)]
    #[ts(skip)]
    pub ghost: Option<usize>,
    /// The lane it waits to get into, with no room there yet: whoever
    /// comes along behind in it may drop back and let it in.
    #[serde(default)]
    #[ts(skip)]
    pub signal: Option<u8>,
}

impl Trip {
    /// How far along its route it is now, and how fast it goes.
    pub fn at(&self, now: GameTime) -> (f64, f64) {
        catch_up(self.progress, self.speed, self.acceleration, (now - self.updated_at) as f64 / 1000.0)
    }

    /// How far along its route an edge of it starts.
    pub fn start_of(&self, edge: EdgeKey) -> Option<f64> {
        (1..self.route.len()).find(|&i| (self.route[i - 1], self.route[i]) == edge).map(|i| self.along[i - 1])
    }
}

/// Tiles a second on an open road: the most any car goes.
pub const CRUISE_SPEED: f64 = 1.5;

/// Advance kinematics by dt seconds with constant acceleration.
///
/// Braking stops the car rather than reversing it, and accelerating stops at
/// the cruising speed rather than sailing past it. Nothing else held that
/// ceiling: acceleration is only recomputed when a car wakes, so between two
/// wakes it simply kept gaining, and cars were driving stretches of road
/// faster than the road allows.
pub fn catch_up(progress: f64, speed: f64, accel: f64, dt: f64) -> (f64, f64) {
    if accel < 0.0 {
        let dt = dt.min(-speed / accel);
        return (
            progress + speed * dt + 0.5 * accel * dt * dt,
            (speed + accel * dt).max(0.0),
        );
    }
    // Pulling away up to the ceiling, then holding it for what is left.
    let to_ceiling = if accel > 0.0 { (CRUISE_SPEED - speed) / accel } else { f64::INFINITY };
    if to_ceiling >= dt {
        return (progress + speed * dt + 0.5 * accel * dt * dt, speed + accel * dt);
    }
    // A car already over the ceiling settles back onto it.
    let t = to_ceiling.max(0.0);
    (
        progress + speed * t + 0.5 * accel * t * t + CRUISE_SPEED * (dt - t),
        CRUISE_SPEED,
    )
}

/// A change of lanes: from one to the other, from `at` until `until`, in
/// sim ms. While it lasts the car stands in both. It steers across from
/// `along` its way, over `over` of it (the client's path bends there).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq)]
#[ts(export)]
pub struct Shift {
    pub from: u8,
    pub to: u8,
    #[ts(type = "number")]
    pub at: u64,
    #[ts(type = "number")]
    pub until: u64,
    pub along: f64,
    pub over: f64,
}

/// Terrain is static, so it travels as a block of tile types rather than as
/// entities. The payload carries CHUNK_SKIRT tiles of margin on every side:
/// the client derives corner shapes from surrounding types, reaching up to
/// two tiles past the one it is drawing.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TerrainChunk {
    pub coord: ChunkCoord,
    /// CHUNK_STRIDE^2 bytes, row-major from the chunk origin minus the skirt.
    #[serde(with = "serde_bytes")]
    #[ts(type = "Uint8Array")]
    pub tiles: Vec<u8>,
    /// The mountains' heights over the chunk and a tile round it, eroded
    /// (`mountains.rs`): `mountains::SIDE` by `SIDE` points, `SAMPLES` to
    /// a tile, a row of x at a time from a tile short of its corner, each
    /// two bytes, low first, in `UNIT`s of a tile. Empty off the mountains.
    #[serde(with = "serde_bytes")]
    #[ts(type = "Uint8Array")]
    pub heights: Vec<u8>,
    /// What lies under each tile, as `tiles` is laid out: 0 nothing, else
    /// `Deposit::to_byte`. Empty where nothing lies under the chunk.
    #[serde(with = "serde_bytes", default)]
    #[ts(type = "Uint8Array")]
    pub deposits: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "kind", content = "data")]
pub enum GameObject {
    RoadNode(RoadNode),
    Building(Building),
    Car(Car),
}

/// Who a player is. Assigned on connect.
pub type OwnerId = u64;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GameObjectEntry {
    #[ts(type = "number")]
    pub id: EntityId,
    pub object: GameObject,
    pub position: Option<GridCoord>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChunkBounds {
    pub min_cx: i32,
    pub min_cy: i32,
    pub max_cx: i32,
    pub max_cy: i32,
}

impl ChunkBounds {
    pub fn coords(&self) -> impl Iterator<Item = ChunkCoord> + '_ {
        (self.min_cy..=self.max_cy)
            .flat_map(move |cy| (self.min_cx..=self.max_cx).map(move |cx| ChunkCoord { cx, cy }))
    }

}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", content = "data")]
pub enum ClientMessage {
    /// A step of a road or the demolisher, built as it is sent.
    Build(Build),
    /// A drag of road, the whole of it so far (`draw.rs`).
    Draw(Stroke),
    /// Where the hand may go (`hint.rs`).
    Ask(Ask),
    /// A building from the hand placed whole round `at`, its front this
    /// way (`blueprint::FACINGS`); none, the first way it fits.
    Place { kind: BuildingKind, at: GridCoord, facing: Option<u8> },
    /// A building taken down whole: a house's family moves along, a
    /// placed building goes back to the hand.
    Raze { #[ts(type = "number")] building: EntityId },
    /// The player's last road taken back.
    Undo,
    /// A card of the pick on the table taken.
    Pick(u8),
    /// A lorry from the hand, for this building to run.
    AddLorry { #[ts(type = "number")] building: EntityId },
    /// Sim steps per tick: 0 pauses, 1 plays, 2 and 4 are fast.
    SetSpeed(u32),
    /// As fast as the game goes until this sim time, then speed 1. Dev-only.
    RunTo(#[ts(type = "number")] u64),
    /// A new town on a new island.
    ResetWorld,
    SetChunks(ChunkBounds),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "op", content = "data")]
pub enum Operation {
    Upsert(Box<GameObjectEntry>),
    Delete(#[ts(type = "number")] EntityId),
}

/// Simulated time of one full day and night: four minutes watched at
/// speed 1. A tile is about 12 m and a car drives 1.5 tiles a second, so a
/// day is a few crossings of a grown town: a family shops once or twice
/// in it, a worker works a shift and rests.
pub const DAY_MS: u32 = 240_000;
/// An hour of the clock.
pub const HOUR: u32 = DAY_MS / 24;

/// The simulation's clock, as the client needs to see it.
///
/// `speed` is how many 10ms steps the server runs per tick, so it is also the
/// rate sim time advances relative to wall time — the client extrapolates car
/// positions with it between updates.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Clock {
    #[ts(type = "number")]
    pub now: u64,
    pub speed: u32,
    pub day_ms: u32,
}

/// The town as its mayor sees it: who lives here, what there is to build
/// with, and the pick on the table.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Town {
    /// Everyone who lives here.
    pub people: u32,
    /// Road tiles left to lay.
    pub roads: u32,
    /// Buildings in hand, to place.
    pub hand: Vec<(BuildingKind, u32)>,
    /// Lorries in hand, for a building to take on.
    pub lorries: u32,
    /// The road tools the town has: the street, the bulldozer, and those
    /// picked since.
    pub tools: Vec<Unlock>,
    /// People who moved in or up since the last pick, and how many bring
    /// the next.
    pub toward: u32,
    pub step: u32,
    /// People who left, all told.
    pub left: u32,
    /// The pick on the table: the game waits while it is.
    pub offer: Vec<Offer>,
    /// The day it is, from 1; and the clean days in a row (nobody left).
    pub day: u32,
    pub streak: u32,
    /// The town's standing: 0 a hamlet, then village, town, city.
    pub status: u8,
    /// Yesterday, said at dawn: who came and who left.
    pub dawn: Option<Dawn>,
    /// Where the town began, for the camera to find it.
    pub start: Option<GridCoord>,
}

/// A day, summed up at the next dawn.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Dawn {
    pub day: u32,
    pub came: u32,
    pub left: u32,
    pub grew: u32,
}

/// A card of a pick.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "kind", content = "data")]
pub enum Offer {
    /// So many of a building, to place.
    Building(BuildingKind, u32),
    /// So many more road tiles.
    Roads(u32),
    /// A road tool, for good.
    Tool(Unlock),
    /// So many more lorries, each for a building that runs one to take on
    /// a second.
    Lorry(u32),
}

/// A road tool to unlock (the street and the bulldozer come with the town).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Unlock {
    /// Main roads: the streets that meet one give way.
    Priority,
    /// Traffic lights at a junction.
    Lights,
    /// One-way streets.
    OneWay,
    /// Two lanes one way.
    Wide,
    /// Roads raised over others: bridges and the motorway's flyovers.
    Overpass,
}

impl Unlock {
    pub const ALL: [Unlock; 5] = [Unlock::Priority, Unlock::Lights, Unlock::OneWay, Unlock::Wide, Unlock::Overpass];
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StateUpdate {
    pub ops: Vec<Operation>,
    pub clock: Clock,
    pub town: Town,
    pub island: ChunkBounds,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", content = "data")]
pub enum ServerMessage {
    /// Who you are.
    Welcome(#[ts(type = "number")] OwnerId),
    Update(StateUpdate),
    /// How many of this client's messages are done, sent after what they
    /// changed: what it guessed they would do may go (`state/guess.ts`).
    Seen(u32),
    TerrainChunk(TerrainChunk),
    UnloadChunk(ChunkCoord),
    /// What happened that the mayor should hear: a family left, a
    /// building refused.
    News(Vec<News>),
    /// The answer to an `Ask`.
    Hint(Hint),
}

/// A line of news, and the building a tap on it goes to.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct News {
    pub text: String,
    pub sub: String,
    #[ts(type = "number")]
    pub at: EntityId,
}

/// What a car slows or stops for (`World::why`): read by a replay, to
/// say what a car was doing, never by the game.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Cause {
    /// The car ahead in its lane.
    Ahead(crate::EntityId),
    /// A car coming into its lane at the junction ahead from another arm.
    Merging(crate::EntityId),
    /// A car in the other lane it lets in ahead of it.
    LettingIn(crate::EntityId),
    /// The lane its way out asks for, not yet got into: the car in the way
    /// there, if it has tried.
    GettingIn(Option<crate::EntityId>),
    /// A junction, crossing or driveway it has no passage at yet.
    Junction(crate::EntityId),
    /// A bend.
    Bend,
    /// A lot, or backing.
    Slow,
    /// A stop it plans: where the gear changes, or its way's end.
    Stop,
}
