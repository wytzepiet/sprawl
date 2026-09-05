//! The skill tree: what a city can become, chosen a point at a time.
//!
//! Three tables, each answering one question. `KINDS` says what a node *is*
//! — its effect, its price, its blurb — one row per kind, the way
//! `blueprint.rs` does buildings. `ROUTES` says where nodes *sit*: the tree
//! written as the paths you would walk through it, consecutive nodes joined,
//! a node in two routes being where branches meet or circle back. What a
//! player has *taken* is not here at all; that is the build, and it is the
//! only thing the game asks about the tree.
//!
//! Nothing here is a verb. Every effect is a number or an unlock, so every
//! node is safe to ship; a keystone that changes the rules will be one more
//! variant and its `match`, when one earns its place.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ts_rs::TS;

use crate::blueprint::Class;
use crate::protocol::BuildingKind;

/// What a node is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum NodeKind {
    Root,
    Homes,
    Apartments,
    Shops,
    Restaurant,
    Bar,
    GasStation,
    Industry,
    Workshop,
    Factory,
    Roads,
    OneWay,
}

impl NodeKind {
    pub const ALL: [NodeKind; 12] = [
        NodeKind::Root,
        NodeKind::Homes,
        NodeKind::Apartments,
        NodeKind::Shops,
        NodeKind::Restaurant,
        NodeKind::Bar,
        NodeKind::GasStation,
        NodeKind::Industry,
        NodeKind::Workshop,
        NodeKind::Factory,
        NodeKind::Roads,
        NodeKind::OneWay,
    ];
}

/// What taking a node does. Odds and unlocks only; no verbs.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "kind", content = "data")]
pub enum Effect {
    Nothing,
    /// Buildings of this class arrive this many times as often.
    Weight { class: Class, times: f64 },
    /// This kind of building may arrive.
    Building(BuildingKind),
    /// One-way streets may be drawn.
    OneWay,
    /// This many more tiles of road may be drawn.
    RoadTiles(u32),
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct Row {
    pub kind: NodeKind,
    pub effect: Effect,
    /// Points to take it.
    pub cost: u32,
    /// What the player learns by taking it: what the thing does.
    pub blurb: &'static str,
}

/// A place in the tree: a kind, and which of that kind when the kind
/// appears more than once. The number is identity and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Node {
    pub kind: NodeKind,
    pub n: u8,
}

const fn node(kind: NodeKind, n: u8) -> Node {
    Node { kind, n }
}

/// One row per kind, in enum order.
pub static KINDS: &[Row] = {
    use BuildingKind::*;
    use Class::*;
    use Effect::*;
    use NodeKind as K;
    &[
        Row { kind: K::Root, effect: Nothing, cost: 0, blurb: "Where every city starts." },
        Row { kind: K::Homes, effect: Weight { class: Living, times: 1.4 }, cost: 1, blurb: "People want to live here. Homes arrive more often." },
        Row { kind: K::Apartments, effect: Building(Apartment), cost: 1, blurb: "Eight households on a plot of two. They fill fast, and empty onto the road slower." },
        Row { kind: K::Shops, effect: Weight { class: Commerce, times: 1.4 }, cost: 1, blurb: "Somewhere to eat and something to do, from nine till late. Commerce arrives more often." },
        Row { kind: K::Restaurant, effect: Building(Restaurant), cost: 1, blurb: "Lunch, and an evening out. A dozen at a time, with the traffic that brings." },
        Row { kind: K::Bar, effect: Building(Bar), cost: 1, blurb: "The last place open. The evening's traffic goes here, and comes home at two." },
        Row { kind: K::GasStation, effect: Building(GasStation), cost: 1, blurb: "Cars run dry. Pumps round the clock, wherever the driving is." },
        Row { kind: K::Industry, effect: Weight { class: Industry, times: 1.4 }, cost: 1, blurb: "Jobs that keep to themselves. Industry arrives more often." },
        Row { kind: K::Workshop, effect: Building(Workshop), cost: 1, blurb: "Six jobs, seven to four." },
        Row { kind: K::Factory, effect: Building(Factory), cost: 1, blurb: "Twenty-four jobs, six to three. The morning rush starts here." },
        Row { kind: K::Roads, effect: RoadTiles(20), cost: 1, blurb: "Twenty more tiles of road. Room to build." },
        Row { kind: K::OneWay, effect: OneWay, cost: 1, blurb: "One-way streets. Half the road, all the throughput." },
    ]
};

/// The tree, as the routes you would walk through it.
pub static ROUTES: &[&[Node]] = {
    use NodeKind::*;
    &[
        &[node(Root, 0), node(Homes, 1), node(Homes, 2), node(Apartments, 0), node(Homes, 3)],
        &[node(Root, 0), node(Shops, 1), node(Restaurant, 0), node(Shops, 2), node(Bar, 0), node(GasStation, 0)],
        &[node(Root, 0), node(Industry, 1), node(Workshop, 0), node(Industry, 2), node(Factory, 0)],
        &[node(Root, 0), node(Roads, 1), node(Roads, 2), node(OneWay, 0), node(Roads, 3)],
        // The ring: homes, road and the high street meet, so a build that went
        // one way reaches the others without paying the root twice.
        &[node(Apartments, 0), node(Roads, 2), node(Shops, 2)],
        // Industry joins the ring from the far side.
        &[node(Factory, 0), node(Roads, 3)],
    ]
};

pub fn row(kind: NodeKind) -> &'static Row {
    &KINDS[kind as usize]
}

/// Every node, in the order routes first name them, and every edge once.
pub fn graph() -> (Vec<Node>, Vec<(Node, Node)>) {
    let mut nodes: Vec<Node> = Vec::new();
    let mut edges: Vec<(Node, Node)> = Vec::new();
    for route in ROUTES {
        for pair in route.windows(2) {
            for n in pair {
                if !nodes.contains(n) {
                    nodes.push(*n);
                }
            }
            let (a, b) = (pair[0], pair[1]);
            if !edges.contains(&(a, b)) && !edges.contains(&(b, a)) {
                edges.push((a, b));
            }
        }
    }
    (nodes, edges)
}

/// The checks the compiler cannot make: rows in enum order, every node
/// reachable from the root, numbered kinds counted without gaps. Called once
/// at startup, so a bad table fails before anyone spends a point on it.
pub fn check() {
    assert_eq!(KINDS.len(), NodeKind::ALL.len(), "a kind has no row");
    for (i, r) in KINDS.iter().enumerate() {
        assert_eq!(r.kind, NodeKind::ALL[i], "rows out of order at {:?}", r.kind);
    }
    let (nodes, edges) = graph();
    let root = node(NodeKind::Root, 0);
    let mut seen = vec![root];
    let mut stack = vec![root];
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
        assert!(seen.contains(n), "{n:?} cannot be reached from the root");
    }
    for kind in NodeKind::ALL {
        let mut ns: Vec<u8> = nodes.iter().filter(|n| n.kind == kind).map(|n| n.n).collect();
        ns.sort_unstable();
        let expect: Vec<u8> = if ns == [0] { vec![0] } else { (1..=ns.len() as u8).collect() };
        assert_eq!(ns, expect, "{kind:?} is numbered with gaps, or mixes 0 with numbers");
    }
}

/// The whole tree, for the client to draw and for anyone to read.
pub fn inspect() -> Value {
    let (nodes, edges) = graph();
    json!({ "kinds": KINDS, "nodes": nodes, "edges": edges, "routes": ROUTES })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tree_holds_up() {
        check();
    }

    #[test]
    fn the_ring_is_one_ring() {
        let (nodes, edges) = graph();
        // The root, four homes, five shops, four industry, four roads.
        assert_eq!(nodes.len(), 18);
        // The spokes' seventeen edges, the ring's two, industry's one.
        assert_eq!(edges.len(), 20);
    }
}
