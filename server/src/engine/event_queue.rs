use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use crate::protocol::EntityId;
use crate::engine::GameTime;

/// An entity and the moment it next thinks.
struct Scheduled {
    time: GameTime,
    id: EntityId,
    /// Generation at time of scheduling; stale entries are skipped in pop_due.
    generation: u64,
}

// BinaryHeap is a max-heap, so we reverse the ordering to get min-first.
impl Ord for Scheduled {
    fn cmp(&self, other: &Self) -> Ordering {
        other.time.cmp(&self.time)
    }
}

impl PartialOrd for Scheduled {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Scheduled {
    fn eq(&self, other: &Self) -> bool {
        self.time == other.time
    }
}

impl Eq for Scheduled {}

struct DedupEntry {
    time: GameTime,
    generation: u64,
}

/// The things about to think, in the order they will think.
///
/// Each entity holds at most one pending wake-up. Scheduling an earlier one
/// pulls it forward — which is how a braking car makes the one behind
/// reconsider — and scheduling a later one is a no-op, so nothing has to check
/// what is already pending before asking for a wake.
pub struct EventQueue {
    heap: BinaryHeap<Scheduled>,
    now: GameTime,
    /// Current wake per entity: the scheduled time and generation.
    dedup: HashMap<EntityId, DedupEntry>,
    next_generation: u64,
}

impl EventQueue {
    pub fn new() -> Self {
        Self {
            heap: BinaryHeap::new(),
            now: 0,
            dedup: HashMap::new(),
            next_generation: 0,
        }
    }

    /// Update the current time.
    pub fn set_now(&mut self, now: GameTime) {
        self.now = now;
    }

    #[allow(dead_code)]
    pub fn now(&self) -> GameTime {
        self.now
    }

    /// Wake `id` in `delay` milliseconds — or sooner, if it was already going
    /// to wake before that.
    pub fn wake(&mut self, delay: u64, id: EntityId) {
        let fire_at = self.now + delay;

        let generation = self.next_generation;
        self.next_generation += 1;

        if let Some(existing) = self.dedup.get(&id)
            && existing.time <= fire_at
        {
            return;
        }
        self.dedup.insert(id, DedupEntry { time: fire_at, generation });
        self.heap.push(Scheduled { time: fire_at, id, generation });
    }

    /// The next entity due to think, if its time has come.
    /// Skips stale entries that were superseded by an earlier wake.
    pub fn pop_due(&mut self) -> Option<EntityId> {
        loop {
            if self.heap.peek().is_none_or(|s| s.time > self.now) {
                return None;
            }
            let scheduled = self.heap.pop().unwrap();
            match self.dedup.get(&scheduled.id) {
                // Superseded, or the entity was despawned — skip.
                Some(current) if current.generation != scheduled.generation => continue,
                None => continue,
                Some(_) => {
                    self.dedup.remove(&scheduled.id);
                    return Some(scheduled.id);
                }
            }
        }
    }

    /// Forget an entity's pending wake (e.g. on despawn). Any heap entry for
    /// it becomes stale and will be skipped.
    pub fn clear_dedup(&mut self, key: EntityId) {
        self.dedup.remove(&key);
    }
}
