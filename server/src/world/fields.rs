//! A farm's land, and the tractor's runs over it. docs/economy.md §12.8.
//!
//! When a street reaches a farm it claims a rectangle of grass round its
//! plot, grown a row at a time on whichever side keeps it squarest, the
//! barn and anything else standing in it — a house, a road, a wood — cut
//! out and made up for, until the land in it is as much as a shift can
//! plough: a field is a rectangle with the farmstead in it, and any other
//! shape only where something forced it. Each tile is then at a stage of one
//! cycle — grass, ploughed, sown, cut — and the tractor drives the whole
//! field in one run a day, doing the job to each tile as it arrives:
//! ploughing turns the ground, seeding starts the crop, harvesting lands
//! a tile's crop in the yard. It works a field as a farmer does: the
//! headland — every tile touching something not field — driven round as
//! a ring, the inside in straight rows turning on the headland, the
//! plough taking the rows first and the ring last, the drill and the
//! harvest the ring first; and home along the headland, never turning
//! sharper than a right angle. Off the roads
//! entirely: a run is a list of tiles and a pace, no route, no claims, no
//! queue. A tile the mayor builds or roads over is dropped at the farm's
//! next look, and another farm's land is never claimed: first claim wins.
//! The tractor's last path stays on the farm's record: it is where the
//! field is drawn.

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

    /// A farm reached by a street claims its land: a rectangle round its
    /// plot with the plot cut out of it, and whatever else stands in it —
    /// a house, a road, a wood — cut out too; what is left is the open
    /// grass in it the tractor can reach from the yard. Begun as the plot
    /// and grown a row at a time — on the long side, so the short side
    /// catches up and the field tends to square; on the flank that keeps
    /// it centred on the yard; on any side, the street's too, since a row
    /// of road adds nothing and is not taken — until the land
    /// in it is as much as a shift can plough, the cutouts made up for.
    /// A row that adds no land is not taken, so a road along the field is
    /// its edge and the rectangle grows the other way; a row that would
    /// take the land past its size is not taken either, and when no row
    /// can be, the field is done. Another farm's land is not open to it:
    /// first claim wins, and the field grows the other way.
    pub fn claim_land(&mut self, farm: EntityId) {
        let Some(e) = self.objects.get(farm) else { return };
        let (Some(pos), GameObject::Building(b)) = (e.position, &e.object) else { return };
        let (kind, facing) = (b.kind, b.facing);
        let wanted = capacity(kind) as usize;
        if !economy::farm(kind) || !b.land.is_empty() {
            return;
        }
        let p = plot(kind, facing);
        let (w, h) = (p.size.0 as i32, p.size.1 as i32);
        let taken: HashSet<(i32, i32)> = self.objects.iter().filter(|e| e.id != farm).flat_map(|e| match e.object {
            GameObject::Building(ref b) => b.land.iter().map(|t| (t.at.x, t.at.y)).collect(),
            _ => Vec::new(),
        }).collect();
        let free = |t: GridCoord, (x0, y0, x1, y1): (i32, i32, i32, i32)| !taken.contains(&(t.x, t.y)) && t.x >= x0 && t.y >= y0 && t.x <= x1 && t.y <= y1;
        // The rectangle grows by what the tractor can reach in it; the
        // land is what of that it can work.
        let reach_in = |rect: (i32, i32, i32, i32)| self.reach(farm, &|t| free(t, rect)).len();
        let mut rect = (pos.x, pos.y, pos.x + w - 1, pos.y + h - 1);
        let mut land = reach_in(rect);
        let (cx, cy) = (pos.x * 2 + w - 1, pos.y * 2 + h - 1);
        while land < wanted {
            let (x0, y0, x1, y1) = rect;
            // Each side, as the rectangle would be with a row added there:
            // the long sides first, then the flank nearer the yard's middle.
            let mut sides: Vec<(i32, i32, (i32, i32, i32, i32))> = AROUND[..4]
                .iter()
                .map(|&(sx, sy)| {
                    let grown = (x0.min(x0 + sx), y0.min(y0 + sy), x1.max(x1 + sx), y1.max(y1 + sy));
                    let row = if sx != 0 { y1 - y0 + 1 } else { x1 - x0 + 1 };
                    let off = (grown.0 + grown.2 - cx).abs() + (grown.1 + grown.3 - cy).abs();
                    (-row, off, grown)
                })
                .collect();
            sides.sort();
            let Some((grown, more)) = sides.into_iter().find_map(|(_, _, grown)| {
                let more = reach_in(grown);
                (more > land && more <= wanted).then_some((grown, more))
            }) else {
                break;
            };
            (rect, land) = (grown, more);
        }
        let land = self.workable(farm, |t| free(t, rect));
        if let Some(GameObject::Building(b)) = self.objects.get_mut(farm).map(|e| &mut e.object) {
            b.land = land.into_iter().map(|at| Tile { at, stage: Stage::Grass, since: 0 }).collect();
        }
    }

    /// The open tiles within some ground the tractor can reach from the
    /// yard, four ways.
    fn reach(&self, farm: EntityId, within: &dyn Fn(GridCoord) -> bool) -> HashSet<(i32, i32)> {
        let yard = self.yard_tiles(farm);
        let mut seen: HashSet<(i32, i32)> = yard.iter().map(|t| (t.x, t.y)).collect();
        let mut queue: VecDeque<GridCoord> = yard.iter().copied().collect();
        let mut reached: HashSet<(i32, i32)> = HashSet::new();
        while let Some(t) = queue.pop_front() {
            for (dx, dy) in AROUND[..4].iter() {
                let n = GridCoord { x: t.x + dx, y: t.y + dy };
                if within(n) && seen.insert((n.x, n.y)) && self.is_open(n) {
                    reached.insert((n.x, n.y));
                    queue.push_back(n);
                }
            }
        }
        reached
    }

    /// The land the tractor can work within some ground: what it can
    /// reach, less any sliver — a tile with no field on either side of it
    /// across one axis, a strip one tile wide beside the barn or between
    /// two neighbours, which is yard or lane and not field, and which no
    /// tractor could turn in — until nothing more falls away. What falls
    /// away beside the plot is still the lane, and the field beyond it
    /// is reached across it.
    fn workable(&self, farm: EntityId, within: impl Fn(GridCoord) -> bool) -> Vec<GridCoord> {
        let lane = self.lane(farm);
        let mut field = self.reach(farm, &within);
        loop {
            let wide = |&(x, y): &(i32, i32)| (field.contains(&(x - 1, y)) || field.contains(&(x + 1, y))) && (field.contains(&(x, y - 1)) || field.contains(&(x, y + 1)));
            let slivers: Vec<(i32, i32)> = field.iter().copied().filter(|t| !wide(t)).collect();
            if slivers.is_empty() {
                break;
            }
            for t in slivers {
                field.remove(&t);
            }
            let kept = field.clone();
            field = self.reach(farm, &|t| kept.contains(&(t.x, t.y)) || lane.contains(&(t.x, t.y))).into_iter().filter(|t| kept.contains(t)).collect();
        }
        let mut land: Vec<GridCoord> = field.into_iter().map(|(x, y)| GridCoord { x, y }).collect();
        land.sort_by_key(|t| (t.y, t.x));
        land
    }

    /// A tile built over, or roaded over, is land no more, and nor is
    /// what that leaves the tractor unable to work: the farm keeps only
    /// the land it can still drive.
    pub fn tend(&mut self, farm: EntityId) {
        let Some(GameObject::Building(b)) = self.objects.get(farm).map(|e| &e.object) else { return };
        let had: HashSet<(i32, i32)> = b.land.iter().map(|t| (t.at.x, t.at.y)).collect();
        let keep: HashSet<(i32, i32)> = self.workable(farm, |t| had.contains(&(t.x, t.y))).into_iter().map(|t| (t.x, t.y)).collect();
        if keep.len() != had.len()
            && let Some(GameObject::Building(b)) = self.objects.get_mut(farm).map(|e| &mut e.object)
        {
            b.land.retain(|t| keep.contains(&(t.at.x, t.at.y)));
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
        let Some((path, left)) = self.sweep(farm, yard, &batch, job) else { return };
        // A tile the tractor cannot work — a pocket it could not turn in,
        // or ground cut off by what was built since — is land no more:
        // the field is what the tractor can drive.
        if !left.is_empty()
            && let Some(GameObject::Building(b)) = self.objects.get_mut(farm).map(|e| &mut e.object)
        {
            b.land.retain(|t| !left.contains(&t.at));
        }
        self.release_spot(tractor);
        self.update_position(tractor, yard);
        if let Some(GameObject::Car(c)) = self.objects.get_mut(tractor).map(|e| &mut e.object) {
            c.spot = None;
            c.run = Some(Run { job, path, started: now, pace: PACE });
        }
        events.wake(PACE, tractor);
    }

    /// The tiles the tractor may drive: the farm's land, its yard, and the
    /// lane. Never the barn.
    fn drivable(&self, farm: EntityId) -> HashSet<(i32, i32)> {
        let mut ground: HashSet<(i32, i32)> = self.yard_tiles(farm).into_iter().map(|t| (t.x, t.y)).collect();
        if let Some(GameObject::Building(b)) = self.objects.get(farm).map(|e| &e.object) {
            ground.extend(b.land.iter().map(|t| (t.at.x, t.at.y)));
        }
        ground.extend(self.lane(farm));
        ground
    }

    /// The lane: the open ground round the plot, which is how the tractor
    /// gets from the yard at the street to the field behind the barn.
    fn lane(&self, farm: EntityId) -> HashSet<(i32, i32)> {
        let Some(e) = self.objects.get(farm) else { return HashSet::new() };
        let (Some(pos), GameObject::Building(b)) = (e.position, &e.object) else { return HashSet::new() };
        Self::footprint(pos, plot(b.kind, b.facing).size)
            .flat_map(|t| AROUND.iter().map(move |(dx, dy)| GridCoord { x: t.x + dx, y: t.y + dy }))
            .filter(|&n| self.is_open(n))
            .map(|n| (n.x, n.y))
            .collect()
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

    /// A run over a batch of tiles as a farmer drives one, in two passes.
    /// The headland is every tile of the field that touches something
    /// that is not field — the outside, the coast, the barn and the lane,
    /// a house in the middle — driven round as a ring: each tile the
    /// nearest not yet driven from where the last was, straight on where
    /// it can. The inside is the rest, in straight rows along the grain,
    /// each a run of inside tiles, the nearest run left from wherever the
    /// last one ended and driven from its nearer end, so the rows
    /// alternate and every turn is made on the headland, a step out, a
    /// step along, a step back in. A strip two tiles wide is all headland
    /// and gets no rows; a strip three wide gets one down its spine. The
    /// plough does the rows first and the headland last, as a ploughman
    /// does, so the scuffs of the turns are turned under; the drill and
    /// the harvest do the headland first, to have room to turn. Then home
    /// along the headland. Never a turn sharper than a right angle:
    /// between one tile and the next the shortest way that keeps to that,
    /// looping round over worked ground where a ragged edge leaves no
    /// room to turn, and never onto a tile it could not get home from
    /// that way — a pocket too narrow to turn in — and a tile there is
    /// no such way to is left, and named.
    fn sweep(&self, farm: EntityId, yard: GridCoord, batch: &[GridCoord], job: Job) -> Option<(Vec<GridCoord>, Vec<GridCoord>)> {
        if batch.is_empty() {
            return None;
        }
        let set: HashSet<(i32, i32)> = batch.iter().map(|t| (t.x, t.y)).collect();
        let head: HashSet<(i32, i32)> = set.iter().copied().filter(|&(x, y)| AROUND.iter().any(|(dx, dy)| !set.contains(&(x + dx, y + dy)))).collect();
        let inside: Vec<GridCoord> = batch.iter().copied().filter(|t| !head.contains(&(t.x, t.y))).collect();
        // The inside in rows: each a run of inside tiles along a line, so
        // a line broken by a cutout is as many rows as it has runs. Along
        // whichever way breaks on fewer cutouts — past the farmstead, not
        // through its lot — and the long side when both break alike.
        let (x0, x1) = (inside.iter().map(|t| t.x).min().unwrap_or(0), inside.iter().map(|t| t.x).max().unwrap_or(-1));
        let (y0, y1) = (inside.iter().map(|t| t.y).min().unwrap_or(0), inside.iter().map(|t| t.y).max().unwrap_or(-1));
        let runs = |along_x: bool| -> (Vec<Vec<GridCoord>>, usize) {
            let mut rows: Vec<Vec<GridCoord>> = Vec::new();
            let mut breaks = 0;
            for r in if along_x { y0..=y1 } else { x0..=x1 } {
                let mut line: Vec<GridCoord> = inside.iter().copied().filter(|t| if along_x { t.y == r } else { t.x == r }).collect();
                line.sort_by_key(|t| if along_x { t.x } else { t.y });
                for (i, t) in line.into_iter().enumerate() {
                    match rows.last_mut() {
                        Some(row) if if along_x { row[0].y == t.y && t.x == row[row.len() - 1].x + 1 } else { row[0].x == t.x && t.y == row[row.len() - 1].y + 1 } => row.push(t),
                        _ => {
                            breaks += (i > 0) as usize;
                            rows.push(vec![t]);
                        }
                    }
                }
            }
            (rows, breaks)
        };
        let rows = match (runs(true), runs(false)) {
            ((x, xb), (_, yb)) if xb < yb || xb == yb && x1 - x0 >= y1 - y0 => x,
            (_, (y, _)) => y,
        };
        let ground = self.drivable(farm);
        let safe = escapable(&ground, yard);
        // The lot is where the tractor lives, not a way through: rows
        // are joined over the field and the lane, never the lot.
        let yard_tiles = self.yard_tiles(farm);
        let field: HashSet<(i32, i32)> = ground.iter().copied().filter(|t| !yard_tiles.iter().any(|y| (y.x, y.y) == *t)).collect();
        // A run of tiles driven on from the path's end, each arrived at
        // heading for the tile after when that is a step away, so the row
        // runs straight — else any way it can; over the run's own ground
        // first, then any. The tiles it never reached.
        let drive = |path: &mut Vec<GridCoord>, run: &[GridCoord], over: &HashSet<(i32, i32)>| -> usize {
            let mut skipped = 0;
            for (i, &t) in run.iter().enumerate() {
                let then = run.get(i + 1).copied().filter(|n| dist(t, *n) == 1);
                let leg = [then, None].into_iter().find_map(|heading| [over, &ground].into_iter().find_map(|g| self.over(g, &safe, path, t, heading, &AROUND)));
                match leg {
                    Some(leg) => path.extend(leg),
                    None => skipped += 1,
                }
            }
            skipped
        };
        // The headland, round: the nearest tile of it not yet driven from
        // where the tractor is, straight on before a turn, over the
        // headland itself where it can.
        let ring = |path: &mut Vec<GridCoord>| -> usize {
            let mut todo = head.clone();
            let mut skipped = 0;
            while !todo.is_empty() {
                let at = path[path.len() - 1];
                let (hx, hy) = if path.len() > 1 { (at.x - path[path.len() - 2].x, at.y - path[path.len() - 2].y) } else { (0, 0) };
                let &(x, y) = todo.iter().min_by_key(|&&(x, y)| (dist(at, GridCoord { x, y }), (x - at.x).abs() + (y - at.y).abs() - 2 * (hx * (x - at.x) + hy * (y - at.y)), x, y)).unwrap();
                todo.remove(&(x, y));
                match [&head, &ground].into_iter().find_map(|g| self.over(g, &safe, path, GridCoord { x, y }, None, &AROUND)) {
                    Some(leg) => path.extend(leg),
                    None => skipped += 1,
                }
            }
            skipped
        };
        // The rows, each the nearest left from where the last ended, from
        // whichever end is nearer.
        let inside_pass = |path: &mut Vec<GridCoord>| -> usize {
            let mut todo = rows.clone();
            let mut skipped = 0;
            while !todo.is_empty() {
                let at = path[path.len() - 1];
                let (_, i, from_end) = todo.iter().enumerate().map(|(i, r)| (dist(at, r[0]).min(dist(at, r[r.len() - 1])), i, dist(at, r[r.len() - 1]) < dist(at, r[0]))).min().unwrap();
                let mut run = todo.remove(i);
                if from_end {
                    run.reverse();
                }
                skipped += drive(path, &run, &field);
            }
            skipped
        };
        let mut path = vec![yard];
        let mut skipped = 0;
        if job == Job::Plough {
            skipped += inside_pass(&mut path);
            skipped += ring(&mut path);
        } else {
            skipped += ring(&mut path);
            skipped += inside_pass(&mut path);
        }
        // Home along the headland.
        let home = self.over(&head, &safe, &path, yard, None, &AROUND).or_else(|| self.over(&ground, &safe, &path, yard, None, &AROUND))?;
        path.extend(home);
        let _ = skipped;
        // What the whole run never reached.
        let left: Vec<GridCoord> = batch.iter().copied().filter(|t| !path.contains(t)).collect();
        Some((path, left))
    }

    /// The shortest drive on from a path to a tile over the given ground,
    /// the given ways, turning no sharper than a right angle — from the way
    /// the path's last step was heading, or any way from a standing start
    /// — and arriving, if a tile after is given, heading so that the step
    /// on to it is no sharper either, and always so that it can still get
    /// home (`safe`). The tiles after the path's last, the destination
    /// included; or none, if no such drive reaches it.
    fn over(&self, ground: &HashSet<(i32, i32)>, safe: &HashSet<State>, path: &[GridCoord], to: GridCoord, then: Option<GridCoord>, ways: &[(i32, i32)]) -> Option<Vec<GridCoord>> {
        let from = *path.last()?;
        let heading = match path.len() {
            0 | 1 => None,
            n => Some((from.x - path[n - 2].x, from.y - path[n - 2].y)),
        };
        let arrived = |way: Option<(i32, i32)>| match (way, then) {
            (Some((wx, wy)), Some(n)) => wx * (n.x - to.x) + wy * (n.y - to.y) >= 0,
            _ => true,
        };
        let start: State = ((from.x, from.y), heading);
        let mut came: std::collections::HashMap<State, State> = std::collections::HashMap::from([(start, start)]);
        let mut queue = VecDeque::from([start]);
        while let Some(state @ ((x, y), way)) = queue.pop_front() {
            if (x, y) == (to.x, to.y) && arrived(way) && way.is_none_or(|_| safe.contains(&state)) {
                let mut drive = Vec::new();
                let mut cur = state;
                while cur != start {
                    drive.push(GridCoord { x: cur.0 .0, y: cur.0 .1 });
                    cur = came[&cur];
                }
                drive.reverse();
                return Some(drive);
            }
            for &(dx, dy) in ways {
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
    /// standing. At the end of the run it is home, its path is the field
    /// as drawn, and the farm takes its turn for the next run.
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

/// Where the tractor is and how it got there: a tile and the way it came
/// onto it, or no way yet from a standing start. Its next step may turn
/// no sharper than a right angle from that way.
type State = ((i32, i32), Option<(i32, i32)>);

/// The states from which the tractor can still get to `home` over the
/// ground turning no sharper than a right angle: what it may drive onto
/// without being stuck. Found backwards from home, a step at a time.
fn escapable(ground: &HashSet<(i32, i32)>, home: GridCoord) -> HashSet<State> {
    let mut seen: HashSet<State> = AROUND.iter().map(|&d| ((home.x, home.y), Some(d))).collect();
    let mut queue: VecDeque<State> = seen.iter().copied().collect();
    while let Some(((x, y), Some((dx, dy)))) = queue.pop_front() {
        let before = (x - dx, y - dy);
        if !ground.contains(&before) {
            continue;
        }
        for (bx, by) in AROUND {
            if bx * dx + by * dy >= 0 && seen.insert((before, Some((bx, by)))) {
                queue.push_back((before, Some((bx, by))));
            }
        }
    }
    seen
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
        world.place_road_path(&(-4..60).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>());
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
    /// round its plot with the plot cut out, near enough square, as much
    /// as a shift ploughs and no more, all of it grass and none of it
    /// across the street; a road behind the plot is its edge and the
    /// field grows along it instead, with the road's side made up for; a house in the
    /// field is cut out and made up for; and a farm in the woods claims
    /// nothing.
    #[test]
    fn a_farm_claims_the_grass_behind_it() {
        let mut world = land();
        let (_, tiles) = farm_at(&mut world, 10);
        let wanted = capacity(BuildingKind::Farm) as usize;
        let (x0, y0, x1, y1, _) = rect(&tiles);
        assert_eq!(((x1 - x0 + 1) * (y1 - y0 + 1)) as usize, tiles.len() + 12, "the land is not the rectangle less the plot");
        assert!(tiles.len() <= wanted && tiles.len() + (x1 - x0 + 1).max(y1 - y0 + 1) as usize > wanted, "the farm claimed {} tiles of {wanted}", tiles.len());
        assert!((x1 - x0).abs_diff(y1 - y0) <= 1, "the field is {}x{}, not square", x1 - x0 + 1, y1 - y0 + 1);
        assert!(y0 == 1 && x0 < 10 && x1 > 12 && y1 > 4, "the field {x0},{y0}..{x1},{y1} is not round the plot");
        assert!(tiles.iter().all(|t| t.stage == Stage::Grass && world.is_open(t.at)));
        assert_eq!(world.laid, 0);
        // Bounded: a road four tiles behind the plot walls the land in,
        // and the field runs along the road instead.
        let mut walled = land();
        walled.place_road_path(&(-4..60).map(|x| GridCoord { x, y: 6 }).collect::<Vec<_>>());
        let (_, tiles) = farm_at(&mut walled, 10);
        let (_, y0, _, y1, _) = rect(&tiles);
        assert!(y0 == 1 && y1 == 5 && tiles.len() + 5 > wanted, "the walled-in field is {} tiles, y {y0}..{y1}", tiles.len());
        // A house in the field is cut out, and the field made up for it.
        let mut cramped = land();
        cramped.place_building(GridCoord { x: 4, y: 6 }, BuildingKind::House, 2);
        let (_, tiles) = farm_at(&mut cramped, 10);
        let (x0, y0, x1, y1, _) = rect(&tiles);
        assert!(tiles.len() + (x1 - x0 + 1).max(y1 - y0 + 1) as usize > wanted, "the house was not made up for: {} tiles", tiles.len());
        assert!(!tiles.iter().any(|t| t.at == GridCoord { x: 4, y: 6 }), "the house is land");
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

    /// The sweep, drawn: the plough's path over six shapes of ground —
    /// an open block behind the farm, land on both flanks, a field with
    /// a house in it, neighbours a tile away, and a coast running
    /// diagonally either way — printed as a grid so it can be looked at.
    /// `cargo test draw_the_sweep -- --nocapture`. Asserted: every step a
    /// neighbour of the last, nothing driven through the barn or the
    /// house, and few turns.
    #[test]
    fn draw_the_sweep() {
        for (name, shape) in [("open block", 0), ("both flanks", 1), ("a house in the field", 2), ("neighbours a tile away", 3), ("a diagonal coast", 4), ("a diagonal coast the other way", 5)] {
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
            if shape == 4 || shape == 5 {
                for y in -4..16 {
                    for x in -4..40 {
                        if (shape == 4 && x + y > 26) || (shape == 5 && x - y < 6) {
                            world.terrain.insert((x, y), TerrainType::Water);
                        }
                    }
                }
            }
            let farm = world.place_on_street(GridCoord { x: 14, y: 1 }, BuildingKind::Farm).unwrap();
            if shape == 3 {
                // Built after the farm, as a town grows: the alleys a tile
                // wide beside the plot and between the neighbours are
                // slivers, and fall away; what is left is the block behind.
                for x in [7, 10, 18, 21] {
                    world.place_on_street(GridCoord { x, y: 1 }, BuildingKind::Warehouse).unwrap();
                }
                world.tend(farm);
            }
            let batch: Vec<GridCoord> = tiles(&world, farm).iter().map(|t| t.at).collect();
            let gate = world.yard_gate(farm, &batch).unwrap();
            let (path, left) = world.sweep(farm, gate, &batch, Job::Seed).expect("a sweep");
            assert!(left.is_empty(), "{name}: tiles left: {left:?}");
            println!("{name}: {} tiles, {} steps seeding (drawn 130 at a time, 0-9a-z then round again, first visit only)", batch.len(), path.len());
            for from in (0..path.len()).step_by(130) {
            let mut grid: Vec<Vec<char>> = (0..20).map(|_| vec!['.'; 44]).collect();
            for t in &batch {
                grid[(t.y + 4) as usize][(t.x + 4) as usize] = ',';
            }
            for (i, t) in path.iter().enumerate().skip(from).take(130) {
                let c = if i == 0 { 'Y' } else { char::from_digit((i % 36) as u32, 36).unwrap() };
                let cell = &mut grid[(t.y + 4) as usize][(t.x + 4) as usize];
                if *cell == '.' || *cell == ',' {
                    *cell = c;
                }
            }
            let (x0, y0, x1, y1, _) = rect(&tiles(&world, farm));
            for y in y0..=y1 {
                for x in x0..=x1 {
                    let t = GridCoord { x, y };
                    if !world.is_open(t) && !world.yard_tiles(farm).contains(&t) {
                        grid[(y + 4) as usize][(x + 4) as usize] = '#';
                    }
                }
            }
            for row in grid.iter().skip(4) {
                println!("  {}", row.iter().collect::<String>());
            }
            println!();
            }
            let ground = world.drivable(farm);
            let set: HashSet<(i32, i32)> = batch.iter().map(|t| (t.x, t.y)).collect();
            // The headland is every tile touching something not field.
            let head = |t: &GridCoord| AROUND.iter().any(|(dx, dy)| !set.contains(&(t.x + dx, t.y + dy)));
            let (ploughing, _) = world.sweep(farm, gate, &batch, Job::Plough).expect("a sweep");
            for (job, path) in [("seeding", &path), ("ploughing", &ploughing)] {
                assert!(path.windows(2).all(|w| dist(w[0], w[1]) == 1), "{name} {job}: a step is not to a neighbour");
                assert!(path.iter().all(|t| ground.contains(&(t.x, t.y))), "{name} {job}: the tractor left the farm's ground");
                assert!(!sharp(path), "{name} {job}: a turn sharper than a right angle");
                assert!(batch.iter().all(|t| path.contains(t)), "{name} {job}: the sweep missed a tile");
                let turns = path.windows(3).filter(|w| (w[1].x - w[0].x, w[1].y - w[0].y) != (w[2].x - w[1].x, w[2].y - w[1].y)).count();
                let mut seen = HashSet::new();
                let again = path.iter().filter(|t| !seen.insert((t.x, t.y))).count();
                println!("  {job}: {turns} turns over {} steps, {again} tiles driven twice", path.len());
                assert!(again * 3 < path.len(), "{name} {job}: {again} of {} steps retrace", path.len());
            }
            // Seeding: the headland first, every tile of it — the coast and
            // the barn's edge with the outline — before the rows; the few
            // inside tiles crossed on the way to a ring round a house are
            // transit, with the drill up.
            let ring_done = batch.iter().filter(|t| head(t)).map(|t| path.iter().position(|p| p == t).unwrap()).max().unwrap();
            let crossed: HashSet<(i32, i32)> = path[..ring_done].iter().filter(|t| !head(t)).map(|t| (t.x, t.y)).collect();
            let inside = batch.iter().filter(|t| !head(t)).count();
            assert!(crossed.len() * 10 <= inside, "{name}: {} inside tiles driven before the headland was done", crossed.len());
            // Ploughing: the headland last, after the rows, but for the
            // transit home from a ring round a house.
            let ring_begun = batch.iter().filter(|t| head(t)).map(|t| ploughing.iter().rposition(|p| p == t).unwrap()).min().unwrap();
            let crossed: HashSet<(i32, i32)> = ploughing[ring_begun..].iter().filter(|t| !head(t)).map(|t| (t.x, t.y)).collect();
            assert!(crossed.len() * 10 <= inside, "{name}: {} inside tiles driven after the plough began the headland", crossed.len());
        }
    }

    /// Another farm's land is not open to a farm: a second farm placed
    /// beside the first, where the first's land already lies, claims none
    /// of it and grows the other way instead.
    #[test]
    fn a_farm_keeps_off_its_neighbours_land() {
        let mut world = land();
        let (_, ours) = farm_at(&mut world, 10);
        let (_, theirs) = farm_at(&mut world, 20);
        assert!(!theirs.iter().any(|t| ours.iter().any(|o| o.at == t.at)), "the second farm claimed the first's land");
        assert!(theirs.len() * 2 > capacity(BuildingKind::Farm) as usize, "the second farm has only {} tiles", theirs.len());
    }

    /// A farm placed over a road's stub is served from the start, and is
    /// reached all the same: its tractor and its land come with it.
    #[test]
    fn a_farm_placed_over_a_stub_gets_its_tractor() {
        let mut world = land();
        let (first, _) = farm_at(&mut world, 10);
        let (pos, facing) = match world.objects.get(first) {
            Some(e) => (e.position.unwrap(), match e.object { GameObject::Building(ref b) => b.facing, _ => unreachable!() }),
            None => unreachable!(),
        };
        let door = world.road_node_for_building(first).and_then(|n| world.objects.get(n)).and_then(|e| e.position).expect("a driveway");
        world.remove_building(first);
        world.place_road_path(&[GridCoord { x: door.x, y: 0 }, door]);
        let farm = world.place_building(pos, BuildingKind::Farm, facing).expect("a farm over the stub");
        assert!(world.road_node_for_building(farm).is_some(), "the stub is not the farm's driveway");
        world.attach_driveway(farm);
        tractor(&world, farm);
        assert!(!tiles(&world, farm).is_empty(), "the farm claimed no land");
    }

    /// A farm placed with no street beside it stands dormant; a road drawn
    /// to it later reaches it, and its tractor and its land come then.
    #[test]
    fn a_farm_reached_later_gets_its_tractor() {
        let mut world = land();
        let farm = world.place_building(GridCoord { x: 10, y: 4 }, BuildingKind::Farm, 0).expect("a farm off the street");
        assert!(world.road_node_for_building(farm).is_none());
        assert!(world.objects.iter().all(|e| !matches!(e.object, GameObject::Car(ref c) if c.owner == farm)), "a tractor before any road");
        world.place_road_path(&(0..=3).map(|y| GridCoord { x: 11, y }).collect::<Vec<_>>());
        println!("node {:?} land {}", world.road_node_for_building(farm), tiles(&world, farm).len());
        tractor(&world, farm);
        assert!(!tiles(&world, farm).is_empty(), "the farm claimed no land");
    }

    /// The farm from the save of 2026-09-15: seed 7, a diagonal highway on
    /// both flanks a tile off the plot, the farm placed beside it and
    /// reached by a driveway drawn later. Its tractor stands in a dock,
    /// and its land, though both flanks are lane and not field, lies
    /// behind the barn across the lane.
    #[test]
    fn the_farm_by_the_diagonal_highway() {
        let mut world = World::new();
        world.terrain = crate::terrain::generate(7);
        world.place_road_path_of(&[(57, 46), (58, 45), (59, 44), (60, 43), (61, 42)].map(|(x, y)| GridCoord { x, y }), true);
        world.place_road_path_of(&[(61, 42), (62, 43), (62, 44), (63, 45), (64, 46), (65, 47)].map(|(x, y)| GridCoord { x, y }), true);
        let farm = world.place_building(GridCoord { x: 60, y: 45 }, BuildingKind::Farm, 0).expect("the farm");
        assert!(world.road_node_for_building(farm).is_none(), "served before any driveway");
        world.place_road_path(&[GridCoord { x: 60, y: 43 }, GridCoord { x: 61, y: 44 }, GridCoord { x: 61, y: 45 }]);
        let t = tractor(&world, farm);
        assert!(matches!(world.objects.get(t).map(|e| &e.object), Some(GameObject::Car(c)) if c.spot.is_some()), "the tractor has no spot");
        let land = tiles(&world, farm);
        assert!(land.len() * 2 > capacity(BuildingKind::Farm) as usize, "the farm claimed only {} tiles", land.len());
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
    /// path stays on the farm's record. A yard with no room leaves the
    /// crop standing.
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
        let (path, left) = world.sweep(farm, pos, &batch, job).expect("a sweep");
        assert!(left.is_empty(), "tiles left: {left:?}");
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
        assert_eq!(match world.objects.get(farm).unwrap().object { GameObject::Building(ref b) => b.ruts.clone(), _ => unreachable!() }, path, "the run's path was not kept");
        // The seed, then nothing until the crop is ripe.
        let (job, batch) = world.batch(farm, now).expect("a job");
        assert_eq!((job, batch.len()), (Job::Seed, tiles.len()));
        let (path, _) = world.sweep(farm, pos, &batch, job).unwrap();
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
        let (path, _) = world.sweep(farm, pos, &batch, job).unwrap();
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
