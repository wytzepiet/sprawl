//! Undo (docs/game.md §Undo). What the mayor places or lays, taken down
//! again while it is recent (`WINDOW`), is as if it never was: it gives
//! back what it paid, the stone off the depots' shelves to their shelves,
//! express coins to the purse, a site's delivered materials to the
//! nearest depot (`raze`, `recoup`).
//!
//! The road a player laid or took up is also kept, a stack a player, for
//! the interchange's Z (`undo`): taken back in order, newest first; an
//! action something since rests on, someone else's building opening onto
//! a street it laid, or ground it ran over built on since, is refused,
//! with why, and stays. All of it is the server's, and dies with the
//! process.

use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::protocol::{Build, Building, BuildingKind, EntityId, GameObject, Good, GridCoord, News, OwnerId, Stroke, Tool, DAY_MS};
use crate::world::World;
use crate::world::decks::Side;

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
    /// Which side of its tile each end stands (`RoadNode::side`).
    pub sides: [Side; 2],
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
    /// One of `n` even parts, taken off.
    fn part(&mut self, n: usize) -> Paid {
        let f = 1.0 / n.max(1) as f64;
        let part = Paid { coins: self.coins * f, stone: self.stone.iter().map(|&(d, u)| (d, u * f)).collect() };
        self.coins -= part.coins;
        for (s, p) in self.stone.iter_mut().zip(&part.stone) {
            s.1 -= p.1;
        }
        part
    }

    pub fn add(&mut self, more: Paid) {
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
        Purse { coins: world.treasury, stone: world.depots().into_iter().map(|(id, b)| (id, stone(b))).collect() }
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

#[derive(Debug, Clone)]
pub enum Act {
    /// Road laid in one drag.
    Laid { links: Vec<Link>, paid: Paid },
    /// Road taken up in one tap or drag.
    Cut(Vec<Link>),
    /// A drag of road drawn as a whole (`draw.rs`): the drag, as last
    /// sent, and each of its steps as laid.
    Drawn { stroke: Stroke, steps: Vec<Laid> },
}

/// A step of a drawn drag, as laid: its link, the nodes at its ends,
/// whether it was laid new or ran along a road already there, and what it
/// paid.
#[derive(Debug, Clone)]
pub struct Laid {
    pub link: Link,
    pub nodes: [EntityId; 2],
    pub fresh: bool,
    pub paid: Paid,
}

/// Steps of a drawn drag taken back, newest first: what each laid taken
/// up, and what it paid given back; what was given back, said.
pub(crate) fn take_back(world: &mut World, events: &mut EventQueue, steps: &[Laid], now: GameTime) -> String {
    let mut paid = Paid::default();
    for step in steps.iter().rev() {
        let [a, b] = step.nodes;
        if step.fresh && (world.edges.contains_key(&(a, b)) || world.edges.contains_key(&(b, a))) {
            crate::car::reroute::handle_link_demolish(world, events, a, b, now);
        }
        paid.add(step.paid.clone());
    }
    refund(world, &paid, now)
}

#[derive(Debug, Clone)]
pub struct Done {
    pub act: Act,
    pub at: GameTime,
    /// The first id handed out for it: whatever came after has a higher.
    pub after: EntityId,
}

/// What a step of the demolisher is about to take: the road on a tile or
/// between two. Read before, to put back after.
pub fn doomed(world: &World, step: Build) -> Option<Act> {
    let Build { from, to, .. } = step;
    let [h0, h1] = step.up.unwrap_or_default();
    if from == to {
        let node = world.node_in(to, h1, step.sides.unwrap_or_default()[1])?;
        let mut arms = world.arms_of(node, false);
        arms.sort_unstable();
        arms.dedup();
        return Some(Act::Cut(arms.into_iter().filter_map(|arm| link_of(world, node, arm)).collect()));
    }
    let [s0, s1] = step.sides.unwrap_or_default();
    let (a, b) = world.link_between_at(from, h0, s0, to, h1, s1)?;
    Some(Act::Cut(vec![link_of(world, a, b)?]))
}

/// The road between two nodes as it stands: the way it runs, from the one
/// it runs from; its priority, heights, sides and lanes.
fn link_of(world: &World, a: EntityId, b: EntityId) -> Option<Link> {
    let at = |id: EntityId| world.objects.get(id).and_then(|e| e.position);
    let (out, back) = (world.edges.contains_key(&(a, b)), world.edges.contains_key(&(b, a)));
    let (a, b) = if back && !out { (b, a) } else { (a, b) };
    Some(Link {
        from: at(a)?,
        to: at(b)?,
        one_way: out != back,
        road: world.is_road_between(a, b),
        up: [world.height_of(a), world.height_of(b)],
        sides: [world.side_of(a), world.side_of(b)],
        wide: world.is_wide(a, b),
    })
}

/// A step of the hand, taken: on to the player's last action if it
/// carries the same drag on, else an action of its own. Says so, the
/// first time a drag of road has to buy its stone express.
pub fn stepped(world: &mut World, owner: OwnerId, step: Build, taken: Option<Act>, paid: Paid, after: EntityId, now: GameTime) -> Option<News> {
    if step.tool == Tool::Light || (step.tool == Tool::Demolish && taken.is_none()) {
        return None;
    }
    let road = matches!(step.tool, Tool::Street | Tool::OneWay | Tool::Wide);
    let link = Link { from: step.from, to: step.to, one_way: matches!(step.tool, Tool::OneWay | Tool::Wide), road: step.road, up: step.up.unwrap_or_default(), sides: step.sides.unwrap_or_default(), wide: step.tool == Tool::Wide };
    let express = paid.coins;
    let history = world.undo.entry(owner).or_default();
    history.retain(|d| now.saturating_sub(d.at) <= WINDOW);
    let top = history.last_mut().filter(|d| now.saturating_sub(d.at) <= WINDOW);
    let carried = match (top.map(|d| &mut d.act), &taken) {
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
    (road && first && express > 0.0).then(|| bought_express(world, express))
}

/// Stone for a road the depots could not give, bought from the world.
pub fn bought_express(world: &World, coins: f64) -> News {
    News {
        text: format!("Stone bought express, {coins:.0} coins"),
        sub: "the depots have none for the road".into(),
        at: world.harbours.keys().next().copied().unwrap_or(0),
    }
}

/// A building placed lately, with the street a harbour brings and what
/// it paid: what razing it within `WINDOW` gives back. `free` if it stood
/// at once for nothing, the town's first depot.
#[derive(Debug, Clone)]
pub struct Placed {
    pub id: EntityId,
    kind: BuildingKind,
    laid: Vec<Link>,
    paid: Paid,
    free: bool,
    at: GameTime,
    /// The first id handed out for it.
    after: EntityId,
}

/// A building placed, kept a while for razing to give back.
pub fn placed(world: &mut World, id: EntityId, laid: Vec<Link>, paid: Paid, after: EntityId, now: GameTime) {
    let Some(b) = world.building(id) else { return };
    let placed = Placed { id, kind: b.kind, free: b.site.is_none(), laid, paid, at: now, after };
    world.placed.retain(|p| now.saturating_sub(p.at) <= WINDOW);
    world.placed.push(placed);
}

/// A building taken down whole. Placed lately, it is as if it never
/// was, and gives back what it cost (`unplace`): what the mayor takes
/// down of their own slip is the slip undone.
pub fn raze(world: &mut World, events: &mut EventQueue, id: EntityId, now: GameTime) -> Option<News> {
    let lately = world.placed.iter().position(|p| p.id == id && now.saturating_sub(p.at) <= WINDOW).map(|i| world.placed.remove(i));
    let Some(Placed { kind, laid, paid, free, after, .. }) = lately else {
        world.remove_building(id);
        return None;
    };
    // The street it brought stays if a building since opens onto it.
    let (laid, paid) = if rests_on(world, &laid, after).is_some() { (Vec::new(), Paid::default()) } else { (laid, paid) };
    let back = unplace(world, events, id, kind, &laid, &paid, free, now);
    Some(News { text: format!("The {} taken back", label(kind)), sub: back, at: 0 })
}

/// Road the demolisher took up: what of it was laid lately given back
/// what it paid, as if it never was, and gone from what it was laid in;
/// the rest, to keep to undo. What was given back, said.
pub fn recoup(world: &mut World, links: Vec<Link>, now: GameTime) -> (Vec<Link>, String) {
    let mut paid = Paid::default();
    let mut kept = Vec::new();
    for l in links {
        match laid_lately(world, &l, now) {
            Some(p) => paid.add(p),
            None => kept.push(l),
        }
    }
    // A drag all taken back is nothing left to undo.
    for h in world.undo.values_mut() {
        h.retain(|d| !matches!(&d.act, Act::Laid { links, .. } if links.is_empty()) && !matches!(&d.act, Act::Drawn { steps, .. } if steps.is_empty()));
    }
    let back = if paid.coins > 0.0 || !paid.stone.is_empty() { refund(world, &paid, now) } else { String::new() };
    (kept, back)
}

/// What a link laid lately paid, taken off the record of the drag that
/// laid it; none if it was not laid lately.
fn laid_lately(world: &mut World, l: &Link, now: GameTime) -> Option<Paid> {
    let ends = |a: &Link| [(a.from, a.up[0], a.sides[0]), (a.to, a.up[1], a.sides[1])];
    let same = |a: &Link| {
        let ([a0, a1], [l0, l1]) = (ends(a), ends(l));
        (a0, a1) == (l0, l1) || (a0, a1) == (l1, l0)
    };
    for d in world.undo.values_mut().flatten().filter(|d| now.saturating_sub(d.at) <= WINDOW) {
        match &mut d.act {
            Act::Laid { links, paid } => {
                if let Some(i) = links.iter().position(same) {
                    let share = paid.part(links.len());
                    links.remove(i);
                    return Some(share);
                }
            }
            Act::Drawn { steps, .. } => {
                if let Some(i) = steps.iter().position(|s| s.fresh && same(&s.link)) {
                    return Some(steps.remove(i).paid);
                }
            }
            _ => {}
        }
    }
    None
}

/// The player's last action taken back, if it is recent and nothing since
/// rests on it; what was done, or why not, as a line of news for them.
pub fn undo(world: &mut World, events: &mut EventQueue, owner: OwnerId, now: GameTime) -> News {
    let say = |text: String, sub: String, at: EntityId| News { text, sub, at };
    let history = world.undo.entry(owner).or_default();
    history.retain(|d| now.saturating_sub(d.at) <= WINDOW);
    let Some(done) = history.last().cloned() else {
        return say("Nothing to undo".into(), "only the last few minutes' road can be taken back".into(), 0);
    };
    let refused = match &done.act {
        Act::Laid { links, .. } => rests_on(world, links, done.after),
        Act::Cut(links) => links.iter().any(|l| world.occupied.contains_key(&(l.to.x, l.to.y)) || world.occupied.contains_key(&(l.from.x, l.from.y))).then_some("Something stands where it ran"),
        Act::Drawn { steps, .. } => rests_on(world, &steps.iter().filter(|s| s.fresh).map(|s| s.link).collect::<Vec<_>>(), done.after),
    };
    if let Some(why) = refused {
        return say("Can't undo".into(), why.into(), 0);
    }
    world.undo.get_mut(&owner).and_then(|h| h.pop());
    match done.act {
        Act::Laid { links, paid } => {
            take_up(world, events, &links, now);
            let back = refund(world, &paid, now);
            say(format!("Undone: {}", tiles(&links)), back, 0)
        }
        Act::Cut(links) => {
            for l in &links {
                crate::hand::lay(world, *l);
            }
            say(format!("Undone: {} put back", tiles(&links)), "for nothing".into(), 0)
        }
        Act::Drawn { steps, .. } => {
            let laid: Vec<Link> = steps.iter().filter(|s| s.fresh).map(|s| s.link).collect();
            let back = take_back(world, events, &steps, now);
            say(format!("Undone: {}", tiles(&laid)), back, 0)
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

/// A building placed taken away as if it never was: what its site was
/// brought, or all it took if it stands, given back, and what is on a
/// van on its way to it; the street it brought taken up, and what that
/// paid given back. What was given back, said.
#[allow(clippy::too_many_arguments)]
fn unplace(world: &mut World, events: &mut EventQueue, id: EntityId, kind: BuildingKind, laid: &[Link], paid: &Paid, free: bool, now: GameTime) -> String {
    let site = match world.objects.get(id).map(|e| &e.object) {
        Some(GameObject::Building(b)) => b.site.clone(),
        _ => None,
    };
    let at = world.objects.get(id).and_then(|e| e.position).unwrap_or(GridCoord { x: 0, y: 0 });
    // None if it stood for nothing.
    let mut materials: Vec<(Good, f64)> = match site {
        Some(site) => site.iter().map(|(&g, s)| (g, s.level)).collect(),
        None if free => Vec::new(),
        None => crate::blueprint::takes(kind),
    };
    // The van arrives empty.
    let vans: Vec<EntityId> = world.calls.iter().filter(|c| c.at == id).filter_map(|c| c.answered_by).collect();
    materials.extend(vans.into_iter().filter_map(|van| crate::calls::load(world, van, None)));
    world.remove_building(id);
    take_up(world, events, laid, now);
    let mut back = vec![refund(world, paid, now)];
    back.push(give_back(world, &materials, at, now));
    back.retain(|s| !s.is_empty());
    if back.is_empty() {
        back.push("it had taken nothing yet".into());
    }
    back.join("; ")
}

/// The links taken up, newest first, as the demolisher would.
fn take_up(world: &mut World, events: &mut EventQueue, links: &[Link], now: GameTime) {
    for l in links.iter().rev() {
        if let Some((a, b)) = world.link_between_at(l.from, l.up[0], l.sides[0], l.to, l.up[1], l.sides[1]) {
            crate::car::reroute::handle_link_demolish(world, events, a, b, now);
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
        let near = world.nearest(at, world.depots().into_iter().map(|(id, _)| id));
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
    let Some(b) = world.building_mut(depot) else { return 0.0 };
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
