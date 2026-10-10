//! Boxes between the harbour and the depots, and the rules that order
//! them (docs/trade.md §Top-up, docs/shipping.md §Boxes and lorries).
//!
//! A depot's lorry hauls the world's boxes. It goes to the harbour when it
//! is sent, by the mayor's tap, or of its own accord once it has standing
//! orders: when a box for its depot, or for the town, stands in the park,
//! or when its depot has a box to sell. It takes with it whatever it has
//! on the hitch, an export filled from the depot's shelf or an empty, and
//! drops it in a free dock for the ferry, drop and hook: then it backs
//! under the box it came for and drives it home, where the box is
//! unloaded onto the shelf, as much as fits, and the empty stays on the
//! hitch for the next trip out. Nothing about an errand is remembered: a
//! lorry reads what it should do from where it is and what it carries,
//! as a resident does.
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
/// town's meals, and a tank box for the vans.
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
    boxes(world).iter().filter(|(t, _, _)| t.to.is_none_or(|d| d == depot) && t.good == Some(good) && !t.outbound).map(|(t, _, _)| t.units).sum()
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
    let Some(ferry) = harbour_for(world, depot).and_then(|h| world.ferry_of(h)) else { return 0 };
    let owed: f64 = self::boxes(world).iter().filter(|(t, l, _)| !t.outbound && matches!(l, Leg::Booked | Leg::Aboard) && t.order != Some(crate::world::sea::GIFT)).map(|(t, _, _)| t.good.map_or(0.0, |g| crate::economy::import(g, t.units))).sum();
    let afford = ((world.treasury - owed) / crate::economy::quote(good, 1)).floor().max(0.0) as u32;
    let n = boxes.min(afford);
    if n == 0 {
        return 0;
    }
    let order = world.objects.reserve_id();
    let ids: Vec<u64> = (0..n).map(|_| world.objects.reserve_id()).collect();
    if let Some(GameObject::Car(c)) = world.objects.get_mut(ferry).map(|e| &mut e.object) {
        for id in ids {
            c.booked.push(Trailer { id, good: Some(good), units: good.per_box(), to: Some(depot), outbound: false, order: Some(order) });
        }
    }
    n
}

/// A depot's rules, read: for each good under its floor with what is
/// already on its way, boxes enough to fill it are booked.
pub fn top_up(world: &mut World, depot: EntityId) {
    let Some(b) = building(world, depot) else { return };
    if b.site.is_some() {
        return;
    }
    let rules: Vec<(Good, Rule, f64)> = b.rules.iter().filter_map(|(&g, &r)| Some((g, r, b.stocks.get(&g)?.level))).collect();
    for (good, rule, level) in rules {
        // What a maker in town has a load of comes from it, by the depot's
        // own fetch, not from over the sea.
        if made_in_town(world, good) {
            continue;
        }
        let have = level + incoming(world, depot, good);
        if have < rule.keep {
            let boxes = ((rule.fill - have) / good.per_box()).ceil().max(1.0) as u32;
            book(world, depot, good, boxes);
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
fn waiting_for(world: &World, depot: EntityId) -> Option<(EntityId, usize)> {
    let at = world.objects.get(depot)?.position?;
    let taken: Vec<(EntityId, usize)> = world.aims.iter().filter(|&(&l, _)| car(world, l).is_some_and(|c| c.owner != depot)).map(|(_, &a)| a).collect();
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
                s.trailer.is_some_and(|t| !t.outbound && !t.empty() && t.good.is_some_and(|g| room(g, t.units)) && (t.to == Some(depot) || t.to.is_none_or(|d| world.objects.get(d).is_none())))
            });
            let i = i.filter(|&i| !taken.contains(&(h, i)))?;
            Some(((p.x - at.x).abs() + (p.y - at.y).abs(), h, i))
        })
        .min()
        .map(|(_, h, i)| (h, i))
}

/// An empty standing in a park, for a lorry that has a box to sell and no
/// box to put it in.
fn empty_at(world: &World, harbour: EntityId) -> Option<usize> {
    building(world, harbour)?.park.iter().position(|s| s.trailer.is_some_and(|t| t.empty()))
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

/// Has the depot something to fill an empty with: its own shelf over a
/// sell line, or a maker's yard of what it sells.
fn wants_empty(world: &World, depot: EntityId) -> bool {
    to_sell(world, depot).is_some() || maker_with_surplus(world, depot).is_some()
}

/// A maker in town has a box's worth of this good in its yard.
fn made_in_town(world: &World, good: Good) -> bool {
    world.objects.iter().any(|e| matches!(e.object, GameObject::Building(ref b) if blueprint(b.kind).makes == Some(good) && b.stocks.get(&good).is_some_and(|s| s.level >= good.per_box())))
}

/// Does the depot sell this good: a rule with a line to sell over.
fn sells(world: &World, depot: EntityId, good: Good) -> bool {
    building(world, depot).is_some_and(|b| b.rules.get(&good).is_some_and(|r| r.sell.is_some()))
}

/// The nearest maker in town with a box's worth in its yard of a good the
/// depot sells, by the tiles between them.
fn maker_with_surplus(world: &World, depot: EntityId) -> Option<EntityId> {
    let at = world.objects.get(depot)?.position?;
    world
        .objects
        .iter()
        .filter_map(|e| match e.object {
            GameObject::Building(ref b) => {
                let good = blueprint(b.kind).makes.filter(|&g| sells(world, depot, g))?;
                (b.stocks.get(&good)?.level >= good.per_box() && world.street_of(e.id).is_some()).then_some((e.id, e.position?))
            }
            _ => None,
        })
        .min_by_key(|&(id, p)| ((p.x - at.x).abs() + (p.y - at.y).abs(), id))
        .map(|(id, _)| id)
}

/// The lorry woke, parked: at the end of its service where it stands, or
/// called. At home it unloads what it brought, fills an empty with what
/// is sold, and sets out if there is a reason to; at a harbour it drops
/// what it brought and hooks what it came for, and goes home.
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
        // At a maker's yard with an empty: filled with what the depot
        // sells, and on to the harbour with it.
        let good = building(world, at).and_then(|b| blueprint(b.kind).makes).filter(|&g| sells(world, depot, g));
        if let (Some(good), Some(t)) = (good, hitched.filter(|t| t.empty())) {
            let units = crate::economy::loaded(world, at, good, good.per_box());
            if units > 0.0 {
                let order = world.objects.reserve_id();
                set_load(world, lorry, Some(Trailer { good: Some(good), units, to: None, outbound: true, order: Some(order), ..t }));
                crate::calls::turn(world, events, at, now);
                let harbour = harbour_for(world, depot);
                let gone = harbour.zip(world.street_of(at)).is_some_and(|(h, door)| crate::car::spawn::start_trip(world, events, lorry, door, h, now, GameTime::MAX));
                if !gone {
                    events.wake(crate::calls::RETRY_MS, lorry);
                }
                return;
            }
        }
        return go_home(world, events, lorry, at, now);
    }
    crate::economy::refilled(world, lorry, now);
    // Home. A box from the harbour is unloaded onto the shelf, what fits.
    if let Some(t) = hitched.filter(|t| !t.outbound && !t.empty()) {
        let good = t.good.unwrap();
        let left = crate::economy::delivered(world, depot, good, t.units);
        let landed = t.units - left;
        set_load(world, lorry, if left > 0.0 { Some(Trailer { units: left, ..t }) } else { Some(Trailer { good: None, units: 0.0, to: None, order: None, ..t }) });
        if landed > 0.0 {
            world.lumps.push(crate::protocol::Lump { building: depot, coins: 0.0, gdp: 0.0, at: now, good: Some(good), units: landed });
            crate::calls::turn(world, events, depot, now);
            events.wake(SERVICE_MS, lorry);
            return;
        }
        // The shelf is full: the rest waits on the hitch in the yard
        // until there is room, and the lorry with it.
        if left > 0.0 {
            return;
        }
    }
    let Some(b) = building(world, depot) else { return };
    let (standing, sent) = (b.standing, world.sent.contains(&lorry));
    let selling = to_sell(world, depot);
    let wanted = waiting_for(world, depot);
    if !(standing || sent || b.selling.first().is_some()) {
        return;
    }
    // An empty on the hitch is filled with what is sold, and goes out.
    let hitched = car(world, lorry).and_then(|c| c.hitched);
    if let (Some((good, units)), Some(t)) = (selling, hitched.filter(|t| t.empty())) {
        let units = crate::economy::loaded(world, depot, good, units);
        if units > 0.0 {
            let order = world.objects.reserve_id();
            set_load(world, lorry, Some(Trailer { good: Some(good), units, to: None, outbound: true, order: Some(order), ..t }));
            if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
                if let Some(i) = b.selling.iter().position(|&g| g == good) {
                    b.selling.remove(i);
                }
            }
        }
    }
    let hitched = car(world, lorry).and_then(|c| c.hitched);
    // Still empty, and a maker in town has a load of what the depot sells:
    // the box is filled at the maker's yard and goes straight out, a
    // street turn, not through the depot's shelf.
    if hitched.is_some_and(|t| t.empty())
        && let Some(maker) = maker_with_surplus(world, depot)
        && let Some(door) = world.street_of(depot)
    {
        world.sent.remove(&lorry);
        if !crate::car::spawn::start_trip(world, events, lorry, door, maker, now, GameTime::MAX) {
            events.wake(crate::calls::RETRY_MS, lorry);
        }
        return;
    }
    let outbound = hitched.is_some_and(|t| t.outbound);
    let needs_empty = wants_empty(world, depot) && hitched.is_none();
    if !(outbound || wanted.is_some() || needs_empty || sent) {
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
        (None, None) => {
            if let Some(i) = empty_at(world, harbour) {
                world.aims.insert(lorry, (harbour, i));
            }
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
        (Some(t), None) if t.outbound || t.empty() => {
            if let Some(GameObject::Building(b)) = world.objects.get_mut(harbour).map(|e| &mut e.object) {
                b.park[dock].trailer = Some(Trailer { outbound: true, to: None, ..t });
            }
            set_load(world, lorry, None);
            if let Some(tug) = world.tug_of(harbour) {
                events.wake(0, tug);
            }
            // Dropped: on to the box it came for, if there is one.
            let selling = wants_empty(world, depot);
            match waiting_for(world, depot).filter(|&(h, _)| h == harbour).or_else(|| selling.then(|| empty_at(world, harbour).map(|i| (harbour, i))).flatten()) {
                Some((_, i)) if i != dock => {
                    world.redock(harbour, lorry, i, now);
                    events.wake(SERVICE_MS, lorry);
                }
                _ => go_home(world, events, lorry, harbour, now),
            }
        }
        (None, Some(t)) if !t.outbound && !t.empty() || t.empty() => {
            if let Some(GameObject::Building(b)) = world.objects.get_mut(harbour).map(|e| &mut e.object) {
                b.park[dock].trailer = None;
            }
            // A box for the town is the depot's once its lorry has it.
            let to = if t.empty() { None } else { Some(t.to.unwrap_or(depot)) };
            set_load(world, lorry, Some(Trailer { to, outbound: false, ..t }));
            world.aims.remove(&lorry);
            events.wake(SERVICE_MS, lorry);
        }
        _ => go_home(world, events, lorry, harbour, now),
    }
}

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
pub fn sea(world: &World, now: GameTime) -> Sea {
    let calls: BTreeMap<EntityId, Option<GameTime>> = world.harbours.keys().filter_map(|&h| world.ferry_of(h)).map(|f| (f, world.next_call(f))).collect();
    let shipments = boxes(world)
        .into_iter()
        .filter_map(|(t, leg, carrier)| {
            let order = t.order?;
            let c = carrier.and_then(|id| car(world, id));
            let eta = match leg {
                Leg::Booked => carrier.and_then(|f| calls.get(&f).copied().flatten()),
                Leg::Aboard => c.map(|c| c.due).filter(|_| c.is_some_and(|c| c.spot.is_none())),
                Leg::Hauled => c.and_then(|c| c.trip.as_ref()).map(|t| t.eta),
                _ => None,
            };
            Some(Shipment { order, trailer: t.id, good: t.good, units: t.units, to: t.to, outbound: t.outbound, leg, carrier, at: carrier.and_then(|id| world.objects.get(id)?.position), eta })
        })
        .collect();
    let sailings = world
        .harbours
        .keys()
        .filter_map(|&harbour| {
            let ferry = world.ferry_of(harbour)?;
            let c = car(world, ferry)?;
            let berthed = c.spot.is_some();
            let arrives = if berthed { c.due - crate::world::sea::DWELL } else if c.run.is_some() { c.due } else { c.due };
            let departs = if berthed { c.due } else { arrives + crate::world::sea::DWELL };
            let _ = now;
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
            })
        })
        .collect();
    Sea { shipments, sailings }
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
    if let Some(lorry) = lorry_of(world, depot) {
        events.wake(0, lorry);
    }
}

pub fn send(world: &mut World, events: &mut EventQueue, depot: EntityId) {
    if let Some(lorry) = lorry_of(world, depot) {
        world.sent.insert(lorry);
        events.wake(0, lorry);
    }
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
                "sailing": c.run.is_some(), "deck": c.deck, "passengers": c.passengers, "booked": c.booked,
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
    json!({ "now": now, "summary": sea(world, now), "harbours": harbours, "lorries": lorries })
}
