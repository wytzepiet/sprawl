//! The scenario harness: the sea's network run headless, for days, in a
//! fraction of a second. Ships sail their lines' routes, queue for a
//! harbour's one berth, and load and land boxes by `lines.rs`'s decision,
//! the game's own; the land side is rates: each harbour's tug moves `tug`
//! boxes an hour between the deck and the yard, and its depot's lorries
//! make `dray` round trips an hour, drop and hook, an export or an empty
//! in and an import out. The world keeps `EMPTIES` standing in each
//! yard, as the game's ferry does. The company's rule runs as in the
//! game: a harbour standing gets the world's ferry and a line to the
//! nearest harbour already standing, sized by the forecast (the demand
//! between the two); a backlog left behind adds a sailing.
//!
//! A scenario is text, `server/scenarios/<name>.txt`: a map (`~` sea, `.`
//! land, `A`..`Z` but `W` a harbour on its quay tile, its berth straight
//! out to sea; the map's border is the world), then directives, a line
//! each:
//!
//! ```text
//! harbour A docks=9 dray=4/h tug=4/h day=0   # stands on day 0
//! line A B ships=2 slots=15 dwell=1.25h  # a line besides the company's
//! demand W->A crates 3/day from=0  # `empty` for empties; W is the world
//! stay 0.5h                        # at the world, beyond the edge
//! days 10
//! expect delivered >= 0.95        # any metric in the table; hours bare
//! pending stage 5: blocks          # runs and prints, asserts nothing
//! ```
//!
//! `cargo test scenario -- --nocapture` runs them all, `SCENARIO=two`
//! one; each prints a page a day and a row of the table, and `SVG=1`
//! draws it into `.dev/scenarios/<name>.svg`.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap, VecDeque};

use crate::engine::GameTime;
use crate::protocol::{GridCoord, Good, DAY_MS};
use crate::world::sea::{DECK, DWELL, EMPTIES};

use super::lines::{boards, by_sea, earliest, prior, slot, worth_a_line, timetable, Call, Change, Connection, Line, BACKLOG, FIRST_SAILING, TRIAL};
use super::water::{Berth, End, Water, BERTH};
use super::{covered, length, point_at, HOUR, WORLD_STAY};

const DAY: GameTime = DAY_MS as GameTime;

struct Port {
    letter: char,
    berth: Berth,
    docks: usize,
    dray: f64,
    tug: f64,
    /// The day it stands.
    day: u64,
}

struct LineSpec {
    calls: Vec<char>,
    ships: usize,
    slots: usize,
    dwell: GameTime,
}

struct Demand {
    from: char,
    to: char,
    good: Option<Good>,
    per_day: f64,
    from_day: u64,
}

struct Expect {
    metric: String,
    op: String,
    value: f64,
}

pub struct Scenario {
    name: String,
    rows: Vec<Vec<u8>>,
    water: Water,
    ports: Vec<Port>,
    lines: Vec<LineSpec>,
    demand: Vec<Demand>,
    /// Roads between harbours, and how long a lorry takes.
    roads: Vec<(char, char, GameTime)>,
    stay: GameTime,
    days: u64,
    expects: Vec<Expect>,
    pending: Option<String>,
}

/// `1.25h` or `30m` in ms; a bare number is hours.
fn duration(s: &str) -> GameTime {
    let (n, unit) = if let Some(m) = s.strip_suffix('m') { (m, HOUR / 60) } else { (s.trim_end_matches('h'), HOUR) };
    (n.parse::<f64>().unwrap_or_else(|_| panic!("not a duration: {s}")) * unit as f64).round() as GameTime
}

fn good(s: &str) -> Option<Good> {
    match s {
        "crates" => Some(Good::Crates),
        "fuel" => Some(Good::Fuel),
        "timber" => Some(Good::Timber),
        "empty" => None,
        _ => panic!("no good {s}"),
    }
}

impl Scenario {
    pub fn parse(name: &str, text: &str) -> Scenario {
        let mut lines = text.lines().map(|l| l.split('#').next().unwrap().trim_end()).peekable();
        while lines.peek().is_some_and(|l| l.trim().is_empty()) {
            lines.next();
        }
        let mut rows: Vec<Vec<u8>> = Vec::new();
        while let Some(l) = lines.peek().filter(|l| !l.is_empty() && l.bytes().all(|b| b == b'~' || b == b'.' || b.is_ascii_uppercase())) {
            rows.push(l.as_bytes().to_vec());
            lines.next();
        }
        assert!(!rows.is_empty() && rows.iter().all(|r| r.len() == rows[0].len()), "{name}: the map's rows are not all as long");
        let (w, h) = (rows[0].len() as i32, rows.len() as i32);
        let sea = |x: i32, y: i32| x >= 0 && y >= 0 && x < w && y < h && rows[y as usize][x as usize] != b'.';
        let water = Water::new(0, 0, w, h, sea);
        let mut s = Scenario { name: name.into(), water, ports: Vec::new(), lines: Vec::new(), demand: Vec::new(), roads: Vec::new(), stay: WORLD_STAY, days: 7, expects: Vec::new(), pending: None, rows: Vec::new() };
        for l in lines {
            let words: Vec<&str> = l.split_whitespace().collect();
            let opt = |key: &str| words.iter().find_map(|w| w.strip_prefix(key).and_then(|v| v.strip_prefix('=')));
            let rate = |key: &str, d: f64| opt(key).map_or(d, |v| v.trim_end_matches("/h").parse().unwrap());
            match words.first().copied() {
                None => {}
                Some("harbour") => {
                    let letter = words[1].chars().next().unwrap();
                    let at = (0..h).flat_map(|y| (0..w).map(move |x| (x, y))).find(|&(x, y)| rows[y as usize][x as usize] == letter as u8).unwrap_or_else(|| panic!("{name}: no {letter} on the map"));
                    let quay = GridCoord { x: at.0, y: at.1 };
                    let berth = [(0, 1), (0, -1), (1, 0), (-1, 0)]
                        .into_iter()
                        .map(|out| Berth { quay, out })
                        .find(|b| !sea(quay.x - b.out.0, quay.y - b.out.1) && (0..BERTH).all(|n| sea(b.tile(n).x, b.tile(n).y)))
                        .unwrap_or_else(|| panic!("{name}: {letter} has no land behind it and {BERTH} tiles of sea in front"));
                    s.ports.push(Port { letter, berth, docks: rate("docks", 9.0) as usize, dray: rate("dray", 4.0), tug: rate("tug", 4.0), day: rate("day", 0.0) as u64 });
                }
                Some("line") => {
                    let calls = words[1..].iter().take_while(|w| !w.contains('=')).map(|w| w.chars().next().unwrap()).collect();
                    s.lines.push(LineSpec {
                        calls,
                        ships: rate("ships", 1.0) as usize,
                        slots: rate("slots", DECK as f64) as usize,
                        dwell: opt("dwell").map_or(DWELL, duration),
                    });
                }
                Some("demand") => {
                    let (from, to) = words[1].split_once("->").unwrap();
                    let per_day = words[3].trim_end_matches("/day").parse().unwrap();
                    s.demand.push(Demand { from: from.chars().next().unwrap(), to: to.chars().next().unwrap(), good: good(words[2]), per_day, from_day: rate("from", 0.0) as u64 });
                }
                Some("stay") => s.stay = duration(words[1]),
                Some("road") => s.roads.push((words[1].chars().next().unwrap(), words[2].chars().next().unwrap(), duration(words[3]))),
                Some("days") => s.days = words[1].parse().unwrap(),
                Some("expect") => s.expects.push(Expect { metric: words[1].into(), op: words[2].into(), value: words[3].trim_end_matches('h').parse().unwrap() }),
                Some("pending") => s.pending = Some(words[1..].join(" ")),
                Some(other) => panic!("{name}: no directive {other}"),
            }
        }
        s.rows = rows;
        s
    }

    fn call(&self, letter: char) -> Call {
        if letter == 'W' {
            return Call::World;
        }
        Call::Harbour(self.ports.iter().position(|p| p.letter == letter).unwrap_or_else(|| panic!("{}: no harbour {letter}", self.name)) as u64)
    }

    fn end(&self, c: Call) -> End {
        match c {
            Call::Harbour(p) => End::Berth(self.ports[p as usize].berth),
            Call::World => End::Edge,
        }
    }

    /// The way from one call to the next: from the world, the way out
    /// to it turned round.
    fn leg(&self, from: Call, to: Call) -> Vec<[f64; 2]> {
        let way = |a: Call, b: Call| match a {
            Call::Harbour(p) => self.water.route(&self.ports[p as usize].berth, self.end(b)),
            Call::World => None,
        };
        let found = if from == Call::World { way(to, from).map(|mut w| { w.reverse(); w }) } else { way(from, to) };
        found.unwrap_or_else(|| panic!("{}: no way over the water from {from:?} to {to:?}", self.name))
    }
}

#[derive(Clone)]
struct Box {
    from: Call,
    to: Call,
    good: Option<Good>,
    ready: GameTime,
    quoted: Option<GameTime>,
    landed: Option<GameTime>,
    rides: u32,
    via_world: bool,
    by_road: bool,
}

impl Box {
    fn units(&self) -> f64 {
        self.good.map_or(0.0, |g| g.per_box())
    }
}

#[derive(Default)]
struct Yard {
    at_berth: Option<usize>,
    queue: VecDeque<(usize, GameTime)>,
    yard: Vec<usize>,
    /// Exports at the depot, waiting for an empty and a lorry.
    depot: VecDeque<usize>,
    /// Empties at the depot.
    empties: u32,
    /// The box the tug has, and which way.
    tug: Option<(usize, bool)>,
    standing: bool,
    /// Since when its forecast has said boxes would flow.
    flows: Option<GameTime>,
    peak: usize,
    calls: u32,
    landed: u32,
    loaded: u32,
}

struct Ship {
    line: usize,
    /// When it first leaves its line's first call, and round again.
    phase: GameTime,
    at: usize,
    deck: Vec<usize>,
    round: u64,
    delay: GameTime,
    departs: GameTime,
    /// Every leg sailed: the way, when, and eased where.
    sails: Vec<(Vec<[f64; 2]>, GameTime, [bool; 2])>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Ev {
    Arrive(usize),
    Berth(usize),
    Depart(usize),
    Tug(usize),
    TugDone(usize),
    Dray(usize),
    Demand(usize),
    Road(usize),
    Stand(usize),
    Midnight,
}

pub struct Sim<'a> {
    s: &'a Scenario,
    now: GameTime,
    seq: u64,
    queue: BinaryHeap<Reverse<(GameTime, u64, Ev)>>,
    lines: Vec<Line>,
    ships: Vec<Ship>,
    ports: Vec<Yard>,
    boxes: Vec<Box>,
    beyond: Vec<usize>,
    /// Each line: when it opened, the boxes a day it was forecast, when
    /// it first sailed; and each sailing after its trial, from which
    /// call, with how many full boxes.
    opened: Vec<(GameTime, f64, Option<GameTime>, Vec<(usize, usize)>)>,
    /// When a pair's backlog may next add a sailing.
    added: BTreeMap<(Call, Call), GameTime>,
    /// What happened, a line each: a page a day and the company's moves.
    pub pages: Vec<String>,
    log: u64,
    berth_wait: GameTime,
    wait_max: GameTime,
    /// The longest a harbour with a flow forecast waited for its line.
    flow_to_line: GameTime,
    missed: u32,
    /// Per line: boxes aboard at each sailing, and sailings.
    filled: Vec<(usize, usize)>,
    rides: (u32, u32),
}

/// The numbers a scenario is judged by, by name.
pub type Metrics = BTreeMap<&'static str, f64>;

fn p90(mut v: Vec<f64>) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(f64::total_cmp);
    v[((v.len() - 1) as f64 * 0.9).round() as usize]
}

fn mean(v: &[f64]) -> f64 {
    if v.is_empty() { 0.0 } else { v.iter().sum::<f64>() / v.len() as f64 }
}

fn hours(ms: GameTime) -> f64 {
    ms as f64 / HOUR as f64
}

impl<'a> Sim<'a> {
    pub fn new(s: &'a Scenario) -> Sim<'a> {
        let mut sim = Sim {
            s,
            now: 0,
            seq: 0,
            queue: BinaryHeap::new(),
            lines: Vec::new(),
            ships: Vec::new(),
            ports: s.ports.iter().map(|_| Yard::default()).collect(),
            boxes: Vec::new(),
            beyond: Vec::new(),
            opened: Vec::new(),
            added: BTreeMap::new(),
            pages: Vec::new(),
            log: 0xcbf2_9ce4_8422_2325,
            berth_wait: 0,
            wait_max: 0,
            flow_to_line: 0,
            missed: 0,
            filled: Vec::new(),
            rides: (0, 0),
        };
        for (p, port) in s.ports.iter().enumerate() {
            sim.at(port.day * DAY, Ev::Stand(p));
        }
        for spec in &s.lines {
            let calls: Vec<Call> = spec.calls.iter().map(|&c| s.call(c)).collect();
            let l = sim.add_line(calls, spec.slots, spec.dwell);
            sim.add_ships(l, spec.ships, 0, FIRST_SAILING);
        }
        for (d, demand) in s.demand.iter().enumerate() {
            // Evenly through the days, a half step in.
            let every = DAY as f64 / demand.per_day;
            let n = ((s.days - demand.from_day) as f64 * demand.per_day).floor() as u64;
            for k in 0..n {
                sim.at(demand.from_day * DAY + ((k as f64 + 0.5) * every) as GameTime, Ev::Demand(d));
            }
        }
        for day in 1..=s.days {
            sim.at(day * DAY, Ev::Midnight);
        }
        sim
    }

    fn at(&mut self, t: GameTime, e: Ev) {
        self.seq += 1;
        self.queue.push(Reverse((t, self.seq, e)));
    }

    /// A line, with no ships yet.
    fn add_line(&mut self, calls: Vec<Call>, slots: usize, dwell: GameTime) -> usize {
        let legs = (0..calls.len()).map(|i| self.s.leg(calls[i], calls[(i + 1) % calls.len()])).collect();
        self.lines.push(Line { calls, legs, ships: Vec::new(), slots, dwell, stay: self.s.stay, every: 0 });
        self.filled.push((0, 0));
        self.opened.push((self.now, 0.0, None, Vec::new()));
        self.lines.len() - 1
    }

    /// `n` ships evenly round a line, the first leaving its call `at` in
    /// the first free window from `soon` on, each coming in to the call
    /// it first leaves.
    fn add_ships(&mut self, l: usize, n: usize, at: usize, soon: GameTime) {
        let line = &self.lines[l];
        let (cycle, offset, stay) = (line.cycle(), line.offset(at), line.stay(line.calls[at]));
        let first = slot(&self.lines, line, at, self.now + soon);
        for k in 0..n as GameTime {
            let leaves = first + cycle * k / n as GameTime;
            // Its call `at`, with each ship's own round counted from it.
            let phase = leaves.saturating_sub(offset);
            let id = self.ships.len();
            self.ships.push(Ship { line: l, phase, at, deck: Vec::new(), round: 0, delay: 0, departs: 0, sails: Vec::new() });
            self.lines[l].ships.push((id as u64, phase));
            self.at(leaves.saturating_sub(stay).max(self.now), Ev::Arrive(id));
        }
    }

    /// A harbour stands: the company links it to the nearest harbour
    /// standing, by sea, with sailings enough for what the two ends
    /// forecast between them, and the world's ferry comes to it.
    fn stand(&mut self, p: usize) {
        let here = Call::Harbour(p as u64);
        self.ports[p].standing = true;
        self.at(self.now + (HOUR as f64 / self.s.ports[p].dray) as GameTime / 2, Ev::Dray(p));
        self.connect(p);
        // The world's ferry after: it takes the window the link leaves.
        let world = self.add_line(vec![here, Call::World], crate::world::sea::DECK, DWELL);
        self.add_ships(world, 1, 0, FIRST_SAILING);
    }

    /// The road between two harbours, if one joins them.
    fn road(&self, a: Call, b: Call) -> Option<GameTime> {
        self.s.roads.iter().find(|r| (self.s.call(r.0), self.s.call(r.1)) == (a, b) || (self.s.call(r.0), self.s.call(r.1)) == (b, a)).map(|r| r.2)
    }

    /// The sea leg between two harbours, and whether it beats the road.
    fn sea(&self, p: usize, q: usize) -> Option<(f64, bool)> {
        let len = length(&self.s.water.route(&self.s.ports[p].berth, End::Berth(self.s.ports[q].berth))?);
        Some((len, by_sea(super::sail_ms(len, [true, true]), self.road(Call::Harbour(p as u64), Call::Harbour(q as u64)))))
    }

    /// A harbour with no line to another of the player's is linked to the
    /// nearest by sea where the sea beats the road, once its forecast says
    /// boxes would flow (`lines::worth_a_line`). A new harbour is a leaf:
    /// all its trade with the others that goes by sea goes over its one
    /// link. Asked when it stands, and each midnight, as rules and makers
    /// change.
    fn connect(&mut self, p: usize) {
        let here = Call::Harbour(p as u64);
        if self.lines.iter().any(|l| l.calls.contains(&here) && !l.calls.contains(&Call::World)) {
            return;
        }
        let ways: Vec<(u64, f64)> = (0..self.ports.len())
            .filter(|&q| q != p && self.ports[q].standing)
            .filter_map(|q| self.sea(p, q).filter(|s| s.1).map(|s| (q as u64, s.0)))
            .collect();
        let Some(q) = prior(&ways) else { return };
        let by_sea = |c: Call| self.road(here, c).is_none() || matches!(c, Call::Harbour(r) if self.sea(p, r as usize).is_some_and(|s| s.1));
        let per_day = self.forecast(|c| c == here, |c| c != here && by_sea(c)).max(self.forecast(|c| c != here && by_sea(c), |c| c == here));
        if per_day > 0.0 {
            self.ports[p].flows.get_or_insert(self.now);
        }
        let sea = super::sail_ms(ways.iter().find(|w| w.0 == q).unwrap().1, [true, true]);
        if worth_a_line(sea, self.road(here, Call::Harbour(q)), per_day) {
            self.flow_to_line = self.flow_to_line.max(self.now - self.ports[p].flows.unwrap());
            self.link(here, Call::Harbour(q), per_day, FIRST_SAILING);
        }
    }

    /// A line between two harbours, with sailings for their forecast: the
    /// boxes a day either way, the larger.
    /// Its first sailing leaves whichever end has a window first.
    fn link(&mut self, a: Call, b: Call, per_day: f64, soon: GameTime) {
        let l = self.add_line(vec![a, b], crate::world::sea::DECK, DWELL);
        let n = self.lines[l].sized(per_day, DWELL);
        let at = (0..2).min_by_key(|&i| slot(&self.lines, &self.lines[l], i, self.now + soon)).unwrap();
        self.opened[l].1 = per_day;
        self.pages.push(format!("  {:.1}h: the company opens a line {a:?} - {b:?}, {per_day:.1} boxes a day forecast: {n} ships, {:.0} min at a berth", hours(self.now), hours(self.lines[l].dwell) * 60.0));
        self.add_ships(l, n, at, soon);
    }

    /// The boxes a day the scenario's towns ask for, from harbours `from`
    /// picks to harbours `to` picks, as their rules and makers would say.
    fn forecast(&self, from: impl Fn(Call) -> bool, to: impl Fn(Call) -> bool) -> f64 {
        let day = self.now / DAY;
        let own = |c: Call| c != Call::World;
        self.s.demand.iter().filter(|d| d.from_day <= day && own(self.s.call(d.from)) && own(self.s.call(d.to)) && from(self.s.call(d.from)) && to(self.s.call(d.to))).map(|d| d.per_day).sum::<f64>() + 0.0
    }

    /// The timetable as it stands: as published, each ship as late as it
    /// is now.
    fn conns(&self) -> Vec<Connection> {
        let mut c: Vec<Connection> = timetable(&self.lines, self.now.saturating_sub(DAY), self.now + 4 * DAY)
            .into_iter()
            .map(|c| {
                let late = self.ships[c.ship as usize].delay;
                Connection { departs: c.departs + late, arrives: c.arrives + late, ..c }
            })
            .filter(|c| c.departs >= self.now)
            .collect();
        c.sort_by_key(|c| (c.departs, c.ship));
        c
    }

    fn here(&self, ship: usize) -> Call {
        let s = &self.ships[ship];
        self.lines[s.line].calls[s.at]
    }

    /// When the ship is due to leave the call it is at.
    fn due(&self, ship: usize) -> GameTime {
        let s = &self.ships[ship];
        let line = &self.lines[s.line];
        s.phase + line.offset(s.at) + s.round * line.cycle()
    }

    /// Does a box stay aboard here: is this ship the first ride of its
    /// earliest journey on.
    fn stays(&self, conns: &[Connection], ship: usize, b: usize) -> bool {
        let here = self.here(ship);
        self.boxes[b].to != here && boards(conns, ship as u64, here, self.boxes[b].to, self.now)
    }

    fn land(&mut self, b: usize) {
        self.boxes[b].landed = Some(self.now);
    }

    fn board(&mut self, ship: usize, b: usize) {
        self.ships[ship].deck.push(b);
        self.boxes[b].rides += 1;
        self.rides.1 += 1;
        if self.boxes[b].good.is_none() {
            self.rides.0 += 1;
        }
    }

    fn new_box(&mut self, from: Call, to: Call, good: Option<Good>) -> usize {
        let conns = self.conns();
        let quoted = earliest(&conns, from, to, self.now).map(|j| j.arrives);
        self.boxes.push(Box { from, to, good, ready: self.now, quoted, landed: None, rides: 0, via_world: false, by_road: false });
        self.boxes.len() - 1
    }

    pub fn run(&mut self) {
        let end = self.s.days * DAY;
        while let Some(Reverse((t, seq, e))) = self.queue.pop() {
            if t > end {
                break;
            }
            self.now = t;
            for v in [t, seq, match e {
                Ev::Arrive(i) | Ev::Berth(i) | Ev::Depart(i) | Ev::Tug(i) | Ev::TugDone(i) | Ev::Dray(i) | Ev::Demand(i) | Ev::Road(i) | Ev::Stand(i) => i as u64,
                Ev::Midnight => u64::MAX,
            }] {
                self.log = (self.log ^ v).wrapping_mul(0x100_0000_01b3);
            }
            match e {
                Ev::Arrive(s) => self.arrive(s),
                Ev::Berth(s) => self.berth(s),
                Ev::Depart(s) => self.depart(s),
                Ev::Tug(p) => self.tug(p),
                Ev::TugDone(p) => self.tug_done(p),
                Ev::Dray(p) => self.dray(p),
                Ev::Demand(d) => self.demand(d),
                Ev::Stand(p) => self.stand(p),
                Ev::Road(b) => {
                    self.boxes[b].by_road = true;
                    self.land(b);
                }
                Ev::Midnight => self.midnight(),
            }
        }
        self.now = end;
    }

    fn arrive(&mut self, s: usize) {
        match self.here(s) {
            Call::World => {
                let conns = self.conns();
                let deck = std::mem::take(&mut self.ships[s].deck);
                for b in deck {
                    if self.boxes[b].to == Call::World {
                        self.land(b);
                    } else if self.stays(&conns, s, b) {
                        self.ships[s].deck.push(b);
                    } else {
                        self.boxes[b].via_world = true;
                        self.beyond.push(b);
                    }
                }
                let due = self.due(s).max(self.now);
                self.ships[s].departs = due;
                self.ships[s].delay = due - self.due(s);
                self.at(due, Ev::Depart(s));
            }
            Call::Harbour(p) => {
                let p = p as usize;
                // Early, it waits at the anchorage for its time.
                let dwell = self.lines[self.ships[s].line].dwell;
                if self.now + dwell < self.due(s) {
                    self.at(self.due(s) - dwell, Ev::Arrive(s));
                } else if self.ports[p].at_berth.is_none() {
                    self.berth(s);
                } else {
                    self.ports[p].queue.push_back((s, self.now));
                }
            }
        }
    }

    fn berth(&mut self, s: usize) {
        let Call::Harbour(p) = self.here(s) else { return };
        let p = p as usize;
        self.ports[p].at_berth = Some(s);
        self.ports[p].calls += 1;
        // A late ship cuts its dwell, down to half, to catch up.
        let dwell = self.lines[self.ships[s].line].dwell;
        let due = self.due(s).max(self.now + dwell / 2);
        self.ships[s].delay = due - self.due(s);
        self.ships[s].departs = due;
        self.at(due, Ev::Depart(s));
        self.at(self.now, Ev::Tug(p));
    }

    fn depart(&mut self, s: usize) {
        let conns = self.conns();
        let here = self.here(s);
        let line = self.ships[s].line;
        match here {
            Call::Harbour(p) => {
                let p = p as usize;
                // What should have gone and did not: a full deck, or no
                // time for the tug.
                let left = self.ports[p].yard.iter().filter(|&&b| self.boxes[b].to != here && boards(&conns, s as u64, here, self.boxes[b].to, self.now)).count();
                self.missed += left as u32;
                self.ports[p].at_berth = None;
                self.backlog(p, s, left);
                if let Some((next, since)) = self.ports[p].queue.pop_front() {
                    self.berth_wait += self.now - since;
                    self.wait_max = self.wait_max.max(self.now - since);
                    self.at(self.now, Ev::Berth(next));
                }
            }
            Call::World => {
                let slots = self.lines[line].slots;
                let mut waiting = std::mem::take(&mut self.beyond);
                waiting.retain(|&b| {
                    let go = self.ships[s].deck.len() < slots && boards(&conns, s as u64, Call::World, self.boxes[b].to, self.now);
                    if go {
                        self.board(s, b);
                    }
                    !go
                });
                self.beyond = waiting;
                // The world keeps empties standing at the next harbour.
                let n = self.lines[line].calls.len();
                let next = self.lines[line].calls[(self.ships[s].at + 1) % n];
                if let Call::Harbour(p) = next {
                    let standing = self.ports[p as usize].yard.iter().chain(&self.ships[s].deck).filter(|&&b| self.boxes[b].good.is_none() && self.boxes[b].to == next).count();
                    for _ in standing..EMPTIES {
                        if self.ships[s].deck.len() < slots {
                            let b = self.new_box(Call::World, next, None);
                            self.board(s, b);
                        }
                    }
                }
            }
        }
        self.filled[line].0 += self.ships[s].deck.len();
        self.filled[line].1 += 1;
        let opened = &mut self.opened[line];
        opened.2.get_or_insert(self.now);
        if self.now >= opened.0 + TRIAL * DAY {
            opened.3.push((self.ships[s].at, self.ships[s].deck.iter().filter(|&&b| self.boxes[b].good.is_some()).count()));
        }
        let ship = &mut self.ships[s];
        let l = &self.lines[line];
        let n = l.calls.len();
        let leg = l.legs[ship.at].clone();
        let ease = [l.calls[ship.at] != Call::World, l.calls[(ship.at + 1) % n] != Call::World];
        let ms = l.leg_ms(ship.at);
        ship.sails.push((leg, self.now, ease));
        ship.at = (ship.at + 1) % n;
        if ship.at == 0 {
            ship.round += 1;
        }
        self.at(self.now + ms, Ev::Arrive(s));
    }

    /// The tug's next move, if the ship at the berth has time for one:
    /// a box off that ends here or changes ship here, while the yard has
    /// room; else a box on that this ship is the first ride for.
    fn tug(&mut self, p: usize) {
        let y = &self.ports[p];
        let Some(s) = y.at_berth.filter(|_| y.tug.is_none()) else { return };
        let ms = (HOUR as f64 / self.s.ports[p].tug) as GameTime;
        // Done before it sails, or not started.
        if self.now + ms >= self.ships[s].departs {
            return;
        }
        let conns = self.conns();
        let here = self.here(s);
        let room = self.ports[p].yard.len() < self.s.ports[p].docks;
        let off = self.ships[s].deck.iter().position(|&b| !self.stays(&conns, s, b)).filter(|_| room);
        let slots = self.lines[self.ships[s].line].slots;
        let on = off.is_none().then(|| {
            self.ports[p].yard.iter().position(|&b| self.boxes[b].to != here && self.ships[s].deck.len() < slots && boards(&conns, s as u64, here, self.boxes[b].to, self.now))
        });
        let job = match (off, on.flatten()) {
            (Some(k), _) => Some((self.ships[s].deck.remove(k), true)),
            (None, Some(i)) => Some((self.ports[p].yard.remove(i), false)),
            _ => None,
        };
        if let Some(job) = job {
            self.ports[p].tug = Some(job);
            self.at(self.now + ms, Ev::TugDone(p));
        }
    }

    fn tug_done(&mut self, p: usize) {
        let Some((b, off)) = self.ports[p].tug.take() else { return };
        let here = Call::Harbour(p as u64);
        match self.ports[p].at_berth {
            Some(s) if !off => {
                self.board(s, b);
                self.ports[p].loaded += 1;
            }
            _ => {
                self.ports[p].yard.push(b);
                if off {
                    self.ports[p].landed += 1;
                    if self.boxes[b].to == here {
                        self.land(b);
                    }
                }
            }
        }
        let y = &mut self.ports[p];
        y.peak = y.peak.max(y.yard.len());
        self.tug(p);
    }

    /// A lorry's round trip, drop and hook: it brings an export, filled
    /// at the depot from the empty it kept, or an empty the depot has no
    /// use for; and takes an import home, or an empty for an export.
    fn dray(&mut self, p: usize) {
        let here = Call::Harbour(p as u64);
        let docks = self.s.ports[p].docks;
        let import = self.ports[p].yard.iter().position(|&b| self.boxes[b].to == here && self.boxes[b].good.is_some());
        let y = &mut self.ports[p];
        if y.yard.len() < docks {
            if y.empties > 0 && let Some(b) = y.depot.pop_front() {
                y.empties -= 1;
                y.yard.push(b);
            } else if y.empties > 1 && import.is_some() {
                y.empties -= 1;
                let b = self.new_box(here, Call::World, None);
                self.ports[p].yard.push(b);
            }
        }
        let y = &mut self.ports[p];
        let import = y.yard.iter().position(|&b| self.boxes[b].to == here && self.boxes[b].good.is_some());
        let empty = y.yard.iter().position(|&b| self.boxes[b].to == here && self.boxes[b].good.is_none());
        match (import, empty) {
            (Some(i), _) => {
                y.yard.remove(i);
                y.empties += 1;
            }
            (None, Some(i)) if !y.depot.is_empty() && y.empties == 0 => {
                y.yard.remove(i);
                y.empties += 1;
            }
            _ => {}
        }
        y.peak = y.peak.max(y.yard.len());
        self.at(self.now + (HOUR as f64 / self.s.ports[p].dray) as GameTime, Ev::Dray(p));
        self.at(self.now, Ev::Tug(p));
    }

    fn demand(&mut self, d: usize) {
        let demand = &self.s.demand[d];
        let (from, to) = (self.s.call(demand.from), self.s.call(demand.to));
        let b = self.new_box(from, to, demand.good);
        // Where the road beats the sea, a lorry drives it there.
        if let (Call::Harbour(p), Call::Harbour(q)) = (from, to)
            && let Some(road) = self.road(from, to).filter(|_| self.sea(p as usize, q as usize).is_none_or(|s| !s.1))
        {
            self.boxes[b].quoted = Some(self.now + road);
            self.at(self.now + road, Ev::Road(b));
            return;
        }
        match from {
            Call::World => self.beyond.push(b),
            Call::Harbour(p) => self.ports[p as usize].depot.push_back(b),
        }
    }

    /// A ship sails from a harbour: the company reads the backlog. A line
    /// that left `BACKLOG` boxes behind stands longer or gets a sailing
    /// more (`lines::backlog`); boxes with no way at all to a harbour of
    /// the player's open a line to it. Once a cycle at most, a pair.
    fn backlog(&mut self, p: usize, ship: usize, left: usize) {
        let here = Call::Harbour(p as u64);
        let l = self.ships[ship].line;
        let line = &self.lines[l];
        if let Some(&to) = line.calls.iter().find(|&&c| c != here).filter(|_| !line.calls.contains(&Call::World))
            && self.added.get(&(here.min(to), here.max(to))).is_none_or(|&t| self.now >= t)
            && let Some(change) = super::lines::backlog(line, left, self.ships[ship].deck.len() >= line.slots, DWELL)
        {
            let at = line.calls.iter().position(|&c| c == here).unwrap();
            self.added.insert((here.min(to), here.max(to)), self.now + line.cycle());
            match change {
                Change::Sailing => {
                    self.pages.push(format!("  {:.1}h: {left} boxes left behind at {here:?}: a sailing added", hours(self.now)));
                    self.add_ships(l, 1, at, FIRST_SAILING);
                }
                Change::Dwell(dwell) => {
                    self.pages.push(format!("  {:.1}h: {left} boxes left behind at {here:?}: {:.0} min at a berth", hours(self.now), hours(dwell) * 60.0));
                    // Each ship keeps its next departure; the rest of its
                    // rounds follow the new dwell.
                    let ships: Vec<(usize, GameTime)> = self.lines[l].ships.iter().map(|&(id, _)| (id as usize, self.due(id as usize))).collect();
                    self.lines[l].dwell = dwell;
                    for (s, due) in ships {
                        let phase = due.saturating_sub(self.lines[l].offset(self.ships[s].at));
                        self.ships[s].phase = phase;
                        self.ships[s].round = 0;
                        self.lines[l].ships.iter_mut().find(|x| x.0 == s as u64).unwrap().1 = phase;
                    }
                }
            }
        }
        let conns = self.conns();
        let mut stranded: BTreeMap<Call, usize> = BTreeMap::new();
        for &b in &self.ports[p].yard {
            let to = self.boxes[b].to;
            if self.boxes[b].good.is_some() && to != here && to != Call::World && earliest(&conns, here, to, self.now).is_none() {
                *stranded.entry(to).or_default() += 1;
            }
        }
        for (to, n) in stranded {
            let pair = (here.min(to), here.max(to));
            let Call::Harbour(q) = to else { continue };
            let per_day = self.forecast(|c| c == here, |c| c == to).max(self.forecast(|c| c == to, |c| c == here));
            let sea = self.sea(p, q as usize).map_or(GameTime::MAX / 4, |s| super::sail_ms(s.0, [true, true]));
            if n >= BACKLOG && worth_a_line(sea, self.road(here, to), per_day.max(n as f64)) && self.added.get(&pair).is_none_or(|&t| self.now >= t) {
                self.link(here, to, per_day, FIRST_SAILING);
                let cycle = self.lines.last().unwrap().cycle();
                self.added.insert(pair, self.now + cycle);
            }
        }
    }

    /// A page a day.
    fn midnight(&mut self) {
        for p in 0..self.ports.len() {
            if self.ports[p].standing {
                self.connect(p);
            }
        }
        let day = self.now / DAY;
        let landed = self.boxes.iter().filter(|b| b.landed.is_some() && b.good.is_some()).count();
        let made = self.boxes.iter().filter(|b| b.good.is_some()).count();
        let yards: Vec<String> = self.s.ports.iter().zip(&self.ports).filter(|(_, y)| y.standing).map(|(p, y)| format!("{}{}+{}", p.letter, y.yard.len(), y.depot.len())).collect();
        let at_sea: usize = self.ships.iter().map(|s| s.deck.len()).sum();
        self.pages.push(format!("  day {day}: {landed}/{made} landed, {at_sea} aboard, {} beyond, yards {}, {} ships, berth wait {:.1}h", self.beyond.len(), yards.join(" "), self.ships.len(), hours(self.berth_wait)));
    }

    pub fn metrics(&self) -> Metrics {
        let end = self.now;
        let full: Vec<&Box> = self.boxes.iter().filter(|b| b.good.is_some()).collect();
        let due = full.iter().filter(|b| b.quoted.is_some_and(|q| q <= end)).count();
        let landed: Vec<&&Box> = full.iter().filter(|b| b.landed.is_some()).collect();
        let transit: Vec<f64> = landed.iter().map(|b| hours(b.landed.unwrap() - b.ready)).collect();
        let late: Vec<f64> = landed.iter().filter_map(|b| Some((b.landed? as f64 - b.quoted? as f64) / HOUR as f64)).collect();
        let quoted: Vec<f64> = landed.iter().filter_map(|b| Some(hours(b.quoted? - b.ready))).collect();
        let transfers = mean(&landed.iter().map(|b| b.rides.saturating_sub(1) as f64).collect::<Vec<_>>());
        // The lines between harbours: how soon each first sailed, how its
        // forecast compares with what it carried a day after its trial,
        // and how many of those sailings left with no full box aboard.
        let links: Vec<(&Line, &(GameTime, f64, Option<GameTime>, Vec<(usize, usize)>))> = self.lines.iter().zip(&self.opened).filter(|(l, _)| !l.calls.contains(&Call::World)).collect();
        let first_sailing = links.iter().map(|(_, o)| o.2.map_or(f64::INFINITY, |t| hours(t - o.0))).fold(0.0, f64::max);
        let forecast_ratio = links.iter().filter(|(_, o)| !o.3.is_empty()).map(|(_, o)| {
            // Boxes a day the busier way, over the days after the trial.
            let days = (self.now - (o.0 + TRIAL * DAY)) as f64 / DAY as f64;
            let way = |k: usize| o.3.iter().filter(|s| s.0 == k).map(|s| s.1).sum::<usize>() as f64 / days.max(1e-9);
            let (f, c) = (o.1.max(0.5), way(0).max(way(1)).max(0.5));
            (f / c).max(c / f)
        }).fold(1.0, f64::max);
        // From each line's busier end: the way back of a one-way trade
        // sails empty whatever the forecast says.
        let after: Vec<usize> = links
            .iter()
            .flat_map(|(_, o)| {
                let busier = (0..2).max_by_key(|&k| (o.3.iter().filter(|s| s.0 == k).map(|s| s.1).sum::<usize>(), k)).unwrap();
                o.3.iter().filter(move |s| s.0 == busier).map(|s| s.1)
            })
            .collect();
        let near_empty = if after.is_empty() { 0.0 } else { after.iter().filter(|&&n| n == 0).count() as f64 / after.len() as f64 };
        let coins_out: f64 = landed.iter().filter(|b| b.from == Call::World).map(|b| crate::economy::import(b.good.unwrap(), b.units())).sum::<f64>() + 0.0;
        let coins_in: f64 = landed.iter().filter(|b| b.to == Call::World).map(|b| crate::economy::export(b.good.unwrap(), b.units())).sum::<f64>() + 0.0;
        let calls: u32 = self.ports.iter().map(|y| y.calls).sum();
        let util: Vec<f64> = self.filled.iter().zip(&self.lines).filter(|(f, _)| f.1 > 0).map(|(f, l)| f.0 as f64 / (f.1 * l.slots) as f64).collect();
        Metrics::from([
            ("delivered", if due == 0 { 1.0 } else { landed.iter().filter(|b| b.quoted.is_some_and(|q| q <= end)).count() as f64 / due as f64 }),
            ("transit", mean(&transit)),
            ("transit_p90", p90(transit.clone())),
            ("late_p90", p90(late)),
            ("stretch", if quoted.is_empty() { 1.0 } else { mean(&transit) / mean(&quoted).max(1e-9) }),
            ("transfers", transfers),
            ("first_sailing", first_sailing),
            ("flow_to_line", hours(self.flow_to_line)),
            ("idle_lines", links.iter().filter(|(_, o)| o.1 <= 0.0).count() as f64),
            ("links", links.len() as f64),
            ("by_road", landed.iter().filter(|b| b.by_road).count() as f64),
            ("forecast_ratio", forecast_ratio),
            ("near_empty", near_empty),
            ("via_world", landed.iter().filter(|b| b.via_world && b.from != Call::World && b.to != Call::World).count() as f64),
            ("missed", self.missed as f64),
            ("util", mean(&util)),
            ("util_min", util.iter().copied().fold(f64::INFINITY, f64::min).min(1.0)),
            ("empties", if self.rides.1 == 0 { 0.0 } else { self.rides.0 as f64 / self.rides.1 as f64 }),
            ("berth_wait", hours(self.berth_wait)),
            ("wait_max", hours(self.wait_max)),
            ("block_wait", 0.0),
            ("yard_peak", self.ports.iter().map(|y| y.peak).max().unwrap_or(0) as f64),
            ("landed_per_call", if calls == 0 { 0.0 } else { self.ports.iter().map(|y| y.landed).sum::<u32>() as f64 / calls as f64 }),
            ("loaded_per_call", if calls == 0 { 0.0 } else { self.ports.iter().map(|y| y.loaded).sum::<u32>() as f64 / calls as f64 }),
            ("coins_in", coins_in),
            ("coins_out", coins_out),
            ("boxes", full.len() as f64),
        ])
    }

    /// The network drawn: the land, each line's legs, the narrows in red,
    /// the harbours, and a dot every ten minutes for each ship at sea.
    pub fn svg(&self) -> String {
        let px = 6.0;
        let (w, h) = (self.s.water.w as f64 * px, self.s.water.h as f64 * px);
        let mut out = format!("<svg xmlns='http://www.w3.org/2000/svg' width='{w}' height='{h}' viewBox='0 0 {w} {h}'><rect width='{w}' height='{h}' fill='#cfe3ef'/>");
        for (y, row) in self.s.rows.iter().enumerate() {
            let mut x = 0;
            while x < row.len() {
                if row[x] == b'.' {
                    let run = row[x..].iter().take_while(|&&c| c == b'.').count();
                    out += &format!("<rect x='{}' y='{}' width='{}' height='{px}' fill='#d9d2bf'/>", x as f64 * px, y as f64 * px, run as f64 * px);
                    x += run;
                } else {
                    x += 1;
                }
            }
        }
        let colours = ["#1f6fb2", "#d1495b", "#2e933c", "#8f5bd1", "#e08a1e", "#00798c"];
        let poly = |p: &[[f64; 2]]| p.iter().map(|q| format!("{:.1},{:.1}", q[0] * px, q[1] * px)).collect::<Vec<_>>().join(" ");
        for (i, line) in self.lines.iter().enumerate() {
            for leg in &line.legs {
                out += &format!("<polyline points='{}' fill='none' stroke='{}' stroke-width='1.5' stroke-opacity='0.6'/>", poly(leg), colours[i % colours.len()]);
                for (a, b) in self.s.water.narrows(leg) {
                    let part: Vec<[f64; 2]> = (0..=((b - a) * 2.0) as usize).map(|k| point_at(leg, a + k as f64 / 2.0).0).collect();
                    out += &format!("<polyline points='{}' fill='none' stroke='#e02020' stroke-width='3'/>", poly(&part));
                }
            }
        }
        for ship in &self.ships {
            let colour = colours[ship.line % colours.len()];
            for (leg, start, ease) in &ship.sails {
                let len = length(leg);
                let ms = super::sail_ms(len, *ease);
                for t in (0..ms).step_by((HOUR / 6) as usize) {
                    if start + t > self.now {
                        break;
                    }
                    let p = point_at(leg, covered(len, *ease, t)).0;
                    out += &format!("<circle cx='{:.1}' cy='{:.1}' r='2' fill='{colour}'/>", p[0] * px, p[1] * px);
                }
            }
        }
        for p in &self.s.ports {
            let c = [p.berth.quay.x as f64 + 0.5, p.berth.quay.y as f64 + 0.5];
            out += &format!("<circle cx='{:.1}' cy='{:.1}' r='7' fill='#fff' stroke='#333'/><text x='{:.1}' y='{:.1}' font-size='9' font-family='sans-serif' text-anchor='middle'>{}</text>", c[0] * px, c[1] * px, c[0] * px, c[1] * px + 3.0, p.letter);
        }
        out + "</svg>"
    }
}

/// Every scenario in `server/scenarios`, or `SCENARIO`'s alone: run,
/// printed, drawn if `SVG` is set, and judged by its `expect` lines, but
/// for one marked pending.
#[test]
fn scenarios_meet_their_expectations() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("scenarios");
    let only = std::env::var("SCENARIO").ok();
    let mut names: Vec<String> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()?.file_name().to_str()?.strip_suffix(".txt").map(String::from)).collect();
    names.sort();
    let columns = ["delivered", "transit", "transit_p90", "late_p90", "stretch", "transfers", "missed", "util", "empties", "berth_wait", "yard_peak", "landed_per_call", "coins_in", "coins_out"];
    let mut table = vec![format!("{:<12} {}  hash", "scenario", columns.iter().map(|c| format!("{:>8}", &c[..c.len().min(8)])).collect::<Vec<_>>().join(" "))];
    let mut failed = Vec::new();
    for name in names.iter().filter(|n| only.as_ref().is_none_or(|o| o == *n)) {
        let text = std::fs::read_to_string(dir.join(format!("{name}.txt"))).unwrap();
        let s = Scenario::parse(name, &text);
        println!("{name}{}", s.pending.as_ref().map_or(String::new(), |p| format!(" (pending: {p})")));
        let started = std::time::Instant::now();
        let mut sim = Sim::new(&s);
        sim.run();
        let m = sim.metrics();
        // The same scenario again is the same run.
        let mut again = Sim::new(&s);
        again.run();
        assert_eq!(sim.log, again.log, "{name}: two runs differ");
        println!("{}", sim.pages.join("\n"));
        println!("  the company: {}", ["links", "idle_lines", "by_road", "via_world", "first_sailing", "flow_to_line", "forecast_ratio", "near_empty", "wait_max"].map(|k| format!("{k} {:.2}", m[k])).join(", "));
        println!("  {} days in {:.0} ms", s.days, started.elapsed().as_secs_f64() * 1000.0 / 2.0);
        table.push(format!("{:<12} {}  {:016x}", name, columns.iter().map(|c| format!("{:>8.2}", m[c])).collect::<Vec<_>>().join(" "), sim.log));
        if std::env::var("SVG").is_ok() {
            let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.dev/scenarios");
            std::fs::create_dir_all(&out).unwrap();
            std::fs::write(out.join(format!("{name}.svg")), sim.svg()).unwrap();
        }
        for e in &s.expects {
            let v = *m.get(e.metric.as_str()).unwrap_or_else(|| panic!("{name}: no metric {}", e.metric));
            let ok = match e.op.as_str() {
                ">=" => v >= e.value,
                "<=" => v <= e.value,
                ">" => v > e.value,
                "<" => v < e.value,
                "==" => (v - e.value).abs() < 1e-9,
                op => panic!("{name}: no op {op}"),
            };
            if !ok {
                println!("  expected {} {} {}, got {v:.3}{}", e.metric, e.op, e.value, if s.pending.is_some() { " (pending)" } else { "" });
                if s.pending.is_none() {
                    failed.push(format!("{name}: {} {} {} (got {v:.3})", e.metric, e.op, e.value));
                }
            }
        }
    }
    println!("{}", table.join("\n"));
    assert!(failed.is_empty(), "scenarios short of their expectations: {failed:#?}");
}
