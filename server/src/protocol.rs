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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
pub enum Category {
    Residential,
    Commercial,
    Industrial,
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
    pub fn category(self) -> Category {
        match self {
            BuildingKind::House | BuildingKind::Apartment => Category::Residential,
            BuildingKind::Shop | BuildingKind::Office => Category::Commercial,
            BuildingKind::Workshop | BuildingKind::Factory => Category::Industrial,
        }
    }

    /// The kind a plot of this size gets, per category.
    pub fn for_plot(category: Category, tiles: u32) -> BuildingKind {
        match (category, tiles > 1) {
            (Category::Residential, false) => BuildingKind::House,
            (Category::Residential, true) => BuildingKind::Apartment,
            (Category::Commercial, false) => BuildingKind::Shop,
            (Category::Commercial, true) => BuildingKind::Office,
            (Category::Industrial, false) => BuildingKind::Workshop,
            (Category::Industrial, true) => BuildingKind::Factory,
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

/// A stroke of the build brush. The tiles are a wish, not an instruction: the
/// server lays out whatever plots actually fit and ignores the rest.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PaintArea {
    pub tiles: Vec<GridCoord>,
    pub category: Category,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Car {
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "kind", content = "data")]
pub enum GameObject {
    RoadNode(RoadNode),
    Building(Building),
    Car(Car),
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
    PaintArea(PaintArea),
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
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "op", content = "data")]
pub enum Operation {
    Upsert(Box<GameObjectEntry>),
    Delete(#[ts(type = "number")] EntityId),
}

/// Simulated time of one full day/night cycle.
pub const DAY_MS: u32 = 120_000;

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
