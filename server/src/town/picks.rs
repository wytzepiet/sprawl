//! What comes to the mayor's hand: a chain arrives from its raw end, the
//! first of each kind as the town first wants what it makes; and every
//! `PICK_STEP` people moving in or up, a pick of two or three cards, the
//! one the town most needs always among them. The game waits while a
//! pick is on the table.

use model::blueprint::{blueprint, maker};
use std::collections::BTreeMap;

use model::{BuildingKind, EntityId, Good, Offer, Unlock};
use crate::world::World;
use super::{of_kind, PICK_ROADS, PICK_STEP};

/// A kind the town now wants: met, and what it is made from met first.
/// It comes to hand once what feeds it stands (`release`).
pub fn unlock(world: &mut World, kind: BuildingKind) {
    if !world.town.met.insert(kind) {
        return;
    }
    world.town.waiting.insert(kind);
    for &(g, _) in blueprint(kind).takes {
        unlock(world, maker(g));
    }
    release(world);
}

/// Every kind waiting whose feeders all stand comes to hand, one of it,
/// with a word of why.
pub fn release(world: &mut World) {
    let standing = |k: BuildingKind| world.map.objects.of_kind(k).next().is_some();
    let ready: Vec<BuildingKind> = world.town.waiting.iter().copied().filter(|&k| blueprint(k).takes.iter().all(|&(g, _)| standing(maker(g)))).collect();
    for kind in ready {
        world.town.waiting.remove(&kind);
        *world.town.hand.entry(kind).or_default() += 1;
        world.news.push(model::News { text: format!("A {} to place", name(kind)), sub: why(kind).into(), at: 0 });
    }
}

/// A card of the pick taken.
pub fn pick(world: &mut World, n: u8, now: model::GameTime) {
    let town = &mut world.town;
    let Some(&card) = town.offer.get(n as usize) else { return };
    match card {
        Offer::Building(kind, k) => *town.hand.entry(kind).or_default() += k,
        Offer::Roads(k) => town.allowance += k,
        Offer::Lorry(k) => town.lorries += k,
        Offer::Tool(u) => {
            town.tools.insert(u);
        }
    }
    town.offer.clear();
    // The next pick is ten more people from now: growth while one was on
    // the table does not stack a second behind it.
    town.picked = town.arrived.max(town.picked + PICK_STEP);
    town.left_since = 0;
    offer(world, now);
}

/// Every `PICK_STEP` people moving in or up, the mayor is offered a pick:
/// what the town most lacks always among it, the rest by chance weighted
/// by need; a wider one when nobody left since the last.
pub fn offer(world: &mut World, now: model::GameTime) {
    let town = &world.town;
    if !town.offer.is_empty() || town.arrived < town.picked + PICK_STEP {
        return;
    }
    let mut cands = candidates(world, now);
    let want = if world.town.left_since == 0 { 3 } else { 2 };
    cands.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut out = vec![cands.remove(0).0];
    while out.len() < want && !cands.is_empty() {
        let total: f64 = cands.iter().map(|c| c.1).sum();
        let mut r = world.town.roll() * total;
        let mut k = 0;
        while k + 1 < cands.len() && r > cands[k].1 {
            r -= cands[k].1;
            k += 1;
        }
        out.push(cands.remove(k).0);
    }
    world.town.offer = out;
}

/// Every card the town could be offered, and how much it needs it: a
/// kind by how many more of it the town's demand calls for (`rates`),
/// and by the waits it would fix at their root; a shop by the families
/// on a street no shop reaches, and the waits where the goods are made
/// but not brought; road by how little is left, a tool once.
pub(super) fn candidates(world: &World, now: model::GameTime) -> Vec<(Offer, f64)> {
    let map = &world.map;
    let rates = rates(world);
    let mut weight: BTreeMap<BuildingKind, f64> = Default::default();
    // More makers where the town wants more than they can make, by how
    // many more it would take.
    for (&g, f) in &rates {
        let one = 60_000.0 / blueprint(maker(g)).every as f64;
        let more = ((f.could - f.make) / one).max(0.0);
        *weight.entry(maker(g)).or_default() += 4.0 * more.min(6.0);
    }
    // Each family's wait, at what it is short of: a want waited on a while
    // three times what the house grows with.
    // A want its car is out for already is held up on the road: the
    // tools that move traffic help it, not another building.
    let mut jammed = 0.0;
    let mut haul = 0.0;
    for (id, _) in of_kind(map, BuildingKind::House) {
        let Some(h) = map.building(id).and_then(|b| b.home.as_ref()) else { continue };
        jammed += h.wants.iter().filter(|w| w.by.is_some() && now >= w.since + super::homes::PATIENCE_MS / 2).count() as f64;
        let waits = h.wants.iter().filter(|w| w.by.is_none() && now >= w.since + super::homes::PATIENCE_MS / 3).map(|w| (w.good, 3.0)).chain(h.growing.iter().flat_map(|g| g.iter().filter(|(_, s)| s.short() >= 1.0).map(|(&g, _)| (g, 1.0))));
        for (g, w) in waits.collect::<Vec<_>>() {
            match short_of(world, &rates, id, g) {
                Short::Make(k) => *weight.entry(k).or_default() += w,
                Short::Haul => haul += w,
                Short::Shelved => {}
            }
        }
    }
    let homes: Vec<EntityId> = of_kind(map, BuildingKind::House).into_iter().map(|(id, _)| id).collect();
    let unserved = homes.iter().filter(|&&h| map.street_of(h).is_some() && super::homes::shop_for(world, h, &[Good::Fish], 0).is_none()).count() as f64;
    *weight.entry(BuildingKind::Shop).or_default() += unserved * 1.5;
    let mut cands: Vec<(Offer, f64)> = world.town.met.iter().map(|&k| (Offer::Building(k, 1), 1.0 + weight.get(&k).copied().unwrap_or(0.0) * 2.0)).collect();
    // A lorry, while anything runs fewer than it has docks for: by the
    // waits where the goods are made but not brought.
    let room = map.objects.iter().any(|e| matches!(e.object, model::GameObject::Building(ref b) if b.kind != BuildingKind::House && super::trucks(map, e.id) < blueprint(b.kind).docks() as u32 && blueprint(b.kind).lorries > 0));
    if room {
        cands.push((Offer::Lorry(1), 1.0 + haul * 2.0));
    }
    // Every lorry it may run running: another shop, with its own.
    // And a shop to every dozen houses or so: past that its bays and its
    // lorries are a queue.
    let shops = of_kind(map, BuildingKind::Shop).len().max(1) as f64;
    let crowd = (homes.len() as f64 / shops - 12.0).max(0.0) * 0.5;
    if let Some(c) = cands.iter_mut().find(|c| c.0 == Offer::Building(BuildingKind::Shop, 1)) {
        c.1 += 2.0 * (crowd + if room { 0.0 } else { haul });
    }
    let roads = world.town.roads(map);
    cands.push((Offer::Roads(PICK_ROADS), (if roads < 10 { 8.0 } else { 2.0 }) + jammed));
    let status = world.town.status;
    // Road tools once a town has the traffic for them: a hamlet's lanes
    // want more road, not lights.
    for (u, from, w) in [(Unlock::Priority, 1, 2.0), (Unlock::Overpass, 2, 2.5), (Unlock::Lights, 2, 2.0), (Unlock::OneWay, 2, 1.5), (Unlock::Wide, 3, 1.5)] {
        if status >= from && !world.town.tools.contains(&u) {
            cands.push((Offer::Tool(u), w + jammed));
        }
    }
    cands
}

/// A good's flow, a minute: what the families who eat it want, what
/// every family would at its level, and what its makers could make at a
/// full crew. Down the chains, what a maker takes at the pace its own
/// good goes (`taken`), or would (`could`).
#[derive(Debug, Clone, Copy, Default)]
pub struct Rate {
    pub taken: f64,
    pub could: f64,
    pub make: f64,
}

/// Each good the town uses, a minute (`Rate`).
pub fn rates(world: &World) -> BTreeMap<Good, Rate> {
    let map = &world.map;
    let mut r: BTreeMap<Good, Rate> = BTreeMap::new();
    for (id, _) in of_kind(map, BuildingKind::House) {
        let Some(h) = map.building(id).and_then(|b| b.home.as_ref()) else { continue };
        for &(g, every) in super::homes::LEVELS[h.level as usize].wants {
            let e = r.entry(g).or_default();
            e.could += 60_000.0 / every as f64;
            if h.due.contains_key(&g) {
                e.taken += 60_000.0 / every as f64;
            }
        }
    }
    let makers: Vec<&model::blueprint::Blueprint> = map.objects.iter().filter_map(|e| match e.object {
        model::GameObject::Building(ref b) => Some(blueprint(b.kind)),
        _ => None,
    }).filter(|row| row.makes.is_some()).collect();
    for row in &makers {
        r.entry(row.makes.unwrap()).or_default().make += 60_000.0 / row.every as f64;
    }
    // Down the chains, a link further each time round.
    let base: BTreeMap<Good, Rate> = r.clone();
    for _ in 0..4 {
        let mut next = base.clone();
        for row in &makers {
            let f = r[&row.makes.unwrap()];
            let full = 60_000.0 / row.every as f64;
            let pace = |w: f64| if f.make > 0.0 { full * (w / f.make).min(1.0) } else { 0.0 };
            for &(i, n) in row.takes {
                let e = next.entry(i).or_default();
                e.taken += pace(f.taken) * n as f64;
                e.could += pace(f.could) * n as f64;
            }
        }
        for (g, n) in next {
            let e = r.entry(g).or_default();
            (e.taken, e.could) = (n.taken, n.could);
        }
    }
    r
}

/// What a family's wait comes down to.
#[derive(Debug)]
pub(super) enum Short {
    /// Too few of a kind, or none: whoever makes it, at its root.
    Make(BuildingKind),
    /// Made, sitting in a yard, and not brought to the shelf: lorries.
    Haul,
    /// On its shop's shelf: the car goes soon.
    Shelved,
}

/// What a family waiting on a good is short of: whoever makes it, at its
/// root, if the town's makers cannot make as much as is wanted; else
/// nothing, if its shop has it on the shelf; else lorries, if it sits in
/// a maker's yard with no lorry come for it yet; else a shop, if none
/// within reach sells it; else whoever makes it.
pub(super) fn short_of(world: &World, rates: &BTreeMap<Good, Rate>, home: EntityId, good: Good) -> Short {
    let map = &world.map;
    let f = rates.get(&good).copied().unwrap_or_default();
    if f.make < f.taken {
        return Short::Make(root(world, rates, good, 0));
    }
    let Some(shop) = super::homes::shop_for(world, home, &[good], 0) else { return Short::Make(BuildingKind::Shop) };
    if super::stock(map, shop, good) >= 1.0 {
        return Short::Shelved;
    }
    if of_kind(map, maker(good)).into_iter().map(|(id, _)| super::stock(map, id, good)).sum::<f64>() >= 3.0 {
        return Short::Haul;
    }
    Short::Make(root(world, rates, good, 0))
}

/// Where a shortage of a good really comes from: what its makers take,
/// if too little of that is made, or they wait on it (follow that input);
/// else too few makers.
fn root(world: &World, rates: &BTreeMap<Good, Rate>, good: Good, depth: u32) -> BuildingKind {
    let kind = maker(good);
    if depth > 4 {
        return kind;
    }
    let f = rates.get(&good).copied().unwrap_or_default();
    let (want, make) = (f.taken, f.make);
    let under = |g: Good| rates.get(&g).is_some_and(|f| f.make < f.taken);
    let starved = world.map.objects.of_kind(kind).filter_map(|id| world.map.building(id)).find_map(|b| blueprint(kind).takes.iter().find(|&&(g, n)| under(g) || b.stocks.get(&g).is_none_or(|s| s.level < n as f64)).map(|&(g, _)| g));
    match starved {
        // Its makers could make it all, but go without what they take.
        Some(g) if make >= want || under(g) => root(world, rates, g, depth + 1),
        _ => kind,
    }
}

fn name(kind: BuildingKind) -> String {
    match kind {
        BuildingKind::ClayPit => "clay pit".into(),
        BuildingKind::SandPit => "sand pit".into(),
        BuildingKind::SheepFarm => "sheep farm".into(),
        k => format!("{k:?}").to_lowercase(),
    }
}

/// Why a kind came to hand, in a line.
fn why(kind: BuildingKind) -> &'static str {
    use BuildingKind::*;
    match kind {
        House => "",
        Shop => "families buy what they want at a shop; its lorry fetches it",
        Fishery => "it catches fish off the shore",
        Woodcutter => "it cuts logs from the forest round it",
        Sawmill => "a cottage grows with planks; a sawmill saws them from logs",
        Farm => "a farm on open grass grows wheat",
        Bakery => "houses want bread; a bakery bakes it from wheat",
        ClayPit => "it digs clay where the ground is ochre",
        Brickworks => "a house grows with bricks, fired from clay and logs",
        Workshop => "townhouses want furniture, made from planks",
        SandPit => "it digs sand on the beach",
        Glassworks => "a townhouse grows with glass, from sand over a wood fire",
        SheepFarm => "sheep on open grass give wool",
        Tailor => "apartments want clothes, sewn from wool",
    }
}
