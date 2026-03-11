use std::collections::{HashMap, VecDeque};

use crate::protocol::EntityId;

type Dir = (i32, i32);

#[derive(Clone, Copy)]
struct QueueEntry {
    car_id: EntityId,
    from: Dir,
    to: Dir,
}

/// Angle on the game map (y-down screen coords → negate y for math-CCW = map-CCW).
fn dir_angle(d: Dir) -> f64 {
    (-(d.1 as f64)).atan2(d.0 as f64)
}

/// Right-hand traffic conflict test.
/// Sweep CCW from the waiting car's entry arm. If we hit the waiting car's exit
/// before any arm of the passing car, the paths don't cross.
fn paths_conflict(waiting: &QueueEntry, passing: &QueueEntry) -> bool {
    // Same entry arm: segment ordering handles safety
    if waiting.from == passing.from {
        return false;
    }
    let base = dir_angle(waiting.from);
    let tau = std::f64::consts::TAU;
    let ccw = |d: Dir| (dir_angle(d) - base).rem_euclid(tau);
    let w_to = ccw(waiting.to);
    let p_from = ccw(passing.from);
    let p_to = ccw(passing.to);
    // Conflict if a passing arm appears before our exit in the CCW sweep.
    // p_from at boundary = opposite directions on same arm (no conflict) → strict <
    // p_to at boundary = same exit arm (merge conflict) → <=
    (p_from > 0.0 && p_from < w_to) || (p_to > 0.0 && p_to <= w_to)
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
}

impl IntersectionManager {
    pub fn new() -> Self {
        Self {
            queue: VecDeque::new(),
            passing: Vec::new(),
        }
    }

    /// Add a car to the queue. Returns true if newly registered.
    pub fn register(&mut self, car_id: EntityId, from: Dir, to: Dir) -> bool {
        let already = self.queue.iter().any(|e| e.car_id == car_id)
            || self.passing.iter().any(|e| e.car_id == car_id);
        if !already {
            self.queue.push_back(QueueEntry { car_id, from, to });
            self.grant_passage();
            return true;
        }
        false
    }

    /// Returns true if this car has been granted passage (is in the passing list).
    pub fn has_passage(&self, car_id: EntityId) -> bool {
        self.passing.iter().any(|e| e.car_id == car_id)
    }

    /// Grant passage to cars at the front of the queue that don't conflict with passing cars.
    fn grant_passage(&mut self) -> Vec<EntityId> {
        let mut newly_granted = Vec::new();
        while let Some(front) = self.queue.front() {
            let dominated = self.passing.iter().any(|p| paths_conflict(front, p));
            if dominated {
                break;
            }
            let entry = self.queue.pop_front().unwrap();
            newly_granted.push(entry.car_id);
            self.passing.push(entry);
        }
        newly_granted
    }

    /// Car has left the intersection. Remove from passing and grant new cars.
    pub fn clear(&mut self, car_id: EntityId) -> Vec<EntityId> {
        self.passing.retain(|e| e.car_id != car_id);
        self.grant_passage()
    }

    /// Remove a car entirely (e.g., on despawn). Returns newly granted cars.
    pub fn remove_car(&mut self, car_id: EntityId) -> Vec<EntityId> {
        let was_passing = self.passing.iter().any(|e| e.car_id == car_id);
        self.passing.retain(|e| e.car_id != car_id);
        self.queue.retain(|e| e.car_id != car_id);
        if was_passing {
            self.grant_passage()
        } else {
            Vec::new()
        }
    }

}

pub struct IntersectionRegistry {
    managers: HashMap<EntityId, IntersectionManager>,
}

impl IntersectionRegistry {
    pub fn new() -> Self {
        Self {
            managers: HashMap::new(),
        }
    }

    pub fn get_or_create(&mut self, node_id: EntityId) -> &mut IntersectionManager {
        self.managers.entry(node_id).or_insert_with(IntersectionManager::new)
    }

    pub fn has_passage(&self, node_id: EntityId, car_id: EntityId) -> bool {
        self.managers.get(&node_id).is_some_and(|m| m.has_passage(car_id))
    }

    /// Remove a car from all intersections. Returns list of (node, woken_car) pairs.
    pub fn remove_car_from_all(&mut self, car_id: EntityId) -> Vec<(EntityId, EntityId)> {
        let mut results = Vec::new();
        for (&node_id, manager) in &mut self.managers {
            for woken in manager.remove_car(car_id) {
                results.push((node_id, woken));
            }
        }
        results
    }

    /// Clear a car from a specific node's manager (if it exists). Returns woken car IDs.
    pub fn clear_car(&mut self, node_id: EntityId, car_id: EntityId) -> Vec<EntityId> {
        if let Some(manager) = self.managers.get_mut(&node_id) {
            manager.clear(car_id)
        } else {
            Vec::new()
        }
    }

    pub fn remove_node(&mut self, node_id: EntityId) {
        self.managers.remove(&node_id);
    }
}
