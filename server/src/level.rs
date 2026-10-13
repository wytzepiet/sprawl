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
//! @want 1 2 12      twelve cars a minute from 1 to 2
//! ```
//!
//! After the map, our own solve: the map again, each row behind a `%`,
//! with `=` on every tile of road it lays, `#` of priority road. Its tiles are the level's par,
//! and it is the level's test: it must carry the traffic.
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

use std::collections::{HashMap, VecDeque};

use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};
use serde::Serialize;
use ts_rs::TS;

use crate::car::CRUISE_SPEED;
use crate::engine::GameTime;
use crate::game::Game;
use crate::protocol::{Build, Car, CarRole, EntityId, GameObject, GridCoord, Tool};
use crate::world::World;

/// How long a test runs, in simulated time.
pub const TEST_MS: GameTime = 4 * 60_000;
/// How many cars may wait at a gate before the road is called jammed: they
/// cannot get on, because the road beyond is full.
const JAM_QUEUE: usize = 8;
/// How long the traffic may stand without anyone arriving, cars on the
/// road, before it is called jammed.
const JAM_STILL_MS: GameTime = 40_000;
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
    pub par: u32,
    /// Trips' time on empty roads over the time they took, 0 to 1.
    pub flow: f64,
    /// Par over cost.
    pub material: f64,
    /// The flow our own solve gets.
    pub par_flow: f64,
    /// Flow and material against our own solve's, as a percentage: a
    /// hundred is as good as ours.
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
    par: u32,
    /// The flow our own solve gets.
    par_flow: f64,
    /// Our own solve's tiles of road and their heights, laid between every
    /// two beside each other, or on a diagonal no tile beside both already
    /// joins, that a road may join: the same level, or a slope's ends.
    solution: Vec<(GridCoord, u8)>,
    /// Those of its tiles that are priority road (`#`): a link is one
    /// where both its ends are.
    priority: Vec<GridCoord>,
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
    /// A level from its text, built into a fresh world, its own solve
    /// tested to know what a hundred is.
    pub fn build(name: &str, text: &str) -> (Level, World) {
        let (mut level, world) = Level::parse(name, text);
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
        level.par_flow = if reference.phase == Phase::Done { reference.done_flow } else { 1.0 };
        (level, world)
    }

    fn parse(name: &str, text: &str) -> (Level, World) {
        let mut world = World::new();
        world.build = crate::tree::Build::all();
        world.treasury = f64::MAX / 4.0;
        world.missions.list.clear();

        let mut gates_said: HashMap<char, Way> = HashMap::new();
        let mut wants_said: Vec<(char, char, f64)> = Vec::new();
        for line in text.lines().filter_map(|l| l.trim().strip_prefix('@')) {
            let words: Vec<&str> = line.split_whitespace().collect();
            match words.as_slice() {
                ["gate", g, way, ..] => {
                    let way = match *way {
                        "in" => Way::In,
                        "out" => Way::Out,
                        _ => Way::Both,
                    };
                    gates_said.insert(g.chars().next().unwrap_or('?'), way);
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
            .map(|r| match r.strip_prefix('^') {
                Some(rest) => (rest[..1].parse().unwrap_or(0), rest[1..].chars().collect()),
                None => (0, r.chars().collect()),
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
                let way = gates_said.get(&c).copied().unwrap_or(Way::Both);
                match way {
                    Way::Both => world.place_road_path_of(&path, false),
                    Way::Out => world.place_one_way_of(&path, false),
                    Way::In => world.place_one_way_of(&path.iter().rev().copied().collect::<Vec<_>>(), false),
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
        let (mut solution, mut priority) = (Vec::new(), Vec::new());
        let mut rows_at: HashMap<u8, i32> = HashMap::new();
        for (height, line) in &solve {
            let row = rows_at.entry(*height).or_insert(0);
            for (col, &c) in line.iter().enumerate() {
                if c == '=' || c == '#' {
                    solution.push((at(col as i32, *row), *height));
                }
                if c == '#' {
                    priority.push(at(col as i32, *row));
                }
            }
            *row += 1;
        }
        let par = solution.iter().map(|&(_, h)| if h == 0 { 1 } else if h % 2 == 1 { 2 } else { 3 }).sum();
        let seed = name.bytes().fold(7u64, |h, b| h.wrapping_mul(31).wrapping_add(b as u64));
        let n = wants.len();
        let level = Level {
            name: name.to_string(),
            title,
            min: at(w - 1, h - 1),
            max: at(0, 0),
            gates,
            wants,
            par,
            par_flow: 1.0,
            solution,
            priority,
            phase: Phase::Build,
            rng: SmallRng::seed_from_u64(seed),
            seed,
            next: vec![0; n],
            queue: vec![VecDeque::new(); n],
            live: HashMap::new(),
            tally: vec![Tally::default(); n],
            started: 0,
            last_arrival: 0,
            jam: None,
            message: String::new(),
            done_flow: 0.0,
        };
        (level, world)
    }

    fn inside(&self, t: GridCoord) -> bool {
        (self.min.x..=self.max.x).contains(&t.x) && (self.min.y..=self.max.y).contains(&t.y)
    }

    /// Whether the player may take this step: on the map, and not into a
    /// gate's stub.
    pub fn allows(&self, world: &World, step: &Build) -> bool {
        let [hf, ht] = step.up.unwrap_or_default();
        let fixed = |t: GridCoord, h: u8| h == 0 && world.road_node_at(t).is_some_and(|id| matches!(world.objects.get(id).map(|e| &e.object), Some(GameObject::RoadNode(n)) if !n.laid));
        match step.tool {
            // A level's own road stays; a road of the player's may be cut
            // from it.
            Tool::Demolish if step.from == step.to => !fixed(step.to, ht),
            Tool::Demolish => !(fixed(step.from, hf) && fixed(step.to, ht)),
            _ => self.inside(step.from) && self.inside(step.to),
        }
    }

    /// Our own solve, laid: the steps the hand would take.
    pub fn solve_steps(&self, world: &World) -> Vec<Build> {
        let road = |t: GridCoord, h: u8| self.solution.contains(&(t, h)) || (h == 0 && self.gates.iter().any(|g| g.edge == t));
        let joins = |a: u8, b: u8| a.abs_diff(b) <= 1 && !(a == b && a % 2 == 1);
        let mut steps = Vec::new();
        for &(a, ha) in &self.solution {
            for (dx, dy) in [(1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1)] {
                let b = GridCoord { x: a.x + dx, y: a.y + dy };
                for hb in ha.saturating_sub(1)..=ha + 1 {
                    let beside = dx != 0 && dy != 0 && (road(GridCoord { x: a.x + dx, y: a.y }, ha) || road(GridCoord { x: a.x, y: a.y + dy }, ha));
                    let done = steps.iter().any(|s: &Build| s.from == b && s.to == a && s.up.unwrap_or_default() == [hb, ha]);
                    if road(b, hb) && joins(ha, hb) && !beside && !done && world.link_between_at(a, ha, b, hb).is_none() {
                        let tool = if ha == 0 && hb == 0 && self.priority.contains(&a) && self.priority.contains(&b) { Tool::Road } else { Tool::Street };
                        steps.push(Build { tool, from: a, to: b, up: (ha > 0 || hb > 0).then_some([ha, hb]) });
                    }
                }
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
    /// tile two, a deck's three, for the concrete and steel under them.
    pub fn cost(world: &World) -> u32 {
        world
            .objects
            .roads()
            .filter_map(|e| match e.object {
                GameObject::RoadNode(ref n) if n.laid => Some(match n.height {
                    0 => 1,
                    h if h % 2 == 1 => 2,
                    _ => 3,
                }),
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
        let material = if cost == 0 { 0.0 } else { self.par as f64 / cost as f64 };
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
            par: self.par,
            flow,
            material,
            par_flow: self.par_flow,
            efficiency: if self.phase == Phase::Done { 100.0 * flow / self.par_flow.max(1e-9) * material } else { 0.0 },
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

    fn lay(game: &mut Game, level: &Level, path: &[(i32, i32)]) {
        for p in path.windows(2) {
            let step = Build { tool: Tool::Street, from: GridCoord { x: p[0].0, y: p[0].1 }, to: GridCoord { x: p[1].0, y: p[1].1 }, up: None };
            assert!(level.allows(&game.world, &step), "{step:?} refused");
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
        lay(&mut game, &level, &(0..=9).rev().map(|x| (x, -1)).collect::<Vec<_>>());
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
            for step in level.solve_steps(&game.world) {
                assert!(level.allows(&game.world, &step), "{name}: {step:?} refused by the level");
                assert!(crate::game::take_step(&mut game.world, &mut game.events, &mut game.intersections, step, game.now), "{name}: {step:?} refused by the world");
            }
            let s = level.state(&game);
            assert!(s.wants.iter().all(|w| w.joined), "{name}: the solve leaves a want with no road");
            assert_eq!(s.cost, s.par, "{name}: the solve costs other than its par");
            level.test(&mut game);
            run(&mut level, &mut game, TEST_MS + 1000);
            let s = level.state(&game);
            assert_eq!(s.phase, Phase::Done, "{name}: {} at {:?}", s.message, s.jam);
            eprintln!("{name}: efficiency {:.1}, flow {:.2}, cost {}", s.efficiency, s.flow, s.cost);
            assert!((s.efficiency - 100.0).abs() < 0.5, "{name}: its own solve scores {:.1}", s.efficiency);
            assert!(s.par_flow > 0.5, "{name}: its own solve flows at {:.2}", s.par_flow);
        }
    }

    #[test]
    fn nothing_is_built_off_the_map_or_on_a_gate() {
        let (level, game) = play(CROSSING);
        let off = Build { tool: Tool::Street, from: GridCoord { x: 0, y: 0 }, to: GridCoord { x: -1, y: 0 }, up: None };
        assert!(!level.allows(&game.world, &off));
        let gate = Build { tool: Tool::Demolish, from: GridCoord { x: 9, y: -1 }, to: GridCoord { x: 9, y: -1 }, up: None };
        assert!(!level.allows(&game.world, &gate));
    }
}
