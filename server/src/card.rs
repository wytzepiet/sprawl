//! One card per thing on the map: what it is, who is in it, and where
//! every line points. Every fact here is something that happened on the
//! map; a line that names another thing carries its id, so the reader can
//! go there. docs/game.md, Legibility. Asked for by `ClientMessage::Card`,
//! sent as `ServerMessage::Card`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::blueprint::blueprint;
use crate::calls::Call;
use crate::engine::GameTime;
use crate::needs::Need;
use crate::protocol::{Building, BuildingKind, Car, CarRole, EntityId, GameObject, Good, Resident, DAY_MS};
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

/// A time of day as the clock shows it.
pub(crate) fn hhmm(t: GameTime) -> String {
    let day = DAY_MS as u64;
    format!("{:02}:{:02}", (t % day) / (day / 24), (t % (day / 24)) / (day / 24 / 60))
}

/// The card of one thing, by what it is.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Card {
    Resident(ResidentCard),
    Car(CarCard),
    Building(BuildingCard),
    Gone {
        #[ts(type = "number")]
        id: EntityId,
    },
}

/// A line that points at something: its id, what to call it, and what it is.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Link {
    #[ts(type = "number")]
    pub id: EntityId,
    pub label: String,
    pub kind: LinkKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    Resident,
    Building,
    Car,
    Gone,
}

/// How full a tank or a shelf is, 0 to 1, and of what.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Gauge {
    pub what: String,
    pub full: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ResidentCard {
    #[ts(type = "number")]
    pub id: EntityId,
    pub name: String,
    pub home: Link,
    pub work: Option<Link>,
    pub at: Option<Link>,
    pub car: Link,
    pub selected: Option<Need>,
    /// When they last thought.
    pub since: String,
    /// The tank is the car's; its card shows it.
    pub needs: Vec<NeedLine>,
}

/// One need: how full it is, and where it would be met now
/// (`resident::needs`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct NeedLine {
    pub need: Need,
    pub full: f64,
    #[ts(type = "number | null")]
    pub option: Option<EntityId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CarCard {
    #[ts(type = "number")]
    pub id: EntityId,
    pub role: CarRole,
    pub owner: Link,
    pub rider: Option<Link>,
    pub stocks: Vec<Gauge>,
    pub trip: Option<TripLine>,
    pub parked_at: Option<Link>,
    pub answering: Vec<CallLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TripLine {
    pub to: Link,
    pub due: String,
    /// Against empty roads: what traffic has cost so far.
    #[ts(type = "number")]
    pub late_s: u64,
}

/// A call: what for, from where, since when, and the vehicle answering.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CallLine {
    pub what: String,
    pub good: Good,
    pub at: Link,
    pub since: String,
    pub answered_by: Option<Link>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BuildingCard {
    #[ts(type = "number")]
    pub id: EntityId,
    pub building_kind: BuildingKind,
    pub reached: bool,
    pub stocks: Vec<Gauge>,
    /// A site's: where its materials are.
    pub depots: Vec<DepotLine>,
    pub makers: Vec<MakerLine>,
    pub here: Vec<Present>,
    pub household: Vec<Link>,
    pub staff: Vec<Staff>,
    pub fleet: Vec<Link>,
    pub calls: Vec<CallLine>,
    pub served: Vec<Served>,
}

/// A depot, as a site's card lists it: what it has, and whether its
/// street is joined to the harbour.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DepotLine {
    pub depot: Link,
    pub joined: bool,
    pub stocks: BTreeMap<Good, f64>,
}

/// A maker of one of a site's materials, and what is in its yard.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MakerLine {
    pub maker: Link,
    pub kind: BuildingKind,
    pub good: Good,
    pub level: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Present {
    pub who: Link,
    pub doing: Option<Need>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Staff {
    pub who: Link,
    pub present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Served {
    pub need: Need,
    pub hours_today: f64,
}

fn link(world: &World, id: EntityId) -> Link {
    let (kind, label) = match world.objects.get(id).map(|e| &e.object) {
        Some(GameObject::Resident(_)) => (LinkKind::Resident, name(id)),
        Some(GameObject::Building(b)) => (LinkKind::Building, format!("{:?}", b.kind)),
        Some(GameObject::Car(c)) => (LinkKind::Car, match c.role {
            CarRole::Private => name(c.owner) + "'s car",
            CarRole::Van => "Van".into(),
            CarRole::Truck => "Lorry".into(),
            CarRole::Tractor => "Tractor".into(),
            CarRole::Ferry => "Ferry".into(),
            CarRole::Tug => "Tug".into(),
        }),
        _ => (LinkKind::Gone, "gone".into()),
    };
    Link { id, label, kind }
}

pub fn card(world: &World, id: EntityId, now: GameTime) -> Card {
    match world.objects.get(id).map(|e| &e.object) {
        Some(GameObject::Resident(r)) => Card::Resident(resident(world, id, r, now)),
        Some(GameObject::Car(c)) => Card::Car(car(world, id, c, now)),
        Some(GameObject::Building(b)) => Card::Building(building(world, id, b, now)),
        _ => Card::Gone { id },
    }
}

fn resident(world: &World, id: EntityId, r: &Resident, now: GameTime) -> ResidentCard {
    ResidentCard {
        id,
        name: name(id),
        home: link(world, r.home),
        work: r.work.map(|w| link(world, w)),
        at: r.at.map(|a| link(world, a)),
        car: link(world, r.car),
        selected: r.selected,
        since: hhmm(r.last_update),
        needs: crate::resident::needs(world, id, now).into_iter().filter(|n| n.need != Need::Fuel).collect(),
    }
}

fn call_line(world: &World, call: &Call) -> CallLine {
    CallLine {
        what: format!("{:?}", call.kind),
        good: call.good,
        at: link(world, call.at),
        since: hhmm(call.raised),
        answered_by: call.answered_by.map(|c| link(world, c)),
    }
}

fn car(world: &World, id: EntityId, c: &Car, now: GameTime) -> CarCard {
    let owner = world.objects.get(c.owner).map(|e| &e.object);
    let rider = match owner {
        Some(GameObject::Resident(r)) if r.at == Some(id) => Some(link(world, c.owner)),
        _ => None,
    };
    let parked_at = match (&c.trip, owner) {
        (Some(_), _) => None,
        (None, Some(GameObject::Resident(r))) => r.at.filter(|&a| a != id).map(|a| link(world, a)),
        (None, Some(GameObject::Building(_))) => Some(link(world, c.owner)),
        _ => None,
    };
    CarCard {
        id,
        role: c.role,
        owner: link(world, c.owner),
        rider,
        stocks: c.stocks.iter().map(|(need, s)| Gauge { what: format!("{need:?}"), full: s.level / s.cap }).collect(),
        trip: c.trip.as_ref().map(|t| TripLine { to: link(world, t.destination), due: hhmm(t.eta), late_s: now.saturating_sub(t.eta) / 1000 }),
        parked_at,
        answering: world.calls.iter().filter(|call| call.answered_by == Some(id)).map(|call| call_line(world, call)).collect(),
    }
}

fn building(world: &World, id: EntityId, b: &Building, now: GameTime) -> BuildingCard {
    let mut here = Vec::new();
    let mut household = Vec::new();
    let mut staff = Vec::new();
    for e in world.objects.iter() {
        let GameObject::Resident(ref r) = e.object else { continue };
        if r.at == Some(id) {
            here.push(Present { who: link(world, e.id), doing: r.selected });
        }
        if r.home == id {
            household.push(link(world, e.id));
        }
        if r.work == Some(id) {
            staff.push(Staff { who: link(world, e.id), present: r.at == Some(id) });
        }
    }
    // A site's: where its materials are, nearest first. Every depot, and
    // whether its street is joined to the harbour; every maker of one, and
    // its yard.
    let pos = world.objects.get(id).and_then(|e| e.position).filter(|_| b.site.is_some());
    let site = b.site.as_ref();
    let depots = pos.map_or_else(Vec::new, |at| {
        let depots = world.depots().into_iter().map(|(d, _)| d);
        world.nearest(at, depots).into_iter().filter_map(|(_, d)| {
            let joined = world.street_of(d).and_then(|s| world.objects.get(s)).is_some_and(|s| matches!(s.object, GameObject::RoadNode(ref n) if n.joined));
            let stocks = world.building(d)?.stocks.iter().map(|(&g, s)| (g, s.level)).collect();
            Some(DepotLine { depot: link(world, d), joined, stocks })
        }).collect()
    });
    let makers = pos.map_or_else(Vec::new, |at| {
        let makes = |k: BuildingKind| blueprint(k).makes.is_some_and(|g| site.is_some_and(|s| s.contains_key(&g)));
        let makers = world.of_kinds(makes).into_iter().filter(|(_, m)| m.site.is_none()).map(|(m, _)| m);
        world.nearest(at, makers).into_iter().filter_map(|(_, m)| {
            let yard = world.building(m)?;
            let good = blueprint(yard.kind).makes?;
            Some(MakerLine { maker: link(world, m), kind: yard.kind, good, level: yard.stocks.get(&good).map_or(0.0, |s| s.level) })
        }).collect()
    });
    BuildingCard {
        id,
        building_kind: b.kind,
        reached: world.street_of(id).is_some(),
        stocks: b.stocks.iter().map(|(good, s)| Gauge { what: format!("{good:?}"), full: s.level / s.cap }).collect(),
        depots,
        makers,
        here,
        household,
        staff,
        fleet: world.objects.fleet(id).filter(|&c| world.car(c).is_some_and(|c| c.role != CarRole::Private)).map(|c| link(world, c)).collect(),
        calls: world.calls.iter().filter(|call| call.at == id).map(|call| call_line(world, call)).collect(),
        served: blueprint(b.kind)
            .taps
            .iter()
            .map(|t| Served { need: t.need, hours_today: world.books.get(&id).and_then(|k| k.on(now).served.get(&t.need).copied()).unwrap_or(0.0) })
            .collect(),
    }
}
