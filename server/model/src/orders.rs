//! The mayors beyond the edge, as the clients are sent them, and the
//! letters they write (`sprawl::orders` writes them).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::Good;

/// Who writes: in the order they come to trust the town.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Mayor {
    Tam,
    Mira,
    Bess,
    Aldra,
}

/// Which way a town lies, beyond which edge of the map.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Compass {
    North,
    East,
    South,
    West,
}

/// A mayor as the clients are sent one: who, where, how they look, and
/// how they stand with the town.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Neighbour {
    pub mayor: Mayor,
    pub name: String,
    pub town: String,
    pub toward: Compass,
    /// The town's colour, the crest's ground.
    pub colour: String,
    pub standing: f64,
    /// Writes to the town yet.
    pub writes: bool,
}

/// A letter's packages still wanted, not yet booked, and what its mayor
/// pays a unit: what the town can send them.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Letter {
    #[ts(type = "number")]
    pub letter: u64,
    pub good: Good,
    pub partner: Mayor,
    pub price: f64,
    pub packages: u32,
}
