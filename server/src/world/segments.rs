use std::collections::VecDeque;

use crate::protocol::EntityId;

/// The cars on one directed edge, a queue a lane. A car changing lanes
/// stands in both for as long as it takes (`car::simulation`'s shifts), so
/// whoever follows in either sees it.
pub struct EdgeSegment {
    /// How many lanes it has, its way: one, or two (`RoadNode::wide`).
    pub lanes: u8,
    /// Each lane's cars, ordered by entry time. Front = closest to exit.
    queues: [VecDeque<EntityId>; 2],
}

impl EdgeSegment {
    pub fn new(lanes: u8) -> Self {
        Self { lanes: lanes.clamp(1, 2), queues: [VecDeque::new(), VecDeque::new()] }
    }

    /// Which lane a car is in, and where in it (0 = front/lead).
    fn find(&self, car_id: EntityId) -> Option<(usize, usize)> {
        self.queues.iter().enumerate().find_map(|(lane, q)| Some((lane, q.iter().position(|&id| id == car_id)?)))
    }

    /// Where a car is in its lane's queue (0 = front/lead).
    pub fn car_position(&self, car_id: EntityId) -> Option<usize> {
        self.find(car_id).map(|(_, i)| i)
    }

    #[cfg(test)]
    pub fn lane_of(&self, car_id: EntityId) -> Option<usize> {
        self.find(car_id).map(|(lane, _)| lane)
    }

    pub fn contains(&self, car_id: EntityId) -> bool {
        self.find(car_id).is_some()
    }

    /// Each lane a car stands in, and where in it.
    fn places(&self, car_id: EntityId) -> impl Iterator<Item = (usize, usize)> + '_ {
        self.queues.iter().enumerate().filter_map(move |(lane, q)| Some((lane, q.iter().position(|&id| id == car_id)?)))
    }

    /// The car ahead of this one in each lane it stands in.
    pub fn ahead(&self, car_id: EntityId) -> Vec<EntityId> {
        self.ahead_but(car_id, |_, _| false)
    }

    /// The nearest car ahead of this one in each lane it stands in, past
    /// any it is told to look past in that lane.
    pub fn ahead_but(&self, car_id: EntityId, past: impl Fn(usize, EntityId) -> bool) -> Vec<EntityId> {
        self.places(car_id).filter_map(|(lane, i)| self.queues[lane].iter().take(i).rev().copied().find(|&o| !past(lane, o))).collect()
    }

    /// The car behind this one in each lane it stands in.
    pub fn behind(&self, car_id: EntityId) -> Vec<EntityId> {
        self.places(car_id).filter_map(|(lane, i)| self.queues[lane].get(i + 1).copied()).collect()
    }

    /// The cars in one lane, the front first.
    pub fn lane(&self, lane: usize) -> impl Iterator<Item = EntityId> + '_ {
        self.queues[lane.min(1)].iter().copied()
    }

    pub fn in_lane(&self, car_id: EntityId, lane: usize) -> bool {
        self.queues[lane.min(1)].contains(&car_id)
    }

    /// Out of one lane, and still in any other it stands in.
    pub fn leave_lane(&mut self, car_id: EntityId, lane: usize) {
        self.queues[lane.min(1)].retain(|&id| id != car_id);
    }

    /// The last car into a lane.
    pub fn back(&self, lane: usize) -> Option<EntityId> {
        self.queues[lane.min(1)].back().copied()
    }

    /// The first car of each lane.
    pub fn fronts(&self) -> impl Iterator<Item = EntityId> + '_ {
        self.queues.iter().filter_map(|q| q.front().copied())
    }

    /// Every car on it, lane by lane.
    pub fn all(&self) -> impl Iterator<Item = EntityId> + '_ {
        self.queues.iter().flatten().copied()
    }

    pub fn push_back(&mut self, car_id: EntityId, lane: usize) {
        self.queues[lane.min(self.lanes as usize - 1)].push_back(car_id);
    }

    /// Into a lane ahead of the first car in it that `behind` says is
    /// behind it; at the back, if none is.
    pub fn insert_before(&mut self, car_id: EntityId, lane: usize, behind: impl Fn(EntityId) -> bool) {
        let q = &mut self.queues[lane.min(self.lanes as usize - 1)];
        let i = q.iter().position(|&o| behind(o)).unwrap_or(q.len());
        q.insert(i, car_id);
    }

    pub fn remove(&mut self, car_id: EntityId) {
        for q in &mut self.queues {
            q.retain(|&id| id != car_id);
        }
    }
}
