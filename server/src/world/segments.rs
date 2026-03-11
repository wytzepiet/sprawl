use std::collections::VecDeque;

use crate::protocol::EntityId;

pub struct EdgeSegment {
    pub length: f64,
    /// Cars on this edge, ordered by entry time. Front = closest to exit.
    pub cars: VecDeque<EntityId>,
}

impl EdgeSegment {
    pub fn new(length: f64) -> Self {
        Self {
            length,
            cars: VecDeque::new(),
        }
    }

    /// Find the position of a car in the deque. Returns index (0 = front/lead).
    pub fn car_position(&self, car_id: EntityId) -> Option<usize> {
        self.cars.iter().position(|&id| id == car_id)
    }
}
