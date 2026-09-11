//! A farm's land, and the tractor's runs over it. docs/economy.md §12.8.
//!
//! When a street reaches a farm it claims the connected grass behind and
//! beside its plot, bounded by roads, water, forest, beach and anything
//! built: any shape the land allows. The land is what the first shift
//! ploughs: the plough run sweeps the grass nearest the yard first, rows
//! along the ground's long axis driven back and forth, and stops where the
//! shift ends; what it ploughed is the farm, the rest is grass again. Each
//! tile is then at a stage of one cycle — ploughed, sown, cut — and the
//! tractor drives the whole field in one run a day, doing the job to each
//! tile as it arrives: seeding starts the crop, harvesting lands a tile's
//! crop in the yard, ploughing turns the stubble. Off the roads entirely:
//! a run is a list of tiles and a pace, no route, no claims, no queue. A
//! tile the mayor builds or roads over is dropped at the farm's next look,
//! and the tractor's last path stays on the ground as its tyre marks.

use std::collections::{HashSet, VecDeque};

use crate::blueprint::plot;
use crate::economy;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::protocol::{CarRole, EntityId, GameObject, GridCoord, Job, Run, Stage, Tile, DAY_MS};
use crate::world::World;

/// How long the tractor takes to cross a tile, working it: two and a
/// half minutes of the game's clock, two seconds watched at full speed,
/// so a shift's ploughing is a couple of hundred tiles.
pub const PACE: GameTime = DAY_MS as GameTime / 600;
/// Days in the cycle: a plough day, a seed day, a harvest day. The yard
/// holds a harvest, which is this many days of the row's make.
pub const CYCLE: u32 = 3;
/// A crop sown by the end of a shift is ripe by the next morning.
pub const RIPEN: GameTime = DAY_MS as GameTime / 2;
/// The tiles a shift's ploughing makes a farm of, on open ground: the
/// shift over the pace, less the ground driven between rows. What a
/// farm's land comes to at capacity, and what its yard is divided by.
pub fn capacity(kind: crate::protocol::BuildingKind) -> f64 {
    (economy::shift_hours(kind) * economy::HOUR / PACE as f64 * 0.9).round()
}

/// The eight ways off a tile: straight first, then the diagonals.
const AROUND: [(i32, i32); 8] = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)];

impl World {
    /// Open grass with nothing on it: what a farm claims, and what a tile
    /// of its land stays while it is one.
    fn is_open(&self, t: GridCoord) -> bool {
        self.is_buildable(t) && self.terrain.get(&(t.x, t.y)) == Some(&crate::protocol::TerrainType::Grass)
    }

    /// A farm reached by a street claims its land: of the grass connected
    /// to its plot on every side but the street's, the nearest tiles by
    /// the chessboard's measure, as much as a shift can plough, so a
    /// square block round the farm that a sweep works in long rows — and
    /// never more than a few tiles further by the walk than as the crow
    /// flies, so the land does not wrap round the end of a road. Bounded
    /// by whatever is not open grass, so a road, a wood or a beach is the
    /// edge of the farm, and a farm on cramped ground is a smaller farm.
    /// The first shift's ploughing makes it a field.
    pub fn claim_land(&mut self, farm: EntityId) {
        let Some(e) = self.objects.get(farm) else { return };
        let (Some(pos), GameObject::Building(b)) = (e.position, &e.object) else { return };
        let (kind, facing) = (b.kind, b.facing);
        let wanted = capacity(kind) as usize;
        if !economy::farm(kind) || !b.land.is_empty() {
            return;
        }
        let p = plot(kind, facing);
        let (fx, fy) = crate::blueprint::FACINGS[facing as usize % 4];
        let (w, h) = (p.size.0 as i32, p.size.1 as i32);
        // The tiles round the plot, less the street side.
        // How far a tile is from the plot as the crow flies: by the
        // chessboard's measure, which grows a square, and by the taxicab's,
        // which is the least any walk can be.
        let off = |t: GridCoord| -> (i32, i32) { ((pos.x - t.x).max(t.x - (pos.x + w - 1)).max(0), (pos.y - t.y).max(t.y - (pos.y + h - 1)).max(0)) };
        let reach = |t: GridCoord| -> i32 { let (dx, dy) = off(t); dx.max(dy) };
        let taxi = |t: GridCoord| -> i32 { let (dx, dy) = off(t); dx + dy };
        // The walk from the plot, tile by tile, over open grass, from every
        // side but the street's; a tile further by the walk than by the
        // crow by more than a few is round the end of something.
        let mut queue: VecDeque<(GridCoord, i32)> = VecDeque::new();
        let mut seen: HashSet<(i32, i32)> = HashSet::new();
        for t in Self::footprint(pos, p.size) {
            for (dx, dy) in AROUND[..4].iter() {
                let n = GridCoord { x: t.x + dx, y: t.y + dy };
                let inside = n.x >= pos.x && n.y >= pos.y && n.x < pos.x + w && n.y < pos.y + h;
                let street_side = (dx * fx + dy * fy) > 0;
                if !inside && !street_side && seen.insert((n.x, n.y)) {
                    queue.push_back((n, 1));
                }
            }
        }
        let side = (wanted as f64).sqrt().ceil() as i32 + 2;
        let mut grass: Vec<(i32, i32, GridCoord)> = Vec::new();
        while let Some((t, walk)) = queue.pop_front() {
            if !self.is_open(t) || reach(t) > side || walk > taxi(t) + 4 {
                continue;
            }
            grass.push((reach(t), walk, t));
            for (dx, dy) in AROUND[..4].iter() {
                let n = GridCoord { x: t.x + dx, y: t.y + dy };
                if seen.insert((n.x, n.y)) {
                    queue.push_back((n, walk + 1));
                }
            }
        }
        grass.sort_by_key(|&(r, walk, t)| (r, walk, t.y, t.x));
        let land: Vec<Tile> = grass.into_iter().take(wanted).map(|(_, _, at)| Tile { at, stage: Stage::Grass, since: 0 }).collect();
        if let Some(GameObject::Building(b)) = self.objects.get_mut(farm).map(|e| &mut e.object) {
            b.land = land;
        }
    }

    /// A tile built over, or roaded over, is land no more: the farm keeps
    /// only the tiles still open.
    pub fn tend(&mut self, farm: EntityId) {
        let Some(GameObject::Building(b)) = self.objects.get(farm).map(|e| &e.object) else { return };
        let kept: Vec<Tile> = b.land.iter().copied().filter(|t| self.is_open(t.at)).collect();
        if kept.len() != b.land.len()
            && let Some(GameObject::Building(b)) = self.objects.get_mut(farm).map(|e| &mut e.object)
        {
            b.land = kept;
        }
    }

    /// The tractor's next job, and the tiles that want it: the harvest,
    /// once every sown tile is ripe and the yard has room for a crop;
    /// else the plough, for grass and stubble; else the seed, for bare
    /// ground. A batch is complete or it waits, so that one run takes it
    /// all and the cycle keeps in step.
    fn batch(&self, farm: EntityId, now: GameTime) -> Option<(Job, Vec<GridCoord>)> {
        let Some(GameObject::Building(b)) = self.objects.get(farm).map(|e| &e.object) else { return None };
        let tiles = |stage: Stage| -> Vec<GridCoord> { b.land.iter().filter(|t| t.stage == stage).map(|t| t.at).collect() };
        let sown = tiles(Stage::Sown);
        if !sown.is_empty() {
            let ripe = b.land.iter().filter(|t| t.stage == Stage::Sown).all(|t| now >= t.since + RIPEN);
            let room = b.stocks.get(&economy::shelf_need(b.kind)).is_some_and(|s| s.short() + 1e-6 >= economy::crop(b.kind));
            if ripe && room {
                return Some((Job::Harvest, sown));
            }
            if ripe {
                return None;
            }
        }
        let rough: Vec<GridCoord> = b.land.iter().filter(|t| matches!(t.stage, Stage::Grass | Stage::Cut)).map(|t| t.at).collect();
        if !rough.is_empty() {
            return Some((Job::Plough, rough));
        }
        let bare = tiles(Stage::Ploughed);
        if !bare.is_empty() && sown.is_empty() {
            return Some((Job::Seed, bare));
        }
        None
    }

    /// The farm's turn for its tractor: with a hand on shift, the tractor
    /// in its yard, and a batch wanting a job, it sets out on a run.
    pub fn farm_run(&mut self, events: &mut EventQueue, farm: EntityId, now: GameTime) {
        self.tend(farm);
        let Some(kind) = self.objects.get(farm).and_then(|e| match e.object {
            GameObject::Building(ref b) => Some(b.kind),
            _ => None,
        }) else {
            return;
        };
        let Some((job, batch)) = self.batch(farm, now) else {
            // A crop still ripening: the farm wakes when the last of it is.
            if let Some(GameObject::Building(b)) = self.objects.get(farm).map(|e| &e.object)
                && let Some(ripe) = b.land.iter().filter(|t| t.stage == Stage::Sown).map(|t| t.since + RIPEN).max()
                && ripe > now
            {
                events.wake(ripe - now, farm);
            }
            return;
        };
        let on_shift = crate::blueprint::blueprint(kind).taps.iter().any(|t| t.need == crate::needs::Need::Work && t.curve.integral(now, now + 1_000) > 0.0);
        if !on_shift || !crate::calls::staffed(self, farm) {
            return;
        }
        let Some(tractor) = self
            .objects
            .iter()
            .find(|e| matches!(e.object, GameObject::Car(ref c) if c.owner == farm && c.role == CarRole::Tractor && c.trip.is_none() && c.run.is_none() && c.away == 0))
            .map(|e| e.id)
        else {
            return;
        };
        let Some(yard) = self.yard_gate(farm, &batch) else { return };
        let Some(path) = self.sweep(farm, yard, &batch) else { return };
        self.release_spot(tractor);
        self.update_position(tractor, yard);
        if let Some(GameObject::Car(c)) = self.objects.get_mut(tractor).map(|e| &mut e.object) {
            c.spot = None;
            c.run = Some(Run { job, path, started: now, pace: PACE });
        }
        events.wake(PACE, tractor);
    }

    /// The tiles the tractor may drive: the farm's land and its yard,
    /// never the barn.
    fn drivable(&self, farm: EntityId) -> HashSet<(i32, i32)> {
        let mut ground: HashSet<(i32, i32)> = self.yard_tiles(farm).into_iter().map(|t| (t.x, t.y)).collect();
        if let Some(GameObject::Building(b)) = self.objects.get(farm).map(|e| &e.object) {
            ground.extend(b.land.iter().map(|t| (t.at.x, t.at.y)));
        }
        ground
    }

    /// The farm's yard: its plot less the barn.
    fn yard_tiles(&self, farm: EntityId) -> Vec<GridCoord> {
        let Some(e) = self.objects.get(farm) else { return Vec::new() };
        let (Some(pos), GameObject::Building(b)) = (e.position, &e.object) else { return Vec::new() };
        let p = plot(b.kind, b.facing);
        let ((bx, by), (bw, bh)) = p.building;
        let barn = GridCoord { x: pos.x + bx as i32, y: pos.y + by as i32 };
        Self::footprint(pos, p.size).filter(|t| !(t.x >= barn.x && t.y >= barn.y && t.x < barn.x + bw as i32 && t.y < barn.y + bh as i32)).collect()
    }

    /// Where a run leaves the yard and comes back to it: the yard tile
    /// nearest the batch.
    fn yard_gate(&self, farm: EntityId, batch: &[GridCoord]) -> Option<GridCoord> {
        self.yard_tiles(farm).into_iter().min_by_key(|&y| batch.iter().map(|&t| dist(y, t)).min().unwrap_or(i32::MAX))
    }

    /// A run over a batch of tiles with the fewest turns: rows parallel to
    /// the street the farm fronts, driven alternately each way so that a
    /// change of row is two gentle turns over a diagonal step and never a
    /// hairpin, taken in order from the street's end to the far end so the
    /// path never doubles back and the field is worked away from the
    /// road; and between one tile and the next, if they do not touch, the
    /// shortest way over the farm's own ground, diagonals allowed. From
    /// the yard, and back to it.
    fn sweep(&self, farm: EntityId, yard: GridCoord, batch: &[GridCoord]) -> Option<Vec<GridCoord>> {
        if batch.is_empty() {
            return None;
        }
        let (xs, ys): (Vec<i32>, Vec<i32>) = batch.iter().map(|t| (t.x, t.y)).unzip();
        let (x0, x1, y0, y1) = (*xs.iter().min()?, *xs.iter().max()?, *ys.iter().min()?, *ys.iter().max()?);
        // Rows parallel to the street: across the facing.
        let facing = match self.objects.get(farm).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.facing,
            _ => return None,
        };
        let along_x = crate::blueprint::FACINGS[facing as usize % 4].1 != 0;
        let mut rows: Vec<Vec<GridCoord>> = Vec::new();
        let (r0, r1) = if along_x { (y0, y1) } else { (x0, x1) };
        for r in r0..=r1 {
            let mut row: Vec<GridCoord> = batch.iter().copied().filter(|t| if along_x { t.y == r } else { t.x == r }).collect();
            if row.is_empty() {
                continue;
            }
            row.sort_by_key(|t| if along_x { t.x } else { t.y });
            rows.push(row);
        }
        // From the yard's end of the field to the other.
        let near_end = |row: &Vec<GridCoord>| if along_x { (row[0].y - yard.y).abs() } else { (row[0].x - yard.x).abs() };
        if near_end(&rows[rows.len() - 1]) < near_end(&rows[0]) {
            rows.reverse();
        }
        let ground = self.drivable(farm);
        // Home along the field's edge, not across it: over the tiles with
        // something other than land on a side, or any ground if the edge
        // does not join up.
        let edge: HashSet<(i32, i32)> = ground
            .iter()
            .copied()
            .filter(|&(x, y)| AROUND[..4].iter().any(|(dx, dy)| !ground.contains(&(x + dx, y + dy))))
            .collect();
        // The first row may be driven either way; the way that leaves the
        // last row ending nearer the yard makes the shorter run.
        let mut best: Option<Vec<GridCoord>> = None;
        for flip in [false, true] {
            let mut path = vec![yard];
            let mut at = yard;
            for (i, row) in rows.iter().enumerate() {
                let mut row = row.clone();
                // Enter the row at whichever end is nearer; the first row as
                // this attempt says.
                let (first, last) = (row[0], row[row.len() - 1]);
                if if i == 0 { flip } else { dist(at, last) < dist(at, first) } {
                    row.reverse();
                }
                for &t in row.iter() {
                    let Some(leg) = self.over(&ground, at, t) else { return None };
                    path.extend(leg.into_iter().skip(1));
                    at = t;
                }
            }
            let Some(home) = self.over(&edge, at, yard).or_else(|| self.over(&ground, at, yard)) else { return None };
            path.extend(home.into_iter().skip(1));
            if best.as_ref().is_none_or(|b| path.len() < b.len()) {
                best = Some(path);
            }
        }
        best
    }

    /// The shortest drive from one tile to another over the given ground,
    /// eight ways, both ends included. Two tiles that touch are one step.
    fn over(&self, ground: &HashSet<(i32, i32)>, from: GridCoord, to: GridCoord) -> Option<Vec<GridCoord>> {
        if dist(from, to) <= 1 {
            return Some(vec![from, to]);
        }
        let mut came: std::collections::HashMap<(i32, i32), (i32, i32)> = std::collections::HashMap::new();
        let mut queue = VecDeque::from([(from.x, from.y)]);
        came.insert((from.x, from.y), (from.x, from.y));
        while let Some((x, y)) = queue.pop_front() {
            if (x, y) == (to.x, to.y) {
                let mut way = vec![to];
                let mut cur = (x, y);
                while cur != (from.x, from.y) {
                    cur = came[&cur];
                    way.push(GridCoord { x: cur.0, y: cur.1 });
                }
                way.reverse();
                return Some(way);
            }
            for (dx, dy) in AROUND {
                let n = (x + dx, y + dy);
                if (ground.contains(&n) || n == (to.x, to.y)) && !came.contains_key(&n) {
                    came.insert(n, (x, y));
                    queue.push_back(n);
                }
            }
        }
        None
    }

    /// The tractor arrives at the tile of its run the clock names and does its job to
    /// it: the plough turns grass or stubble to bare ground, the seed
    /// starts a crop, the harvest lands a crop in the yard and leaves
    /// stubble — or, with no room left in the yard, leaves the crop
    /// standing. At the end of the run it is home, its path is the tyre
    /// marks, and the farm takes its turn for the next run.
    pub fn tractor_step(&mut self, events: &mut EventQueue, tractor: EntityId, now: GameTime) {
        let Some(GameObject::Car(c)) = self.objects.get(tractor).map(|e| &e.object) else { return };
        let (farm, Some(run)) = (c.owner, c.run.clone()) else { return };
        // The tile is the clock's: the run began on the first, and reaches
        // one more every pace. Nothing on the car changes from step to
        // step, so nothing is resent until the run is over.
        let k = ((now - run.started) / run.pace) as usize;
        let Some(&here) = run.path.get(k) else { return };
        self.update_position(tractor, here);
        let crop = self.objects.get(farm).and_then(|e| match e.object {
            GameObject::Building(ref b) => Some(economy::crop(b.kind)),
            _ => None,
        });
        let mut cut = 0.0;
        if let Some(GameObject::Building(b)) = self.objects.get_mut(farm).map(|e| &mut e.object)
            && let Some(tile) = b.land.iter_mut().find(|t| t.at == here)
        {
            match (run.job, tile.stage) {
                (Job::Plough, Stage::Grass | Stage::Cut) => (tile.stage, tile.since) = (Stage::Ploughed, now),
                (Job::Seed, Stage::Ploughed) => (tile.stage, tile.since) = (Stage::Sown, now),
                (Job::Harvest, Stage::Sown) => {
                    let room = b.stocks.get(&economy::shelf_need(b.kind)).is_some_and(|s| s.short() + 1e-6 >= crop.unwrap_or(0.0));
                    if room {
                        (tile.stage, tile.since) = (Stage::Cut, now);
                        cut = crop.unwrap_or(0.0);
                    }
                }
                _ => {}
            }
        }
        if cut > 0.0 {
            economy::harvested(self, farm, cut);
        }
        if k + 1 < run.path.len() {
            events.wake(PACE, tractor);
            return;
        }
        if let Some(GameObject::Car(c)) = self.objects.get_mut(tractor).map(|e| &mut e.object) {
            c.run = None;
        }
        if let Some(GameObject::Building(b)) = self.objects.get_mut(farm).map(|e| &mut e.object) {
            b.ruts = run.path;
        }
        self.park_in_lot(farm, tractor, now);
        economy::refilled(self, tractor, now);
        crate::calls::turn(self, events, farm, now);
    }
}

/// Steps between two tiles, eight ways: the longer of the two distances.
fn dist(a: GridCoord, b: GridCoord) -> i32 {
    (a.x - b.x).abs().max((a.y - b.y).abs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::needs::Need;
    use crate::protocol::{BuildingKind, TerrainType};

    /// Grass either side of a street along y = 0, deep enough for a farm
    /// and its land.
    fn land() -> World {
        let mut world = World::new();
        for y in -12..14 {
            for x in -4..60 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        world.place_road_path(&(-2..60).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>());
        world
    }

    fn farm_at(world: &mut World, x: i32) -> (EntityId, Vec<Tile>) {
        let farm = world.place_on_street(GridCoord { x, y: 1 }, BuildingKind::Farm).unwrap();
        (farm, tiles(world, farm))
    }

    fn tiles(world: &World, farm: EntityId) -> Vec<Tile> {
        match world.objects.get(farm).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.land.clone(),
            _ => Vec::new(),
        }
    }

    fn tractor(world: &World, farm: EntityId) -> EntityId {
        world.objects.iter().find(|e| matches!(e.object, GameObject::Car(ref c) if c.owner == farm)).map(|e| e.id).expect("a tractor in the yard")
    }

    fn run_of(world: &World, tractor: EntityId) -> Option<Run> {
        match world.objects.get(tractor).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.run.clone(),
            _ => None,
        }
    }

    /// Drive a run to its end, one tile at a time.
    fn drive(world: &mut World, events: &mut EventQueue, tractor: EntityId, mut now: GameTime) -> GameTime {
        while run_of(world, tractor).is_some() {
            now += PACE;
            world.tractor_step(events, tractor, now);
        }
        now
    }

    /// §12.8: a farm reached by a street claims its row's land, the grass
    /// connected to its plot on every side but the street's, all of it
    /// grass and none of it on the street; a road through the land is
    /// its edge, and a farm in the woods claims nothing.
    #[test]
    fn a_farm_claims_the_grass_behind_it() {
        let mut world = land();
        let (farm, tiles) = farm_at(&mut world, 10);
        assert_eq!(tiles.len(), capacity(BuildingKind::Farm) as usize, "the farm claimed {} tiles", tiles.len());
        assert!(tiles.iter().all(|t| t.at.x.abs_diff(10) < 20), "the land is not round the farm");
        assert!(tiles.iter().all(|t| t.stage == Stage::Grass && world.is_open(t.at)));
        assert!(tiles.iter().all(|t| t.at.y >= 1), "land was claimed across the street: {:?}", tiles.iter().filter(|t| t.at.y < 1).map(|t| t.at).collect::<Vec<_>>());
        assert_eq!(world.laid, 0);
        // Bounded: a road four tiles behind the plot walls the land in.
        let mut walled = land();
        walled.place_road_path(&(-4..60).map(|x| GridCoord { x, y: 6 }).collect::<Vec<_>>());
        let (_, tiles) = farm_at(&mut walled, 10);
        assert!(!tiles.is_empty() && tiles.iter().all(|t| t.at.y < 6), "the land crossed the road");
        // Nothing to claim in a wood.
        let mut woods = land();
        for y in -12..14 {
            for x in -4..60 {
                woods.terrain.insert((x, y), TerrainType::Forest);
            }
        }
        let (_, tiles) = farm_at(&mut woods, 10);
        assert!(tiles.is_empty(), "fields were claimed from forest");
    }

    /// The sweep, drawn: the plough's path over three shapes of ground —
    /// an open block behind the farm, land on both flanks, and a field
    /// with a house in it — printed as a grid so it can be looked at.
    /// `cargo test draw_the_sweep -- --nocapture`. Asserted: every step a
    /// neighbour of the last, nothing driven through the barn or the
    /// house, and few turns.
    #[test]
    fn draw_the_sweep() {
        for (name, shape) in [("open block", 0), ("both flanks", 1), ("a house in the field", 2)] {
            let mut world = World::new();
            for y in -4..16 {
                for x in -4..40 {
                    world.terrain.insert((x, y), TerrainType::Grass);
                }
            }
            world.place_road_path(&(-2..40).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>());
            if shape == 0 {
                // Walls of forest on the flanks: land only behind.
                for y in 1..16 {
                    for x in [-4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 22, 23, 24, 25, 26, 27, 28, 29, 30] {
                        world.terrain.insert((x, y), TerrainType::Forest);
                    }
                }
            }
            if shape == 2 {
                world.place_building(GridCoord { x: 17, y: 8 }, BuildingKind::House, 2);
            }
            let farm = world.place_on_street(GridCoord { x: 14, y: 1 }, BuildingKind::Farm).unwrap();
            let batch: Vec<GridCoord> = tiles(&world, farm).iter().map(|t| t.at).collect();
            let gate = world.yard_gate(farm, &batch).unwrap();
            let path = world.sweep(farm, gate, &batch).expect("a sweep");
            let steps = 130usize.min(path.len());
            let mut grid: Vec<Vec<char>> = (0..20).map(|_| vec!['.'; 44]).collect();
            for t in &batch {
                grid[(t.y + 4) as usize][(t.x + 4) as usize] = ',';
            }
            for (i, t) in path.iter().enumerate().take(steps) {
                let c = if i == 0 { 'Y' } else { char::from_digit((i % 36) as u32, 36).unwrap() };
                grid[(t.y + 4) as usize][(t.x + 4) as usize] = c;
            }
            for t in World::footprint(GridCoord { x: 14, y: 1 }, (3, 4)) {
                if !world.yard_tiles(farm).contains(&t) {
                    grid[(t.y + 4) as usize][(t.x + 4) as usize] = '#';
                }
            }
            if shape == 2 {
                grid[12][21] = 'H';
            }
            println!("{name}: {} tiles, {} steps (first {steps} drawn, 0-9a-z then round again)", batch.len(), path.len());
            for row in grid.iter().skip(4) {
                println!("  {}", row.iter().collect::<String>());
            }
            assert!(path.windows(2).all(|w| dist(w[0], w[1]) == 1), "{name}: a step is not to a neighbour");
            let ground = world.drivable(farm);
            assert!(path.iter().all(|t| ground.contains(&(t.x, t.y))), "{name}: the tractor left the farm's ground");
            let turns = path.windows(3).filter(|w| (w[1].x - w[0].x, w[1].y - w[0].y) != (w[2].x - w[1].x, w[2].y - w[1].y)).count();
            let mut seen = HashSet::new();
            let again = path.iter().filter(|t| !seen.insert((t.x, t.y))).count();
            println!("  {turns} turns over {} steps, {again} tiles driven twice", path.len());
            assert!(again * 5 < path.len(), "{name}: {again} of {} steps retrace", path.len());
        }
    }

    /// A tile is ordinary grass to the mayor: build on it and the farm
    /// keeps the rest.
    #[test]
    fn a_tile_built_over_is_land_no_more() {
        let mut world = land();
        let (farm, tiles) = farm_at(&mut world, 10);
        let lost = tiles[tiles.len() - 1].at;
        assert!(world.place_building(lost, BuildingKind::House, 2).is_some(), "a tile could not be built on");
        world.tend(farm);
        let kept = self::tiles(&world, farm);
        assert_eq!(kept.len(), tiles.len() - 1);
        assert!(kept.iter().all(|t| t.at != lost));
    }

    /// The cycle: the tractor ploughs every tile in one run, seeds them in
    /// the next, and a day on harvests them, each tile's crop landing in
    /// the yard as it is cut; the run goes from the yard over the farm's
    /// own ground and back, every step a neighbour of the last, and its
    /// path is the tyre marks. A yard with no room leaves the crop
    /// standing.
    #[test]
    fn the_tractor_ploughs_seeds_and_harvests_in_runs() {
        let mut world = land();
        let (farm, tiles) = farm_at(&mut world, 10);
        let mut events = EventQueue::new();
        let tractor = tractor(&world, farm);
        let yard = |world: &World| match world.objects.get(farm).unwrap().object {
            GameObject::Building(ref b) => b.stocks[&Need::Eat].level,
            _ => unreachable!(),
        };
        let stages = |world: &World| -> Vec<Stage> { self::tiles(world, farm).iter().map(|t| t.stage).collect() };
        // Nobody on shift: no run.
        world.farm_run(&mut events, farm, 0);
        assert!(run_of(&world, tractor).is_none(), "the tractor went out with nobody to drive it");
        // The plough.
        let now = 1_000;
        let (job, batch) = world.batch(farm, now).expect("a job");
        assert_eq!((job, batch.len()), (Job::Plough, tiles.len()));
        let pos = world.yard_gate(farm, &batch).unwrap();
        let path = world.sweep(farm, pos, &batch).expect("a sweep");
        assert_eq!((path[0], *path.last().unwrap()), (pos, pos), "the run does not start and end at the yard");
        assert!(path.windows(2).all(|w| dist(w[0], w[1]) == 1), "a step of the run is not to a neighbour");
        assert!(batch.iter().all(|t| path.contains(t)), "the sweep missed a tile");
        let ground = world.drivable(farm);
        assert!(path.iter().all(|t| ground.contains(&(t.x, t.y))), "the tractor left the farm's ground");
        // Turns: a sweep of a block is about one turn a row.
        let turns = path.windows(3).filter(|w| (w[1].x - w[0].x, w[1].y - w[0].y) != (w[2].x - w[1].x, w[2].y - w[1].y)).count();
        assert!(turns * 3 < path.len(), "{turns} turns over {} steps", path.len());
        if let Some(GameObject::Car(c)) = world.objects.get_mut(tractor).map(|e| &mut e.object) {
            c.run = Some(Run { job, path: path.clone(), started: now, pace: PACE });
        }
        let now = drive(&mut world, &mut events, tractor, now);
        assert!(stages(&world).iter().all(|&s| s == Stage::Ploughed), "not every tile was ploughed");
        assert_eq!(match world.objects.get(farm).unwrap().object { GameObject::Building(ref b) => b.ruts.clone(), _ => unreachable!() }, path, "the tyre marks are not the run");
        // The seed, then nothing until the crop is ripe.
        let (job, batch) = world.batch(farm, now).expect("a job");
        assert_eq!((job, batch.len()), (Job::Seed, tiles.len()));
        let path = world.sweep(farm, pos, &batch).unwrap();
        if let Some(GameObject::Car(c)) = world.objects.get_mut(tractor).map(|e| &mut e.object) {
            c.run = Some(Run { job, path, started: now, pace: PACE });
        }
        let sown_at = now;
        let now = drive(&mut world, &mut events, tractor, now);
        assert!(stages(&world).iter().all(|&s| s == Stage::Sown));
        assert!(world.batch(farm, now).is_none(), "a job before the crop is ripe");
        assert!(world.batch(farm, sown_at + DAY_MS as u64 / 2).is_none());
        // The harvest, a day on: every tile's crop in the yard.
        let now = sown_at + DAY_MS as u64 + PACE * 200;
        let (job, batch) = world.batch(farm, now).expect("a harvest");
        assert_eq!((job, batch.len()), (Job::Harvest, tiles.len()));
        let path = world.sweep(farm, pos, &batch).unwrap();
        if let Some(GameObject::Car(c)) = world.objects.get_mut(tractor).map(|e| &mut e.object) {
            c.run = Some(Run { job, path, started: now, pace: PACE });
        }
        let now = drive(&mut world, &mut events, tractor, now);
        assert!(stages(&world).iter().all(|&s| s == Stage::Cut));
        assert!((yard(&world) - tiles.len() as f64 * economy::crop(BuildingKind::Farm)).abs() < 1e-9, "the yard holds {}", yard(&world));
        // Round again: plough the stubble. And a full yard leaves the
        // crop standing.
        assert_eq!(world.batch(farm, now).map(|b| b.0), Some(Job::Plough));
        if let Some(GameObject::Building(b)) = world.objects.get_mut(farm).map(|e| &mut e.object) {
            for t in b.land.iter_mut() {
                (t.stage, t.since) = (Stage::Sown, 0);
            }
            let s = b.stocks.get_mut(&Need::Eat).unwrap();
            s.level = s.cap;
        }
        assert!(world.batch(farm, now).is_none(), "a harvest with no room in the yard");
    }
}
