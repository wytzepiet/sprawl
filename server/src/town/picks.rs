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
    for (&g, &(want, make)) in &rates {
        let one = 60_000.0 / blueprint(maker(g)).every as f64;
        let more = ((want - make) / one).max(0.0);
        *weight.entry(maker(g)).or_default() += 4.0 * more.min(6.0);
    }
    // Each family's wait, at what it is short of: a want waited on a while
    // three times what the house grows with.
    for (id, _) in of_kind(map, BuildingKind::House) {
        let Some(h) = map.building(id).and_then(|b| b.home.as_ref()) else { continue };
        let waits = h.wants.iter().filter(|w| now >= w.since + super::homes::PATIENCE_MS / 3).map(|w| (w.good, 3.0)).chain(h.growing.iter().flat_map(|g| g.iter().filter(|(_, s)| s.short() >= 1.0).map(|(&g, _)| (g, 1.0))));
        for (g, w) in waits.collect::<Vec<_>>() {
            *weight.entry(short_of(world, &rates, id, g)).or_default() += w;
        }
    }
    let homes: Vec<EntityId> = of_kind(map, BuildingKind::House).into_iter().map(|(id, _)| id).collect();
    let unserved = homes.iter().filter(|&&h| map.street_of(h).is_some() && super::homes::shop_for(world, h, &[Good::Fish], 0).is_none()).count() as f64;
    *weight.entry(BuildingKind::Shop).or_default() += unserved * 1.5;
    let mut cands: Vec<(Offer, f64)> = world.town.met.iter().map(|&k| (Offer::Building(k, 1), 1.0 + weight.get(&k).copied().unwrap_or(0.0) * 2.0)).collect();
    let roads = world.town.roads(map);
    cands.push((Offer::Roads(PICK_ROADS), if roads < 10 { 8.0 } else { 2.0 }));
    let status = world.town.status;
    for (u, from, w) in [(Unlock::Priority, 0, 2.0), (Unlock::Lights, 1, 2.0), (Unlock::OneWay, 1, 1.5), (Unlock::Overpass, 1, 2.5), (Unlock::Wide, 2, 1.5)] {
        if status >= from && !world.town.tools.contains(&u) {
            cands.push((Offer::Tool(u), w));
        }
    }
    cands
}

/// Each good the town uses, a minute: how much it wants, and how much
/// its makers could make at a full crew. What families eat, every house
/// at its level; and what a maker takes, at the pace it could make at,
/// or no faster than its own good is wanted.
pub fn rates(world: &World) -> BTreeMap<Good, (f64, f64)> {
    let map = &world.map;
    let mut r: BTreeMap<Good, (f64, f64)> = BTreeMap::new();
    for (id, _) in of_kind(map, BuildingKind::House) {
        let Some(h) = map.building(id).and_then(|b| b.home.as_ref()) else { continue };
        for &(g, every) in super::homes::LEVELS[h.level as usize].wants {
            if h.due.contains_key(&g) {
                r.entry(g).or_default().0 += 60_000.0 / every as f64;
            }
        }
    }
    for e in map.objects.iter() {
        let model::GameObject::Building(ref b) = e.object else { continue };
        let row = blueprint(b.kind);
        if let Some(g) = row.makes {
            r.entry(g).or_default().1 += 60_000.0 / row.every as f64;
        }
    }
    // Down the chains: what a maker takes, at the pace its own good goes,
    // a link further down each time round.
    let base: BTreeMap<Good, f64> = r.iter().map(|(&g, &(w, _))| (g, w)).collect();
    for _ in 0..4 {
        let mut want = base.clone();
        for e in map.objects.iter() {
            let model::GameObject::Building(ref b) = e.object else { continue };
            let row = blueprint(b.kind);
            let Some(g) = row.makes else { continue };
            let (w, make) = r.get(&g).copied().unwrap_or_default();
            let pace = if make > 0.0 { (60_000.0 / row.every as f64) * (w / make).min(1.0) } else { 0.0 };
            for &(i, n) in row.takes {
                *want.entry(i).or_default() += pace * n as f64;
            }
        }
        for (g, w) in want {
            r.entry(g).or_default().0 = w;
        }
    }
    r
}

/// What a family waiting on a good is short of: whoever makes it, at its
/// root, if the town's makers cannot make as much as is wanted; else a
/// shop, if the shop it goes to has it on the shelf, or it sits in a
/// maker's yard with no lorry come for it yet; else whoever makes it.
pub(super) fn short_of(world: &World, rates: &BTreeMap<Good, (f64, f64)>, home: EntityId, good: Good) -> BuildingKind {
    let map = &world.map;
    let (want, make) = rates.get(&good).copied().unwrap_or_default();
    if make < want {
        return root(world, rates, good, 0);
    }
    let shelf = super::homes::shop_for(world, home, &[good], 0).is_some_and(|s| super::stock(map, s, good) >= 1.0);
    let yard = of_kind(map, maker(good)).into_iter().map(|(id, _)| super::stock(map, id, good)).sum::<f64>() >= 3.0;
    if shelf || yard {
        return BuildingKind::Shop;
    }
    root(world, rates, good, 0)
}

/// Where a shortage of a good really comes from: what its makers take,
/// if too little of that is made, or they wait on it (follow that input);
/// else too few makers.
fn root(world: &World, rates: &BTreeMap<Good, (f64, f64)>, good: Good, depth: u32) -> BuildingKind {
    let kind = maker(good);
    if depth > 4 {
        return kind;
    }
    let (want, make) = rates.get(&good).copied().unwrap_or_default();
    let under = |g: Good| rates.get(&g).is_some_and(|&(w, m)| m < w);
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
