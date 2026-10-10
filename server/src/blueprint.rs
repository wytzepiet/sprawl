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

use crate::needs::curve::Curve;
use crate::needs::{Need, Tap};
use crate::protocol::{BuildingKind, CarRole, Good, DAY_MS};

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
    /// anything nobody moves into.
    pub homes: u32,
    /// How many work here.
    pub jobs: u32,
    /// The building's own footprint in tiles, wide along its frontage.
    pub size: (u8, u8),
    /// Its yard, in tiles along the frontage and deep, on the street side:
    /// a kind with vehicles of its own keeps one. (0, 0) is none: it parks
    /// on its drive.
    pub lot: (u8, u8),
    /// What it is built from, a material each and how much: a site stands
    /// when all of it has been delivered (docs/game.md §Buildings). None
    /// stands at once. Timber for every kind the opening builds; stone
    /// besides for the big ones, the masonry a timber frame stands on.
    pub materials: &'static [(Good, u32)],
    /// What it serves, to whom, and when.
    pub taps: Vec<Tap>,
    /// Its shelves, a good each and the units it holds: what a counter
    /// serves from, what a depot keeps, what a farm's yard fills with.
    pub shelves: &'static [(Good, u32)],
    /// What its land fills its shelf with: a farm's crates. None for a
    /// row that buys its shelves in, or keeps none.
    pub makes: Option<Good>,
    /// The vehicles it runs, each in a dock of its yard. A kind with
    /// shelves and vehicles delivers them (`economy::depot`).
    pub vehicles: &'static [CarRole],
    /// Stands with its back to the sea: the world's ferry berths at the
    /// quay behind it (`world/sea.rs`).
    pub quay: bool,
    /// A farm: its land is what its tractor ploughs in a shift, and its
    /// yard holds a harvest, the cycle's make (docs/economy.md §12.8).
    pub farm: bool,
}

/// The row for a kind.
pub fn blueprint(kind: BuildingKind) -> &'static Blueprint {
    let (k, b) = &BLUEPRINTS[kind as usize];
    debug_assert_eq!(*k, kind, "blueprint table out of order");
    b
}

/// What a kind is built from, material by material: what a draft of it
/// puts on the bill and its site waits for.
pub fn takes(kind: BuildingKind) -> Vec<(Good, f64)> {
    blueprint(kind).materials.iter().map(|&(good, n)| (good, n as f64)).collect()
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
    // As wide as the wider of building and yard.
    let w = bw.max(lw);
    let size = if facing % 2 == 0 { (w, bh + ld) } else { (bh + ld, w) };
    lie(kind, facing, size)
}

/// How a building `size` across lies facing this way: its yard, if its
/// kind keeps one, the rows on its street side as deep as the kind's, the
/// whole width; the rest the building. A painted building is laid out by
/// its bounds, the smallest that works by `plot`.
pub fn lie(kind: BuildingKind, facing: u8, (w, h): (u8, u8)) -> Plot {
    let ld = blueprint(kind).lot.1;
    let lot = ld > 0;
    let d = if lot { ld } else { 0 };
    // In the building's own frame the yard lies beyond its frontage, along
    // +y; the frame turns with the facing.
    match facing % 4 {
        2 => Plot { size: (w, h), building: ((0, 0), (w, h - d)), lot: lot.then_some(((0, h - d), (w, d))) },
        0 => Plot { size: (w, h), building: ((0, d), (w, h - d)), lot: lot.then_some(((0, 0), (w, d))) },
        1 => Plot { size: (w, h), building: ((0, 0), (w - d, h)), lot: lot.then_some(((w - d, 0), (d, h))) },
        _ => Plot { size: (w, h), building: ((d, 0), (w - d, h)), lot: lot.then_some(((0, 0), (d, h))) },
    }
}

/// How many a tap serves at once. A visitor's tap seats seven, what a
/// building's lot parked when it had one, until the kerb's bays say how
/// many can come; staff, a house's two homes and a yard seat the row's
/// number.
pub fn seats(kind: BuildingKind, tap: &Tap) -> u32 {
    let b = blueprint(kind);
    let parked = b.vehicles.is_empty() && kind != BuildingKind::House;
    if tap.need != Need::Work && parked { 7 } else { tap.slots }
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
    // rates rank the needs: sleep and food can pull someone out of a shift.
    let tap = |need, curve, slots| Tap { need, curve, rate: 1.0, overhead: 0, slots };
    let meal = |curve, slots| tap(Eat, curve, slots);
    // A pump fills a tank in twenty minutes, and a stop takes ten more
    // whatever it fills: pulling in, paying at the kiosk. What keeps a
    // driver from topping up every time they pass, now that the tank
    // costs them nothing: they fill up when it is worth the stop.
    let pump = |curve, slots| Tap { need: Fuel, curve, rate: Fuel.cap() / Need::FILL_MS, overhead: (H / 6) as u64, slots };
    // Staff are sized to what parks at the door, a third at most. A
    // visitor tap at a kind that kept a lot seats seven at once whatever
    // the row says (`seats`); the row's number is its rate.
    let hours = Curve::hours;
    let always = Curve::always;
    // A shift: work on offer between these hours, with a place for each of the staff.
    let shift = |open: u32, close: u32, jobs: u32| tap(Work, hours(open * H, close * H), jobs);
    // A household: sleep on offer through the night; being home and the
    // kitchen on offer always, to everyone who lives there.
    let household = |homes: u32| {
        vec![
            tap(Rest, hours(22 * H, 7 * H), homes),
            tap(Home, always(), homes),
            meal(always(), homes),
        ]
    };

    let row = |class, homes, jobs, size, lot, materials, taps| Blueprint {
        class, homes, jobs, size, lot, materials, taps, shelves: &[], makes: None, vehicles: &[], quay: false, farm: false,
    };
    use Good::{Stone, Timber};
    vec![
        (House, row(Living, 2, 0, (1, 1), (0, 0), &[(Timber, 4)], household(2))),
        (Apartment, row(Living, 7, 0, (2, 1), (0, 0), &[(Timber, 12), (Stone, 8)], household(7))),
        // A shop seats as many as it staffs.
        (Shop, Blueprint {
            shelves: &[(Good::Crates, 40)],
            ..row(Commerce, 0, 2, (1, 1), (0, 0), &[(Timber, 4)], vec![shift(9, 18, 2), meal(hours(9 * H, 18 * H), 7)])
        }),
        // Rush hour is staggered by kind so it comes as a wave rather than a
        // spike: industry starts before offices, offices before shops.
        (Office, row(Commerce, 0, 12, (2, 1), (0, 0), &[(Timber, 10), (Stone, 6)], vec![shift(8, 17, 12)])),
        (Factory, row(Industry, 0, 12, (2, 1), (0, 0), &[(Timber, 14), (Stone, 8)], vec![shift(6, 15, 12)])),
        // The pumps run round the clock; the kiosk keeps shop hours. Where
        // the tanks are filled is where the driving is — beside the homes.
        // Its shelf is tanks: a delivery is a van's worth, and more than
        // four pumps could sell in the two hours a van is away with the lot
        // full, or it would never stop ordering.
        (GasStation, Blueprint {
            shelves: &[(Good::Fuel, 40)],
            ..row(Commerce, 0, 1, (1, 1), (0, 0), &[(Timber, 6), (Stone, 4)], vec![shift(6, 22, 1), pump(always(), 4)])
        }),
        // Shopping for a whole district, with far more on the shelves than a
        // corner shop.
        (Supermarket, Blueprint {
            shelves: &[(Good::Crates, 150)],
            ..row(Commerce, 0, 6, (2, 2), (0, 0), &[(Timber, 16), (Stone, 10)], vec![shift(8, 21, 6), meal(hours(8 * H, 21 * H), 12)])
        }),
        // Where the town's goods are kept, a little of every class: two
        // boxes of crates, two tank boxes, three of timber, three of stone. Its lorry hauls
        // boxes from the harbour and its vans deliver to shops and sites.
        (Depot, Blueprint {
            shelves: &[(Good::Crates, 200), (Good::Fuel, 100), (Good::Timber, 60), (Good::Stone, 60)],
            vehicles: &[CarRole::Truck, CarRole::Van, CarRole::Van],
            ..row(Industry, 0, 6, (2, 2), (3, 2), &[(Timber, 10)], vec![shift(6, 18, 6)])
        }),
        // Where food comes from. Four hands, six to three, each growing a
        // sitting's worth every few minutes: at eighteen crates an hour a
        // day's work feeds sixty people, a fifth of what a modern farm
        // manages and about what a market garden does. The make grows on
        // its land, the grass behind it that its tractor ploughs in a
        // shift, seeds the next day and harvests the day after, each tile's
        // crop landing in the yard as it is cut (§12.8). A depot's lorry
        // fetches from it. Its yard is a harvest: three days of four hands'
        // nine hours at eighteen crates an hour.
        (Farm, Blueprint {
            shelves: &[(Good::Crates, 1944)],
            makes: Some(Good::Crates),
            vehicles: &[CarRole::Tractor],
            farm: true,
            ..row(Industry, 0, 4, (3, 2), (2, 2), &[(Timber, 8)], vec![shift(6, 15, 4)])
        }),
        // The door: an apron on the quay that the tug crosses, the ramp
        // behind it, and a trailer park on the street side, its docks the
        // slots boxes stand in, with the tug that shunts them. Two hands drive the tug and work the ramp, dawn to late.
        // Built from nothing: it is where timber first comes in.
        (Harbour, Blueprint {
            vehicles: &[CarRole::Tug],
            quay: true,
            ..row(Industry, 0, 2, (3, 1), (3, 2), &[], vec![shift(6, 22, 2)])
        }),
        // Four hands, seven to four, felling and sawing the forest round it:
        // with woods all round, a box of timber a shift and a half, a house
        // every hour and a bit. Its yard holds six boxes; full, it stops.
        (Sawmill, Blueprint {
            shelves: &[(Good::Timber, 120)],
            makes: Some(Good::Timber),
            ..row(Industry, 0, 4, (2, 2), (2, 2), &[(Timber, 6)], vec![shift(7, 16, 4)])
        }),
        // The sawmill's twin at the mountain's foot: four hands, seven to
        // four, breaking the rock within reach, as much stone a shift as the
        // sawmill makes timber. Built of timber alone, so the town can
        // build its quarry before it has any stone.
        (Quarry, Blueprint {
            shelves: &[(Good::Stone, 120)],
            makes: Some(Good::Stone),
            ..row(Industry, 0, 4, (2, 2), (2, 2), &[(Timber, 8)], vec![shift(7, 16, 4)])
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
        assert!(!b.farm || b.vehicles.contains(&CarRole::Tractor), "{kind:?} farms without a tractor");
        // A harbour has a park for the ferry's boxes and a tug to shunt them.
        assert!(!b.quay || (b.lot.1 > 0 && b.vehicles.contains(&CarRole::Tug)), "{kind:?} has a quay and nowhere to land a box");
        assert!(b.makes.is_none_or(|g| b.shelves.iter().any(|&(s, _)| s == g)), "{kind:?} makes what it has no shelf for");
        // A depot's van brings every material a site takes.
        for &(good, _) in b.materials {
            assert!(blueprint(BuildingKind::Depot).shelves.iter().any(|&(s, _)| s == good), "{kind:?} is built of {good:?}, which no depot keeps");
        }
        for tap in &b.taps {
            // T1: a fixed-length service still takes time.
            assert!(tap.rate.is_finite() || tap.overhead > 0, "{kind:?} serves {:?} instantly and for free", tap.need);
            // C1: an empty stock refills within the one-day horizon.
            assert!(
                tap.need.drain() == 0.0 || tap.need.cap() / tap.rate <= day,
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
        "materials": b.materials,
        "shelves": b.shelves,
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

    /// The whole table serialises: the readout is the only way to see
    /// what a kind actually says.
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
