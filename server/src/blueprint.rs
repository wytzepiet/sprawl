//! Every kind of building, one row each: who it holds, what it serves and
//! when, what it costs. A kind is a name in the protocol and a row here,
//! and nothing else in the game names one — the build menu reads the row
//! for its price and its shelf, residents read it for its taps, the
//! settlement reads it for rooms and jobs. A new kind is a new row.
//!
//! What is a number or a schedule lives here. What is a verb — how a shift
//! is worked, how a visit is scored — lives with the code that does it, and
//! takes its parameters from the row.

use std::sync::LazyLock;

use serde_json::{json, Value};

use crate::calls::CallKind;
use crate::needs::curve::Curve;
use crate::needs::{Need, Tap};
use crate::protocol::{CarRole, BuildingKind, DAY_MS};

const H: u32 = DAY_MS / 24;

/// Which of the tree's three avenues a kind belongs to. Taking one makes
/// its class cheaper to place; nothing else reads this.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub enum Class {
    Living,
    Commerce,
    Industry,
}

pub struct Blueprint {
    pub class: Class,
    /// How many the settlement moves in of its own accord. Zero for
    /// anything nobody moves into — a shop, and the edge, whose households
    /// are made by the jobs the city could not fill.
    pub homes: u32,
    /// How many work here.
    pub jobs: u32,
    /// The building's own footprint in tiles, wide along its frontage.
    pub size: (u8, u8),
    /// Its lot, in tiles along the frontage and deep, on the street side.
    /// (0, 0) is none: a driveway, or nothing.
    pub lot: (u8, u8),
    /// What the mayor pays for one, in hours of need served.
    pub price: f64,
    /// What it serves, to whom, and when.
    pub taps: Vec<Tap>,
    /// Visits one delivery is good for. Zero: shelves that never run out.
    pub stock: u32,
    /// The kind of call it answers, with a vehicle of its own.
    pub answers: Option<CallKind>,
    /// The vehicles it runs, each in a dock of its yard.
    pub vehicles: &'static [CarRole],
}

/// The row for a kind.
pub fn blueprint(kind: BuildingKind) -> &'static Blueprint {
    let (k, b) = &BLUEPRINTS[kind as usize];
    debug_assert_eq!(*k, kind, "blueprint table out of order");
    b
}

/// The four ways a plot can lie: which side of the building its lot, and
/// so its street, is on. 0 is toward -y, then clockwise on the grid:
/// 1 toward +x, 2 toward +y, 3 toward -x.
pub const FACINGS: [(i32, i32); 4] = [(0, -1), (1, 0), (0, 1), (-1, 0)];

/// A plot as it lies on the grid for a facing: its size, and where the
/// building and the lot are within it, as (offset, size).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plot {
    pub size: (u8, u8),
    pub building: ((u8, u8), (u8, u8)),
    pub lot: Option<((u8, u8), (u8, u8))>,
}

pub fn plot(kind: BuildingKind, facing: u8) -> Plot {
    let b = blueprint(kind);
    let (bw, bh) = b.size;
    let (lw, ld) = b.lot;
    let lot = lw > 0 && ld > 0;
    // In the building's own frame the lot lies beyond its frontage, along
    // +y; the frame turns with the facing.
    // As wide as the wider of building and lot: a small building with a
    // two-car lot beside its front stands in the corner of its plot.
    let w = bw.max(lw);
    match facing % 4 {
        2 => Plot { size: (w, bh + ld), building: ((0, 0), (bw, bh)), lot: lot.then_some(((0, bh), (lw, ld))) },
        0 => Plot { size: (w, bh + ld), building: ((0, ld), (bw, bh)), lot: lot.then_some(((0, 0), (lw, ld))) },
        1 => Plot { size: (bh + ld, w), building: ((0, 0), (bh, bw)), lot: lot.then_some(((bh, 0), (ld, lw))) },
        _ => Plot { size: (bh + ld, w), building: ((ld, 0), (bh, bw)), lot: lot.then_some(((0, 0), (ld, lw))) },
    }
}

/// Every tap of every kind — what a need can be served by, anywhere.
pub fn all_taps() -> impl Iterator<Item = &'static Tap> {
    BLUEPRINTS.iter().flat_map(|(_, b)| b.taps.iter())
}

static BLUEPRINTS: LazyLock<Vec<(BuildingKind, Blueprint)>> = LazyLock::new(|| {
    use BuildingKind::*;
    use Class::*;
    use Need::*;
    // Rate is what a need can matter at its most urgent (needs §5.1), so the
    // rates rank the needs: sleep and food can pull someone out of a shift,
    // time off cannot while it is under six tenths full, which is how it
    // sits the day after a night out; over that, an evening out beats
    // waiting at home for bed, which is what a night out is.
    let tap = |need, curve, slots| Tap { need, curve, rate: 1.0, overhead: 0, slots };
    let potter = |need, curve, slots| Tap { need, curve, rate: 0.35, overhead: 0, slots };
    let outing = |need, curve, slots| Tap { need, curve, rate: 0.8, overhead: 0, slots };
    // Staff are sized to the lot, since everyone parks in it: a one-wide lot
    // parks seven hemmed in and twelve in the open, a two-wide one seven to
    // seventeen, and staff take a third at most. A visitor tap's slots are
    // its lot's spots whatever the row says; the row's number is what a
    // one-wide lot holds hemmed in.
    let hours = Curve::hours;
    let always = Curve::always;
    // A tap of the edge: open always, and with room for everyone who ever
    // turns up, because beyond the map there is as much of everything as
    // you like.
    let everywhere = |need, rate| Tap { need, curve: always(), rate, overhead: 0, slots: u32::MAX };
    // A shift: work on offer between these hours, with a place for each of the staff.
    let shift = |open: u32, close: u32, jobs: u32| tap(Work, hours(open * H, close * H), jobs);
    // A household: sleep on offer through the night; being home, the kitchen
    // and pottering about on offer always, to everyone who lives there.
    let household = |homes: u32| {
        vec![
            tap(Rest, hours(22 * H, 7 * H), homes),
            tap(Home, always(), homes),
            tap(Eat, always(), homes),
            potter(Leisure, always(), homes),
        ]
    };

    vec![
        (House, Blueprint {
            class: Living, homes: 2, jobs: 0, size: (1, 1), lot: (0, 0), price: 3.0,
            stock: 0, answers: None, vehicles: &[],
            taps: household(2),
        }),
        (Apartment, Blueprint {
            class: Living, homes: 7, jobs: 0, size: (2, 1), lot: (2, 1), price: 8.0,
            stock: 0, answers: None, vehicles: &[],
            taps: household(7),
        }),
        // A shop seats as many as it staffs, and the high street is somewhere
        // to be until late.
        (Shop, Blueprint {
            class: Commerce, homes: 0, jobs: 2, size: (1, 1), lot: (2, 1), price: 4.0,
            stock: 40, answers: None, vehicles: &[],
            taps: vec![
                shift(9, 18, 2),
                tap(Eat, hours(9 * H, 18 * H), 7),
                outing(Leisure, hours(9 * H, 22 * H), 7),
            ],
        }),
        // Rush hour is staggered by kind so it comes as a wave rather than a
        // spike: industry starts before offices, offices before shops.
        (Office, Blueprint {
            class: Commerce, homes: 0, jobs: 12, size: (2, 1), lot: (2, 1), price: 10.0,
            stock: 0, answers: None, vehicles: &[],
            taps: vec![shift(8, 17, 12)],
        }),
        (Workshop, Blueprint {
            class: Industry, homes: 0, jobs: 4, size: (1, 1), lot: (2, 1), price: 5.0,
            stock: 0, answers: None, vehicles: &[],
            taps: vec![shift(7, 16, 4)],
        }),
        (Factory, Blueprint {
            class: Industry, homes: 0, jobs: 12, size: (2, 1), lot: (2, 1), price: 12.0,
            stock: 0, answers: None, vehicles: &[],
            taps: vec![shift(6, 15, 12)],
        }),
        // A restaurant seats a dozen, from lunch until late, and is an evening
        // out in itself. The first kind the mayor can place by hand.
        (Restaurant, Blueprint {
            class: Commerce, homes: 0, jobs: 3, size: (1, 1), lot: (2, 1), price: 5.0,
            stock: 30, answers: None, vehicles: &[],
            taps: vec![
                shift(11, 23, 3),
                tap(Eat, hours(11 * H, 22 * H), 7),
                outing(Leisure, hours(11 * H, 22 * H), 7),
            ],
        }),
        // A bar opens as the shops shut and is the last place open. Small
        // staff, an evening's crowd, a kitchen until eleven.
        (Bar, Blueprint {
            class: Commerce, homes: 0, jobs: 2, size: (1, 1), lot: (2, 1), price: 4.0,
            stock: 30, answers: None, vehicles: &[],
            taps: vec![
                shift(18, 2, 2),
                tap(Eat, hours(18 * H, 23 * H), 7),
                outing(Leisure, hours(20 * H, 2 * H), 7),
            ],
        }),
        // The pumps run round the clock; the kiosk keeps shop hours. Where
        // the tanks are filled is where the driving is — beside the homes.
        (GasStation, Blueprint {
            class: Commerce, homes: 0, jobs: 1, size: (1, 1), lot: (2, 1), price: 6.0,
            stock: 0, answers: None, vehicles: &[],
            taps: vec![
                shift(6, 22, 1),
                tap(Fuel, always(), 4),
            ],
        }),
        // Shopping for a whole district, with far more on the shelves than a
        // corner shop and a warehouse's truck to keep them full. The first
        // placeable with something to run out of.
        (Supermarket, Blueprint {
            class: Commerce, homes: 0, jobs: 6, size: (2, 2), lot: (2, 1), price: 12.0,
            stock: 150, answers: None, vehicles: &[],
            taps: vec![
                shift(8, 21, 6),
                tap(Eat, hours(8 * H, 21 * H), 12),
            ],
        }),
        // Where stock comes from. Its trucks answer the shops' calls; until
        // there is one, every delivery comes from beyond the edge.
        (Warehouse, Blueprint {
            class: Industry, homes: 0, jobs: 6, size: (2, 2), lot: (2, 2), price: 15.0,
            stock: 6, answers: Some(CallKind::Stock), vehicles: &[CarRole::Truck, CarRole::Truck, CarRole::Van, CarRole::Van],
            taps: vec![shift(6, 18, 6)],
        }),
        // The world beyond the survey, standing where a road runs off the
        // map. Every tap in the game, never closed and never crowded: a
        // town with no restaurant still eats, a job nobody in town wants is
        // still worked. What it costs is the drive, and that is the whole
        // argument for building your own. Priceless in the literal sense —
        // the outside is not for sale, so the mayor can never afford one —
        // and what it serves is another city's earnings, not this one's
        // (see `resident::served`).
        (Edge, Blueprint {
            class: Commerce, homes: 0, jobs: u32::MAX, size: (1, 1), lot: (0, 0), price: f64::INFINITY,
            stock: 0, answers: None, vehicles: &[],
            taps: vec![
                everywhere(Home, 1.0),
                everywhere(Work, 1.0),
                everywhere(Rest, 1.0),
                everywhere(Eat, 1.0),
                // No better than an evening out in town, or the edge would
                // raise what every bucket thinks is possible; see `Need::bounds`.
                everywhere(Leisure, 0.8),
                everywhere(Fuel, 1.0),
            ],
        }),
    ]
});

/// Build every row and check it against the invariants the decision procedure
/// leans on. Called once at startup, so nothing is materialised lazily later
/// and a bad table fails before anyone acts on it.
pub fn check() {
    let day = DAY_MS as f64;
    for (i, (kind, b)) in BLUEPRINTS.iter().enumerate() {
        assert_eq!(*kind as usize, i, "blueprint table out of order at {kind:?}");
        assert_eq!(*kind, BuildingKind::ALL[i], "{kind:?} missing from BuildingKind::ALL");
        for tap in &b.taps {
            // T1: a fixed-length service still takes time.
            assert!(tap.rate.is_finite() || tap.overhead > 0, "{kind:?} serves {:?} instantly and for free", tap.need);
            // C1: a full bucket drains within the one-day horizon.
            assert!(
                tap.need.fill() == 0.0 || tap.need.cap() / tap.rate <= day,
                "{kind:?} takes over a day to drain {:?}",
                tap.need
            );
        }
    }
    assert_eq!(BLUEPRINTS.len(), BuildingKind::ALL.len(), "a kind has no blueprint");
}

/// The whole table, readable: what each kind is and does.
pub fn inspect() -> Value {
    let hours = |c: &Curve| c.per_day() / H as f64;
    json!(BLUEPRINTS.iter().map(|(kind, b)| json!({
        "kind": kind,
        "class": b.class,
        "homes": b.homes,
        "jobs": b.jobs,
        "size": b.size,
        "price_h": b.price,
        "taps": b.taps.iter().map(|t| json!({
            "need": t.need, "open_h": hours(&t.curve), "rate": t.rate, "slots": t.slots,
        })).collect::<Vec<_>>(),
    })).collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use super::*;
    use BuildingKind::*;

    #[test]
    fn the_table_holds_up() {
        check();
    }

    /// The edge answers every need there is, always, and with room for
    /// everyone: that is what "everything the city lacks exists beyond the
    /// edge" means in the table. And it is not for sale at any price.
    #[test]
    fn the_edge_serves_everything_and_is_not_for_sale() {
        let b = blueprint(Edge);
        for need in Need::ALL {
            let tap = b.taps.iter().find(|t| t.need == need).unwrap_or_else(|| panic!("the edge does not serve {need:?}"));
            assert_eq!(tap.slots, u32::MAX, "{need:?} at the edge is rationed");
            assert_eq!(tap.curve.per_day(), DAY_MS as f64, "{need:?} at the edge closes");
            // No better than the best in town, or the edge would raise what
            // every bucket anywhere thinks is possible.
            assert!(tap.rate <= need.bounds().0, "{need:?} is served better at the edge than anywhere");
        }
        assert!(!b.price.is_finite(), "the outside is for sale");
        assert!(b.taps.iter().any(|t| t.need == Need::Work), "no work beyond the edge");
        assert_eq!(b.jobs, u32::MAX, "the edge runs out of jobs");
        // Its kitchen is nobody's in particular, so the search offers it to
        // everyone — see `resident::search`.
        assert_eq!(b.homes, 0, "the edge draws people in for its own sake");
    }

    /// The whole table serialises, infinite price and all: the readout is
    /// the only way to see what a kind actually says.
    #[test]
    fn the_table_can_be_read() {
        let v = inspect();
        assert_eq!(v.as_array().unwrap().len(), BLUEPRINTS.len());
    }

    #[test]
    fn a_home_offers_sleep_and_a_shop_offers_work() {
        let taps = |k| blueprint(k).taps.iter();
        assert!(taps(House).any(|t| t.need == Need::Rest));
        assert!(taps(Shop).any(|t| t.need == Need::Work));
        assert!(taps(House).all(|t| t.need != Need::Work));
        assert!(taps(Shop).any(|t| t.need == Need::Eat));
    }
}
