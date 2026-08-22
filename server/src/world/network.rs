use std::collections::{HashMap, HashSet, VecDeque};

use crate::protocol::EntityId;

pub type ComponentId = u32;
pub type SegmentId = u32;

/// A segment named by something that outlives it.
///
/// Segment ids churn: an edit throws away the runs it touches and lays them
/// again, so a neighbour rebuilt unchanged still comes back with a fresh id,
/// and anything keyed on that id would lose its history to an edit down the
/// road. The first two nodes do not churn — and they stay distinct even for
/// two roads running between the same pair of junctions, since those leave by
/// different neighbours.
pub type SegmentKey = (EntityId, EntityId);

/// How long this run takes to drive, as driven.
#[derive(Debug, Clone, Copy, Default)]
pub struct Passage {
    mean_ms: f64,
    count: u32,
}

/// How much a fresh observation moves the average. One freak trip — a crash, a
/// closure — should not decide next week's departures, but a road that really
/// has got slower should be believed within a few journeys.
const BLEND: f64 = 0.3;

/// Where the count stops climbing. A segment that converged after a thousand
/// cars and then ignored the bypass you built would be a monument, not a
/// memory.
const CONFIDENCE_CAP: u32 = 20;

impl Passage {
    fn observe(&mut self, ms: f64) {
        self.mean_ms = if self.count == 0 {
            ms
        } else {
            self.mean_ms * (1.0 - BLEND) + ms * BLEND
        };
        self.count = (self.count + 1).min(CONFIDENCE_CAP);
    }
}

/// A run of road with nothing joining it along the way.
///
/// Ends at an intersection or a dead end, so everything that drives onto a
/// segment leaves it at one of the two ends — which is what makes it the
/// honest unit to measure passage time over, and what lets a route search step
/// over whole corridors instead of tile by tile.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    /// How far it is to drive, in tiles.
    pub length: f64,
    /// In order, both ends included. A segment with no intersection anywhere on
    /// it — a ring road — starts and ends at the same node.
    pub nodes: Vec<EntityId>,
}

impl Segment {
    pub fn key(&self) -> SegmentKey {
        (self.nodes[0], self.nodes[1])
    }

    pub fn ends(&self) -> (EntityId, EntityId) {
        (self.nodes[0], self.nodes[self.nodes.len() - 1])
    }

    pub fn is_ring(&self) -> bool {
        self.nodes.len() > 1 && self.nodes[0] == self.nodes[self.nodes.len() - 1]
    }
}

/// An undirected road link, named the same way whichever end you come from.
type Link = (EntityId, EntityId);

fn link_key(a: EntityId, b: EntityId) -> Link {
    if a <= b { (a, b) } else { (b, a) }
}

/// Turn a closed loop so it begins at its lowest node. A ring has no ends to
/// name it by, so it needs one chosen for it, or the same road would come out
/// differently depending on which link happened to be laid last.
fn close_ring(mut nodes: Vec<EntityId>) -> Vec<EntityId> {
    nodes.pop(); // the repeated first node; put back after rotating
    let Some(start) = (0..nodes.len()).min_by_key(|&i| nodes[i]) else {
        return nodes;
    };
    nodes.rotate_left(start);
    // And run it the same way round: a ring can be walked either direction,
    // and which one you get would otherwise depend on the order it was drawn.
    if nodes.len() > 2 && nodes[1] > nodes[nodes.len() - 1] {
        nodes[1..].reverse();
    }
    nodes.push(nodes[0]);
    nodes
}

/// Which nodes can reach which, kept up to date as roads are laid and pulled
/// up rather than recomputed from scratch.
///
/// A shared world is edited constantly and from everywhere, so the cost of an
/// edit has to depend on the edit, not on the size of the city. Both operations
/// here cost the size of the *smaller* piece involved: joining two networks
/// relabels the smaller one, and cutting one searches outward from both sides
/// of the cut in step, stopping the moment either side closes.
///
/// Pure graph, no World: everything it needs is what it was told.
#[derive(Default)]
pub struct RoadNetwork {
    /// Neighbours, and how far away each is.
    adj: HashMap<EntityId, HashMap<EntityId, f64>>,
    component: HashMap<EntityId, ComponentId>,
    members: HashMap<ComponentId, HashSet<EntityId>>,
    next: ComponentId,
    segments: HashMap<SegmentId, Segment>,
    /// Every segment a node lies on. One for a node in the middle of a run,
    /// one per arm for an intersection.
    on_node: HashMap<EntityId, HashSet<SegmentId>>,
    next_segment: SegmentId,
    /// Observed passage time, one per direction: [along the run, against it].
    /// Keyed so it survives the run being laid again by a nearby edit.
    passage: HashMap<SegmentKey, [Passage; 2]>,
}

impl RoadNetwork {
    /// Could a car get from one node to the other, however far it is?
    ///
    /// The point of the index: a search that is going to fail is refused before
    /// it starts, rather than exhausting everything reachable to find that out.
    pub fn connected(&self, from: EntityId, to: EntityId) -> bool {
        match (self.component.get(&from), self.component.get(&to)) {
            (Some(a), Some(b)) => a == b,
            _ => false,
        }
    }

    #[cfg(test)]
    pub fn component_of(&self, node: EntityId) -> Option<ComponentId> {
        self.component.get(&node).copied()
    }

    /// A road now joins these two.
    pub fn link(&mut self, a: EntityId, b: EntityId, length: f64) {
        if a == b {
            return;
        }
        let stale = self.take_segments_around(&[a, b]);
        self.adj.entry(a).or_default().insert(b, length);
        self.adj.entry(b).or_default().insert(a, length);
        self.recontract(stale, Some(link_key(a, b)));

        let (ca, cb) = (self.claim(a), self.claim(b));
        if ca == cb {
            return;
        }
        // Relabel the smaller side. Doing it by size is what keeps a lifetime
        // of joins near-linear instead of quadratic.
        let (keep, drop) = if self.size(ca) >= self.size(cb) { (ca, cb) } else { (cb, ca) };
        let moving = self.members.remove(&drop).unwrap_or_default();
        for id in &moving {
            self.component.insert(*id, keep);
        }
        self.members.entry(keep).or_default().extend(moving);
    }

    /// The road between these two is gone.
    pub fn unlink(&mut self, a: EntityId, b: EntityId) {
        let mut stale = self.take_segments_around(&[a, b]);
        if let Some(set) = self.adj.get_mut(&a) {
            set.remove(&b);
        }
        if let Some(set) = self.adj.get_mut(&b) {
            set.remove(&a);
        }
        stale.remove(&link_key(a, b));
        self.recontract(stale, None);
        self.forget_if_isolated(a);
        self.forget_if_isolated(b);

        let (Some(&ca), Some(&cb)) = (self.component.get(&a), self.component.get(&b)) else {
            return; // one end left the graph entirely; nothing can still be joined
        };
        if ca != cb {
            return;
        }
        // Grow both sides one step at a time. If they meet, the cut changed
        // nothing. If one closes first, it is the smaller half by construction,
        // and it is the one that becomes a new component — so the work done is
        // the size of the piece that broke off, not of the network it left.
        let Some(split) = self.smaller_half(a, b) else { return };
        let id = self.fresh();
        if let Some(old) = self.members.get_mut(&ca) {
            for node in &split {
                old.remove(node);
            }
        }
        for node in &split {
            self.component.insert(*node, id);
        }
        self.members.insert(id, split);
    }

    /// Walk outward from both ends of a cut in step. `None` if they meet —
    /// some other path still joins them. Otherwise the side that closed first.
    fn smaller_half(&self, a: EntityId, b: EntityId) -> Option<HashSet<EntityId>> {
        let mut sides = [
            (HashSet::from([a]), VecDeque::from([a])),
            (HashSet::from([b]), VecDeque::from([b])),
        ];
        loop {
            let mut both_closed = true;
            for i in 0..2 {
                let Some(node) = sides[i].1.pop_front() else { continue };
                both_closed = false;
                let Some(next) = self.adj.get(&node) else { continue };
                for &n in next.keys() {
                    if n == if i == 0 { b } else { a } {
                        return None; // still joined the long way round
                    }
                    if sides[i].0.insert(n) {
                        sides[i].1.push_back(n);
                    }
                }
            }
            if both_closed {
                return None;
            }
            for i in 0..2 {
                if sides[i].1.is_empty() {
                    let (visited, _) = std::mem::take(&mut sides[i]);
                    return Some(visited);
                }
            }
        }
    }

    /// Does a run of road end here — because others meet it, or because it
    /// stops? Distinct from `is_intersection`, which is about arbitrating who
    /// goes first and so only counts genuine forks.
    pub fn is_junction(&self, node: EntityId) -> bool {
        self.adj.get(&node).map_or(false, |a| a.len() != 2)
    }

    /// Time a car took to drive the run between two junctions.
    ///
    /// Entry to entry rather than entry to the far end, so the wait at the
    /// junction it leaves by is counted as part of the run — which is where
    /// most of the delay is, and it costs nothing to include.
    pub fn observe_passage(&mut self, entered: EntityId, left: EntityId, ms: f64) {
        let Some((key, forward)) = self.run_between(entered, left) else { return };
        self.passage.entry(key).or_default()[usize::from(!forward)].observe(ms);
    }

    /// What driving between these two junctions is reckoned to cost, in
    /// milliseconds.
    ///
    /// **Half what the road promises, half what it has been giving.** Taking
    /// only the promise ignores the jam; taking only the record makes a fast
    /// road unattractive the moment it gets busy, which is backwards — a
    /// motorway crawling at half speed is still worth more than the lane
    /// beside it. Halfway between lets congestion tilt a choice without
    /// deciding it, which is also what stops everyone swapping roads at once
    /// and swapping back.
    ///
    /// It also composes: averaging each run and adding them up gives the same
    /// answer as averaging the whole journey, so a search can total this run
    /// by run without the arithmetic drifting.
    ///
    /// A road nobody has driven costs what it promises, which is the same rule
    /// with nothing to weigh against it.
    pub fn travel_ms(&self, from: EntityId, to: EntityId, cruise_speed: f64) -> Option<f64> {
        let (key, forward) = self.run_between(from, to)?;
        let free = self.segments_at(from).find(|s| s.key() == key)?.length / cruise_speed * 1000.0;
        match self.passage.get(&key).map(|p| p[usize::from(!forward)]) {
            Some(seen) if seen.count > 0 => Some((free + seen.mean_ms) / 2.0),
            _ => Some(free),
        }
    }

    /// What the road between these two junctions has been taking, in the
    /// direction of travel. `None` where nobody has driven it yet.
    pub fn passage_ms(&self, entered: EntityId, left: EntityId) -> Option<f64> {
        let (key, forward) = self.run_between(entered, left)?;
        let seen = self.passage.get(&key)?[usize::from(!forward)];
        (seen.count > 0).then_some(seen.mean_ms)
    }

    /// The run joining two junctions, and whether driving it that way round is
    /// along the run's own direction.
    ///
    /// `None` when the two do not bound a run between them — a car that joined
    /// the road partway along has driven part of one, and a part says nothing
    /// about the whole. Rings answer `None` too: nothing joins a ring, so
    /// nothing can be driving on one.
    fn run_between(&self, from: EntityId, to: EntityId) -> Option<(SegmentKey, bool)> {
        self.segments_at(from).find_map(|seg| {
            if seg.is_ring() {
                return None;
            }
            let (a, b) = seg.ends();
            match (from == a && to == b, from == b && to == a) {
                (true, _) => Some((seg.key(), true)),
                (_, true) => Some((seg.key(), false)),
                _ => None,
            }
        })
    }

    /// Every segment a node lies on. One for a node mid-run, one per arm at an
    /// intersection.
    pub fn segments_at(&self, node: EntityId) -> impl Iterator<Item = &Segment> {
        self.on_node
            .get(&node)
            .into_iter()
            .flatten()
            .filter_map(|id| self.segments.get(id))
    }

    #[cfg(test)]
    pub fn segment_count(&self) -> usize {
        self.segments.len()
    }

    /// Lift out every segment touching these nodes, returning the links they
    /// covered so they can be laid again.
    ///
    /// An edit can only change the shape of the runs it touches: a node whose
    /// neighbour count did not move is still an intersection, or still not one,
    /// so the segments beyond are unaffected and are left alone.
    fn take_segments_around(&mut self, nodes: &[EntityId]) -> HashSet<Link> {
        let mut doomed: HashSet<SegmentId> = HashSet::new();
        for node in nodes {
            doomed.extend(self.on_node.get(node).into_iter().flatten().copied());
        }
        let mut links = HashSet::new();
        for id in doomed {
            let Some(seg) = self.segments.remove(&id) else { continue };
            for pair in seg.nodes.windows(2) {
                links.insert(link_key(pair[0], pair[1]));
            }
            for node in &seg.nodes {
                if let Some(set) = self.on_node.get_mut(node) {
                    set.remove(&id);
                    if set.is_empty() {
                        self.on_node.remove(node);
                    }
                }
            }
        }
        links
    }

    /// Lay segments over every link left uncovered, one maximal run at a time.
    ///
    /// Rebuilding a neighbourhood rather than patching it: an edit turns a node
    /// into an intersection or stops it being one, and the runs that meet there
    /// split or merge accordingly. Enumerating those cases is where the bugs
    /// would live; contracting from scratch over a bounded set cannot get them
    /// wrong, and costs the same.
    fn recontract(&mut self, mut links: HashSet<Link>, extra: Option<Link>) {
        links.extend(extra);
        while let Some(&(a, b)) = links.iter().next() {
            let nodes = self.run_through(a, b);
            for pair in nodes.windows(2) {
                links.remove(&link_key(pair[0], pair[1]));
            }
            let id = self.next_segment;
            self.next_segment += 1;
            for node in &nodes {
                self.on_node.entry(*node).or_default().insert(id);
            }
            let length = nodes
                .windows(2)
                .map(|p| self.adj.get(&p[0]).and_then(|n| n.get(&p[1])).copied().unwrap_or(1.0))
                .sum();
            self.segments.insert(id, Segment { length, nodes });
        }
    }

    /// The whole run this link belongs to, stretched out to an intersection or
    /// a dead end at either end.
    fn run_through(&self, a: EntityId, b: EntityId) -> Vec<EntityId> {
        let mut nodes = vec![a, b];
        // Forward, until the road branches, stops, or comes back around.
        while let Some(next) = self.straight_on(nodes[nodes.len() - 2], nodes[nodes.len() - 1]) {
            if next == nodes[0] {
                // A ring: no intersection anywhere on it, so no natural ends.
                // Close it and start it at its lowest node, so the same ring
                // always comes out the same way.
                nodes.push(next);
                return close_ring(nodes);
            }
            nodes.push(next);
        }
        // Then backward from the other end, prepending as we go.
        let mut head = Vec::new();
        let (mut behind, mut at) = (b, a);
        while let Some(prev) = self.straight_on(behind, at) {
            head.push(prev);
            behind = at;
            at = prev;
        }
        head.reverse();
        head.extend(nodes);
        // Run it from its lower end. Direction is arbitrary for an open road,
        // and leaving it arbitrary would mean the same stretch faced one way or
        // the other depending on which link was edited last — which is no way to
        // key passage times that are about to be kept per direction.
        if head[0] > head[head.len() - 1] {
            head.reverse();
        }
        head
    }

    /// Carrying on from `prev` through `at`: the one other way out, if `at` is
    /// a plain point on a road rather than a junction or a dead end.
    fn straight_on(&self, prev: EntityId, at: EntityId) -> Option<EntityId> {
        let arms = self.adj.get(&at)?;
        if arms.len() != 2 {
            return None;
        }
        arms.keys().find(|&&n| n != prev).copied()
    }

    /// A node nothing connects to is not part of any network.
    fn forget_if_isolated(&mut self, node: EntityId) {
        if self.adj.get(&node).is_some_and(|s| !s.is_empty()) {
            return;
        }
        self.adj.remove(&node);
        if let Some(c) = self.component.remove(&node)
            && let Some(set) = self.members.get_mut(&c)
        {
            set.remove(&node);
            if set.is_empty() {
                self.members.remove(&c);
            }
        }
    }

    fn claim(&mut self, node: EntityId) -> ComponentId {
        if let Some(&c) = self.component.get(&node) {
            return c;
        }
        let c = self.fresh();
        self.component.insert(node, c);
        self.members.insert(c, HashSet::from([node]));
        c
    }

    fn fresh(&mut self) -> ComponentId {
        self.next += 1;
        self.next
    }

    fn size(&self, c: ComponentId) -> usize {
        self.members.get(&c).map_or(0, |s| s.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One tile between each, so a run's length is its number of hops.
    fn chain(net: &mut RoadNetwork, ids: &[EntityId]) {
        for pair in ids.windows(2) {
            net.link(pair[0], pair[1], 1.0);
        }
    }

    /// What the index claims, worked out the slow obvious way: every run of
    /// road, contracted from nothing. An index that is *updated* fails by
    /// drifting, so this is the test that matters.
    fn segments_agree(net: &RoadNetwork) {
        let mut links: HashSet<Link> = HashSet::new();
        for (&a, ns) in &net.adj {
            for &b in ns.keys() {
                links.insert(link_key(a, b));
            }
        }
        let held: HashSet<Link> = net
            .segments
            .values()
            .flat_map(|s| s.nodes.windows(2).map(|p| link_key(p[0], p[1])))
            .collect();
        assert_eq!(held, links, "every road belongs to exactly one segment");

        let covered: usize = net.segments.values().map(|s| s.nodes.len() - 1).sum();
        assert_eq!(covered, links.len(), "no road is covered twice");

        for seg in net.segments.values() {
            for node in &seg.nodes[1..seg.nodes.len() - 1] {
                assert_eq!(
                    net.adj.get(node).map_or(0, |a| a.len()),
                    2,
                    "a junction cannot sit inside a segment",
                );
            }
        }
    }

    /// The segments the index *should* hold, worked out a different way from
    /// the way it builds them: start at every junction and dead end, walk each
    /// arm to the next one, and whatever links are left over are rings.
    ///
    /// Deliberately not the same algorithm as `recontract` — a reference that
    /// shares the production reasoning would share its mistakes.
    fn reference_segments(adj: &HashMap<EntityId, HashMap<EntityId, f64>>) -> HashSet<Vec<Link>> {
        let deg = |n: EntityId| adj.get(&n).map_or(0, |a| a.len());
        let mut all: HashSet<Link> = HashSet::new();
        for (&a, ns) in adj {
            for &b in ns.keys() {
                all.insert(link_key(a, b));
            }
        }

        let mut out: HashSet<Vec<Link>> = HashSet::new();
        let mut used: HashSet<Link> = HashSet::new();

        let mut ends: Vec<EntityId> = adj.keys().copied().filter(|&n| deg(n) != 2).collect();
        ends.sort_unstable();
        for start in ends {
            let mut arms: Vec<EntityId> = adj[&start].keys().copied().collect();
            arms.sort_unstable();
            for first in arms {
                if used.contains(&link_key(start, first)) {
                    continue;
                }
                let mut run = vec![link_key(start, first)];
                used.insert(link_key(start, first));
                let (mut prev, mut at) = (start, first);
                while deg(at) == 2 {
                    let next = *adj[&at].keys().find(|&&n| n != prev).unwrap();
                    run.push(link_key(at, next));
                    used.insert(link_key(at, next));
                    prev = at;
                    at = next;
                }
                run.sort_unstable();
                out.insert(run);
            }
        }

        // Anything untouched has no junction on it at all: a ring.
        let mut leftover: Vec<Link> = all.difference(&used).copied().collect();
        leftover.sort_unstable();
        while let Some(&seed) = leftover.first() {
            let mut run = vec![seed];
            used.insert(seed);
            let (start, mut prev, mut at) = (seed.0, seed.0, seed.1);
            while at != start {
                let next = *adj[&at].keys().find(|&&n| n != prev).unwrap();
                run.push(link_key(at, next));
                used.insert(link_key(at, next));
                prev = at;
                at = next;
            }
            run.sort_unstable();
            out.insert(run);
            leftover.retain(|l| !used.contains(l));
        }
        out
    }

    fn held_segments(net: &RoadNetwork) -> HashSet<Vec<Link>> {
        net.segments
            .values()
            .map(|s| {
                let mut ls: Vec<Link> =
                    s.nodes.windows(2).map(|p| link_key(p[0], p[1])).collect();
                ls.sort_unstable();
                ls
            })
            .collect()
    }

    /// Roads laid and lifted at random, checked after every single edit.
    ///
    /// The point is the cases nobody thought to write down: a junction that
    /// becomes a dead end, a ring that grows a spur and loses it again, a
    /// stretch cut and rejoined until the index has had every chance to drift.
    #[test]
    fn churn_never_drifts() {
        let mut rng: u64 = 0x5eed;
        let mut roll = move || {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (rng >> 33) as usize
        };

        let mut net = RoadNetwork::default();
        let mut laid: HashSet<Link> = HashSet::new();
        let (mut saw_ring, mut saw_crossroads, mut saw_split) = (false, false, false);
        // A small grid, so junctions, rings and dead ends all turn up often.
        const W: i32 = 5;
        let node = |x: i32, y: i32| (y * W + x) as EntityId + 1;

        for step in 0..4000 {
            let (x, y) = ((roll() as i32) % W, (roll() as i32) % W);
            let horizontal = roll() % 2 == 0;
            let (nx, ny) = if horizontal { (x + 1, y) } else { (x, y + 1) };
            if nx >= W || ny >= W {
                continue;
            }
            let (a, b) = (node(x, y), node(nx, ny));
            let key = link_key(a, b);

            if laid.contains(&key) {
                net.unlink(a, b);
                laid.remove(&key);
            } else {
                net.link(a, b, 1.0);
                laid.insert(key);
            }

            assert_eq!(
                held_segments(&net),
                reference_segments(&net.adj),
                "segments drifted at step {step} after touching {a}-{b}",
            );

            saw_ring |= net.segments.values().any(|s| s.is_ring());
            saw_crossroads |= net.adj.values().any(|arms| arms.len() == 4);
            saw_split |= net.members.len() > 1;

            // And the node index has to agree with the segments themselves.
            for (id, seg) in &net.segments {
                for n in &seg.nodes {
                    assert!(
                        net.on_node.get(n).is_some_and(|s| s.contains(id)),
                        "segment {id} not indexed at node {n} (step {step})",
                    );
                }
                for pair in seg.nodes.windows(2) {
                    assert!(
                        net.adj[&pair[0]].contains_key(&pair[1]),
                        "segment {id} walks a road that is not there (step {step})",
                    );
                }
            }
            for (n, ids) in &net.on_node {
                for id in ids {
                    assert!(
                        net.segments[id].nodes.contains(n),
                        "node {n} points at segment {id}, which does not contain it",
                    );
                }
            }
        }
        assert!(!laid.is_empty(), "the churn should leave some road standing");
        // A churn that never reached an interesting shape would pass without
        // testing anything.
        assert!(saw_ring, "the churn never closed a ring");
        assert!(saw_crossroads, "the churn never built a crossroads");
        assert!(saw_split, "the churn never broke the network in two");
    }

    #[test]
    fn a_run_remembers_each_direction_separately() {
        let mut net = RoadNetwork::default();
        // Dead ends at both ends, so 1..4 is one measurable run.
        chain(&mut net, &[1, 2, 3, 4]);

        net.observe_passage(1, 4, 1000.0);
        net.observe_passage(4, 1, 4000.0);
        assert_eq!(net.passage_ms(1, 4), Some(1000.0));
        assert_eq!(net.passage_ms(4, 1), Some(4000.0), "the jam is one way only");
    }

    /// Someone arriving from off the map joins wherever the road out past the
    /// frontier reaches, which is rarely a junction. Half a run tells you
    /// nothing about the whole one.
    #[test]
    fn a_car_that_joined_partway_reports_nothing() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3, 4, 5]);
        net.observe_passage(3, 5, 900.0); // joined at 3, mid-run
        assert_eq!(net.passage_ms(1, 5), None, "a part-driven run is not a measurement");
        assert_eq!(net.passage_ms(3, 5), None);
    }

    /// Four tiles at one tile per second is four seconds promised.
    #[test]
    fn a_road_nobody_has_driven_costs_what_it_promises() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3, 4, 5]);
        assert_eq!(net.travel_ms(1, 5, 1.0), Some(4000.0));
    }

    #[test]
    fn a_busy_road_costs_halfway_between_promise_and_record() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3, 4, 5]);
        net.observe_passage(1, 5, 8000.0); // twice what it promises
        assert_eq!(net.travel_ms(1, 5, 1.0), Some(6000.0));
        assert_eq!(net.travel_ms(5, 1, 1.0), Some(4000.0), "the other way is clear");
    }

    /// The property that lets a route be totalled run by run: averaging each
    /// and adding is the same as averaging the whole journey.
    #[test]
    fn costs_add_up_the_same_either_way() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3]);
        net.link(3, 4, 1.0);
        net.link(3, 9, 1.0); // junction at 3, so 1..3 and 3..4 are separate runs
        net.observe_passage(1, 3, 6000.0);
        net.observe_passage(3, 4, 3000.0);

        let leg_by_leg = net.travel_ms(1, 3, 1.0).unwrap() + net.travel_ms(3, 4, 1.0).unwrap();
        let free = 3.0 * 1000.0; // three tiles
        let driven = 6000.0 + 3000.0;
        assert_eq!(leg_by_leg, (free + driven) / 2.0);
    }

    /// A jam is discounted, never charged in full — which is what keeps a
    /// motorway crawling at half speed worth more than the lane beside it, and
    /// what stops everyone abandoning a road at once and piling back later.
    #[test]
    fn a_jam_is_only_ever_half_believed() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3]);
        let promised = net.travel_ms(1, 3, 1.0).unwrap();
        net.observe_passage(1, 3, promised * 3.0);

        let cost = net.travel_ms(1, 3, 1.0).unwrap();
        assert!(cost > promised, "the jam has to count for something");
        assert_eq!(cost, promised * 2.0, "but only half of it");
    }

    #[test]
    fn a_road_nobody_has_driven_has_nothing_to_say() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3]);
        assert_eq!(net.passage_ms(1, 3), None);
    }

    #[test]
    fn one_freak_trip_does_not_become_the_truth() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3]);
        for _ in 0..20 {
            net.observe_passage(1, 3, 1000.0);
        }
        net.observe_passage(1, 3, 9000.0);
        let after = net.passage_ms(1, 3).unwrap();
        assert!(after < 4000.0, "one bad run swung the average to {after}");
        assert!(after > 1000.0, "but it was not ignored either");
    }

    #[test]
    fn a_road_that_really_got_slower_is_believed() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3]);
        for _ in 0..20 {
            net.observe_passage(1, 3, 1000.0);
        }
        for _ in 0..10 {
            net.observe_passage(1, 3, 5000.0);
        }
        assert!(net.passage_ms(1, 3).unwrap() > 4500.0, "ten slow runs should convince it");
    }

    /// The reason passage is keyed by nodes and not by segment id: a road laid
    /// at a junction throws away every run meeting there and lays them again,
    /// so a run that came back completely unchanged still comes back with a
    /// fresh id. Keyed on the id, its history would evaporate.
    #[test]
    fn what_a_run_learned_survives_being_laid_again() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3]);
        net.link(3, 4, 1.0);
        net.link(3, 5, 1.0); // node 3 is now a junction, so 1..3 is a run
        net.observe_passage(1, 3, 1000.0);

        let before: Vec<SegmentId> =
            net.on_node[&2].iter().copied().collect();
        net.link(3, 7, 1.0); // a fourth arm: every run at 3 is rebuilt, 1..3 unchanged
        let after: Vec<SegmentId> = net.on_node[&2].iter().copied().collect();
        assert_ne!(before, after, "the run should have been laid again");

        assert_eq!(net.passage_ms(1, 3), Some(1000.0), "and kept what it knew");
    }

    #[test]
    fn a_straight_road_is_one_segment() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3, 4, 5]);
        assert_eq!(net.segment_count(), 1);
        segments_agree(&net);
    }

    #[test]
    fn a_junction_cuts_a_road_into_three() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3, 4, 5]);
        net.link(3, 99, 1.0); // a side road off the middle
        assert_eq!(net.segment_count(), 3, "two halves and the side road");
        segments_agree(&net);
    }

    #[test]
    fn removing_the_junction_makes_it_one_road_again() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3, 4, 5]);
        net.link(3, 99, 1.0);
        net.unlink(3, 99);
        assert_eq!(net.segment_count(), 1, "the halves merge back");
        segments_agree(&net);
    }

    #[test]
    fn a_ring_road_is_one_segment_however_it_was_drawn() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3, 4]);
        net.link(4, 1, 1.0);
        assert_eq!(net.segment_count(), 1);
        let ring = net.segments.values().next().unwrap();
        assert!(ring.is_ring());
        assert_eq!(ring.nodes.first(), Some(&1), "a ring starts at its lowest node");
        segments_agree(&net);

        // The same ring, closed from the other side, comes out identical.
        let mut other = RoadNetwork::default();
        chain(&mut other, &[3, 4, 1, 2]);
        other.link(2, 3, 1.0);
        assert_eq!(
            other.segments.values().next().unwrap().nodes,
            net.segments.values().next().unwrap().nodes,
        );
    }

    #[test]
    fn cutting_a_ring_leaves_one_open_road() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3, 4]);
        net.link(4, 1, 1.0);
        net.unlink(1, 2);
        assert_eq!(net.segment_count(), 1);
        let seg = net.segments.values().next().unwrap();
        assert!(!seg.is_ring());
        assert_eq!(seg.ends(), (1, 2), "it opens up at the cut");
        segments_agree(&net);
    }

    #[test]
    fn a_crossroads_meets_four_segments() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3]); // west-east through 2
        net.link(2, 10, 1.0);
        chain(&mut net, &[10, 11]);
        net.link(2, 20, 1.0);
        assert_eq!(net.segments_at(2).count(), 4, "four arms meet here");
        segments_agree(&net);
    }

    #[test]
    fn extending_a_dead_end_lengthens_its_segment() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3]);
        net.link(3, 4, 1.0);
        assert_eq!(net.segment_count(), 1);
        let seg = net.segments.values().next().unwrap();
        assert_eq!(seg.nodes, vec![1, 2, 3, 4]);
        segments_agree(&net);
    }

    #[test]
    fn a_road_pulled_up_in_the_middle_leaves_two() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3, 4, 5]);
        net.unlink(3, 4);
        assert_eq!(net.segment_count(), 2);
        segments_agree(&net);
    }

    #[test]
    fn the_last_road_leaves_nothing_behind() {
        let mut net = RoadNetwork::default();
        net.link(1, 2, 1.0);
        net.unlink(1, 2);
        assert_eq!(net.segment_count(), 0);
        assert!(net.on_node.is_empty(), "no segment left pointing at a node");
        segments_agree(&net);
    }

    #[test]
    fn a_road_joins_what_it_touches() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3]);
        assert!(net.connected(1, 3));
    }

    #[test]
    fn two_roads_that_never_meet_are_two_networks() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3]);
        chain(&mut net, &[10, 11]);
        assert!(!net.connected(1, 10));
    }

    #[test]
    fn joining_them_makes_one() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3]);
        chain(&mut net, &[10, 11]);
        net.link(3, 10, 1.0);
        assert!(net.connected(1, 11));
    }

    #[test]
    fn cutting_a_chain_splits_it() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3, 4]);
        net.unlink(2, 3);
        assert!(net.connected(1, 2));
        assert!(net.connected(3, 4));
        assert!(!net.connected(1, 4));
    }

    #[test]
    fn cutting_a_ring_leaves_it_whole() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3, 4]);
        net.link(4, 1, 1.0);
        net.unlink(1, 2);
        assert!(net.connected(1, 2));
        assert!(net.connected(2, 4));
    }

    #[test]
    fn a_node_left_with_nothing_is_out_of_the_network() {
        let mut net = RoadNetwork::default();
        net.link(1, 2, 1.0);
        net.unlink(1, 2);
        assert!(!net.connected(1, 2));
        assert_eq!(net.component_of(1), None);
    }

    #[test]
    fn rejoining_after_a_cut_is_one_network_again() {
        let mut net = RoadNetwork::default();
        chain(&mut net, &[1, 2, 3, 4]);
        net.unlink(2, 3);
        net.link(2, 3, 1.0);
        assert!(net.connected(1, 4));
    }

    #[test]
    fn a_stub_breaking_off_a_long_road_costs_the_stub() {
        let mut net = RoadNetwork::default();
        let long: Vec<EntityId> = (1..=200).collect();
        chain(&mut net, &long);
        chain(&mut net, &[200, 201, 202]);
        net.unlink(200, 201);
        assert!(net.connected(1, 200));
        assert!(net.connected(201, 202));
        assert!(!net.connected(200, 201));
    }
}
