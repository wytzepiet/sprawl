use crate::car::spawn::start_trip;
use crate::car::CRUISE_SPEED;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::needs::{taps, Bucket, Need, Tap};
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

    let Some((i, _, departure, _, there)) = best else {
        // Nothing to do anywhere, and nothing to wait for. Look again in a
        // while: a world with nothing on offer is the unmet-demand case, and
        // it is not this resident's to solve.
        set_selected(world, id, None);
        events.wake(RETRY_MS, id);
        return;
    };
    set_selected(world, id, Some(r.buckets[i].need));
    // Not yet time to set out, or already there: stay put.
    if departure > now || at == there {
        events.wake(alarm.max(now) - now, id);
    } else if !drive(world, events, r.car, at, there, now) {
        events.wake(RETRY_MS, id);
    }
}

/// One verdict per bucket: the best any of its candidates offers.
fn verdicts(world: &World, r: &Resident, at: EntityId, now: GameTime, crowd: &Crowd) -> Vec<Verdict> {
    let mut floor = 0.0_f64;
    r.buckets
        .iter()
        .map(|b| {
            let v = candidates(world, r, at, b, floor)
                .flat_map(|building| {
                    // Everyone else there or on the way, plus this resident.
                    let mine = (at == building && r.selected == Some(b.need)) as u32;
                    let company = crowd.get(&(building, b.need)).copied().unwrap_or(0) - mine + 1;
                    taps_of(world, building)
                        .iter()
                        .filter(|t| t.need == b.need)
                        .map(move |t| evaluate(world, at, building, t, b, now, company))
                })
                .fold(Verdict::Nothing, Verdict::better);
            if let Verdict::Go { score, .. } = v {
                floor = floor.max(score);
            }
            v
        })
        .collect()
}

/// Where a bucket could be served, nearest first. A need with an assigned
/// place has one candidate. One served by whatever is around is a search
/// outward by chunk, which stops once nothing further out could beat the
/// best score already found — `w * L / (tau + h)` bounds an option from
/// its distance alone (section 10) — or the surveyed world runs out.
fn candidates<'a>(
    world: &'a World,
    r: &'a Resident,
    at: EntityId,
    b: &Bucket,
    floor: f64,
) -> Box<dyn Iterator<Item = EntityId> + 'a> {
    match b.need {
        Need::Work => Box::new(r.work.into_iter()),
        Need::Rest | Need::Home => Box::new(std::iter::once(r.home)),
        Need::Eat => {
            let need = b.need;
            let (_, h) = need.bounds();
            let bound = b.level / need.cap() * b.level;
            let Some(origin) = world.objects.get(at).and_then(|e| e.position) else {
                return Box::new(std::iter::empty());
            };
            let here = crate::world::chunk_of(origin);
            let bounds = world.revealed_bounds;
            let reach = (here.cx - bounds.min_cx)
                .max(bounds.max_cx - here.cx)
                .max(here.cy - bounds.min_cy)
                .max(bounds.max_cy - here.cy)
                .max(0);
            Box::new(
                (0..=reach)
                    .take_while(move |&ring| {
                        // Nothing in this ring is nearer than its inner edge.
                        let tiles = ((ring - 1) * crate::protocol::CHUNK_SIZE).max(0) as f64;
                        let tau = tiles / CRUISE_SPEED * DETOUR * 1000.0;
                        bound / (tau + h as f64) > floor
                    })
                    .flat_map(move |ring| {
                        let mut found: Vec<(i32, EntityId)> = chunk_ring(here, ring)
                            .flat_map(|c| world.buildings_in(c))
                            // A home's kitchen is its residents' alone.
                            .filter(|&id| id == r.home || kind(world, id).is_some_and(|k| k.homes() == 0))
                            .filter(|&id| taps_of(world, id).iter().any(|t| t.need == need))
                            .filter_map(|id| {
                                let p = world.objects.get(id)?.position?;
                                Some(((p.x - origin.x).abs().max((p.y - origin.y).abs()), id))
                            })
                            .collect();
                        found.sort_unstable();
                        found.into_iter().map(|(_, id)| id)
                    }),
            )
        }
    }
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
    at: EntityId,
    building: EntityId,
    tap: &Tap,
    bucket: &Bucket,
    now: GameTime,
    company: u32,
) -> Verdict {
    let tau = if at == building { 0 } else { travel_ms(world, at, building) };
    let h = tap.overhead;
    let rate = tap.serving(company);
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
    let drained = if rate.is_finite() { bucket.level.min(rate * available) } else { bucket.level };
    // Less than a millisecond owed is nothing: the clock cannot tell.
    if drained < 1.0 {
        return Verdict::Nothing;
    }
    let leave = if rate.is_finite() {
        tap.curve.advance(entry, drained / rate).unwrap_or(dry as f64)
    } else {
        entry as f64
    };
    let score = bucket.level / bucket.need.cap() * drained / (leave - now as f64);
    Verdict::Go {
        score,
        departure,
        leave: (leave.ceil() as GameTime).min(dry),
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
/// before the level is served, never overtakes by level. One sitting on the
/// crossing has tied and lost to an earlier bucket, and wins a millisecond
/// on.
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
    if target >= cap {
        return GameTime::MAX;
    }
    now + ((target - b.level) / b.need.fill()).ceil().max(1.0) as GameTime
}

/// Section 4.3: bring the buckets up to date. The one being served drains by
/// what its tap offered since the last look and accrues only for the part it
/// did not; every other one accrues the whole interval. A constant need is
/// constant: it neither drains nor accrues.
fn settle(world: &mut World, id: EntityId, at: EntityId, now: GameTime, crowd: &Crowd) {
    let Some(r) = resident(world, id) else { return };
    let (last, selected) = (r.last_update, r.selected);
    let elapsed = (now - last) as f64;
    let serving: Option<(f64, f64)> = selected.and_then(|need| {
        let company = crowd.get(&(at, need)).copied().unwrap_or(0).max(1);
        taps_of(world, at)
            .iter()
            .find(|t| t.need == need)
            .map(|t| (t.serving(company), t.curve.integral(last, now)))
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
    fn serving(&self, company: u32) -> f64 {
        self.rate * (self.slots as f64 / company.max(1) as f64).min(1.0)
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
    world: &mut World,
    id: EntityId,
    destination: EntityId,
    eta: GameTime,
    length: f64,
    now: GameTime,
) {
    // Every arrival teaches the city how much slower than empty roads it
    // is running, and every departure estimate reads it.
    let free = length / CRUISE_SPEED * 1000.0;
    if free > 0.0 {
        let ratio = (free + now.saturating_sub(eta) as f64) / free;
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

/// Section 6: the demand signal. Who cannot be served — a bucket with no
/// option at all, weighted by how full it is — summed by the chunk they
/// live in; and what every building delivered, today and yesterday. Both
/// derived on request: the first from the same verdicts a wake would
/// compute, the second from what settle has been counting.
pub fn demand(world: &World, now: GameTime) -> Value {
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

/// Step out somewhere. The time up to now was spent wherever they were —
/// in the car, served nothing — and is settled as such before the place
/// changes, or the drive would count as a visit.
pub fn set_at(world: &mut World, id: EntityId, place: EntityId, now: GameTime) {
    if let Some(from) = resident(world, id).and_then(|r| r.at) {
        let crowd = headcount(world);
        settle(world, id, from, now, &crowd);
    }
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
    (dist / CRUISE_SPEED * DETOUR * world.delay * 1000.0) as GameTime
}

fn position_of(world: &World, id: EntityId) -> Option<(i32, i32)> {
    world.objects.get(id)?.position.map(|p| (p.x, p.y))
}

fn time_of_day(now: GameTime) -> u32 {
    (now % DAY_MS as u64) as u32
}
