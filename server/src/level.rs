//! A puzzle level: a piece of map with roads coming in at its edges, the
//! traffic that wants to get from one to another, and the player's roads in
//! between, scored by how well the traffic flows for how little asphalt
//! (`docs/plan-interchange.md`).
//!
//! A level is a fixture's text (`fixtures.rs`) with its gates drawn on the
//! map as digits on the edge, and lines starting with `@` saying what they
//! are and what wants to go where:
//!
//! ```text
//! # Crossing
//! @gate 1 in        cars come in here (a one-way, inward)
//! @gate 2 out       and leave here (a one-way, outward)
//! @gate 3 both      a two-way: in and out
//! @gate 4 in2       a one-way of two lanes, inward (`out2` outward)
//! @want 1 2 12      twelve cars a minute from 1 to 2
//! @at 2 1           where it lies on the map of levels (the client's)
//! ```
//!
//! After the map, our own solve, if the level has one: the map again, each
//! row behind a `%`, with `=` on every tile of road it lays, `#` of
//! priority road, `*` a junction with lights, and `<` `>` `^` `v` a
//! one-way, the way it runs as the map is read, on to the tile it points
//! at. Rows behind `%#` are an overlay: its `#` tiles are priority road,
//! one-ways among them. Its tiles are the level's par, and it is the
//! level's test: it must carry the traffic. A level with none is open:
//! nothing to measure against but the traffic itself, so it scores the
//! flow alone, and the asphalt is the player's own to keep down.
//!
//! A gate is a stub of road from its edge tile out past the map's edge,
//! two tiles beyond it: cars appear at its far end and leave from there.
//! Its tiles are the level's, not the player's: they cannot be pulled up,
//! and nothing may be built outside the map.
//!
//! The level drives a `Game` it does not own: before each step of time it
//! sets off whoever is due and counts whoever arrived. While the player
//! builds, the traffic runs for the sight of it; a test runs it for
//! `TEST_MS` from empty roads, every car counted, and ends early in a jam.

use std::collections::VecDeque;
use crate::fixed::HashMap;

use crate::fixed::SmallRng;
use rand::{Rng, SeedableRng};
use serde::Serialize;
use ts_rs::TS;

use crate::car::CRUISE_SPEED;
use crate::engine::GameTime;
use crate::game::Game;
use crate::protocol::{Build, Car, CarRole, EntityId, GameObject, GridCoord, Tool};
use crate::world::World;
use crate::world::decks::MIDDLE;

/// How long a test runs, in simulated time.
pub const TEST_MS: GameTime = 4 * 60_000;
/// How many cars may wait at a gate before the road is called jammed: they
/// cannot get on, because the road beyond is full.
const JAM_QUEUE: usize = 8;
/// How long the traffic may stand without anyone arriving, cars on the
/// road, before it is called jammed.
const JAM_STILL_MS: GameTime = 40_000;
/// The solve's overlay of priority tiles, as its rows are read.
const PRIORITY: u8 = u8::MAX;
/// The highest a road stands (`decks.rs`).
const TOP_H: u8 = crate::world::decks::TOP;
/// What a junction's lights cost, in tiles of road.
pub const LIGHT_COST: u32 = 4;
/// How far a gate's stub runs past the map's edge.
const STUB: i32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub enum Phase {
    /// The player builds; cars drive what there is, for the sight of it.
    Build,
    /// The traffic runs, timed, from empty roads.
    Test,
    /// A test that jammed.
    Jammed,
    /// A test that ran its time: scored.
    Done,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Way {
    In,
    Out,
    Both,
}

/// A gate's lanes: one, or two (`in2`, `out2`).
type Lanes = bool;

struct Gate {
    label: char,
    /// Its tile on the map's edge, and the stub's far end, past it.
    edge: GridCoord,
    end: GridCoord,
    way: Way,
}

struct Want {
    from: usize,
    to: usize,
    per_min: f64,
}

/// One kind of trip's count in a test.
#[derive(Clone, Copy, Default)]
struct Tally {
    due: u32,
    delivered: u32,
    /// What the trips would have taken on empty roads, and what they took,
    /// summed, in ms. A car still waiting or still driving counts what it
    /// has taken so far.
    ideal_ms: f64,
    taken_ms: f64,
}

/// A gate as the client draws it.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct GateView {
    pub label: String,
    pub x: i32,
    pub y: i32,
    /// The stub's far end, past the map's edge.
    pub end_x: i32,
    pub end_y: i32,
    pub ins: bool,
    pub outs: bool,
    /// Cars due here that could not get on the road yet.
    pub waiting: u32,
}

/// What wants to get from one gate to another, and how it is going.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct WantView {
    pub from: String,
    pub to: String,
    pub per_min: f64,
    /// Whether any road joins them yet, as the cars would drive it.
    pub joined: bool,
    pub due: u32,
    pub delivered: u32,
}

/// Everything the client shows of a level.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct LevelState {
    pub name: String,
    pub title: String,
    /// The map's corners, in the game's tiles, inclusive.
    pub min_x: i32,
    pub min_y: i32,
    pub max_x: i32,
    pub max_y: i32,
    pub phase: Phase,
    /// How far into the test, and how long it runs, in ms.
    #[ts(type = "number")]
    pub test_ms: u64,
    #[ts(type = "number")]
    pub test_total_ms: u64,
    /// What the player's roads cost, in tiles of ground road (`Level::cost`),
    /// and what our own solve's did.
    pub cost: u32,
    /// None on an open level, which has no solve of ours.
    pub par: Option<u32>,
    /// Trips' time on empty roads over the time they took, 0 to 1.
    pub flow: f64,
    /// Par over cost; on an open level, none.
    pub material: Option<f64>,
    /// The flow our own solve gets; on an open level, none.
    pub par_flow: Option<f64>,
    /// Flow and material against our own solve's, as a percentage: a
    /// hundred is as good as ours. On an open level, the flow alone.
    pub efficiency: f64,
    pub gates: Vec<GateView>,
    pub wants: Vec<WantView>,
    /// Where it jammed, and why, when it did.
    pub jam: Option<[i32; 2]>,
    pub message: String,
}

pub struct Level {
    pub name: String,
    pub title: String,
    min: GridCoord,
    max: GridCoord,
    gates: Vec<Gate>,
    wants: Vec<Want>,
    /// What our own solve costs and how it flows; none, an open level.
    par: Option<(u32, f64)>,
    /// Our own solve's tiles of road and their heights, laid between every
    /// two beside each other, or on a diagonal no tile beside both already
    /// joins, that a road may join: the same level, or a slope's ends.
    solution: Vec<(GridCoord, u8)>,
    /// Those of its tiles that are priority road (`#`): a link is one
    /// where both its ends are.
    priority: Vec<GridCoord>,
    /// The junctions it puts lights at (`*`).
    lights: Vec<(GridCoord, u8)>,
    /// Its one-way tiles (`<`, `>`, `^`, `v`), and the way each runs on.
    arrows: Vec<((GridCoord, u8), (i32, i32))>,
    phase: Phase,
    rng: SmallRng,
    seed: u64,
    /// When each want next sets off a car.
    next: Vec<GameTime>,
    /// Cars due at each want's gate and not yet on the road, by when they
    /// were due.
    queue: Vec<VecDeque<GameTime>>,
    /// Cars on the road: which want, when it was due, what its trip would
    /// take on empty roads.
    live: HashMap<EntityId, (usize, GameTime, f64)>,
    tally: Vec<Tally>,
    started: GameTime,
    last_arrival: GameTime,
    jam: Option<GridCoord>,
    message: String,
    /// The flow as the test ended: what it scores.
    done_flow: f64,
}

impl Level {
    /// A level from its text, built into a fresh world, its own solve, if
    /// it has one, tested to know what a hundred is.
    pub fn build(name: &str, text: &str) -> (Level, World) {
        let (mut level, world) = Level::parse(name, text);
        let Some((par, _)) = level.par else { return (level, world) };
        let (mut reference, world_r) = Level::parse(name, text);
        let mut game = Game::new(world_r, 0, 1, Box::new(World::new));
        for step in reference.solve_steps(&game.world) {
            crate::game::take_step(&mut game.world, &mut game.events, &mut game.intersections, step, game.now);
        }
        reference.test(&mut game);
        while reference.phase == Phase::Test {
            reference.step(&mut game);
            game.step();
        }
        level.par = Some((par, if reference.phase == Phase::Done { reference.done_flow } else { 1.0 }));
        (level, world)
    }

    fn parse(name: &str, text: &str) -> (Level, World) {
        let mut world = World::new();
        world.build = crate::tree::Build::all();
        world.treasury = f64::MAX / 4.0;
        world.missions.list.clear();

        let mut gates_said: HashMap<char, (Way, Lanes)> = HashMap::default();
        let mut wants_said: Vec<(char, char, f64)> = Vec::new();
        for line in text.lines().filter_map(|l| l.trim().strip_prefix('@')) {
            let words: Vec<&str> = line.split_whitespace().collect();
            match words.as_slice() {
                ["gate", g, way, ..] => {
                    let wide = way.ends_with('2');
                    let way = match way.trim_end_matches('2') {
                        "in" => Way::In,
                        "out" => Way::Out,
                        _ => Way::Both,
                    };
                    gates_said.insert(g.chars().next().unwrap_or('?'), (way, wide));
                }
                ["want", a, b, n, ..] => wants_said.push((a.chars().next().unwrap_or('?'), b.chars().next().unwrap_or('?'), n.parse().unwrap_or(0.0))),
                _ => {}
            }
        }
        // The map without its gates' digits, laid as a fixture; the
        // digits found, by column and row.
        let map: Vec<&str> = text.lines().filter(|l| !l.trim().starts_with('@') && !l.starts_with('%')).collect();
        // Our solve: the ground's rows, then a block of rows for each
        // height above it that has any (`%^2` and its row, a level up).
        let solve: Vec<(u8, Vec<char>)> = text
            .lines()
            .filter_map(|l| l.strip_prefix('%'))
            .map(|r| match (r.strip_prefix('^'), r.strip_prefix('#')) {
                (Some(rest), _) => (rest[..1].parse().unwrap_or(0), rest[1..].chars().collect()),
                // The priority overlay: its `#` tiles are priority road,
                // whatever their own row says.
                (_, Some(rest)) => (PRIORITY, rest.chars().collect()),
                _ => (0, r.chars().collect()),
            })
            .collect();
        let rows: Vec<Vec<char>> = map
            .iter()
            .filter(|l| !l.starts_with('#'))
            .map(|r| r.chars().filter(|c| !c.is_whitespace()).collect::<Vec<_>>())
            .filter(|r| !r.is_empty())
            .collect();
        let plain: String = map.iter().map(|l| if l.starts_with('#') { l.to_string() } else { l.chars().map(|c| if c.is_ascii_digit() { '.' } else { c }).collect() }).collect::<Vec<_>>().join("\n");
        let (w, h, title) = crate::fixtures::lay(&mut world, &plain, 0, name);
        let at = |col: i32, row: i32| GridCoord { x: w - 1 - col, y: -row };

        let mut gates = Vec::new();
        for (row, line) in rows.iter().enumerate() {
            for (col, &c) in line.iter().enumerate() {
                if !c.is_ascii_digit() {
                    continue;
                }
                let (col, row) = (col as i32, row as i32);
                // Out past whichever edge it stands on.
                let (dc, dr) = if col == 0 {
                    (-1, 0)
                } else if col == w - 1 {
                    (1, 0)
                } else if row == 0 {
                    (0, -1)
                } else {
                    (0, 1)
                };
                let path: Vec<GridCoord> = (0..=STUB).map(|k| at(col + dc * k, row + dr * k)).collect();
                let (way, wide) = gates_said.get(&c).copied().unwrap_or((Way::Both, false));
                let run: Vec<GridCoord> = if way == Way::In { path.iter().rev().copied().collect() } else { path.clone() };
                match way {
                    Way::Both => world.place_road_path_of(&path, false),
                    _ => world.place_one_way_of(&run, false),
                }
                if wide && way != Way::Both {
                    for p in run.windows(2) {
                        if let (Some(a), Some(b)) = (world.road_node_at(p[0]), world.road_node_at(p[1])) {
                            world.set_wide(a, b, true);
                        }
                    }
                }
                let end = path[path.len() - 1];
                if let Some(node) = world.road_node_at(end) {
                    world.open_exit(node);
                }
                gates.push(Gate { label: c, edge: path[0], end, way });
            }
        }
        gates.sort_by_key(|g| g.label);
        let index = |c: char| gates.iter().position(|g| g.label == c);
        let wants: Vec<Want> = wants_said
            .iter()
            .filter_map(|&(a, b, n)| Some(Want { from: index(a)?, to: index(b)?, per_min: n }))
            .collect();
        let (mut solution, mut priority, mut lights, mut arrows) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let mut rows_at: HashMap<u8, i32> = HashMap::default();
        for (height, line) in &solve {
            let row = rows_at.entry(*height).or_insert(0);
            if *height == PRIORITY {
                for (col, &c) in line.iter().enumerate() {
                    if c == '#' {
                        priority.push(at(col as i32, *row));
                    }
                }
                *row += 1;
                continue;
            }
            for (col, &c) in line.iter().enumerate() {
                if "=#*<>^v".contains(c) {
                    solution.push((at(col as i32, *row), *height));
                }
                // A one-way, the way it runs as the map is read: the game's
                // x runs the other way to the map's columns.
                let way = match c {
                    '>' => Some((-1, 0)),
                    '<' => Some((1, 0)),
                    '^' => Some((0, 1)),
                    'v' => Some((0, -1)),
                    _ => None,
                };
                if let Some(way) = way {
                    arrows.push(((at(col as i32, *row), *height), way));
                }
                if c == '*' {
                    lights.push((at(col as i32, *row), *height));
                }
                if c == '#' {
                    priority.push(at(col as i32, *row));
                }
            }
            *row += 1;
        }
        let par = solution.iter().map(|&(_, h)| if h == 0 { 1 } else if h % 2 == 1 { 2 } else { 3 }).sum::<u32>() + lights.len() as u32 * LIGHT_COST;
        let par = (!solution.is_empty()).then_some((par, 1.0));
        let seed = name.bytes().fold(7u64, |h, b| h.wrapping_mul(31).wrapping_add(b as u64));
        let n = wants.len();
        world.frame = Some((at(w - 1, h - 1), at(0, 0)));
        let level = Level {
            name: name.to_string(),
            title,
            min: at(w - 1, h - 1),
            max: at(0, 0),
            gates,
            wants,
            par,
            solution,
            priority,
            lights,
            arrows,
            phase: Phase::Build,
            rng: SmallRng::seed_from_u64(seed),
            seed,
            next: vec![0; n],
            queue: vec![VecDeque::new(); n],
            live: HashMap::default(),
            tally: vec![Tally::default(); n],
            started: 0,
            last_arrival: 0,
            jam: None,
            message: String::new(),
            done_flow: 0.0,
        };
        (level, world)
    }

    pub fn inside(&self, t: GridCoord) -> bool {
        (self.min.x..=self.max.x).contains(&t.x) && (self.min.y..=self.max.y).contains(&t.y)
    }

    /// Our own solve, laid: the steps the hand would take.
    pub fn solve_steps(&self, world: &World) -> Vec<Build> {
        let road = |t: GridCoord, h: u8| self.solution.contains(&(t, h)) || (h == 0 && self.gates.iter().any(|g| g.edge == t));
        let joins = |a: u8, b: u8| a.abs_diff(b) <= 1 && !(a == b && a % 2 == 1);
        let arrow = |t: GridCoord, h: u8| self.arrows.iter().find(|(at, _)| *at == (t, h)).map(|&(_, w)| w);
        // The overlay's priority is the ground's.
        let priority = |a: GridCoord, ha: u8, b: GridCoord, hb: u8| ha == 0 && hb == 0 && self.priority.contains(&a) && self.priority.contains(&b);
        let mut steps = Vec::new();
        // One-ways first, each on to the tile it points at.
        for &((a, ha), (dx, dy)) in &self.arrows {
            let b = GridCoord { x: a.x + dx, y: a.y + dy };
            if let Some(hb) = (ha.saturating_sub(1)..=ha + 1).find(|&hb| road(b, hb) && joins(ha, hb)) {
                steps.push(Build { tool: Tool::OneWay, from: a, to: b, up: (ha > 0 || hb > 0).then_some([ha, hb]), sides: None, road: priority(a, ha, b, hb) });
            }
        }
        for &(a, ha) in &self.solution {
            for (dx, dy) in [(1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1)] {
                let b = GridCoord { x: a.x + dx, y: a.y + dy };
                // A one-way's tiles join others only as its arrows say, or
                // square on from a two-way's.
                if (arrow(a, ha).is_some() || (0..=TOP_H).any(|h| arrow(b, h).is_some())) && (arrow(a, ha).is_some() && arrow(b, ha).is_some() || dx != 0 && dy != 0) {
                    continue;
                }
                for hb in ha.saturating_sub(1)..=ha + 1 {
                    let beside = dx != 0 && dy != 0 && (road(GridCoord { x: a.x + dx, y: a.y }, ha) || road(GridCoord { x: a.x, y: a.y + dy }, ha));
                    let done = steps.iter().any(|s: &Build| s.from == b && s.to == a && s.up.unwrap_or_default() == [hb, ha]);
                    if road(b, hb) && joins(ha, hb) && !beside && !done && world.link_between_at(a, ha, MIDDLE, b, hb, MIDDLE).is_none() {
                        steps.push(Build { tool: Tool::Street, from: a, to: b, up: (ha > 0 || hb > 0).then_some([ha, hb]), sides: None, road: priority(a, ha, b, hb) });
                    }
                }
            }
        }
        for &(at, h) in &self.lights {
            steps.push(Build { tool: Tool::Light, from: at, to: at, up: (h > 0).then_some([h, h]), sides: None, road: false });
        }
        steps
    }

    /// The player's roads, as the steps that would lay them again: every
    /// link with a laid end, the way it runs, at its heights.
    pub fn layout(world: &World) -> Vec<Build> {
        let mut steps = Vec::new();
        let node = |id: EntityId| match world.objects.get(id).map(|e| (e.position, &e.object)) {
            Some((Some(p), GameObject::RoadNode(n))) => Some((p, n.height, n.road, n.laid)),
            _ => None,
        };
        let mut edges: Vec<_> = world.edges.keys().copied().collect();
        edges.sort_unstable();
        for (a, b) in edges {
            let (Some((pa, ha, ra, la)), Some((pb, hb, rb, lb))) = (node(a), node(b)) else { continue };
            if !la && !lb {
                continue;
            }
            let back = world.edges.contains_key(&(b, a));
            // A two-way once, from its lower end; a one-way the way it runs.
            if back && a > b {
                continue;
            }
            let tool = if back {
                Tool::Street
            } else if world.is_wide(a, b) {
                Tool::Wide
            } else {
                Tool::OneWay
            };
            let sides = [world.side_of(a), world.side_of(b)];
            steps.push(Build { tool, from: pa, to: pb, up: (ha > 0 || hb > 0).then_some([ha, hb]), sides: (sides != [MIDDLE; 2]).then_some(sides), road: ra && rb });
        }
        // And the lights, once their junctions stand.
        for e in world.objects.roads() {
            if let (Some(p), GameObject::RoadNode(n)) = (e.position, &e.object)
                && n.light.is_some()
            {
                steps.push(Build { tool: Tool::Light, from: p, to: p, up: (n.height > 0).then_some([n.height, n.height]), sides: None, road: false });
            }
        }
        steps
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// Clear the roads of cars and start the clock on a test.
    pub fn test(&mut self, game: &mut Game) {
        clear(game);
        self.rng = SmallRng::seed_from_u64(self.seed);
        self.phase = Phase::Test;
        self.started = game.now;
        self.last_arrival = game.now;
        self.jam = None;
        self.message.clear();
        self.tally = vec![Tally::default(); self.wants.len()];
        for q in &mut self.queue {
            q.clear();
        }
        for i in 0..self.wants.len() {
            self.next[i] = game.now + self.gap(i) / 2;
        }
        // A trip with no road for it has jammed before it starts.
        for i in 0..self.wants.len() {
            if self.route(&game.world, i).is_none() {
                let w = &self.wants[i];
                let (a, b) = (self.gates[w.from].label, self.gates[w.to].label);
                self.jammed(self.gates[w.from].edge, format!("No way from {a} to {b}"));
                return;
            }
        }
    }

    /// Back to building: the traffic carries on, untimed.
    pub fn build_again(&mut self) {
        self.phase = Phase::Build;
        for q in &mut self.queue {
            q.clear();
        }
    }

    fn jammed(&mut self, at: GridCoord, why: String) {
        self.phase = Phase::Jammed;
        self.jam = Some(at);
        self.message = why;
    }

    /// The time to the next car of a want, drawn so that they bunch as
    /// traffic does: exponential, at the want's rate.
    fn gap(&mut self, i: usize) -> GameTime {
        let per_ms = self.wants[i].per_min / 60_000.0;
        if per_ms <= 0.0 {
            return GameTime::MAX / 4;
        }
        let u: f64 = self.rng.random_range(1e-6..1.0);
        (-u.ln() / per_ms).clamp(400.0, 600_000.0) as GameTime
    }

    fn route(&self, world: &World, i: usize) -> Option<Vec<EntityId>> {
        let w = &self.wants[i];
        let from = world.road_node_at(self.gates[w.from].end)?;
        let to = world.road_node_at(self.gates[w.to].end)?;
        crate::world::pathfinding::Routes::from(world, from).route_to(to)
    }

    /// Before each step of time: count who arrived, set off who is due, and
    /// in a test, call it jammed or done.
    pub fn step(&mut self, game: &mut Game) {
        let now = game.now;
        // Arrived: gone from the world.
        let arrived: Vec<EntityId> = self.live.keys().copied().filter(|&id| game.world.objects.get(id).is_none()).collect();
        for id in arrived {
            let (i, due, ideal) = self.live.remove(&id).unwrap();
            if self.phase == Phase::Test {
                let t = &mut self.tally[i];
                t.delivered += 1;
                t.ideal_ms += ideal;
                t.taken_ms += (now - due) as f64;
                self.last_arrival = now;
            }
        }
        if !matches!(self.phase, Phase::Build | Phase::Test) {
            return;
        }
        let testing = self.phase == Phase::Test;
        for i in 0..self.wants.len() {
            while self.next[i] <= now {
                let due = self.next[i];
                self.next[i] += self.gap(i);
                if testing {
                    self.tally[i].due += 1;
                    self.queue[i].push_back(due);
                } else if self.queue[i].is_empty() {
                    // Building: one waits at most; the rest never came.
                    self.queue[i].push_back(due);
                }
            }
            while let Some(&due) = self.queue[i].front() {
                let Some(route) = self.route(&game.world, i) else {
                    if !testing {
                        self.queue[i].clear();
                    }
                    break;
                };
                let start = game.world.objects.get(route[0]).and_then(|e| e.position);
                let car = game.world.insert_at(GameObject::Car(Car::new(0, CarRole::Private)), start);
                if !crate::car::spawn::drive_through(&mut game.world, &mut game.events, car, route, now) {
                    game.world.despawn_car(car);
                    break;
                }
                self.queue[i].pop_front();
                let ideal = match game.world.objects.get(car).map(|e| &e.object) {
                    Some(GameObject::Car(c)) => c.trip.as_ref().map_or(0.0, |t| t.total_route_length / CRUISE_SPEED * 1000.0),
                    _ => 0.0,
                };
                self.live.insert(car, (i, due, ideal));
            }
        }
        if !testing {
            return;
        }
        if let Some(i) = (0..self.wants.len()).find(|&i| self.queue[i].len() > JAM_QUEUE) {
            let g = &self.gates[self.wants[i].from];
            self.jammed(g.edge, format!("Cars can't get on at {}", g.label));
        } else if !self.live.is_empty() && now - self.last_arrival > JAM_STILL_MS {
            let at = self
                .live
                .iter()
                .min_by_key(|(id, (_, due, _))| (*due, **id))
                .and_then(|(&id, _)| game.world.objects.get(id).and_then(|e| e.position))
                .unwrap_or(self.min);
            self.jammed(at, "Gridlock".to_string());
        } else if now - self.started >= TEST_MS {
            self.phase = Phase::Done;
            self.done_flow = self.flow(game);
        }
    }

    /// What the player's roads cost, in tiles of ground road: a slope's
    /// tile two, a deck's three, for the concrete and steel under them; a
    /// junction's lights four.
    pub fn cost(world: &World) -> u32 {
        world
            .objects
            .roads()
            .filter_map(|e| match e.object {
                GameObject::RoadNode(ref n) if n.laid || n.light.is_some() => Some(
                    u32::from(n.laid) * match n.height {
                        0 => 1,
                        h if h % 2 == 1 => 2,
                        _ => 3,
                    } + if n.light.is_some() { LIGHT_COST } else { 0 },
                ),
                _ => None,
            })
            .sum()
    }

    /// Time on empty roads over time taken, every car due counted: those
    /// still waiting and still driving with what they have taken so far.
    fn flow(&self, game: &Game) -> f64 {
        let (mut ideal, mut taken) = (0.0, 0.0);
        for t in &self.tally {
            ideal += t.ideal_ms;
            taken += t.taken_ms;
        }
        for (_, (i, due, est)) in &self.live {
            let _ = i;
            ideal += est;
            taken += (game.now - due) as f64;
        }
        for (i, q) in self.queue.iter().enumerate() {
            let est = self.estimate(&game.world, i);
            for &due in q {
                ideal += est;
                taken += (game.now.saturating_sub(due)) as f64;
            }
        }
        if taken <= 0.0 { 1.0 } else { (ideal / taken).min(1.0) }
    }

    fn estimate(&self, world: &World, i: usize) -> f64 {
        self.route(world, i).map_or(0.0, |r| r.windows(2).map(|p| world.segment_length(p[0], p[1])).sum::<f64>() / CRUISE_SPEED * 1000.0)
    }

    pub fn state(&self, game: &Game) -> LevelState {
        let world = &game.world;
        let cost = Level::cost(world);
        let testing = self.phase != Phase::Build;
        let flow = match self.phase {
            Phase::Build => 0.0,
            Phase::Done => self.done_flow,
            _ => self.flow(game),
        };
        let material = self.par.map(|(par, _)| if cost == 0 { 0.0 } else { par as f64 / cost as f64 });
        LevelState {
            name: self.name.clone(),
            title: self.title.clone(),
            min_x: self.min.x,
            min_y: self.min.y,
            max_x: self.max.x,
            max_y: self.max.y,
            phase: self.phase,
            test_ms: if testing { (game.now - self.started).min(TEST_MS) } else { 0 },
            test_total_ms: TEST_MS,
            cost,
            par: self.par.map(|(par, _)| par),
            flow,
            material,
            par_flow: self.par.map(|(_, f)| f),
            efficiency: match (self.phase, self.par) {
                (Phase::Done, Some((_, par_flow))) => 100.0 * flow / par_flow.max(1e-9) * material.unwrap_or(0.0),
                (Phase::Done, None) => 100.0 * flow,
                _ => 0.0,
            },
            gates: self
                .gates
                .iter()
                .enumerate()
                .map(|(gi, g)| GateView {
                    label: g.label.to_string(),
                    x: g.edge.x,
                    y: g.edge.y,
                    end_x: g.end.x,
                    end_y: g.end.y,
                    ins: g.way != Way::Out,
                    outs: g.way != Way::In,
                    waiting: (0..self.wants.len()).filter(|&i| self.wants[i].from == gi).map(|i| self.queue[i].len() as u32).sum(),
                })
                .collect(),
            wants: self
                .wants
                .iter()
                .enumerate()
                .map(|(i, w)| WantView {
                    from: self.gates[w.from].label.to_string(),
                    to: self.gates[w.to].label.to_string(),
                    per_min: w.per_min,
                    joined: self.route(world, i).is_some(),
                    due: self.tally[i].due,
                    delivered: self.tally[i].delivered,
                })
                .collect(),
            jam: self.jam.map(|t| [t.x, t.y]),
            message: self.message.clone(),
        }
    }
}

/// Every car off the road.
fn clear(game: &mut Game) {
    let cars: Vec<EntityId> = game.world.objects.iter().filter(|e| matches!(e.object, GameObject::Car(_))).map(|e| e.id).collect();
    for car in cars {
        crate::car::simulation::park_at_home(&mut game.world, &mut game.intersections, &mut game.events, car);
    }
}

#[cfg(test)]
mod tests {

    /// Two flows across each other on an X of diagonals, no junction where
    /// they cross: their cars take turns at the crossing, never two in it
    /// at once, and both get through.
    #[test]
    fn cars_take_turns_where_diagonals_cross() {
        let text = [
            "# Cross", "@gate 1 in", "@gate 2 out", "@gate 3 in", "@gate 4 out", "@want 1 2 20", "@want 3 4 20",
            "....3....", ".........", ".........", ".........", "2.......1", ".........", ".........", ".........", "....4....",
        ]
        .join("\n");
        let (mut level, world) = Level::build("cross", &text);
        let mut game = Game::new(world, 0, 1, Box::new(World::new));
        let at = |x: i32, y: i32| crate::protocol::Spot { at: GridCoord { x, y }, want: 0 };
        // 1 to 2 along the middle row (the map is read mirrored, 1 on the
        // west), up over the corner and back; 3 to 4
        // down the middle column, across the same corner the other way.
        for (id, tiles) in [
            (1, vec![at(0, -4), at(1, -4), at(2, -4), at(3, -4), at(4, -3), at(5, -3), at(6, -3), at(7, -3), at(8, -4)]),
            (2, vec![at(4, 0), at(4, -1), at(4, -2), at(3, -3), at(4, -4), at(4, -5), at(4, -6), at(4, -7), at(4, -8)]),
        ] {
            for n in 2..=tiles.len() {
                let stroke = crate::protocol::Stroke { id, tool: Tool::OneWay, road: false, tiles: tiles[..n].to_vec(), start: None };
                crate::draw::draw(&mut game.world, &mut game.events, &mut game.intersections, 1, stroke, 0);
            }
        }
        let node = |x, y| game.world.road_node_at(GridCoord { x, y }).expect("the roads were not laid");
        assert!(game.world.crossing_of(node(3, -4), node(4, -3)).is_some(), "the diagonals do not cross");
        level.test(&mut game);
        let corner = [4.0, -3.0];
        let mut both = 0;
        while level.phase == Phase::Test {
            level.step(&mut game);
            game.step();
            // Where each car is, along the edge it is on.
            let near: Vec<EntityId> = game
                .world
                .objects
                .iter()
                .filter_map(|e| match e.object {
                    GameObject::Car(ref c) => {
                        let t = c.trip.as_ref()?;
                        let (a, b) = (t.route_positions.get(t.route_index.checked_sub(1)?)?, t.route_positions.get(t.route_index)?);
                        let f = t.seg_fraction;
                        let p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
                        ((p[0] - corner[0]).hypot(p[1] - corner[1]) < 0.2).then_some(e.id)
                    }
                    _ => None,
                })
                .collect();
            both += (near.len() > 1) as u32;
        }
        let wants = level.state(&game).wants;
        assert_eq!(level.phase, Phase::Done, "the crossing jammed: {}", level.message);
        assert!(wants.iter().all(|w| w.delivered > 40), "a flow did not get through: {:?}", wants.iter().map(|w| w.delivered).collect::<Vec<_>>());
        assert_eq!(both, 0, "two cars were in the crossing at once");
    }

    use super::*;

    const CROSSING: &str = "# Crossing
@gate 1 in
@gate 2 out
@want 1 2 12
..........
1........2
..........
%..........
%1========2
%..........
";

    fn play(text: &str) -> (Level, Game) {
        let (level, world) = Level::build("t", text);
        let game = Game::new(world, 0, 1, Box::new(World::new));
        (level, game)
    }

    fn run(level: &mut Level, game: &mut Game, ms: GameTime) {
        for _ in 0..ms / crate::game::STEP_MS {
            level.step(game);
            game.step();
        }
    }

    fn lay(game: &mut Game, path: &[(i32, i32)]) {
        for p in path.windows(2) {
            let step = Build { tool: Tool::Street, from: GridCoord { x: p[0].0, y: p[0].1 }, to: GridCoord { x: p[1].0, y: p[1].1 }, up: None, sides: None, road: false };
            assert!(crate::game::may_step(&game.world, step), "{step:?} refused");
            crate::game::take_step(&mut game.world, &mut game.events, &mut game.intersections, step, game.now);
        }
    }

    #[test]
    fn a_level_has_its_gates_and_wants() {
        let (level, game) = play(CROSSING);
        let s = level.state(&game);
        assert_eq!(s.gates.len(), 2);
        assert_eq!((s.min_x, s.min_y, s.max_x, s.max_y), (0, -2, 9, 0));
        assert!(!s.wants[0].joined, "nothing joins them yet");
    }

    #[test]
    fn with_no_road_a_test_jams_at_once() {
        let (mut level, mut game) = play(CROSSING);
        level.test(&mut game);
        assert_eq!(level.phase(), Phase::Jammed);
    }

    #[test]
    fn a_straight_road_carries_the_traffic_and_scores() {
        let (mut level, mut game) = play(CROSSING);
        // Gate 1 stands at column 0, the map's x 9; gate 2 at x 0.
        lay(&mut game, &(0..=9).rev().map(|x| (x, -1)).collect::<Vec<_>>());
        assert!(level.state(&game).wants[0].joined);
        level.test(&mut game);
        run(&mut level, &mut game, TEST_MS + 1000);
        let s = level.state(&game);
        assert_eq!(s.phase, Phase::Done, "{}", s.message);
        assert!(s.wants[0].delivered > 20, "only {} of {} arrived", s.wants[0].delivered, s.wants[0].due);
        eprintln!("flow {} eff {} delivered {}/{}", s.flow, s.efficiency, s.wants[0].delivered, s.wants[0].due);
        assert!(s.flow > 0.6, "flow {}", s.flow);
        assert_eq!(s.cost, 8, "the eight tiles between the gates");
        assert!(s.efficiency > 60.0, "efficiency {}", s.efficiency);
    }

    /// Every level's own solve carries its traffic through a test without
    /// jamming, at its par, and scores about a hundred.
    #[test]
    fn every_level_is_solved_by_its_own_solve() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/levels");
        let mut names: Vec<_> = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "txt")).collect();
        names.sort();
        assert!(!names.is_empty());
        for path in names {
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            let (mut level, mut game) = play(&std::fs::read_to_string(&path).unwrap());
            if level.par.is_none() {
                continue;
            }
            for step in level.solve_steps(&game.world) {
                assert!(crate::game::may_step(&game.world, step), "{name}: {step:?} refused by the level");
                assert!(crate::game::take_step(&mut game.world, &mut game.events, &mut game.intersections, step, game.now), "{name}: {step:?} refused by the world");
            }
            let s = level.state(&game);
            assert!(s.wants.iter().all(|w| w.joined), "{name}: the solve leaves a want with no road");
            assert_eq!(Some(s.cost), s.par, "{name}: the solve costs other than its par");
            level.test(&mut game);
            // Nothing going wrong on the way (`Watch`): no car through
            // another, none standing for good.
            let mut watch = crate::replay::Watch::default();
            let end = game.now + TEST_MS + 1000;
            while game.now < end {
                level.step(&mut game);
                game.step();
                let wrong = watch.look(&game);
                assert!(wrong.is_empty(), "{name}: {}", wrong.join("; "));
            }
            let s = level.state(&game);
            assert_eq!(s.phase, Phase::Done, "{name}: {} at {:?}", s.message, s.jam);
            eprintln!("{name}: efficiency {:.1}, flow {:.2}, cost {}", s.efficiency, s.flow, s.cost);
            assert!((s.efficiency - 100.0).abs() < 0.5, "{name}: its own solve scores {:.1}", s.efficiency);
            assert!(s.par_flow.is_some_and(|f| f > 0.5), "{name}: its own solve flows at {:?}", s.par_flow);
        }
    }

    /// An open level, with no solve of ours to prove it, is at least fair:
    /// its gates stand on the map's edge, and none asks more of its lanes
    /// than a lane carries, sixty cars a minute.
    #[test]
    fn every_open_level_asks_no_more_than_its_lanes_carry() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/levels");
        let mut open = 0;
        for path in std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "txt")) {
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            let (level, game) = play(&std::fs::read_to_string(&path).unwrap());
            if level.par.is_some() {
                continue;
            }
            open += 1;
            for (i, g) in level.gates.iter().enumerate() {
                assert!(level.inside(g.edge) && !level.inside(g.end), "{name}: gate {} is not on the edge", g.label);
                let node = game.world.road_node_at(g.edge).unwrap_or_else(|| panic!("{name}: gate {} has no road", g.label));
                let lanes = game.world.edges.iter().filter(|(k, _)| k.0 == node || k.1 == node).map(|(_, s)| s.lanes).max().unwrap_or(1) as f64;
                let asked: f64 = level.wants.iter().filter(|w| w.from == i || w.to == i).map(|w| w.per_min).sum();
                assert!(asked <= 60.0 * lanes, "{name}: gate {} asks {asked} a minute of {lanes} lanes", g.label);
            }
        }
        assert!(open > 0);
    }

    /// What the player built, written down and laid again on a fresh
    /// level, is the same roads.
    #[test]
    fn a_layout_lays_again_as_it_was() {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/levels/08-over-and-under.txt")).unwrap();
        let (level, mut game) = play(&text);
        for step in level.solve_steps(&game.world) {
            crate::game::take_step(&mut game.world, &mut game.events, &mut game.intersections, step, game.now);
        }
        let written = Level::layout(&game.world);
        let (_, mut fresh) = play(&text);
        for step in &written {
            assert!(crate::game::may_step(&fresh.world, *step));
            assert!(crate::game::take_step(&mut fresh.world, &mut fresh.events, &mut fresh.intersections, *step, fresh.now), "{step:?}");
        }
        assert_eq!(Level::cost(&fresh.world), Level::cost(&game.world));
        assert_eq!(fresh.world.edges.len(), game.world.edges.len());
    }

    /// A road of two lanes carries cars in both, side by side; where two
    /// lanes become one, they fall in behind each other, never through.
    #[test]
    fn two_lanes_carry_side_by_side() {
        // Into one lane, as many as it carries a tile from the gate, each
        // in at the gap it takes there (`headway`): about forty-five a
        // minute. A hundred it carried only while cars out of the merge kept
        // on closer than any gap.
        let run = |tool: Tool, per_min: u32| {
            let (mut level, mut game) = play(&format!("# Two lanes\n@gate 1 in2\n@gate 2 out2\n@want 1 2 {per_min}\n..........\n1........2\n..........\n"));
            for x in (1..=9).rev() {
                let step = Build { tool, from: GridCoord { x, y: -1 }, to: GridCoord { x: x - 1, y: -1 }, up: None, sides: None, road: false };
                assert!(crate::game::take_step(&mut game.world, &mut game.events, &mut game.intersections, step, game.now), "{step:?}");
            }
            level.test(&mut game);
            let (mut both, mut watch) = (false, crate::replay::Watch::default());
            while level.phase == Phase::Test {
                level.step(&mut game);
                game.step();
                // Never one through another (`Watch`).
                let wrong = watch.look(&game);
                assert!(wrong.is_empty(), "{tool:?}: {}", wrong.join("; "));
                let node = |x| game.world.road_node_at(GridCoord { x, y: -1 }).unwrap();
                let Some(seg) = game.world.edges.get(&(node(5), node(4))) else { continue };
                both |= seg.all().any(|c| seg.lane_of(c) == Some(1)) && seg.all().any(|c| seg.lane_of(c) == Some(0));
            }
            (level.phase, both)
        };
        let (phase, both) = run(Tool::Wide, 100);
        assert_eq!(phase, Phase::Done);
        assert!(both, "cars side by side in the two lanes");
        assert_eq!(run(Tool::OneWay, 40).0, Phase::Done);
    }

    /// Lay a road along tiles, a step at a time, each step taken.
    fn draw_road(game: &mut Game, tool: Tool, tiles: &[(i32, i32)]) {
        for w in tiles.windows(2) {
            let step = Build { tool, from: GridCoord { x: w[0].0, y: w[0].1 }, to: GridCoord { x: w[1].0, y: w[1].1 }, up: None, sides: None, road: false };
            assert!(crate::game::take_step(&mut game.world, &mut game.events, &mut game.intersections, step, game.now), "{step:?}");
        }
    }

    /// The cars on the road, with their trips.
    fn trips(game: &Game) -> Vec<(EntityId, crate::protocol::Trip)> {
        game.world.objects.iter().filter_map(|e| match &e.object {
            GameObject::Car(c) => c.trip.clone().map(|t| (e.id, t)),
            _ => None,
        }).collect()
    }

    /// A busy road of two lanes with a road joining it from the side: the
    /// cars joining come into the near lane, those on it change lanes,
    /// round each other and out of the joining cars' way, and never into
    /// each other; the traffic keeps moving.
    #[test]
    fn cars_change_lanes_to_let_others_merge() {
        let text = "# Merge\n@gate 1 in2\n@gate 2 out2\n@gate 3 in\n@want 1 2 40\n@want 3 2 14\n....................\n....................\n....................\n1..................2\n....................\n....................\n..........3.........\n";
        let (mut level, mut game) = play(text);
        draw_road(&mut game, Tool::Wide, &(0..=19).rev().map(|x| (x, -3)).collect::<Vec<_>>());
        draw_road(&mut game, Tool::OneWay, &[(9, -6), (9, -5), (9, -4), (9, -3)]);
        let junction = game.world.road_node_at(GridCoord { x: 9, y: -3 }).unwrap();
        level.test(&mut game);
        let (mut changes, mut merged_into) = (crate::fixed::HashSet::default(), crate::fixed::HashSet::default());
        let mut watch = crate::replay::Watch::default();
        while level.phase == Phase::Test {
            level.step(&mut game);
            game.step();
            let wrong = watch.look(&game);
            assert!(wrong.is_empty(), "{}", wrong.join("\n"));
            for (id, t) in trips(&game) {
                if let Some(s) = t.shift {
                    changes.insert((id, s.at));
                }
                // One from the side, short of the road: the lane it joins by.
                if let Some(j) = t.route.iter().position(|&n| n == junction).filter(|&j| j > 0 && t.route_index <= j && t.route[j - 1] != t.route[0] && game.world.height_of(t.route[j - 1]) == 0) {
                    if game.world.objects.get(t.route[j - 1]).and_then(|e| e.position) == Some(GridCoord { x: 9, y: -4 }) {
                        merged_into.insert(t.lanes[j + 1]);
                    }
                }
            }
        }
        assert_eq!(level.phase, Phase::Done, "{}", level.message);
        assert_eq!(merged_into, crate::fixed::HashSet::from_iter([0]), "joining from the right, into the right lane");
        assert!(changes.len() > 10, "{} changes of lane", changes.len());
    }

    /// Cars bound for a turn off a road of two lanes get into the lane it
    /// asks for before they come to it, keeping right as they may; on an
    /// open road they keep right.
    #[test]
    fn cars_get_in_lane_and_keep_right() {
        let text = "# Lanes\n@gate 1 in2\n@gate 2 out2\n@gate 3 out\n@want 1 2 20\n@want 1 3 20\n..............3.....\n....................\n....................\n1..................2\n....................\n";
        let (mut level, mut game) = play(text);
        draw_road(&mut game, Tool::Wide, &(0..=19).rev().map(|x| (x, -3)).collect::<Vec<_>>());
        draw_road(&mut game, Tool::OneWay, &[(5, -3), (5, -2), (5, -1), (5, 0)]);
        let junction = game.world.road_node_at(GridCoord { x: 5, y: -3 }).unwrap();
        let out = game.world.road_node_at(GridCoord { x: 0, y: -3 }).unwrap();
        level.test(&mut game);
        let (mut turning, mut through) = (Vec::new(), Vec::new());
        let mut seen = crate::fixed::HashSet::default();
        let mut watch = crate::replay::Watch::default();
        while level.phase == Phase::Test {
            level.step(&mut game);
            game.step();
            let wrong = watch.look(&game);
            assert!(wrong.is_empty(), "{}", wrong.join("\n"));
            for (id, t) in trips(&game) {
                let ri = t.route_index;
                // Coming to the turn, its last edge before it; at the far end, the last edge.
                if t.route.get(ri) == Some(&junction) && t.route.get(ri + 1).is_some_and(|&n| game.world.objects.get(n).and_then(|e| e.position).is_some_and(|p| p.y == -2)) && seen.insert((id, 0)) {
                    turning.push(t.lanes[ri]);
                }
                if t.route.get(ri) == Some(&out) && seen.insert((id, 1)) {
                    through.push(t.lanes[ri]);
                }
            }
        }
        assert_eq!(level.phase, Phase::Done, "{}", level.message);
        let share = |v: &[u8], l: u8| v.iter().filter(|&&x| x == l).count() as f64 / v.len().max(1) as f64;
        eprintln!("turning in lane 1: {:.2} of {}; through in lane 0: {:.2} of {}", share(&turning, 1), turning.len(), share(&through, 0), through.len());
        assert!(share(&turning, 1) > 0.9, "into the left lane for the left turn");
        assert!(share(&through, 0) > 0.8, "keeping right");
    }

    /// A road of two lanes with a turn off either side: cars cross from
    /// lane to lane both ways to make their turns, one letting another in
    /// ahead of it, and none waits for good for a gap that never comes,
    /// nor drives into another.
    #[test]
    fn cars_let_each_other_in() {
        let text = "# Lanes\n@gate 1 in2\n@gate 2 out2\n@gate 3 out\n@gate 4 out\n@want 1 2 15\n@want 1 3 15\n@want 1 4 15\n..............3.....\n....................\n....................\n1..................2\n....................\n....................\n..........4.........\n";
        let (mut level, mut game) = play(text);
        draw_road(&mut game, Tool::Wide, &(0..=19).rev().map(|x| (x, -3)).collect::<Vec<_>>());
        draw_road(&mut game, Tool::OneWay, &[(5, -3), (5, -2), (5, -1), (5, 0)]);
        draw_road(&mut game, Tool::OneWay, &[(9, -3), (9, -4), (9, -5), (9, -6)]);
        level.test(&mut game);
        let mut watch = crate::replay::Watch::default();
        while level.phase == Phase::Test {
            level.step(&mut game);
            game.step();
            let wrong = watch.look(&game);
            assert!(wrong.is_empty(), "{}", wrong.join("\n"));
        }
        assert_eq!(level.phase, Phase::Done, "{}", level.message);
    }

    #[test]
    fn nothing_is_built_off_the_map_or_on_a_gate() {
        let (_, game) = play(CROSSING);
        let off = Build { tool: Tool::Street, from: GridCoord { x: 0, y: 0 }, to: GridCoord { x: -1, y: 0 }, up: None, sides: None, road: false };
        assert!(!crate::game::may_step(&game.world, off));
        let gate = Build { tool: Tool::Demolish, from: GridCoord { x: 9, y: -1 }, to: GridCoord { x: 9, y: -1 }, up: None, sides: None, road: false };
        assert!(!crate::game::may_step(&game.world, gate));
    }

    /// Priority is the hand's, whatever road it draws: a one-way laid with
    /// it has it, and drawn along again without it, loses it, all but
    /// where it runs off another priority road.
    #[test]
    fn any_road_may_have_priority() {
        let (_, mut game) = play(CROSSING);
        let road = |game: &Game, x| game.world.is_road(game.world.road_node_at(GridCoord { x, y: -1 }).unwrap());
        let mut step = |game: &mut Game, tool, x, priority| {
            let step = Build { tool, from: GridCoord { x, y: -1 }, to: GridCoord { x: x + 1, y: -1 }, up: None, sides: None, road: priority };
            assert!(crate::game::take_step(&mut game.world, &mut game.events, &mut game.intersections, step, game.now), "{step:?}");
        };
        for x in 0..9 {
            step(&mut game, Tool::OneWay, x, true);
        }
        assert!((0..=9).all(|x| road(&game, x)), "a one-way with priority");
        step(&mut game, Tool::OneWay, 4, false);
        assert!(road(&game, 4) && road(&game, 5), "both ends run on along priority road");
        for x in 0..9 {
            step(&mut game, Tool::OneWay, x, false);
        }
        assert!((0..=9).all(|x| !road(&game, x)), "drawn again without it, it has none");
        assert!(game.world.edges.contains_key(&(game.world.road_node_at(GridCoord { x: 3, y: -1 }).unwrap(), game.world.road_node_at(GridCoord { x: 4, y: -1 }).unwrap())), "and is still there");
    }
}
