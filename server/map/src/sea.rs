//! The harbour and the ferry: the door everything comes in and goes out
//! by (docs/shipping.md §Harbours, docs/plan-goods.md §The harbour).
//!
//! A harbour stands half on the water, with its back to the sea: the
//! middle of its back row is over the sea, its quay built out on it, and
//! the tile of sea behind that is the berth's; the ferry berths there with
//! its ramp on the quay edge, lying straight out to sea, so a harbour
//! needs `BERTH` tiles of sea in a line behind it. Down its middle a lane
//! runs from the gate to the ramp; on one side of it are the docks
//! lorries back into (`lots.rs`), on the other the quay's pad, the
//! packages standing on it (`Building::pad`).
//!
//! The ferry is the world's, one to a harbour, on a timetable: it leaves
//! the world with what was booked for it and the settlers waiting to come,
//! sails in from the map's edge along its line's way (`traffic::sea`),
//! berths for `DWELL`, and casts off on time with whatever the forklifts
//! got aboard, back out over the edge. Its deck carries pallets, a few to
//! a bay, and settlers' cars in the bays with none. The harbour's
//! forklifts lift the pallets off onto the quay while it has room, and
//! what waits on the quay to go out onto the deck while it has room, each
//! only if it is done before the ferry sails (`Map::lift`). The world
//! pays for what went out as it casts off; the town pays for what came in
//! as each package lands on the quay. It is double-ended, as small island
//! ferries are: it never turns, it sails in one end first and out the
//! other.

use model::blueprint::FACINGS;
use model::{BuildingKind, EntityId, GameObject, GridCoord, Pose};
use land::TerrainType;
use crate::Map;
/// The ferry, in tiles: long and broad, bigger than true to the map, as
/// `FERRY` in the client's `dressing.ts`.
pub const FERRY_LENGTH: f64 = 3.2;
/// The deck: three lanes of five bays, the land end first. A bay holds
/// four pallets, two by two, or two settlers' cars.
pub const LANES: usize = 3;
pub const ROWS: usize = 5;
pub const BAYS: usize = LANES * ROWS;
pub const PER_BAY: usize = 4;
pub const DECK: usize = BAYS * PER_BAY;
/// Packages the quay's pad holds: what the ferry lands waits there for
/// the town's lorries, and what they bring for the ferry.
pub const QUAY: usize = 48;
const LANE_GAP: f64 = 0.27;
const ROW_FIRST: f64 = 0.45;
const ROW_GAP: f64 = 0.6;

fn ahead(heading: f64, d: f64) -> [f64; 2] {
    [heading.cos() * d, heading.sin() * d]
}

fn plus(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [a[0] + b[0], a[1] + b[1]]
}

/// The middle of deck bay `k` of a ferry standing at `ship`: across its
/// lanes and along its rows from the end its heading points to, the land
/// end at the berth, facing it.
pub fn deck_pose(ship: Pose, k: usize) -> Pose {
    let (lane, row) = (k % LANES, k / LANES);
    let end = plus(ship.at, ahead(ship.heading, FERRY_LENGTH / 2.0));
    let along = plus(end, ahead(ship.heading, -(ROW_FIRST + row as f64 * ROW_GAP)));
    let across = ahead(ship.heading + std::f64::consts::FRAC_PI_2, (lane as f64 - 1.0) * LANE_GAP);
    Pose { at: plus(along, across), heading: ship.heading }
}

/// Tiles of sea in a line behind a harbour: the ferry's length at the
/// berth, and room to come straight in.
pub const BERTH: i32 = 6;

/// The berth of a harbour: its quay tile and the way out to sea from it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Berth {
    pub quay: GridCoord,
    pub out: (i32, i32),
}

impl Berth {
    pub fn tile(&self, n: i32) -> GridCoord {
        GridCoord { x: self.quay.x + self.out.0 * n, y: self.quay.y + self.out.1 * n }
    }
    /// The middle of the quay's edge, where the ramp comes down.
    pub fn ramp(&self) -> [f64; 2] {
        [self.quay.x as f64 + 0.5 - self.out.0 as f64 * 0.5, self.quay.y as f64 + 0.5 - self.out.1 as f64 * 0.5]
    }
    /// Toward the land, from the sea.
    pub fn landward(&self) -> f64 {
        (-self.out.1 as f64).atan2(-self.out.0 as f64)
    }
    /// The ferry at the berth: its land end on the ramp, facing the land.
    pub fn moored(&self) -> Pose {
        let d = FERRY_LENGTH / 2.0;
        Pose { at: [self.ramp()[0] + self.out.0 as f64 * d, self.ramp()[1] + self.out.1 as f64 * d], heading: self.landward() }
    }
}


/// Where a settler's car stands in deck bay `k`, two to a bay, one
/// either side of its middle along it, facing the land (`aboard` in the
/// client's `motion.ts`).
pub fn seats(ship: Pose, k: usize) -> [Pose; 2] {
    let p = deck_pose(ship, k);
    [-0.15, 0.15].map(|d| Pose { at: plus(p.at, ahead(p.heading, d)), heading: p.heading })
}

impl Berth {
    /// The harbour's yard as it is laid (`lots::park`), in from the ramp:
    /// the lane from the gate down to the ramp, and the docks on the
    /// terminal's side of it; the quay's pad is on the other. Nothing
    /// stands in the lane: what comes off the ferry drives up it to the
    /// gate.
    pub fn park(&self) -> (Vec<[f64; 2]>, Vec<(Pose, usize, [f64; 2])>) {
        let side = self.landward() + std::f64::consts::FRAC_PI_2;
        crate::lots::park(|s, out| plus(plus(self.ramp(), ahead(self.landward(), s)), ahead(side, out)), &[1.0])
    }
}

impl Map {
    /// The berth a kind's plot would have here this way round: the tile of
    /// the sea behind the middle of its back, in line with its lane, with
    /// `BERTH` tiles of sea straight out from it, and the middle of its
    /// back row on the sea too, the quay built out over it. None where
    /// that is land, a lake, or water too narrow for the ferry.
    pub fn berth_at(&self, tiles: &[GridCoord], kind: BuildingKind, facing: u8) -> Option<Berth> {
        let (dx, dy) = FACINGS[facing as usize % 4];
        let gate = Map::gate_of(tiles, kind, facing)?;
        // Straight back from the gate, through the plot, to the water.
        let (_, (w, h)) = Map::bounds(tiles);
        let deep = if dx == 0 { h } else { w } as i32;
        let b = Berth { quay: GridCoord { x: gate.x - dx * deep, y: gate.y - dy * deep }, out: (-dx, -dy) };
        (-1..BERTH).all(|n| self.terrain.get(&(b.tile(n).x, b.tile(n).y)) == Some(&TerrainType::Sea)).then_some(b)
    }

    /// A standing harbour's berth.
    pub fn berth(&self, harbour: EntityId) -> Option<Berth> {
        let GameObject::Building(ref b) = self.objects.get(harbour)?.object else { return None };
        self.berth_at(&b.tiles, b.kind, b.facing)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use land::TerrainType;

    /// Grass either side of a street along y = 0, and the sea from y = 3
    /// south of it; the map ends at y = 41, a chunk and more out, and
    /// further than that to the sides.
    fn coast() -> Map {
        let mut world = Map::new();
        for y in -8..41 {
            for x in -60..100 {
                world.terrain.insert((x, y), if y >= 2 { TerrainType::Sea } else { TerrainType::Grass });
            }
        }
        world.place_road_path(&(-4..40).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>());
        world
    }

    #[test]
    fn a_harbour_stands_with_its_back_to_the_sea() {
        let mut world = coast();
        // North of the street the back is on grass: no way round fits.
        assert!(world.place_on_street(GridCoord { x: 10, y: -1 }, BuildingKind::Harbour).is_none());
        let harbour = world.place_on_street(GridCoord { x: 10, y: 1 }, BuildingKind::Harbour).expect("the coast takes a harbour");
        let berth = world.berth(harbour).unwrap();
        assert_eq!((berth.quay.y, berth.out), (3, (0, 1)), "the quay is the water behind the back face: {berth:?}");
        // Moored, its land end is on the ramp.
        let m = berth.moored();
        let end = plus(m.at, ahead(m.heading, FERRY_LENGTH / 2.0));
        assert!((end[0] - berth.ramp()[0]).abs() < 1e-9 && (end[1] - berth.ramp()[1]).abs() < 1e-9);
    }

    /// Its lane is clear and half its yard is the quay's: four docks
    /// stand on one side of the lane from the gate to the ramp, each
    /// lorry's cab wholly on the harbour and out of the lane, and the
    /// other side is left to the pad.
    #[test]
    fn the_docks_keep_the_lane_and_the_pad_clear() {
        let mut world = coast();
        let harbour = world.place_on_street(GridCoord { x: 10, y: 1 }, BuildingKind::Harbour).unwrap();
        let berth = world.berth(harbour).unwrap();
        let gate = world.door_of(harbour).unwrap().0;
        assert_eq!((gate.x, berth.quay.x), (11, 11), "the gate and the ramp are not in line");
        let docks: Vec<Pose> = world.lot_mut(harbour).unwrap().spots.iter().map(|s| s.pose).collect();
        assert_eq!(docks.len(), 4);
        let lane = berth.ramp()[0];
        let side = (docks[0].at[0] - lane).signum();
        for p in &docks {
            let [x, y] = p.at;
            assert!((10.0..=13.0).contains(&x) && (1.0..=3.0).contains(&y), "a dock off the harbour at {:?}", p.at);
            assert!((x - lane).abs() >= 0.5, "a dock in the lane at {:?}", p.at);
            assert_eq!((x - lane).signum(), side, "docks either side of the lane");
        }
    }

    /// On a coast running on the diagonal, the shore crosses the plot:
    /// its gate on the land, its quay out over the sea.
    #[test]
    fn a_harbour_fits_a_diagonal_coast() {
        let mut world = Map::new();
        for y in -10..40 {
            for x in -10..40 {
                world.terrain.insert((x, y), if x + y >= 14 { TerrainType::Sea } else { TerrainType::Grass });
            }
        }
        let tiles = world.fit(BuildingKind::Harbour, GridCoord { x: 10, y: 4 }, 0).expect("the diagonal coast takes a harbour");
        let wet = tiles.iter().filter(|t| world.terrain[&(t.x, t.y)] == TerrainType::Sea).count();
        assert_eq!(wet, 3, "it stands half on the water: {tiles:?}");
    }

    #[test]
    fn a_lake_takes_no_harbour() {
        let mut world = coast();
        for t in world.terrain.values_mut() {
            if *t == TerrainType::Sea {
                *t = TerrainType::Water;
            }
        }
        assert!(world.place_on_street(GridCoord { x: 10, y: 1 }, BuildingKind::Harbour).is_none(), "a harbour stood on a lake");
    }

    /// Every deck bay is on the hull, and no two overlap.
    #[test]
    fn the_deck_holds_its_bays_on_the_hull() {
        let ship = Pose { at: [0.0, 0.0], heading: 0.0 };
        for k in 0..BAYS {
            let p = deck_pose(ship, k);
            assert!(p.at[0].abs() + 0.23 <= FERRY_LENGTH / 2.0, "bay {k} hangs off the end: {:?}", p.at);
            assert!(p.at[1].abs() <= 0.4, "bay {k} hangs off the side");
            for j in 0..k {
                let q = deck_pose(ship, j);
                assert!((p.at[0] - q.at[0]).abs() >= 0.46 || (p.at[1] - q.at[1]).abs() >= 0.17, "bays {j} and {k} overlap");
            }
        }
    }
}

