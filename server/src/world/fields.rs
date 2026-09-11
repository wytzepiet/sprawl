//! A farm's land, and the tractor's runs over it. docs/economy.md §12.8.
//!
//! When a street reaches a farm it claims a rectangle of grass behind its
//! plot, grown a row at a time on whichever side keeps it squarest until
//! it is as much as a shift can plough, and stopping short of a road, a
//! wood, a beach or anything built: a field is a rectangle unless
//! something forced it not to be. Each tile is then at a stage of one
//! cycle — grass, ploughed, sown, cut — and the tractor drives the whole
//! field in one run a day, doing the job to each tile as it arrives:
//! ploughing turns the ground, seeding starts the crop, harvesting lands
//! a tile's crop in the yard. It works a field as a farmer does: out of
//! the yard along the lane round the barn, once round the outline for
//! the headland, then straight rows along the long side, and home along
//! the edge, never turning sharper than a right angle. Off the roads
//! entirely: a run is a list of tiles and a pace, no route, no claims, no
//! queue. A tile the mayor builds or roads over is dropped at the farm's
//! next look, and the tractor's last path stays on the ground as its
//! tyre marks.

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

    /// A farm reached by a street claims its land: a rectangle of open
    /// grass behind its plot, begun as the row along the plot's back and
    /// grown a row at a time — on the long side, so the short side catches
    /// up and the field tends to square; on the flank that keeps it
    /// centred on the yard; never toward the street — until it is as much
    /// as a shift can plough. A row that would run onto anything but open
    /// grass is not taken, so a road, a house or a wood is the edge of the
    /// field and the rectangle grows the other way; a row that would take
    /// the field past its size is not taken either, and when no row can
    /// be, the field is done. The first shift's ploughing makes it a field.
    pub fn claim_land(&mut self, farm: EntityId) {
        let Some(e) = self.objects.get(farm) else { return };
        let (Some(pos), GameObject::Building(b)) = (e.position, &e.object) else { return };
        let (kind, facing) = (b.kind, b.facing);
        let wanted = capacity(kind) as i32;
        if !economy::farm(kind) || !b.land.is_empty() {
            return;
        }
        let p = plot(kind, facing);
        let (fx, fy) = crate::blueprint::FACINGS[facing as usize % 4];
        let (w, h) = (p.size.0 as i32, p.size.1 as i32);
        // The row along the plot's back: the plot's tiles stepped one away
        // from the street, less the plot itself.
        let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        for t in Self::footprint(pos, p.size) {
            let n = GridCoord { x: t.x - fx, y: t.y - fy };
            if n.x >= pos.x && n.y >= pos.y && n.x < pos.x + w && n.y < pos.y + h {
                continue;
            }
            (x0, y0, x1, y1) = (x0.min(n.x), y0.min(n.y), x1.max(n.x), y1.max(n.y));
        }
        let open = |x0: i32, y0: i32, x1: i32, y1: i32| (y0..=y1).all(|y| (x0..=x1).all(|x| self.is_open(GridCoord { x, y })));
        if !open(x0, y0, x1, y1) {
            return;
        }
        let (cx, cy) = (pos.x * 2 + w - 1, pos.y * 2 + h - 1);
        loop {
            let (dx, dy) = (x1 - x0 + 1, y1 - y0 + 1);
            if dx * dy >= wanted {
                break;
            }
            // Each side but the street's, as the rectangle would be with a
            // row added there: the long sides first, then the flank nearer
            // the yard's middle.
            let mut sides: Vec<(i32, i32, (i32, i32, i32, i32))> = AROUND[..4]
                .iter()
                .filter(|&&(sx, sy)| (sx, sy) != (fx, fy))
                .map(|&(sx, sy)| {
                    let grown = (x0.min(x0 + sx), y0.min(y0 + sy), x1.max(x1 + sx), y1.max(y1 + sy));
                    let row = if sx != 0 { dy } else { dx };
                    let off = ((grown.0 + grown.2 - cx).abs(), (grown.1 + grown.3 - cy).abs());
                    (-row, off.0 + off.1, grown)
                })
                .collect();
            sides.sort();
            let Some(&(_, _, (gx0, gy0, gx1, gy1))) = sides.iter().find(|&&(_, _, (gx0, gy0, gx1, gy1))| {
                (gx1 - gx0 + 1) * (gy1 - gy0 + 1) <= wanted && open(gx0, gy0, gx1, gy1)
            }) else {
                break;
            };
            (x0, y0, x1, y1) = (gx0, gy0, gx1, gy1);
        }
        let land: Vec<Tile> = (y0..=y1).flat_map(|y| (x0..=x1).map(move |x| Tile { at: GridCoord { x, y }, stage: Stage::Grass, since: 0 })).collect();
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
            let room = b.stocks.get(&economy::shelf_need(b.kind)).is_some_and(|s| s.short() + 1e-6 >= economy::crop(b.kind, b.land.len()));
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

    /// The tiles the tractor may drive: the farm's land, its yard, and the
    /// lane — the open ground round the plot, which is how the tractor
    /// gets from the yard at the street to the field behind the barn.
    /// Never the barn.
    fn drivable(&self, farm: EntityId) -> HashSet<(i32, i32)> {
        let mut ground: HashSet<(i32, i32)> = self.yard_tiles(farm).into_iter().map(|t| (t.x, t.y)).collect();
        let Some(e) = self.objects.get(farm) else { return ground };
        let (Some(pos), GameObject::Building(b)) = (e.position, &e.object) else { return ground };
        ground.extend(b.land.iter().map(|t| (t.at.x, t.at.y)));
        for t in Self::footprint(pos, plot(b.kind, b.facing).size) {
            for (dx, dy) in AROUND {
                let n = GridCoord { x: t.x + dx, y: t.y + dy };
                if self.is_open(n) {
                    ground.insert((n.x, n.y));
                }
            }
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

    /// A run over a batch of tiles as a farmer drives one: from the yard
    /// along the lane to the corner of the field nearest it, once round
    /// the outline for the headland, then the inside in straight rows
    /// along the long side, each driven the way back from the last, from
    /// the yard's side of the field to the far side; and home along the
    /// edge. Never a turn sharper than a right angle: between one tile and
    /// the next the shortest way that keeps to that, and a tile there is
    /// no such way to is left — the headland has already been round it.
    /// Round the outline either way; whichever leaves fewer tiles and the
    /// shorter run.
    fn sweep(&self, farm: EntityId, yard: GridCoord, batch: &[GridCoord]) -> Option<Vec<GridCoord>> {
        if batch.is_empty() {
            return None;
        }
        let set: HashSet<(i32, i32)> = batch.iter().map(|t| (t.x, t.y)).collect();
        let (x0, x1) = (batch.iter().map(|t| t.x).min()?, batch.iter().map(|t| t.x).max()?);
        let (y0, y1) = (batch.iter().map(|t| t.y).min()?, batch.iter().map(|t| t.y).max()?);
        // The outline, clockwise from the corner nearest the yard.
        let mut outline: Vec<GridCoord> = Vec::new();
        let mut seen: HashSet<(i32, i32)> = HashSet::new();
        for (x, y) in (x0..=x1).map(|x| (x, y0)).chain((y0..=y1).map(|y| (x1, y))).chain((x0..=x1).rev().map(|x| (x, y1))).chain((y0..=y1).rev().map(|y| (x0, y))) {
            if set.contains(&(x, y)) && seen.insert((x, y)) {
                outline.push(GridCoord { x, y });
            }
        }
        let corner = |t: &GridCoord| (t.x == x0 || t.x == x1) && (t.y == y0 || t.y == y1);
        let start = (0..outline.len()).filter(|&i| corner(&outline[i])).min_by_key(|&i| dist(outline[i], yard)).or_else(|| (0..outline.len()).min_by_key(|&i| dist(outline[i], yard)))?;
        outline.rotate_left(start);
        // The inside, in rows along the long side, from the yard's side.
        let along_x = x1 - x0 >= y1 - y0;
        let mut rows: Vec<Vec<GridCoord>> = Vec::new();
        for r in if along_x { y0 + 1..y1 } else { x0 + 1..x1 } {
            let mut row: Vec<GridCoord> = batch.iter().copied().filter(|t| if along_x { t.y == r && t.x > x0 && t.x < x1 } else { t.x == r && t.y > y0 && t.y < y1 }).collect();
            if !row.is_empty() {
                row.sort_by_key(|t| if along_x { t.x } else { t.y });
                rows.push(row);
            }
        }
        let near = |row: &Vec<GridCoord>| if along_x { (row[0].y - yard.y).abs() } else { (row[0].x - yard.x).abs() };
        if rows.len() > 1 && near(&rows[rows.len() - 1]) < near(&rows[0]) {
            rows.reverse();
        }
        let ground = self.drivable(farm);
        // Home along the edge: the headland, the lane and the yard.
        let edge: HashSet<(i32, i32)> = ground.iter().copied().filter(|t| !set.contains(t) || outline.iter().any(|o| (o.x, o.y) == *t)).collect();
        let mut best: Option<(usize, Vec<GridCoord>)> = None;
        for widdershins in [false, true] {
            let mut round = outline.clone();
            if widdershins {
                round[1..].reverse();
            }
            let mut path = vec![yard];
            let mut left = 0;
            // The tiles in the order they are wanted: the outline, then
            // each row from whichever end the tractor is nearer.
            let mut order = round;
            for row in rows.iter() {
                let at = order[order.len() - 1];
                if dist(at, row[row.len() - 1]) < dist(at, row[0]) {
                    order.extend(row.iter().rev());
                } else {
                    order.extend(row);
                }
            }
            for (i, &t) in order.iter().enumerate() {
                // Arrive heading for the tile after, when that is a step
                // away, so the row runs straight; failing that, anyhow.
                let then = order.get(i + 1).copied().filter(|n| dist(t, *n) == 1);
                match self.over(&ground, &path, t, then).or_else(|| then.and_then(|_| self.over(&ground, &path, t, None))) {
                    Some(leg) => path.extend(leg),
                    None => left += 1,
                }
            }
            let home = self.over(&edge, &path, yard, None).or_else(|| self.over(&ground, &path, yard, None))?;
            path.extend(home);
            if best.as_ref().is_none_or(|(l, b)| (left, path.len()) < (*l, b.len())) {
                best = Some((left, path));
            }
        }
        best.map(|(_, path)| path)
    }

    /// The shortest drive on from a path to a tile over the given ground,
    /// eight ways, turning no sharper than a right angle — from the way
    /// the path's last step was heading, or any way from a standing start
    /// — and arriving, if a tile after is given, heading so that the step
    /// on to it is no sharper either. The tiles after the path's last, the
    /// destination included; or none, if no such drive reaches it.
    fn over(&self, ground: &HashSet<(i32, i32)>, path: &[GridCoord], to: GridCoord, then: Option<GridCoord>) -> Option<Vec<GridCoord>> {
        let from = *path.last()?;
        let heading = match path.len() {
            0 | 1 => None,
            n => Some((from.x - path[n - 2].x, from.y - path[n - 2].y)),
        };
        let arrived = |way: Option<(i32, i32)>| match (way, then) {
            (Some((wx, wy)), Some(n)) => wx * (n.x - to.x) + wy * (n.y - to.y) >= 0,
            _ => true,
        };
        // A state is a tile and the way the tractor came onto it.
        type State = ((i32, i32), Option<(i32, i32)>);
        let start: State = ((from.x, from.y), heading);
        let mut came: std::collections::HashMap<State, State> = std::collections::HashMap::from([(start, start)]);
        let mut queue = VecDeque::from([start]);
        while let Some(state @ ((x, y), way)) = queue.pop_front() {
            if (x, y) == (to.x, to.y) && arrived(way) {
                let mut drive = Vec::new();
                let mut cur = state;
                while cur != start {
                    drive.push(GridCoord { x: cur.0 .0, y: cur.0 .1 });
                    cur = came[&cur];
                }
                drive.reverse();
                return Some(drive);
            }
            for (dx, dy) in AROUND {
                if way.is_some_and(|(wx, wy)| wx * dx + wy * dy < 0) {
                    continue;
                }
                let n = (x + dx, y + dy);
                let next: State = (n, Some((dx, dy)));
                if (ground.contains(&n) || n == (to.x, to.y)) && !came.contains_key(&next) {
                    came.insert(next, state);
                    queue.push_back(next);
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
            GameObject::Building(ref b) => Some(economy::crop(b.kind, b.land.len())),
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
        for y in -12..24 {
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

    /// Whether a path turns sharper than a right angle anywhere.
    fn sharp(path: &[GridCoord]) -> bool {
        path.windows(3).any(|w| (w[1].x - w[0].x) * (w[2].x - w[1].x) + (w[1].y - w[0].y) * (w[2].y - w[1].y) < 0)
    }

    /// Drive a run to its end, one tile at a time.
    fn drive(world: &mut World, events: &mut EventQueue, tractor: EntityId, mut now: GameTime) -> GameTime {
        while run_of(world, tractor).is_some() {
            now += PACE;
            world.tractor_step(events, tractor, now);
        }
        now
    }

    /// The land's bounding rectangle: its corners, and whether it is full.
    fn rect(tiles: &[Tile]) -> (i32, i32, i32, i32, bool) {
        let (x0, x1) = (tiles.iter().map(|t| t.at.x).min().unwrap(), tiles.iter().map(|t| t.at.x).max().unwrap());
        let (y0, y1) = (tiles.iter().map(|t| t.at.y).min().unwrap(), tiles.iter().map(|t| t.at.y).max().unwrap());
        (x0, y0, x1, y1, ((x1 - x0 + 1) * (y1 - y0 + 1)) as usize == tiles.len())
    }

    /// §12.8: a farm reached by a street claims a rectangle of grass
    /// behind its plot, near enough square, as much as a shift ploughs
    /// and no more, all of it grass and none of it on the street; a road
    /// behind the plot is its edge and the field grows along it instead,
    /// and a farm in the woods claims nothing.
    #[test]
    fn a_farm_claims_the_grass_behind_it() {
        let mut world = land();
        let (_, tiles) = farm_at(&mut world, 10);
        let wanted = capacity(BuildingKind::Farm) as usize;
        let (x0, y0, x1, y1, full) = rect(&tiles);
        assert!(full, "the land is not a rectangle");
        assert!(tiles.len() <= wanted && tiles.len() + (x1 - x0 + 1).max(y1 - y0 + 1) as usize > wanted, "the farm claimed {} tiles of {wanted}", tiles.len());
        assert!((x1 - x0).abs_diff(y1 - y0) <= 1, "the field is {}x{}, not square", x1 - x0 + 1, y1 - y0 + 1);
        assert!(y0 == 5 && x0 <= 10 && x1 >= 12, "the field {x0},{y0}..{x1},{y1} is not behind the plot");
        assert!(tiles.iter().all(|t| t.stage == Stage::Grass && world.is_open(t.at)));
        assert_eq!(world.laid, 0);
        // Bounded: a road four tiles behind the plot walls the land in,
        // and the field runs along the road instead.
        let mut walled = land();
        walled.place_road_path(&(-4..60).map(|x| GridCoord { x, y: 6 }).collect::<Vec<_>>());
        let (_, tiles) = farm_at(&mut walled, 10);
        let (_, y0, _, y1, full) = rect(&tiles);
        assert!(full && y0 == 5 && y1 == 5 && tiles.len() > 20, "the walled-in field is {} tiles, y {y0}..{y1}", tiles.len());
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
                let cell = &mut grid[(t.y + 4) as usize][(t.x + 4) as usize];
                if *cell == '.' || *cell == ',' {
                    *cell = c;
                }
            }
            for t in World::footprint(GridCoord { x: 14, y: 1 }, (3, 4)) {
                if !world.yard_tiles(farm).contains(&t) {
                    grid[(t.y + 4) as usize][(t.x + 4) as usize] = '#';
                }
            }
            if shape == 2 {
                grid[12][21] = 'H';
            }
            println!("{name}: {} tiles, {} steps (first {steps} drawn, 0-9a-z then round again, first visit only)", batch.len(), path.len());
            println!("  home: {:?}", path.iter().rev().take(12).map(|t| (t.x, t.y)).collect::<Vec<_>>());
            for row in grid.iter().skip(4) {
                println!("  {}", row.iter().collect::<String>());
            }
            assert!(path.windows(2).all(|w| dist(w[0], w[1]) == 1), "{name}: a step is not to a neighbour");
            let ground = world.drivable(farm);
            assert!(path.iter().all(|t| ground.contains(&(t.x, t.y))), "{name}: the tractor left the farm's ground");
            assert!(!sharp(&path), "{name}: a turn sharper than a right angle");
            assert!(batch.iter().all(|t| path.contains(t)), "{name}: the sweep missed a tile");
            // The headland first: every tile on the outline before any inside it.
            let (x0, y0, x1, y1, _) = rect(&tiles(&world, farm));
            let inside = |t: &GridCoord| t.x > x0 && t.x < x1 && t.y > y0 && t.y < y1;
            let first_inside = path.iter().position(inside).unwrap_or(path.len());
            assert!(batch.iter().filter(|t| !inside(t)).all(|t| path.iter().position(|p| p == t).unwrap() < first_inside), "{name}: the outline was not driven first");
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
        assert!(!sharp(&path), "a turn sharper than a right angle");
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
        assert!((yard(&world) - 1944.0).abs() < 1e-9, "the harvest does not fill the yard: {}", yard(&world));
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
