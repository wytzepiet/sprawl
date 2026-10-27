//! The land: the islands a seed raises from the sea, and the mountains
//! eroded on them. It knows nothing of what is built there, so the world
//! (`sprawl::world`) reads it and never the other way round.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub mod mountains;
pub mod terrain;

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

/// What lies under a tile that a works can take out: iron ore and coal
/// in some mountains, oil under some grass. Only some places have each,
/// so a town that wants what its land lacks buys it (`terrain::deposits`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Hash)]
#[ts(export)]
pub enum Deposit {
    Ore,
    Coal,
    Oil,
}

impl Deposit {
    /// Wire encoding in a chunk's `deposits`: none is 0.
    pub fn to_byte(self) -> u8 {
        match self {
            Deposit::Ore => 1,
            Deposit::Coal => 2,
            Deposit::Oil => 3,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Hash)]
#[ts(export)]
pub struct ChunkCoord {
    pub cx: i32,
    pub cy: i32,
}
