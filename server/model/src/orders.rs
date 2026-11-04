//! The mayors beyond the edge, as the clients are sent them: who a
//! package comes from or goes to (`sprawl::orders`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The mayors beyond the edge.
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

/// A mayor as the clients are sent one: who, where, how they look.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Neighbour {
    pub mayor: Mayor,
    pub name: String,
    pub town: String,
    pub toward: Compass,
    /// The town's colour, the crest's ground.
    pub colour: String,
}
