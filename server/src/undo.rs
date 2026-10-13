//! Undo (docs/game.md §Undo): each player's last actions, kept a while to
//! take back. An action is what one gesture did: a drag of road, a
//! building placed, a building or a drag of road taken down. Taken back,
//! it leaves the town as it was, and gives back what it paid: the stone
//! off the depots' shelves to their shelves, express coins to the purse,
//! a site's delivered materials to the nearest depot. A demolition taken
//! back stands again as it stood, for nothing.
//!
//! The history is the server's, a stack a player, and dies with the
//! process. It is taken back in order, newest first, while it is recent
//! (`WINDOW`); an action something since rests on, someone else's
//! building opening onto a street it laid, or ground it would build on
//! taken since, is refused, with why, and stays.

use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::intersection::IntersectionRegistry;
use crate::protocol::{Build, Building, BuildingKind, EntityId, GameObject, Good, GridCoord, News, OwnerId, Tool, DAY_MS};
use crate::world::World;

/// How long an action may be taken back: five minutes of play, a quarter
/// of the town's day. Long enough to see a slip for what it is; short
/// enough that undo is never a demolition with the materials back.
pub const WINDOW: GameTime = DAY_MS as GameTime / 4;

/// A road between two tiles as it stood: one way from the first, or not;
/// a through road, or a street.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Link {
    pub from: GridCoord,
    pub to: GridCoord,
    pub one_way: bool,
    pub road: bool,
    /// How high each end stands (`RoadNode::height`).
    pub up: [u8; 2],
    /// Two lanes, one way.
    pub wide: bool,
}

/// What an action cost: coins out of the purse, and stone off each
/// depot's shelf.
#[derive(Debug, Clone, Default)]
pub struct Paid {
    pub coins: f64,
    pub stone: Vec<(EntityId, f64)>,
}

impl Paid {
    fn add(&mut self, more: Paid) {
        self.coins += more.coins;
        for (depot, units) in more.stone {
            match self.stone.iter_mut().find(|(d, _)| *d == depot) {
                Some((_, u)) => *u += units,
                None => self.stone.push((depot, units)),
            }
        }
    }
}

/// The purse and the depots' stone before an action, to tell what it paid.
pub struct Purse {
    coins: f64,
    stone: Vec<(EntityId, f64)>,
}

impl Purse {
    pub fn of(world: &World) -> Purse {
        Purse { coins: world.treasury, stone: depots(world).map(|(id, b)| (id, stone(b))).collect() }
    }

    pub fn paid(&self, world: &World) -> Paid {
        let stone = self
            .stone
            .iter()
            .filter_map(|&(id, was)| {
                let now = world.objects.get(id).and_then(|e| match e.object {
                    GameObject::Building(ref b) => Some(stone(b)),
                    _ => None,
                })?;
                (was - now > 1e-9).then_some((id, was - now))
            })
            .collect();
        Paid { coins: (self.coins - world.treasury).max(0.0), stone }
    }
}

fn stone(b: &Building) -> f64 {
    b.stocks.get(&Good::Stone).map_or(0.0, |s| s.level)
}

fn depots(world: &World) -> impl Iterator<Item = (EntityId, &Building)> {
    world.objects.iter().filter_map(|e| match e.object {
        GameObject::Building(ref b) if crate::economy::depot(b.kind) && b.site.is_none() => Some((e.id, b)),
        _ => None,
    })
}

#[derive(Debug, Clone)]
pub enum Act {
    /// Road laid in one drag.
    Laid { links: Vec<Link>, paid: Paid },
    /// A building placed, with the street a harbour brings; `free` if it
    /// stood at once for nothing, the town's first depot.
    Placed { id: EntityId, kind: BuildingKind, laid: Vec<Link>, paid: Paid, free: bool },
    /// A building taken down, as it stood, and what it was known by.
    Razed(EntityId, Building),
    /// Road taken up in one tap or drag.
    Cut(Vec<Link>),
}

#[derive(Debug, Clone)]
pub struct Done {
    pub act: Act,
    pub at: GameTime,
    /// The first id handed out for it: whatever came after has a higher.
    pub after: EntityId,
}

/// What a step of the demolisher is about to take: a building whole, or
/// the road on a tile or between two. Read before, to put back after.
pub fn doomed(world: &World, step: Build) -> Option<Act> {
    let Build { from, to, .. } = step;
    let [h0, h1] = step.up.unwrap_or_default();
    if from == to {
        if h1 == 0
            && let Some(GameObject::Building(b)) = world.occupied.get(&(to.x, to.y)).and_then(|&id| world.objects.get(id)).map(|e| &e.object) {
            return Some(Act::Razed(world.occupied[&(to.x, to.y)], b.clone()));
        }
        let node = world.node_at(to, h1)?;
        let GameObject::RoadNode(ref n) = world.objects.get(node)?.object else { return None };
        let mut arms: Vec<EntityId> = n.outgoing.iter().chain(&n.incoming).copied().collect();
        arms.sort_unstable();
        arms.dedup();
        let links = arms
            .into_iter()
            .filter_map(|arm| {
                let at = world.objects.get(arm)?.position?;
                let h = world.height_of(arm);
                let (out, inn) = (n.outgoing.contains(&arm), n.incoming.contains(&arm));
                Some(match (out, inn) {
                    (true, false) => Link { from: to, to: at, one_way: true, road: n.road, up: [h1, h], wide: n.wide.contains(&arm) },
                    (false, true) => Link { from: at, to, one_way: true, road: n.road, up: [h, h1], wide: world.is_wide(arm, node) },
                    _ => Link { from: to, to: at, one_way: false, road: n.road, up: [h1, h], wide: false },
                })
            })
            .collect();
        return Some(Act::Cut(links));
    }
    let (a, b) = world.link_between_at(from, h0, to, h1)?;
    let road = matches!(world.objects.get(a).map(|e| &e.object), Some(GameObject::RoadNode(n)) if n.road);
    Some(Act::Cut(vec![match (world.edges.contains_key(&(a, b)), world.edges.contains_key(&(b, a))) {
        (true, false) => Link { from, to, one_way: true, road, up: [h0, h1], wide: world.is_wide(a, b) },
        (false, true) => Link { from: to, to: from, one_way: true, road, up: [h1, h0], wide: world.is_wide(b, a) },
        _ => Link { from, to, one_way: false, road, up: [h0, h1], wide: false },
    }]))
}

/// A step of the hand, taken: on to the player's last action if it
/// carries the same drag on, else an action of its own. Says so, the
/// first time a drag of road has to buy its stone express.
pub fn stepped(world: &mut World, owner: OwnerId, step: Build, taken: Option<Act>, paid: Paid, after: EntityId, now: GameTime) -> Option<News> {
    if step.tool == Tool::Light {
        return None;
    }
    let road = matches!(step.tool, Tool::Street | Tool::OneWay | Tool::Wide);
    let link = Link { from: step.from, to: step.to, one_way: matches!(step.tool, Tool::OneWay | Tool::Wide), road: step.road, up: step.up.unwrap_or_default(), wide: step.tool == Tool::Wide };
    let express = paid.coins;
    let history = world.undo.entry(owner).or_default();
    history.retain(|d| now.saturating_sub(d.at) <= WINDOW);
    let top = history.last_mut().filter(|d| now.saturating_sub(d.at) <= WINDOW);
    let carried = match (top.map(|d| &mut d.act), &taken) {
        // The same drag of road, carried on from where it ended.
        (Some(Act::Laid { links, paid: was }), None) if road && links.last().is_some_and(|l| l.to == step.from && l.one_way == link.one_way && l.road == link.road) => {
            let first = was.coins == 0.0;
            links.push(link);
            was.add(paid.clone());
            Some(first)
        }
        (Some(Act::Cut(links)), Some(Act::Cut(more))) if step.from != step.to && more.len() == 1 && links.last().is_some_and(|l| l.from == step.from || l.to == step.from) => {
            links.extend(more.iter().copied());
            Some(false)
        }
        _ => None,
    };
    let first = match carried {
        Some(first) => first,
        None => {
            let act = match taken {
                Some(act) => act,
                None => Act::Laid { links: vec![link], paid },
            };
            history.push(Done { act, at: now, after });
            true
        }
    };
    // The drag is the action: said once, where it first buys stone.
    (road && first && express > 0.0).then(|| News {
        text: format!("Stone bought express, {express:.0} coins"),
        sub: "the depots have none for the road; a rule on a depot keeps some in".into(),
        at: world.harbours.keys().next().copied().unwrap_or(0),
    })
}

/// A building placed, kept to undo, with the street it brought.
pub fn placed(world: &mut World, owner: OwnerId, id: EntityId, laid: Vec<Link>, paid: Paid, after: EntityId, now: GameTime) {
    let Some(GameObject::Building(b)) = world.objects.get(id).map(|e| &e.object) else { return };
    let act = Act::Placed { id, kind: b.kind, free: b.site.is_none(), laid, paid };
    let history = world.undo.entry(owner).or_default();
    history.retain(|d| now.saturating_sub(d.at) <= WINDOW);
    history.push(Done { act, at: now, after });
}

/// The player's last action taken back, if it is recent and nothing since
/// rests on it; what was done, or why not, as a line of news for them.
pub fn undo(world: &mut World, events: &mut EventQueue, intersections: &mut IntersectionRegistry, owner: OwnerId, now: GameTime) -> News {
    let say = |text: String, sub: String, at: EntityId| News { text, sub, at };
    let history = world.undo.entry(owner).or_default();
    history.retain(|d| now.saturating_sub(d.at) <= WINDOW);
    let Some(done) = history.last().cloned() else {
        return say("Nothing to undo".into(), "only the last few minutes' building can be taken back".into(), 0);
    };
    // A building someone else has taken down since leaves nothing to take
    // back: it goes from the history, and the next undo goes on before it.
    if let Act::Placed { id, kind, .. } = done.act
        && world.objects.get(id).is_none()
    {
        world.undo.get_mut(&owner).and_then(|h| h.pop());
        return say(format!("The {} is gone already", label(kind)), "nothing of it to undo; again for the action before".into(), 0);
    }
    let refused = match &done.act {
        Act::Laid { links, .. } => rests_on(world, links, done.after),
        Act::Placed { laid, .. } => rests_on(world, laid, done.after),
        Act::Razed(_, b) => (!b.tiles.iter().all(|&t| world.may_stand(t))).then_some("Something stands where it stood"),
        Act::Cut(links) => links.iter().any(|l| world.occupied.contains_key(&(l.to.x, l.to.y)) || world.occupied.contains_key(&(l.from.x, l.from.y))).then_some("Something stands where it ran"),
    };
    if let Some(why) = refused {
        return say("Can't undo".into(), why.into(), 0);
    }
    world.undo.get_mut(&owner).and_then(|h| h.pop());
    match done.act {
        Act::Laid { links, paid } => {
            take_up(world, events, intersections, &links, now);
            let back = refund(world, &paid, now);
            say(format!("Undone: {}", tiles(&links)), back, 0)
        }
        Act::Placed { id, kind, laid, paid, free } => {
            let site = match world.objects.get(id).map(|e| &e.object) {
                Some(GameObject::Building(b)) => b.site.clone(),
                _ => None,
            };
            let at = world.objects.get(id).and_then(|e| e.position).unwrap_or(GridCoord { x: 0, y: 0 });
            // What its site was brought, or all it took if it stands; none
            // if it stood for nothing.
            let mut materials: Vec<(Good, f64)> = match site {
                Some(site) => site.iter().map(|(&g, s)| (g, s.level)).collect(),
                None if free => Vec::new(),
                None => crate::blueprint::takes(kind),
            };
            // And what is on a van on its way to it: the van arrives empty.
            let vans: Vec<EntityId> = world.calls.iter().filter(|c| c.at == id).filter_map(|c| c.answered_by).collect();
            materials.extend(vans.into_iter().filter_map(|van| crate::calls::load(world, van, None)));
            world.remove_building(id);
            take_up(world, events, intersections, &laid, now);
            let mut back = vec![refund(world, &paid, now)];
            back.push(give_back(world, &materials, at, now));
            back.retain(|s| !s.is_empty());
            if back.is_empty() {
                back.push("it had taken nothing yet".into());
            }
            say(format!("Undone: the {}", label(kind)), back.join("; "), 0)
        }
        Act::Razed(was, b) => {
            let kind = b.kind;
            let id = world.raise_as(Building { door: None, park: Vec::new(), land: Vec::new(), ruts: Vec::new(), ..b });
            // Standing again, it is the one placed: undo of that takes it.
            for d in world.undo.values_mut().flatten() {
                if let Act::Placed { id: placed, .. } = &mut d.act
                    && *placed == was
                {
                    *placed = id;
                }
            }
            say(format!("The {} stands again", label(kind)), "as it stood, for nothing".into(), id)
        }
        Act::Cut(links) => {
            for l in &links {
                crate::game::lay(world, *l);
            }
            say(format!("Undone: {} put back", tiles(&links)), "for nothing".into(), 0)
        }
    }
}

/// Why taking these links up is refused: a building placed since, by
/// anyone, opens onto them.
fn rests_on(world: &World, links: &[Link], after: EntityId) -> Option<&'static str> {
    let laid: Vec<GridCoord> = links.iter().flat_map(|l| [l.from, l.to]).collect();
    world
        .objects
        .iter()
        .any(|e| e.id >= after && matches!(e.object, GameObject::Building(ref b) if b.door.is_some_and(|d| laid.contains(&d.street))))
        .then_some("A building placed since opens onto that street")
}

/// The links taken up, newest first, as the demolisher would.
fn take_up(world: &mut World, events: &mut EventQueue, intersections: &mut IntersectionRegistry, links: &[Link], now: GameTime) {
    for l in links.iter().rev() {
        if let Some((a, b)) = world.link_between_at(l.from, l.up[0], l.to, l.up[1]) {
            crate::game::handle_link_demolish(world, events, intersections, a, b, now);
        }
    }
}

/// What an action paid, given back: coins to the purse, stone to the
/// shelves it came off, or its price where the depot is gone or full.
fn refund(world: &mut World, paid: &Paid, now: GameTime) -> String {
    let mut coins = paid.coins;
    let mut stone = 0.0;
    for &(depot, units) in &paid.stone {
        let put = shelve(world, depot, Good::Stone, units);
        stone += put;
        coins += crate::economy::import(Good::Stone, units - put);
    }
    if coins > 0.0 {
        let at = world.harbours.keys().next().copied().unwrap_or(0);
        crate::economy::refunded(world, at, coins, now);
    }
    [(stone > 0.0).then(|| format!("{stone:.0} stone back on the shelf")), (coins > 0.0).then(|| format!("{coins:.0} coins back"))]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(", ")
}

/// Materials given back to the depots nearest a tile, as far as their
/// shelves hold, and the rest in coins at the world's price.
fn give_back(world: &mut World, goods: &[(Good, f64)], at: GridCoord, now: GameTime) -> String {
    let mut out = Vec::new();
    let mut coins = 0.0;
    let mut all: std::collections::BTreeMap<Good, f64> = Default::default();
    for &(good, units) in goods {
        *all.entry(good).or_default() += units;
    }
    for (good, units) in all.into_iter().filter(|(_, u)| *u > 0.0) {
        let mut near: Vec<(i32, EntityId)> = depots(world).filter_map(|(id, _)| Some(((world.objects.get(id)?.position?.x - at.x).abs() + (world.objects.get(id)?.position?.y - at.y).abs(), id))).collect();
        near.sort();
        let mut left = units;
        for (_, depot) in near {
            left -= shelve(world, depot, good, left);
        }
        if units - left > 0.0 {
            out.push(format!("{:.0} {} back to the depot", units - left, format!("{good:?}").to_lowercase()));
        }
        coins += crate::economy::import(good, left);
    }
    if coins > 0.0 {
        let harbour = world.harbours.keys().next().copied().unwrap_or(0);
        crate::economy::refunded(world, harbour, coins, now);
        out.push(format!("{coins:.0} coins back"));
    }
    out.join(", ")
}

/// Units of a good put on a depot's shelf, as far as it has room: how many.
fn shelve(world: &mut World, depot: EntityId, good: Good, units: f64) -> f64 {
    let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) else { return 0.0 };
    let Some(stock) = b.stocks.get_mut(&good) else { return 0.0 };
    let put = units.min(stock.cap - stock.level).max(0.0);
    stock.level += put;
    put
}

fn tiles(links: &[Link]) -> String {
    let kind = if links.iter().any(|l| l.road) { "road" } else { "street" };
    format!("{} {} of {kind}", links.len(), if links.len() == 1 { "tile" } else { "tiles" })
}

fn label(kind: BuildingKind) -> String {
    format!("{kind:?}").to_lowercase()
}
