use std::collections::HashMap;
use crate::protocol::EntityId;

/// Tracks which cars are on each directed segment.
/// Stores unordered sets — callers determine ordering by checking actual progress.
pub struct SegmentTracker {
    segments: HashMap<(EntityId, EntityId), Vec<EntityId>>,
}

impl SegmentTracker {
    pub fn new() -> Self {
        Self { segments: HashMap::new() }
    }

    pub fn insert(&mut self, from: EntityId, to: EntityId, car_id: EntityId) {
        self.segments.entry((from, to)).or_default().push(car_id);
    }

    pub fn remove(&mut self, from: EntityId, to: EntityId, car_id: EntityId) {
        if let Some(cars) = self.segments.get_mut(&(from, to)) {
            cars.retain(|&id| id != car_id);
        }
    }

    /// All car IDs on this directed segment (unordered).
    pub fn cars_on(&self, from: EntityId, to: EntityId) -> &[EntityId] {
        match self.segments.get(&(from, to)) {
            Some(cars) => cars,
            None => &[],
        }
    }

    pub fn clear(&mut self) {
        self.segments.clear();
    }
}
