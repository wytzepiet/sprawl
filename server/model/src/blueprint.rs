//! Every kind of building, one row each: what it makes and from what, who
//! works it, what it runs, and from those, how big its lot is. A kind is a
//! name in the protocol and a row here; a new kind is a new row.
//!
//! A lot is never typed in. A row says what the building needs room for —
//! its own lorries, the lorries that come to fetch from it and wait their
//! turn, its workers' cars and its customers' — and `plot` works the lot
//! out from that: docks in a yard before it for the lorries, bays at the
//! kerb for the cars, the building as long as its bays need.

use std::sync::LazyLock;

use crate::{BuildingKind, CarRole, Good, GameTime};

/// What a kind must stand on or beside.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ground {
    /// Anywhere dry.
    Any,
    /// With its back to the water, its boat off the shore.
    Shore,
    /// With forest round it to fell.
    Forest,
    /// On the ochre ground that has clay under it.
    Clay,
    /// On the beach.
    Beach,
}

pub struct Blueprint {
    /// The building itself, in tiles, wide along its frontage.
    pub body: (u8, u8),
    /// What it makes, a crate every `every` ms at a full crew.
    pub makes: Option<Good>,
    pub every: GameTime,
    /// What a crate takes, of each good.
    pub takes: &'static [(Good, u32)],
    /// Workers it hires; it works slower for each seat empty.
    pub seats: u32,
    /// Its own lorries, which fetch what it takes (a shop's, what it sells).
    pub lorries: u8,
    /// Lorries from elsewhere that may wait in its yard to load.
    pub queue: u8,
    /// Families' cars that may stand at its kerb at once, shopping.
    pub customers: u8,
    /// Crates of what it makes its yard holds.
    pub yard: u32,
    pub ground: Ground,
    /// Forklifts working its pad.
    pub forklifts: u8,
    /// A farm: its tractor works the land round it (`map/fields.rs`).
    pub farm: bool,
    /// Loud: a house beside it won't grow.
    pub loud: bool,
}

impl Blueprint {
    /// Docks in its yard: one for each of its lorries, and one for each
    /// lorry that may wait to load.
    pub fn docks(&self) -> usize {
        self.lorries as usize + self.queue as usize
    }

    /// Bays at its kerb: its workers' cars and its customers'.
    pub fn bays(&self) -> usize {
        self.seats as usize + self.customers as usize
    }

    /// The vehicles it comes with.
    pub fn vehicles(&self) -> Vec<CarRole> {
        let mut v = vec![CarRole::Truck; self.lorries as usize];
        if self.farm {
            v.push(CarRole::Tractor);
        }
        v
    }
}

/// The row for a kind.
pub fn blueprint(kind: BuildingKind) -> &'static Blueprint {
    let (k, b) = &BLUEPRINTS[kind as usize];
    debug_assert_eq!(*k, kind, "blueprint table out of order");
    b
}

/// The kind that makes a good.
pub fn maker(good: Good) -> BuildingKind {
    BuildingKind::ALL.into_iter().find(|&k| blueprint(k).makes == Some(good)).expect("every good has a maker")
}

const SECOND: GameTime = 1_000;

static BLUEPRINTS: LazyLock<Vec<(BuildingKind, Blueprint)>> = LazyLock::new(|| {
    use BuildingKind::*;
    use Good::*;
    let maker = |body, makes, every, takes, lorries, ground| Blueprint {
        body,
        makes: Some(makes),
        every,
        takes,
        seats: 2,
        lorries,
        queue: 2,
        customers: 0,
        yard: 6,
        ground,
        forklifts: 1,
        farm: false,
        loud: false,
    };
    let rows = vec![
        (House, Blueprint { body: (1, 1), makes: None, every: 0, takes: &[], seats: 0, lorries: 0, queue: 0, customers: 0, yard: 0, ground: Ground::Any, forklifts: 1, farm: false, loud: false }),
        (Shop, Blueprint { body: (2, 1), makes: None, every: 0, takes: &[], seats: 0, lorries: 2, queue: 0, customers: 4, yard: 0, ground: Ground::Any, forklifts: 1, farm: false, loud: false }),
        (Fishery, maker((2, 1), Fish, 7 * SECOND, &[], 0, Ground::Shore)),
        (Woodcutter, maker((1, 1), Logs, 8 * SECOND, &[], 0, Ground::Forest)),
        (Sawmill, Blueprint { loud: true, ..maker((2, 2), Planks, 7 * SECOND, &[(Logs, 1)], 1, Ground::Any) }),
        (Farm, Blueprint { farm: true, ..maker((2, 1), Wheat, 9 * SECOND, &[], 0, Ground::Any) }),
        (Bakery, maker((2, 1), Bread, 8 * SECOND, &[(Wheat, 1)], 1, Ground::Any)),
        (ClayPit, maker((1, 1), Clay, 9 * SECOND, &[], 0, Ground::Clay)),
        (Brickworks, Blueprint { loud: true, ..maker((2, 2), Bricks, 9 * SECOND, &[(Clay, 1), (Logs, 1)], 1, Ground::Any) }),
        (Workshop, Blueprint { loud: true, ..maker((2, 1), Furniture, 11 * SECOND, &[(Planks, 2)], 1, Ground::Any) }),
        (SandPit, maker((1, 1), Sand, 9 * SECOND, &[], 0, Ground::Beach)),
        (Glassworks, Blueprint { loud: true, ..maker((2, 2), Glass, 10 * SECOND, &[(Sand, 1), (Logs, 1)], 1, Ground::Any) }),
        (SheepFarm, maker((2, 1), Wool, 10 * SECOND, &[], 0, Ground::Any)),
        (Tailor, maker((2, 1), Clothes, 9 * SECOND, &[(Wool, 1)], 1, Ground::Any)),
    ];
    for (i, (k, _)) in rows.iter().enumerate() {
        assert_eq!(*k as usize, i, "blueprint table out of order at {k:?}");
    }
    rows
});

/// What a kind keeps of each good, and room for how much: what it makes
/// in its yard, and a few of each it takes. A shop's shelves are the
/// town's to set, by what its families want.
pub fn shelves(kind: BuildingKind) -> Vec<(Good, f64)> {
    let b = blueprint(kind);
    b.makes.map(|g| (g, b.yard as f64)).into_iter().chain(b.takes.iter().map(|&(g, n)| (g, (4 * n) as f64))).collect()
}

/// A crate's worth of goods in a crate. Everything moves in whole crates.
pub const CRATE: f64 = 1.0;

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

/// How many tiles of frontage hold `n` square kerb bays, a bay's width
/// apart within a fifth of a tile of each end (`SQUARE_PITCH`,
/// `WALL_INSET` in `map/lots.rs`).
pub fn frontage(n: usize) -> u8 {
    if n == 0 {
        return 0;
    }
    ((n - 1) as f64 * 0.27 + 0.4 + 0.25).ceil() as u8
}

/// A yard's size, wide along the street and deep, for so many docks: a
/// lane in from a gate in the middle, and docks either side of it a lorry
/// backs into. None for none.
pub fn yard(docks: usize) -> (u8, u8) {
    match docks {
        0 => (0, 0),
        1..=2 => (3, 2),
        3..=4 => (4, 2),
        _ => (5, 2),
    }
}

/// A kind's size and lot, worked out from what it needs room for.
pub fn lot(kind: BuildingKind) -> ((u8, u8), (u8, u8)) {
    let b = blueprint(kind);
    let (yw, yd) = yard(b.docks());
    let w = b.body.0.max(yw).max(frontage(b.bays()));
    ((w, b.body.1), (if yd > 0 { w } else { 0 }, yd))
}

pub fn plot(kind: BuildingKind, facing: u8) -> Plot {
    let ((w, bh), (_, ld)) = lot(kind);
    let size = if facing % 2 == 0 { (w, bh + ld) } else { (bh + ld, w) };
    lie(kind, facing, size)
}

/// How a building `size` across lies facing this way: its yard, if its
/// kind keeps one, the rows on its street side as deep as the kind's, the
/// whole width; the rest the building.
pub fn lie(kind: BuildingKind, facing: u8, (w, h): (u8, u8)) -> Plot {
    let d = lot(kind).1 .1;
    let lot = d > 0;
    match facing % 4 {
        2 => Plot { size: (w, h), building: ((0, 0), (w, h - d)), lot: lot.then_some(((0, h - d), (w, d))) },
        0 => Plot { size: (w, h), building: ((0, d), (w, h - d)), lot: lot.then_some(((0, 0), (w, d))) },
        1 => Plot { size: (w, h), building: ((0, 0), (w - d, h)), lot: lot.then_some(((w - d, 0), (d, h))) },
        _ => Plot { size: (w, h), building: ((d, 0), (w - d, h)), lot: lot.then_some(((0, 0), (d, h))) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_good_has_one_maker() {
        for g in Good::ALL {
            assert_eq!(BuildingKind::ALL.iter().filter(|&&k| blueprint(k).makes == Some(g)).count(), 1, "{g:?}");
        }
    }

    /// A maker's yard holds its lorries and those that come to it; a shop
    /// fronts the street with bays for its customers.
    #[test]
    fn lots_follow_what_they_hold() {
        assert_eq!(lot(BuildingKind::Fishery), ((3, 1), (3, 2)));
        assert_eq!(lot(BuildingKind::Sawmill), ((4, 2), (4, 2)));
        assert_eq!(lot(BuildingKind::House), ((1, 1), (0, 0)));
        let ((w, _), (yw, yd)) = lot(BuildingKind::Shop);
        assert!(w >= 2 && yw == w && yd == 2, "a shop's lorry has a dock: {:?}", lot(BuildingKind::Shop));
    }
}
