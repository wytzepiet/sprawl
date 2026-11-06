//! Undo: the road a player laid or took up, kept a stack a player, taken
//! back in order, newest first, while it is recent (`WINDOW`). An action
//! something since rests on, a building opening onto a street it laid, or
//! ground it ran over built on since, is refused, with why, and stays.
//! Road laid comes off the town's tiles (`Map::laid`), so taking it up
//! gives them back by itself. All of it is the server's, and dies with
//! the process.

use traffic::event_queue::EventQueue;
use model::GameTime;
use model::{Build, EntityId, GameObject, GridCoord, News, OwnerId, Stroke, Tool};
use crate::world::World;
use map::decks::Side;

/// How long an action may be taken back: long enough to see a slip for
/// what it is.
pub const WINDOW: GameTime = 300_000;

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

#[derive(Debug, Clone)]
pub enum Act {
    /// Road laid in one drag.
    Laid(Vec<Link>),
    /// Road taken up in one tap or drag.
    Cut(Vec<Link>),
    /// A drag of road drawn as a whole (`draw.rs`): the drag, as last
    /// sent, and each of its steps as laid.
    Drawn { stroke: Stroke, steps: Vec<Laid> },
}

/// A step of a drawn drag, as laid: its link, the nodes at its ends, and
/// whether it was laid new or ran along a road already there.
#[derive(Debug, Clone)]
pub struct Laid {
    pub link: Link,
    pub nodes: [EntityId; 2],
    pub fresh: bool,
}

#[derive(Debug, Clone)]
pub struct Done {
    pub act: Act,
    pub at: GameTime,
    /// The first id handed out for it: whatever came after has a higher.
    pub after: EntityId,
}

/// Steps of a drawn drag taken back, newest first.
pub(crate) fn take_back(world: &mut World, events: &mut EventQueue, steps: &[Laid], now: GameTime) {
    for step in steps.iter().rev() {
        let [a, b] = step.nodes;
        if step.fresh && (world.map.edges.contains_key(&(a, b)) || world.map.edges.contains_key(&(b, a))) {
            world.drive(events, |t, e| traffic::car::reroute::handle_link_demolish(t, e, a, b, now));
        }
    }
}

/// What a step of the demolisher is about to take: the road on a tile or
/// between two. Read before, to put back after.
pub fn doomed(world: &World, step: Build) -> Option<Act> {
    let Build { from, to, .. } = step;
    let [h0, h1] = step.up.unwrap_or_default();
    if from == to {
        let node = world.map.node_in(to, h1, step.sides.unwrap_or_default()[1])?;
        let mut arms = world.map.arms_of(node, false);
        arms.sort_unstable();
        arms.dedup();
        return Some(Act::Cut(arms.into_iter().filter_map(|arm| link_of(world, node, arm)).collect()));
    }
    let [s0, s1] = step.sides.unwrap_or_default();
    let (a, b) = world.map.link_between_at(from, h0, s0, to, h1, s1)?;
    Some(Act::Cut(vec![link_of(world, a, b)?]))
}

/// The road between two nodes as it stands: the way it runs, from the one
/// it runs from; its priority, heights, sides and lanes.
fn link_of(world: &World, a: EntityId, b: EntityId) -> Option<Link> {
    let at = |id: EntityId| world.map.objects.get(id).and_then(|e| e.position);
    let (out, back) = (world.map.edges.contains_key(&(a, b)), world.map.edges.contains_key(&(b, a)));
    let (a, b) = if back && !out { (b, a) } else { (a, b) };
    Some(Link {
        from: at(a)?,
        to: at(b)?,
        one_way: out != back,
        road: world.map.is_road_between(a, b),
        up: [world.map.height_of(a), world.map.height_of(b)],
        sides: [world.map.side_of(a), world.map.side_of(b)],
        wide: world.map.is_wide(a, b),
    })
}

/// A step of the hand, taken: on to the player's last action if it
/// carries the same drag on, else an action of its own.
pub fn stepped(world: &mut World, owner: OwnerId, step: Build, taken: Option<Act>, after: EntityId, now: GameTime) {
    if step.tool == Tool::Light || (step.tool == Tool::Demolish && taken.is_none()) {
        return;
    }
    let link = Link { from: step.from, to: step.to, one_way: matches!(step.tool, Tool::OneWay | Tool::Wide), road: step.road, up: step.up.unwrap_or_default(), sides: step.sides.unwrap_or_default(), wide: step.tool == Tool::Wide };
    let history = world.undo.entry(owner).or_default();
    history.retain(|d| now.saturating_sub(d.at) <= WINDOW);
    let carried = match (history.last_mut().map(|d| &mut d.act), &taken) {
        (Some(Act::Cut(links)), Some(Act::Cut(more))) if step.from != step.to && more.len() == 1 && links.last().is_some_and(|l| l.from == step.from || l.to == step.from) => {
            links.extend(more.iter().copied());
            true
        }
        _ => false,
    };
    if !carried {
        history.push(Done { act: taken.unwrap_or(Act::Laid(vec![link])), at: now, after });
    }
}

/// The player's last action taken back, if it is recent and nothing since
/// rests on it; what was done, or why not, as a line of news for them.
pub fn undo(world: &mut World, events: &mut EventQueue, owner: OwnerId, now: GameTime) -> News {
    let say = |text: String, sub: &str| News { text, sub: sub.into(), at: 0 };
    let history = world.undo.entry(owner).or_default();
    history.retain(|d| now.saturating_sub(d.at) <= WINDOW);
    let Some(done) = history.last().cloned() else {
        return say("Nothing to undo".into(), "only the last few minutes' road can be taken back");
    };
    let refused = match &done.act {
        Act::Laid(links) => rests_on(world, links, done.after),
        Act::Cut(links) => links.iter().any(|l| world.map.occupied.contains_key(&(l.to.x, l.to.y)) || world.map.occupied.contains_key(&(l.from.x, l.from.y))).then_some("Something stands where it ran"),
        Act::Drawn { steps, .. } => rests_on(world, &steps.iter().filter(|s| s.fresh).map(|s| s.link).collect::<Vec<_>>(), done.after),
    };
    if let Some(why) = refused {
        return say("Can't undo".into(), why);
    }
    world.undo.get_mut(&owner).and_then(|h| h.pop());
    match done.act {
        Act::Laid(links) => {
            take_up(world, events, &links, now);
            say(format!("Undone: {}", tiles(&links)), "")
        }
        Act::Cut(links) => {
            for l in &links {
                crate::hand::lay(world, *l);
            }
            say(format!("Undone: {} put back", tiles(&links)), "")
        }
        Act::Drawn { steps, .. } => {
            let laid: Vec<Link> = steps.iter().filter(|s| s.fresh).map(|s| s.link).collect();
            take_back(world, events, &steps, now);
            say(format!("Undone: {}", tiles(&laid)), "")
        }
    }
}

/// Why taking these links up is refused: a building placed since, by
/// anyone, opens onto them.
fn rests_on(world: &World, links: &[Link], after: EntityId) -> Option<&'static str> {
    let laid: Vec<GridCoord> = links.iter().flat_map(|l| [l.from, l.to]).collect();
    world.map
        .objects
        .iter()
        .any(|e| e.id >= after && matches!(e.object, GameObject::Building(ref b) if b.door.is_some_and(|d| laid.contains(&d.street))))
        .then_some("A building placed since opens onto that street")
}

/// The links taken up, newest first, as the demolisher would.
fn take_up(world: &mut World, events: &mut EventQueue, links: &[Link], now: GameTime) {
    for l in links.iter().rev() {
        if let Some((a, b)) = world.map.link_between_at(l.from, l.up[0], l.sides[0], l.to, l.up[1], l.sides[1]) {
            world.drive(events, |t, e| traffic::car::reroute::handle_link_demolish(t, e, a, b, now));
        }
    }
}

fn tiles(links: &[Link]) -> String {
    let kind = if links.iter().any(|l| l.road) { "road" } else { "street" };
    format!("{} {} of {kind}", links.len(), if links.len() == 1 { "tile" } else { "tiles" })
}
