//! The card of one thing, as the client shows it (`sprawl::card` draws one up).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use std::collections::BTreeMap;

use crate::needs::Need;
use crate::{BuildingKind, CarRole, EntityId, Good};

/// The card of one thing, by what it is.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Card {
    Resident(ResidentCard),
    Car(CarCard),
    Building(BuildingCard),
    Gone {
        #[ts(type = "number")]
        id: EntityId,
    },
}

/// A line that points at something: its id, what to call it, and what it is.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Link {
    #[ts(type = "number")]
    pub id: EntityId,
    pub label: String,
    pub kind: LinkKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    Resident,
    Building,
    Car,
    Gone,
}

/// How full a tank or a shelf is, 0 to 1, and of what.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Gauge {
    pub what: String,
    pub full: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ResidentCard {
    #[ts(type = "number")]
    pub id: EntityId,
    pub name: String,
    pub home: Link,
    pub work: Option<Link>,
    pub at: Option<Link>,
    pub car: Link,
    pub selected: Option<Need>,
    /// When they last thought.
    pub since: String,
    /// The tank is the car's; its card shows it.
    pub needs: Vec<NeedLine>,
}

/// One need: how full it is, and where it would be met now
/// (`resident::needs`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct NeedLine {
    pub need: Need,
    pub full: f64,
    #[ts(type = "number | null")]
    pub option: Option<EntityId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CarCard {
    #[ts(type = "number")]
    pub id: EntityId,
    pub role: CarRole,
    pub owner: Link,
    pub rider: Option<Link>,
    pub stocks: Vec<Gauge>,
    pub trip: Option<TripLine>,
    pub parked_at: Option<Link>,
    pub answering: Vec<CallLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TripLine {
    pub to: Link,
    pub due: String,
    /// Against empty roads: what traffic has cost so far.
    #[ts(type = "number")]
    pub late_s: u64,
}

/// A call: what for, from where, since when, and the vehicle answering.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CallLine {
    pub what: String,
    pub good: Good,
    pub at: Link,
    pub since: String,
    pub answered_by: Option<Link>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BuildingCard {
    #[ts(type = "number")]
    pub id: EntityId,
    pub building_kind: BuildingKind,
    pub reached: bool,
    pub stocks: Vec<Gauge>,
    /// A site's: where its materials are.
    pub depots: Vec<DepotLine>,
    pub makers: Vec<MakerLine>,
    pub here: Vec<Present>,
    pub household: Vec<Link>,
    pub staff: Vec<Staff>,
    pub fleet: Vec<Link>,
    pub calls: Vec<CallLine>,
    pub served: Vec<Served>,
}

/// A depot, as a site's card lists it: what it has, and whether its
/// street is joined to the harbour.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DepotLine {
    pub depot: Link,
    pub joined: bool,
    pub stocks: BTreeMap<Good, f64>,
}

/// A maker of one of a site's materials, and what is in its yard.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MakerLine {
    pub maker: Link,
    pub kind: BuildingKind,
    pub good: Good,
    pub level: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Present {
    pub who: Link,
    pub doing: Option<Need>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Staff {
    pub who: Link,
    pub present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Served {
    pub need: Need,
    pub hours_today: f64,
}
