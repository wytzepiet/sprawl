use std::collections::{HashMap, VecDeque};

use crate::engine::GameTime;
use crate::protocol::EntityId;

pub type Dir = (i32, i32);

/// Who may go together through a junction: does a party waiting, from
/// its arm to its exit, cross one passing. Roads keep right
/// (`paths_conflict`); the sea has its own (`shipping::lanes`).
pub type Rule = fn(waiting: (Dir, Dir), passing: (Dir, Dir)) -> bool;

/// A car's way through a junction, as it drives it: points along its lane
/// from the seam it comes in by to the one it goes out by, in tiles from
/// the junction (`track`).
pub type Track = [[f32; 2]; TRACK_POINTS];
pub const TRACK_POINTS: usize = 9;

/// How near two cars' tracks may come before they are in each other's
/// way: a car's width, and a little.
const CLEAR: f32 = 0.15;

#[derive(Clone, Copy)]
struct QueueEntry {
    car_id: EntityId,
    from: Dir,
    to: Dir,
    /// Its way through, if it is a car on the road; a ship, none, and its
    /// junction's rule says who crosses whom.
    track: Option<Track>,
    /// Coming in on a priority road: it goes before anyone on a minor one.
    major: bool,
    /// The lane it goes out by, on a road of two: a merge gives way only
    /// to whoever goes out in its own lane.
    lane: u8,
    /// When it was granted passage; meaningless while it waits.
    since: GameTime,
}

/// How long a car holds a junction it cannot use before it waves the others
/// through: a driver stuck behind something with the cross traffic waiting
/// gives way in a matter of seconds. A claim held that long by a car that
/// is not moving lapses, and the car queues again. Two driveways two tiles
/// apart can otherwise hold each other for good (docs/parking.md §9); with
/// this, no claim outlives whatever is blocking it. Physics seconds, like
/// the cruising speed.
pub const PATIENCE: GameTime = 10_000;

/// Angle on the game map (y-down screen coords → negate y for math-CCW = map-CCW).
fn dir_angle(d: Dir) -> f64 {
    (-(d.1 as f64)).atan2(d.0 as f64)
}

/// Right-hand traffic conflict test.
/// Sweep CCW from the waiting car's entry arm. If we hit the waiting car's exit
/// before any arm of the passing car, the paths don't cross.
pub fn paths_conflict((w_from, w_to): (Dir, Dir), (p_from, p_to): (Dir, Dir)) -> bool {
    // Same entry arm: segment ordering handles safety
    if w_from == p_from {
        return false;
    }
    let base = dir_angle(w_from);
    let tau = std::f64::consts::TAU;
    let ccw = |d: Dir| (dir_angle(d) - base).rem_euclid(tau);
    let w_to = ccw(w_to);
    let p_from = ccw(p_from);
    let p_to = ccw(p_to);
    // Conflict if a passing arm appears before our exit in the CCW sweep.
    // p_from at boundary = opposite directions on same arm (no conflict) → strict <
    // p_to at boundary = same exit arm (merge conflict) → <=
    (p_from > 0.0 && p_from < w_to) || (p_to > 0.0 && p_to <= w_to)
}

/// Right-hand traffic, as `paths_conflict`, but two cars bound for the
/// same exit from different arms do not exclude each other: they merge,
/// the one behind following the one ahead on the road out
/// (`car::simulation`'s `join_run`), easing in rather than stopping.
pub fn paths_cross((w_from, w_to): (Dir, Dir), (p_from, p_to): (Dir, Dir)) -> bool {
    if w_from == p_from {
        return false;
    }
    let base = dir_angle(w_from);
    let tau = std::f64::consts::TAU;
    let ccw = |d: Dir| (dir_angle(d) - base).rem_euclid(tau);
    let w_to = ccw(w_to);
    let p_from = ccw(p_from);
    let p_to = ccw(p_to);
    (p_from > 0.0 && p_from < w_to) || (p_to > 0.0 && p_to < w_to - 1e-9)
}

/// A junction's traffic lights: its arms in phases, each green in turn.
///
/// Phases are found, not set: arms straight across from each other are
/// green together, any other alone. Within a green phase the junction is
/// as it is without lights, first come first served by the rule, so a
/// left turn waits for the oncoming. The lights are adaptive: a phase
/// holds while its cars come, and ends after `MIN_GREEN` once another has
/// cars waiting and none has come to its own for `GAP`, or at `MAX_GREEN`
/// whatever; then
/// all red until the junction is clear (`CLEAR_MS` at most), and the next
/// phase with cars waiting is green.
#[derive(Clone, Debug)]
pub struct Signal {
    pub phases: Vec<Vec<Dir>>,
    pub phase: usize,
    since: GameTime,
    clearing: bool,
    /// When a car last came to the green: the green holds while they keep
    /// coming.
    last: GameTime,
}

impl Signal {
    /// All red, between phases.
    pub fn clearing(&self) -> bool {
        self.clearing
    }
}

pub const MIN_GREEN: GameTime = 5_000;
/// How long a green waits for its next car before it gives way.
pub const GAP: GameTime = 3_500;
pub const MAX_GREEN: GameTime = 18_000;
pub const CLEAR_MS: GameTime = 3_000;
/// How often a light with traffic at it looks again.
pub const SIGNAL_TICK: GameTime = 1_000;

/// The phases of a junction with these arms: each with the one straight
/// across from it, if there is one; else alone.
pub fn phases_of(arms: &[Dir]) -> Vec<Vec<Dir>> {
    let mut left: Vec<Dir> = arms.to_vec();
    left.sort_unstable();
    let mut phases = Vec::new();
    while let Some(a) = left.first().copied() {
        left.remove(0);
        let mut phase = vec![a];
        if let Some(i) = left.iter().position(|&b| b == (-a.0, -a.1)) {
            phase.push(left.remove(i));
        }
        phases.push(phase);
    }
    phases
}

/// FIFO intersection manager. Cars with non-crossing paths can go simultaneously.
///
/// Two separate lists:
/// - `queue`: cars waiting for passage, in arrival order.
/// - `passing`: cars currently in the intersection (already granted).
///
/// Passage is granted front-to-back: pop from the front of the queue as long as
/// the car doesn't conflict with any car in `passing`. Stop at the first conflict.
pub struct IntersectionManager {
    queue: VecDeque<QueueEntry>,
    passing: Vec<QueueEntry>,
    rule: Rule,
    /// Its lights, if it has them.
    signal: Option<Signal>,
}

impl IntersectionManager {
    pub fn new(rule: Rule) -> Self {
        Self {
            queue: VecDeque::new(),
            passing: Vec::new(),
            rule,
            signal: None,
        }
    }

    /// Add a car to the queue. Returns true if newly registered.
    pub fn register(&mut self, car_id: EntityId, from: Dir, to: Dir, now: GameTime) -> bool {
        self.register_ranked(car_id, from, to, 0, None, false, now)
    }

    /// Add a car to the queue, the lane it goes out by, its way through
    /// (`track`), coming in on a priority road (`major`) or not; already
    /// there, its lane kept up to date, as it may change lanes on its way.
    /// Returns true if newly registered.
    pub fn register_ranked(&mut self, car_id: EntityId, from: Dir, to: Dir, lane: u8, track: Option<Track>, major: bool, now: GameTime) -> bool {
        let mut already = false;
        for e in self.queue.iter_mut().chain(self.passing.iter_mut()).filter(|e| e.car_id == car_id) {
            e.lane = lane;
            already = true;
        }
        if !already {
            if let Some(signal) = &mut self.signal
                && signal.phases.get(signal.phase).is_some_and(|green| green.contains(&from))
            {
                signal.last = now;
            }
            self.queue.push_back(QueueEntry { car_id, from, to, track, major, lane, since: now });
            self.grant_passage(now);
            return true;
        }
        false
    }

    /// A car with passage is standing still: if it has held the claim past
    /// `PATIENCE`, it gives it back and queues again at the back. Returns
    /// whoever that lets through.
    pub fn lapse(&mut self, car_id: EntityId, now: GameTime) -> Vec<EntityId> {
        let Some(i) = self.passing.iter().position(|e| e.car_id == car_id && now >= e.since + PATIENCE) else { return Vec::new() };
        let mut entry = self.passing.remove(i);
        entry.since = now;
        self.queue.push_back(entry);
        self.grant_passage(now)
    }

    /// Returns true if this car has been granted passage (is in the passing list).
    pub fn has_passage(&self, car_id: EntityId) -> bool {
        self.passing.iter().any(|e| e.car_id == car_id)
    }

    /// Grant passage to cars at the front of the queue that don't conflict
    /// with passing cars: those on a priority road first, in the order they
    /// came, then the rest. The first that must wait holds everyone behind
    /// it, so nobody on a minor road slips in before a car on the major
    /// one, nor before anyone who came before them. Where no road has
    /// priority, or every one does, that is first come, first served.
    fn grant_passage(&mut self, now: GameTime) -> Vec<EntityId> {
        let mut newly_granted = Vec::new();
        // At lights, only those at a green arm, in the order they came: the
        // lights are the priority.
        if let Some(signal) = &self.signal {
            if signal.clearing {
                return newly_granted;
            }
            let green = signal.phases.get(signal.phase).cloned().unwrap_or_default();
            while let Some(i) = self.queue.iter().position(|e| green.contains(&e.from)) {
                let next = self.queue[i];
                if self.passing.iter().any(|p| self.crosses(&next, p)) {
                    break;
                }
                let mut entry = self.queue.remove(i).unwrap();
                entry.since = now;
                newly_granted.push(entry.car_id);
                self.passing.push(entry);
            }
            return newly_granted;
        }
        while let Some(i) = self.queue.iter().position(|e| e.major).or((!self.queue.is_empty()).then_some(0)) {
            let next = self.queue[i];
            // A merge is no conflict between equals: who goes first is the
            // cars' own to settle (`car::simulation`'s merging). Onto a
            // priority road from a minor one, into the same lane, it is:
            // the minor gives way.
            let dominated = self.passing.iter().any(|p| self.crosses(&next, p) || (next.to == p.to && next.lane == p.lane && next.major != p.major));
            if dominated {
                break;
            }
            let mut entry = self.queue.remove(i).unwrap();
            entry.since = now;
            newly_granted.push(entry.car_id);
            self.passing.push(entry);
        }
        newly_granted
    }

    /// Does a car waiting cross one passing: their ways through, where both
    /// are known, coming within `CLEAR` of each other, but for two from
    /// one arm, which follow each other in, and two to one, which merge;
    /// else the junction's rule.
    fn crosses(&self, waiting: &QueueEntry, passing: &QueueEntry) -> bool {
        match (&waiting.track, &passing.track) {
            (Some(a), Some(b)) => waiting.from != passing.from && waiting.to != passing.to && apart(a, b) < CLEAR,
            _ => (self.rule)((waiting.from, waiting.to), (passing.from, passing.to)),
        }
    }

    /// Lights at this junction, with these arms; or none. Lights already
    /// there keep their phase, if they still have it.
    pub fn set_signal(&mut self, arms: Option<&[Dir]>, now: GameTime) {
        match arms {
            None => self.signal = None,
            Some(arms) => {
                let phases = phases_of(arms);
                match &mut self.signal {
                    Some(s) if s.phases == phases => {}
                    _ => self.signal = Some(Signal { phases, phase: 0, since: now, clearing: false, last: now }),
                }
            }
        }
    }

    pub fn signal(&self) -> Option<&Signal> {
        self.signal.as_ref()
    }


    /// The lights look again: whether to end the green, or, all red and
    /// clear, which phase is green next. The cars that lets through, and
    /// when to look again (none while nobody is at the junction).
    pub fn tick(&mut self, now: GameTime) -> (Vec<EntityId>, Option<GameTime>) {
        let Some(signal) = &self.signal else { return (self.grant_passage(now), None) };
        let waiting = |phase: &Vec<Dir>| self.queue.iter().any(|e| phase.contains(&e.from));
        let elapsed = now.saturating_sub(signal.since);
        let mut next = signal.clone();
        if signal.clearing {
            if self.passing.is_empty() || elapsed >= CLEAR_MS {
                let n = next.phases.len();
                next.phase = (1..=n).map(|k| (signal.phase + k) % n).find(|&p| waiting(&signal.phases[p])).unwrap_or((signal.phase + 1) % n);
                next.since = now;
                next.last = now;
                next.clearing = false;
            }
        } else {
            let others = signal.phases.iter().enumerate().any(|(i, p)| i != signal.phase && waiting(p));
            let mine = waiting(&signal.phases[signal.phase]) || now.saturating_sub(signal.last) < GAP;
            if others && ((elapsed >= MIN_GREEN && !mine) || elapsed >= MAX_GREEN) {
                next.clearing = true;
                next.since = now;
            }
        }
        self.signal = Some(next);
        let woken = self.grant_passage(now);
        let busy = !self.queue.is_empty() || !self.passing.is_empty();
        (woken, busy.then_some(SIGNAL_TICK))
    }

    /// Car has left the intersection. Remove from passing and grant new cars.
    pub fn clear(&mut self, car_id: EntityId, now: GameTime) -> Vec<EntityId> {
        self.passing.retain(|e| e.car_id != car_id);
        // Nor queued: a claim that lapsed while it stood in the box, and
        // was never granted again before it left, would stand in the queue
        // for a car that is gone.
        self.queue.retain(|e| e.car_id != car_id);
        self.grant_passage(now)
    }

    /// Remove a car entirely (e.g., on despawn). Returns newly granted cars.
    pub fn remove_car(&mut self, car_id: EntityId, now: GameTime) -> Vec<EntityId> {
        let was_passing = self.passing.iter().any(|e| e.car_id == car_id);
        self.passing.retain(|e| e.car_id != car_id);
        self.queue.retain(|e| e.car_id != car_id);
        if was_passing {
            self.grant_passage(now)
        } else {
            Vec::new()
        }
    }

}

pub struct IntersectionRegistry {
    managers: HashMap<EntityId, IntersectionManager>,
    /// How many claims have lapsed: the gauge of how often the street
    /// locks. A handful a day is a jam; a climb is the street model.
    pub lapses: u64,
}

impl IntersectionRegistry {
    pub fn new() -> Self {
        Self {
            managers: HashMap::new(),
            lapses: 0,
        }
    }

    /// A car with passage at this junction is standing still; let its claim
    /// lapse if it is old enough. Returns the cars let through.
    pub fn lapse(&mut self, node_id: EntityId, car_id: EntityId, now: GameTime) -> Vec<EntityId> {
        let Some(manager) = self.managers.get_mut(&node_id) else { return Vec::new() };
        let was = manager.has_passage(car_id);
        let woken = manager.lapse(car_id, now);
        if was && !manager.has_passage(car_id) {
            self.lapses += 1;
        }
        woken
    }

    pub fn get_or_create(&mut self, node_id: EntityId) -> &mut IntersectionManager {
        self.get_or_create_with(node_id, paths_cross)
    }

    /// A junction that keeps its own rule (a sea's: `shipping::lanes`).
    pub fn get_or_create_with(&mut self, node_id: EntityId, rule: Rule) -> &mut IntersectionManager {
        self.managers.entry(node_id).or_insert_with(|| IntersectionManager::new(rule))
    }

    /// A junction's lights, if it has any.
    pub fn signal(&self, node_id: EntityId) -> Option<&Signal> {
        self.managers.get(&node_id).and_then(|m| m.signal())
    }

    /// The lights at a junction look again (`IntersectionManager::tick`).
    pub fn tick(&mut self, node_id: EntityId, now: GameTime) -> (Vec<EntityId>, Option<GameTime>) {
        self.managers.get_mut(&node_id).map_or((Vec::new(), None), |m| m.tick(now))
    }

    pub fn has_passage(&self, node_id: EntityId, car_id: EntityId) -> bool {
        self.managers.get(&node_id).is_some_and(|m| m.has_passage(car_id))
    }

    /// Remove a car from all intersections. Returns list of (node, woken_car) pairs.
    pub fn remove_car_from_all(&mut self, car_id: EntityId, now: GameTime) -> Vec<(EntityId, EntityId)> {
        let mut results = Vec::new();
        for (&node_id, manager) in &mut self.managers {
            for woken in manager.remove_car(car_id, now) {
                results.push((node_id, woken));
            }
        }
        results
    }

    /// Take a car out of one junction's queue and passage altogether: a
    /// claim made from behind a junction it has since lost passage at
    /// would be held by a car that cannot reach it. Returns woken car IDs.
    pub fn remove_car(&mut self, node_id: EntityId, car_id: EntityId, now: GameTime) -> Vec<EntityId> {
        self.managers.get_mut(&node_id).map_or_else(Vec::new, |m| m.remove_car(car_id, now))
    }

    /// Clear a car from a specific node's manager (if it exists). Returns woken car IDs.
    pub fn clear_car(&mut self, node_id: EntityId, car_id: EntityId, now: GameTime) -> Vec<EntityId> {
        if let Some(manager) = self.managers.get_mut(&node_id) {
            manager.clear(car_id, now)
        } else {
            Vec::new()
        }
    }

    pub fn remove_node(&mut self, node_id: EntityId) {
        self.managers.remove(&node_id);
    }
}

/// A lane's way through a junction at `at`, from the one at `from` to the
/// one at `to` (where each stands, in tiles), as a car keeps to it: from
/// where it crosses the one seam to where it crosses the other, each beside
/// its road's middle by the lane's offset (to the right of the way it is
/// driven), pulled toward where the two lanes' ways meet; straight on, or
/// nearly, straight. The client draws the same (`surface.ts`'s `laneOf`).
pub fn track(from: [f64; 2], at: [f64; 2], to: [f64; 2], lane_in: f64, lane_out: f64) -> Track {
    let unit = |p: [f64; 2]| {
        let (x, y) = (p[0] - at[0], p[1] - at[1]);
        let l = x.hypot(y).max(1e-9);
        [x / l, y / l]
    };
    let seam = |p: [f64; 2]| [(p[0] - at[0]) / 2.0, (p[1] - at[1]) / 2.0];
    let (ua, ub) = (unit(from), unit(to));
    let (ia, ob) = ([-ua[0], -ua[1]], ub);
    let (sa, sb) = (seam(from), seam(to));
    let a = [sa[0] - ia[1] * lane_in, sa[1] + ia[0] * lane_in];
    let b = [sb[0] - ob[1] * lane_out, sb[1] + ob[0] * lane_out];
    let cross = ia[0] * ob[1] - ia[1] * ob[0];
    let s = ((b[0] - a[0]) * ob[1] - (b[1] - a[1]) * ob[0]) / cross;
    let c = if cross.abs() >= 0.2 && s > 0.0 { [a[0] + ia[0] * s, a[1] + ia[1] * s] } else { [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0] };
    std::array::from_fn(|k| {
        let t = k as f64 / (TRACK_POINTS - 1) as f64;
        let (u, v, w) = ((1.0 - t) * (1.0 - t), 2.0 * t * (1.0 - t), t * t);
        [(u * a[0] + v * c[0] + w * b[0]) as f32, (u * a[1] + v * c[1] + w * b[1]) as f32]
    })
}

/// A lane's way straight from `a` to `b` (where each stands, in tiles from
/// where it is seen), beside the road's middle by the lane's offset, to the
/// right of the way it is driven: across a crossing.
pub fn straight(a: [f64; 2], b: [f64; 2], lane: f64) -> Track {
    let (x, y) = (b[0] - a[0], b[1] - a[1]);
    let l = x.hypot(y).max(1e-9);
    let (ox, oy) = (-y / l * lane, x / l * lane);
    std::array::from_fn(|k| {
        let t = k as f64 / (TRACK_POINTS - 1) as f64;
        [(a[0] + x * t + ox) as f32, (a[1] + y * t + oy) as f32]
    })
}

/// How near two tracks come.
fn apart(a: &Track, b: &Track) -> f32 {
    let mut near = f32::MAX;
    for p in a.windows(2) {
        for q in b.windows(2) {
            near = near.min(between(p[0], p[1], q[0], q[1]));
        }
    }
    near
}

/// How near two segments come: none if they cross.
fn between(a: [f32; 2], b: [f32; 2], c: [f32; 2], d: [f32; 2]) -> f32 {
    let side = |p: [f32; 2], q: [f32; 2], r: [f32; 2]| (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    if side(a, b, c) * side(a, b, d) < 0.0 && side(c, d, a) * side(c, d, b) < 0.0 {
        return 0.0;
    }
    let to = |p: [f32; 2], a: [f32; 2], b: [f32; 2]| {
        let (ex, ey) = (b[0] - a[0], b[1] - a[1]);
        let t = (((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (ex * ex + ey * ey).max(1e-12)).clamp(0.0, 1.0);
        (p[0] - a[0] - ex * t).hypot(p[1] - a[1] - ey * t)
    };
    to(a, c, d).min(to(b, c, d)).min(to(c, a, b)).min(to(d, a, b))
}

#[cfg(test)]
mod tests {
    use super::{apart, track, CLEAR};

    /// Ways through a junction at the origin, by the neighbours' steps and
    /// whether each road runs both ways (its lane on the right).
    fn way(from: (i32, i32), to: (i32, i32), two_way: bool) -> super::Track {
        let lane = if two_way { 0.11 } else { 0.0 };
        track([from.0 as f64, from.1 as f64], [0.0, 0.0], [to.0 as f64, to.1 as f64], lane, lane)
    }

    /// Cars on two bends round opposite corners of one junction go at
    /// once; two crossing, one waits.
    #[test]
    fn cars_whose_ways_miss_go_at_once() {
        let (w, e, n, s) = ((-1, 0), (1, 0), (0, -1), (0, 1));
        let mut j = super::IntersectionManager::new(super::paths_cross);
        j.register_ranked(1, w, n, 0, Some(way(w, n, false)), false, 0);
        j.register_ranked(2, s, e, 0, Some(way(s, e, false)), false, 0);
        assert!(j.has_passage(1) && j.has_passage(2), "two bends wait for each other");
        let mut j = super::IntersectionManager::new(super::paths_cross);
        j.register_ranked(1, w, e, 0, Some(way(w, e, true)), false, 0);
        j.register_ranked(2, s, n, 0, Some(way(s, n, true)), false, 0);
        assert!(j.has_passage(1) && !j.has_passage(2), "two crossing go together");
    }

    /// Tracks cross where cars would, and pass where they would not.
    #[test]
    fn tracks_cross_where_cars_would() {
        let (w, e, n, s) = ((-1, 0), (1, 0), (0, -1), (0, 1));
        // Two one-ways each bending round its own corner of one tile.
        assert!(apart(&way(w, n, false), &way(s, e, false)) > CLEAR, "two bends in opposite corners meet");
        // Straight across each other.
        assert!(apart(&way(w, e, true), &way(s, n, true)) < CLEAR, "a crossroads does not cross");
        // Two ways of a road both ways, side by side.
        assert!(apart(&way(w, e, true), &way(e, w, true)) > CLEAR, "a road's two lanes meet");
        // A left turn across the oncoming lane.
        assert!(apart(&way(w, n, true), &way(e, w, true)) < CLEAR, "a left turn misses the oncoming");
        // Two right turns from opposite arms.
        assert!(apart(&way(w, s, true), &way(e, n, true)) > CLEAR, "two right turns meet");
        // A diagonal past a one-way's bend.
        assert!(apart(&way((-1, 1), (1, -1), false), &way(n, w, false)) > CLEAR, "a diagonal meets a bend it passes");
    }

    use super::*;

    const W: Dir = (-1, 0);
    const E: Dir = (1, 0);
    const N: Dir = (0, -1);
    const S: Dir = (0, 1);

    /// A car on the priority road goes first, though it came second; the
    /// one on the side street waits until it is through. Without priority
    /// it is first come, first served.
    #[test]
    fn the_priority_road_goes_first() {
        let mut j = IntersectionManager::new(paths_conflict);
        j.register_ranked(1, S, N, 0, None, false, 0);
        assert!(j.has_passage(1), "alone, the side street goes");
        j.clear(1, 10);

        let mut j = IntersectionManager::new(paths_conflict);
        // Both arrive while the junction is held, the side street first,
        // and both are bound west, so only one may go.
        j.register_ranked(9, N, S, 0, None, true, 0);
        j.register_ranked(1, S, W, 0, None, false, 1);
        j.register_ranked(2, E, W, 0, None, true, 2);
        assert!(!j.has_passage(1) && !j.has_passage(2));
        assert_eq!(j.clear(9, 3), vec![2], "the priority road's car, not the side street's");
        assert_eq!(j.clear(2, 4), vec![1], "then the side street");

        let mut j = IntersectionManager::new(paths_conflict);
        j.register_ranked(9, N, S, 0, None, false, 0);
        j.register_ranked(1, S, W, 0, None, false, 1);
        j.register_ranked(2, E, W, 0, None, false, 2);
        assert_eq!(j.clear(9, 3), vec![1], "no priority: in the order they came");
    }

    /// Lights let one phase through, then, the other waiting and its own
    /// empty after the shortest green, all red, then the other.
    #[test]
    fn the_lights_take_turns() {
        let mut j = IntersectionManager::new(paths_cross);
        j.set_signal(Some(&[W, E, N, S]), 0);
        assert_eq!(j.signal().unwrap().phases.len(), 2, "east-west, and north-south");
        let green = j.signal().unwrap().phases[0].clone();
        let (go, stop) = if green.contains(&W) { (W, N) } else { (N, W) };
        let opposite = |d: Dir| (-d.0, -d.1);
        j.register(1, go, opposite(go), 0);
        j.register(2, stop, opposite(stop), 0);
        assert!(j.has_passage(1), "green");
        assert!(!j.has_passage(2), "red");
        j.clear(1, 1_000);
        assert!(j.tick(2_000).0.is_empty(), "the shortest green still runs");
        let mut t = 2_000;
        let mut through = Vec::new();
        while through.is_empty() && t < 20_000 {
            t += SIGNAL_TICK;
            through = j.tick(t).0;
        }
        assert_eq!(through, vec![2], "then the other phase");
        assert!(t >= MIN_GREEN, "not before the shortest green");
    }
}
