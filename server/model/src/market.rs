//! The market as the clients are sent it (`sprawl::market` moves it).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::Good;

/// A "when" order: so many packages of a good, bought once the price falls
/// to this, or sold once it rises to it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct When {
    #[ts(type = "number")]
    pub id: u64,
    pub good: Good,
    pub out: bool,
    pub packages: u32,
    pub price: f64,
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
    pub orders: Vec<When>,
    /// The hour the last price is for, from the world's start.
    #[ts(type = "number")]
    pub hour: u64,
}
