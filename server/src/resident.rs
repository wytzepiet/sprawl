use crate::car::spawn::start_trip;
use crate::car::CRUISE_SPEED;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::needs::{taps, Bucket, Need, Tap};
use crate::protocol::{BuildingKind, EntityId, GameObject, Resident, DAY_MS};
use crate::world::World;
use serde::Serialize;
use serde_json::{json, Value};

/// Real roads bend; the crow does not. Straight-line travel time is scaled up
/// by this before promising to be anywhere. Being systematically a little
/// early beats being systematically late for reasons that are nobody's fault.
const DETOUR: f64 = 1.4;

/// How long to sit on a failed departure — a blocked driveway, a severed road —
/// before looking again.
const RETRY_MS: u64 = 10_000;

/// One resident thinking, as sprawl-needs.md specifies. Reads the clock and
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
            Some(node) => start_trip(world, events, r.car, node, r.home, now),
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

    settle(world, id, at, now);
    let Some(r) = resident(world, id).cloned() else { return };
    let verdicts = verdicts(world, &r, at, now);

    // Actionable: can be set out for now, or is right here — where waiting
    // for it to open is the action. Waiting for somewhere else is not; that
    // time goes to the best thing that can be started, and the departure
    // becomes an alarm.
    let best = verdicts
        .iter()
        .enumerate()
        .filter_map(|(i, v)| match *v {
            Verdict::Go { score, departure, leave }
                if departure == now || candidate(&r, r.buckets[i].need) == Some(at) =>
            {
                Some((i, score, departure, leave))
            }
            _ => None,
        })
        // Strictly better wins, so ties fall to the earlier bucket.
        .fold(None, |best: Option<(usize, f64, GameTime, GameTime)>, o| match best {
            Some((_, s, _, _)) if s >= o.1 => best,
            _ => Some(o),
        });

    // When could the answer change? When the choice is due to set out, or
    // runs out (it empties, or its tap closes); when another is due to set
    // out; or when a bucket left behind has grown enough to outrank the
    // choice.
    let score = best.map_or(0.0, |(_, s, _, _)| s);
    let mut alarm = best.map_or(GameTime::MAX, |(_, _, d, l)| if d > now { d } else { l });
    for (i, v) in verdicts.iter().enumerate() {
        if Some(i) == best.map(|(b, ..)| b) {
            continue;
        }
        let b = &r.buckets[i];
        alarm = alarm.min(match *v {
            Verdict::Go { score: own, departure, .. } if departure > now => {
                departure.min(overtake(b, own, score, now))
            }
            Verdict::Go { score: own, .. } => overtake(b, own, score, now),
            Verdict::Nothing => overtake(b, 0.0, score, now),
        });
    }

    let Some((i, _, departure, _)) = best else {
        // Nothing to do anywhere, and nothing to wait for. Look again in a
        // while: a world with nothing on offer is the unmet-demand case, and
        // it is not this resident's to solve.
        set_selected(world, id, None);
        events.wake(RETRY_MS, id);
        return;
    };
    let need = r.buckets[i].need;
    let there = candidate(&r, need).unwrap();
    set_selected(world, id, Some(need));
    // Not yet time to set out, or already there: stay put.
    if departure > now || at == there {
        events.wake(alarm.max(now) - now, id);
    } else if !drive(world, events, r.car, at, there, now) {
        events.wake(RETRY_MS, id);
    }
}

/// One verdict per bucket: the best its candidate offers.
fn verdicts(world: &World, r: &Resident, at: EntityId, now: GameTime) -> Vec<Verdict> {
    r.buckets
        .iter()
        .map(|b| {
            let Some(building) = candidate(r, b.need) else { return Verdict::Nothing };
            taps_of(world, building)
                .iter()
                .filter(|t| t.need == b.need)
                .map(|t| evaluate(world, at, building, t, b, now))
                .fold(Verdict::Nothing, Verdict::better)
        })
        .collect()
}

/// What one place offers one bucket.
#[derive(Clone, Copy, Serialize)]
#[serde(tag = "verdict")]
enum Verdict {
    /// How much, per unit of time from now until the visit is over; when to
    /// set out — now, or later so as to arrive as it opens; and when the
    /// visit would be over, the earlier of the bucket emptying and the tap
    /// closing.
    Go { score: f64, departure: GameTime, leave: GameTime },
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
    at: EntityId,
    building: EntityId,
    tap: &Tap,
    bucket: &Bucket,
    now: GameTime,
) -> Verdict {
    let tau = if at == building { 0 } else { travel_ms(world, at, building) };
    let h = tap.overhead;
    let Some(opening) = tap.curve.next_nonzero(now + tau + h) else {
        return Verdict::Nothing;
    };
    let departure = (opening - h - tau).max(now);
    let entry = departure + tau + h;
    let dry = tap.curve.next_zero(entry);
    let available = tap.curve.integral(entry, dry);
    if available <= 0.0 {
        return Verdict::Nothing;
    }
    let drained = if tap.rate.is_finite() {
        bucket.level.min(tap.rate * available)
    } else {
        bucket.level
    };
    // Less than a millisecond owed is nothing: the clock cannot tell.
    if drained < 1.0 {
        return Verdict::Nothing;
    }
    let leave = if tap.rate.is_finite() {
        tap.curve.advance(entry, drained / tap.rate).unwrap_or(dry as f64)
    } else {
        entry as f64
    };
    let score = bucket.level / bucket.need.cap() * drained / (leave - now as f64);
    Verdict::Go { score, departure, leave: (leave.ceil() as GameTime).min(dry) }
}

/// Section 4.2: the earliest a bucket left behind could outrank the choice.
///
/// Its ceiling grows with its level, and its actual score sits below the
/// ceiling by however much travel and waiting cost it. Taking that ratio as
/// fixed, it overtakes when the ceiling reaches `score / ratio`. The ratio
/// improves as the bucket fills, which makes this early; it also improves
/// as a wait shortens, which makes it late — by at most the wait, which the
/// departure term caps. A bucket that cannot grow, or has nothing to grow
/// toward, never overtakes by level.
fn overtake(b: &Bucket, own: f64, score: f64, now: GameTime) -> GameTime {
    if b.need.fill() == 0.0 {
        return GameTime::MAX;
    }
    let ceiling = b.need.ceiling(b.level);
    let ratio = if own > 0.0 && ceiling > 0.0 { own / ceiling } else { 1.0 };
    match b.need.level_for(score / ratio) {
        Some(level) if level > b.level => now + ((level - b.level) / b.need.fill()).ceil() as GameTime,
        // Already that full and still not winning: level is not what holds
        // it back, and whatever does has its own term.
        _ => GameTime::MAX,
    }
}

/// Section 4.3: bring the buckets up to date. The one being served drains by
/// what its tap offered since the last look and accrues only for the part it
/// did not; every other one accrues the whole interval. A constant need is
/// constant: it neither drains nor accrues.
fn settle(world: &mut World, id: EntityId, at: EntityId, now: GameTime) {
    let Some(r) = resident(world, id) else { return };
    let (last, selected) = (r.last_update, r.selected);
    let elapsed = (now - last) as f64;
    let serving: Option<(f64, f64)> = selected.and_then(|need| {
        taps_of(world, at)
            .iter()
            .find(|t| t.need == need)
            .map(|t| (t.rate, t.curve.integral(last, now)))
    });
    let Some(r) = resident_mut(world, id) else { return };
    for b in &mut r.buckets {
        if b.need.fill() == 0.0 {
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

/// Where a need could be met. One place each for now; a need served by many
/// buildings is a search, and comes with the first such need.
fn candidate(r: &Resident, need: Need) -> Option<EntityId> {
    match need {
        Need::Work => r.work,
        Need::Rest | Need::Home => Some(r.home),
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
) -> bool {
    match world.road_node_for_building(from_building) {
        Some(node) => start_trip(world, events, car, node, dest_building, now),
        None => false,
    }
}

/// The readout the whole system exists for, printed as a trip ends: how the
/// arrival compares to the shift, and to the free-flow promise made at
/// departure. People leave on time under free-flow assumptions, so both
/// numbers worsening together is a direct measurement of congestion on the
/// roads they actually drove.
pub fn arrival_readout(
    world: &World,
    id: EntityId,
    destination: EntityId,
    eta: GameTime,
    now: GameTime,
) {
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
    let verdicts = verdicts(world, r, at, now);
    json!({
        "id": id,
        "now": hhmm(now),
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
            "candidate": candidate(r, b.need),
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

impl Verdict {
    fn describe(&self, now: GameTime) -> Value {
        match *self {
            Verdict::Go { score, departure, leave } => json!({
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

pub fn set_at(world: &mut World, id: EntityId, place: EntityId) {
    if let Some(r) = resident_mut(world, id) {
        r.at = Some(place);
    }
}

fn set_selected(world: &mut World, id: EntityId, need: Option<Need>) {
    if let Some(r) = resident_mut(world, id) {
        r.selected = need;
    }
}

fn kind(world: &World, building: EntityId) -> Option<BuildingKind> {
    match world.objects.get(building)?.object {
        GameObject::Building(ref b) => Some(b.kind),
        _ => None,
    }
}

fn taps_of(world: &World, building: EntityId) -> &'static [Tap] {
    kind(world, building).map_or(&[], taps)
}

/// Straight-line travel time between two buildings in game milliseconds,
/// with the detour factor.
fn travel_ms(world: &World, from: EntityId, to: EntityId) -> GameTime {
    let dist = match (position_of(world, from), position_of(world, to)) {
        (Some(a), Some(b)) => (a.0 - b.0).abs().max((a.1 - b.1).abs()) as f64,
        _ => 0.0,
    };
    (dist / CRUISE_SPEED * DETOUR * 1000.0) as GameTime
}

fn position_of(world: &World, id: EntityId) -> Option<(i32, i32)> {
    world.objects.get(id)?.position.map(|p| (p.x, p.y))
}

fn time_of_day(now: GameTime) -> u32 {
    (now % DAY_MS as u64) as u32
}
