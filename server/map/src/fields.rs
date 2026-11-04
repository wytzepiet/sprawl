//! A farm's land, and the tractor's runs over it. docs/buildings.md, Making things.
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
//! plough and the drill taking the rows first and the ring last, the
//! harvest the ring first; and home along the headland, never turning
//! sharper than a right angle. Off the roads
//! entirely: a run is a list of tiles and a pace, no route, no claims, no
//! queue. A tile the mayor builds or roads over is dropped at the farm's
//! next look, and another farm's land is never claimed: first claim wins.
//! The tractor's last path stays on the farm's record: it is where the
//! field is drawn.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, VecDeque};
use fixed::HashSet;

use model::GameTime;
use model::{CarRole, EntityId, GameObject, GridCoord, Job, Run, Stage, Tile, DAY_MS};
use crate::Map;

/// How long the tractor takes to cross a tile, working it: two and a
/// half minutes of the game's clock, two seconds watched at full speed,
/// so a shift's ploughing is a couple of hundred tiles.
pub const PACE: GameTime = DAY_MS as GameTime / 600;
/// A crop sown by the end of a shift stands a day and is ripe the
/// morning after: a day and a half.
pub const RIPEN: GameTime = DAY_MS as GameTime * 3 / 2;
/// The tiles a shift's ploughing makes a farm of, on open ground: the
/// shift over the pace, less the ground driven between rows. What a
/// farm's land comes to at capacity, and what its yard is divided by.
pub fn capacity(kind: model::BuildingKind) -> f64 {
    (model::blueprint::shift_hours(kind) * model::HOUR as f64 / PACE as f64 * 0.9).round()
}

/// The eight ways off a tile: straight first, then the diagonals.
const AROUND: [(i32, i32); 8] = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)];

impl Map {
    /// Open grass with nothing on it: what a farm claims, and what a tile
    /// of its land stays while it is one.
    fn is_open(&self, t: GridCoord) -> bool {
        self.is_buildable(t) && self.terrain.get(&(t.x, t.y)) == Some(&land::TerrainType::Grass)
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
        let GameObject::Building(b) = &e.object else { return };
        let (kind, facing) = (b.kind, b.facing);
        let wanted = capacity(kind) as usize;
        if !model::blueprint::farm(kind) || !b.land.is_empty() {
            return;
        }
        let _ = facing;
        let (pos, (w, h)) = Self::bounds(&b.tiles);
        let (w, h) = (w as i32, h as i32);
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
        if let Some(b) = self.building_mut(farm) {
            b.land = land.into_iter().map(|at| Tile { at, stage: Stage::Grass, since: 0 }).collect();
        }
    }

    /// The open tiles within some ground the tractor can reach from the
    /// gate, four ways.
    fn reach(&self, farm: EntityId, within: &dyn Fn(GridCoord) -> bool) -> HashSet<(i32, i32)> {
        let gate = self.gate(farm);
        let mut seen: HashSet<(i32, i32)> = gate.iter().map(|t| (t.x, t.y)).collect();
        let mut queue: VecDeque<GridCoord> = gate.into_iter().collect();
        let mut reached: HashSet<(i32, i32)> = HashSet::default();
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
            let wide = |&(x, y): &(i32, i32)| [(-1, -1), (-1, 0), (0, -1), (0, 0)].iter().any(|(ox, oy)| (0..2).all(|i| (0..2).all(|j| field.contains(&(x + ox + i, y + oy + j)))));
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
        let Some(b) = self.building(farm) else { return };
        let had: HashSet<(i32, i32)> = b.land.iter().map(|t| (t.at.x, t.at.y)).collect();
        let keep: HashSet<(i32, i32)> = self.workable(farm, |t| had.contains(&(t.x, t.y))).into_iter().map(|t| (t.x, t.y)).collect();
        if keep.len() != had.len()
            && let Some(b) = self.building_mut(farm)
        {
            b.land.retain(|t| keep.contains(&(t.at.x, t.at.y)));
        }
    }

    /// The tractor's next job, and the tiles that want it: the harvest,
    /// once every sown tile is ripe and the yard has room for a crop;
    /// else the plough, for grass and stubble; else the seed, for bare
    /// ground. A batch is complete or it waits, so that one run takes it
    /// all and the cycle keeps in step.
    pub fn batch(&self, farm: EntityId, now: GameTime) -> Option<(Job, Vec<GridCoord>)> {
        let Some(b) = self.building(farm) else { return None };
        let tiles = |stage: Stage| -> Vec<GridCoord> { b.land.iter().filter(|t| t.stage == stage).map(|t| t.at).collect() };
        let sown = tiles(Stage::Sown);
        if !sown.is_empty() {
            let ripe = b.land.iter().filter(|t| t.stage == Stage::Sown).all(|t| now >= t.since + RIPEN);
            let room = model::blueprint::blueprint(b.kind).makes.and_then(|m| b.stocks.get(&m)).is_some_and(|s| s.short() + 1e-6 >= model::blueprint::crop(b.kind, b.land.len()));
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

    /// The cycle played at once, for a fixture to show: each job a whole
    /// run over the tiles it wants, done at the time given, the last run's
    /// path the farm's ruts; then, if given, the tractor out on the next
    /// job, that share of its run driven, the tiles behind it done.
    pub fn play(&mut self, farm: EntityId, jobs: &[(Job, GameTime)], going: Option<(Job, f64)>, now: GameTime) {
        let wants = |job: Job, stage: Stage| matches!((job, stage), (Job::Plough, Stage::Grass | Stage::Cut) | (Job::Seed, Stage::Ploughed) | (Job::Harvest, Stage::Sown));
        let done = |job: Job| match job {
            Job::Plough => Stage::Ploughed,
            Job::Seed => Stage::Sown,
            Job::Harvest => Stage::Cut,
        };
        let run = |world: &Map, job: Job| {
            let Some(b) = world.building(farm) else { return None };
            let batch: Vec<GridCoord> = b.land.iter().filter(|t| wants(job, t.stage)).map(|t| t.at).collect();
            let yard = world.gate(farm)?;
            world.sweep(farm, yard, &batch, job).map(|(path, _)| path)
        };
        let work = |world: &mut Map, job: Job, tiles: &[GridCoord], at: GameTime| {
            if let Some(b) = world.building_mut(farm) {
                for t in b.land.iter_mut().filter(|t| wants(job, t.stage) && tiles.contains(&t.at)) {
                    (t.stage, t.since) = (done(job), at);
                }
            }
        };
        for &(job, at) in jobs {
            let Some(path) = run(self, job) else { return };
            work(self, job, &path, at);
            if let Some(b) = self.building_mut(farm) {
                b.ruts = path;
            }
        }
        let Some((job, share)) = going else { return };
        let Some(path) = run(self, job) else { return };
        let k = ((path.len() - 1) as f64 * share) as usize;
        work(self, job, &path[..=k], now);
        let Some(tractor) = self.objects.fleet(farm).find(|&c| self.car(c).is_some_and(|c| c.role == CarRole::Tractor)) else { return };
        self.release_spot(tractor);
        self.update_position(tractor, path[k]);
        if let Some(c) = self.car_mut(tractor) {
            c.spot = None;
            c.run = Some(Run { job, path, started: now - k as GameTime * PACE, pace: PACE });
        }
    }

    /// The tiles the tractor may drive: the farm's land, its gate, and the
    /// lane. Never the yard or the rest of the barn row.
    pub fn drivable(&self, farm: EntityId) -> HashSet<(i32, i32)> {
        let mut ground: HashSet<(i32, i32)> = self.gate(farm).into_iter().map(|t| (t.x, t.y)).collect();
        if let Some(b) = self.building(farm) {
            ground.extend(b.land.iter().map(|t| (t.at.x, t.at.y)));
        }
        ground.extend(self.lane(farm));
        ground
    }

    /// The lane: the open ground round the plot, which is how the tractor
    /// gets from the yard at the street to the field behind the barn.
    fn lane(&self, farm: EntityId) -> HashSet<(i32, i32)> {
        let Some(e) = self.objects.get(farm) else { return HashSet::default() };
        let GameObject::Building(b) = &e.object else { return HashSet::default() };
        b.tiles.iter()
            .flat_map(|t| AROUND.iter().map(move |(dx, dy)| GridCoord { x: t.x + dx, y: t.y + dy }))
            .filter(|&n| self.is_open(n))
            .map(|n| (n.x, n.y))
            .collect()
    }

    /// Where a run leaves the farm and comes back to it: the middle of
    /// the barn's back row, so the tractor goes out to the fields behind
    /// and round, never through the yard to the street side.
    pub fn gate(&self, farm: EntityId) -> Option<GridCoord> {
        let Some(e) = self.objects.get(farm) else { return None };
        let GameObject::Building(b) = &e.object else { return None };
        let (pos, p) = Self::lie(&b.tiles, b.kind, b.facing);
        let ((bx, by), (bw, bh)) = p.building;
        let (fx, fy) = model::blueprint::FACINGS[b.facing as usize % 4];
        let back = |street: i32, size: u8| match street {
            0 => size / 2,
            1 => 0,
            _ => size - 1,
        };
        Some(GridCoord { x: pos.x + (bx + back(fx, bw)) as i32, y: pos.y + (by + back(fy, bh)) as i32 })
    }

    /// A run over a batch of tiles as a farmer drives one, in two passes.
    /// The headland is every tile with a side on something that is not
    /// field — the outside, the coast, the barn and the lane, a house in
    /// the middle — driven round as a ring, each outline of the field
    /// followed tile by tile. The inside is the rest, in straight rows
    /// along the grain, worked block by block, back and forth, each row
    /// driven right out onto the headland and turned there, plough up.
    /// On the diagonal only where an edge runs diagonally. The plough and the drill do the rows first
    /// and the headland last, as a farmer does, so the scuffs of the turns
    /// are turned under and no turn is made on fresh seed; the harvest
    /// does the headland first, to have room to turn. Then home along the
    /// headland. Never a turn sharper than a right angle, and never onto a
    /// tile it could not get home from that way — a pocket too narrow to
    /// turn in — and a tile there is no such way to is left, and named.
    /// `bun run fields` drives it over the fields in `server/fields/`.
    pub fn sweep(&self, farm: EntityId, yard: GridCoord, batch: &[GridCoord], job: Job) -> Option<(Vec<GridCoord>, Vec<GridCoord>)> {
        if batch.is_empty() {
            return None;
        }
        let set: HashSet<(i32, i32)> = batch.iter().map(|t| (t.x, t.y)).collect();
        let outlines = outlines(&set);
        let head: HashSet<(i32, i32)> = outlines.iter().flatten().map(|t| (t.x, t.y)).collect();
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
        let (rows, along_x) = match (runs(true), runs(false)) {
            ((x, xb), (_, yb)) if xb < yb || xb == yb && x1 - x0 >= y1 - y0 => (x, true),
            (_, (y, _)) => (y, false),
        };
        // The rows in blocks, as a farmer works a field something stands
        // in: a block is rows side by side, each beside the last along most
        // of it, and it goes on until a row meets two, or two meet one, where
        // something in the field splits it or the halves join again. Each
        // block is worked through, back and forth, before the next.
        let line = |t: GridCoord| if along_x { t.y } else { t.x };
        let span = |r: &[GridCoord]| {
            let (a, b) = if along_x { (r[0].x, r[r.len() - 1].x) } else { (r[0].y, r[r.len() - 1].y) };
            (a.min(b), a.max(b))
        };
        let meets = |a: &[GridCoord], b: &[GridCoord]| line(a[0]) + 1 == line(b[0]) && span(a).0 <= span(b).1 && span(b).0 <= span(a).1;
        let mut blocks: Vec<Vec<Vec<GridCoord>>> = Vec::new();
        for row in &rows {
            let above: Vec<usize> = (0..blocks.len()).filter(|&i| meets(blocks[i].last().unwrap(), row)).collect();
            let alone = |i: usize| rows.iter().filter(|r| meets(blocks[i].last().unwrap(), r)).count() == 1;
            match above[..] {
                [i] if alone(i) => blocks[i].push(row.clone()),
                _ => blocks.push(vec![row.clone()]),
            }
        }
        let ground = self.drivable(farm);
        let safe = escapable(&ground, yard);
        // A run of tiles driven on from the path's end, each arrived at
        // heading for the tile after when that is a step away, so the row
        // runs straight — else any way it can; keeping to the given way
        // where it can. A tile it cannot get to is passed over.
        let drive = |path: &mut Vec<GridCoord>, run: &[GridCoord], way: &HashSet<(i32, i32)>| {
            for (i, &t) in run.iter().enumerate() {
                let then = run.get(i + 1).copied().filter(|n| dist(t, *n) == 1);
                if let Some(leg) = [then, None].into_iter().find_map(|heading| Self::over(&ground, way, &safe, path, t, heading)) {
                    path.extend(leg);
                }
            }
        };
        // The headland, round: each outline in turn, the nearest first,
        // driven from its tile nearest the tractor all the way round, over
        // the headland itself where it can. The outline by the yard is
        // where the run sets out or comes home: first from the yard, else
        // last, so the run ends beside the gate.
        let by_yard = (0..outlines.len()).min_by_key(|&i| outlines[i].iter().map(|&t| dist(t, yard)).min()).unwrap_or(0);
        let ring = |path: &mut Vec<GridCoord>| {
            let mut todo: Vec<(bool, Vec<GridCoord>)> = outlines.iter().enumerate().map(|(i, o)| (i == by_yard, o.clone())).collect();
            let from_yard = path.len() == 1;
            while !todo.is_empty() {
                let at = path[path.len() - 1];
                let wait = !from_yard && todo.len() > 1;
                let (_, i, k) = todo.iter().enumerate().filter(|(_, (outer, _))| !(wait && *outer)).flat_map(|(i, (_, o))| o.iter().enumerate().map(move |(k, t)| (dist(at, *t), i, k))).min().unwrap();
                let (_, mut outline) = todo.remove(i);
                outline.rotate_left(k);
                outline.dedup();
                drive(path, &outline, &head);
            }
        };
        // The rows, block by block.
        let inside_pass = |path: &mut Vec<GridCoord>| {
            let mut todo = blocks.clone();
            // The nearest block from where the tractor is, from whichever
            // side of it is nearer; then its rows in turn, each from its
            // end nearer the last, so they go back and forth.
            let near = |at: GridCoord, r: &[GridCoord]| dist(at, r[0]).min(dist(at, r[r.len() - 1]));
            let mut runs: Vec<Vec<GridCoord>> = Vec::new();
            let mut at = path[path.len() - 1];
            while !todo.is_empty() {
                let (_, i, from_last) = todo.iter().enumerate().map(|(i, b)| (near(at, &b[0]).min(near(at, &b[b.len() - 1])), i, near(at, &b[b.len() - 1]) < near(at, &b[0]))).min().unwrap();
                let mut block = todo.remove(i);
                if from_last {
                    block.reverse();
                }
                for mut run in block {
                    if dist(at, run[run.len() - 1]) < dist(at, run[0]) {
                        run.reverse();
                    }
                    at = run[run.len() - 1];
                    runs.push(run);
                }
            }
            // Each driven right out onto the headland at both ends, and
            // turned there, plough up, into the next: never a turn on the
            // rows themselves.
            let (ax, ay) = if along_x { (1, 0) } else { (0, 1) };
            for mut run in runs {
                let (a, b) = (run[0], run[run.len() - 1]);
                let s = if (b.x - a.x) * ax + (b.y - a.y) * ay >= 0 { 1 } else { -1 };
                run.insert(0, GridCoord { x: a.x - s * ax, y: a.y - s * ay });
                run.push(GridCoord { x: b.x + s * ax, y: b.y + s * ay });
                drive(path, &run, &head);
            }
        };
        let mut path = vec![yard];
        if job == Job::Harvest {
            ring(&mut path);
            inside_pass(&mut path);
        } else {
            inside_pass(&mut path);
            ring(&mut path);
        }
        // Home along the headland where it can.
        let home = Self::over(&ground, &head, &safe, &path, yard, None)?;
        path.extend(home);
        // What the whole run never reached.
        let left: Vec<GridCoord> = batch.iter().copied().filter(|t| !path.contains(t)).collect();
        Some((path, left))
    }

    /// The shortest drive on from a path to a tile over the farm's ground,
    /// a step off the `way` it is given counting three on it, so the drive
    /// keeps to that way where it can and cuts across where that saves —
    /// turning no sharper than a right angle from the way the path's last
    /// step was heading, or any way from a standing start, and arriving, if
    /// a tile after is given, heading so that the step on to it is no
    /// sharper either, and always so that it can still get home (`safe`).
    /// The tiles after the path's last, the destination included; or none,
    /// if no such drive reaches it.
    fn over(ground: &HashSet<(i32, i32)>, way: &HashSet<(i32, i32)>, safe: &HashSet<State>, path: &[GridCoord], to: GridCoord, then: Option<GridCoord>) -> Option<Vec<GridCoord>> {
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
        let mut came: fixed::HashMap<State, (u32, State)> = fixed::HashMap::from_iter([(start, (0, start))]);
        let mut queue = BinaryHeap::from([Reverse((0, start))]);
        while let Some(Reverse((cost, state @ ((x, y), heading)))) = queue.pop() {
            if came[&state].0 < cost {
                continue;
            }
            if (x, y) == (to.x, to.y) && arrived(heading) && heading.is_none_or(|_| safe.contains(&state)) {
                let mut drive = Vec::new();
                let mut cur = state;
                while cur != start {
                    drive.push(GridCoord { x: cur.0 .0, y: cur.0 .1 });
                    cur = came[&cur].1;
                }
                drive.reverse();
                return Some(drive);
            }
            for (dx, dy) in AROUND {
                if heading.is_some_and(|(hx, hy)| hx * dx + hy * dy < 0) {
                    continue;
                }
                if !square(ground, path[0], (x, y), (dx, dy)) {
                    continue;
                }
                let n = (x + dx, y + dy);
                let next: State = (n, Some((dx, dy)));
                let on = n == (to.x, to.y) || way.contains(&n);
                let cost = cost + if on { 1 } else { 3 };
                if (on || ground.contains(&n)) && came.get(&next).is_none_or(|&(c, _)| cost < c) {
                    came.insert(next, (cost, state));
                    queue.push(Reverse((cost, next)));
                }
            }
        }
        None
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
        if !square(ground, home, before, (dx, dy)) {
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

/// The edges of a piece of land, each a ring of the tiles along it in
/// order, the land on the right: its outside, and round each hole in it.
/// A tile is on an edge if a side of it is: one touching the land's edge
/// only at a corner is inside. Followed side by side, so a ragged edge is
/// followed tile by tile, in and out, and a step's two tiles both.
fn outlines(land: &HashSet<(i32, i32)>) -> Vec<Vec<GridCoord>> {
    const SIDES: [(i32, i32); 4] = [(1, 0), (0, 1), (-1, 0), (0, -1)];
    let mut sides: Vec<((i32, i32), (i32, i32))> = land.iter().flat_map(|&(x, y)| SIDES.iter().filter(move |(dx, dy)| !land.contains(&(x + dx, y + dy))).map(move |&d| ((x, y), d))).collect();
    sides.sort();
    let mut done: HashSet<((i32, i32), (i32, i32))> = HashSet::default();
    let mut rings = Vec::new();
    for &first in &sides {
        if done.contains(&first) {
            continue;
        }
        let mut ring = Vec::new();
        let mut side = first;
        while done.insert(side) {
            let ((x, y), (dx, dy)) = side;
            if ring.last() != Some(&GridCoord { x, y }) {
                ring.push(GridCoord { x, y });
            }
            // Along the side, the land on the right: on to the tile ahead,
            // round the corner onto the tile ahead and out, or round this
            // tile's own corner.
            let (ax, ay) = (-dy, dx);
            let ahead = (x + ax, y + ay);
            let out = (ahead.0 + dx, ahead.1 + dy);
            side = if !land.contains(&ahead) {
                ((x, y), (ax, ay))
            } else if land.contains(&out) {
                (out, (-ax, -ay))
            } else {
                (ahead, (dx, dy))
            };
        }
        if ring.len() > 1 && ring.first() == ring.last() {
            ring.pop();
        }
        rings.push(ring);
    }
    rings
}

/// Whether a step keeps to the lie of the ground: straight, or on the
/// diagonal only along an edge that runs diagonally — past a missing
/// corner the ground goes on missing along that diagonal, as a coast or
/// a road on the slant does — never across the corner of a square edge
/// or squeezed between two things; and never into or out of the gate,
/// which is driven through straight.
fn square(ground: &HashSet<(i32, i32)>, gate: GridCoord, (x, y): (i32, i32), (dx, dy): (i32, i32)) -> bool {
    if dx == 0 || dy == 0 {
        return true;
    }
    if [(x, y), (x + dx, y + dy)].contains(&(gate.x, gate.y)) {
        return false;
    }
    let missing = |(tx, ty): (i32, i32)| !ground.contains(&(tx, ty));
    let slant = |(cx, cy): (i32, i32)| missing((cx - dx, cy - dy)) || missing((cx + dx, cy + dy));
    match (missing((x + dx, y)), missing((x, y + dy))) {
        (true, false) => slant((x + dx, y)),
        (false, true) => slant((x, y + dy)),
        _ => false,
    }
}

/// Steps between two tiles, eight ways: the longer of the two distances.
fn dist(a: GridCoord, b: GridCoord) -> i32 {
    (a.x - b.x).abs().max((a.y - b.y).abs())
}

#[cfg(test)]
mod bench;

#[cfg(test)]
mod tests {
    use super::*;
    use model::BuildingKind;
    use land::TerrainType;

    /// Grass either side of a street along y = 0, deep enough for a farm
    /// and its land.
    fn land() -> Map {
        let mut world = Map::new();
        for y in -12..24 {
            for x in -4..60 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        world.place_road_path(&(-4..60).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>());
        world
    }

    fn farm_at(world: &mut Map, x: i32) -> (EntityId, Vec<Tile>) {
        let farm = world.place_on_street(GridCoord { x, y: 1 }, BuildingKind::Farm).unwrap();
        (farm, tiles(world, farm))
    }

    fn tiles(world: &Map, farm: EntityId) -> Vec<Tile> {
        match world.objects.get(farm).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.land.clone(),
            _ => Vec::new(),
        }
    }

    fn tractor(world: &Map, farm: EntityId) -> EntityId {
        world.objects.fleet(farm).next().expect("a tractor in the yard")
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
        assert_eq!(((x1 - x0 + 1) * (y1 - y0 + 1)) as usize, tiles.len() + 9, "the land is not the rectangle less the plot");
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
        let door = world.door_of(first).expect("a door").0;
        world.remove_building(first);
        world.place_road_path(&[GridCoord { x: door.x, y: 0 }, door]);
        let farm = world.place_building(pos, BuildingKind::Farm, facing).expect("a farm over the stub");
        world.finish(farm);
        assert_eq!(world.door_of(farm).map(|d| d.0), Some(door), "the stub is the farm's door");
        assert!(world.road_node_at(door).is_none(), "and no road on its tile");
        world.orient(farm);
        tractor(&world, farm);
        assert!(!tiles(&world, farm).is_empty(), "the farm claimed no land");
    }

    /// A farm placed with no street beside it stands dormant; a road drawn
    /// to it later reaches it, and its tractor and its land come then.
    #[test]
    fn a_farm_reached_later_gets_its_tractor() {
        let mut world = land();
        let farm = world.place_building(GridCoord { x: 10, y: 4 }, BuildingKind::Farm, 0).expect("a farm off the street");
        world.finish(farm);
        assert!(world.street_of(farm).is_none());
        assert!(world.objects.fleet(farm).next().is_none(), "a tractor before any road");
        world.place_road_path(&(0..=3).map(|y| GridCoord { x: 11, y }).collect::<Vec<_>>());
        println!("node {:?} land {}", world.street_of(farm), tiles(&world, farm).len());
        tractor(&world, farm);
        assert!(!tiles(&world, farm).is_empty(), "the farm claimed no land");
    }

    /// The farm from the save of 2026-09-15: a diagonal highway on both
    /// flanks a tile off the plot, on open grass, the farm placed beside
    /// it and reached by a door drawn later. Its tractor stands in a dock,
    /// and its land, though both flanks are lane and not field, lies
    /// behind the barn across the lane.
    #[test]
    fn the_farm_by_the_diagonal_highway() {
        let mut world = Map::new();
        world.terrain = (40..80).flat_map(|x| (30..60).map(move |y| ((x, y), TerrainType::Grass))).collect();
        world.place_road_path_of(&[(57, 46), (58, 45), (59, 44), (60, 43), (61, 42)].map(|(x, y)| GridCoord { x, y }), true);
        world.place_road_path_of(&[(61, 42), (62, 43), (62, 44), (63, 45), (64, 46), (65, 47)].map(|(x, y)| GridCoord { x, y }), true);
        let farm = world.place_building(GridCoord { x: 60, y: 45 }, BuildingKind::Farm, 0).expect("the farm");
        world.finish(farm);
        assert!(world.street_of(farm).is_none(), "served before any door");
        world.place_road_path(&[GridCoord { x: 60, y: 43 }, GridCoord { x: 61, y: 44 }]);
        world.place_road_at(GridCoord { x: 61, y: 44 }, 0, crate::decks::MIDDLE, GridCoord { x: 61, y: 45 }, 0, crate::decks::MIDDLE, false, false);
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

}
