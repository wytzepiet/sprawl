//! The player's build: the one door every question about what the city
//! may do goes through. What may be placed, which roads drawn, how much
//! road, how much cheaper a class is.
//!
//! Switched off (`game.md` §The build): the old skill tree is gone, and
//! until the one that replaces it is designed from the roster, everything
//! is open. The level still counts; it is GDP to date, and nothing here
//! reads it.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::blueprint::Class;
use crate::protocol::BuildingKind;

/// A node of a tree, as the old saves and the protocol name one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Cell {
    pub x: u8,
    pub y: u8,
}

/// The player's build: nothing taken, everything allowed.
#[derive(Debug, Clone, Default)]
pub struct Build;

impl Build {
    pub fn load(_taken: impl IntoIterator<Item = Cell>) -> Self {
        Build
    }

    pub fn all() -> Self {
        Build
    }

    /// The nodes taken: what a save writes down.
    pub fn taken(&self) -> Vec<Cell> {
        Vec::new()
    }

    /// Take a node: there are none to take.
    pub fn take(&mut self, _c: Cell, _level: u32) -> bool {
        false
    }

    pub fn may_place(&self, _kind: BuildingKind) -> bool {
        true
    }

    /// How much cheaper this class is than the table says.
    pub fn weight(&self, _class: Class) -> f64 {
        1.0
    }

    /// Tiles of road the mayor may have laid, all told.
    pub fn road_tiles(&self) -> u32 {
        u32::MAX
    }

    /// May this kind of road be drawn?
    pub fn may_draw(&self, _one_way: bool, _road: bool) -> bool {
        true
    }
}
