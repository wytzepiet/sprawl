use crate::car::spawn::start_trip;
use crate::car::CRUISE_SPEED;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::protocol::{BuildingKind, EntityId, GameObject, DAY_MS};
use crate::world::World;

/// Real roads bend; the crow does not. Straight-line travel time is scaled up
/// by this before promising to be anywhere. Being systematically a little
/// early beats being systematically late for reasons that are nobody's fault.
const DETOUR: f64 = 1.4;

/// How long to sit on a failed departure — a blocked driveway, a severed road —
/// before looking again.
const RETRY_MS: u64 = 10_000;

/// One resident thinking. Reads the clock and the world, decides where it
/// should be, and either goes there or schedules the moment that answer
/// changes. Carries no memory of why it was woken — any wake, at any time,
/// converges on the same behaviour.
pub fn handle_resident_wake(
    world: &mut World,
    events: &mut EventQueue,
    id: EntityId,
    now: GameTime,
) {
    let Some((home, work, at, car)) = read(world, id) else { return };

    // Off-map: someone who has not driven in yet. Immigration will give this
    // branch a trip; until then they simply are not here.
    let Some(mut at) = at else { return };

    // Riding: the trip's arrival is what wakes us next, not the clock.
    if matches!(world.objects.get(at).map(|e| &e.object), Some(GameObject::Car(_))) {
        return;
    }

    // Standing somewhere that no longer exists — a demolished workplace, a
    // save that outlived its car. Home is where you are when the world has
    // moved on; if home is gone too, settle is about to take us with it.
    if world.objects.get(at).is_none() {
        if world.objects.get(home).is_none() {
            return;
        }
        set_at(world, id, home);
        at = home;
    }

    let Some(work) = work else {
        // Jobless: nowhere to be. Head home if stranded elsewhere; otherwise
        // wait for settle to wake us with news.
        if at != home && !start_trip(world, events, car, at, home, now) {
            events.wake(RETRY_MS, id);
        }
        return;
    };
    let Some((open, close)) = kind(world, work).and_then(BuildingKind::hours) else {
        return;
    };

    // Leave early enough to be there when the shift starts.
    let leave = open.wrapping_sub(travel_margin(world, home, work)) % DAY_MS;

    let should_be = if between(leave, time_of_day(now), close) { work } else { home };
    if at == should_be {
        // Nothing to do until the answer changes.
        let boundary = if should_be == home { leave } else { close };
        events.wake(until(now, boundary), id);
    } else if !start_trip(world, events, car, at, should_be, now) {
        events.wake(RETRY_MS, id);
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
    if let Some((_, work, _, _)) = read(world, id)
        && work == Some(destination)
        && let Some((open, _)) = kind(world, destination).and_then(BuildingKind::hours)
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

type Situation = (EntityId, Option<EntityId>, Option<EntityId>, EntityId);

fn read(world: &World, id: EntityId) -> Option<Situation> {
    let entry = world.objects.get(id)?;
    let GameObject::Resident(ref r) = entry.object else { return None };
    Some((r.home, r.work, r.at, r.car))
}

pub fn set_at(world: &mut World, id: EntityId, place: EntityId) {
    if let Some(entry) = world.objects.get_mut(id)
        && let GameObject::Resident(ref mut r) = entry.object
    {
        r.at = Some(place);
    }
}

fn kind(world: &World, building: EntityId) -> Option<BuildingKind> {
    let entry = world.objects.get(building)?;
    let GameObject::Building(ref b) = entry.object else { return None };
    Some(b.kind)
}

/// Straight-line commute time in game milliseconds, with the detour factor.
fn travel_margin(world: &World, home: EntityId, work: EntityId) -> u32 {
    let dist = match (position_of(world, home), position_of(world, work)) {
        (Some(a), Some(b)) => (a.0 - b.0).abs().max((a.1 - b.1).abs()) as f64,
        _ => 0.0,
    };
    (dist / CRUISE_SPEED * DETOUR * 1000.0) as u32
}

fn position_of(world: &World, id: EntityId) -> Option<(i32, i32)> {
    world.objects.get(id)?.position.map(|p| (p.x, p.y))
}

fn time_of_day(now: GameTime) -> u32 {
    (now % DAY_MS as u64) as u32
}

/// Milliseconds until the clock next reads `tod`. Zero-length never happens:
/// asking at exactly `tod` waits a full day, which is what a boundary wake
/// wants — the moment just passed was already acted on.
fn until(now: GameTime, tod: u32) -> u64 {
    ((tod as u64 + DAY_MS as u64 - time_of_day(now) as u64 - 1) % DAY_MS as u64) + 1
}

/// Is `tod` inside the circular window [from, to)? The working day wraps
/// midnight when an early shift's departure margin reaches into yesterday.
fn between(from: u32, tod: u32, to: u32) -> bool {
    if from <= to {
        from <= tod && tod < to
    } else {
        tod >= from || tod < to
    }
}
