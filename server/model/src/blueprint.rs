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
    /// Docks at its front: one for each of its own lorries, which rest in
    /// them, and one for each lorry come to load that may wait its turn.
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
        (Shop, Blueprint { body: (2, 1), makes: None, every: 0, takes: &[], seats: 0, lorries: 2, queue: 0, customers: 3, yard: 0, ground: Ground::Any, forklifts: 1, farm: false, loud: false }),
        (Fishery, maker((2, 1), Fish, 7 * SECOND, &[], 0, Ground::Shore)),
        (Woodcutter, maker((1, 1), Logs, 8 * SECOND, &[], 0, Ground::Forest)),
        (Sawmill, Blueprint { loud: true, ..maker((2, 2), Planks, 7 * SECOND, &[(Logs, 1)], 1, Ground::Any) }),
        (Farm, Blueprint { farm: true, ..maker((2, 1), Wheat, 9 * SECOND, &[], 0, Ground::Any) }),
        (Bakery, maker((2, 1), Bread, 8 * SECOND, &[(Wheat, 1)], 1, Ground::Any)),
        (ClayPit, maker((1, 1), Clay, 9 * SECOND, &[], 0, Ground::Clay)),
        (Brickworks, Blueprint { loud: true, ..maker((2, 2), Bricks, 9 * SECOND, &[(Clay, 1), (Logs, 1)], 1, Ground::Any) }),
        (Workshop, Blueprint { loud: true, ..maker((2, 2), Furniture, 11 * SECOND, &[(Planks, 2)], 1, Ground::Any) }),
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

/// How many tiles of frontage a building needs before its street: its
/// docks side by side at its gate, the middle tile of its front, or the
/// second of two; a truck backed into each, room either side of them for
/// a truck to swing its nose round as it backs in; and its square kerb
/// bays out from them either way, a bay's width apart, within a fifth of
/// a tile of each end (`DOCK_PITCH`, `DOCK_CLEAR`, `SQUARE_PITCH`,
/// `WALL_INSET` in `map/lots.rs`).
pub fn frontage(bays: usize, docks: usize) -> u8 {
    if bays + docks == 0 {
        return 0;
    }
    let fit = |room: f64| if room < -1e-9 { 0 } else { (room / 0.27 + 1e-9).floor() as usize + 1 };
    (1..=8u8)
        .find(|&w| {
            let g = (w / 2) as f64 + 0.5;
            let d0 = if docks > 0 { (docks - 1) as f64 * 0.15 + 0.4 } else { -0.135 };
            let docked = docks == 0 || g + (docks as f64) * 0.15 <= w as f64;
            docked && fit(g - d0 - 0.2) + fit(w as f64 - 0.2 - g - d0) >= bays
        })
        .unwrap_or(8)
}

/// Whether a kind has a front: a gate in the middle of the side toward
/// its street, its docks before it, a truck backed into each to its
/// loading door.
pub fn fronted(kind: BuildingKind) -> bool {
    blueprint(kind).docks() > 0
}

/// A kind's size, wide along its street and deep: the building, as wide
/// as its frontage needs.
pub fn size(kind: BuildingKind) -> (u8, u8) {
    let b = blueprint(kind);
    (b.body.0.max(frontage(b.bays(), b.docks())), b.body.1)
}

/// A kind's size on the grid, facing this way.
pub fn plot(kind: BuildingKind, facing: u8) -> (u8, u8) {
    let (w, h) = size(kind);
    if facing % 2 == 0 { (w, h) } else { (h, w) }
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

    /// A maker fronts its street with its docks and its staff's bays; a
    /// shop with its customers' too.
    #[test]
    fn sizes_follow_what_they_front() {
        assert_eq!(size(BuildingKind::Fishery), (2, 1));
        assert_eq!(size(BuildingKind::Woodcutter), (2, 1));
        assert_eq!(size(BuildingKind::Sawmill), (2, 2));
        assert_eq!(size(BuildingKind::House), (1, 1));
        assert_eq!(size(BuildingKind::Shop), (2, 1));
    }
}
