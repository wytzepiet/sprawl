use std::collections::HashMap;

use crate::event_queue::GameTime;
use crate::protocol::EntityId;

pub struct ApproachingCar {
    pub car_id: EntityId,
    #[allow(dead_code)]
    pub from_node: EntityId,
    pub approach_dir: (f64, f64), // normalized direction into intersection
    pub registered_at: GameTime,
}

pub struct IntersectionManager {
    #[allow(dead_code)]
    pub node_id: EntityId,
    pub approaching: HashMap<EntityId, ApproachingCar>, // keyed by car_id
    pub active_car: Option<EntityId>,
}

impl IntersectionManager {
    pub fn new(node_id: EntityId) -> Self {
        Self {
            node_id,
            approaching: HashMap::new(),
            active_car: None,
        }
    }

    /// Pick the next car to go using priority-from-the-right + FIFO tiebreaker.
    /// Returns None if no cars are waiting or one is already active.
    pub fn evaluate(&self) -> Option<EntityId> {
        if self.active_car.is_some() {
            return None;
        }
        if self.approaching.is_empty() {
            return None;
        }
        if self.approaching.len() == 1 {
            return self.approaching.values().next().map(|c| c.car_id);
        }

        let cars: Vec<&ApproachingCar> = self.approaching.values().collect();

        // For each car, check if any other car has priority over it (is to its right).
        // A car with no one having priority over it wins. FIFO breaks ties.
        let mut best: Option<&ApproachingCar> = None;

        'outer: for candidate in &cars {
            // Check if any other car has priority over this candidate
            let mut has_priority_car = false;
            for other in &cars {
                if other.car_id == candidate.car_id {
                    continue;
                }
                // "other" is to the right of "candidate" if cross product > 0
                // cross = candidate.dy * other.dx - candidate.dx * other.dy
                let cross = candidate.approach_dir.1 * other.approach_dir.0
                    - candidate.approach_dir.0 * other.approach_dir.1;
                if cross > 1e-9 {
                    has_priority_car = true;
                    break;
                }
            }
            if !has_priority_car {
                match best {
                    None => best = Some(candidate),
                    Some(prev) => {
                        if candidate.registered_at < prev.registered_at {
                            best = Some(candidate);
                        }
                    }
                }
                continue 'outer;
            }
        }

        // If no car has clear priority (deadlock — everyone has someone to their right),
        // fall back to pure FIFO.
        if best.is_none() {
            best = cars
                .iter()
                .min_by_key(|c| c.registered_at)
                .copied();
        }

        best.map(|c| c.car_id)
    }
}

pub struct IntersectionRegistry {
    pub managers: HashMap<EntityId, IntersectionManager>, // keyed by node_id
}

impl IntersectionRegistry {
    pub fn new() -> Self {
        Self {
            managers: HashMap::new(),
        }
    }

    pub fn ensure_manager(&mut self, node_id: EntityId) {
        self.managers
            .entry(node_id)
            .or_insert_with(|| IntersectionManager::new(node_id));
    }

    pub fn remove_manager(&mut self, node_id: EntityId) {
        self.managers.remove(&node_id);
    }

    pub fn register_car(
        &mut self,
        node_id: EntityId,
        car_id: EntityId,
        from_node: EntityId,
        approach_dir: (f64, f64),
        now: GameTime,
    ) {
        if let Some(mgr) = self.managers.get_mut(&node_id) {
            mgr.approaching.insert(
                car_id,
                ApproachingCar {
                    car_id,
                    from_node,
                    approach_dir,
                    registered_at: now,
                },
            );
        }
    }

    pub fn clear_active(&mut self, node_id: EntityId) {
        if let Some(mgr) = self.managers.get_mut(&node_id) {
            mgr.active_car = None;
        }
    }

    pub fn remove_car(&mut self, car_id: EntityId, node_id: EntityId) {
        if let Some(mgr) = self.managers.get_mut(&node_id) {
            mgr.approaching.remove(&car_id);
            if mgr.active_car == Some(car_id) {
                mgr.active_car = None;
            }
        }
    }

    pub fn clear(&mut self) {
        self.managers.clear();
    }
}
