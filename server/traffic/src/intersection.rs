use std::collections::VecDeque;
use fixed::HashMap;

use model::GameTime;
use model::EntityId;

use map::track::{Track, TRACK_POINTS};

pub type Dir = (i32, i32);

/// How near two cars' tracks may come before they are in each other's
/// way: a car's width, and a little.
const CLEAR: f32 = 0.15;
/// Half a car's length.
const HALF_BODY: f32 = 0.145;

/// What a party asks of a junction: its way through, and when it means
/// to be there.
#[derive(Clone, Copy)]
pub struct Claim {
    pub from: Dir,
    pub to: Dir,
    /// Its way through, in its lanes.
    pub track: Track,
    /// Coming in on a priority road: it goes before anyone on a minor one.
    pub major: bool,
    /// When it comes to the line; and at each point of its track, when its
    /// nose comes to it, and when its tail is past it, going as it can.
    /// Waiting at another junction first, it cannot say when it will be
    /// past anything: its tails are never.
    pub due: GameTime,
    pub nose: [GameTime; TRACK_POINTS],
    pub tail: [GameTime; TRACK_POINTS],
    /// Too near its line to stop short of it: whatever it holds, it keeps.
    pub committed: bool,
    /// The one ahead of it in its lane: through the junction before it.
    pub after: Option<EntityId>,
}

#[derive(Clone, Copy)]
struct QueueEntry {
    car_id: EntityId,
    /// What it said when it last looked.
    claim: Claim,
    /// When it came to its line, if it has: first come, first served, and
    /// how long it has waited there.
    arrived: GameTime,
    /// When it was granted passage; meaningless while it waits.
    since: GameTime,
}

impl QueueEntry {
    /// Its claim slid on by however late it is: one not past its line when
    /// it said it would be comes now, and is clear that much later.
    fn late(&self, now: GameTime) -> GameTime {
        now.saturating_sub(self.claim.due)
    }
    fn due(&self, now: GameTime) -> GameTime {
        self.claim.due.saturating_add(self.late(now))
    }
    fn nose(&self, i: usize, now: GameTime) -> GameTime {
        self.claim.nose[i].saturating_add(self.late(now))
    }
    fn tail(&self, i: usize, now: GameTime) -> GameTime {
        self.claim.tail[i].saturating_add(self.late(now))
    }
    /// It cannot say when it will be out, waiting at another junction
    /// first: those it would hold up see it coming, but it is not let
    /// through.
    fn waits(&self) -> bool {
        self.claim.tail[0] == GameTime::MAX && !self.claim.committed
    }
}

/// How far ahead of its line a car may hold a junction: claimed further
/// off, it would hold it against everyone crossing for longer than it
/// takes to come.
pub const HOLD: GameTime = 3_000;
/// What two ways across each other keep between one's tail out of where
/// they meet and the other's nose into it: each says when it will be there
/// going as fast as it may, and may be slower.
const SPARE: GameTime = 1_000;
/// How two ways through a junction meet: not at all; across each other,
/// over a stretch of each track (from the point its nose comes into the
/// other's way, to the one its tail is out of it at); or into one lane.
enum Meet {
    Apart,
    Cross([usize; 2], [usize; 2]),
    Merge,
}

/// A junction's traffic lights: its arms in phases, each green in turn.
///
/// Phases are found, not set: arms straight across from each other are
/// green together, any other alone. Within a green phase the junction is
/// as it is without lights, first come first served by the rule, so a
/// left turn waits for the oncoming. The lights are adaptive: a phase
/// holds while its cars come, and ends after `MIN_GREEN` once another has
/// cars waiting and none has come to its own for `GAP`, or at `MAX_GREEN`
/// whatever; then
/// all red until the junction is clear (`CLEAR_MS` at most), and the next
/// phase with cars waiting is green.
#[derive(Clone, Debug)]
pub struct Signal {
    pub phases: Vec<Vec<Dir>>,
    pub phase: usize,
    since: GameTime,
    clearing: bool,
    /// When a car last came to the green: the green holds while they keep
    /// coming.
    last: GameTime,
}

impl Signal {
    /// All red, between phases.
    pub fn clearing(&self) -> bool {
        self.clearing
    }
}

pub const MIN_GREEN: GameTime = 5_000;
/// How long a green waits for its next car before it gives way.
pub const GAP: GameTime = 3_500;
pub const MAX_GREEN: GameTime = 18_000;
pub const CLEAR_MS: GameTime = 3_000;
/// How often a light with traffic at it looks again.
pub const SIGNAL_TICK: GameTime = 1_000;

/// The phases of a junction with these arms: each with the one straight
/// across from it, if there is one; else alone.
pub fn phases_of(arms: &[Dir]) -> Vec<Vec<Dir>> {
    let mut left: Vec<Dir> = arms.to_vec();
    left.sort_unstable();
    let mut phases = Vec::new();
    while let Some(a) = left.first().copied() {
        left.remove(0);
        let mut phase = vec![a];
        if let Some(i) = left.iter().position(|&b| b == (-a.0, -a.1)) {
            phase.push(left.remove(i));
        }
        phases.push(phase);
    }
    phases
}

/// A junction's right of way. Everyone coming says when it will be there
/// (`Claim`) and queues; those let through hold it, against anyone whose
/// way crosses theirs, until they are through (`passing`).
///
/// One rule says who goes: a party goes when nobody crossing it is
/// through, and nobody it must let go first is due before it would be
/// clear. It lets go first one on a priority road, if it is not on one
/// itself, and among equals whoever is due first. So a side road takes a
/// gap it can clear, a merge is a crossing whose ways meet at its end,
/// and where nobody has priority it is first come, first served. One let
/// through that can still stop gives way, by the same rule, to one that
/// comes after it.
pub struct IntersectionManager {
    queue: VecDeque<QueueEntry>,
    passing: Vec<QueueEntry>,
    /// Its lights, if it has them.
    signal: Option<Signal>,
}

impl IntersectionManager {
    pub fn new() -> Self {
        Self { queue: VecDeque::new(), passing: Vec::new(), signal: None }
    }

    /// Say when a party will be at the junction, the first time or again
    /// as it comes. Whoever that lets through, itself among them, or whose
    /// claim it now comes before, so it may look again.
    pub fn claim(&mut self, car_id: EntityId, claim: Claim, now: GameTime) -> Vec<EntityId> {
        let mut woken = Vec::new();
        // At its line, it came when it first got there: one waiting there
        // keeps its place among those coming.
        let update = |e: &mut QueueEntry| {
            e.arrived = if claim.due <= now { e.arrived.min(claim.due) } else { claim.due };
            e.claim = claim;
        };
        if let Some(e) = self.queue.iter_mut().find(|e| e.car_id == car_id) {
            update(e);
        } else if let Some(i) = self.passing.iter().position(|e| e.car_id == car_id) {
            let moved = self.passing[i].claim.track != claim.track;
            update(&mut self.passing[i]);
            // Not yet on its way, it gives way to whoever it must after all,
            // and waits for one let through before it that has fallen behind;
            // holds nothing it is no longer due at, as one stood in a queue
            // back from it would hold it against everyone crossing; and asks
            // again for a new way through, into another lane.
            let e = &self.passing[i];
            let held = self.passing.iter().any(|p| (p.since, p.car_id) < (e.since, e.car_id) && self.held_by(e, p, now));
            if !claim.committed && (moved || claim.due > now + HOLD || held || e.waits() || (self.signal.is_none() && self.queue.iter().any(|q| self.yields(e, q, now)))) {
                let mut e = self.passing.remove(i);
                e.since = now;
                self.queue.push_back(e);
            }
        } else {
            self.queue.push_back(QueueEntry { car_id, claim, arrived: claim.due, since: now });
        }
        // Waiting, and someone let through who can still stop must let it go
        // first, as it now comes: that one gives its passage back, and is
        // told. Not only when it first comes: then it may be far off yet.
        if self.signal.is_none()
            && let Some(q) = self.queue.iter().find(|e| e.car_id == car_id).copied()
        {
            let back: Vec<EntityId> = self.passing.iter().filter(|p| !p.claim.committed && self.yields(p, &q, now)).map(|p| p.car_id).collect();
            for &id in &back {
                let i = self.passing.iter().position(|p| p.car_id == id).unwrap();
                let mut e = self.passing.remove(i);
                e.since = now;
                self.queue.push_back(e);
            }
            woken.extend(back);
        }
        woken.extend(self.grant_passage(now));
        woken
    }

    /// Returns true if this car has been granted passage (is in the passing list).
    pub fn has_passage(&self, car_id: EntityId) -> bool {
        self.passing.iter().any(|e| e.car_id == car_id)
    }

    /// Would this claim be let through now, were it made: by the rule
    /// below, as though it were the only one asking.
    fn grantable(&self, car_id: EntityId, claim: Claim, now: GameTime) -> bool {
        if self.has_passage(car_id) {
            return true;
        }
        let arrived = self.queue.iter().find(|e| e.car_id == car_id).map_or(claim.due, |e| if claim.due <= now { e.arrived.min(claim.due) } else { claim.due });
        let e = QueueEntry { car_id, claim, arrived, since: now };
        if e.waits() || e.due(now) > now + HOLD || self.passing.iter().any(|p| self.held_by(&e, p, now)) {
            return false;
        }
        match &self.signal {
            Some(signal) => !signal.clearing && signal.phases.get(signal.phase).is_some_and(|g| g.contains(&claim.from)),
            None => !self.queue.iter().any(|q| q.car_id != car_id && self.yields(&e, q, now)),
        }
    }

    /// Let through whoever may go now (the rule above), each in turn as
    /// it comes first, and due within `HOLD`.
    fn grant_passage(&mut self, now: GameTime) -> Vec<EntityId> {
        let mut newly_granted = Vec::new();
        // At lights, only those at a green arm, in the order they came: the
        // lights are the priority.
        if let Some(signal) = &mut self.signal {
            if signal.clearing {
                return newly_granted;
            }
            let green = signal.phases.get(signal.phase).cloned().unwrap_or_default();
            while let Some(i) = self.queue.iter().position(|e| green.contains(&e.claim.from) && !e.waits() && e.due(now) <= now + HOLD) {
                let next = self.queue[i];
                if self.passing.iter().any(|p| self.held_by(&next, p, now)) {
                    break;
                }
                let mut entry = self.queue.remove(i).unwrap();
                entry.since = now;
                newly_granted.push(entry.car_id);
                self.passing.push(entry);
                // A car coming to the green: it holds while they come.
                if let Some(signal) = &mut self.signal {
                    signal.last = now;
                }
            }
            return newly_granted;
        }
        let mut order: Vec<QueueEntry> = self.queue.iter().copied().collect();
        order.sort_by_key(|e| self.first(e));
        for e in order {
            if e.waits() || e.due(now) > now + HOLD || self.queue.iter().any(|q| self.yields(&e, q, now)) || self.passing.iter().any(|p| self.held_by(&e, p, now)) {
                continue;
            }
            self.queue.retain(|q| q.car_id != e.car_id);
            self.passing.push(QueueEntry { since: now, ..e });
            newly_granted.push(e.car_id);
        }
        newly_granted
    }

    /// Must `e` let `q` go first: `q` is ahead of it in its lane; or their
    /// ways meet, `q` comes before it, and `q` would come into `e`'s way
    /// before `e` were past it: across, out the far side; merging, before
    /// `e` is in, so `q` would not follow it.
    fn yields(&self, e: &QueueEntry, q: &QueueEntry, now: GameTime) -> bool {
        e.claim.after == Some(q.car_id)
            || e.car_id != q.car_id
                && self.first(q) < self.first(e)
                // One waiting at another junction first, it goes before
                // only by priority: one waiting on a car that waits.
                && (!q.waits() || q.claim.major && !e.claim.major)
                && match self.meet(e, q) {
                    Meet::Apart => false,
                    Meet::Cross([_, i1], [j0, _]) => q.nose(j0, now) < e.tail(i1, now).saturating_add(SPARE),
                    Meet::Merge => q.due(now) < e.tail(0, now),
                }
    }

    /// Is `e` held up by `p`, through already: across its way, unless
    /// `p`'s tail will be past where their ways meet when `e`'s nose comes
    /// there, or, `e` at its line, `e` would be past before `p` can come
    /// (`nose` is the soonest it can); into its lane, until `p` is in, for
    /// `e` to follow it, when `e` comes to its line.
    fn held_by(&self, e: &QueueEntry, p: &QueueEntry, now: GameTime) -> bool {
        let at_line = e.claim.due <= now;
        match self.meet(e, p) {
            Meet::Apart => false,
            Meet::Cross([i0, i1], [j0, j1]) => e.nose(i0, now) < p.tail(j1, now).saturating_add(SPARE / 2) && !(at_line && e.tail(i1, now).saturating_add(SPARE) <= p.nose(j0, now)),
            Meet::Merge => e.due(now) < p.tail(0, now),
        }
    }

    /// Who comes first: one on a priority road, then whoever is due first,
    /// though none before the one ahead of it in its lane.
    fn first(&self, e: &QueueEntry) -> (bool, GameTime, EntityId) {
        let mut due = e.arrived;
        let mut ahead = e.claim.after;
        for _ in 0..self.queue.len() + self.passing.len() {
            let Some(a) = ahead.and_then(|a| self.queue.iter().chain(&self.passing).find(|o| o.car_id == a)) else { break };
            // After it, never with it: a tie went to the lower id, and a
            // car behind came first and was waited for by the one ahead.
            due = due.max(a.arrived.saturating_add(1));
            ahead = a.claim.after;
        }
        (!e.claim.major, due, e.car_id)
    }

    /// How two ways through meet: apart for two from one lane, which
    /// follow each other in (`Claim::after`), or that come no nearer than
    /// `CLEAR`, and merging for two out into one.
    fn meet(&self, a: &QueueEntry, b: &QueueEntry) -> Meet {
        let (x, y) = (&a.claim.track, &b.claim.track);
        match near(x, y) {
            _ if x[0] == y[0] => Meet::Apart,
            None => Meet::Apart,
            Some(_) if x[TRACK_POINTS - 1] == y[TRACK_POINTS - 1] => Meet::Merge,
            Some((i, j)) => Meet::Cross(i, j),
        }
    }

    /// Who else let through comes out into a car's lane from another way:
    /// it follows whichever of them is ahead of it.
    fn merging(&self, car_id: EntityId) -> Vec<EntityId> {
        let Some(e) = self.passing.iter().find(|e| e.car_id == car_id) else { return Vec::new() };
        self.passing.iter().filter(|p| p.car_id != car_id && matches!(self.meet(e, p), Meet::Merge)).map(|p| p.car_id).collect()
    }

    /// Lights at this junction, with these arms; or none. Lights already
    /// there keep their phase, if they still have it.
    pub fn set_signal(&mut self, arms: Option<&[Dir]>, now: GameTime) {
        match arms {
            None => self.signal = None,
            Some(arms) => {
                let phases = phases_of(arms);
                match &mut self.signal {
                    Some(s) if s.phases == phases => {}
                    _ => self.signal = Some(Signal { phases, phase: 0, since: now, clearing: false, last: now }),
                }
            }
        }
    }

    pub fn signal(&self) -> Option<&Signal> {
        self.signal.as_ref()
    }


    /// The lights look again: whether to end the green, or, all red and
    /// clear, which phase is green next. The cars that lets through, and
    /// when to look again (none while nobody is at the junction).
    pub fn tick(&mut self, now: GameTime) -> (Vec<EntityId>, Option<GameTime>) {
        let Some(signal) = &self.signal else { return (self.grant_passage(now), None) };
        let waiting = |phase: &Vec<Dir>| self.queue.iter().any(|e| phase.contains(&e.claim.from) && e.due(now) <= now + HOLD);
        let elapsed = now.saturating_sub(signal.since);
        let mut next = signal.clone();
        if signal.clearing {
            if self.passing.is_empty() || elapsed >= CLEAR_MS {
                let n = next.phases.len();
                next.phase = (1..=n).map(|k| (signal.phase + k) % n).find(|&p| waiting(&signal.phases[p])).unwrap_or((signal.phase + 1) % n);
                next.since = now;
                next.last = now;
                next.clearing = false;
            }
        } else {
            let others = signal.phases.iter().enumerate().any(|(i, p)| i != signal.phase && waiting(p));
            let mine = waiting(&signal.phases[signal.phase]) || now.saturating_sub(signal.last) < GAP;
            if others && ((elapsed >= MIN_GREEN && !mine) || elapsed >= MAX_GREEN) {
                next.clearing = true;
                next.since = now;
            }
        }
        self.signal = Some(next);
        let woken = self.grant_passage(now);
        let busy = !self.queue.is_empty() || !self.passing.is_empty();
        (woken, busy.then_some(SIGNAL_TICK))
    }

    /// A party gone from the junction, through it or not: out of passage
    /// and out of the queue, and whoever that lets through let through.
    /// Out of the queue too: a claim that lapsed while it stood in the box,
    /// and was never granted again before it left, would stand in the
    /// queue for a car that is gone.
    pub fn clear(&mut self, car_id: EntityId, now: GameTime) -> Vec<EntityId> {
        self.passing.retain(|e| e.car_id != car_id);
        self.queue.retain(|e| e.car_id != car_id);
        self.grant_passage(now)
    }
}

pub struct IntersectionRegistry {
    managers: HashMap<EntityId, IntersectionManager>,
    /// Where each car has a claim.
    held: HashMap<EntityId, Vec<EntityId>>,
}

impl IntersectionRegistry {
    pub fn new() -> Self {
        Self {
            managers: HashMap::default(),
            held: HashMap::default(),
        }
    }

    /// A car says when it will be at a junction (`IntersectionManager::claim`).
    pub fn claim(&mut self, node_id: EntityId, car_id: EntityId, claim: Claim, now: GameTime) -> Vec<EntityId> {
        let held = self.held.entry(car_id).or_default();
        if !held.contains(&node_id) {
            held.push(node_id);
        }
        self.get_or_create(node_id).claim(car_id, claim, now)
    }

    /// A car still asks for these junctions and no others: anything else
    /// it claimed, it no longer needs. Returns whoever that lets through.
    pub fn keep(&mut self, car_id: EntityId, nodes: &[EntityId], now: GameTime) -> Vec<EntityId> {
        let Some(held) = self.held.get_mut(&car_id) else { return Vec::new() };
        let gone: Vec<EntityId> = held.iter().copied().filter(|n| !nodes.contains(n)).collect();
        held.retain(|n| nodes.contains(n));
        gone.into_iter().flat_map(|n| self.clear_car(n, car_id, now)).collect()
    }

    pub fn get_or_create(&mut self, node_id: EntityId) -> &mut IntersectionManager {
        self.managers.entry(node_id).or_insert_with(IntersectionManager::new)
    }

    pub fn has_passage(&self, node_id: EntityId, car_id: EntityId) -> bool {
        self.managers.get(&node_id).is_some_and(|m| m.has_passage(car_id))
    }

    /// Would a car be let through a junction now, were it to claim it so
    /// (`IntersectionManager::grantable`): a box is claimed only whole.
    pub fn grantable(&self, node_id: EntityId, car_id: EntityId, claim: Claim, now: GameTime) -> bool {
        self.managers.get(&node_id).is_none_or(|m| m.grantable(car_id, claim, now))
    }

    /// Has a car said when it will be at this junction.
    pub fn knows(&self, node_id: EntityId, car_id: EntityId) -> bool {
        self.managers.get(&node_id).is_some_and(|m| m.queue.iter().chain(&m.passing).any(|e| e.car_id == car_id))
    }

    /// Whose ways through this junction a car's (`track`) meets, but for
    /// its own: everyone else coming, whose way comes near it, or, `into`
    /// only, goes out in its lane.
    pub fn meets(&self, node_id: EntityId, car_id: EntityId, track: &Track, into: bool) -> bool {
        let Some(m) = self.managers.get(&node_id) else { return false };
        m.queue.iter().chain(&m.passing).filter(|e| e.car_id != car_id).map(|e| e.claim.track).any(|t| t[0] != track[0] && if into { t[TRACK_POINTS - 1] == track[TRACK_POINTS - 1] } else { near(&t, track).is_some() })
    }

    /// Is anyone coming in by another arm than `from` to come out where a
    /// car's way (`track`) does.
    pub fn joins(&self, node_id: EntityId, car_id: EntityId, track: &Track, from: Dir) -> bool {
        let Some(m) = self.managers.get(&node_id) else { return false };
        m.queue.iter().chain(&m.passing).any(|e| e.car_id != car_id && e.claim.from != from && e.claim.track[TRACK_POINTS - 1] == track[TRACK_POINTS - 1])
    }

    /// Who else let through a junction comes out into a car's lane
    /// (`IntersectionManager::merging`).
    pub fn merging(&self, node_id: EntityId, car_id: EntityId) -> Vec<EntityId> {
        self.managers.get(&node_id).map_or_else(Vec::new, |m| m.merging(car_id))
    }

    /// Is anyone but this car waiting at this junction to come across its
    /// way (`track`): at its line by now, not on its way there still, some
    /// way off and held up perhaps in the very queue that would keep clear
    /// for it; and not one behind it in its lane, whose way begins on its
    /// own.
    pub fn waited_across(&self, node_id: EntityId, car_id: EntityId, track: &Track, now: GameTime) -> bool {
        let Some(m) = self.managers.get(&node_id) else { return false };
        let on = |p: [f32; 2]| track.windows(2).any(|w| between(p, p, w[0], w[1]) < CLEAR);
        m.queue.iter().filter(|e| e.car_id != car_id && e.claim.due <= now + HOLD).map(|e| e.claim.track).any(|t| !on(t[0]) && near(&t, track).is_some())
    }

    /// Where along its track a car waiting at a junction first comes into
    /// the way of anyone it waits for, let through or coming first: the
    /// point it stops short of. None if it waits for nobody's way.
    pub fn held_at(&self, node_id: EntityId, car_id: EntityId, now: GameTime) -> Option<usize> {
        let m = self.managers.get(&node_id)?;
        let e = m.queue.iter().find(|e| e.car_id == car_id)?;
        let mine = e.claim.track;
        m.passing
            .iter()
            .filter(|p| m.held_by(e, p, now))
            .chain(m.queue.iter().filter(|q| m.yields(e, q, now)))
            .filter_map(|o| near(&mine, &o.claim.track))
            .map(|(i, _)| i[0])
            .min()
    }

    /// Who is through a junction, and who waits at it, in order.
    pub fn who(&self, node_id: EntityId) -> (Vec<EntityId>, Vec<EntityId>) {
        self.managers.get(&node_id).map_or_else(Default::default, |m| (m.passing.iter().map(|e| e.car_id).collect(), m.queue.iter().map(|e| e.car_id).collect()))
    }

    /// Remove a car from all intersections. Returns list of (node, woken_car) pairs.
    pub fn remove_car_from_all(&mut self, car_id: EntityId, now: GameTime) -> Vec<(EntityId, EntityId)> {
        self.held.remove(&car_id);
        let mut at: Vec<EntityId> = self.managers.iter().filter(|(_, m)| m.queue.iter().chain(&m.passing).any(|e| e.car_id == car_id)).map(|(&n, _)| n).collect();
        at.sort_unstable();
        at.into_iter().flat_map(|n| self.managers.get_mut(&n).unwrap().clear(car_id, now).into_iter().map(move |woken| (n, woken))).collect()
    }

    /// Take a car out of one junction's queue and passage altogether
    /// (`IntersectionManager::clear`). Returns woken car IDs.
    pub fn clear_car(&mut self, node_id: EntityId, car_id: EntityId, now: GameTime) -> Vec<EntityId> {
        if let Some(manager) = self.managers.get_mut(&node_id) {
            manager.clear(car_id, now)
        } else {
            Vec::new()
        }
    }

}


/// Where two tracks come nearer than their cars' bodies let them
/// (`clear`): on each, from the first point of the first stretch that
/// does to the last point of the last.
fn near(a: &Track, b: &Track) -> Option<([usize; 2], [usize; 2])> {
    let (mut i, mut j) = ([usize::MAX, 0], [usize::MAX, 0]);
    for (k, p) in a.windows(2).enumerate() {
        for (l, q) in b.windows(2).enumerate() {
            if between(p[0], p[1], q[0], q[1]) < clear(p, q) {
                (i[0], i[1]) = (i[0].min(k), i[1].max(k + 1));
                (j[0], j[1]) = (j[0].min(l), j[1].max(l + 1));
            }
        }
    }
    (i[0] != usize::MAX).then_some((i, j))
}

/// How near two stretches of two cars' ways may come: side by side, a
/// car's width (`CLEAR`); turned across each other, more: seen square to
/// one, the other's body reaches out by its half length as it turns.
fn clear(p: &[[f32; 2]], q: &[[f32; 2]]) -> f32 {
    let (u, v) = ([p[1][0] - p[0][0], p[1][1] - p[0][1]], [q[1][0] - q[0][0], q[1][1] - q[0][1]]);
    let l = (u[0].hypot(u[1]) * v[0].hypot(v[1])).max(1e-9);
    let (sin, cos) = ((u[0] * v[1] - u[1] * v[0]).abs() / l, (u[0] * v[0] + u[1] * v[1]).abs() / l);
    CLEAR / 2.0 * (1.0 + cos) + HALF_BODY * sin
}

/// How near two segments come: none if they cross.
fn between(a: [f32; 2], b: [f32; 2], c: [f32; 2], d: [f32; 2]) -> f32 {
    let side = |p: [f32; 2], q: [f32; 2], r: [f32; 2]| (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    if side(a, b, c) * side(a, b, d) < 0.0 && side(c, d, a) * side(c, d, b) < 0.0 {
        return 0.0;
    }
    let to = |p: [f32; 2], a: [f32; 2], b: [f32; 2]| {
        let (ex, ey) = (b[0] - a[0], b[1] - a[1]);
        let t = (((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (ex * ex + ey * ey).max(1e-12)).clamp(0.0, 1.0);
        (p[0] - a[0] - ex * t).hypot(p[1] - a[1] - ey * t)
    };
    to(a, c, d).min(to(b, c, d)).min(to(c, a, b)).min(to(d, a, b))
}

#[cfg(test)]
mod tests {
    use super::near;
    use map::track::track;

    /// Ways through a junction at the origin, by the neighbours' steps and
    /// whether each road runs both ways (its lane on the right).
    fn way(from: (i32, i32), to: (i32, i32), two_way: bool) -> super::Track {
        let lane = if two_way { 0.11 } else { 0.0 };
        track([from.0 as f64, from.1 as f64], [0.0, 0.0], [to.0 as f64, to.1 as f64], lane, lane)
    }

    /// A car's claim: due at `due`, a second through, its tail half a
    /// second behind its nose.
    fn come(j: &mut super::IntersectionManager, car: u64, from: super::Dir, to: super::Dir, track: super::Track, major: bool, due: u64) {
        let nose = std::array::from_fn(|i| due + 1_000 * i as u64 / (super::TRACK_POINTS - 1) as u64);
        let tail = nose.map(|t| t + 500);
        j.claim(car, super::Claim { from, to, track, major, due, nose, tail, committed: false, after: None }, due);
    }

    /// Cars on two bends round opposite corners of one junction go at
    /// once; two crossing, one waits.
    #[test]
    fn cars_whose_ways_miss_go_at_once() {
        let (w, e, n, s) = ((-1, 0), (1, 0), (0, -1), (0, 1));
        let mut j = super::IntersectionManager::new();
        come(&mut j, 1, w, n, way(w, n, false), false, 0);
        come(&mut j, 2, s, e, way(s, e, false), false, 0);
        assert!(j.has_passage(1) && j.has_passage(2), "two bends wait for each other");
        let mut j = super::IntersectionManager::new();
        come(&mut j, 1, w, e, way(w, e, true), false, 0);
        come(&mut j, 2, s, n, way(s, n, true), false, 0);
        assert!(j.has_passage(1) && !j.has_passage(2), "two crossing go together");
    }

    /// Tracks cross where cars would, and pass where they would not.
    #[test]
    fn tracks_cross_where_cars_would() {
        let (w, e, n, s) = ((-1, 0), (1, 0), (0, -1), (0, 1));
        // Two one-ways each bending round its own corner of one tile.
        assert!(near(&way(w, n, false), &way(s, e, false)).is_none(), "two bends in opposite corners meet");
        // Straight across each other.
        assert!(near(&way(w, e, true), &way(s, n, true)).is_some(), "a crossroads does not cross");
        // Two ways of a road both ways, side by side.
        assert!(near(&way(w, e, true), &way(e, w, true)).is_none(), "a road's two lanes meet");
        // A left turn across the oncoming lane.
        assert!(near(&way(w, n, true), &way(e, w, true)).is_some(), "a left turn misses the oncoming");
        // Two right turns from opposite arms.
        assert!(near(&way(w, s, true), &way(e, n, true)).is_none(), "two right turns meet");
        // A diagonal past a one-way's bend, a body's width off it but
        // turned across it: the corners of the two cars would touch.
        assert!(near(&way((-1, 1), (1, -1), false), &way(n, w, false)).is_some(), "a diagonal misses the bend its car's corner sweeps");
    }

    use super::*;

    const W: Dir = (-1, 0);
    const E: Dir = (1, 0);
    const N: Dir = (0, -1);
    const S: Dir = (0, 1);

    /// A car on the priority road goes first, though it came second; the
    /// one on the side street waits until it is through. Without priority
    /// it is first come, first served.
    #[test]
    fn the_priority_road_goes_first() {
        let mut j = IntersectionManager::new();
        come(&mut j, 1, S, N, way(S, N, true), false, 0);
        assert!(j.has_passage(1), "alone, the side street goes");
        j.clear(1, 10);

        let mut j = IntersectionManager::new();
        // Both arrive while the junction is held, the side street first,
        // and both are bound west, so only one may go.
        come(&mut j, 9, N, S, way(N, S, true), true, 0);
        come(&mut j, 1, S, W, way(S, W, true), false, 1);
        come(&mut j, 2, E, W, way(E, W, true), true, 2);
        assert!(!j.has_passage(1) && !j.has_passage(2));
        assert_eq!(j.clear(9, 3), vec![2], "the priority road's car, not the side street's");
        assert_eq!(j.clear(2, 4), vec![1], "then the side street");

        let mut j = IntersectionManager::new();
        come(&mut j, 9, N, S, way(N, S, true), false, 0);
        come(&mut j, 1, S, W, way(S, W, true), false, 1);
        come(&mut j, 2, E, W, way(E, W, true), false, 2);
        assert_eq!(j.clear(9, 3), vec![1], "no priority: in the order they came");
    }

    /// Lights let one phase through, then, the other waiting and its own
    /// empty after the shortest green, all red, then the other.
    #[test]
    fn the_lights_take_turns() {
        let mut j = IntersectionManager::new();
        j.set_signal(Some(&[W, E, N, S]), 0);
        assert_eq!(j.signal().unwrap().phases.len(), 2, "east-west, and north-south");
        let green = j.signal().unwrap().phases[0].clone();
        let (go, stop) = if green.contains(&W) { (W, N) } else { (N, W) };
        let opposite = |d: Dir| (-d.0, -d.1);
        come(&mut j, 1, go, opposite(go), way(go, opposite(go), true), false, 0);
        come(&mut j, 2, stop, opposite(stop), way(stop, opposite(stop), true), false, 0);
        assert!(j.has_passage(1), "green");
        assert!(!j.has_passage(2), "red");
        j.clear(1, 1_000);
        assert!(j.tick(2_000).0.is_empty(), "the shortest green still runs");
        let mut t = 2_000;
        let mut through = Vec::new();
        while through.is_empty() && t < 20_000 {
            t += SIGNAL_TICK;
            through = j.tick(t).0;
        }
        assert_eq!(through, vec![2], "then the other phase");
        assert!(t >= MIN_GREEN, "not before the shortest green");
    }
}
