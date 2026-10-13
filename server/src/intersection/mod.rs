use std::collections::{HashMap, VecDeque};

use crate::engine::GameTime;
use crate::protocol::EntityId;

pub type Dir = (i32, i32);

/// Who may go together through a junction: does a party waiting, from
/// its arm to its exit, cross one passing. Roads keep right
/// (`paths_conflict`); the sea has its own (`shipping::lanes`).
pub type Rule = fn(waiting: (Dir, Dir), passing: (Dir, Dir)) -> bool;

#[derive(Clone, Copy)]
struct QueueEntry {
    car_id: EntityId,
    from: Dir,
    to: Dir,
    /// Coming in on a priority road: it goes before anyone on a minor one.
    major: bool,
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
}

impl IntersectionManager {
    pub fn new(rule: Rule) -> Self {
        Self {
            queue: VecDeque::new(),
            passing: Vec::new(),
            rule,
        }
    }

    /// Add a car to the queue. Returns true if newly registered.
    pub fn register(&mut self, car_id: EntityId, from: Dir, to: Dir, now: GameTime) -> bool {
        self.register_ranked(car_id, from, to, false, now)
    }

    /// Add a car to the queue, coming in on a priority road (`major`) or
    /// not. Returns true if newly registered.
    pub fn register_ranked(&mut self, car_id: EntityId, from: Dir, to: Dir, major: bool, now: GameTime) -> bool {
        let already = self.queue.iter().any(|e| e.car_id == car_id)
            || self.passing.iter().any(|e| e.car_id == car_id);
        if !already {
            self.queue.push_back(QueueEntry { car_id, from, to, major, since: now });
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
        while let Some(i) = self.queue.iter().position(|e| e.major).or((!self.queue.is_empty()).then_some(0)) {
            let next = self.queue[i];
            // A merge is no conflict between equals; onto a priority road
            // from a minor one it is: the minor gives way.
            let dominated = self.passing.iter().any(|p| (self.rule)((next.from, next.to), (p.from, p.to)) || (next.to == p.to && next.major != p.major));
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

#[cfg(test)]
mod tests {
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
        j.register_ranked(1, S, N, false, 0);
        assert!(j.has_passage(1), "alone, the side street goes");
        j.clear(1, 10);

        let mut j = IntersectionManager::new(paths_conflict);
        // Both arrive while the junction is held, the side street first,
        // and both are bound west, so only one may go.
        j.register_ranked(9, N, S, true, 0);
        j.register_ranked(1, S, W, false, 1);
        j.register_ranked(2, E, W, true, 2);
        assert!(!j.has_passage(1) && !j.has_passage(2));
        assert_eq!(j.clear(9, 3), vec![2], "the priority road's car, not the side street's");
        assert_eq!(j.clear(2, 4), vec![1], "then the side street");

        let mut j = IntersectionManager::new(paths_conflict);
        j.register_ranked(9, N, S, false, 0);
        j.register_ranked(1, S, W, false, 1);
        j.register_ranked(2, E, W, false, 2);
        assert_eq!(j.clear(9, 3), vec![1], "no priority: in the order they came");
    }
}
