//! Every kind of building, one row each: who it holds, what it serves and
//! when, what it costs. A kind is a name in the protocol and a row here,
//! and nothing else in the game names one — the build menu reads the row
//! for its price and its shelf, residents read it for its taps, the
//! settlement reads it for rooms and jobs. A new kind is a new row.
//!
//! What is a number or a schedule lives here. What is a verb — how a shift
//! is worked, how a visit is scored — lives with the code that does it, and
//! takes its parameters from the row.

use std::collections::BTreeMap;
use std::sync::LazyLock;


use crate::needs::curve::Curve;
use crate::needs::{Need, Tap};
use crate::{BuildingKind, CarRole, Good, DAY_MS, HOUR as H};
use land::{Deposit, TerrainType};

/// The ground a maker's hands work for a good: the forest for timber, the
/// mountain for stone, and what lies under it for ore, coal and crude.
/// None for what is not got off the land round it.
pub fn ground(good: Good) -> Option<(TerrainType, Option<Deposit>)> {
    match good {
        Good::Timber => Some((TerrainType::Forest, None)),
        Good::Stone => Some((TerrainType::Mountain, None)),
        Good::Ore => Some((TerrainType::Mountain, Some(Deposit::Ore))),
        Good::Coal => Some((TerrainType::Mountain, Some(Deposit::Coal))),
        Good::Crude => Some((TerrainType::Grass, Some(Deposit::Oil))),
        _ => None,
    }
}

pub struct Blueprint {
    /// How many the settlement moves in of its own accord: whom it gives a
    /// bed (its Rest tap). Zero for anything nobody moves into.
    pub homes: u32,
    /// How many work here: its shift's places.
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
    /// What its land or its hands fill its shelf with: a farm's grain, a
    /// sawmill's timber, a bakery's bread. None for a row that buys its
    /// shelves in, or keeps none.
    pub makes: Option<Good>,
    /// What its hands open to make it, and how much of each a unit takes:
    /// a bakery's grain, a steelworks' ore and coal. Bought in like a
    /// counter's shelf. Empty for a maker off the land.
    pub opens: &'static [(Good, f64)],
    /// Units of its make an hour of a hand's work makes at best: off the
    /// land, with all the ground in reach; opening goods, while its bins
    /// hold them. A farm's grows on its fields instead (`crop`).
    pub pace: f64,
    /// The vehicles it runs, each in a dock of its yard. A kind with
    /// shelves and vehicles delivers them (`economy::depot`).
    pub vehicles: &'static [CarRole],
    /// Stands with its back to the sea: the world's ferry berths at the
    /// quay behind it (`map/sea.rs`).
    pub quay: bool,
    /// Forklifts working its pad: how many vehicles it loads or unloads
    /// at once (`World::lift`). One, but a harbour's, which works the
    /// ferry's deck and the lorries both.
    pub forklifts: u8,
    /// Docks in its yard, the ones nearest its building: as many as fit,
    /// but a sawmill's one, before its barn door (`lots::park`).
    pub docks: usize,
    /// A farm: its land is what its tractor ploughs in a shift, and its
    /// yard holds a harvest, the cycle's make (`map/fields.rs`).
    pub farm: bool,
}

/// The row for a kind.
pub fn blueprint(kind: BuildingKind) -> &'static Blueprint {
    let (k, b) = &BLUEPRINTS[kind as usize];
    debug_assert_eq!(*k, kind, "blueprint table out of order");
    b
}

/// What a kind is built from, material by material: what its site waits
/// for, and what undoing it gives back.
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
/// whole width; the rest the building. A building is laid out by its
/// bounds: placed, they are its plot's (`plot`); a fixture's may be any.
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

    let row = |size, lot, materials, taps: Vec<Tap>| {
        let slots = |need: Need| taps.iter().find(|t| t.need == need).map_or(0, |t| t.slots);
        Blueprint { homes: slots(Rest), jobs: slots(Work), size, lot, materials, taps, shelves: &[], makes: None, opens: &[], pace: 0.0, vehicles: &[], quay: false, forklifts: 1, docks: usize::MAX, farm: false }
    };
    use Good::{Cement, Coal, Crude, Grain, Machinery, Ore, Steel, Stone, Timber};
    vec![
        // A home's kitchen cooks off its pantry: two crates of bread for
        // a house, some ten days of its two's meals; four for a block of
        // seven, a week. A depot's van fills it as it would a shop's shelf.
        (House, Blueprint { shelves: &[(Good::Bread, 50)], ..row((1, 1), (0, 0), &[(Timber, 4)], household(2)) }),
        (Apartment, Blueprint { shelves: &[(Good::Bread, 100)], ..row((2, 1), (0, 0), &[(Timber, 12), (Stone, 8), (Cement, 8)], household(7)) }),
        // A shop seats as many as it staffs.
        (Shop, Blueprint {
            shelves: &[(Good::Bread, 50)],
            ..row((1, 1), (0, 0), &[(Timber, 4)], vec![shift(9, 18, 2), meal(hours(9 * H, 18 * H), 7)])
        }),
        // Rush hour is staggered by kind so it comes as a wave rather than a
        // spike: industry starts before offices, offices before shops.
        (Office, row((2, 1), (0, 0), &[(Timber, 12), (Stone, 8)], vec![shift(8, 17, 12)])),
        // The machine works: twelve hands, six to three, making machine
        // parts of steel, two units a part, a crate a hand a couple of
        // days. Light and dear: what the oil and the port are built with.
        (Factory, Blueprint {
            shelves: &[(Steel, 20), (Machinery, 10)],
            makes: Some(Machinery),
            opens: &[(Steel, 2.0)],
            pace: 0.05,
            docks: 2,
            ..row((3, 2), (3, 2), &[(Stone, 8), (Cement, 16), (Steel, 8)], vec![shift(6, 15, 12)])
        }),
        // The pumps run round the clock; the kiosk keeps shop hours. Where
        // the tanks are filled is where the driving is — beside the homes.
        // Its shelf is tanks, four pallets of drums: a delivery is a van's
        // worth, and more than four pumps could sell in the two hours a
        // van is away with the lot full, or it would never stop ordering.
        (GasStation, Blueprint {
            shelves: &[(Good::Fuel, 40)],
            ..row((1, 1), (0, 0), &[(Timber, 8), (Stone, 4)], vec![shift(6, 22, 1), pump(always(), 4)])
        }),
        // Shopping for a whole district, with far more on the shelves than a
        // corner shop.
        (Supermarket, Blueprint {
            shelves: &[(Good::Bread, 150)],
            ..row((2, 2), (0, 0), &[(Timber, 16), (Stone, 12), (Cement, 8)], vec![shift(8, 21, 6), meal(hours(8 * H, 21 * H), 12)])
        }),
        // Where the town's goods are kept, in the open, a little of every
        // good, about ten packages of each: twenty crates of bread, what
        // its town's pantries and counters go through in a day or so, and
        // twenty bags of grain for its bakers; fifteen bundles of timber
        // and fifteen pallets of stone. Its lorry hauls packages from the
        // harbour and the makers' yards, and its vans deliver to homes,
        // shops, works and sites.
        (Depot, Blueprint {
            shelves: &[
                (Good::Bread, 500),
                (Good::Fuel, 100),
                (Timber, 60),
                (Stone, 60),
                (Grain, 500),
                (Cement, 40),
                (Ore, 40),
                (Coal, 40),
                (Steel, 20),
                (Machinery, 10),
                (Crude, 100),
            ],
            vehicles: &[CarRole::Truck, CarRole::Van, CarRole::Van],
            ..row((2, 2), (3, 2), &[(Timber, 12)], vec![shift(6, 18, 6)])
        }),
        // Where food comes from. Four hands, six to three, each growing a
        // sitting's worth every few minutes: at eighteen crates an hour a
        // day's work feeds sixty people, a fifth of what a modern farm
        // manages and about what a market garden does. The make grows on
        // its land, the grass behind it that its tractor ploughs in a
        // shift, seeds the next day and harvests two days after, each
        // tile's crop landing in the yard as it is cut (§12.8). A depot's
        // lorry fetches from it. Its yard is a harvest: four days of four
        // hands' nine hours at eighteen crates an hour, a hundred and four
        // crates on its pad. Two docks by the barn, one for the lorry that
        // takes them and one the tractor stands in: the rest of the yard
        // is the farm's own. Three tiles square: the barn a row along the
        // back, its middle the gate the tractor goes out to the fields by.
        (Farm, Blueprint {
            shelves: &[(Grain, 2600)],
            makes: Some(Grain),
            vehicles: &[CarRole::Tractor],
            farm: true,
            docks: 2,
            ..row((3, 1), (2, 2), &[(Timber, 8)], vec![shift(6, 15, 4)])
        }),
        // The door: all yard, three tiles along the quay and two in, no
        // building. Down its middle a lane from the gate on the street to
        // the ramp, kept clear for what comes off the ferry; on one side
        // of it the docks lorries back into, on the other the quay's pad,
        // the pallets standing on it; in the corner on the quay the
        // terminal (`map/sea.rs`). Two hands work the ramp and its three
        // forklifts, dawn to late. Built from nothing: it is where timber
        // first comes in.
        (Harbour, Blueprint {
            quay: true,
            forklifts: 3,
            ..row((3, 0), (3, 2), &[], vec![shift(6, 22, 2)])
        }),
        // Four hands, seven to four, felling and sawing the forest round it:
        // with woods all round, five bundles of timber a shift and a half, a
        // house every hour and a bit. Its yard holds thirty bundles; full,
        // it stops.
        (Sawmill, Blueprint {
            shelves: &[(Good::Timber, 120)],
            makes: Some(Good::Timber),
            pace: 0.5,
            docks: 1,
            ..row((2, 2), (2, 2), &[(Timber, 8)], vec![shift(7, 16, 4)])
        }),
        // The sawmill's twin at the mountain's foot: four hands, seven to
        // four, breaking the rock within reach, as much stone a shift as the
        // sawmill makes timber. Built of timber alone, so the town can
        // build its quarry before it has any stone.
        (Quarry, Blueprint {
            shelves: &[(Good::Stone, 120)],
            makes: Some(Good::Stone),
            pace: 0.5,
            ..row((2, 2), (2, 2), &[(Timber, 8)], vec![shift(7, 16, 4)])
        }),
        // Four at desks, eight to five: thirty-six researcher-hours a
        // day, the first rung's kind in two thirds of one.
        (Lab, row((2, 1), (0, 0), &[(Timber, 8)], vec![shift(8, 17, 4)])),
        // Bakers start before the town wakes: four hands, five to two,
        // opening bags of grain and baking them into crates of bread, a
        // unit of grain a meal, as much a shift as a farm grows. It keeps
        // a shift's grain in, twenty-six bags, filled overnight while the
        // vans are free, and twenty crates out.
        (Bakery, Blueprint {
            shelves: &[(Grain, 650), (Good::Bread, 500)],
            makes: Some(Good::Bread),
            opens: &[(Grain, 1.0)],
            pace: 18.0,
            // A lorry for its bread and a van with its grain at once.
            docks: 2,
            ..row((2, 1), (2, 2), &[(Timber, 8)], vec![shift(5, 14, 4)])
        }),
        // A kiln and a mill: six hands, seven to four, burning stone into
        // cement, a unit for a unit, as fast as a quarry breaks it.
        (CementWorks, Blueprint {
            shelves: &[(Stone, 60), (Cement, 60)],
            makes: Some(Cement),
            opens: &[(Stone, 1.0)],
            pace: 0.5,
            docks: 1,
            ..row((2, 2), (2, 2), &[(Timber, 12), (Stone, 12)], vec![shift(7, 16, 6)])
        }),
        // The quarry's cousins, on mountains that have ore or coal in
        // them: six hands, seven to four, as much a shift as a quarry.
        (Mine, Blueprint {
            shelves: &[(Ore, 120)],
            makes: Some(Ore),
            pace: 0.5,
            ..row((2, 2), (2, 2), &[(Timber, 8), (Stone, 8)], vec![shift(7, 16, 6)])
        }),
        (Colliery, Blueprint {
            shelves: &[(Coal, 120)],
            makes: Some(Coal),
            pace: 0.5,
            ..row((2, 2), (2, 2), &[(Timber, 8), (Stone, 8)], vec![shift(7, 16, 6)])
        }),
        // Sixteen hands, six to three, a unit of ore and one of coal to a
        // unit of steel: a mine's and a colliery's day a day. The works
        // that make a district and a morning rush.
        (Steelworks, Blueprint {
            shelves: &[(Ore, 40), (Coal, 40), (Steel, 40)],
            makes: Some(Steel),
            opens: &[(Ore, 1.0), (Coal, 1.0)],
            pace: 0.2,
            docks: 2,
            ..row((3, 2), (3, 2), &[(Timber, 12), (Stone, 16), (Cement, 24)], vec![shift(6, 15, 16)])
        }),
        // A nodding pump on oil ground: two hands, six to ten at night,
        // tending it, a pallet of drums every few hours.
        (OilWell, Blueprint {
            shelves: &[(Crude, 100)],
            makes: Some(Crude),
            pace: 1.0,
            ..row((2, 2), (2, 2), &[(Cement, 8), (Steel, 8), (Machinery, 2)], vec![shift(6, 22, 2)])
        }),
        // Eight hands, six to three, making fuel of crude a unit for a
        // unit, as fast as several wells pump it.
        (Refinery, Blueprint {
            shelves: &[(Crude, 100), (Good::Fuel, 100)],
            makes: Some(Good::Fuel),
            opens: &[(Crude, 1.0)],
            pace: 2.0,
            docks: 2,
            ..row((3, 2), (3, 2), &[(Cement, 24), (Steel, 16), (Machinery, 4)], vec![shift(6, 15, 8)])
        }),
        // The harbour grown: a crane on a deep quay, where a container
        // ship berths, its yard stacked with boxes. Six hands, round the
        // clock but the small hours.
        (Port, Blueprint {
            quay: true,
            forklifts: 4,
            ..row((3, 0), (3, 2), &[(Cement, 40), (Steel, 20), (Machinery, 6)], vec![shift(5, 23, 6)])
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
        // A harbour has a yard for the ferry's pallets.
        assert!(!b.quay || b.lot.1 > 0, "{kind:?} has a quay and nowhere to land a pallet");
        // Its lane runs down its middle from the gate to the ramp.
        assert!(!b.quay || b.size.0 % 2 == 1, "{kind:?} has a quay and no middle tile for its ramp");
        assert!(b.makes.is_none_or(|g| b.shelves.iter().any(|&(s, _)| s == g)), "{kind:?} makes what it has no shelf for");
        assert!(b.opens.iter().all(|&(g, _)| b.makes.is_some() && b.shelves.iter().any(|&(s, _)| s == g)), "{kind:?} opens what it has no shelf for, or makes nothing of it");
        assert!(b.makes.is_none() || b.farm || b.pace > 0.0, "{kind:?} makes at no pace");
        // Packages are whole: every shelf holds, and every site takes, so
        // many of them.
        for &(good, n) in b.shelves.iter().chain(b.materials) {
            assert_eq!(n as f64 % good.per_package(), 0.0, "{kind:?} keeps or takes {n} of {good:?}, not whole packages");
        }
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

/// Hours of the shift a kind's row posts.
pub fn shift_hours(kind: BuildingKind) -> f64 {
    blueprint(kind).taps.iter().find(|t| t.need == Need::Work).map_or(0.0, |t| t.curve.per_day() / H as f64)
}

/// The shelves a kind keeps, and their caps.
pub fn stocks(kind: BuildingKind) -> BTreeMap<Good, f64> {
    blueprint(kind).shelves.iter().map(|&(good, cap)| (good, cap as f64)).collect()
}

/// The goods a kind keeps a shelf of.
pub fn shelves(kind: BuildingKind) -> Vec<Good> {
    blueprint(kind).shelves.iter().map(|&(good, _)| good).collect()
}

/// Units of a good a kind could pass on in a day: what its taps could
/// serve with every slot busy, and a depot's shelf, turned once.
pub fn rated(kind: BuildingKind, good: Good) -> f64 {
    let bp = blueprint(kind);
    let over_the_counter: f64 = bp.taps.iter().filter(|t| t.need.good() == Some(good)).map(Tap::rated).sum();
    let opened: f64 = bp.opens.iter().filter(|&&(g, _)| g == good).map(|&(_, per)| per * bp.pace * bp.jobs as f64 * shift_hours(kind)).sum();
    over_the_counter + opened + if depot(kind) { stocks(kind).get(&good).copied().unwrap_or(0.0) } else { 0.0 }
}

/// Its land fills its shelf with this: it never calls for it. The only
/// seller a depot's lorry fetches from, so that a depot never fetches
/// from a depot, round and round for nothing.
pub fn makes(kind: BuildingKind, good: Good) -> bool {
    blueprint(kind).makes == Some(good)
}

/// Works land with a tractor. §12.8.
pub fn farm(kind: BuildingKind) -> bool {
    blueprint(kind).farm
}

/// What one tile of a farm's land grows in a cycle: the yard, a
/// harvest, over the tiles the farm has, so a harvest fills the yard
/// whatever ground the farm got. A farm on cramped ground has fewer
/// tiles and a longer wait between runs, not a smaller harvest.
pub fn crop(kind: BuildingKind, tiles: usize) -> f64 {
    blueprint(kind).makes.and_then(|g| stocks(kind).get(&g).copied()).unwrap_or(0.0) / tiles.max(1) as f64
}

/// Keeps shelves and runs vans: delivers its shelves, answering the calls
/// of stocks running low.
pub fn depot(kind: BuildingKind) -> bool {
    let bp = blueprint(kind);
    !bp.shelves.is_empty() && bp.vehicles.contains(&CarRole::Van)
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
