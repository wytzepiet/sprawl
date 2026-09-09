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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PlaceRoad {
    pub from: GridCoord,
    pub to: GridCoord,
    pub one_way: bool,
    /// A road rather than a street: a through route nothing fronts onto.
    #[serde(default)]
    pub road: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RoadNode {
    #[ts(type = "Array<number>")]
    pub outgoing: Vec<EntityId>,
    #[ts(type = "Array<number>")]
    pub incoming: Vec<EntityId>,
    /// Part of a network that reaches beyond the survey — road immigrants can
    /// come in by. Otherwise an island: drawn red, driven by nobody.
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
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
pub enum BuildingKind {
    House,
    Apartment,
    Shop,
    Office,
    Workshop,
    Factory,
    /// The first special kind: a place to eat out, and to be, into the
    /// evening. Placed by hand or offered by the city.
    Restaurant,
    /// Somewhere to be after dark. The first thing open when everything
    /// else has shut.
    Bar,
    /// Pumps that never close, and a kiosk that does.
    GasStation,
    /// Shopping for the whole street, with shelves that a warehouse keeps
    /// full. Placed by the mayor.
    Supermarket,
    /// Where stock comes from: trucks that answer the shops' calls. Placed
    /// by the mayor.
    Warehouse,
    /// The world beyond the survey, standing where a road runs off the map.
    /// Not placed by anyone: it appears at every road exit and moves with
    /// the frontier. See `blueprint.rs`.
    Edge,
}

impl BuildingKind {
    /// Every kind, in declaration order — the order of the blueprint table.
    pub const ALL: [BuildingKind; 12] = [
        BuildingKind::House,
        BuildingKind::Apartment,
        BuildingKind::Shop,
        BuildingKind::Office,
        BuildingKind::Workshop,
        BuildingKind::Factory,
        BuildingKind::Restaurant,
        BuildingKind::Bar,
        BuildingKind::GasStation,
        BuildingKind::Supermarket,
        BuildingKind::Warehouse,
        BuildingKind::Edge,
    ];
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Building {
    pub kind: BuildingKind,
    /// The plot's footprint in tiles, as it lies on the grid: the building
    /// and its lot together.
    pub size: (u8, u8),
    /// Which side of the building the lot and the street are on; see
    /// `blueprint::FACINGS`. The client lays the building and the lot out
    /// within the footprint from this.
    #[serde(default = "south")]
    pub facing: u8,
    /// What is on the shelves, as a fraction of a delivery. Drawn down by
    /// visits, filled by a delivery; empty shelves sell nothing. Always
    /// full for a kind that keeps no stock.
    #[serde(default = "full")]
    pub stock: f64,
}

fn full() -> f64 {
    1.0
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
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PlaceBuilding {
    /// The point on the ground the building is held over: the server
    /// decides where the plot lands from it, the same way it showed the
    /// mayor while dragging.
    pub at: [f64; 2],
    pub kind: BuildingKind,
}

/// Where a kind would land with its building held over a point: the plot's
/// origin and facing, whether it can land at all, and the driveway it would
/// get. What the dragged ghost draws, and what placing lays — one answer.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Site {
    pub pos: GridCoord,
    pub facing: u8,
    pub fits: bool,
    pub door: Option<GridCoord>,
    pub street: Option<GridCoord>,
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
    /// The tank: fuel owed at a pump, filled by the mile. The car's, though
    /// its driver decides when to stop. A save from before cars had one
    /// gets it half full.
    #[serde(default = "crate::needs::Bucket::tank")]
    pub fuel: crate::needs::Bucket,
}

/// A place to stand, and which way.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Pose {
    pub at: [f64; 2],
    pub heading: f64,
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
    /// How many edges at the end are driven backwards: a lorry backing
    /// into its dock. Drawn facing the other way, trailer first.
    #[serde(default)]
    pub reverse: usize,
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
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
pub enum TerrainType {
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DemolishRoad {
    pub pos: GridCoord,
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

    pub fn contains(&self, coord: ChunkCoord) -> bool {
        coord.cx >= self.min_cx
            && coord.cx <= self.max_cx
            && coord.cy >= self.min_cy
            && coord.cy <= self.max_cy
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", content = "data")]
pub enum ClientMessage {
    PlaceRoad(PlaceRoad),
    /// Spend a point on a node of the tree.
    Take(crate::tree::Cell),
    PlaceBuilding(PlaceBuilding),
    DemolishRoad(DemolishRoad),
    DespawnAllCars,
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

/// How the city is doing, as the two bars read it. Everything is in points,
/// one being a minute of need served by the city's buildings.
///
/// The level is the city's whole history, the offer is what it has put by
/// since the last one. Both are a snapshot at the clock the update carries,
/// climbing at `rate` — so a client runs them forward between updates and
/// the bars move as the city works, not when it clocks off.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Growth {
    pub level: u32,
    pub xp: f64,
    pub xp_needed: f64,
    /// What the mayor has to spend, in points.
    pub balance: f64,
    /// Points per millisecond of sim time, as of the update's clock.
    pub rate: f64,
    /// The build: the nodes of the tree taken.
    pub taken: Vec<crate::tree::Cell>,
    /// Tiles of road the mayor may still lay.
    pub road_tiles_left: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StateUpdate {
    pub ops: Vec<Operation>,
    pub clock: Clock,
    pub growth: Growth,
    #[ts(type = "number")]
    pub terrain_seed: u32,
    /// Extent of the surveyed world, which the client keeps its camera inside.
    pub revealed_bounds: ChunkBounds,
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


