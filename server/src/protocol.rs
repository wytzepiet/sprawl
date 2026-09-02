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
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RoadNode {
    #[ts(type = "Array<number>")]
    pub outgoing: Vec<EntityId>,
    #[ts(type = "Array<number>")]
    pub incoming: Vec<EntityId>,
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
}

impl BuildingKind {
    /// How many people live here. Zero for everything you cannot live in, so
    /// "is this housing" never needs asking separately.
    pub fn homes(self) -> u32 {
        match self {
            BuildingKind::House => 2,
            BuildingKind::Apartment => 8,
            _ => 0,
        }
    }

    /// How many people work here.
    pub fn jobs(self) -> u32 {
        match self {
            BuildingKind::Shop => 4,
            BuildingKind::Office => 16,
            BuildingKind::Workshop => 6,
            BuildingKind::Factory => 24,
            _ => 0,
        }
    }
}

/// Which way a building faces. Appearance only — the entrance is wherever the
/// driveway runs in, which is a road node standing on one of the plot's tiles.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
pub enum Rotation {
    North,
    East,
    South,
    West,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Building {
    pub kind: BuildingKind,
    /// Footprint in tiles, as it lies on the grid. Rotation does not turn it:
    /// a plot that was validated one shape cannot become another.
    pub size: (u8, u8),
    pub rotation: Rotation,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PlaceBuilding {
    pub pos: GridCoord,
    pub kind: BuildingKind,
}

/// Someone's car. It outlives its journeys: between trips it sits parked at a
/// building, doing nothing and costing nothing, and everything about the
/// journey it is currently on lives in `trip`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Car {
    /// The resident it belongs to, who is also who is driving it. Their `at`
    /// points back at this car while they are aboard.
    #[ts(type = "number")]
    pub owner: EntityId,
    pub trip: Option<Trip>,
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

/// A building the city would like to put here, waiting for the mayor's
/// answer. An entity — persisted and streamed like any other, with its
/// position — but not a building: it occupies nothing, traffic and settle
/// never see it, and accepting it is what makes the building.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Proposal {
    pub kind: BuildingKind,
    pub size: (u8, u8),
    pub rotation: Rotation,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "kind", content = "data")]
pub enum GameObject {
    RoadNode(RoadNode),
    Building(Building),
    Car(Car),
    Resident(Resident),
    Proposal(Proposal),
}

/// Who a player is, for the purpose of owning drafts. Assigned on connect.
pub type OwnerId = u64;

/// An uncommitted change, and whose it is.
///
/// A draft is an ordinary world object that reserves its space and is visible
/// to everyone, but is invisible to traffic and to persistence. Two questions
/// get different answers: the planner and the renderer see the world as it will
/// be after commit, while traffic sees it as it is now. So an `Added` road
/// carries no cars but does block a plot, and a `Removed` road still carries
/// cars but will not be given a new driveway.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
#[serde(tag = "state", content = "owner")]
pub enum Draft {
    Added(#[ts(type = "number")] OwnerId),
    Removed(#[ts(type = "number")] OwnerId),
}

impl Draft {
    pub fn owner(self) -> OwnerId {
        match self {
            Draft::Added(o) | Draft::Removed(o) => o,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GameObjectEntry {
    #[ts(type = "number")]
    pub id: EntityId,
    pub object: GameObject,
    pub position: Option<GridCoord>,
    /// `None` once committed, which is what the simulation and the save file
    /// both key off.
    #[serde(default)]
    pub draft: Option<Draft>,
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
    PlaceBuilding(PlaceBuilding),
    DemolishRoad(DemolishRoad),
    DespawnAllCars,
    /// Make everything you have drafted real.
    Commit,
    /// Throw away everything you have drafted. Nothing committed was ever
    /// touched, so this destroys nothing and restores nothing.
    Discard,
    /// Sim steps per tick. 0 pauses; dev-only, and it moves the whole world.
    SetSpeed(u32),
    ResetWorld,
    SetChunks(ChunkBounds),
    Ping,
    /// The mayor's answer to a proposal: build it, or not.
    Answer {
        #[ts(type = "number")]
        id: EntityId,
        accept: bool,
    },
    /// Drag a proposal's pin somewhere else before answering.
    MoveProposal {
        #[ts(type = "number")]
        id: EntityId,
        pos: GridCoord,
    },
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StateUpdate {
    pub ops: Vec<Operation>,
    pub clock: Clock,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The client keys its rendering off this field, so it has to survive the
    /// wire. Adjacently-tagged enums inside an Option are the kind of thing a
    /// binary format can quietly drop.
    #[test]
    fn a_draft_survives_the_wire() {
        let entry = GameObjectEntry {
            id: 7,
            object: GameObject::RoadNode(RoadNode { outgoing: vec![], incoming: vec![] }),
            position: Some(GridCoord { x: 1, y: 2 }),
            draft: Some(Draft::Added(99)),
        };
        let bytes = rmp_serde::to_vec_named(&entry).unwrap();
        let back: GameObjectEntry = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(back.draft, Some(Draft::Added(99)));
    }
}
