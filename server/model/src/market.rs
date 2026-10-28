//! The market as the clients are sent it (`sprawl::market` moves it).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::orders::Mayor;
use crate::{GameTime, Good};

/// A good the last day: units the town made and used of it, made by its
/// works and fields, used by its counters, pumps, sites and works; and
/// packages that crossed its border, in and out, and the coins they
/// cost and fetched.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Flow {
    pub good: Good,
    pub made: f64,
    pub used: f64,
    pub imported: u32,
    pub exported: u32,
    pub spent: f64,
    pub earned: f64,
}

/// Packages of one good that crossed the border with one partner, landed
/// or sailed within the same hour: what the town paid a unit, or got.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Deal {
    #[ts(type = "number")]
    pub at: GameTime,
    pub good: Good,
    pub packages: u32,
    pub out: bool,
    pub partner: Mayor,
    pub price: f64,
}

/// A good on the market as the clients are sent it: the price, the
/// band, and the week.
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
    /// Each good the town made, used or traded the last day.
    pub flows: Vec<Flow>,
    /// The deals kept, oldest first.
    pub deals: Vec<Deal>,
    /// The hour the last price is for, from the world's start.
    #[ts(type = "number")]
    pub hour: u64,
}
