//! Errands: every trip anyone makes. A family's car to the shop and home
//! with what it bought; to work and back. A lorry to whoever makes what
//! its building lacks, waiting in their yard until it has its load, and
//! home to unload.

use traffic::event_queue::EventQueue;
use model::blueprint::{blueprint, maker};
use model::{BuildingKind, CarRole, EntityId, GameTime, Good, Package};
use crate::world::World;
use super::homes::{shop_for, LEVELS};
use super::{apart, of_kind, open, reaches, stock};

/// How often whoever waits at a counter or a yard looks again.
const POLL_MS: GameTime = 2_000;
/// Waiting with something aboard, how long before going home with it;
/// with nothing, before giving up. A family's patience at the counter is
/// shorter than a lorry's in a yard.
const SOME_MS: [GameTime; 2] = [10_000, 8_000];
const NONE_MS: [GameTime; 2] = [30_000, 60_000];
/// Crates a shop's lorry carries, and a maker's.
const SHOP_LOAD: usize = 8;
const LOAD: usize = 4;
/// A worker's shift, and their rest at home between shifts. A maker
/// loses only the time its workers spend on the road.
const SHIFT_MS: GameTime = 160_000;
const REST_MS: GameTime = 60_000;
/// A family keeps a couple of each thing it eats put by, and one more for
/// every this many tiles to its shop: a shop's car park takes a car a
/// meal no better than a real one would.
const PANTRY: i32 = 2;
const PANTRY_TILES: i32 = 8;

/// A car's errand: where it went and for what, what it has, and since
/// when it has waited there.
#[derive(Debug, Clone)]
pub(super) enum Errand {
    /// On its way to, or waiting at, a place that has what it went for.
    Fetch { to: EntityId, want: Vec<Good>, got: Vec<Good>, extra: Vec<Good>, at: Option<GameTime>, last: GameTime },
    /// On its way home with it.
    Home { got: Vec<Good>, extra: Vec<Good> },
    /// On its way to work, or there since.
    Work { job: EntityId, at: Option<GameTime> },
}

/// A parked car's turn: what its owner needs, fetched; its worker's shift.
pub fn car_idle(world: &mut World, events: &mut EventQueue, car: EntityId, now: GameTime) {
    let Some(c) = world.map.car(car) else { return };
    if c.trip.is_some() || c.run.is_some() {
        return;
    }
    let (owner, role) = (c.owner, c.role);
    if world.map.building(owner).is_none() {
        drop_car(world, car);
        return;
    }
    if !world.map.handled(car, now) {
        events.wake(c.due.saturating_sub(now).max(1), car);
        return;
    }
    let here = world.map.claims.get(&car).copied().filter(|&b| world.map.building(b).is_some());
    match world.town.errands.get(&car).cloned() {
        None => set_out(world, events, car, owner, role, now),
        Some(Errand::Fetch { to, at, .. }) if here == Some(to) => {
            if at.is_none()
                && let Some(Errand::Fetch { at, last, .. }) = world.town.errands.get_mut(&car)
            {
                (*at, *last) = (Some(now), now);
            }
            fetch(world, events, car, owner, role, now);
        }
        // Home, or nowhere: set down at home with no spot free there.
        Some(Errand::Fetch { got, extra, .. } | Errand::Home { got, extra }) if here == Some(owner) || here.is_none() => unpack(world, events, car, owner, role, got, extra, now),
        Some(Errand::Fetch { got, extra, .. } | Errand::Home { got, extra }) => {
            world.town.errands.insert(car, Errand::Home { got, extra });
            go_home(world, events, car, owner, here, now);
        }
        Some(Errand::Work { job, at: None }) if here == Some(job) => {
            if let Some(b) = world.map.building_mut(job) {
                b.present += 1;
            }
            commuting(world, car, false);
            world.town.errands.insert(car, Errand::Work { job, at: Some(now) });
            events.wake(SHIFT_MS, car);
        }
        Some(Errand::Work { job, at: Some(at) }) if here == Some(job) => {
            if now < at + SHIFT_MS {
                events.wake(at + SHIFT_MS - now, car);
                return;
            }
            off_shift(world, events, car, owner, job, now);
        }
        // Its work gone, or never reached: home.
        Some(Errand::Work { .. }) if here == Some(owner) => {
            world.town.errands.remove(&car);
            commuting(world, car, false);
            events.wake(POLL_MS, car);
        }
        Some(Errand::Work { .. }) => {
            world.town.errands.insert(car, Errand::Home { got: Vec::new(), extra: Vec::new() });
            go_home(world, events, car, owner, here, now);
        }
    }
}

/// At home and idle: out for what is lacking, to the nearest place that
/// has it, or else that makes or sells it with room to wait; or, a
/// family's car with nothing wanted, to work.
fn set_out(world: &mut World, events: &mut EventQueue, car: EntityId, owner: EntityId, role: CarRole, now: GameTime) {
    if world.map.street_of(owner).is_none() {
        events.wake(POLL_MS * 3, car);
        return;
    }
    let found = match role {
        CarRole::Private => family_errand(world, car, owner, now),
        CarRole::Truck => lorry_errand(world, owner),
        _ => return,
    };
    if let Some((to, want)) = found {
        if trip(world, events, car, owner, to, now) {
            if role == CarRole::Private
                && let Some(h) = world.map.building_mut(owner).and_then(|b| b.home.as_mut())
            {
                for w in h.wants.iter_mut().filter(|w| w.by.is_none() && want.contains(&w.good)) {
                    w.by = Some(car);
                }
            }
            world.town.errands.insert(car, Errand::Fetch { to, want, got: Vec::new(), extra: Vec::new(), at: None, last: now });
        } else {
            events.wake(POLL_MS, car);
        }
        return;
    }
    if role == CarRole::Private && world.town.rest.get(&car).is_none_or(|&r| r <= now) {
        if let Some(job) = job(world, car, owner)
            && trip(world, events, car, owner, job, now)
        {
            commuting(world, car, true);
            world.town.errands.insert(car, Errand::Work { job, at: None });
            return;
        }
    }
    events.wake(POLL_MS * 2, car);
}

/// What a family's car goes out for, and where: everything open the
/// nearest shop that sells any of it sells, wants first, then what the
/// house grows with that no other car of theirs is out for.
fn family_errand(world: &World, car: EntityId, owner: EntityId, now: GameTime) -> Option<(EntityId, Vec<Good>)> {
    let h = world.map.building(owner)?.home.as_ref()?;
    let mut want: Vec<Good> = h.wants.iter().filter(|w| w.by.is_none()).map(|w| w.good).collect();
    let others: Vec<Good> = world.map.objects.fleet(owner).filter(|&c| c != car).filter_map(|c| match world.town.errands.get(&c) {
        Some(Errand::Fetch { want, .. }) => Some(want.clone()),
        _ => None,
    }).flatten().collect();
    let mut growth = Vec::new();
    for (&g, s) in h.growing.iter().flatten() {
        let n = s.short().round() as usize;
        let out = others.iter().filter(|&&o| o == g).count();
        growth.extend(std::iter::repeat_n(g, n.saturating_sub(out)));
    }
    // What the house grows with is fetched only from a shelf that has it:
    // a trip for nothing is a want kept waiting.
    let stocked = |s: EntityId, g: &Good| world.map.building(s).and_then(|b| b.stocks.get(g)).is_some_and(|st| st.level >= 1.0);
    let shop = if want.is_empty() {
        shop_for(world, owner, &growth, now).filter(|&s| growth.iter().any(|g| stocked(s, g)))?
    } else {
        shop_for(world, owner, &want, now)?
    };
    want.extend(growth.into_iter().filter(|g| stocked(shop, g)));
    let sells = &world.map.building(shop)?.stocks;
    want.retain(|g| sells.contains_key(g));
    Some((shop, want))
}

/// What a lorry goes out for, and where: the good its building lacks most
/// of, from the nearest maker that has some, else that has room to wait.
fn lorry_errand(world: &World, owner: EntityId) -> Option<(EntityId, Vec<Good>)> {
    let b = world.map.building(owner)?;
    let shop = b.kind == BuildingKind::Shop;
    let mut lacks: Vec<(f64, Good, usize)> = b
        .stocks
        .iter()
        .filter(|(g, _)| shop || blueprint(b.kind).takes.iter().any(|t| t.0 == **g))
        .filter_map(|(&g, s)| {
            let lack = s.short().floor();
            let go = if shop { lack >= (s.cap / 3.0).floor().max(1.0) } else { s.level < s.cap / 2.0 };
            go.then_some((lack / s.cap.max(1.0), g, (lack as usize).min(if shop { SHOP_LOAD } else { LOAD })))
        })
        .collect();
    lacks.sort_by(|a, b| b.0.total_cmp(&a.0));
    lacks.into_iter().find_map(|(_, g, n)| Some((source(world, owner, g)?, vec![g; n])))
}

/// The nearest maker of a good a lorry from `home` can reach: one with
/// some in its yard no lorry already on its way has spoken for, else one
/// with room to wait in its yard.
fn source(world: &World, home: EntityId, good: Good) -> Option<EntityId> {
    let map = &world.map;
    let kind = maker(good);
    let mut best: Option<(i32, EntityId)> = None;
    let mut wait: Option<(i32, EntityId)> = None;
    for (id, _) in of_kind(map, kind) {
        if !reaches(map, home, id) {
            continue;
        }
        let d = apart(map, home, id);
        if stock(map, id, good) - spoken_for(world, id, good) >= 1.0 {
            best = best.filter(|b| b.0 <= d).or(Some((d, id)));
        } else if waiting_at(world, id) < blueprint(kind).queue as usize {
            wait = wait.filter(|b| b.0 <= d).or(Some((d, id)));
        }
    }
    best.or(wait).map(|(_, id)| id)
}

/// Crates of a good the lorries on their way to a yard, or in it, have
/// still to load.
fn spoken_for(world: &World, id: EntityId, good: Good) -> f64 {
    world.town.errands.values().map(|e| match e {
        Errand::Fetch { to, want, got, .. } if *to == id => want.iter().filter(|&&g| g == good).count().saturating_sub(got.iter().filter(|&&g| g == good).count()) as f64,
        _ => 0.0,
    }).sum()
}

/// Lorries on their way to, or waiting at, a building for its goods.
fn waiting_at(world: &World, id: EntityId) -> usize {
    world.town.errands.values().filter(|e| matches!(e, Errand::Fetch { to, .. } if *to == id)).count()
}

/// At the counter or in the yard: what is there is taken, a family's at
/// the till, a lorry's lifted aboard; home once it has it all, with what
/// it has once it has waited a while, empty-handed once nothing comes.
fn fetch(world: &mut World, events: &mut EventQueue, car: EntityId, owner: EntityId, role: CarRole, now: GameTime) {
    let Some(Errand::Fetch { to, want, mut got, mut extra, at, mut last }) = world.town.errands.get(&car).cloned() else { return };
    let since = at.unwrap_or(now);
    let lorry = role == CarRole::Truck;
    let shut = !lorry && !open(now);
    let mut took: Vec<Good> = Vec::new();
    if !shut {
        let mut left = want.clone();
        for g in &got {
            if let Some(i) = left.iter().position(|w| w == g) {
                left.remove(i);
            }
        }
        for g in left {
            if let Some(s) = world.map.building_mut(to).and_then(|b| b.stocks.get_mut(&g)).filter(|s| s.level >= 1.0) {
                s.level -= 1.0;
                took.push(g);
            }
        }
    }
    if !took.is_empty() {
        last = now;
        got.extend(took.iter().copied());
        if lorry {
            for g in dedup(&took) {
                let n = took.iter().filter(|&&t| t == g).count() as u32;
                world.map.lift(to, car, g, n, true, now);
            }
        }
        load(world, car, &got);
        // Off the shelf: the shop's lorry sees what it lacks.
        for lorry in world.map.objects.fleet(to).collect::<Vec<_>>() {
            if !world.town.errands.contains_key(&lorry) {
                events.wake(0, lorry);
            }
        }
    }
    // A lorry waiting on an empty yard while another has some goes there.
    if lorry && got.is_empty() && took.is_empty()
        && let Some(&g) = want.first()
        && let Some(other) = source(world, owner, g).filter(|&o| o != to && stock(&world.map, o, g) >= 1.0)
        && trip(world, events, car, to, other, now)
    {
        world.town.errands.insert(car, Errand::Fetch { to: other, want, got, extra, at: None, last: now });
        return;
    }
    let k = lorry as usize;
    let done = shut || got.len() >= want.len() || (!got.is_empty() && now - last >= SOME_MS[k]) || now - since >= NONE_MS[k];
    if done && !lorry && !shut {
        extra = pantry(world, owner, to);
    }
    world.town.errands.insert(car, Errand::Fetch { to, want, got: got.clone(), extra: extra.clone(), at: Some(since), last });
    if !done {
        events.wake(world.map.car(car).map_or(now, |c| c.due).max(now + POLL_MS) - now, car);
        return;
    }
    // The forklift first, then off.
    if !world.map.handled(car, now) {
        events.wake(world.map.car(car).map_or(now, |c| c.due) - now, car);
        return;
    }
    world.town.errands.insert(car, Errand::Home { got, extra });
    go_home(world, events, car, owner, Some(to), now);
}

/// What a family brings home to put by, more the further the shop: what
/// it eats, taken off the shelf now.
fn pantry(world: &mut World, home: EntityId, shop: EntityId) -> Vec<Good> {
    let keep = PANTRY + apart(&world.map, home, shop) / PANTRY_TILES;
    let Some(h) = world.map.building(home).and_then(|b| b.home.as_ref()) else { return Vec::new() };
    let goods: Vec<(Good, i32)> = LEVELS[h.level as usize].wants.iter().map(|&(g, _)| (g, keep - *h.pantry.get(&g).unwrap_or(&0) as i32)).collect();
    let mut extra = Vec::new();
    for (g, n) in goods {
        for _ in 0..n.max(0) {
            match world.map.building_mut(shop).and_then(|b| b.stocks.get_mut(&g)).filter(|s| s.level >= 1.0) {
                Some(s) => {
                    s.level -= 1.0;
                    extra.push(g);
                }
                None => break,
            }
        }
    }
    extra
}

/// Back home from where it stands, with what it has. No way home from
/// there, it is home at once.
fn go_home(world: &mut World, events: &mut EventQueue, car: EntityId, owner: EntityId, from: Option<EntityId>, now: GameTime) {
    if let Some(from) = from
        && trip(world, events, car, from, owner, now)
    {
        return;
    }
    if from.is_none() || world.map.street_of(owner).is_none() || from.is_some_and(|f| !reaches(&world.map, f, owner)) {
        world.drive(events, |t, e| traffic::car::simulation::park_at_home(t, e, car));
        events.wake(0, car);
    } else {
        events.wake(POLL_MS, car);
    }
}

/// Home with the load: a family's wants it answers are met, what it grows
/// with put by; a lorry's crates lifted onto its building's pad.
#[allow(clippy::too_many_arguments)]
fn unpack(world: &mut World, events: &mut EventQueue, car: EntityId, owner: EntityId, role: CarRole, got: Vec<Good>, extra: Vec<Good>, now: GameTime) {
    world.town.errands.remove(&car);
    commuting(world, car, false);
    load(world, car, &[]);
    match role {
        CarRole::Private => {
            super::homes::unpack(world, events, owner, car, &got, &extra, now);
            events.wake(POLL_MS, car);
        }
        _ => {
            let mut done = now;
            for g in dedup(&got) {
                let n = got.iter().filter(|&&t| t == g).count();
                done = done.max(world.map.lift(owner, car, g, n as u32, false, now));
                if let Some(s) = world.map.building_mut(owner).and_then(|b| b.stocks.get_mut(&g)) {
                    s.level = (s.level + n as f64).min(s.cap);
                }
            }
            events.wake(done.saturating_sub(now).max(POLL_MS), car);
        }
    }
}

/// A worker's shift over: off their seat; to the shop if the family wants
/// something and it is open, else home to rest.
fn off_shift(world: &mut World, events: &mut EventQueue, car: EntityId, owner: EntityId, job: EntityId, now: GameTime) {
    if let Some(b) = world.map.building_mut(job) {
        b.present = b.present.saturating_sub(1);
    }
    let rest = REST_MS as f64 * (0.7 + 0.6 * world.town.roll());
    world.town.rest.insert(car, now + rest as GameTime);
    world.town.errands.remove(&car);
    if let Some((to, want)) = family_errand(world, car, owner, now)
        && trip(world, events, car, job, to, now)
    {
        if let Some(h) = world.map.building_mut(owner).and_then(|b| b.home.as_mut()) {
            for w in h.wants.iter_mut().filter(|w| w.by.is_none() && want.contains(&w.good)) {
                w.by = Some(car);
            }
        }
        commuting(world, car, false);
        world.town.errands.insert(car, Errand::Fetch { to, want, got: Vec::new(), extra: Vec::new(), at: None, last: now });
        return;
    }
    world.town.errands.insert(car, Errand::Home { got: Vec::new(), extra: Vec::new() });
    go_home(world, events, car, owner, Some(job), now);
}

/// A worker's job: the seat they hold, or the nearest maker with one free
/// they can drive to.
fn job(world: &mut World, car: EntityId, home: EntityId) -> Option<EntityId> {
    let map = &world.map;
    if let Some(id) = map.objects.iter().find(|e| matches!(e.object, model::GameObject::Building(ref b) if b.crew.contains(&car))).map(|e| e.id) {
        return Some(id);
    }
    let job = map
        .objects
        .iter()
        .filter_map(|e| match e.object {
            model::GameObject::Building(ref b) if blueprint(b.kind).seats > 0 && b.home.is_none() && (b.crew.len() as u32) < blueprint(b.kind).seats => Some(e.id),
            _ => None,
        })
        .filter(|&id| reaches(map, home, id))
        .min_by_key(|&id| (apart(map, home, id), id))?;
    world.map.building_mut(job)?.crew.push(car);
    Some(job)
}

/// A drive from one building to another: whether it set off.
fn trip(world: &mut World, events: &mut EventQueue, car: EntityId, from: EntityId, to: EntityId, now: GameTime) -> bool {
    let Some(door) = world.map.street_of(from) else { return false };
    world.drive(events, |t, e| traffic::car::spawn::start_trip(t, e, car, door, to, now, GameTime::MAX))
}

fn commuting(world: &mut World, car: EntityId, on: bool) {
    if let Some(c) = world.map.car_mut(car)
        && c.commuting != on
    {
        c.commuting = on;
    }
}

/// What a car carries, as the client draws it.
fn load(world: &mut World, car: EntityId, goods: &[Good]) {
    let have: Vec<Good> = world.map.car(car).map_or(Vec::new(), |c| c.cargo.iter().map(|p| p.good).collect());
    if have == goods {
        return;
    }
    let cargo: Vec<Package> = goods.iter().map(|&good| Package { id: world.map.objects.reserve_id(), good }).collect();
    if let Some(c) = world.map.car_mut(car) {
        c.cargo = cargo;
    }
}

fn dedup(goods: &[Good]) -> Vec<Good> {
    let mut v = goods.to_vec();
    v.sort();
    v.dedup();
    v
}

/// Whether a family's car is at work, or on its way: nobody home to want.
pub(super) fn at_work(world: &World, car: EntityId) -> bool {
    matches!(world.town.errands.get(&car), Some(Errand::Work { .. }))
}

/// A car gone for good: its seat and its errand with it.
pub(super) fn drop_car(world: &mut World, car: EntityId) {
    world.town.errands.remove(&car);
    world.town.rest.remove(&car);
    let jobs: Vec<EntityId> = world.map.objects.iter().filter(|e| matches!(e.object, model::GameObject::Building(ref b) if b.crew.contains(&car))).map(|e| e.id).collect();
    for j in jobs {
        if let Some(b) = world.map.building_mut(j) {
            b.crew.retain(|&c| c != car);
        }
    }
    world.map.despawn_car(car);
}

/// A building about to come down: its own cars' errands end with them,
/// and a family's car that works there loses its seat.
pub(super) fn forget(world: &mut World, id: EntityId) {
    let fleet: Vec<EntityId> = world.map.objects.fleet(id).collect();
    for car in fleet {
        let out = world.map.car(car).is_some_and(|c| c.trip.is_some());
        if !out {
            drop_car(world, car);
        }
    }
    if let Some(b) = world.map.building(id) {
        for car in b.crew.clone() {
            if let Some(Errand::Work { job, .. }) = world.town.errands.get(&car)
                && *job == id
            {
                world.town.errands.insert(car, Errand::Home { got: Vec::new(), extra: Vec::new() });
            }
        }
    }
}
