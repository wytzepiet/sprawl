//! The sea's side of goods: every package and where it is, the
//! harbours' timetables for the client, and the depots' fleets
//! (docs/plan-goods.md, docs/shipping.md §Boxes and lorries). What the
//! vans and lorries do is `logistics.rs`.

use std::collections::BTreeMap;

use traffic::event_queue::EventQueue;
use model::GameTime;
use model::{CarRole, EntityId, GameObject, Leg, Package, Sailing, Sea, Shipment};
use crate::world::World;

/// Packages a lorry's flatbed carries.
pub const LOAD: u32 = 5;

/// Every package in the world, and where it is: the shipments list, read
/// off every place a package can be.
pub fn packages(world: &World) -> Vec<(Package, Leg, Option<EntityId>)> {
    let mut out = Vec::new();
    for e in world.map.objects.iter() {
        match e.object {
            GameObject::Car(ref c) => {
                out.extend(c.booked.iter().map(|&t| (t, Leg::Booked, Some(e.id))));
                out.extend(c.deck.iter().flatten().map(|&t| (t, Leg::Aboard, Some(e.id))));
                let home = world.map.claims.get(&e.id) == Some(&c.owner);
                out.extend(c.cargo.iter().map(|&t| (t, if home { Leg::Yard } else { Leg::Hauled }, Some(e.id))));
            }
            GameObject::Building(ref b) => out.extend(b.pad.iter().map(|&t| (t, Leg::Quay, Some(e.id)))),
            _ => {}
        }
    }
    out
}

/// The harbour a depot books through: the nearest standing, by its tile.
pub fn harbour_for(world: &World, depot: EntityId) -> Option<EntityId> {
    let at = world.map.objects.get(depot)?.position?;
    world.map
        .harbours
        .keys()
        .filter_map(|&h| Some((h, world.map.objects.get(h)?.position?)))
        .min_by_key(|&(h, p)| ((p.x - at.x).abs() + (p.y - at.y).abs(), h))
        .map(|(h, _)| h)
}

/// The sea's part of an update: every package with an order, where it is
/// and when it lands; every harbour's timetable.
pub fn sea(world: &World) -> Sea {
    let calls: BTreeMap<EntityId, Option<GameTime>> = world.map.harbours.keys().flat_map(|&h| world.ferries_of(h)).map(|f| (f, world.next_call(f))).collect();
    let shipments = packages(world)
        .into_iter()
        .map(|(t, leg, carrier)| {
            let c = carrier.and_then(|id| world.map.car(id));
            let eta = match leg {
                Leg::Booked => carrier.and_then(|f| calls.get(&f).copied().flatten()),
                Leg::Aboard => c.map(|c| c.due).filter(|_| c.is_some_and(|c| c.spot.is_none())),
                Leg::Hauled => c.and_then(|c| c.trip.as_ref()).map(|t| t.eta),
                _ => None,
            };
            Shipment { order: t.order, partner: t.partner, price: t.price, package: t.id, good: t.good, to: t.to, outbound: t.outbound, leg, carrier, at: carrier.and_then(|id| world.map.objects.get(id)?.position), eta }
        })
        .collect();
    let sailings = world.map
        .harbours
        .keys()
        .filter_map(|&harbour| {
            let h = world.map.building(harbour)?;
            let ferry = world.ferry_of(harbour)?;
            let c = world.map.car(ferry)?;
            let berthed = c.spot.is_some();
            let arrives = if berthed { c.due - traffic::sea::DWELL } else { c.due };
            let departs = arrives + traffic::sea::DWELL;
            Some(Sailing {
                harbour,
                ferry,
                arrives,
                departs,
                berthed,
                packages: c.deck.iter().flatten().count() as u32,
                settlers: c.passengers.len() as u32,
                deck: map::sea::DECK as u32,
                booked: c.booked.len() as u32,
                waiting: world.waiting_settlers(harbour).len() as u32,
                lands: world.next_ferry(harbour).and_then(|f| world.next_call(f))?,
                turn: world.turn(harbour)?,
                outgoing: h.outgoing.clone(),
            })
        })
        .collect();
    let lanes = world.lanes.as_ref().map_or(Vec::new(), |lanes| world.lines.values().flat_map(|l| &l.legs).flat_map(|leg| lanes.drawn(leg)).collect());
    Sea { shipments, sailings, lanes }
}

/// What a lorry or a van costs from the world: a vehicle is an import
/// like any other, paid as it is bought.
pub const LORRY_PRICE: f64 = 40.0;
/// Vehicles a depot can keep beyond its own lorry and two vans: its yard
/// has eight docks.
pub const MORE_LORRIES: u8 = 5;

/// Buy the depot another lorry, to fetch, or another van, to deliver,
/// from the world, while its yard has a dock for one and the treasury
/// can pay. It stands in the yard at once, and goes about the depot's
/// work.
pub fn buy(world: &mut World, events: &mut EventQueue, depot: EntityId, role: CarRole, now: GameTime) {
    let treasury = world.treasury;
    let Some(b) = world.map.building_mut(depot) else { return };
    if !model::blueprint::depot(b.kind) || b.lorries + b.vans >= MORE_LORRIES || treasury < LORRY_PRICE {
        return;
    }
    match role {
        CarRole::Truck => b.lorries += 1,
        CarRole::Van => b.vans += 1,
        _ => return,
    }
    crate::economy::bought(world, depot, LORRY_PRICE, now);
    world.map.stable(depot);
    crate::logistics::turn(world, events, depot, now);
}

/// The sea as the server has it, for reading: the summary the client gets,
/// every harbour's quay, forklifts and ferry, and every lorry and what it
/// carries.
pub fn inspect(world: &World, now: GameTime) -> serde_json::Value {
    use serde_json::json;
    let harbours: Vec<_> = world.map
        .harbours
        .keys()
        .map(|&h| {
            let quay = world.map.building(h).map(|b| (b.pad.clone(), b.lifts.clone()));
            let ferry = world.ferry_of(h).and_then(|f| world.map.car(f).map(|c| json!({
                "id": f, "at": world.map.objects.get(f).and_then(|e| e.position), "due": c.due, "moored": c.spot.is_some(),
                "sailing": c.sail.is_some(), "deck": c.deck, "passengers": c.passengers, "booked": c.booked,
            })));
            json!({ "harbour": h, "quay": quay.as_ref().map(|q| &q.0), "lifts": quay.as_ref().map(|q| &q.1), "ferry": ferry })
        })
        .collect();
    let lorries: Vec<_> = world.map
        .objects
        .iter()
        .filter_map(|e| match e.object {
            GameObject::Car(ref c) if c.role == CarRole::Truck => Some(json!({
                "id": e.id, "depot": c.owner, "at": e.position, "to": c.trip.as_ref().map(|t| t.destination),
                "cargo": c.cargo, "errand": c.errand, "due": c.due, "standing_at": world.map.claims.get(&e.id),
            })),
            _ => None,
        })
        .collect();
    let mut market = world.market.prices();
    market.goods.iter_mut().for_each(|q| q.history.clear());
    json!({ "now": now, "summary": sea(world), "market": market, "harbours": harbours, "lorries": lorries })
}
