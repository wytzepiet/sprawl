//! Every kind of building, one row each: who it holds, what it serves and
//! when, where it belongs in a town. A kind is a name in the protocol and a
//! row here, and nothing else in the game names one — the spawner reads the
//! row for its class and weight, residents read it for its taps, the
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
use crate::protocol::{BuildingKind, DAY_MS};

const H: u32 = DAY_MS / 24;

/// What company a kind keeps. Homes flock, commerce goes where the homes
/// are, industry keeps to itself — the spawner's whole sense of neighbourhood.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub enum Class {
    Living,
    Commerce,
    Industry,
}

pub struct Blueprint {
    pub class: Class,
    /// How many live here. Zero for anything you cannot live in.
    pub homes: u32,
    /// How many work here.
    pub jobs: u32,
    /// Footprint in tiles.
    pub size: (u8, u8),
    /// The spawner's base draw weight, before demand tilts it.
    pub weight: f64,
    /// The needs whose unmet demand argues for one more of these.
    pub tilt: &'static [Need],
    /// In the build menu, for the mayor to place by hand.
    pub by_hand: bool,
    /// What it serves, to whom, and when.
    pub taps: Vec<Tap>,
    /// Visits one delivery is good for. Zero: shelves that never run out.
    pub stock: u32,
    /// The kind of call it answers, with a vehicle of its own.
    pub answers: Option<CallKind>,
    /// How many vehicles it runs.
    pub vehicles: u32,
}

/// The row for a kind.
pub fn blueprint(kind: BuildingKind) -> &'static Blueprint {
    let (k, b) = &BLUEPRINTS[kind as usize];
    debug_assert_eq!(*k, kind, "blueprint table out of order");
    b
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
    // time off cannot, and only nearly-full time off beats sitting at home.
    let tap = |need, curve, slots| Tap { need, curve, rate: 1.0, overhead: 0, slots };
    let potter = |need, curve, slots| Tap { need, curve, rate: 0.35, overhead: 0, slots };
    let outing = |need, curve, slots| Tap { need, curve, rate: 0.45, overhead: 0, slots };
    let hours = Curve::hours;
    let always = Curve::always;
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
            class: Living, homes: 2, jobs: 0, size: (1, 1), weight: 4.0, tilt: &[], by_hand: false,
            stock: 0, answers: None, vehicles: 0,
            taps: household(2),
        }),
        (Apartment, Blueprint {
            class: Living, homes: 8, jobs: 0, size: (2, 1), weight: 1.0, tilt: &[], by_hand: false,
            stock: 0, answers: None, vehicles: 0,
            taps: household(8),
        }),
        // A shop seats as many as it staffs, and the high street is somewhere
        // to be until late.
        (Shop, Blueprint {
            class: Commerce, homes: 0, jobs: 4, size: (1, 1), weight: 1.5, tilt: &[Eat, Leisure], by_hand: false,
            stock: 40, answers: None, vehicles: 0,
            taps: vec![
                shift(9, 18, 4),
                tap(Eat, hours(9 * H, 18 * H), 4),
                outing(Leisure, hours(9 * H, 22 * H), 16),
            ],
        }),
        // Rush hour is staggered by kind so it comes as a wave rather than a
        // spike: industry starts before offices, offices before shops.
        (Office, Blueprint {
            class: Commerce, homes: 0, jobs: 16, size: (2, 1), weight: 0.7, tilt: &[Work], by_hand: false,
            stock: 0, answers: None, vehicles: 0,
            taps: vec![shift(8, 17, 16)],
        }),
        (Workshop, Blueprint {
            class: Industry, homes: 0, jobs: 6, size: (1, 1), weight: 0.7, tilt: &[Work], by_hand: false,
            stock: 0, answers: None, vehicles: 0,
            taps: vec![shift(7, 16, 6)],
        }),
        (Factory, Blueprint {
            class: Industry, homes: 0, jobs: 24, size: (2, 1), weight: 0.3, tilt: &[Work], by_hand: false,
            stock: 0, answers: None, vehicles: 0,
            taps: vec![shift(6, 15, 24)],
        }),
        // A restaurant seats a dozen, from lunch until late, and is an evening
        // out in itself. The first kind the mayor can place by hand.
        (Restaurant, Blueprint {
            class: Commerce, homes: 0, jobs: 6, size: (1, 1), weight: 0.4, tilt: &[Eat, Leisure], by_hand: true,
            stock: 30, answers: None, vehicles: 0,
            taps: vec![
                shift(11, 23, 6),
                tap(Eat, hours(11 * H, 22 * H), 12),
                outing(Leisure, hours(11 * H, 22 * H), 12),
            ],
        }),
        // A bar opens as the shops shut and is the last place open. Small
        // staff, an evening's crowd, a kitchen until eleven.
        (Bar, Blueprint {
            class: Commerce, homes: 0, jobs: 3, size: (1, 1), weight: 0.4, tilt: &[Leisure], by_hand: false,
            stock: 30, answers: None, vehicles: 0,
            taps: vec![
                shift(18, 2, 3),
                tap(Eat, hours(18 * H, 23 * H), 6),
                outing(Leisure, hours(20 * H, 2 * H), 12),
            ],
        }),
        // The pumps run round the clock; the kiosk keeps shop hours. Where
        // the tanks are filled is where the driving is — beside the homes.
        (GasStation, Blueprint {
            class: Commerce, homes: 0, jobs: 2, size: (1, 1), weight: 0.3, tilt: &[Fuel], by_hand: false,
            stock: 0, answers: None, vehicles: 0,
            taps: vec![
                shift(6, 22, 2),
                tap(Fuel, always(), 4),
            ],
        }),
        // Shopping for a whole district, with far more on the shelves than a
        // corner shop and a warehouse's truck to keep them full. The first
        // placeable with something to run out of.
        (Supermarket, Blueprint {
            class: Commerce, homes: 0, jobs: 8, size: (2, 2), weight: 0.0, tilt: &[], by_hand: true,
            stock: 150, answers: None, vehicles: 0,
            taps: vec![
                shift(8, 21, 8),
                tap(Eat, hours(8 * H, 21 * H), 24),
            ],
        }),
        // Where stock comes from. Its trucks answer the shops' calls; until
        // there is one, every delivery comes from beyond the edge.
        (Warehouse, Blueprint {
            class: Industry, homes: 0, jobs: 10, size: (1, 1), weight: 0.0, tilt: &[], by_hand: true,
            stock: 0, answers: Some(CallKind::Stock), vehicles: 2,
            taps: vec![shift(6, 18, 10)],
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
        "weight": b.weight,
        "tilt": b.tilt,
        "by_hand": b.by_hand,
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

    #[test]
    fn a_home_offers_sleep_and_a_shop_offers_work() {
        let taps = |k| blueprint(k).taps.iter();
        assert!(taps(House).any(|t| t.need == Need::Rest));
        assert!(taps(Shop).any(|t| t.need == Need::Work));
        assert!(taps(House).all(|t| t.need != Need::Work));
        assert!(taps(Shop).any(|t| t.need == Need::Eat));
    }
}
