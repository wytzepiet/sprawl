//! A mission as the town keeps and the clients are sent one: what it asks,
//! step by step, and what it pays (`sprawl::missions` opens and checks them).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{BuildingKind, EntityId, Good, GameTime};

/// Which mission this is: each opens once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Key {
    Opening,
    Book,
    Sell,
    Pump,
    Quarry,
    Sawmill,
    Farm,
    /// An order from a town beyond the edge, by its number: the number
    /// its boxes carry as their shipment's.
    Order(#[ts(type = "number")] u64),
}

/// What a step asks of the town: a fact read off the world.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "kind", content = "data")]
pub enum Goal {
    /// A building of this kind stands, built and reached by a street.
    Stands(BuildingKind),
    /// A depot's street joined to the harbour's.
    Joined,
    /// Something on a depot's shelf: a box fetched and unloaded.
    Fetched,
    /// Settlers in town: someone has driven off the ferry.
    Settled,
    /// A box booked to come in on the deck.
    Booked,
    /// Something sold over the sea.
    Sold,
    /// So many units of a good sailed for an order's town: counted by the
    /// ferry as it casts off (`orders::sailed`).
    Delivered { good: Good, units: f64, sailed: f64 },
}

/// What finishing a mission pays. Coins for now; XP once the level means
/// something.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "kind", content = "data")]
pub enum Reward {
    Coins(f64),
    /// An order's: its coins paid a box at a time as each sails, and
    /// standing with its mayor once the last has.
    Order { coins: f64, standing: f64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Step {
    pub goal: Goal,
    /// What it asks, in a line.
    pub title: String,
    /// How, paragraphs apart by a blank line.
    pub text: String,
    pub done: bool,
    /// The building the step's button acts on: the depot, for a depot's
    /// goal.
    #[ts(type = "number | null")]
    pub at: Option<EntityId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Mission {
    pub key: Key,
    pub title: String,
    pub steps: Vec<Step>,
    pub reward: Reward,
    #[ts(type = "number")]
    pub opened: GameTime,
    /// Finished, its steps done; or, for an order, given up on with a
    /// step not done.
    #[ts(type = "number | null")]
    pub finished: Option<GameTime>,
    /// Who asked, for an order.
    #[serde(default)]
    pub from: Option<crate::orders::Mayor>,
    /// When an order lapses.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub due: Option<GameTime>,
}
