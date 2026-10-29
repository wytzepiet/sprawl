//! Goods on land: what the town's buildings want, what they have to
//! give, and the errands its depots' vans and lorries run between them.
//! docs/game.md §Goods.
//!
//! The one thing kept is the errand a vehicle is on (`model::Errand`),
//! on the vehicle, saved with it and gone with it. What a place wants and
//! what it can give are read off the buildings whenever they are asked,
//! less what the errands under way bring there or take from there.
//!
//! One rule says what a place wants, every place alike: a site, each
//! material it lacks; a shelf, a bin, a pantry or a depot under its
//! reorder point, counting what is on its way, enough to fill it; a
//! harbour, a package for every slot booked to go out. A depot gives its
//! shelf to the town's callers and what it has over its reorder point to
//! the world; a maker its whole yard; a quay what landed for the town.
//!
//! When something changed (`World::plan_due`), at the end of the step,
//! the planner hands each vehicle standing free in its yard an errand: a
//! van the oldest want its depot is the nearest by road to answer; a
//! lorry its own depot's shortages first, from the nearest maker's yard,
//! then what landed for the town that its depot has room for, then the
//! slots going out, from its depot's spare or a maker's yard. The vehicle
//! drives to where the goods are, is loaded, drives them to where they
//! are wanted, is unloaded, and goes home. A place a depot's vehicle could
//! not drive to, a dock full or no way there, is left to others for an
//! hour, and the planner looks again at once. A farm's tractor is no
//! errand: it runs over the farm's own land (`map/fields.rs`).

use std::collections::BTreeMap;

use map::pathfinding::Routes;
use model::blueprint::{blueprint, depot};
use model::{CarRole, EntityId, Errand, GameObject, GameTime, Good, Package, DAY_MS};
use traffic::event_queue::EventQueue;

use crate::economy::{self, whole, VAN_LOAD};
use crate::haul::{harbour_for, LOAD};
use crate::world::World;

pub use traffic::car::SERVICE_MS;

/// A place a depot's vehicle could not drive to is left to others this
/// long, and a vehicle that could not go on tries again this often.
pub const BARRED_MS: GameTime = DAY_MS as GameTime / 24;
const AGAIN_MS: GameTime = DAY_MS as GameTime / 96;

/// A stock changed, or time passed: the building takes its turn. What it
/// wants may have changed, so the planner looks again; and a farm with a
/// hand on shift, room in the yard and a ripe field sends the tractor.
pub fn turn(world: &mut World, events: &mut EventQueue, building: EntityId, now: GameTime) {
    let Some(b) = world.map.building(building) else { return };
    let farm = b.site.is_none() && model::blueprint::farm(b.kind);
    world.waiting.insert(building);
    world.plan_due = true;
    if farm {
        world.farm_run(events, building, now);
    }
}

/// Midnight: every building takes its turn, so a row nobody visits still
/// draws, and every line reads the labour market at the next settle.
pub fn turns(world: &mut World, events: &mut EventQueue, now: GameTime) {
    let ids: Vec<EntityId> = world.map.objects.iter().filter(|e| matches!(e.object, GameObject::Building(_))).map(|e| e.id).collect();
    for id in ids {
        turn(world, events, id, now);
        world.map.unsettled.insert(id);
    }
}

/// A hand on shift at the building: a tractor goes only with someone to
/// drive it.
pub fn staffed(world: &World, building: EntityId) -> bool {
    world.map.objects.iter().any(|e| matches!(e.object, GameObject::Resident(ref r) if r.at == Some(building) && r.selected == Some(model::needs::Need::Work)))
}

/// Does this building have something on every shelf its taps sell from?
/// A building that keeps no shelf always does; a site never does.
pub fn stocked(world: &World, building: EntityId) -> bool {
    match world.map.objects.get(building).map(|e| &e.object) {
        Some(GameObject::Building(b)) => b.site.is_none() && blueprint(b.kind).taps.iter().all(|t| t.need.good().and_then(|g| b.stocks.get(&g)).is_none_or(|s| s.level > 0.0)),
        _ => false,
    }
}

/// What the errands under way bring to each place and take from each,
/// by good, in packages, and the vehicles bringing it: read off the
/// vehicles, so never out of step with them.
#[derive(Default)]
pub struct UnderWay {
    coming: BTreeMap<(EntityId, Good), u32>,
    taking: BTreeMap<(EntityId, Good), u32>,
    by: BTreeMap<(EntityId, Good), EntityId>,
}

impl UnderWay {
    pub fn read(world: &World) -> UnderWay {
        let mut u = UnderWay::default();
        for e in world.map.objects.iter() {
            let GameObject::Car(ref c) = e.object else { continue };
            let Some(errand) = c.errand else { continue };
            u.bring(e.id, errand, c.cargo.is_empty());
        }
        u
    }

    fn bring(&mut self, car: EntityId, e: Errand, to_load: bool) {
        *self.coming.entry((e.to, e.good)).or_default() += e.n;
        self.by.entry((e.to, e.good)).or_insert(car);
        if to_load {
            *self.taking.entry((e.from, e.good)).or_default() += e.n;
        }
    }

    /// Packages of a good errands are bringing to a place.
    pub fn coming(&self, to: EntityId, good: Good) -> u32 {
        self.coming.get(&(to, good)).copied().unwrap_or(0)
    }

    /// Packages of every good errands are bringing to a place.
    pub fn coming_all(&self, to: EntityId) -> u32 {
        self.coming.iter().filter(|((t, _), _)| *t == to).map(|(_, &n)| n).sum()
    }

    /// Packages of a good errands are on their way to load at a place.
    pub fn taking(&self, from: EntityId, good: Good) -> u32 {
        self.taking.get(&(from, good)).copied().unwrap_or(0)
    }

    /// A vehicle bringing a good to a place.
    pub fn by(&self, to: EntityId, good: Good) -> Option<EntityId> {
        self.by.get(&(to, good)).copied()
    }
}

/// What a place wants brought, in whole packages of each good, less what
/// errands under way bring it. The one rule, for every place (see the
/// top of this file); a maker's own good, it never wants.
pub fn wants(world: &World, under: &UnderWay, at: EntityId) -> Vec<(Good, u32)> {
    let Some(b) = world.map.building(at) else { return Vec::new() };
    let short = |g: Good, n: u32| (g, n.saturating_sub(under.coming(at, g)));
    let mut wants: Vec<(Good, u32)> = if let Some(site) = &b.site {
        site.iter().map(|(&g, s)| short(g, whole(s.short(), g))).collect()
    } else if world.map.harbours.contains_key(&at) {
        let mut slots: BTreeMap<Good, u32> = BTreeMap::new();
        for t in &b.outgoing {
            *slots.entry(t.good).or_default() += 1;
        }
        slots.into_iter().map(|(g, n)| short(g, n)).collect()
    } else {
        b.stocks
            .iter()
            .filter(|&(&g, s)| (depot(b.kind) || economy::buys(b.kind, g)) && s.level < economy::reorder(world, at, g))
            .map(|(&g, s)| short(g, whole(s.short(), g)))
            .collect()
    };
    wants.retain(|w| w.1 > 0);
    wants
}

/// Whole packages of a good a depot has on its shelf for the town's
/// callers, or, `spare`, over its reorder point for the world; or a
/// maker's yard, all of it: less what errands are on their way to load.
fn gives(world: &World, under: &UnderWay, at: EntityId, good: Good, spare: bool) -> u32 {
    let Some(b) = world.map.building(at).filter(|b| b.site.is_none()) else { return 0 };
    let Some(s) = b.stocks.get(&good) else { return 0 };
    let keep = if spare && depot(b.kind) { economy::reorder(world, at, good) } else { 0.0 };
    whole(s.level - keep, good).saturating_sub(under.taking(at, good))
}

/// Is this package on a quay one for the depot's lorry: the depot's, or
/// the town's, or one whose depot has gone.
fn for_depot(world: &World, t: &Package, depot: EntityId) -> bool {
    !t.outbound && (t.to == Some(depot) || t.to.is_none_or(|d| world.map.objects.get(d).is_none()))
}

/// Packages of a good landed on a harbour's quay for a depot, less what
/// lorries are on their way to fetch.
fn landed(world: &World, under: &UnderWay, harbour: EntityId, good: Good, depot: EntityId) -> u32 {
    let n = world.map.building(harbour).map_or(0, |b| b.pad.iter().filter(|t| t.good == good && for_depot(world, t, depot)).count() as u32);
    n.saturating_sub(under.taking(harbour, good))
}

/// Places on a harbour's quay neither filled nor held: exports on their
/// way hold theirs, so what the ferry lands never fills the quay under
/// lorries of exports, each waiting there for room the packages it waits
/// to take would free.
pub fn quay_room(world: &World, under: &UnderWay, harbour: EntityId) -> usize {
    let pad = world.map.building(harbour).map_or(0, |b| b.pad.len());
    map::sea::QUAY.saturating_sub(pad + under.coming_all(harbour) as usize)
}

/// When each place has wanted each good it wants, from the first plan
/// that saw it: what a card says it has waited since, and the lead time
/// a delivery teaches its reorder point.
fn since(world: &mut World, wanting: &[(EntityId, Good)], now: GameTime) {
    let was = std::mem::take(&mut world.wanted);
    world.wanted = wanting.iter().map(|&k| (k, was.get(&k).copied().unwrap_or(now))).collect();
}

/// The vehicles of each depot standing free in its yard, no forklift at
/// them and nothing to do: vans and lorries apart.
fn free(world: &mut World, now: GameTime) -> BTreeMap<EntityId, (Vec<EntityId>, Vec<EntityId>)> {
    let depots: Vec<EntityId> = world.map.depots().into_iter().map(|(d, _)| d).filter(|&d| world.map.street_of(d).is_some()).collect();
    let mut free = BTreeMap::new();
    for d in depots {
        world.map.stable(d);
        let (mut vans, mut lorries) = (Vec::new(), Vec::new());
        for car in world.map.objects.fleet(d) {
            let Some(c) = world.map.car(car) else { continue };
            if c.trip.is_some() || c.errand.is_some() || !c.cargo.is_empty() || c.due > now || world.map.claims.get(&car).is_some_and(|&b| b != d) {
                continue;
            }
            match c.role {
                CarRole::Van => vans.push(car),
                CarRole::Truck => lorries.push(car),
                _ => {}
            }
        }
        if !vans.is_empty() || !lorries.is_empty() {
            free.insert(d, (vans, lorries));
        }
    }
    free
}

/// Hand an errand to a vehicle, and send it.
fn assign(world: &mut World, events: &mut EventQueue, under: &mut UnderWay, car: EntityId, e: Errand) {
    under.bring(car, e, true);
    if let Some(c) = world.map.car_mut(car) {
        c.errand = Some(e);
    }
    events.wake(0, car);
}

/// Is a place left to others by this depot's vehicles for now.
fn barred(world: &World, depot: EntityId, place: EntityId) -> bool {
    world.barred.contains_key(&(depot, place))
}

/// The planner: when something changed, every vehicle standing free in
/// its yard is handed what there is for it to do.
pub fn plan(world: &mut World, events: &mut EventQueue, now: GameTime) {
    if !std::mem::take(&mut world.plan_due) {
        return;
    }
    world.barred.retain(|_, &mut until| until > now);
    let mut under = UnderWay::read(world);
    // Every want, the oldest first; those the vans answer, and the
    // depots' own, the lorries'.
    let mut wanting = Vec::new();
    let mut calls = Vec::new();
    let buildings: Vec<EntityId> = world.map.objects.iter().filter(|e| matches!(e.object, GameObject::Building(_))).map(|e| e.id).collect();
    for at in buildings {
        let all = wants(world, &UnderWay::default(), at);
        wanting.extend(all.iter().map(|&(g, _)| (at, g)));
        let open = world.map.street_of(at).is_some() && !world.map.harbours.contains_key(&at) && !world.map.building(at).is_some_and(|b| depot(b.kind) && b.site.is_none());
        if open {
            // One van a want at a time: a bakery's empty bin never takes
            // every van in town from the pantries.
            calls.extend(wants(world, &under, at).into_iter().filter(|&(g, _)| under.coming(at, g) == 0).map(|(g, n)| (at, g, n)));
        }
    }
    since(world, &wanting, now);
    let mut free = free(world, now);
    let mut calls: Vec<(GameTime, EntityId, Good, u32)> = calls.into_iter().map(|(at, g, n)| (world.wanted.get(&(at, g)).copied().unwrap_or(now), at, g, n)).collect();
    calls.sort_unstable();
    for (since, at, good, n) in calls {
        vans(world, events, &mut under, &mut free, Errand { good, n, from: at, to: at, since });
    }
    for (depot, (_, lorries)) in free {
        for lorry in lorries {
            let Some(e) = haul(world, &under, depot, now) else { break };
            assign(world, events, &mut under, lorry, e);
        }
    }
}

/// A want a van answers: the nearest depot by road with the good on its
/// shelf and a van free sends it, with as much as the want, a vanload
/// at most.
fn vans(world: &mut World, events: &mut EventQueue, under: &mut UnderWay, free: &mut BTreeMap<EntityId, (Vec<EntityId>, Vec<EntityId>)>, want: Errand) {
    let at = want.to;
    let sellers: Vec<(EntityId, EntityId)> = free
        .iter()
        .filter(|&(&d, (vans, _))| d != at && !vans.is_empty() && !barred(world, d, at) && gives(world, under, d, want.good, false) > 0)
        .filter_map(|(&d, _)| Some((d, world.map.street_of(d)?)))
        .collect();
    if sellers.is_empty() {
        return;
    }
    let Some(door) = world.map.street_of(at) else { return };
    let mut routes = Routes::from(&world.map, door);
    let Some((_, depot)) = sellers.into_iter().filter_map(|(d, from)| Some((if from == door { 0.0 } else { routes.cost_to(from)? }, d))).min_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1))) else { return };
    let n = want.n.min(VAN_LOAD).min(gives(world, under, depot, want.good, false));
    let Some(van) = free.get_mut(&depot).map(|(vans, _)| vans.remove(0)) else { return };
    assign(world, events, under, van, Errand { n, from: depot, ..want });
}

/// What a depot's lorry free in its yard should fetch, if anything: its
/// depot's own shortages, from the nearest maker's yard with some; else
/// what landed for the town that the depot has room for, what landed
/// first first; else
/// what a slot going out at its harbour wants, from the depot's spare or
/// the nearest maker's yard. The town's own shelf before the world's.
fn haul(world: &World, under: &UnderWay, depot: EntityId, now: GameTime) -> Option<Errand> {
    let here = world.map.objects.get(depot)?.position?;
    let far = |id: EntityId| world.map.objects.get(id).and_then(|e| e.position).map_or(i32::MAX, |p| (p.x - here.x).abs() + (p.y - here.y).abs());
    let open = |id: EntityId| id == depot || (world.map.street_of(id).is_some() && !barred(world, depot, id));
    let makers = |good: Good| {
        world.map.objects.iter().filter_map(move |e| match e.object {
            GameObject::Building(ref b) if b.site.is_none() && blueprint(b.kind).makes == Some(good) => Some(e.id),
            _ => None,
        })
    };
    let harbours: Vec<EntityId> = world.map.harbours.keys().copied().filter(|&h| open(h)).collect();
    // On a quay, the good that landed first.
    let first = |h: EntityId, good: Good| world.map.building(h).and_then(|b| b.pad.iter().position(|t| t.good == good)).unwrap_or(0);
    // (which, how far, from, which first, good, packages, to)
    let mut best: Option<(u8, i32, EntityId, usize, Good, u32, EntityId)> = None;
    let mut consider = |c: (u8, i32, EntityId, usize, Good, u32, EntityId)| {
        if c.5 > 0 && best.is_none_or(|b| (c.0, c.1, c.2, c.3, c.4) < (b.0, b.1, b.2, b.3, b.4)) {
            best = Some(c);
        }
    };
    let short = wants(world, under, depot);
    for &(good, n) in &short {
        for m in makers(good).filter(|&m| open(m)) {
            consider((0, far(m), m, 0, good, n.min(gives(world, under, m, good, false)).min(LOAD), depot));
        }
    }
    if let Some(d) = world.map.building(depot) {
        for (&good, s) in &d.stocks {
            let room = whole(s.short(), good).saturating_sub(under.coming(depot, good));
            for &h in &harbours {
                consider((1, far(h), h, first(h, good), good, room.min(landed(world, under, h, good, depot)).min(LOAD), depot));
            }
        }
    }
    if let Some(h) = harbour_for(world, depot).filter(|&h| open(h)) {
        let room = quay_room(world, under, h) as u32;
        for (good, n) in wants(world, under, h) {
            let n = n.min(room).min(LOAD);
            consider((2, 0, depot, 0, good, n.min(gives(world, under, depot, good, true)), h));
            // A maker's yard goes to the world only once no depot in
            // town is short of it.
            if world.map.depots().into_iter().any(|(d, _)| wants(world, under, d).iter().any(|w| w.0 == good)) {
                continue;
            }
            for m in makers(good).filter(|&m| open(m)) {
                consider((2, far(m), m, 0, good, n.min(gives(world, under, m, good, false)), h));
            }
        }
    }
    let (_, _, from, _, good, n, to) = best?;
    Some(Errand { good, n, from, to, since: world.wanted.get(&(to, good)).copied().unwrap_or(now) })
}

/// A vehicle woke while parked. Private cars have nothing to think about;
/// the ferry keeps the harbour's time; a tractor is on its run or home;
/// one standing for a forklift waits for it; and a depot's van or lorry
/// goes on with its errand from where it stands (`errand`).
pub fn car_idle(world: &mut World, events: &mut EventQueue, car: EntityId, now: GameTime) {
    let (owner, run, role) = match world.map.objects.get(car) {
        Some(e) => match e.object {
            GameObject::Car(ref c) if c.role != CarRole::Private && c.trip.is_none() => (c.owner, c.run.is_some(), c.role),
            _ => return,
        },
        None => return,
    };
    match role {
        CarRole::Ferry => return world.ferry_wake(events, car, now),
        CarRole::Tractor if run => return world.tractor_step(events, car, now),
        _ => {}
    }
    if !world.map.handled(car, now) {
        let due = world.map.car(car).map_or(now, |c| c.due);
        events.wake(due - now, car);
        return;
    }
    if matches!(role, CarRole::Van | CarRole::Truck) {
        return errand(world, events, car, now);
    }
    // A tractor home from its run: filled, and the farm takes its turn.
    let at = world.map.claims.get(&car).copied().unwrap_or(owner);
    if at != owner {
        if !drive(world, events, car, at, owner, now) {
            events.wake(SERVICE_MS, car);
        }
        return;
    }
    economy::refilled(world, car, now);
    turn(world, events, owner, now);
}

/// Start a vehicle's drive from the place it stands at to another.
/// Whether it went.
fn drive(world: &mut World, events: &mut EventQueue, car: EntityId, from: EntityId, to: EntityId, now: GameTime) -> bool {
    let Some(door) = world.map.street_of(from) else { return false };
    world.drive(events, |t, e| traffic::car::spawn::start_trip(t, e, car, door, to, now, GameTime::MAX))
}

/// The vehicle stands until its forklift is done.
fn wait(world: &World, events: &mut EventQueue, car: EntityId, now: GameTime) {
    let due = world.map.car(car).map_or(now, |c| c.due);
    events.wake(due.saturating_sub(now).max(1), car);
}

fn set_errand(world: &mut World, car: EntityId, e: Option<Errand>) {
    if let Some(c) = world.map.car_mut(car) {
        c.errand = e;
    }
    world.plan_due = true;
}

/// A depot's van or lorry, parked, the forklift done with it, goes on
/// with its errand: empty, to where its goods are, and loaded there;
/// laden, to where they are wanted, and unloaded there. With none, it
/// goes home, and at home stands free for the planner; what it carries
/// with no errand (a want gone, a shelf full) goes back into its depot.
fn errand(world: &mut World, events: &mut EventQueue, car: EntityId, now: GameTime) {
    let Some(c) = world.map.car(car) else { return };
    let (owner, e, laden) = (c.owner, c.errand, !c.cargo.is_empty());
    let at = world.map.claims.get(&car).copied().unwrap_or(owner);
    if at == owner {
        economy::refilled(world, car, now);
    }
    let Some(mut e) = e else {
        if at != owner {
            if !drive(world, events, car, at, owner, now) {
                events.wake(AGAIN_MS, car);
            }
        } else if laden {
            home(world, events, car, now);
        } else {
            world.plan_due = true;
        }
        return;
    };
    // Where its goods were wanted is gone: they come home.
    if world.map.building(e.to).is_none() {
        e.to = owner;
        set_errand(world, car, laden.then_some(e));
        if !laden {
            return events.wake(0, car);
        }
    }
    if !laden {
        if at == e.from {
            return load(world, events, car, e, now);
        }
        if !drive(world, events, car, at, e.from, now) {
            world.barred.insert((owner, e.from), now + BARRED_MS);
            set_errand(world, car, None);
            events.wake(if at == owner { 0 } else { AGAIN_MS }, car);
        }
        return;
    }
    if at == e.to {
        return unload(world, events, car, e, now);
    }
    if drive(world, events, car, at, e.to, now) {
        return;
    }
    // A caller it cannot reach is left to others, and what it brought
    // goes home; its depot or the quay it waits for.
    if e.to != owner && !world.map.harbours.contains_key(&e.to) {
        world.barred.insert((owner, e.to), now + BARRED_MS);
        set_errand(world, car, None);
        return events.wake(0, car);
    }
    events.wake(AGAIN_MS, car);
}

/// Loaded where its errand's goods are: from a quay, what landed there
/// for its depot; from a depot or a maker, packages off its pad, priced
/// for the slots going out if it is bound for the quay. None left, the
/// errand is over.
fn load(world: &mut World, events: &mut EventQueue, car: EntityId, e: Errand, now: GameTime) {
    let mut packages = Vec::new();
    if world.map.harbours.contains_key(&e.from) {
        // What it came for, and then, while there is room on the flatbed,
        // whatever else landed for its depot that the depot has room for.
        let depot = e.to;
        let under = UnderWay::read(world);
        let mut room: BTreeMap<Good, u32> = world.map.building(depot).map_or(BTreeMap::new(), |b| b.stocks.iter().map(|(&g, s)| (g, whole(s.short(), g).saturating_sub(under.coming(depot, g)))).collect());
        room.insert(e.good, e.n);
        let mut taken: Vec<usize> = Vec::new();
        if let Some(b) = world.map.building(e.from) {
            let first = b.pad.iter().enumerate().filter(|(_, t)| t.good == e.good);
            let rest = b.pad.iter().enumerate().filter(|(_, t)| t.good != e.good);
            for (i, t) in first.chain(rest) {
                let left = room.entry(t.good).or_default();
                if taken.len() < LOAD as usize && *left > 0 && for_depot(world, t, depot) {
                    *left -= 1;
                    taken.push(i);
                }
            }
        }
        taken.sort_unstable();
        if let Some(b) = world.map.building_mut(e.from) {
            for &i in taken.iter().rev() {
                packages.push(Package { to: Some(depot), ..b.pad.remove(i) });
            }
        }
        packages.reverse();
    } else {
        let out = world.map.harbours.contains_key(&e.to);
        let slots = if out { world.map.building(e.to).map_or(0, |b| b.outgoing.iter().filter(|t| t.good == e.good).count() as u32) } else { e.n };
        let n = economy::loaded(world, e.from, e.good, e.n.min(slots));
        for _ in 0..n {
            let t = if out {
                world.map.building_mut(e.to).and_then(|b| b.outgoing.iter().position(|t| t.good == e.good).map(|i| b.outgoing.remove(i)))
            } else {
                let id = world.map.objects.reserve_id();
                Some(Package { id, good: e.good, to: Some(e.to), outbound: false, order: id, partner: None, price: 0.0 })
            };
            packages.extend(t);
        }
        turn(world, events, e.from, now);
    }
    if packages.is_empty() {
        set_errand(world, car, None);
        return events.wake(0, car);
    }
    let count = |g: Good| packages.iter().filter(|t| t.good == g).count() as u32;
    for good in Good::ALL {
        world.map.lift(e.from, car, good, count(good), true, now);
    }
    let n = count(e.good);
    if let Some(c) = world.map.car_mut(car) {
        c.cargo.extend(packages);
        c.errand = Some(Errand { n, ..e });
    }
    wait(world, events, car, now);
}

/// Unloaded where its goods were wanted: onto the quay, as far as it has
/// room, the ferry at the ramp woken to load them; into a depot, all of
/// it, what is over its shelf stacked in the yard; onto a caller's shelf
/// or a site, what fits, the rest going home. The errand is over once
/// nothing is left for there.
fn unload(world: &mut World, events: &mut EventQueue, car: EntityId, e: Errand, now: GameTime) {
    let cargo = world.map.car(car).map_or(Vec::new(), |c| c.cargo.clone());
    if world.map.harbours.contains_key(&e.to) {
        let quay = world.map.building(e.to).map_or(0, |b| b.pad.len());
        let (mut off, on): (Vec<Package>, Vec<Package>) = cargo.into_iter().partition(|t| t.outbound);
        let kept = off.split_off(map::sea::QUAY.saturating_sub(quay).min(off.len()));
        if off.is_empty() {
            return events.wake(map::HANDLE_MS * LOAD as GameTime, car);
        }
        if let Some(b) = world.map.building_mut(e.to) {
            b.pad.extend(&off);
        }
        if let Some(c) = world.map.car_mut(car) {
            c.cargo = on.into_iter().chain(kept.iter().copied()).collect();
            c.errand = (!kept.is_empty()).then_some(Errand { n: kept.len() as u32, ..e });
        }
        for good in Good::ALL {
            let n = off.iter().filter(|t| t.good == good).count() as u32;
            world.map.lift(e.to, car, good, n, false, now);
        }
        // The ferry at the ramp may load what was dropped.
        if let Some(ferry) = world.ferry_of(e.to).filter(|&f| world.map.car(f).is_some_and(|c| c.spot.is_some())) {
            events.wake(0, ferry);
        }
        world.plan_due = true;
        return wait(world, events, car, now);
    }
    let into_depot = world.map.building(e.to).is_some_and(|b| depot(b.kind) && b.site.is_none());
    let n = land(world, car, e.to, into_depot, now);
    if n > 0 && !into_depot {
        // How long it took, from the want to the load landing: the lead
        // time the next reorder point covers.
        world.books.entry(e.to).or_default().lead = Some(now - e.since);
    }
    // Answered: a want still open waits from now, behind the others.
    world.wanted.remove(&(e.to, e.good));
    set_errand(world, car, None);
    turn(world, events, e.to, now);
    if n == 0 {
        return events.wake(SERVICE_MS, car);
    }
    wait(world, events, car, now);
}

/// What a vehicle carries for the town lifted off at a building, by
/// good: as much as fits, whole, or, into a depot, all of it, what is
/// over its shelf stacked in the yard over its line. Packages landed.
fn land(world: &mut World, car: EntityId, at: EntityId, all: bool, now: GameTime) -> u32 {
    let cargo = world.map.car(car).map_or(Vec::new(), |c| c.cargo.clone());
    let mut kept = Vec::new();
    let mut landed = 0;
    for good in Good::ALL {
        let these: Vec<Package> = cargo.iter().filter(|t| t.good == good && !t.outbound).copied().collect();
        if these.is_empty() {
            continue;
        }
        let units = these.len() as f64 * good.per_package();
        let mut left = economy::delivered(world, at, good, units);
        if all {
            if let Some(s) = world.map.building_mut(at).and_then(|b| b.stocks.get_mut(&good)) {
                s.level += left;
            }
            left = 0.0;
            world.lumps.push(model::Lump { building: at, coins: 0.0, gdp: 0.0, at: now, good: Some(good), units });
        }
        let n = these.len() as u32 - whole(left, good).min(these.len() as u32);
        kept.extend(these.into_iter().skip(n as usize));
        world.map.lift(at, car, good, n, false, now);
        landed += n;
    }
    kept.extend(cargo.iter().filter(|t| t.outbound).copied());
    if let Some(c) = world.map.car_mut(car) {
        c.cargo = kept;
    }
    landed
}

/// Home with what it carries and no errand: what is the town's goes into
/// the depot; what is the world's is an errand to its quay.
fn home(world: &mut World, events: &mut EventQueue, car: EntityId, now: GameTime) {
    let Some(owner) = world.map.car(car).map(|c| c.owner) else { return };
    land(world, car, owner, true, now);
    let out: Vec<Package> = world.map.car(car).map_or(Vec::new(), |c| c.cargo.clone());
    if let (Some(first), Some(h)) = (out.first(), harbour_for(world, owner)) {
        set_errand(world, car, Some(Errand { good: first.good, n: out.len() as u32, from: owner, to: h, since: now }));
    }
    turn(world, events, owner, now);
    wait(world, events, car, now);
}

/// A building taken away: what errands were bringing it, on their way,
/// goes home with them; what they had not loaded yet stays where it is.
/// What the laden ones carried, by good, for giving back.
pub fn recall(world: &mut World, to: EntityId) -> Vec<(Good, f64)> {
    let cars: Vec<EntityId> = world.map.objects.iter().filter(|e| matches!(e.object, GameObject::Car(ref c) if c.errand.is_some_and(|e| e.to == to))).map(|e| e.id).collect();
    let mut back = Vec::new();
    for car in cars {
        let Some(c) = world.map.car_mut(car) else { continue };
        c.errand = None;
        back.extend(c.cargo.drain(..).filter(|t| !t.outbound).map(|t| (t.good, t.good.per_package())));
    }
    world.plan_due = true;
    back
}

/// What a building has asked for, and the vehicle bringing each, if one
/// is: for its card and its pins.
pub fn asked(world: &World, under: &UnderWay, at: EntityId) -> Vec<(Good, Option<EntityId>)> {
    let mut goods: Vec<Good> = wants(world, &UnderWay::default(), at).into_iter().map(|(g, _)| g).collect();
    goods.extend(Good::ALL.into_iter().filter(|&g| under.coming(at, g) > 0));
    goods.sort_unstable();
    goods.dedup();
    goods.into_iter().map(|g| (g, under.by(at, g))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::tests::*;
    use model::{BuildingKind, Good, DAY_MS};

    /// Sell `units` off a shop's shelf, as visits would, let it take its
    /// turn, and the planner look.
    fn sell(world: &mut World, events: &mut EventQueue, shop: EntityId, units: f64, now: GameTime) {
        if let Some(b) = world.map.building_mut(shop) {
            b.stocks.get_mut(&Good::Bread).unwrap().take(units);
        }
        turn(world, events, shop, now);
        plan(world, events, now);
    }

    /// The first shelf, as a fraction of full.
    fn stock(world: &World, building: EntityId) -> f64 {
        let b = world.map.building(building).unwrap();
        let s = &b.stocks[&model::blueprint::shelves(b.kind)[0]];
        s.level / s.cap
    }

    /// The vehicle on an errand to a place, and its depot.
    fn sent(world: &World, to: EntityId) -> Option<(EntityId, EntityId)> {
        world.map.objects.iter().find_map(|e| match e.object {
            GameObject::Car(ref c) if c.errand.is_some_and(|e| e.to == to) => Some((e.id, c.owner)),
            _ => None,
        })
    }

    /// With a depot in town with crates on its shelf, its own van
    /// answers, delivers, and comes home.
    #[test]
    fn a_depot_sends_its_own_van_and_it_comes_home() {
        let mut world = street();
        let shop = build(&mut world, 20, BuildingKind::Shop);
        let warehouse = build(&mut world, 60, BuildingKind::Depot);
        let mut game = game(world);
        sell(&mut game.world, &mut game.events, shop, 50.0, 0);
        let (van, owner) = sent(&game.world, shop).expect("the depot answers");
        assert_eq!(owner, warehouse);
        // The shop learned how long a delivery from next door takes, and
        // reorders later for it.
        let before = crate::economy::reorder(&game.world, shop, Good::Bread);

        // Out through one ring and home through another, at lot speed, on
        // top of the drive: under three hours.
        game.run_to(3 * DAY_MS as u64 / 24);
        let world = &game.world;
        assert!(sent(world, shop).is_none(), "the van is still on its errand");
        let e = world.map.objects.get(van).expect("the depot keeps its van");
        assert!(matches!(e.object, GameObject::Car(ref c) if c.trip.is_none() && c.cargo.is_empty()));
        assert_eq!(e.position, world.map.objects.get(warehouse).unwrap().position, "parked back at the depot");
        let vanload = crate::economy::VAN_LOAD as f64 * Good::Bread.per_package() / 50.0;
        assert_eq!(stock(world, shop), vanload, "a vanload is on the shelves");
        assert!(crate::economy::reorder(world, shop, Good::Bread) < before, "the shop did not learn the lead time");
    }

    /// A shop whose door opens onto the same street node as the depot's,
    /// across the street: the van goes out of the one lot and into the
    /// other, and lands its load, rather than stand loaded in its yard
    /// for good.
    #[test]
    fn a_depot_delivers_next_door() {
        let mut world = street();
        let depot = build(&mut world, 60, BuildingKind::Depot);
        let door = world.map.street_of(depot);
        let shop = (55..70)
            .flat_map(|x| [(x, 1), (x, -1)])
            .find_map(|(x, y)| {
                let shop = world.map.place_on_street(model::GridCoord { x, y }, BuildingKind::Shop)?;
                if world.map.street_of(shop) == door {
                    return Some(shop);
                }
                world.map.remove_building(shop);
                None
            })
            .expect("a shop on the depot's door");
        let mut game = game(world);
        sell(&mut game.world, &mut game.events, shop, 50.0, 0);
        assert!(sent(&game.world, shop).is_some(), "the depot answers");
        game.run_to(3 * DAY_MS as u64 / 24);
        assert!(sent(&game.world, shop).is_none(), "the van never delivered next door");
        assert!(stock(&game.world, shop) > 0.5, "nothing landed on the shelf");
    }

    /// A buyer takes the nearest seller with stock, by road. Of two
    /// depots the nearer answers; one with an empty shelf is no seller,
    /// and the farther answers; with nothing in town on a shelf, nobody
    /// does: the world comes only by sea.
    #[test]
    fn a_buyer_takes_the_nearest_seller_with_stock() {
        let mut world = street();
        let shop = build(&mut world, 20, BuildingKind::Shop);
        let near = build(&mut world, 30, BuildingKind::Depot);
        let far = build(&mut world, 60, BuildingKind::Depot);
        let mut events = EventQueue::new();
        let empty = |world: &mut World, depot: EntityId| {
            if let Some(b) = world.map.building_mut(depot) {
                b.stocks.get_mut(&Good::Bread).unwrap().level = 0.0;
            }
        };
        sell(&mut world, &mut events, shop, 35.0, 0);
        assert_eq!(sent(&world, shop).map(|s| s.1), Some(near), "the nearer depot did not answer");
        let other = build(&mut world, 24, BuildingKind::Shop);
        empty(&mut world, near);
        sell(&mut world, &mut events, other, 35.0, 0);
        assert_eq!(sent(&world, other).map(|s| s.1), Some(far), "an empty shelf answered");
        let third = build(&mut world, 10, BuildingKind::Shop);
        empty(&mut world, far);
        sell(&mut world, &mut events, third, 35.0, 0);
        assert_eq!(sent(&world, third), None, "with nothing in town somebody answered");
    }

    /// A depot short of grain with two farms' yards full: its two lorries
    /// go one to each, not both to the nearer, and each brings a load.
    #[test]
    fn two_lorries_share_two_farms() {
        let mut world = street();
        let near = build(&mut world, 30, BuildingKind::Farm);
        let far = build(&mut world, 50, BuildingKind::Farm);
        let depot = build(&mut world, 10, BuildingKind::Depot);
        let mut game = game(world);
        crate::haul::buy(&mut game.world, &mut game.events, depot, CarRole::Truck, 0);
        for farm in [near, far] {
            let b = game.world.map.building_mut(farm).unwrap();
            let s = b.stocks.get_mut(&Good::Grain).unwrap();
            s.level = s.cap.min(LOAD as f64 * Good::Grain.per_package());
        }
        game.world.map.building_mut(depot).unwrap().stocks.get_mut(&Good::Grain).unwrap().level = 0.0;
        turn(&mut game.world, &mut game.events, depot, 0);
        plan(&mut game.world, &mut game.events, 0);
        let from: Vec<EntityId> = game.world.map.objects.fleet(depot).filter_map(|c| game.world.map.car(c)?.errand.map(|e| e.from)).collect();
        assert!(from.contains(&near) && from.contains(&far), "the lorries went {from:?}, not one to each farm");
    }
}
