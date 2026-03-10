use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use crate::protocol::EntityId;
use crate::engine::GameTime;

/// A scheduled event with a firing time.
pub struct Scheduled<E> {
    pub time: GameTime,
    pub event: E,
    dedup_key: Option<EntityId>,
    /// Generation at time of scheduling; stale entries are skipped in pop_due.
    generation: u64,
}

// BinaryHeap is a max-heap, so we reverse the ordering to get min-first.
impl<E> Ord for Scheduled<E> {
    fn cmp(&self, other: &Self) -> Ordering {
        other.time.cmp(&self.time)
    }
}

impl<E> PartialOrd for Scheduled<E> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl<E> PartialEq for Scheduled<E> {
    fn eq(&self, other: &Self) -> bool {
        self.time == other.time
    }
}

impl<E> Eq for Scheduled<E> {}

struct DedupEntry {
    time: GameTime,
    generation: u64,
}

/// A min-heap priority queue for discrete event simulation.
///
/// Generic over the event type. Supports optional dedup by EntityId key:
/// when a key is provided, only the earliest event for that key is kept.
/// Later-superseded entries stay in the heap but are skipped on pop.
pub struct EventQueue<E> {
    heap: BinaryHeap<Scheduled<E>>,
    now: GameTime,
    /// Current dedup state per key: the scheduled time and generation.
    dedup: HashMap<EntityId, DedupEntry>,
    next_generation: u64,
}

impl<E> EventQueue<E> {
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

    /// Schedule an event `delay` milliseconds from now.
    ///
    /// If `dedup_key` is provided:
    /// - If an earlier-or-equal event already exists for this key, this call is a no-op.
    /// - If this event is earlier, it replaces the old one (the old heap entry
    ///   becomes stale and will be skipped on pop).
    pub fn schedule(&mut self, delay: u64, event: E, dedup_key: Option<EntityId>) {
        let fire_at = self.now + delay;

        let generation = self.next_generation;
        self.next_generation += 1;

        if let Some(key) = dedup_key {
            if let Some(existing) = self.dedup.get(&key)
                && existing.time <= fire_at {
                    return;
                }
            self.dedup.insert(key, DedupEntry { time: fire_at, generation });
        }

        self.heap.push(Scheduled { time: fire_at, event, dedup_key, generation });
    }

    /// Pop and return the next event if its time <= `now`.
    /// Skips stale dedup entries that were superseded by a later schedule call.
    pub fn pop_due(&mut self) -> Option<Scheduled<E>> {
        loop {
            if self.heap.peek().is_none_or(|s| s.time > self.now) {
                return None;
            }
            let scheduled = self.heap.pop().unwrap();

            // Check if this entry is stale (superseded by a newer schedule for the same key).
            if let Some(key) = scheduled.dedup_key {
                if let Some(current) = self.dedup.get(&key) {
                    if current.generation != scheduled.generation {
                        // Stale entry — skip it.
                        continue;
                    }
                    // This is the current entry — clear the dedup tracking.
                    self.dedup.remove(&key);
                }
                // If no dedup entry exists (cleared by clear_dedup), skip too —
                // the entity was despawned.
                else {
                    continue;
                }
            }

            return Some(scheduled);
        }
    }

    /// Clear dedup tracking for a key (e.g. on entity despawn).
    /// Any pending heap entries for this key become stale and will be skipped.
    pub fn clear_dedup(&mut self, key: EntityId) {
        self.dedup.remove(&key);
    }

}
