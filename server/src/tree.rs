//! The skill tree, and the player's build.
//!
//! The tree is a town plan: roads are its edges and buildings its nodes,
//! written as a small map so the whole thing can be read at a glance and
//! redrawn by moving letters about. A road is `.`, a node is a letter from
//! the legend, anything else is open land. The client draws this same map;
//! it fetches it from `/tree` and never has a copy of its own.
//!
//! `LEGEND` says what a letter *is*: its effect, its price, its blurb — one
//! row per letter, the way `blueprint.rs` does buildings. The player's
//! `Build` is the set of nodes taken, and it is the one door every question
//! about what the city may do goes through: what may arrive, what may be
//! placed, how often, how much road. Nothing else reads the tree.
//!
//! Every effect is a number or an unlock, so every node is safe to ship; a
//! keystone that changes the rules will be one more variant and its `match`,
//! when one earns its place.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ts_rs::TS;

use crate::blueprint::Class;
use crate::protocol::BuildingKind;

/// North: homes. East: commerce. South: industry. West: roads. Each avenue
/// winds out from the city with its unlocks on side streets; a node always
/// sits on a straight, so every bend is a bend. Written with a space between
/// cells so it can be read; a cell is every other column.
pub const MAP: &[&str] = &[
    "                                    H                                    ",
    "                                    .                                    ",
    "                                    .                                    ",
    "                                    H . . A                              ",
    "                                    .                                    ",
    "                                  .                                      ",
    "                                .                                        ",
    "                          A . . H                                        ",
    "                                .                                        ",
    "                                  .                                      ",
    "                                    .                                    ",
    "        G                           H                     B              ",
    "T .     .           . r .           .                     .           . S",
    "    .   .         .   .   .         .                     .         .    ",
    "      . r . . r .     .     . r . . @ . . S .           . S . . S .      ",
    "              .       o             .     .   .       .         .        ",
    "              .                     .     .     . S M           .        ",
    "              r               W . . I     R           .         R        ",
    "                                    .                 .                  ",
    "                                      .               .                  ",
    "                                        .             .                  ",
    "                                        I . . F . . . V                  ",
    "                                        .                                ",
    "                                      .                                  ",
    "                                    .                                    ",
    "                              W . . I                                    ",
    "                                    .                                    ",
    "                                    .                                    ",
    "                                    I . . P                              ",
];

/// What taking a node does. Odds and unlocks only; no verbs.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "kind")]
pub enum Effect {
    Nothing,
    /// Buildings of this class arrive this many times as often.
    Weight { class: Class, times: f64 },
    /// This kind of building may arrive, or be placed.
    Building { building: BuildingKind },
    /// One-way streets may be drawn.
    OneWay,
    /// Roads may be drawn: through routes that nothing fronts onto.
    Road,
    /// This many more tiles of road may be drawn.
    RoadTiles { tiles: u32 },
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct Row {
    pub name: &'static str,
    pub effect: Effect,
    /// Points to take it.
    pub cost: u32,
    /// What the player learns by taking it: what the thing does.
    pub blurb: &'static str,
}

/// A node of the tree: a cell of the map.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Cell {
    pub x: u8,
    pub y: u8,
}

/// One row per letter.
pub static LEGEND: &[(char, Row)] = {
    use BuildingKind::*;
    use Class::*;
    use Effect::*;
    &[
        ('@', Row { name: "The city", effect: Nothing, cost: 0, blurb: "Where every city starts." }),
        ('H', Row { name: "Homes", effect: Weight { class: Living, times: 1.4 }, cost: 1, blurb: "People want to live here. Homes cost less." }),
        ('A', Row { name: "Apartments", effect: Building { building: Apartment }, cost: 1, blurb: "Eight households on a plot of two. They fill fast, and empty onto the road slower." }),
        ('S', Row { name: "Commerce", effect: Weight { class: Commerce, times: 1.4 }, cost: 1, blurb: "Somewhere to eat and something to do, from nine till late. Commerce costs less." }),
        ('R', Row { name: "Restaurant", effect: Building { building: Restaurant }, cost: 1, blurb: "Lunch, and an evening out. A dozen at a time, with the traffic that brings." }),
        ('B', Row { name: "Bar", effect: Building { building: Bar }, cost: 1, blurb: "The last place open. The evening's traffic goes here, and comes home at two." }),
        ('G', Row { name: "Gas station", effect: Building { building: GasStation }, cost: 1, blurb: "Cars run dry. Pumps round the clock, wherever the driving is." }),
        ('I', Row { name: "Industry", effect: Weight { class: Industry, times: 1.4 }, cost: 1, blurb: "Jobs that keep to themselves. Industry costs less." }),
        ('W', Row { name: "Workshop", effect: Building { building: Workshop }, cost: 1, blurb: "Four jobs, seven to four, and two bays: cars come in worn and leave put right." }),
        ('F', Row { name: "Factory", effect: Building { building: Factory }, cost: 1, blurb: "Twenty-four jobs, six to three. The morning rush starts here." }),
        ('r', Row { name: "Roads", effect: RoadTiles { tiles: 60 }, cost: 1, blurb: "Sixty more tiles of road. Room to build." }),
        ('o', Row { name: "One-way streets", effect: OneWay, cost: 1, blurb: "One-way streets. Half the road, all the throughput." }),
        ('M', Row { name: "Supermarket", effect: Building { building: Supermarket }, cost: 1, blurb: "Shopping for a whole district. Shelves that run low, and a truck to fill them." }),
        ('V', Row { name: "Warehouse", effect: Building { building: Warehouse }, cost: 1, blurb: "Where stock comes from. Its trucks answer the shops' calls; without one, every delivery comes from beyond the edge." }),
        ('P', Row { name: "Farm", effect: Building { building: Farm }, cost: 1, blurb: "Where food comes from. Four hands fill a yard with crates; a van takes them to the shops, and what nobody in town buys goes out to the edge." }),
        ('T', Row { name: "Through roads", effect: Road, cost: 1, blurb: "Roads nothing fronts onto: nothing arrives beside them, and nothing turns out of a driveway into the traffic." }),
    ]
};

/// Tiles of road a city may draw before it has taken a single node. Every
/// street is the mayor's to draw now, so this has to be a town's worth.
const ROAD_BASE: u32 = 300;

fn at(x: i32, y: i32) -> char {
    if x < 0 || y < 0 {
        return ' ';
    }
    MAP.get(y as usize).and_then(|r| r.as_bytes().get(x as usize * 2)).map_or(' ', |&b| b as char)
}

fn legend(ch: char) -> Option<&'static Row> {
    LEGEND.iter().find(|(c, _)| *c == ch).map(|(_, r)| r)
}

fn is_node(x: i32, y: i32) -> bool {
    legend(at(x, y)).is_some()
}

fn is_paved(x: i32, y: i32) -> bool {
    at(x, y) == '.' || is_node(x, y)
}

/// The row a node stands for.
pub fn row(c: Cell) -> &'static Row {
    legend(at(c.x as i32, c.y as i32)).expect("a cell that is not a node")
}

/// The cells a cell is joined to: the eight around it that are paved, except
/// a diagonal that would cut the corner of a bend — the same rule the game's
/// own roads keep, so a diagonal is a diagonal and a corner is a corner.
fn joined(c: Cell) -> Vec<Cell> {
    let (x, y) = (c.x as i32, c.y as i32);
    let mut out = Vec::new();
    for dy in -1..=1 {
        for dx in -1..=1 {
            if (dx, dy) == (0, 0) || !is_paved(x + dx, y + dy) {
                continue;
            }
            if dx != 0 && dy != 0 && (is_paved(x + dx, y) || is_paved(x, y + dy)) {
                continue;
            }
            out.push(Cell { x: (x + dx) as u8, y: (y + dy) as u8 });
        }
    }
    out
}

/// Every node, in reading order.
pub fn nodes() -> Vec<Cell> {
    let mut out = Vec::new();
    for (y, row) in MAP.iter().enumerate() {
        for x in 0..row.len().div_ceil(2) {
            if is_node(x as i32, y as i32) {
                out.push(Cell { x: x as u8, y: y as u8 });
            }
        }
    }
    out
}

/// Every pair of nodes with a run of road between them, once.
pub fn edges() -> Vec<(Cell, Cell)> {
    let mut out: Vec<(Cell, Cell)> = Vec::new();
    for n in nodes() {
        for first in joined(n) {
            let (mut prev, mut cur) = (n, first);
            // Walk the run to its far end.
            while !is_node(cur.x as i32, cur.y as i32) {
                let Some(next) = joined(cur).into_iter().find(|&c| c != prev) else { break };
                prev = cur;
                cur = next;
            }
            if is_node(cur.x as i32, cur.y as i32) && !out.contains(&(cur, n)) && !out.contains(&(n, cur)) {
                out.push((n, cur));
            }
        }
    }
    out
}

pub fn root() -> Cell {
    nodes().into_iter().find(|&c| row(c).effect == Effect::Nothing).expect("a map with no root")
}

/// The player's build: the nodes taken. The root always is.
#[derive(Debug, Clone)]
pub struct Build {
    taken: HashSet<Cell>,
}

impl Default for Build {
    fn default() -> Self {
        Build { taken: HashSet::from([root()]) }
    }
}

impl Build {
    pub fn load(taken: impl IntoIterator<Item = Cell>) -> Self {
        let mut b = Build::default();
        b.taken.extend(taken.into_iter().filter(|&c| nodes().contains(&c)));
        b
    }

    /// The nodes taken, in reading order: what a save writes down.
    pub fn taken(&self) -> Vec<Cell> {
        let mut v: Vec<Cell> = self.taken.iter().copied().collect();
        v.sort_by_key(|c| (c.y, c.x));
        v
    }

    fn effects(&self) -> impl Iterator<Item = Effect> + '_ {
        self.taken.iter().map(|&c| row(c).effect)
    }

    pub fn spent(&self) -> u32 {
        self.taken.iter().map(|&c| row(c).cost).sum()
    }

    /// Take a node: it must be a node, untaken, beside a taken one, and
    /// affordable at this level.
    pub fn take(&mut self, c: Cell, level: u32) -> bool {
        if !nodes().contains(&c) || self.taken.contains(&c) {
            return false;
        }
        let beside = edges().iter().any(|&(a, b)| (a == c && self.taken.contains(&b)) || (b == c && self.taken.contains(&a)));
        if !beside || self.spent() + row(c).cost > level {
            return false;
        }
        self.taken.insert(c);
        true
    }

    /// A kind no node names is always allowed; one a node names waits for it.
    fn unlocked(&self, kind: BuildingKind) -> bool {
        let named = LEGEND.iter().any(|(_, r)| r.effect == Effect::Building { building: kind });
        !named || self.effects().any(|e| e == Effect::Building { building: kind })
    }

    /// May the mayor place one of these?
    pub fn may_place(&self, kind: BuildingKind) -> bool {
        self.unlocked(kind)
    }

    /// How much cheaper this class is than the table says.
    pub fn weight(&self, class: Class) -> f64 {
        self.effects()
            .map(|e| match e {
                Effect::Weight { class: c, times } if c == class => times,
                _ => 1.0,
            })
            .product()
    }

    /// Tiles of road the mayor may have laid, all told.
    pub fn road_tiles(&self) -> u32 {
        ROAD_BASE
            + self
                .effects()
                .map(|e| match e {
                    Effect::RoadTiles { tiles } => tiles,
                    _ => 0,
                })
                .sum::<u32>()
    }

    /// May this kind of road be drawn?
    pub fn may_draw(&self, one_way: bool, road: bool) -> bool {
        (!one_way || self.effects().any(|e| e == Effect::OneWay)) && (!road || self.effects().any(|e| e == Effect::Road))
    }
}

/// The checks the compiler cannot make: every letter on the map in the
/// legend, one root, every node reachable from it. Called once at startup,
/// so a bad map fails before anyone spends a point on it.
pub fn check() {
    for (y, r) in MAP.iter().enumerate() {
        for (i, ch) in r.chars().enumerate() {
            assert!(ch == ' ' || ch == '.' || legend(ch).is_some(), "({i},{y}): {ch:?} is not on the legend");
            assert!(i % 2 == 0 || ch == ' ', "({i},{y}): a cell is every other column");
        }
    }
    let nodes = nodes();
    assert_eq!(nodes.iter().filter(|&&c| row(c).effect == Effect::Nothing).count(), 1, "one root");
    let edges = edges();
    let mut seen = vec![root()];
    let mut stack = vec![root()];
    while let Some(n) = stack.pop() {
        for &(a, b) in &edges {
            let other = if a == n { b } else if b == n { a } else { continue };
            if !seen.contains(&other) {
                seen.push(other);
                stack.push(other);
            }
        }
    }
    for n in &nodes {
        assert!(seen.contains(n), "{n:?} ({}) cannot be reached from the root", row(*n).name);
    }
}

/// The whole tree, for the client to draw and for anyone to read.
pub fn inspect() -> Value {
    json!({
        "map": MAP,
        "legend": LEGEND.iter().map(|(c, r)| (c.to_string(), json!(r))).collect::<serde_json::Map<_, _>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tree_holds_up() {
        check();
        assert_eq!(nodes().len(), 33);
    }

    #[test]
    fn a_build_grows_from_the_root_and_pays_for_it() {
        let mut b = Build::default();
        let (root, far) = (root(), Cell { x: 0, y: 12 });
        let next = edges().iter().find_map(|&(a, c)| (a == root).then_some(c).or((c == root).then_some(a))).unwrap();
        assert!(!b.take(far, 10), "not beside anything taken");
        assert!(!b.take(next, 0), "no points");
        assert!(b.take(next, 1));
        assert!(!b.take(next, 5), "already taken");
        assert_eq!(b.spent(), 1);
    }

    #[test]
    fn the_build_is_the_gate() {
        let mut b = Build::default();
        assert!(b.may_place(BuildingKind::House));
        assert!(!b.may_place(BuildingKind::Factory));
        assert!(!b.may_place(BuildingKind::Restaurant));
        assert!(!b.may_draw(true, false));
        assert_eq!(b.weight(Class::Living), 1.0);
        // Walk the homes avenue: root, H, H, then the apartments.
        let level = 10;
        for c in [Cell { x: 18, y: 11 }, Cell { x: 16, y: 7 }, Cell { x: 13, y: 7 }] {
            assert!(b.take(c, level), "{c:?}");
        }
        assert!(b.may_place(BuildingKind::Apartment));
        assert!((b.weight(Class::Living) - 1.4 * 1.4).abs() < 1e-9);
        assert_eq!(b.road_tiles(), ROAD_BASE);
    }
}
