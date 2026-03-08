use crate::event_queue::GameTime;
use crate::protocol::EntityId;
use std::collections::HashMap;

pub struct QueuedCar {
    pub car_id: EntityId,
    pub from_node: EntityId,
    pub to_node: EntityId,
    pub approach_dir: (f64, f64),
    #[allow(dead_code)]
    pub registered_at: GameTime,
}

/// If a car has been waiting longer than this, it gets priority over all non-starved waiters.
const STARVATION_TIMEOUT_MS: u64 = 5000;

/// Check if two paths conflict (same entry, same exit, or head-on).
fn paths_conflict(a: &QueuedCar, b: &QueuedCar) -> bool {
    a.from_node == b.from_node
        || a.to_node == b.to_node
        || a.from_node == b.to_node
        || a.to_node == b.from_node
}

pub struct IntersectionManager {
    /// Cars currently crossing. Block all conflicting newcomers unconditionally.
    pub active: Vec<QueuedCar>,
    /// Cars waiting to cross, priority-sorted. Front (index 0) = highest priority.
    pub queue: Vec<QueuedCar>,
}

impl IntersectionManager {
    pub fn new() -> Self {
        Self { active: Vec::new(), queue: Vec::new() }
    }

    /// Is this car already tracked (active or waiting)?
    pub fn contains(&self, car_id: EntityId) -> bool {
        self.active.iter().any(|c| c.car_id == car_id)
            || self.queue.iter().any(|c| c.car_id == car_id)
    }

    /// Is this car currently crossing?
    pub fn is_active(&self, car_id: EntityId) -> bool {
        self.active.iter().any(|c| c.car_id == car_id)
    }

    /// Insert a car into the waiting queue at the correct priority position.
    pub fn enqueue(&mut self, car: QueuedCar) {
        let mut pos = self.queue.len();
        while pos > 0 {
            let other = &self.queue[pos - 1];

            // Same direction → go behind it
            if other.from_node == car.from_node {
                break;
            }

            // Other is to my right → yield (other has priority)
            let cross = car.approach_dir.1 * other.approach_dir.0
                - car.approach_dir.0 * other.approach_dir.1;
            if cross > 1e-9 {
                break;
            }

            pos -= 1;
        }
        self.queue.insert(pos, car);
    }

    /// Can this car proceed? Active cars always can. Waiting cars can if no
    /// conflicting active car and no conflicting higher-priority waiter ahead.
    /// Starved cars (waiting > STARVATION_TIMEOUT_MS) ignore queue priority
    /// and are only blocked by active cars.
    pub fn can_go(&self, car_id: EntityId, now: GameTime, alive: impl Fn(EntityId) -> bool) -> bool {
        if self.is_active(car_id) {
            return true;
        }

        let me = match self.queue.iter().find(|c| c.car_id == car_id) {
            Some(c) => c,
            None => return false,
        };

        // Any conflicting active car blocks us (always, even if starved)
        for a in &self.active {
            if alive(a.car_id) && paths_conflict(me, a) {
                return false;
            }
        }

        // If we've been waiting too long, skip queue priority check
        let starved = now.saturating_sub(me.registered_at) >= STARVATION_TIMEOUT_MS;
        if starved {
            // Only blocked by other starved cars that registered before us
            for entry in &self.queue {
                if entry.car_id == car_id {
                    return true;
                }
                if !alive(entry.car_id) {
                    continue;
                }
                let entry_starved = now.saturating_sub(entry.registered_at) >= STARVATION_TIMEOUT_MS;
                if entry_starved && paths_conflict(me, entry) {
                    return false;
                }
            }
            return true;
        }

        // Normal priority check: any conflicting higher-priority waiter blocks us
        for entry in &self.queue {
            if entry.car_id == car_id {
                return true; // reached ourselves — no blocker
            }
            if !alive(entry.car_id) {
                continue;
            }
            if paths_conflict(me, entry) {
                return false;
            }
        }
        false // shouldn't reach here
    }

    /// Move car from waiting queue to active. Called when car enters the intersection.
    pub fn activate(&mut self, car_id: EntityId) {
        if self.is_active(car_id) {
            return;
        }
        if let Some(pos) = self.queue.iter().position(|c| c.car_id == car_id) {
            self.active.push(self.queue.remove(pos));
        }
    }

    /// Remove car entirely (cleared the intersection or despawned).
    pub fn remove(&mut self, car_id: EntityId) {
        self.active.retain(|c| c.car_id != car_id);
        self.queue.retain(|c| c.car_id != car_id);
    }

    /// All waiting car IDs that can currently proceed.
    pub fn cars_that_can_go(&self, now: GameTime, alive: impl Fn(EntityId) -> bool) -> Vec<EntityId> {
        let mut result = Vec::new();
        for entry in &self.queue {
            if self.can_go(entry.car_id, now, &alive) {
                result.push(entry.car_id);
            }
        }
        result
    }
}

pub struct IntersectionRegistry {
    pub managers: HashMap<EntityId, IntersectionManager>,
}

impl IntersectionRegistry {
    pub fn new() -> Self {
        Self { managers: HashMap::new() }
    }

    pub fn ensure_manager(&mut self, node_id: EntityId) {
        self.managers.entry(node_id).or_insert_with(IntersectionManager::new);
    }

    pub fn remove_manager(&mut self, node_id: EntityId) {
        self.managers.remove(&node_id);
    }

    pub fn register_car(
        &mut self,
        node_id: EntityId,
        car_id: EntityId,
        from_node: EntityId,
        to_node: EntityId,
        approach_dir: (f64, f64),
        now: GameTime,
    ) {
        if let Some(mgr) = self.managers.get_mut(&node_id) {
            if mgr.contains(car_id) {
                return;
            }
            mgr.enqueue(QueuedCar {
                car_id,
                from_node,
                to_node,
                approach_dir,
                registered_at: now,
            });
        }
    }

    pub fn activate_car(&mut self, node_id: EntityId, car_id: EntityId) {
        if let Some(mgr) = self.managers.get_mut(&node_id) {
            mgr.activate(car_id);
        }
    }

    pub fn clear_car(&mut self, car_id: EntityId, node_id: EntityId) {
        if let Some(mgr) = self.managers.get_mut(&node_id) {
            mgr.remove(car_id);
        }
    }

    /// Should this car stop? Returns false if the car can proceed (or isn't registered).
    pub fn should_stop(&self, node_id: EntityId, car_id: EntityId, now: GameTime, alive: impl Fn(EntityId) -> bool) -> bool {
        match self.managers.get(&node_id) {
            Some(mgr) => !mgr.can_go(car_id, now, alive),
            None => false,
        }
    }

    pub fn clear(&mut self) {
        self.managers.clear();
    }
}
