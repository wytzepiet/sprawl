use std::cmp::Ordering;
use std::collections::BinaryHeap;

/// Game time in milliseconds (monotonic, starts at 0).
pub type GameTime = u64;

/// A scheduled event with a firing time.
pub struct Scheduled<E> {
    pub time: GameTime,
    pub event: E,
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

/// A min-heap priority queue for discrete event simulation.
pub struct EventQueue<E> {
    heap: BinaryHeap<Scheduled<E>>,
    now: GameTime,
}

impl<E> EventQueue<E> {
    pub fn new() -> Self {
        Self {
            heap: BinaryHeap::new(),
            now: 0,
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
    pub fn schedule(&mut self, delay: u64, event: E) {
        self.heap.push(Scheduled { time: self.now + delay, event });
    }

    /// Pop and return the next event if its time <= `now`.
    pub fn pop_due(&mut self) -> Option<Scheduled<E>> {
        if self.heap.peek().is_some_and(|s| s.time <= self.now) {
            self.heap.pop()
        } else {
            None
        }
    }

    /// Drain all events, regardless of time. Useful for reset.
    pub fn clear(&mut self) {
        self.heap.clear();
    }
}
