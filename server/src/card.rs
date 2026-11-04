//! One card per thing on the map: what it is, who is in it, and where
//! every line points. Every fact here is something that happened on the
//! map; a line that names another thing carries its id, so the reader can
//! go there. docs/game.md, Legibility. Asked for by `ClientMessage::Card`,
//! sent as `ServerMessage::Card`.

use model::card::{Card, Link, LinkKind, Gauge, ResidentCard, CarCard, TripLine, CallLine, BuildingCard, DepotLine, MakerLine, Present, Staff, Served};


use model::blueprint::blueprint;
use crate::calls::Call;
use model::GameTime;
use model::needs::Need;
use model::{Building, BuildingKind, Car, CarRole, EntityId, GameObject, Resident, DAY_MS};
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

fn link(world: &World, id: EntityId) -> Link {
    let (kind, label) = match world.map.objects.get(id).map(|e| &e.object) {
        Some(GameObject::Resident(_)) => (LinkKind::Resident, name(id)),
        Some(GameObject::Building(b)) => (LinkKind::Building, format!("{:?}", b.kind)),
        Some(GameObject::Car(c)) => (LinkKind::Car, match c.role {
            CarRole::Private => name(c.owner) + "'s car",
            CarRole::Van => "Van".into(),
            CarRole::Truck => "Lorry".into(),
            CarRole::Tractor => "Tractor".into(),
            CarRole::Ferry => "Ferry".into(),
        }),
        _ => (LinkKind::Gone, "gone".into()),
    };
    Link { id, label, kind }
}

pub fn card(world: &World, id: EntityId, now: GameTime) -> Card {
    match world.map.objects.get(id).map(|e| &e.object) {
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
        what: format!("{:?}", call.good),
        good: call.good,
        at: link(world, call.at),
        since: hhmm(call.raised),
        answered_by: call.answered_by.map(|c| link(world, c)),
    }
}

fn car(world: &World, id: EntityId, c: &Car, now: GameTime) -> CarCard {
    let owner = world.map.objects.get(c.owner).map(|e| &e.object);
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
    for e in world.map.objects.iter() {
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
    let pos = world.map.objects.get(id).and_then(|e| e.position).filter(|_| b.site.is_some());
    let site = b.site.as_ref();
    let depots = pos.map_or_else(Vec::new, |at| {
        let depots = world.map.depots().into_iter().map(|(d, _)| d);
        world.map.nearest(at, depots).into_iter().filter_map(|(_, d)| {
            let joined = world.map.street_of(d).and_then(|s| world.map.objects.get(s)).is_some_and(|s| matches!(s.object, GameObject::RoadNode(ref n) if n.joined));
            let stocks = world.map.building(d)?.stocks.iter().map(|(&g, s)| (g, s.level)).collect();
            Some(DepotLine { depot: link(world, d), joined, stocks })
        }).collect()
    });
    let makers = pos.map_or_else(Vec::new, |at| {
        let makes = |k: BuildingKind| blueprint(k).makes.is_some_and(|g| site.is_some_and(|s| s.contains_key(&g)));
        let makers = world.map.of_kinds(makes).into_iter().filter(|(_, m)| m.site.is_none()).map(|(m, _)| m);
        world.map.nearest(at, makers).into_iter().filter_map(|(_, m)| {
            let yard = world.map.building(m)?;
            let good = blueprint(yard.kind).makes?;
            Some(MakerLine { maker: link(world, m), kind: yard.kind, good, level: yard.stocks.get(&good).map_or(0.0, |s| s.level) })
        }).collect()
    });
    BuildingCard {
        id,
        building_kind: b.kind,
        reached: world.map.street_of(id).is_some(),
        stocks: b.stocks.iter().map(|(good, s)| Gauge { what: format!("{good:?}"), full: s.level / s.cap }).collect(),
        depots,
        makers,
        here,
        household,
        staff,
        fleet: world.map.objects.fleet(id).filter(|&c| world.map.car(c).is_some_and(|c| c.role != CarRole::Private)).map(|c| link(world, c)).collect(),
        calls: world.calls.iter().filter(|call| call.at == id).map(|call| call_line(world, call)).collect(),
        served: world.books.get(&id).map_or(vec![], |k| k.on(now).served.iter().map(|(&need, &hours_today)| Served { need, hours_today }).collect()),
    }
}
