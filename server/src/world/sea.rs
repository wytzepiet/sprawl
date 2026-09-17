//! A port's quay, and its ship's voyages over the water. docs/economy.md
//! §12.10.
//!
//! The sea is the water joined to the map's edge, charted once from the
//! terrain; water that is not is a lake, and no port stands on it. A port
//! stands with its back to the sea: the tile behind its building's back
//! face is the quay, where the ship stands when it is home. A voyage is a
//! run off the roads, as a tractor's is (`world/fields.rs`): the shortest
//! way over the sea from the quay toward the map's edge, a tile every
//! pace, as far as the fog, which is the horizon, or the map's edge where
//! the survey reaches it. There the ship sails out of sight, is away the
//! sailing, and sails back in the way it went; home, it is a lorry back
//! from beyond the edge (`calls::car_idle`), and lands every shelf's worth
//! at the sea's crossing.

use std::collections::{HashMap, HashSet, VecDeque};

use crate::blueprint::{plot, FACINGS};
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::protocol::{BuildingKind, EntityId, GameObject, GridCoord, Job, Pose, Run, TerrainType, DAY_MS};
use crate::world::World;

/// How long a ship takes to cross a tile: 1.2 seconds of the clock, a
/// ship at twenty knots on twelve-metre tiles, a little under a car.
pub const PACE: GameTime = DAY_MS as GameTime / 1000;
/// How long a ship is beyond the horizon: four hours, twice a lorry's
/// absence beyond the edge.
pub const SAILING: GameTime = DAY_MS as GameTime / 6;

/// The four ways off a tile.
const AROUND: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

impl World {
    /// The sea: every water tile joined to the map's edge, flooded from
    /// the edge inward. Charted the first time anything asks.
    pub fn sea(&self) -> &HashSet<(i32, i32)> {
        self.sea.get_or_init(|| {
            let water = |t: (i32, i32)| self.terrain.get(&t) == Some(&TerrainType::Water);
            let off = |t: (i32, i32)| !self.terrain.contains_key(&t);
            let mut sea: HashSet<(i32, i32)> = self.terrain.keys().copied().filter(|&t| water(t) && AROUND.iter().any(|d| off((t.0 + d.0, t.1 + d.1)))).collect();
            let mut queue: VecDeque<(i32, i32)> = sea.iter().copied().collect();
            while let Some(t) = queue.pop_front() {
                for d in AROUND {
                    let n = (t.0 + d.0, t.1 + d.1);
                    if water(n) && sea.insert(n) {
                        queue.push_back(n);
                    }
                }
            }
            sea
        })
    }

    /// The quay a kind's plot would have here this way round: a tile of
    /// the sea behind its building's back face, the middle one first. None
    /// where the back is on land, or on a lake.
    pub fn quay_at(&self, pos: GridCoord, kind: BuildingKind, facing: u8) -> Option<GridCoord> {
        let ((bx, by), (bw, bh)) = plot(kind, facing).building;
        let (dx, dy) = FACINGS[facing as usize % 4];
        let building = GridCoord { x: pos.x + bx as i32, y: pos.y + by as i32 };
        // The back face is the row of the building furthest from the lot,
        // and the quay is one step further out from it.
        let mut back: Vec<GridCoord> = if dx == 0 {
            let y = if dy < 0 { building.y + bh as i32 } else { building.y - 1 };
            (0..bw as i32).map(|i| GridCoord { x: building.x + i, y }).collect()
        } else {
            let x = if dx < 0 { building.x + bh as i32 } else { building.x - 1 };
            (0..bw as i32).map(|i| GridCoord { x, y: building.y + i }).collect()
        };
        let mid = back[back.len() / 2];
        back.sort_by_key(|t| ((t.x - mid.x).abs() + (t.y - mid.y).abs(), t.x, t.y));
        back.into_iter().find(|t| self.sea().contains(&(t.x, t.y)))
    }

    /// A standing port's quay.
    pub fn quay(&self, port: EntityId) -> Option<GridCoord> {
        let e = self.objects.get(port)?;
        let GameObject::Building(ref b) = e.object else { return None };
        self.quay_at(e.position?, b.kind, b.facing)
    }

    /// The ship stands at its port's quay, nose along the coast.
    pub fn moor(&mut self, ship: EntityId) {
        let owner = match self.objects.get(ship).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.owner,
            _ => return,
        };
        let Some(quay) = self.quay(owner) else { return };
        let facing = match self.objects.get(owner).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.facing,
            _ => return,
        };
        let (dx, dy) = FACINGS[facing as usize % 4];
        self.update_position(ship, quay);
        if let Some(GameObject::Car(c)) = self.objects.get_mut(ship).map(|e| &mut e.object) {
            c.run = None;
            c.spot = Some(Pose { at: [quay.x as f64 + 0.5, quay.y as f64 + 0.5], heading: (dy as f64).atan2(dx as f64) + std::f64::consts::FRAC_PI_2 });
        }
    }

    /// The way from the quay to the horizon: the shortest over the sea to
    /// the map's edge, cut where it enters the fog, since a ship out of
    /// the survey is out of sight either way. None from a quay that is
    /// not on the sea.
    fn horizon(&self, quay: GridCoord) -> Option<Vec<GridCoord>> {
        let sea = self.sea();
        let off = |t: GridCoord| AROUND.iter().any(|d| !self.terrain.contains_key(&(t.x + d.0, t.y + d.1)));
        let mut came: HashMap<(i32, i32), (i32, i32)> = HashMap::from([((quay.x, quay.y), (quay.x, quay.y))]);
        let mut queue = VecDeque::from([quay]);
        let mut edge = None;
        while let Some(t) = queue.pop_front() {
            if off(t) {
                edge = Some(t);
                break;
            }
            for (dx, dy) in AROUND {
                let n = GridCoord { x: t.x + dx, y: t.y + dy };
                if sea.contains(&(n.x, n.y)) && !came.contains_key(&(n.x, n.y)) {
                    came.insert((n.x, n.y), (t.x, t.y));
                    queue.push_back(n);
                }
            }
        }
        let mut path = vec![edge?];
        while path.last().unwrap() != &quay {
            let at = came[&(path.last().unwrap().x, path.last().unwrap().y)];
            path.push(GridCoord { x: at.0, y: at.1 });
        }
        path.reverse();
        if let Some(fog) = path.iter().position(|t| !self.revealed.contains(&crate::world::chunk_of(*t))) {
            path.truncate(fog + 1);
        }
        Some(path)
    }

    /// The ship sets out from the quay for the horizon. False from a
    /// port with no way to the sea.
    pub fn set_sail(&mut self, events: &mut EventQueue, ship: EntityId, now: GameTime) -> bool {
        let owner = match self.objects.get(ship).map(|e| &e.object) {
            Some(GameObject::Car(c)) if c.run.is_none() && c.trip.is_none() => c.owner,
            _ => return false,
        };
        let Some(path) = self.quay(owner).and_then(|q| self.horizon(q)) else { return false };
        self.update_position(ship, path[0]);
        if let Some(GameObject::Car(c)) = self.objects.get_mut(ship).map(|e| &mut e.object) {
            c.spot = None;
            c.run = Some(Run { job: Job::Sail, path, started: now, pace: PACE });
        }
        events.wake(PACE, ship);
        true
    }

    /// Back over the horizon, the way it went, home to the quay. False
    /// where the port is gone.
    pub fn sail_home(&mut self, events: &mut EventQueue, ship: EntityId, now: GameTime) -> bool {
        let owner = match self.objects.get(ship).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.owner,
            _ => return false,
        };
        let Some(mut path) = self.quay(owner).and_then(|q| self.horizon(q)) else { return false };
        path.reverse();
        self.update_position(ship, path[0]);
        if let Some(GameObject::Car(c)) = self.objects.get_mut(ship).map(|e| &mut e.object) {
            c.away = 0;
            c.run = Some(Run { job: Job::Sail, path, started: now, pace: PACE });
        }
        events.wake(PACE, ship);
        true
    }

    /// The ship reaches the tile of its voyage the clock names. At the
    /// horizon it sails out of sight for the sailing; at the quay it is
    /// home, and thinks as a lorry home from beyond the edge does.
    pub fn ship_step(&mut self, events: &mut EventQueue, ship: EntityId, now: GameTime) {
        let Some(GameObject::Car(c)) = self.objects.get(ship).map(|e| &e.object) else { return };
        let (owner, Some(run)) = (c.owner, c.run.clone()) else { return };
        let k = ((now - run.started) / run.pace) as usize;
        let Some(&here) = run.path.get(k) else { return };
        self.update_position(ship, here);
        if k + 1 < run.path.len() {
            events.wake(PACE, ship);
            return;
        }
        // The voyage burns what it burns, a tile at a time, like any drive.
        crate::resident::drove(self, ship, run.path.len() as f64);
        if Some(here) == self.quay(owner) {
            self.moor(ship);
            events.wake(0, ship);
        } else {
            self.leave_map(ship, now + SAILING);
            if let Some(GameObject::Car(c)) = self.objects.get_mut(ship).map(|e| &mut e.object) {
                c.run = None;
            }
            events.wake(SAILING, ship);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::TerrainType;

    /// Grass either side of a street along y = 0, and the sea from y = 5
    /// south of it; the map ends at y = 41, a chunk and more out, and
    /// further than that to the sides.
    fn coast() -> World {
        let mut world = World::new();
        for y in -8..41 {
            for x in -60..100 {
                world.terrain.insert((x, y), if y >= 5 { TerrainType::Water } else { TerrainType::Grass });
            }
        }
        world.place_road_path(&(-4..40).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>());
        world
    }

    #[test]
    fn a_port_stands_with_its_back_to_the_water() {
        let mut world = coast();
        // North of the street the back is on grass: no way round fits.
        assert!(world.place_on_street(GridCoord { x: 10, y: -1 }, BuildingKind::Port).is_none());
        let port = world.place_on_street(GridCoord { x: 10, y: 1 }, BuildingKind::Port).expect("the coast takes a port");
        let quay = world.quay(port).unwrap();
        assert_eq!(quay.y, 5, "the quay is the water behind the back face: {quay:?}");
        assert_eq!(world.terrain[&(quay.x, quay.y)], TerrainType::Water);
        // The horizon is where the map ends, the survey reaching it: the
        // last tile of water.
        let path = world.horizon(quay).expect("a way to the sea");
        assert_eq!((path[0], path.last().unwrap().y), (quay, 40));
        assert!(path.windows(2).all(|w| (w[0].x - w[1].x).abs() + (w[0].y - w[1].y).abs() == 1));
        assert!(path.iter().all(|t| world.terrain[&(t.x, t.y)] == TerrainType::Water), "the ship sailed over land");
        // Or the fog, where the survey stops short of it: the first tile
        // of the chunk nobody has surveyed.
        world.revealed.retain(|c| c.cy < 1);
        let path = world.horizon(quay).unwrap();
        assert_eq!(path.last().unwrap().y, crate::protocol::CHUNK_SIZE, "the ship did not stop at the fog: {path:?}");
    }

    #[test]
    fn a_lake_takes_no_port() {
        let mut world = coast();
        // Grass all round the water: a lake, not the sea.
        for y in 38..41 {
            for x in -60..100 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        for y in -8..41 {
            for x in [-60, 99] {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        assert!(world.sea().is_empty(), "a lake was charted as the sea");
        assert!(world.place_on_street(GridCoord { x: 10, y: 1 }, BuildingKind::Port).is_none(), "a port stood on a lake");
    }
}

#[cfg(test)]
mod look {
    use super::*;
    use crate::protocol::TerrainType;

    /// Not an assertion: for SPRAWL_SEED, or seeds 1 to 20, where the
    /// starting town is and how far its nearest sea is, for whoever wants
    /// to watch a port. Seed 7's town is on a lake.
    #[test]
    #[ignore]
    fn where_the_sea_is() {
        let seeds: Vec<u32> = match std::env::var("SPRAWL_SEED").ok().and_then(|s| s.parse().ok()) {
            Some(s) => vec![s],
            None => (1..=20).collect(),
        };
        for seed in seeds {
            let mut world = World::new();
            world.terrain = crate::terrain::generate(seed);
            let terrain = world.terrain.clone();
            let Some(anchor) = crate::road_gen::generate(&mut world, seed, &terrain) else {
                eprintln!("seed {seed}: no town");
                continue;
            };
            let far = |&(x, y): &(i32, i32)| (x - anchor.x).abs().max((y - anchor.y).abs());
            match world.sea().iter().min_by_key(|t| (far(t), t.0, t.1)) {
                Some(t) => eprintln!("seed {seed}: town at {:?}, the sea {} tiles off at {t:?}, {} water tiles of which {} sea", anchor, far(t), terrain.values().filter(|&&v| v == TerrainType::Water).count(), world.sea().len()),
                None => eprintln!("seed {seed}: town at {:?}, no sea on the map", anchor),
            }
        }
    }
}
