use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub type EntityId = u64;
pub type EdgeKey = (EntityId, EntityId);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Hash)]
#[ts(export)]
pub struct GridCoord {
    pub x: i32,
    pub y: i32,
}

/// A step of the mayor's hand: one tile to the next, or a tap, from and
/// to the same tile. A drag is its steps, each built as it is sent.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Build {
    pub tool: Tool,
    pub from: GridCoord,
    pub to: GridCoord,
}

/// What the mayor's hand holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Tool {
    /// A street, both ways: what buildings front.
    Street,
    /// A street one way, `from` to `to`.
    OneWay,
    /// A road: a through route nothing fronts onto.
    Road,
    /// A kind of building: `to` painted, and joined to whatever of the
    /// kind `from` is part of.
    Building(BuildingKind),
    /// Whatever stands on `to`.
    Demolish,
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
    /// A road rather than a street. Buildings front streets only: no driveway
    /// is ever laid onto a road, and nothing arrives beside one.
    #[serde(default)]
    pub road: bool,
    /// Laid by the mayor, so it counts against the build's road tiles. The
    /// survey's own roads, and driveways, are free.
    #[serde(default)]
    pub laid: bool,
}

/// What stands on a plot. The kind follows from the footprint the layout chose,
/// so a wide plot becomes an Apartment where a single tile becomes a House.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, PartialOrd, Ord)]
#[ts(export)]
pub enum BuildingKind {
    House,
    Apartment,
    Shop,
    Office,
    Factory,
    /// Pumps that never close, and a kiosk that does.
    GasStation,
    /// Shopping for the whole street, with shelves that a warehouse keeps
    /// full. Placed by the mayor.
    Supermarket,
    /// Where the town's goods are kept: a little of every class, a lorry
    /// that fetches boxes from the harbour and vans that deliver to shops
    /// and sites. Placed by the mayor.
    Depot,
    /// Where food comes from: hands that fill a yard with crates, and a
    /// tractor on its land. A depot's lorry fetches them. Placed by the
    /// mayor.
    Farm,
    /// The door: a ramp on the coast and a trailer park, where the world's
    /// ferry lands settlers and boxes and takes boxes away
    /// (`world/sea.rs`). Placed by the mayor, with its back to the sea.
    Harbour,
    /// Where timber comes from: hands felling the forest round it and
    /// sawing it, the planks stacked in its yard for a depot's lorry.
    /// Placed by the mayor, beside the woods.
    Sawmill,
}

impl BuildingKind {
    /// Every kind, in declaration order — the order of the blueprint table.
    pub const ALL: [BuildingKind; 11] = [
        BuildingKind::House,
        BuildingKind::Apartment,
        BuildingKind::Shop,
        BuildingKind::Office,
        BuildingKind::Factory,
        BuildingKind::GasStation,
        BuildingKind::Supermarket,
        BuildingKind::Depot,
        BuildingKind::Farm,
        BuildingKind::Harbour,
        BuildingKind::Sawmill,
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
    /// A save's plot from before a building was its tiles, read once at
    /// load into `tiles` (`World::rebuild_occupied`) and never written.
    #[serde(default, skip_serializing)]
    #[ts(skip)]
    pub size: Option<(u8, u8)>,
    /// Which side of the building the lot and the street are on; see
    /// `blueprint::FACINGS`. The client lays the building and the lot out
    /// within the footprint from this.
    #[serde(default = "south")]
    pub facing: u8,
    /// Its stocks, by good: the shelf of what it serves or keeps — meals,
    /// tanks, a farm's crates — drawn down by visits and loads and filled
    /// by a delivery or its own land. Empty shelves serve nothing. A save
    /// from before a stock existed gets it issued at load
    /// (`economy::open`).
    #[serde(default)]
    pub stocks: std::collections::BTreeMap<Good, crate::needs::Stock>,
    /// Still going up: the timber delivered toward it, of what its row
    /// takes (`blueprint::Blueprint::timber`). A site has no door for
    /// anyone but the van bringing its timber; full, it stands.
    #[serde(default)]
    pub site: Option<crate::needs::Stock>,
    /// A harbour's trailer park: its docks, each where a box stands and
    /// the box standing there, if any (`world/sea.rs`). The poses are its
    /// lot's, laid when the lot is.
    #[serde(default)]
    pub park: Vec<Slot>,
    /// A depot's top-up rules, by good (docs/trade.md §Top-up).
    #[serde(default)]
    pub rules: std::collections::BTreeMap<Good, Rule>,
    /// A depot's lorry has standing orders: it fetches what lands for the
    /// depot at the harbour and takes out what the rules sell, without
    /// being sent. Off, it goes when the mayor taps it.
    #[serde(default)]
    pub standing: bool,
    /// Boxes the mayor has sold from a depot and its lorry has yet to take
    /// to the harbour, a good a box.
    #[serde(default)]
    pub selling: Vec<Good>,
    /// A farm's land: the grass it claimed when a street reached it, each
    /// tile at a stage of the cycle the tractor drives it through
    /// (`world/fields.rs`). A tile built over is dropped.
    #[serde(default)]
    pub land: Vec<Tile>,
    /// Where the tractor last drove: one run's path, which the client
    /// draws the field along, corners and all. Every run works the same
    /// ground, so the last run's path is the field. Redrawn by the next.
    #[serde(default)]
    pub ruts: Vec<GridCoord>,
    /// The tiles beside it, of other buildings of its kind, the hand drew
    /// it on from or onto: a row of houses drawn as a row, each a home of
    /// its own. Only a kind that never grows into one building keeps any.
    #[serde(default)]
    pub joined: Vec<GridCoord>,
    /// Where it is driven into: one of its tiles, and the street tile
    /// beside it the drive runs from. The drive is the building's, not a
    /// road: drawn as one, driven by the cars of its lot, and gone with it.
    /// Kept when the street goes, and good again if it comes back.
    #[serde(default)]
    pub door: Option<Door>,
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

/// What a vehicle does to a tile as it drives over it: a tractor's job
/// on the land, or a ship's sailing over the water, which does nothing
/// to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Job {
    Plough,
    Seed,
    Harvest,
    Sail,
}

/// A run off the roads: a tractor's over the land, a ship's over the
/// water. The tiles it drives in order, doing its job to each as it
/// arrives, standing on the first at `started` and reaching one more
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
    /// One of a kind, founded: what it buys in full, what it makes not
    /// yet made.
    /// One of a kind, placed: a site waiting for its timber, or standing
    /// at once where its row takes none (`economy::stand`).
    pub fn new(kind: BuildingKind, tiles: Vec<GridCoord>, facing: u8) -> Building {
        let timber = crate::blueprint::blueprint(kind).timber as f64;
        Building {
            kind,
            tiles,
            size: None,
            facing,
            stocks: Default::default(),
            site: (timber > 0.0).then_some(crate::needs::Stock { level: 0.0, cap: timber }),
            park: Vec::new(),
            rules: Default::default(),
            standing: false,
            selling: Vec::new(),
            land: Vec::new(),
            ruts: Vec::new(),
            joined: Vec::new(),
            door: None,
        }
    }
}

fn south() -> u8 {
    2
}

/// What a car is for, which is who drives it and what it looks like.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum CarRole {
    /// A resident's own, driven by them.
    #[default]
    Private,
    /// An articulated lorry: a depot's, fetching from beyond the edge, or
    /// from beyond the edge itself where the city has no depot.
    Truck,
    /// A depot's van, on the last mile to a shop.
    Van,
    /// A farm's: out along the track to a ripe field and home with the
    /// crop, driven by a hand on shift. On the road it is a slow car.
    Tractor,
    /// The world's ferry: in over the horizon to a harbour's ramp on the
    /// timetable, settlers and boxes on its deck, and away again. Never on
    /// a road.
    Ferry,
    /// A harbour's tugmaster: shunts boxes between the ferry's deck and the
    /// trailer park. Never on a road.
    Tug,
}

/// Someone's car. It outlives its journeys: between trips it sits parked at a
/// building, doing nothing and costing nothing, and everything about the
/// journey it is currently on lives in `trip`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Car {
    /// Who it belongs to: the resident driving it, whose `at` points back
    /// at this car while they are aboard; or the facility it works for; or,
    /// come from beyond the edge, the building that called it.
    #[ts(type = "number")]
    pub owner: EntityId,
    pub trip: Option<Trip>,
    #[serde(default)]
    pub role: CarRole,
    /// Beyond the edge of the map until this time; zero when on it.
    #[serde(skip)]
    #[ts(skip)]
    pub away: u64,
    /// Where it stands while parked, if the lot had room: the spot's centre
    /// and the way its nose points, in radians. `None` is parked out of
    /// sight.
    #[serde(default)]
    pub spot: Option<Pose>,
    /// The tank and the wear: used by the tile, filled at a pump and put
    /// right at a workshop. The car's, though its driver decides when to
    /// stop. A save from before cars had them gets them full.
    #[serde(default = "crate::needs::Bucket::driven")]
    pub stocks: std::collections::BTreeMap<crate::needs::Need, crate::needs::Stock>,
    /// A tractor's run over its farm's land, or a ship's voyage, while
    /// it is on one.
    #[serde(default)]
    pub run: Option<Run>,
    /// The box on its hitch: a lorry's, or a tug's.
    #[serde(default)]
    pub hitched: Option<Trailer>,
    /// A ferry's deck, by slot (`world/sea.rs` DECK): boxes, and the cars
    /// of settlers riding over, by id.
    #[serde(default)]
    pub deck: Vec<Option<Trailer>>,
    #[serde(default)]
    #[ts(type = "Array<number>")]
    pub passengers: Vec<EntityId>,
    /// A tug's move between two poses, while it makes one.
    #[serde(default)]
    pub shunt: Option<Shunt>,
    /// A ferry's boxes booked beyond the sea, waiting for a sailing with
    /// room on its deck.
    #[serde(default)]
    pub booked: Vec<Trailer>,
    /// A ferry's next moment on the timetable: when it berths, while it is
    /// away or at sea; when it casts off, while it is at the ramp.
    #[serde(default)]
    #[ts(type = "number")]
    pub due: u64,
}

impl Car {
    /// A car as it arrives: parked out of sight, going nowhere, full.
    pub fn new(owner: EntityId, role: CarRole) -> Car {
        Car { owner, trip: None, role, spot: None, away: 0, stocks: crate::needs::Bucket::driven(), run: None, hitched: None, deck: Vec::new(), passengers: Vec::new(), shunt: None, booked: Vec::new(), due: 0 }
    }
}

/// A place to stand, and which way.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Pose {
    pub at: [f64; 2],
    pub heading: f64,
}

/// A good: what a shelf, a yard or a box holds, and what the world
/// prices. A resident's need draws one off a counter's shelf (`Need::good`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Good {
    /// Food, boxed: what a shop serves meals from.
    Crates,
    /// What a pump fills a tank from. Liquid: it rides in a tank box.
    Fuel,
    /// What buildings are built from, the first material.
    Timber,
}

impl Good {
    /// Units one box holds: a trailer of crates is a hundred, of timber
    /// twenty, a tank box fifty tanks.
    pub fn per_box(self) -> f64 {
        match self {
            Good::Crates => 100.0,
            Good::Fuel => 50.0,
            Good::Timber => 20.0,
        }
    }
}

/// A box: a trailer off the ferry, the world's, which the town's lorries
/// haul. Never an entity: a value that stands in one place at a time, on
/// a ferry's deck, in a yard's slot, on a hitch, or booked beyond the sea
/// (`World::booked`). docs/shipping.md §Boxes and lorries.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Trailer {
    /// Its number, for following it wherever it is.
    #[ts(type = "number")]
    pub id: u64,
    /// What is in it; None, or no units, is an empty.
    pub good: Option<Good>,
    pub units: f64,
    /// The depot it is bound for; None is the town's, for whichever depot's
    /// lorry comes first, or the world's, going back.
    #[ts(type = "number | null")]
    pub to: Option<EntityId>,
    /// Going out: dropped at a harbour for the ferry, an export or an empty.
    pub outbound: bool,
    /// The shipment it is part of: an order, a top-up, the starter pack.
    #[ts(type = "number | null")]
    pub order: Option<u64>,
}

impl Trailer {
    pub fn empty(&self) -> bool {
        self.good.is_none() || self.units <= 0.0
    }
}

/// A dock of a harbour's trailer park: where a box stands in it, a
/// lorry's tail to the quay, and the box, if one is there.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Slot {
    pub pose: Pose,
    pub trailer: Option<Trailer>,
}

/// A depot's top-up rule for one good: keep above `keep`, fill up to
/// `fill`, from the world on the next ferry; and sell what is over `sell`,
/// a box at a time, when there is one.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Rule {
    pub keep: f64,
    pub fill: f64,
    pub sell: Option<f64>,
}

/// A tug's move: along a path between two moments, a box on its hitch or
/// not, forwards or backing (a box pushed up the ramp onto the deck leads
/// the tug).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Shunt {
    /// The way it goes, through these points in order; the box, if on the
    /// hitch, trails the tug, or leads it backing.
    pub path: Vec<[f64; 2]>,
    #[ts(type = "number")]
    pub started: u64,
    #[ts(type = "number")]
    pub ends: u64,
    /// The point from which it is backing, to the end: none past the last.
    pub backs_from: usize,
    /// What it does at the end: hitch the box there, or drop its own.
    pub to: Place,
}

/// Where a tug's move ends: a slot of the ferry's deck, a dock of the
/// park, or its place by the ramp.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Place {
    Deck(usize),
    Park(usize),
    Rest,
}

/// Where a box is on its way, as the shipments list reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Leg {
    /// Ordered, waiting beyond the sea for its sailing.
    Booked,
    /// On a ferry's deck, at sea or at the berth.
    Aboard,
    /// In a harbour's trailer park.
    Parked,
    /// On a lorry's hitch, or a tug's.
    Hauled,
    /// In a depot's yard, waiting to be unloaded.
    Yard,
}

/// A box with an order, where it is: the shipments list and its pins.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Shipment {
    #[ts(type = "number")]
    pub order: u64,
    #[ts(type = "number")]
    pub trailer: u64,
    pub good: Option<Good>,
    pub units: f64,
    #[ts(type = "number | null")]
    pub to: Option<EntityId>,
    pub outbound: bool,
    pub leg: Leg,
    /// What it is on or in: the ferry, the lorry, the harbour, the depot.
    #[ts(type = "number | null")]
    pub carrier: Option<EntityId>,
    /// Where that is on the map, to the tile, when it is on it.
    pub at: Option<GridCoord>,
    /// When it lands where it is going next: the ferry's berthing for a
    /// box booked or at sea.
    #[ts(type = "number | null")]
    pub eta: Option<u64>,
}

/// A harbour's ferry, as its timetable reads.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Sailing {
    #[ts(type = "number")]
    pub harbour: EntityId,
    #[ts(type = "number")]
    pub ferry: EntityId,
    /// When it next berths, or berthed; and when it casts off.
    #[ts(type = "number")]
    pub arrives: u64,
    #[ts(type = "number")]
    pub departs: u64,
    /// At the ramp now.
    pub berthed: bool,
    /// Boxes and settlers aboard, and how many the deck holds.
    pub boxes: u32,
    pub settlers: u32,
    pub deck: u32,
    /// Boxes booked beyond the sea for this harbour.
    pub booked: u32,
    /// Households moved in and waiting beyond the sea for a sailing.
    pub waiting: u32,
}

/// The sea's part of an update: every shipment on its way and every
/// harbour's timetable. Small, and summarised afresh each update.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Sea {
    pub shipments: Vec<Shipment>,
    pub sailings: Vec<Sailing>,
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
    /// Cumulative distance along the route.
    pub progress: f64,
    pub speed: f64,
    pub acceleration: f64,
    /// Total arc length of the entire route.
    pub total_route_length: f64,
    #[ts(type = "number")]
    pub updated_at: u64,
    /// Current segment (1-based). The car is between route[ri-1] and route[ri].
    pub route_index: usize,
    /// Fraction (0–1) of the current segment the car has traveled.
    pub seg_fraction: f64,
    /// Arc length of the current segment (for extrapolation).
    pub seg_length: f64,
    /// Cumulative distance to start of current segment.
    #[serde(skip)]
    #[ts(skip)]
    pub seg_start_dist: f64,
    /// Precomputed arc length of each segment. segment_lengths[i] = length from
    /// route[i-1] to route[i]. Index 0 is unused (always 0.0).
    #[serde(skip)]
    #[ts(skip)]
    pub segment_lengths: Vec<f64>,
    /// The street nodes either side of the stretch a kerb bay is turned
    /// across, at the trip's start and its end: the street waits at both
    /// while the car turns (`car::simulation`).
    #[serde(skip)]
    #[ts(skip)]
    pub stretches: [Vec<EntityId>; 2],
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
pub enum TerrainType {
    /// The sea: water on the ocean's side of the step in `terrain.rs`, where
    /// a ship can sail. Water is a lake.
    Sea,
    Water,
    Beach,
    Grass,
    Forest,
    Mountain,
}

/// Tiles per chunk edge. Shared by terrain transport and client meshing.
pub const CHUNK_SIZE: i32 = 32;
/// Extra tiles sent around a chunk so the client can derive corner shapes.
pub const CHUNK_SKIRT: i32 = 2;
/// Edge length of a chunk payload, in tiles.
pub const CHUNK_STRIDE: i32 = CHUNK_SIZE + CHUNK_SKIRT * 2;

/// Marks a tile outside the generated world in a chunk payload.
pub const TILE_ABSENT: u8 = 255;

impl TerrainType {
    /// Wire encoding. The client decodes by the same order, so this must not
    /// be reordered without updating it there.
    pub fn to_byte(self) -> u8 {
        match self {
            TerrainType::Water => 0,
            TerrainType::Beach => 1,
            TerrainType::Grass => 2,
            TerrainType::Forest => 3,
            TerrainType::Mountain => 4,
            TerrainType::Sea => 5,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Hash)]
#[ts(export)]
pub struct ChunkCoord {
    pub cx: i32,
    pub cy: i32,
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
}

/// Someone who lives in the city, and the two buildings their day runs between.
///
/// Deliberately position-less: a resident is not a thing on the map but the
/// reason a car exists. `flush_dirty` only streams entities that have a
/// position, so residents persist and stay entirely server-side for free.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Resident {
    #[ts(type = "number")]
    pub home: EntityId,
    /// `None` while nowhere within reach has a job going.
    #[ts(type = "number | null")]
    pub work: Option<EntityId>,
    /// Where they are: a building, or the car they are riding in. `None` is
    /// off-map — someone who exists but has not driven in yet.
    #[ts(type = "number | null")]
    pub at: Option<EntityId>,
    /// The car they own. Settled alongside homes and jobs; defaults so saves
    /// from before cars were owned settle themselves a car on load.
    #[serde(default)]
    #[ts(type = "number")]
    pub car: EntityId,
    /// What they owe each need. Issued fresh to anyone saved before needs
    /// existed.
    #[serde(default = "crate::needs::Bucket::fresh")]
    pub buckets: Vec<crate::needs::Bucket>,
    /// The need being served where they stand, if any. A record of what is
    /// happening, like `at` — not a plan.
    #[serde(default)]
    pub selected: Option<crate::needs::Need>,
    /// When the buckets were last brought up to date.
    #[serde(default)]
    #[ts(type = "number")]
    pub last_update: u64,
    /// Units of the selected need served since this visit began: drawn
    /// off the shelf it was served from when the visit ends. A record of
    /// what is happening, like `at`.
    #[serde(default)]
    pub tab: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "kind", content = "data")]
pub enum GameObject {
    RoadNode(RoadNode),
    Building(Building),
    Car(Car),
    Resident(Resident),
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ErrorMessage {
    pub message: String,
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
    Build(Build),
    /// Spend a point on a node of the tree.
    Take(crate::tree::Cell),
    DespawnAllCars,
    /// Buy boxes of a good from the world, for a depot, on the next ferry.
    Order { #[ts(type = "number")] depot: EntityId, good: Good, boxes: u32 },
    /// Set a depot's top-up rule for a good, or clear it.
    SetRule { #[ts(type = "number")] depot: EntityId, good: Good, rule: Option<Rule> },
    /// Give a depot's lorry standing orders, or take them away.
    Standing { #[ts(type = "number")] depot: EntityId, on: bool },
    /// Send a depot's lorry to the harbour now: the tap.
    Send { #[ts(type = "number")] depot: EntityId },
    /// Sell a box of a good from a depot to the world: the lorry takes it
    /// to the harbour for the next ferry.
    Sell { #[ts(type = "number")] depot: EntityId, good: Good },
    /// Sim steps per tick. 0 pauses; dev-only, and it moves the whole world.
    SetSpeed(u32),
    ResetWorld,
    SetChunks(ChunkBounds),
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "op", content = "data")]
pub enum Operation {
    Upsert(Box<GameObjectEntry>),
    Delete(#[ts(type = "number")] EntityId),
}

/// Simulated time of one full day/night cycle.
///
/// This is the scale of the whole game rather than a cosmetic setting. A tile
/// is about 12 m — a car is 0.35 tiles long and a car is 4.2 m, and a one-tile
/// road is a 12 m two-way street — so CRUISE_SPEED works out at 65 km/h and a
/// chunk is 384 m across. Against a twenty-minute day an hour is 900 m of
/// driving, putting a town commute at half an hour and a crossing of a
/// sprawling city at four, which is what earns a highway. At two minutes, the
/// length this was, that same crossing took two days.
pub const DAY_MS: u32 = 1_200_000;

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

/// How the city is doing, as the two dials read it.
///
/// The level is the town's GDP to date.
/// The treasury is the mayor's coins, stepped as goods cross the border.
/// Neither is extrapolated: a dial that steps is the event landing.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Growth {
    pub level: u32,
    /// GDP since the level was reached, and what the next takes.
    pub toward: f64,
    pub needed: f64,
    /// GDP added in town today so far.
    pub gdp: f64,
    /// What the town has to spend, in coins: earned at the border, net of
    /// what it bought and built.
    pub treasury: f64,
    /// Today's net at the border so far, and what went out: the treasury
    /// over it is days of imports left.
    pub income: f64,
    pub imports: f64,
    /// The build: the nodes of the tree taken.
    pub taken: Vec<crate::tree::Cell>,
    /// Tiles of road the mayor may still lay.
    pub road_tiles_left: u32,
}

/// Something landing on a building: coins as goods cross the border, a
/// load sold to the world or a delivery bought from it, negative leaving;
/// or GDP as value is added there, a meal served, a crop cut, a shift
/// worked at a desk. docs/trade.md.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Lump {
    #[ts(type = "number")]
    pub building: EntityId,
    pub coins: f64,
    pub gdp: f64,
    #[ts(type = "number")]
    pub at: u64,
    /// Or goods landing: a box unloaded onto a depot's shelf.
    #[serde(default)]
    pub good: Option<Good>,
    #[serde(default)]
    pub units: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StateUpdate {
    pub ops: Vec<Operation>,
    /// Lumps that landed on buildings in view since the last update.
    #[serde(default)]
    pub lumps: Vec<Lump>,
    pub clock: Clock,
    pub growth: Growth,
    /// Every shipment on its way and every harbour's timetable.
    #[serde(default)]
    pub sea: Sea,
    #[ts(type = "number")]
    pub terrain_seed: u32,
    /// The island's map, which the client keeps its camera inside.
    pub island: ChunkBounds,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", content = "data")]
pub enum ServerMessage {
    /// Who you are. Drafts carry an owner, and the client needs this to tell
    /// its own pending work from everyone else's.
    Welcome(#[ts(type = "number")] OwnerId),
    Update(StateUpdate),
    TerrainChunk(TerrainChunk),
    UnloadChunk(ChunkCoord),
    Error(ErrorMessage),
    Pong(#[ts(type = "number")] u64),
}


