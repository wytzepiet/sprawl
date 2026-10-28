//! The market as the clients are sent it (`sprawl::market` moves it).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::Good;

/// A line on a good's stock: the town buys up to it and sells what is
/// over it, as far as its offices' desks go (docs/core.md §Trade).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Line {
    pub good: Good,
    /// Units kept.
    pub keep: f64,
}

/// What the town made of a good and used of it, the last day: made by its
/// works and fields, used by its counters, pumps, sites and works.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Flow {
    pub good: Good,
    pub made: f64,
    pub used: f64,
}

/// A good on the market as the clients are sent it: the price, the
/// band, what the town pays and gets at its harbour, and the week.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Quote {
    pub good: Good,
    pub price: f64,
    pub floor: f64,
    pub ceiling: f64,
    /// How far a package moves the price, a unit's: each is paid at the
    /// price it moved to.
    pub step: f64,
    /// The price each hour kept, oldest first; the last is the hour just
    /// gone.
    pub history: Vec<f64>,
}

/// The market's part of what the clients are sent, when it changes.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Prices {
    pub goods: Vec<Quote>,
    pub lines: Vec<Line>,
    /// Packages a day the town's offices could trade for the lines, as
    /// they are staffed, and whether the lines wanted more in the hour
    /// just gone than the desks had.
    pub desks: f64,
    pub full: bool,
    /// Each good the town made or used the last day.
    pub flows: Vec<Flow>,
    /// The hour the last price is for, from the world's start.
    #[ts(type = "number")]
    pub hour: u64,
}
