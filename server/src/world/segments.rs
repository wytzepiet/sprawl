use std::collections::VecDeque;

use crate::protocol::EntityId;

pub struct Segment {
    /// Ordered nodes: [start_junction, ..intermediates.., end_junction]
    pub nodes: Vec<EntityId>,
    /// Total length (Euclidean sum, for A* cost).
    pub length: f64,
    /// Cars on this segment, ordered by entry time. Front = closest to exit.
    pub cars: VecDeque<EntityId>,
}

impl Segment {
    pub fn end_junction(&self) -> EntityId {
        *self.nodes.last().unwrap()
    }

    /// Find the position of a car in the deque. Returns index (0 = front/lead).
    pub fn car_position(&self, car_id: EntityId) -> Option<usize> {
        self.cars.iter().position(|&id| id == car_id)
    }

}
