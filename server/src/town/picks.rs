//! What comes to the mayor's hand: a chain arrives from its raw end, the
//! first of each kind as the town first wants what it makes; and every
//! `PICK_STEP` people moving in or up, a pick of two or three cards, the
//! one the town most needs always among them. The game waits while a
//! pick is on the table.

use model::blueprint::{blueprint, maker};
use model::{BuildingKind, EntityId, GameObject, Good, Offer, Unlock};
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
pub fn pick(world: &mut World, n: u8) {
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
    offer(world);
}

/// Every `PICK_STEP` people moving in or up, the mayor is offered a pick:
/// what the town most lacks always among it, the rest by chance weighted
/// by need; a wider one when nobody left since the last.
pub fn offer(world: &mut World) {
    let town = &world.town;
    if !town.offer.is_empty() || town.arrived < town.picked + PICK_STEP {
        return;
    }
    let mut cands = candidates(world);
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
/// kind by the shortages it would fix at their root, a shop by the
/// families no shop reaches, road by how little is left, a tool once.
fn candidates(world: &World) -> Vec<(Offer, f64)> {
    let map = &world.map;
    let now_waits: Vec<(Good, f64)> = map.objects.iter().filter_map(|e| match e.object {
        GameObject::Building(ref b) => b.home.as_ref(),
        _ => None,
    }).flat_map(|h| h.wants.iter().map(|w| (w.good, 3.0)).chain(h.growing.iter().flat_map(|g| g.iter().filter(|(_, s)| s.short() >= 1.0).map(|(&g, _)| (g, 1.0))))).collect();
    let mut weight: std::collections::BTreeMap<BuildingKind, f64> = Default::default();
    for (g, w) in now_waits {
        *weight.entry(root(world, g, 0)).or_default() += w;
    }
    let homes: Vec<EntityId> = of_kind(map, BuildingKind::House).into_iter().map(|(id, _)| id).collect();
    let unserved = homes.iter().filter(|&&h| super::homes::shop_for(world, h, &[Good::Fish], 0).is_none()).count() as f64;
    let swamped = of_kind(map, BuildingKind::Shop).into_iter().filter(|&(s, _)| map.building(s).is_some_and(|b| b.stocks.values().any(|st| st.level < 1.0 && st.cap > 0.0))).count() as f64;
    *weight.entry(BuildingKind::Shop).or_default() += unserved * 1.5 + swamped * 4.0;
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

/// Where a shortage of a good really comes from: its makers waiting on an
/// input (follow that input), or too few makers.
fn root(world: &World, good: Good, depth: u32) -> BuildingKind {
    let kind = maker(good);
    if depth > 4 {
        return kind;
    }
    let starved = world.map.objects.of_kind(kind).filter_map(|id| world.map.building(id)).find_map(|b| blueprint(kind).takes.iter().find(|&&(g, n)| b.stocks.get(&g).is_none_or(|s| s.level < n as f64)).map(|&(g, _)| g));
    match starved {
        Some(g) => root(world, g, depth + 1),
        None => kind,
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
