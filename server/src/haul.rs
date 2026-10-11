//! Boxes between the harbour and the depots, and the rules that order
//! them (docs/trade.md §Top-up, docs/shipping.md §Boxes and lorries).
//!
//! A depot's lorry hauls the world's boxes. It goes to the harbour when it
//! is sent, by the mayor's tap, or of its own accord once it has standing
//! orders: when a box for its depot, or for the town, stands in the park,
//! or when its depot has a box to sell. A box is only ever full. An
//! export is loaded under the depot's canopy, or at a maker's yard, and
//! the lorry pulls it out and drops it in a free dock for the ferry, drop
//! and hook: then it backs under the box it came for and drives it home,
//! backs it under the canopy, where it is unloaded into stock and is gone,
//! and drives off bobtail. With nothing to take it goes bobtail. Nothing
//! about an errand is remembered: a lorry reads what it should do from
//! where it is and what it carries, as a resident does.
//!
//! A depot's rules book boxes from the world on the next ferry when its
//! stock and what is already on its way fall under the floor, as far as
//! the treasury goes; the coins go when each box lands.

use std::collections::BTreeMap;

use crate::blueprint::blueprint;

use crate::calls::SERVICE_MS;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::protocol::{CarRole, EntityId, GameObject, Good, Leg, Rule, Sailing, Sea, Shipment, Trailer};
use crate::world::World;

/// The rules a new depot comes with, drawn over it like any rule, so the
/// player sees automation before they need to understand it (docs/game.md
/// §Buildings): keep a box and a half of timber, a few days of a small
/// town's meals, and a tank box for the vans. They buy nothing until the
/// depot has standing orders (`top_up`).
pub fn first_rules() -> BTreeMap<Good, Rule> {
    BTreeMap::from([
        (Good::Timber, Rule { keep: 30.0, fill: 60.0, sell: None }),
        (Good::Crates, Rule { keep: 80.0, fill: 200.0, sell: None }),
        (Good::Fuel, Rule { keep: 30.0, fill: 100.0, sell: None }),
    ])
}

fn building(world: &World, id: EntityId) -> Option<&crate::protocol::Building> {
    match world.objects.get(id).map(|e| &e.object) {
        Some(GameObject::Building(b)) => Some(b),
        _ => None,
    }
}

fn car(world: &World, id: EntityId) -> Option<&crate::protocol::Car> {
    match world.objects.get(id).map(|e| &e.object) {
        Some(GameObject::Car(c)) => Some(c),
        _ => None,
    }
}

/// A depot's lorry.
pub fn lorry_of(world: &World, depot: EntityId) -> Option<EntityId> {
    world.objects.iter().find(|e| matches!(e.object, GameObject::Car(ref c) if c.role == CarRole::Truck && c.owner == depot)).map(|e| e.id)
}

/// Every box in the world, and where it is: the shipments list, read off
/// every place a box can be.
pub fn boxes(world: &World) -> Vec<(Trailer, Leg, Option<EntityId>)> {
    let mut out = Vec::new();
    for e in world.objects.iter() {
        match e.object {
            GameObject::Car(ref c) => {
                out.extend(c.booked.iter().map(|&t| (t, Leg::Booked, Some(e.id))));
                out.extend(c.deck.iter().flatten().map(|&t| (t, Leg::Aboard, Some(e.id))));
                out.extend(c.hitched.map(|t| (t, if c.role == CarRole::Truck && world.claims.get(&e.id) == Some(&c.owner) { Leg::Yard } else { Leg::Hauled }, Some(e.id))));
            }
            GameObject::Building(ref b) => out.extend(b.park.iter().filter_map(|s| s.trailer).map(|t| (t, Leg::Parked, Some(e.id)))),
            _ => {}
        }
    }
    out
}

/// What is on its way to a depot of a good, booked, at sea, in the park
/// or on a hitch: what its rule counts as good as in stock.
/// A box for the town, for whichever depot's lorry comes first, counts
/// for every depot: a town of one depot, which is the town that has them,
/// counts it once.
pub fn incoming(world: &World, depot: EntityId, good: Good) -> f64 {
    boxes(world).iter().filter(|(t, _, _)| t.to.is_none_or(|d| d == depot) && t.good == good && !t.outbound).map(|(t, _, _)| t.units).sum()
}

/// The harbour a depot books through: the nearest standing, by its tile.
fn harbour_for(world: &World, depot: EntityId) -> Option<EntityId> {
    let at = world.objects.get(depot)?.position?;
    world
        .harbours
        .keys()
        .filter_map(|&h| Some((h, world.objects.get(h)?.position?)))
        .min_by_key(|&(h, p)| ((p.x - at.x).abs() + (p.y - at.y).abs(), h))
        .map(|(h, _)| h)
}

/// Book boxes of a good from the world for a depot, on its harbour's next
/// sailing, as many as the treasury can pay for when they land. Returns
/// how many were booked.
pub fn book(world: &mut World, depot: EntityId, good: Good, boxes: u32) -> u32 {
    let Some(ferry) = harbour_for(world, depot).and_then(|h| world.next_ferry(h)) else { return 0 };
    let owed: f64 = self::boxes(world).iter().filter(|(t, l, _)| !t.outbound && matches!(l, Leg::Booked | Leg::Aboard) && t.order != crate::world::sea::GIFT).map(|(t, _, _)| crate::economy::import(t.good, t.units)).sum();
    let afford = ((world.treasury - owed) / crate::economy::quote(good, 1)).floor().max(0.0) as u32;
    let n = boxes.min(afford);
    if n == 0 {
        return 0;
    }
    let order = world.objects.reserve_id();
    let ids: Vec<u64> = (0..n).map(|_| world.objects.reserve_id()).collect();
    if let Some(GameObject::Car(c)) = world.objects.get_mut(ferry).map(|e| &mut e.object) {
        for id in ids {
            c.booked.push(Trailer { id, good, units: good.per_box(), to: Some(depot), outbound: false, order });
        }
    }
    n
}

/// A depot's rules, read, once the mayor has given it standing orders:
/// for each good under its floor with what is already on its way, boxes
/// enough to fill it are booked, and the news says so, with the price.
/// Without standing orders a rule is only drawn, and spends nothing.
pub fn top_up(world: &mut World, depot: EntityId) {
    let Some(b) = building(world, depot) else { return };
    if b.site.is_some() || !b.standing {
        return;
    }
    let rules: Vec<(Good, Rule, f64, f64)> = b.rules.iter().filter_map(|(&g, &r)| Some((g, r, b.stocks.get(&g)?.level, b.stocks.get(&g)?.cap))).collect();
    for (good, rule, level, cap) in rules {
        // What a maker in town has a load of comes from it, by the depot's
        // own fetch, not from over the sea.
        if made_in_town(world, good) {
            continue;
        }
        let have = level + incoming(world, depot, good);
        // As many as fill it, but only whole boxes the shelf has room
        // for: the lorry fetches a box only when it fits, and one bought
        // past that would stand in the park, paid for, till it did.
        let room = ((cap - have) / good.per_box()).floor().max(0.0) as u32;
        if have < rule.keep {
            let boxes = (((rule.fill - have) / good.per_box()).ceil().max(1.0) as u32).min(room);
            let n = if boxes > 0 { book(world, depot, good, boxes) } else { 0 };
            if n > 0 {
                let units = n as f64 * good.per_box();
                world.news.push(crate::protocol::News {
                    text: format!("Depot ordered {units:.0} {}", format!("{good:?}").to_lowercase()),
                    sub: format!("under its keep line of {:.0}, −{:.0} as it lands", rule.keep, crate::economy::quote(good, n)),
                    at: depot,
                });
            }
        }
    }
}

/// Something landed in a park, or a depot has something to sell: every
/// lorry standing idle with standing orders thinks again.
pub fn call_lorries(world: &mut World, events: &mut EventQueue) {
    let idle: Vec<EntityId> = world
        .objects
        .iter()
        .filter(|e| matches!(e.object, GameObject::Car(ref c) if c.role == CarRole::Truck && c.trip.is_none()))
        .map(|e| e.id)
        .collect();
    for lorry in idle {
        events.wake(0, lorry);
    }
}

/// A box in a harbour's park the depot's lorry should fetch: one bound
/// for the depot, or for the town; the nearest harbour's first. And the
/// dock it stands in.
fn waiting_for(world: &World, depot: EntityId, lorry: EntityId) -> Option<(EntityId, usize)> {
    let at = world.objects.get(depot)?.position?;
    let taken: Vec<(EntityId, usize)> = world.aims.iter().filter(|&(&l, _)| l != lorry).map(|(_, &a)| a).collect();
    world
        .harbours
        .keys()
        .filter_map(|&h| {
            let b = building(world, h)?;
            let p = world.objects.get(h)?.position?;
            // One the depot has room for, whole: a lorry does not fetch a
            // box to stand in the yard on its hitch.
            let room = |g: Good, units: f64| building(world, depot).and_then(|d| d.stocks.get(&g)).is_some_and(|s| s.short() >= units);
            let i = b.park.iter().position(|s| {
                s.trailer.is_some_and(|t| !t.outbound && room(t.good, t.units) && (t.to == Some(depot) || t.to.is_none_or(|d| world.objects.get(d).is_none())))
            });
            let i = i.filter(|&i| !taken.contains(&(h, i)))?;
            Some(((p.x - at.x).abs() + (p.y - at.y).abs(), h, i))
        })
        .min()
        .map(|(_, h, i)| (h, i))
}

/// What the depot wants to sell now, and how much: a box the mayor sold
/// by hand, first, full as the shelf allows; or what its rules sell,
/// everything over the line up to a box, once that is a quarter of one.
fn to_sell(world: &World, depot: EntityId) -> Option<(Good, f64)> {
    let b = building(world, depot)?;
    if let Some(&g) = b.selling.first() {
        return Some((g, g.per_box()));
    }
    b.rules.iter().find_map(|(&g, r)| {
        let over = b.stocks.get(&g)?.level - r.sell?;
        (over >= g.per_box() / 4.0).then_some((g, over.min(g.per_box())))
    })
}

/// A full box, made where it is loaded: an export at a depot or a
/// maker's yard, or a maker's load for its depot.
fn new_box(world: &mut World, good: Good, units: f64, to: Option<EntityId>, outbound: bool) -> Trailer {
    let (id, order) = (world.objects.reserve_id(), world.objects.reserve_id());
    Trailer { id, good, units, to, outbound, order }
}

/// A maker in town has a box's worth of this good in its yard.
fn made_in_town(world: &World, good: Good) -> bool {
    world.objects.iter().any(|e| matches!(e.object, GameObject::Building(ref b) if blueprint(b.kind).makes == Some(good) && b.stocks.get(&good).is_some_and(|s| s.level >= good.per_box())))
}

/// Is the depot under its keep line of a good, or its reorder point if it
/// has no rule for it, counting what is on its way: the town's own shelf
/// comes before the world's.
fn short_of(world: &World, depot: EntityId, good: Good) -> bool {
    let Some(b) = building(world, depot) else { return false };
    let Some(s) = b.stocks.get(&good) else { return false };
    let line = b.rules.get(&good).map_or_else(|| crate::economy::reorder(world, depot, good), |r| r.keep.max(crate::economy::reorder(world, depot, good)));
    s.level + incoming(world, depot, good) < line
}

/// Does the depot sell this good: a rule with a line to sell over.
fn sells(world: &World, depot: EntityId, good: Good) -> bool {
    building(world, depot).is_some_and(|b| b.rules.get(&good).is_some_and(|r| r.sell.is_some()))
}

/// The nearest maker in town with a box's worth in its yard of a good the
/// depot is short of, by the tiles between them, or else of one it sells:
/// the town's own shelf before the world's. A lorry is free to go to a
/// maker whenever it is bobtail, so a farm's endless crates for the world
/// would otherwise keep it from the sawmill's timber the town is out of.
fn maker_with_surplus(world: &World, depot: EntityId) -> Option<EntityId> {
    let at = world.objects.get(depot)?.position?;
    world
        .objects
        .iter()
        .filter_map(|e| match e.object {
            GameObject::Building(ref b) => {
                let good = blueprint(b.kind).makes?;
                let short = short_of(world, depot, good);
                (short || sells(world, depot, good)).then_some(())?;
                (b.stocks.get(&good)?.level >= good.per_box() && world.street_of(e.id).is_some()).then_some((!short, e.id, e.position?))
            }
            _ => None,
        })
        .min_by_key(|&(sold, id, p)| (sold, (p.x - at.x).abs() + (p.y - at.y).abs(), id))
        .map(|(_, id, _)| id)
}

/// The lorry woke, parked: at the end of its service where it stands, or
/// called. At home it unloads what it brought, pulls out a box of what is
/// sold, and sets out if there is a reason to; at a harbour it drops what
/// it brought and hooks what it came for, and goes home.
pub fn lorry_wake(world: &mut World, events: &mut EventQueue, lorry: EntityId, now: GameTime) {
    let Some(c) = car(world, lorry) else { return };
    if c.trip.is_some() {
        return;
    }
    let (depot, hitched) = (c.owner, c.hitched);
    let Some(home) = world.street_of(depot) else { return };
    let at = world.claims.get(&lorry).copied().unwrap_or(depot);
    if world.harbours.contains_key(&at) {
        at_harbour(world, events, lorry, depot, at, now);
        return;
    }
    if at != depot {
        // At a maker's yard, bobtail: a box loaded with what it makes, and
        // home with it while the depot is short, else on to the harbour
        // for the world.
        let good = building(world, at).and_then(|b| blueprint(b.kind).makes).filter(|&g| sells(world, depot, g) || short_of(world, depot, g));
        if let (Some(good), None) = (good, hitched) {
            let units = crate::economy::loaded(world, at, good, good.per_box());
            if units > 0.0 {
                let home = short_of(world, depot, good);
                let t = new_box(world, good, units, home.then_some(depot), !home);
                set_load(world, lorry, Some(t));
                crate::calls::turn(world, events, at, now);
                let to = if home { Some(depot) } else { harbour_for(world, depot) };
                let gone = to.zip(world.street_of(at)).is_some_and(|(h, door)| crate::car::spawn::start_trip(world, events, lorry, door, h, now, GameTime::MAX));
                if !gone {
                    events.wake(crate::calls::RETRY_MS, lorry);
                }
                return;
            }
        }
        return go_home(world, events, lorry, at, now);
    }
    crate::economy::refilled(world, lorry, now);
    // Home, backed under the canopy. A box from the harbour is unloaded
    // into stock and is gone; what does not fit the shelf is stacked in
    // the yard over its line. The lorry drives off bobtail.
    if let Some(t) = hitched.filter(|t| !t.outbound) {
        let left = crate::economy::delivered(world, depot, t.good, t.units);
        if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object)
            && let Some(s) = b.stocks.get_mut(&t.good)
        {
            s.level += left;
        }
        set_load(world, lorry, None);
        world.lumps.push(crate::protocol::Lump { building: depot, coins: 0.0, gdp: 0.0, at: now, good: Some(t.good), units: t.units });
        crate::calls::turn(world, events, depot, now);
        events.wake(SERVICE_MS, lorry);
        return;
    }
    let Some(b) = building(world, depot) else { return };
    let (standing, sent) = (b.standing, world.sent.contains(&lorry));
    if !(standing || sent || b.selling.first().is_some()) {
        return;
    }
    // Bobtail, and the depot has something to sell: a box is loaded with
    // it under the canopy, and the lorry pulls it out.
    if let (Some((good, units)), None) = (to_sell(world, depot), hitched) {
        let units = crate::economy::loaded(world, depot, good, units);
        if units > 0.0 {
            let t = new_box(world, good, units, None, true);
            set_load(world, lorry, Some(t));
            if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
                if let Some(i) = b.selling.iter().position(|&g| g == good) {
                    b.selling.remove(i);
                }
            }
        }
    }
    let hitched = car(world, lorry).and_then(|c| c.hitched);
    // Still bobtail, and a maker in town has a load of what the depot
    // sells or is short of: the lorry fetches it from the maker's yard.
    if hitched.is_none()
        && let Some(maker) = maker_with_surplus(world, depot)
        && let Some(door) = world.street_of(depot)
    {
        world.sent.remove(&lorry);
        if !crate::car::spawn::start_trip(world, events, lorry, door, maker, now, GameTime::MAX) {
            events.wake(crate::calls::RETRY_MS, lorry);
        }
        return;
    }
    // At home every box on the hitch is going out.
    let wanted = waiting_for(world, depot, lorry);
    if !(hitched.is_some() || wanted.is_some() || sent) {
        return;
    }
    let harbour = wanted.map(|(h, _)| h).or_else(|| harbour_for(world, depot));
    let Some(harbour) = harbour else { return };
    // Bobtail, it backs straight under the box it came for; with a box,
    // it takes a free dock to drop it first.
    match (hitched, wanted) {
        (None, Some((h, i))) => {
            world.aims.insert(lorry, (h, i));
        }
        _ => {
            world.aims.remove(&lorry);
        }
    }
    world.sent.remove(&lorry);
    if !crate::car::spawn::start_trip(world, events, lorry, home, harbour, now, GameTime::MAX) {
        world.aims.remove(&lorry);
        events.wake(crate::calls::RETRY_MS, lorry);
    }
}

/// At a harbour, in a dock: a box on the hitch going out is dropped here
/// for the ferry; bobtail, the box in this dock is hooked if it is one the
/// lorry came for; then on to the box it came for, or home.
fn at_harbour(world: &mut World, events: &mut EventQueue, lorry: EntityId, depot: EntityId, harbour: EntityId, now: GameTime) {
    let dock = match world.claim_of_dock(harbour, lorry) {
        Some(i) => i,
        None => return go_home(world, events, lorry, harbour, now),
    };
    let hitched = car(world, lorry).and_then(|c| c.hitched);
    let in_dock = building(world, harbour).and_then(|b| b.park.get(dock).and_then(|s| s.trailer));
    match (hitched, in_dock) {
        (Some(t), None) if t.outbound => {
            if let Some(GameObject::Building(b)) = world.objects.get_mut(harbour).map(|e| &mut e.object) {
                b.park[dock].trailer = Some(t);
            }
            set_load(world, lorry, None);
            if let Some(tug) = world.tug_of(harbour) {
                events.wake(0, tug);
            }
            // Dropped: on to the box it came for, if there is one.
            match waiting_for(world, depot, lorry).filter(|&(h, _)| h == harbour) {
                Some((_, i)) if i != dock => {
                    let leaves = car(world, lorry).and_then(|c| c.spot);
                    world.aims.insert(lorry, (harbour, i));
                    let moved = world.redock(harbour, lorry, i, now).is_some_and(|(way, backs)| crate::car::spawn::manoeuvre(world, events, lorry, harbour, way, backs, leaves, now));
                    if !moved {
                        go_home(world, events, lorry, harbour, now);
                    }
                }
                _ => go_home(world, events, lorry, harbour, now),
            }
        }
        (None, Some(t)) if !t.outbound => {
            if let Some(GameObject::Building(b)) = world.objects.get_mut(harbour).map(|e| &mut e.object) {
                b.park[dock].trailer = None;
            }
            // A box for the town is the depot's once its lorry has it.
            set_load(world, lorry, Some(Trailer { to: Some(t.to.unwrap_or(depot)), ..t }));
            go_home(world, events, lorry, harbour, now);
        }
        _ => go_home(world, events, lorry, harbour, now),
    }
}

/// Coupling to a box or dropping one: a few seconds' work for a driver,
/// a moment to watch.
pub const COUPLE_MS: GameTime = 400;

fn go_home(world: &mut World, events: &mut EventQueue, lorry: EntityId, harbour: EntityId, now: GameTime) {
    world.aims.remove(&lorry);
    let Some(depot) = car(world, lorry).map(|c| c.owner) else { return };
    let from = world.street_of(harbour);
    let gone = from.is_some_and(|from| crate::car::spawn::start_trip(world, events, lorry, from, depot, now, GameTime::MAX));
    if !gone {
        events.wake(crate::calls::RETRY_MS, lorry);
    }
}

fn set_load(world: &mut World, lorry: EntityId, t: Option<Trailer>) {
    world.set_hitch(lorry, t);
}

/// The sea's part of an update: every box with an order, where it is and
/// when it lands; every harbour's timetable.
pub fn sea(world: &World) -> Sea {
    let calls: BTreeMap<EntityId, Option<GameTime>> = world.harbours.keys().flat_map(|&h| world.ferries_of(h)).map(|f| (f, world.next_call(f))).collect();
    let shipments = boxes(world)
        .into_iter()
        .map(|(t, leg, carrier)| {
            let c = carrier.and_then(|id| car(world, id));
            let eta = match leg {
                Leg::Booked => carrier.and_then(|f| calls.get(&f).copied().flatten()),
                Leg::Aboard => c.map(|c| c.due).filter(|_| c.is_some_and(|c| c.spot.is_none())),
                Leg::Hauled => c.and_then(|c| c.trip.as_ref()).map(|t| t.eta),
                _ => None,
            };
            Shipment { order: t.order, trailer: t.id, good: t.good, units: t.units, to: t.to, outbound: t.outbound, leg, carrier, at: carrier.and_then(|id| world.objects.get(id)?.position), eta }
        })
        .collect();
    let sailings = world
        .harbours
        .keys()
        .filter_map(|&harbour| {
            let ferry = world.ferry_of(harbour)?;
            let c = car(world, ferry)?;
            let berthed = c.spot.is_some();
            let arrives = if berthed { c.due - crate::world::sea::DWELL } else { c.due };
            let departs = arrives + crate::world::sea::DWELL;
            Some(Sailing {
                harbour,
                ferry,
                arrives,
                departs,
                berthed,
                boxes: c.deck.iter().flatten().count() as u32,
                settlers: c.passengers.len() as u32,
                deck: crate::world::sea::DECK as u32,
                booked: c.booked.len() as u32,
                waiting: world.waiting_settlers(harbour).len() as u32,
                lands: world.next_ferry(harbour).and_then(|f| world.next_call(f))?,
                turn: world.turn(harbour)?,
            })
        })
        .collect();
    let lanes = world.lanes.as_ref().map_or(Vec::new(), |lanes| world.lines.values().flat_map(|l| &l.legs).flat_map(|leg| lanes.drawn(leg)).collect());
    Sea { shipments, sailings, lanes }
}

/// The mayor's hand at the border: an order, a rule, standing orders, a
/// tap, a box sold.
pub fn order(world: &mut World, events: &mut EventQueue, depot: EntityId, good: Good, boxes: u32) {
    if building(world, depot).is_some_and(|b| crate::economy::depot(b.kind)) {
        book(world, depot, good, boxes);
    }
    let _ = events;
}

pub fn set_rule(world: &mut World, events: &mut EventQueue, depot: EntityId, good: Good, rule: Option<Rule>, now: GameTime) {
    if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
        if !crate::economy::depot(b.kind) {
            return;
        }
        match rule {
            Some(r) => b.rules.insert(good, Rule { keep: r.keep.max(0.0), fill: r.fill.max(r.keep), sell: r.sell }),
            None => b.rules.remove(&good),
        };
    }
    crate::calls::turn(world, events, depot, now);
}

pub fn set_standing(world: &mut World, events: &mut EventQueue, depot: EntityId, on: bool) {
    if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
        b.standing = on;
    }
    // Its rules, read now they may buy.
    top_up(world, depot);
    for lorry in lorries_of(world, depot) {
        events.wake(0, lorry);
    }
}

/// The tap: the first of the depot's lorries standing in its yard goes.
pub fn send(world: &mut World, events: &mut EventQueue, depot: EntityId) {
    let lorry = lorries_of(world, depot).into_iter().find(|&l| car(world, l).is_some_and(|c| c.trip.is_none()) && world.claims.get(&l) == Some(&depot));
    if let Some(lorry) = lorry.or_else(|| lorry_of(world, depot)) {
        world.sent.insert(lorry);
        events.wake(0, lorry);
    }
}

/// A depot's lorries, by id.
pub fn lorries_of(world: &World, depot: EntityId) -> Vec<EntityId> {
    world.objects.iter().filter(|e| matches!(e.object, GameObject::Car(ref c) if c.role == CarRole::Truck && c.owner == depot)).map(|e| e.id).collect()
}

/// What a lorry costs from the world: a vehicle is an import like any
/// other, paid as it is bought.
pub const LORRY_PRICE: f64 = 40.0;
/// Lorries a depot can keep beyond its own: its yard has eight docks, and
/// its vans want two of them.
pub const MORE_LORRIES: u8 = 3;

/// Buy the depot another lorry from the world, while its yard has a dock
/// for one and the treasury can pay. It stands in the yard at once, with
/// the depot's standing orders.
pub fn buy_lorry(world: &mut World, events: &mut EventQueue, depot: EntityId, now: GameTime) {
    let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) else { return };
    if !crate::economy::depot(b.kind) || b.lorries >= MORE_LORRIES || world.treasury < LORRY_PRICE {
        return;
    }
    b.lorries += 1;
    crate::economy::bought(world, depot, LORRY_PRICE, now);
    crate::calls::stable(world, depot);
    call_lorries(world, events);
}

pub fn sell(world: &mut World, events: &mut EventQueue, depot: EntityId, good: Good) {
    let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) else { return };
    let queued = b.selling.iter().filter(|&&g| g == good).count() as f64;
    if b.stocks.get(&good).is_some_and(|s| s.level >= (queued + 1.0) * good.per_box() * 0.5) {
        b.selling.push(good);
    }
    send(world, events, depot);
}


/// The sea as the server has it, for reading: the summary the client gets,
/// every harbour's park and ferry, and every lorry and what it hauls.
pub fn inspect(world: &World, now: GameTime) -> serde_json::Value {
    use serde_json::json;
    let harbours: Vec<_> = world
        .harbours
        .keys()
        .map(|&h| {
            let park = building(world, h).map(|b| b.park.iter().map(|s| s.trailer).collect::<Vec<_>>());
            let ferry = world.ferry_of(h).and_then(|f| car(world, f).map(|c| json!({
                "id": f, "at": world.objects.get(f).and_then(|e| e.position), "due": c.due, "moored": c.spot.is_some(),
                "sailing": c.sail.is_some(), "deck": c.deck, "passengers": c.passengers, "booked": c.booked,
            })));
            let tug = world.tug_of(h).and_then(|t| car(world, t).map(|c| json!({ "id": t, "spot": c.spot, "shunt": c.shunt, "hitched": c.hitched })));
            json!({ "harbour": h, "park": park, "ferry": ferry, "tug": tug })
        })
        .collect();
    let lorries: Vec<_> = world
        .objects
        .iter()
        .filter_map(|e| match e.object {
            GameObject::Car(ref c) if c.role == CarRole::Truck => Some(json!({
                "id": e.id, "depot": c.owner, "at": e.position, "to": c.trip.as_ref().map(|t| t.destination),
                "hitched": c.hitched, "standing_at": world.claims.get(&e.id),
            })),
            _ => None,
        })
        .collect();
    json!({ "now": now, "summary": sea(world), "harbours": harbours, "lorries": lorries })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{BuildingKind, GridCoord, TerrainType};

    #[test]
    fn a_rule_buys_only_the_boxes_the_shelf_has_room_for() {
        // Crates keep 80, fill to 200, on a shelf of 200, with 20 left:
        // two boxes of a hundred would fill it, but the second could
        // never be fetched, and would stand in the park, paid for.
        let mut world = World::new();
        for y in -8..41 {
            for x in -60..100 {
                world.terrain.insert((x, y), if y >= 3 { TerrainType::Sea } else { TerrainType::Grass });
            }
        }
        world.place_road_path(&(-4..40).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>());
        let harbour = world.place_on_street(GridCoord { x: 10, y: 1 }, BuildingKind::Harbour).expect("the coast takes a harbour");
        let depot = world.place_on_street(GridCoord { x: 20, y: -4 }, BuildingKind::Depot).expect("a depot by the street");
        if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
            b.rules = first_rules();
            for (g, s) in b.stocks.iter_mut() {
                s.level = if *g == Good::Crates { 20.0 } else { s.cap };
            }
        }
        world.treasury = 10_000.0;
        // Its ferry, without the starter pack, which would count as on its way.
        world.mark_harbours(0);
        let ferry = world.ferry_of(harbour).expect("the harbour's ferry");
        if let Some(GameObject::Car(c)) = world.objects.get_mut(ferry).map(|e| &mut e.object) {
            c.booked.clear();
        }
        // Drawn, its rules spend nothing until the mayor gives it standing
        // orders; then they buy, and the news says what, why and for how much.
        let booked = |world: &World| match world.objects.get(ferry).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.booked.iter().filter(|t| t.good == Good::Crates).count(),
            _ => panic!("no ferry"),
        };
        top_up(&mut world, depot);
        assert_eq!((booked(&world), world.news.len()), (0, 0), "a rule bought without standing orders");
        if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
            b.standing = true;
        }
        top_up(&mut world, depot);
        assert_eq!(booked(&world), 1);
        let news = &world.news[0];
        assert_eq!((news.text.as_str(), news.at), ("Depot ordered 100 crates", depot));
        assert_eq!(news.sub, format!("under its keep line of 80, −{:.0} as it lands", crate::economy::quote(Good::Crates, 1)));
    }
}
