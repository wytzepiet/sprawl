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
pub enum BuildingType {
    CarSpawner,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Building {
    pub building_type: BuildingType,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PlaceBuilding {
    pub pos: GridCoord,
    pub building_type: BuildingType,
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
pub struct ViewportBounds {
    pub min_x: i32,
    pub min_y: i32,
    pub max_x: i32,
    pub max_y: i32,
}

impl ViewportBounds {
    pub fn contains(&self, coord: GridCoord) -> bool {
        coord.x >= self.min_x && coord.x <= self.max_x
            && coord.y >= self.min_y && coord.y <= self.max_y
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
    ResetWorld,
    SetViewport(ViewportBounds),
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "op", content = "data")]
pub enum Operation {
    Upsert(Box<GameObjectEntry>),
    Delete(#[ts(type = "number")] EntityId),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StateUpdate {
    pub ops: Vec<Operation>,
    #[ts(type = "number")]
    pub server_time: u64,
    #[ts(type = "number")]
    pub terrain_seed: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", content = "data")]
pub enum ServerMessage {
    Update(StateUpdate),
    TerrainChunk(TerrainChunk),
    UnloadChunk(ChunkCoord),
    Error(ErrorMessage),
    Pong(#[ts(type = "number")] u64),
}
