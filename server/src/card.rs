//! One card per thing on the map: what it is, who is in it, and where
//! every line points. Every fact here is something that happened on the
//! map; a line that names another thing carries its id, so the reader can
//! go there. docs/game.md, Legibility.

use serde_json::{json, Value};

use crate::blueprint::blueprint;
use crate::engine::GameTime;
use crate::protocol::{Building, Car, CarRole, EntityId, GameObject, Resident, DAY_MS};
use crate::world::World;

const FIRST: [&str; 32] = [
    "Ada", "Bram", "Cleo", "Dev", "Elin", "Faye", "Gus", "Hana", "Ivo", "Juno", "Kai", "Lena", "Milo", "Nia", "Otto", "Pia",
    "Quin", "Rosa", "Sem", "Tess", "Uri", "Vera", "Wim", "Xena", "Yara", "Zed", "Ari", "Bea", "Cas", "Dua", "Eli", "Fen",
];
const LAST: [&str; 32] = [
    "Adler", "Bakker", "Cole", "Dijk", "Ekwe", "Frost", "Gale", "Haas", "Ibsen", "Jansen", "Kato", "Lund", "Marsh", "Nkemelu",
    "Ortiz", "Peel", "Quist", "Reyes", "Sato", "Tolan", "Ueda", "Vos", "Wade", "Xu", "Yilmaz", "Zell", "Amsel", "Berg", "Cruz",
    "Dahl", "Ekman", "Falk",
];

/// A resident's name, a fact about their id: the same person every time,
/// nothing stored.
pub fn name(id: EntityId) -> String {
    let h = id.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    format!("{} {}", FIRST[(h >> 20) as usize % FIRST.len()], LAST[(h >> 40) as usize % LAST.len()])
}

fn hhmm(t: GameTime) -> String {
    let day = DAY_MS as u64;
    format!("{:02}:{:02}", (t % day) / (day / 24), (t % (day / 24)) / (day / 24 / 60))
}

/// A line that points at something: its id, what to call it, and what it is.
fn link(world: &World, id: EntityId) -> Value {
    let (kind, label) = match world.objects.get(id).map(|e| &e.object) {
        Some(GameObject::Resident(_)) => ("resident", name(id)),
        Some(GameObject::Building(b)) => ("building", format!("{:?}", b.kind)),
        Some(GameObject::Car(c)) => ("car", match c.role {
            CarRole::Private => name(c.owner) + "'s car",
            CarRole::Van => "Van".into(),
            CarRole::Truck => "Lorry".into(),
            CarRole::Company => "Car".into(),
        }),
        _ => ("gone", "gone".into()),
    };
    json!({ "id": id, "label": label, "kind": kind })
}

pub fn card(world: &World, id: EntityId, now: GameTime) -> Value {
    match world.objects.get(id).map(|e| &e.object) {
        Some(GameObject::Resident(r)) => resident(world, id, r, now),
        Some(GameObject::Car(c)) => car(world, id, c, now),
        Some(GameObject::Building(b)) => building(world, id, b, now),
        _ => json!({ "kind": "gone", "id": id }),
    }
}

fn residents(world: &World) -> impl Iterator<Item = (EntityId, &Resident)> {
    world.objects.iter().filter_map(|e| match e.object {
        GameObject::Resident(ref r) => Some((e.id, r)),
        _ => None,
    })
}

fn resident(world: &World, id: EntityId, r: &Resident, now: GameTime) -> Value {
    // The arithmetic behind the choice is the resident's own inspect; the
    // card wears it.
    let thinking = crate::resident::inspect(world, id, now);
    json!({
        "kind": "resident",
        "id": id,
        "name": name(id),
        "home": link(world, r.home),
        "work": r.work.map(|w| link(world, w)),
        "at": r.at.map(|a| link(world, a)),
        "car": link(world, r.car),
        "wage": r.wage,
        "selected": r.selected,
        "since": hhmm(r.last_update),
        // The tank and the wear are the car's; its card shows them.
        "buckets": thinking["buckets"].as_array().map(|bs| bs.iter().filter(|b| b["need"] != "Fuel" && b["need"] != "Wear").cloned().collect::<Vec<_>>()),
    })
}

fn car(world: &World, id: EntityId, c: &Car, now: GameTime) -> Value {
    let owner = world.objects.get(c.owner).map(|e| &e.object);
    let rider = match owner {
        Some(GameObject::Resident(r)) if r.at == Some(id) => Some(link(world, c.owner)),
        _ => None,
    };
    let trip = c.trip.as_ref().map(|t| json!({
        "to": link(world, t.destination),
        "due": hhmm(t.eta),
        // Against empty roads: what traffic has cost so far.
        "late_s": now.saturating_sub(t.eta) / 1000,
    }));
    let parked_at = if c.trip.is_none() {
        match owner {
            Some(GameObject::Resident(r)) => r.at.filter(|&a| a != id).map(|a| link(world, a)),
            Some(GameObject::Building(_)) => Some(link(world, c.owner)),
            _ => None,
        }
    } else {
        None
    };
    let answering: Vec<Value> = world
        .calls
        .iter()
        .filter(|call| call.answered_by == Some(id))
        .map(|call| json!({ "what": format!("{:?}", call.kind), "for": link(world, call.at), "since": hhmm(call.raised) }))
        .collect();
    json!({
        "kind": "car",
        "id": id,
        "role": c.role,
        "owner": link(world, c.owner),
        "rider": rider,
        "stocks": c.stocks.iter().map(|(need, s)| json!({ "need": need, "full": s.level / s.cap })).collect::<Vec<_>>(),
        "trip": trip,
        "parked_at": parked_at,
        "answering": answering,
    })
}

fn building(world: &World, id: EntityId, b: &Building, now: GameTime) -> Value {
    let bp = blueprint(b.kind);
    let mut here = Vec::new();
    let mut household = Vec::new();
    let mut staff = Vec::new();
    for (rid, r) in residents(world) {
        if r.at == Some(id) {
            here.push(json!({ "who": link(world, rid), "doing": r.selected }));
        }
        if r.home == id {
            household.push(link(world, rid));
        }
        if r.work == Some(id) {
            staff.push(json!({ "who": link(world, rid), "present": r.at == Some(id) }));
        }
    }
    let fleet: Vec<Value> = world
        .objects
        .iter()
        .filter(|e| matches!(e.object, GameObject::Car(ref c) if c.owner == id && c.role != CarRole::Private))
        .map(|e| link(world, e.id))
        .collect();
    let calls: Vec<Value> = world
        .calls
        .iter()
        .filter(|call| call.at == id)
        .map(|call| json!({ "what": format!("{:?}", call.kind), "since": hhmm(call.raised), "answered_by": call.answered_by.map(|c| link(world, c)) }))
        .collect();
    let served: Vec<Value> = bp
        .taps
        .iter()
        .map(|t| {
            let today = world.books.get(&id).and_then(|k| k.on(now).served.get(&t.need).copied()).unwrap_or(0.0);
            json!({ "need": t.need, "hours_today": today })
        })
        .collect();
    json!({
        "kind": "building",
        "id": id,
        "label": format!("{:?}", b.kind),
        "building_kind": b.kind,
        "reached": world.road_node_for_building(id).is_some(),
        "stocks": b.stocks.iter().map(|(need, s)| json!({ "need": need, "full": s.level / s.cap })).collect::<Vec<_>>(),
        "money": (!world.edge.contains(&id)).then(|| crate::economy::inspect(world, id, now)),
        "spots": world.spots_at(id),
        "here": here,
        "household": household,
        "staff": staff,
        "fleet": fleet,
        "calls": calls,
        "served": served,
    })
}
