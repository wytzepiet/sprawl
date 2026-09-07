use crate::car::spawn::start_trip;
use crate::car::CRUISE_SPEED;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::blueprint::blueprint;
use crate::needs::{Bucket, Need, Tap};
use crate::protocol::{BuildingKind, ChunkCoord, EntityId, GameObject, Resident, DAY_MS};
use crate::world::World;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;

/// Real roads bend; the crow does not. Straight-line travel time is scaled up
/// by this before promising to be anywhere. Being systematically a little
/// early beats being systematically late for reasons that are nobody's fault.
const DETOUR: f64 = 1.4;

/// How long to sit on a failed departure — a blocked driveway, a severed road —
/// before looking again.
const RETRY_MS: u64 = 10_000;

/// How many arrivals it takes for the learned delay to mostly forget the
/// old ones.
const DELAY_MEMORY: f64 = 16.0;

/// Who is at, or on their way to, each building for each need. Counted
/// fresh at every wake from what residents are doing — a claim is being
/// present or being en route, so there is nothing to release.
type Crowd = HashMap<(EntityId, Need), u32>;

/// One resident thinking, as docs/residents.md specifies. Reads the clock and
/// the world, brings what they owe up to date, scores every place that could
/// serve any of it, and either goes to the best one or stays — scheduling
/// the earliest moment that answer could change. Carries no memory of why it
/// was woken: any wake, at any time, converges on the same behaviour.
pub fn handle_resident_wake(
    world: &mut World,
    events: &mut EventQueue,
    id: EntityId,
    now: GameTime,
) {
    let Some(r) = resident(world, id).cloned() else { return };

    // Off-map: someone who has not driven in yet. They enter the way
    // everyone enters — by road, from beyond the frontier, car and all.
    let Some(mut at) = r.at else {
        let entry = position_of(world, r.home)
            .and_then(|(x, y)| world.entry_node_near(crate::protocol::GridCoord { x, y }));
        let started = match entry {
            Some(node) => start_trip(world, events, r.car, node, r.home, now, GameTime::MAX),
            None => false,
        };
        if !started {
            events.wake(RETRY_MS, id);
        }
        return;
    };

    // Riding: the trip's arrival is what wakes us next, not the clock.
    if matches!(world.objects.get(at).map(|e| &e.object), Some(GameObject::Car(_))) {
        return;
    }

    // Standing somewhere that no longer exists — a demolished workplace, a
    // save that outlived its car. Home is where you are when the world has
    // moved on; if home is gone too, settle is about to take us with it.
    if world.objects.get(at).is_none() {
        if world.objects.get(r.home).is_none() {
            return;
        }
        at = r.home;
    }

    let crowd = headcount(world);
    settle(world, id, at, now, &crowd);
    let Some(r) = resident(world, id).cloned() else { return };
    let verdicts = verdicts(world, &r, at, now, &crowd);

    // Actionable: can be set out for now, or is right here — where waiting
    // for it to open is the action. Waiting for somewhere else is not; that
    // time goes to the best thing that can be started, and the departure
    // becomes an alarm.
    let best = verdicts
        .iter()
        .enumerate()
        .filter_map(|(i, v)| match *v {
            Verdict::Go { score, departure, leave, building, .. }
                if departure == now || building == at =>
            {
                Some((i, score, departure, leave, building))
            }
            _ => None,
        })
        // Strictly better wins, so ties fall to the earlier bucket.
        .fold(None, |best: Option<(usize, f64, GameTime, GameTime, EntityId)>, o| match best {
            Some((_, s, ..)) if s >= o.1 => best,
            _ => Some(o),
        });

    // When could the answer change? When the choice is due to set out, or
    // runs out (it empties, or its tap closes); when another is due to set
    // out; or when a bucket left behind has grown enough to outrank the
    // choice.
    let score = best.map_or(0.0, |(_, s, ..)| s);
    let mut alarm = best.map_or(GameTime::MAX, |(_, _, d, l, _)| if d > now { d } else { l });
    for (i, v) in verdicts.iter().enumerate() {
        if Some(i) == best.map(|(b, ..)| b) {
            continue;
        }
        let b = &r.buckets[i];
        alarm = alarm.min(match *v {
            Verdict::Go { departure, .. } if departure > now => departure.min(overtake(b, v, score, now)),
            _ => overtake(b, v, score, now),
        });
    }

    let Some((i, _, departure, leave, there)) = best else {
        // Nothing to do anywhere, and nothing to wait for. Look again in a
        // while: a world with nothing on offer is the unmet-demand case, and
        // it is not this resident's to solve.
        set_selected(world, id, None, now);
        events.wake(RETRY_MS, id);
        return;
    };
    set_selected(world, id, Some(r.buckets[i].need), now);
    // Not yet time to set out, or already there: stay put. Staying restates
    // how long the car's spot is held.
    if at == there {
        world.restate(r.car, leave.saturating_add(crate::world::lots::SLACK));
    }
    if departure > now || at == there {
        events.wake(alarm.max(now) - now, id);
    } else if !drive(world, events, r.car, at, there, now, leave) {
        events.wake(RETRY_MS, id);
    }
}

/// One verdict per bucket: the best any of its candidates offers.
fn verdicts(world: &World, r: &Resident, at: EntityId, now: GameTime, crowd: &Crowd) -> Vec<Verdict> {
    r.buckets
        .iter()
        .map(|b| match b.need {
            Need::Work => r.work.map_or(Verdict::Nothing, |w| verdict_at(world, r, at, b, w, now, crowd)),
            Need::Rest | Need::Home => verdict_at(world, r, at, b, r.home, now, crowd),
            Need::Eat | Need::Leisure | Need::Fuel => search(world, r, at, b, now, crowd),
        })
        .collect()
}

/// The best one place offers a bucket, through any of its taps for the need.
fn verdict_at(
    world: &World,
    r: &Resident,
    at: EntityId,
    b: &Bucket,
    building: EntityId,
    now: GameTime,
    crowd: &Crowd,
) -> Verdict {
    // Everyone else there or on the way, plus this resident. The count is a
    // snapshot taken before anyone moved, so it can disagree with `mine`
    // about whether this resident is among them — take them out if they are
    // there to take out.
    let mine = (at == building && r.selected == Some(b.need)) as u32;
    let seen = crowd.get(&(building, b.need)).copied().unwrap_or(0);
    let company = seen.saturating_sub(mine) + 1;
    taps_of(world, building)
        .iter()
        .filter(|t| t.need == b.need)
        .map(|t| evaluate(world, r.car, at, building, t, b, now, company))
        .fold(Verdict::Nothing, Verdict::better)
}

/// The best of whatever is around: a search outward by chunk, nearest ring
/// first, which stops once nothing further out could beat the best score
/// found so far — `w * L / (tau + h + L / R)` bounds an option from its
/// distance alone (section 10) — or the surveyed world runs out. A verdict
/// is a bucket's own best, whatever the other buckets scored: the alarms
/// and the unmet count read it as such.
fn search(world: &World, r: &Resident, at: EntityId, b: &Bucket, now: GameTime, crowd: &Crowd) -> Verdict {
    let need = b.need;
    let (r_max, h) = need.bounds();
    // The most a visit can score is the whole level served at the best rate
    // any tap has, and no sooner than the drive there.
    let bound = b.level / need.cap() * b.level;
    let service = b.level / r_max;
    let Some(origin) = world.objects.get(at).and_then(|e| e.position) else {
        return Verdict::Nothing;
    };
    let here = crate::world::chunk_of(origin);
    let bounds = world.revealed_bounds;
    let reach = (here.cx - bounds.min_cx)
        .max(bounds.max_cx - here.cx)
        .max(here.cy - bounds.min_cy)
        .max(bounds.max_cy - here.cy)
        .max(0);
    let mut best = Verdict::Nothing;
    for ring in 0..=reach {
        // Nothing in this ring is nearer than its inner edge.
        let tiles = ((ring - 1) * crate::protocol::CHUNK_SIZE).max(0) as f64;
        let tau = tiles / CRUISE_SPEED * DETOUR * 1000.0;
        if let Verdict::Go { score, .. } = best
            && bound / (tau + h as f64 + service) <= score
        {
            break;
        }
        let mut found: Vec<(i32, EntityId)> = chunk_ring(here, ring)
            .flat_map(|c| world.buildings_in(c))
            // A home's kitchen is its residents' alone, and a place no road
            // reaches is not on offer.
            .filter(|&id| id == r.home || kind(world, id).is_some_and(|k| blueprint(k).homes == 0))
            .filter(|&id| world.road_node_for_building(id).is_some())
            // Empty shelves sell nothing.
            .filter(|&id| crate::calls::stocked(world, id))
            .filter(|&id| taps_of(world, id).iter().any(|t| t.need == need))
            .filter_map(|id| {
                let p = world.objects.get(id)?.position?;
                Some(((p.x - origin.x).abs().max((p.y - origin.y).abs()), id))
            })
            .collect();
        found.sort_unstable();
        for (_, id) in found {
            best = best.better(verdict_at(world, r, at, b, id, now, crowd));
        }
    }
    best
}

/// The chunks exactly `ring` steps out from `center`, in a fixed order.
fn chunk_ring(center: ChunkCoord, ring: i32) -> impl Iterator<Item = ChunkCoord> {
    let r = ring;
    (-r..=r).flat_map(move |dy| {
        (-r..=r).filter_map(move |dx| {
            (dx.abs() == r || dy.abs() == r)
                .then_some(ChunkCoord { cx: center.cx + dx, cy: center.cy + dy })
        })
    })
}

/// What one place offers one bucket.
#[derive(Clone, Copy, Serialize)]
#[serde(tag = "verdict")]
enum Verdict {
    /// How much, per unit of time from now until the visit is over; when to
    /// set out — now, or later so as to arrive as it opens; and when the
    /// visit would be over, the earlier of the bucket emptying and the tap
    /// closing.
    Go {
        score: f64,
        departure: GameTime,
        leave: GameTime,
        building: EntityId,
        /// Time from now until service, in ms: the wait, the journey, the
        /// overhead. What a fuller bucket cannot shorten.
        fixed: f64,
        rate: f64,
        /// How much of the level the visit would serve. Less than all of it
        /// means the tap closes first, and a fuller bucket scores no better.
        drained: f64,
    },
    Nothing,
}

impl Verdict {
    fn better(self, other: Verdict) -> Verdict {
        match (self, other) {
            (Verdict::Go { score: a, .. }, Verdict::Go { score: b, .. }) if b > a => other,
            (Verdict::Nothing, _) => other,
            _ => self,
        }
    }
}

/// Section 4.1: score one (bucket, tap) pair over the visit it would get,
/// counted from now — so a wait for the tap to open costs what it costs.
/// Nobody sets out early to wait somewhere else, but someone already there
/// is scored on waiting honestly, and does not go home for five minutes.
fn evaluate(
    world: &World,
    car: EntityId,
    at: EntityId,
    building: EntityId,
    tap: &Tap,
    bucket: &Bucket,
    now: GameTime,
    company: u32,
) -> Verdict {
    let tau = if at == building { 0 } else { travel_ms(world, at, building) };
    let h = tap.overhead;
    let rate = tap.serving(slots_at(world, building, tap), company);
    // The visit as the tap allows it; then, going there for it, as the lot
    // allows it: if no spot is clear for the whole visit from when the car
    // would arrive, the earliest gap is when to arrive instead, and the
    // visit is planned again from there. Waiting for a spot is waiting,
    // the same as waiting for the tap to open.
    let plan = |arrive: GameTime| -> Option<(GameTime, GameTime, f64, GameTime)> {
        let opening = tap.curve.next_nonzero(arrive + h)?;
        let departure = (opening - h - tau).max(now);
        let entry = departure + tau + h;
        let dry = tap.curve.next_zero(entry);
        let available = tap.curve.integral(entry, dry);
        if available <= 0.0 {
            return None;
        }
        let drained = if rate.is_finite() { bucket.level.min(rate * available) } else { bucket.level };
        // Less than a millisecond owed is nothing: the clock cannot tell.
        if drained < 1.0 {
            return None;
        }
        let leave = if rate.is_finite() {
            tap.curve.advance(entry, drained / rate).unwrap_or(dry as f64)
        } else {
            entry as f64
        };
        Some((departure, (leave.ceil() as GameTime).min(dry), drained, entry))
    };
    let Some(mut planned) = plan(now + tau) else { return Verdict::Nothing };
    if at != building && tap.need != Need::Work {
        let (_, leave, _, entry) = planned;
        if let Some(t) = world.spot_window(building, car, entry - h, leave.saturating_add(crate::world::lots::SLACK))
            && t > entry - h
        {
            // A lot held by cars that have not said when they leave frees
            // never, as far as anyone can plan: no visit, not a visit at
            // the end of time.
            if t == GameTime::MAX {
                return Verdict::Nothing;
            }
            planned = match plan(t) {
                Some(p) => p,
                None => return Verdict::Nothing,
            };
        }
    }
    let (departure, leave, drained, entry) = planned;
    let score = bucket.level / bucket.need.cap() * drained / (leave - now) as f64;
    Verdict::Go {
        score,
        departure,
        leave,
        building,
        fixed: (entry - now) as f64,
        rate,
        drained,
    }
}

/// Section 4.2: the earliest a bucket left behind could outrank the choice.
///
/// Its level grows linearly while it is not served, and its score with it:
/// `(L / cap) * L / (fixed + L / r)`, when the whole level would be served.
/// Setting that equal to the choice's score is a quadratic in `L`, so the
/// level it overtakes at is closed-form, and the time to reach it follows.
/// A bucket with no option at all is bounded by its ceiling instead. One
/// that cannot grow, would need more than its cap, or whose tap closes
/// before the level is served, never overtakes by level. One already past
/// the crossing is not overtaking anything by growing: it is waiting on its
/// departure, or on the world to offer it something, and those wake it. One
/// sitting exactly on it has tied and lost to an earlier bucket, and wins a
/// millisecond on.
fn overtake(b: &Bucket, v: &Verdict, score: f64, now: GameTime) -> GameTime {
    if b.need.fill() == 0.0 {
        return GameTime::MAX;
    }
    let cap = b.need.cap();
    let target = match *v {
        Verdict::Go { drained, .. } if drained < b.level => return GameTime::MAX,
        Verdict::Go { fixed, rate, .. } => {
            // L^2 / cap = score * (fixed + L / rate)
            let half_b = score * cap / rate / 2.0;
            let c = score * cap * fixed;
            half_b + (half_b * half_b + c).sqrt()
        }
        Verdict::Nothing => match b.need.level_for(score) {
            Some(level) => level,
            None => return GameTime::MAX,
        },
    };
    if target >= cap || target < b.level {
        return GameTime::MAX;
    }
    now + ((target - b.level) / b.need.fill()).ceil().max(1.0) as GameTime
}

/// Section 4.3: bring the buckets up to date. The one being served drains by
/// what its tap offered since the last look and accrues only for the part it
/// did not; every other one accrues the whole interval. A constant need is
/// constant: it neither drains nor accrues. A driven need accrues at the end
/// of a trip, in `drove`, and drains like any other.
fn settle(world: &mut World, id: EntityId, at: EntityId, now: GameTime, crowd: &Crowd) {
    let Some(r) = resident(world, id) else { return };
    let (last, selected) = (r.last_update, r.selected);
    let elapsed = (now - last) as f64;
    let serving: Option<(f64, f64)> = selected.and_then(|need| {
        let company = crowd.get(&(at, need)).copied().unwrap_or(0).max(1);
        taps_of(world, at)
            .iter()
            .find(|t| t.need == need)
            .map(|t| (t.serving(slots_at(world, at, t), company), t.curve.integral(last, now)))
    });
    // What the building put out is what it put out, whether or not the
    // bucket had room for it: a shift worked is labour received.
    if let (Some(need), Some((rate, served))) = (selected, serving)
        && served > 0.0
    {
        world.delivered.entry((at, need)).or_default().add(now / DAY_MS as u64, rate * served);
    }
    let Some(r) = resident_mut(world, id) else { return };
    for b in &mut r.buckets {
        if b.need.constant() {
            continue;
        }
        let (served, rate) = match serving {
            Some((rate, served)) if Some(b.need) == selected => (served, rate),
            _ => (0.0, 0.0),
        };
        let idle = elapsed - served;
        b.level = (b.level - rate * served + b.need.fill() * idle).clamp(0.0, b.need.cap());
    }
    r.last_update = now;
}

/// Who is where, for what: present and selected, or aboard a car bound
/// there. One pass over everyone.
fn headcount(world: &World) -> Crowd {
    let mut crowd = Crowd::new();
    for id in world.resident_ids() {
        let Some(r) = resident(world, id) else { continue };
        let (Some(at), Some(need)) = (r.at, r.selected) else { continue };
        let place = match world.objects.get(at).map(|e| &e.object) {
            Some(GameObject::Building(_)) => at,
            Some(GameObject::Car(c)) => match &c.trip {
                Some(t) => t.destination,
                None => continue,
            },
            _ => continue,
        };
        *crowd.entry((place, need)).or_default() += 1;
    }
    crowd
}

impl Tap {
    /// The rate each of `company` present is served at: full up to the
    /// slots, then shared.
    fn serving(&self, slots: u32, company: u32) -> f64 {
        self.rate * (slots as f64 / company.max(1) as f64).min(1.0)
    }
}

/// What a tap serves at once. At a building with a lot, a visitor's tap
/// serves as many as can park: the lot decides. Anywhere else, and for
/// the staff, the row's number.
fn slots_at(world: &World, building: EntityId, tap: &Tap) -> u32 {
    match world.spots_at(building) {
        Some(n) if tap.need != Need::Work => n,
        _ => tap.slots,
    }
}

/// Pull out of one building's driveway toward another's.
fn drive(
    world: &mut World,
    events: &mut EventQueue,
    car: EntityId,
    from_building: EntityId,
    dest_building: EntityId,
    now: GameTime,
    until: GameTime,
) -> bool {
    match world.road_node_for_building(from_building) {
        Some(node) => start_trip(world, events, car, node, dest_building, now, until),
        None => false,
    }
}

/// The readout the whole system exists for, printed as a trip ends: how the
/// arrival compares to the shift, and to the free-flow promise made at
/// departure. People leave on time under free-flow assumptions, so both
/// numbers worsening together is a direct measurement of congestion on the
/// roads they actually drove. The delay is learned from the street part
/// alone, from setting out to turning into the lot: a queue at a lot's
/// entrance is that lot's problem, not a slow street across town.
pub fn arrival_readout(
    world: &mut World,
    id: EntityId,
    destination: EntityId,
    eta: GameTime,
    street_promised: GameTime,
    departed: GameTime,
    entered_lot: GameTime,
    now: GameTime,
) {
    // Every arrival teaches the city how much slower than empty roads it
    // is running, and every departure estimate reads it.
    if street_promised > 0 {
        let street_took = if entered_lot > 0 { entered_lot } else { now }.saturating_sub(departed);
        let ratio = street_took as f64 / street_promised as f64;
        world.delay += (ratio - world.delay) / DELAY_MEMORY;
    }
    if let Some(r) = resident(world, id)
        && r.work == Some(destination)
        && let Some(open) = taps_of(world, destination)
            .iter()
            .find(|t| t.need == Need::Work)
            .and_then(|t| t.curve.next_nonzero(0))
    {
        let day = DAY_MS as i64;
        let mut diff = (time_of_day(now) as i64 - open as i64).rem_euclid(day);
        if diff > day / 2 {
            diff -= day;
        }
        let word = if diff > 0 { "late" } else { "early" };
        let lost = now.saturating_sub(eta) / 1000;
        println!(
            "commute: resident {id} at work {}s {word}, {lost}s lost to traffic",
            (diff / 1000).abs()
        );
    }
}

/// The arithmetic, made visible: what one resident owes, and what every
/// option scores right now. The model's failure mode is quiet, and this is
/// the only way to watch it think. Read-only — the buckets are shown as they
/// stood at the last wake, not settled.
pub fn inspect(world: &World, id: EntityId, now: GameTime) -> Value {
    let Some(r) = resident(world, id) else { return json!({ "error": "no such resident" }) };
    let Some(at) = r.at else { return json!({ "id": id, "at": null, "note": "off-map" }) };
    let crowd = headcount(world);
    let verdicts = verdicts(world, r, at, now, &crowd);
    json!({
        "id": id,
        "now": hhmm(now),
        "delay": world.delay,
        "at": at,
        "at_kind": whereabouts(world, at),
        "home": r.home,
        "work": r.work,
        "selected": r.selected,
        "last_update": hhmm(r.last_update),
        "buckets": r.buckets.iter().zip(&verdicts).map(|(b, v)| json!({
            "need": b.need,
            "owed_h": b.level / HOUR,
            "full": b.level / b.need.cap(),
            "option": v.describe(now),
        })).collect::<Vec<_>>(),
    })
}

/// Everyone, one line each: where they are and what they are doing.
pub fn inspect_all(world: &World, now: GameTime) -> Value {
    let mut rows: Vec<Value> = world
        .resident_ids()
        .into_iter()
        .filter_map(|id| resident(world, id).map(|r| (id, r)))
        .map(|(id, r)| json!({
            "id": id,
            "at": r.at,
            "at_kind": r.at.map(|a| whereabouts(world, a)),
            "selected": r.selected,
            "owed_h": r.buckets.iter().map(|b| (format!("{:?}", b.need), b.level / HOUR)).collect::<std::collections::BTreeMap<_, _>>(),
        }))
        .collect();
    rows.sort_by_key(|v| v["id"].as_u64());
    json!({ "now": hhmm(now), "residents": rows })
}

/// Who wants what they cannot get, by home chunk: how many, and how badly.
pub fn unmet(world: &World, now: GameTime) -> HashMap<(ChunkCoord, Need), (u32, f64)> {
    let crowd = headcount(world);
    let mut unmet: HashMap<(ChunkCoord, Need), (u32, f64)> = HashMap::new();
    for id in world.resident_ids() {
        let Some(r) = resident(world, id) else { continue };
        let Some(at) = r.at else { continue };
        let Some(home) = world.objects.get(r.home).and_then(|e| e.position) else { continue };
        let here = crate::world::chunk_of(home);
        for (b, v) in r.buckets.iter().zip(verdicts(world, r, at, now, &crowd)) {
            // Nothing on offer and something owed; an empty bucket wants
            // nothing. A job is wanted whether or not the shift is on.
            let wanting = matches!(v, Verdict::Nothing) && b.need.fill() > 0.0 && b.level >= 1.0;
            if wanting || b.need == Need::Work && r.work.is_none() {
                let e = unmet.entry((here, b.need)).or_default();
                e.0 += 1;
                e.1 += if b.need.fill() > 0.0 { b.level / b.need.cap() } else { 1.0 };
            }
        }
    }
    unmet
}

/// The city's unmet demand per need, summed. What the spawner reads.
pub fn pressure(world: &World, now: GameTime) -> HashMap<Need, f64> {
    let mut by_need = HashMap::new();
    for ((_, need), (_, p)) in unmet(world, now) {
        *by_need.entry(need).or_default() += p;
    }
    by_need
}

/// Section 6: the demand signal. Who cannot be served — a bucket with no
/// option at all, weighted by how full it is — summed by the chunk they
/// live in; and what every building delivered, today and yesterday. Both
/// derived on request: the first from the same verdicts a wake would
/// compute, the second from what settle has been counting.
pub fn demand(world: &World, now: GameTime) -> Value {
    let unmet = unmet(world, now);
    let mut unmet: Vec<Value> = unmet
        .into_iter()
        .map(|((c, need), (people, pressure))| {
            json!({ "chunk": [c.cx, c.cy], "need": need, "people": people, "pressure": pressure })
        })
        .collect();
    unmet.sort_by_key(|v| (v["chunk"].to_string(), v["need"].to_string()));

    let mut delivered: Vec<Value> = world
        .delivered
        .iter()
        .map(|(&(building, need), d)| {
            json!({
                "building": building,
                "kind": whereabouts(world, building),
                "need": need,
                "today_h": d.today / HOUR,
                "yesterday_h": d.yesterday / HOUR,
            })
        })
        .collect();
    delivered.sort_by_key(|v| (v["building"].as_u64(), v["need"].to_string()));
    json!({ "now": hhmm(now), "unmet": unmet, "delivered": delivered })
}

impl Verdict {
    fn describe(&self, now: GameTime) -> Value {
        match *self {
            Verdict::Go { score, departure, leave, building, rate, .. } => json!({
                "building": building,
                "rate": rate,
                "score": score,
                "departure": hhmm(departure),
                "wait_h": (departure - now) as f64 / HOUR,
                "leave": hhmm(leave),
            }),
            Verdict::Nothing => json!("nothing"),
        }
    }
}

/// What kind of place `at` is — a building by kind, or the car.
fn whereabouts(world: &World, at: EntityId) -> String {
    match world.objects.get(at).map(|e| &e.object) {
        Some(GameObject::Building(b)) => format!("{:?}", b.kind),
        Some(GameObject::Car(_)) => "Car".into(),
        _ => "gone".into(),
    }
}

const HOUR: f64 = (DAY_MS / 24) as f64;

/// Clock time, with the day in front when it is not today's.
fn hhmm(t: GameTime) -> String {
    let day = t / DAY_MS as u64;
    let tod = time_of_day(t) as f64 / HOUR;
    format!("d{day} {:02}:{:02}", tod as u32, ((tod % 1.0) * 60.0) as u32)
}

fn resident(world: &World, id: EntityId) -> Option<&Resident> {
    match world.objects.get(id)?.object {
        GameObject::Resident(ref r) => Some(r),
        _ => None,
    }
}

fn resident_mut(world: &mut World, id: EntityId) -> Option<&mut Resident> {
    match world.objects.get_mut(id)?.object {
        GameObject::Resident(ref mut r) => Some(r),
        _ => None,
    }
}

/// A trip's end: what it cost in fuel goes on the tank's bucket.
pub fn drove(world: &mut World, id: EntityId, tiles: f64) {
    if let Some(r) = resident_mut(world, id)
        && let Some(b) = r.buckets.iter_mut().find(|b| b.need == Need::Fuel)
    {
        b.level = (b.level + tiles * Need::per_tile()).min(Need::Fuel.cap());
    }
}

/// Step out somewhere. The time up to now was spent wherever they were —
/// in the car, served nothing — and is settled as such before the place
/// changes, or the drive would count as a visit.
pub fn set_at(world: &mut World, id: EntityId, place: EntityId, now: GameTime) {
    if let Some(from) = resident(world, id).and_then(|r| r.at) {
        let crowd = headcount(world);
        settle(world, id, from, now, &crowd);
    }
    world.xp.settle(now);
    if let Some(r) = resident_mut(world, id) {
        r.at = Some(place);
    }
    world.xp.streams = served(world);
}

fn set_selected(world: &mut World, id: EntityId, need: Option<Need>, now: GameTime) {
    world.xp.settle(now);
    if let Some(r) = resident_mut(world, id) {
        r.selected = need;
    }
    world.xp.streams = served(world);
}

/// Everyone being served right now, as the ledger counts them: standing in a
/// building, on a need it has a tap for, at the rate the company there
/// allows. Same arithmetic as `settle`, so the two agree on what a shift is
/// worth; the ledger just does not wait for it to end.
pub fn served(world: &World) -> Vec<(f64, &'static Tap)> {
    let crowd = headcount(world);
    world
        .resident_ids()
        .into_iter()
        .filter_map(|id| {
            let r = resident(world, id)?;
            let (at, need) = (r.at?, r.selected?);
            let tap = taps_of(world, at).iter().find(|t| t.need == need)?;
            let company = crowd.get(&(at, need)).copied().unwrap_or(0);
            Some((tap.serving(slots_at(world, at, tap), company), tap))
        })
        .collect()
}

fn kind(world: &World, building: EntityId) -> Option<BuildingKind> {
    match world.objects.get(building)?.object {
        GameObject::Building(ref b) => Some(b.kind),
        _ => None,
    }
}

fn taps_of(world: &World, building: EntityId) -> &'static [Tap] {
    kind(world, building).map_or(&[], |k| &blueprint(k).taps)
}

/// Straight-line travel time between two buildings in game milliseconds,
/// with the detour factor.
fn travel_ms(world: &World, from: EntityId, to: EntityId) -> GameTime {
    let dist = match (position_of(world, from), position_of(world, to)) {
        (Some(a), Some(b)) => (a.0 - b.0).abs().max((a.1 - b.1).abs()) as f64,
        _ => 0.0,
    };
    (dist / CRUISE_SPEED * DETOUR * world.delay * 1000.0) as GameTime
}

fn position_of(world: &World, id: EntityId) -> Option<(i32, i32)> {
    world.objects.get(id)?.position.map(|p| (p.x, p.y))
}

fn time_of_day(now: GameTime) -> u32 {
    (now % DAY_MS as u64) as u32
}
