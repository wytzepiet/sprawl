//! Drafts: what the mayor's hand has drawn and not yet built
//! (docs/game.md §Drafts).
//!
//! A draft is the steps of the hand, kept as they were taken, a drag to a
//! stroke: nothing else. It is never a road node, an edge or a building,
//! so nothing that runs the town knows it exists; it only takes up its
//! tiles, which nobody else may draw on. Commit replays the steps through
//! the same handler that builds live, roads, then buildings, then
//! demolitions, round again while anything more goes in; what is refused
//! stays, marked. Undo takes back the last stroke, discard the lot.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::protocol::{Build, BuildingKind, GameObject, Good, GridCoord, OwnerId, TerrainType, Tool};
use crate::world::World;

/// A step of the hand, drafted.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Mark {
    pub step: Build,
    /// Refused at the last commit: something else stands there now, or it
    /// reaches nothing.
    #[serde(default)]
    pub stuck: bool,
}

/// One drag of the hand: what undo takes back.
pub type Stroke = Vec<Mark>;

/// A player's draft as every client is sent it: their strokes and the
/// bill, so each can draw their own in blue and everyone else's as taken.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Draft {
    #[ts(type = "number")]
    pub owner: OwnerId,
    pub strokes: Vec<Stroke>,
    pub bill: Vec<Line>,
    /// Where an order for the shortfall goes: the standing depot nearest
    /// the draft.
    #[ts(type = "number | null")]
    pub depot: Option<crate::protocol::EntityId>,
}

/// A line of the bill: a material the draft takes, against what the town
/// has of it, and what the shortfall would cost from the world.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Line {
    pub good: Good,
    pub takes: f64,
    /// In the depots or on its way to them, less what sites already wait on.
    pub have: f64,
    /// Boxes to order to cover the shortfall, and their price.
    pub boxes: u32,
    pub coins: f64,
}

/// The tiles a step would lay something on: a road's two, a building's
/// one. A demolition lays nothing.
fn lays(step: &Build) -> Vec<GridCoord> {
    match step.tool {
        Tool::Street | Tool::OneWay | Tool::Road => vec![step.from, step.to],
        Tool::Building(_) => vec![step.to],
        Tool::Demolish => vec![],
    }
}

fn marks(world: &World, owner: OwnerId) -> impl Iterator<Item = &Mark> {
    world.drafts.get(&owner).into_iter().flatten().flatten()
}

/// Is the tile drawn on by somebody else's draft.
fn taken(world: &World, owner: OwnerId, t: GridCoord) -> bool {
    world.drafts.iter().any(|(&o, strokes)| o != owner && strokes.iter().flatten().any(|m| lays(&m.step).contains(&t)))
}

/// Is the tile drawn on by the owner's own draft.
fn mine(world: &World, owner: OwnerId, t: GridCoord) -> bool {
    marks(world, owner).any(|m| lays(&m.step).contains(&t))
}

/// The kind of building the owner's draft paints on a tile.
fn drafted(world: &World, owner: OwnerId, t: GridCoord) -> Option<BuildingKind> {
    marks(world, owner).filter(|m| m.step.to == t).find_map(|m| match m.step.tool {
        Tool::Building(kind) => Some(kind),
        _ => None,
    })
}

/// May the step be drafted: on the map, on nobody else's draft, onto
/// ground it could stand on. Lenient, since what it joins may itself be a
/// draft: the whole rule (`game_loop::may`) is the commit's.
fn fair(world: &World, owner: OwnerId, step: &Build) -> bool {
    let (dx, dy) = (step.to.x - step.from.x, step.to.y - step.from.y);
    if dx.abs() > 1 || dy.abs() > 1 || lays(step).iter().any(|&t| taken(world, owner, t)) {
        return false;
    }
    let land = |t: GridCoord| matches!(world.terrain.get(&(t.x, t.y)), Some(TerrainType::Grass | TerrainType::Forest));
    let road = |t: GridCoord| world.road_node_at(t).is_some();
    match step.tool {
        Tool::Street | Tool::OneWay | Tool::Road => {
            step.from != step.to
                && !world.occupied.contains_key(&(step.from.x, step.from.y))
                && !world.are_connected(step.from, step.to)
                && [step.from, step.to].iter().all(|&t| road(t) || mine(world, owner, t) || world.occupied.contains_key(&(t.x, t.y)) || land(t))
        }
        // Onto a building, standing or drafted, only a step from another
        // of its kind, to join or link the two: a tap there does nothing.
        Tool::Building(kind) => {
            let tap = step.from == step.to;
            let standing = |t: GridCoord| world.occupied.get(&(t.x, t.y)).and_then(|&b| match world.objects.get(b)?.object {
                GameObject::Building(ref b) => Some(b.kind),
                _ => None,
            });
            match (standing(step.to), drafted(world, owner, step.to)) {
                (Some(k), _) => !tap && k == kind && (world.may_paint(kind, step.from, step.to) || drafted(world, owner, step.from) == Some(kind)),
                // Two tiles of one drafted building are one already.
                (None, Some(k)) => !tap && k == kind && !(crate::world::grows(kind) && drafted(world, owner, step.from) == Some(kind)),
                (None, None) => land(step.to) && (mine(world, owner, step.to) || world.road_node_at(step.to).is_none_or(|n| world.arms_of(n, false).len() <= 1)),
            }
        }
        Tool::Demolish if step.from == step.to => road(step.to) || world.occupied.contains_key(&(step.to.x, step.to.y)),
        Tool::Demolish => world.link_between(step.from, step.to).is_some(),
    }
}

/// A step of the owner's hand, drafted: on to their last stroke if it
/// carries that drag on, else a stroke of its own. The demolisher on the
/// owner's own draft rubs it out instead, and on a demolition already
/// drafted takes it back. Whether the draft changed.
pub fn draw(world: &mut World, owner: OwnerId, step: Build) -> bool {
    let same = |a: &Build, b: &Build| a.tool == b.tool && ((a.from, a.to) == (b.from, b.to) || (a.tool != Tool::OneWay && (a.from, a.to) == (b.to, b.from)));
    if step.tool == Tool::Demolish {
        let tap = step.from == step.to;
        // A tap rubs out whatever of the draft is on its tile; a drag, the
        // drafted road it cuts across.
        let rubbed = |m: &Mark| match m.step.tool {
            Tool::Demolish => same(&m.step, &step),
            _ if tap => lays(&m.step).contains(&step.to),
            Tool::Building(_) => false,
            _ => [(step.from, step.to), (step.to, step.from)].contains(&(m.step.from, m.step.to)),
        };
        if marks(world, owner).any(rubbed) {
            let strokes = world.drafts.entry(owner).or_default();
            for s in strokes.iter_mut() {
                s.retain(|m| !rubbed(m));
            }
            strokes.retain(|s| !s.is_empty());
            if strokes.is_empty() {
                world.drafts.remove(&owner);
            }
            return true;
        }
    }
    if marks(world, owner).any(|m| same(&m.step, &step)) || !fair(world, owner, &step) {
        println!("refused draft: {:?} from {:?} to {:?}", step.tool, step.from, step.to);
        return false;
    }
    let strokes = world.drafts.entry(owner).or_default();
    let carries_on = step.from != step.to && strokes.last().and_then(|s| s.last()).is_some_and(|m| m.step.tool == step.tool && m.step.to == step.from);
    let mark = Mark { step, stuck: false };
    match strokes.last_mut() {
        Some(s) if carries_on => s.push(mark),
        _ => strokes.push(vec![mark]),
    }
    true
}

/// The owner's last stroke taken back.
pub fn undo(world: &mut World, owner: OwnerId) {
    if let Some(strokes) = world.drafts.get_mut(&owner) {
        strokes.pop();
        if strokes.is_empty() {
            world.drafts.remove(&owner);
        }
    }
}

/// The owner's whole draft dropped.
pub fn discard(world: &mut World, owner: OwnerId) {
    world.drafts.remove(&owner);
}

/// The order a commit builds in: the roads, so what is drawn beside them
/// is reached; the buildings; then what comes down, so traffic has the
/// new road before the old one goes.
fn pass(step: &Build) -> u8 {
    match step.tool {
        Tool::Street | Tool::OneWay | Tool::Road => 0,
        Tool::Building(_) => 1,
        Tool::Demolish => 2,
    }
}

/// The owner's draft made real in one stroke, each step through `build`,
/// the handler that builds live, which says whether it took the step. Round
/// again while anything more goes in: a demolition can free a tile a road
/// was refused. What is never taken stays in the draft, marked.
pub fn commit(world: &mut World, owner: OwnerId, mut build: impl FnMut(&mut World, Build) -> bool) {
    let Some(strokes) = world.drafts.remove(&owner) else { return };
    let mut left: Vec<(usize, Build)> = strokes.iter().enumerate().flat_map(|(i, s)| s.iter().map(move |m| (i, m.step))).collect();
    loop {
        let before = left.len();
        for p in 0..3 {
            left.retain(|(_, s)| pass(s) != p || !build(world, *s));
        }
        if left.is_empty() || left.len() == before {
            break;
        }
    }
    let mut stuck: Vec<Stroke> = vec![Vec::new(); strokes.len()];
    for (i, step) in left {
        stuck[i].push(Mark { step, stuck: true });
    }
    stuck.retain(|s| !s.is_empty());
    if !stuck.is_empty() {
        world.drafts.insert(owner, stuck);
    }
}

/// Every draft, with its bill, as the clients are sent them.
pub fn all(world: &World) -> Vec<Draft> {
    world.drafts.iter().map(|(&owner, strokes)| Draft { owner, strokes: strokes.clone(), bill: bill(world, strokes), depot: depot_for(world, strokes) }).collect()
}

/// The standing depot nearest the draft's first step.
fn depot_for(world: &World, strokes: &[Stroke]) -> Option<crate::protocol::EntityId> {
    let at = strokes.first()?.first()?.step.to;
    world
        .objects
        .iter()
        .filter(|e| matches!(e.object, GameObject::Building(ref b) if crate::economy::depot(b.kind) && b.site.is_none()))
        .filter_map(|e| Some((e.id, e.position?)))
        .min_by_key(|&(id, p)| ((p.x - at.x).abs() + (p.y - at.y).abs(), id))
        .map(|(id, _)| id)
}

/// The buildings a draft would found, by kind: a step painting on from a
/// drafted tile of its kind grows that building, or links it into a row;
/// from a building standing, it grows that, for nothing; onto one
/// standing, it joins it, for nothing; otherwise it is a building of its
/// own. As `World::paint` lays them.
fn founds(world: &World, strokes: &[Stroke]) -> Vec<BuildingKind> {
    let mut of: HashMap<(i32, i32), usize> = HashMap::new();
    // Each building founded, and the one it was joined into, if it was.
    let mut parent: Vec<usize> = Vec::new();
    let mut kinds: Vec<BuildingKind> = Vec::new();
    fn root(parent: &[usize], mut i: usize) -> usize {
        while parent[i] != i {
            i = parent[i];
        }
        i
    }
    for m in strokes.iter().flatten() {
        let Tool::Building(kind) = m.step.tool else { continue };
        let (from, to) = (m.step.from, m.step.to);
        let grows = crate::world::grows(kind);
        let standing = |t: GridCoord| matches!(world.occupied.get(&(t.x, t.y)).and_then(|&b| world.objects.get(b)).map(|e| &e.object), Some(GameObject::Building(b)) if b.kind == kind);
        if standing(to) || (grows && from != to && standing(from)) {
            continue;
        }
        let here = (from != to).then(|| of.get(&(from.x, from.y)).copied()).flatten().filter(|&g| kinds[g] == kind && grows);
        match (here, of.get(&(to.x, to.y)).copied()) {
            (Some(a), Some(b)) => {
                let (a, b) = (root(&parent, a), root(&parent, b));
                parent[a.max(b)] = a.min(b);
            }
            (Some(a), None) => {
                of.insert((to.x, to.y), a);
            }
            (None, None) => {
                of.insert((to.x, to.y), parent.len());
                parent.push(parent.len());
                kinds.push(kind);
            }
            (None, Some(_)) => {}
        }
    }
    (0..parent.len()).filter(|&i| root(&parent, i) == i).map(|i| kinds[i]).collect()
}

/// What a draft takes, material by material, against what the town has:
/// the depots' stock and what is on its way to them, less what the sites
/// already standing still wait for. The town's first depot is free, as it
/// stands at once (`World::founded`).
fn bill(world: &World, strokes: &[Stroke]) -> Vec<Line> {
    let mut founds = founds(world, strokes);
    let depot_stands = world.objects.iter().any(|e| matches!(e.object, GameObject::Building(ref b) if crate::economy::depot(b.kind) && b.site.is_none()));
    if !depot_stands && let Some(i) = founds.iter().position(|&k| crate::economy::depot(k)) {
        founds.remove(i);
    }
    let mut takes: BTreeMap<Good, f64> = BTreeMap::new();
    for kind in founds {
        for (good, n) in crate::blueprint::takes(kind) {
            *takes.entry(good).or_default() += n;
        }
    }
    // A road's stone, a tile at a time, for the tiles not road already;
    // before there is a harbour a road is free (`economy::paved`).
    let harbour = world.objects.iter().any(|e| matches!(e.object, GameObject::Building(ref b) if b.kind == BuildingKind::Harbour && b.site.is_none()));
    let road: HashSet<(i32, i32)> = strokes
        .iter()
        .flatten()
        .filter(|m| matches!(m.step.tool, Tool::Street | Tool::OneWay | Tool::Road))
        .flat_map(|m| [m.step.from, m.step.to])
        .filter(|t| world.road_node_at(*t).is_none())
        .map(|t| (t.x, t.y))
        .collect();
    if harbour && !road.is_empty() {
        *takes.entry(Good::Stone).or_default() += road.len() as f64 * crate::economy::ROAD_STONE;
    }
    if takes.is_empty() {
        return Vec::new();
    }
    let mut have: BTreeMap<Good, f64> = BTreeMap::new();
    for e in world.objects.iter() {
        let GameObject::Building(ref b) = e.object else { continue };
        if let Some(site) = &b.site {
            for (&good, s) in site {
                *have.entry(good).or_default() -= s.cap - s.level;
            }
        } else if crate::economy::depot(b.kind) {
            for (&good, s) in &b.stocks {
                *have.entry(good).or_default() += s.level;
            }
        }
    }
    for (t, _, _) in crate::haul::boxes(world) {
        if let Some(good) = t.good.filter(|_| !t.outbound) {
            *have.entry(good).or_default() += t.units;
        }
    }
    takes
        .into_iter()
        .map(|(good, takes)| {
            let have = have.get(&good).copied().unwrap_or(0.0).max(0.0);
            let boxes = ((takes - have).max(0.0) / good.per_box()).ceil() as u32;
            Line { good, takes, have, boxes, coins: crate::economy::quote(good, boxes) }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(x: i32, y: i32) -> GridCoord {
        GridCoord { x, y }
    }

    fn grass(world: &mut World) {
        for y in -10..10 {
            for x in -10..30 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
    }

    fn step(tool: Tool, from: GridCoord, to: GridCoord) -> Build {
        Build { tool, from, to }
    }

    #[test]
    fn a_drag_is_one_stroke_and_undo_takes_it_back() {
        let mut world = World::new();
        grass(&mut world);
        for x in 0..4 {
            assert!(draw(&mut world, 1, step(Tool::Street, at(x, 0), at(x + 1, 0))));
        }
        let house = Tool::Building(BuildingKind::House);
        assert!(draw(&mut world, 1, step(house, at(2, 1), at(2, 1))));
        assert!(draw(&mut world, 1, step(house, at(2, 1), at(3, 1))));
        assert_eq!(world.drafts[&1].iter().map(Vec::len).collect::<Vec<_>>(), vec![4, 2]);
        assert!(world.roads.is_empty() && world.occupied.is_empty(), "a draft built something");
        undo(&mut world, 1);
        assert_eq!(world.drafts[&1].len(), 1);
        discard(&mut world, 1);
        assert!(world.drafts.is_empty());
    }

    /// A press on a building already drawn, to paint on from it, drafts
    /// nothing: it would only be refused at the commit, and stick.
    #[test]
    fn a_press_on_a_drafted_building_is_nothing() {
        let mut world = World::new();
        grass(&mut world);
        let depot = Tool::Building(BuildingKind::Depot);
        assert!(draw(&mut world, 1, step(depot, at(5, 1), at(5, 1))));
        assert!(draw(&mut world, 1, step(depot, at(5, 1), at(6, 1))));
        assert!(draw(&mut world, 1, step(depot, at(6, 1), at(7, 1))));
        assert!(!draw(&mut world, 1, step(depot, at(6, 1), at(6, 1))), "a press drafted");
        assert!(draw(&mut world, 1, step(depot, at(6, 1), at(6, 2))));
        assert!(!draw(&mut world, 1, step(depot, at(6, 2), at(7, 1))), "a step within one drafted building");
        assert!(!draw(&mut world, 1, step(Tool::Building(BuildingKind::House), at(4, 1), at(5, 1))), "a house onto a depot");
        assert_eq!(world.drafts[&1].concat().len(), 4);
    }

    #[test]
    fn a_tile_drafted_is_nobody_elses() {
        let mut world = World::new();
        grass(&mut world);
        assert!(draw(&mut world, 1, step(Tool::Street, at(0, 0), at(1, 0))));
        assert!(!draw(&mut world, 2, step(Tool::Street, at(1, 0), at(2, 0))), "another player drew over a draft");
        assert!(!draw(&mut world, 2, step(Tool::Building(BuildingKind::House), at(0, 0), at(0, 0))));
        assert!(draw(&mut world, 1, step(Tool::Street, at(1, 0), at(2, 0))), "the owner could not carry on");
    }

    #[test]
    fn the_demolisher_rubs_out_a_draft() {
        let mut world = World::new();
        grass(&mut world);
        for x in 0..3 {
            draw(&mut world, 1, step(Tool::Street, at(x, 0), at(x + 1, 0)));
        }
        assert!(draw(&mut world, 1, step(Tool::Demolish, at(1, 0), at(2, 0))), "a drafted link was not cut");
        assert_eq!(world.drafts[&1].concat().len(), 2);
        assert!(draw(&mut world, 1, step(Tool::Demolish, at(0, 0), at(0, 0))));
        assert_eq!(world.drafts[&1].concat().len(), 1);
    }

    #[test]
    fn a_row_of_houses_is_a_bill_a_house_and_a_depot_one() {
        let mut world = World::new();
        grass(&mut world);
        let house = Tool::Building(BuildingKind::House);
        let depot = Tool::Building(BuildingKind::Depot);
        draw(&mut world, 1, step(house, at(0, 1), at(0, 1)));
        draw(&mut world, 1, step(house, at(0, 1), at(1, 1)));
        draw(&mut world, 1, step(house, at(1, 1), at(2, 1)));
        draw(&mut world, 1, step(depot, at(5, 1), at(5, 1)));
        draw(&mut world, 1, step(depot, at(5, 1), at(6, 1)));
        draw(&mut world, 1, step(depot, at(6, 1), at(6, 2)));
        assert_eq!(founds(&world, &world.drafts[&1]), vec![BuildingKind::House, BuildingKind::House, BuildingKind::House, BuildingKind::Depot]);
        // The first depot stands at once: three houses' timber.
        let bill = bill(&world, &world.drafts[&1]);
        let timber = crate::blueprint::takes(BuildingKind::House)[0].1;
        assert_eq!(bill.len(), 1);
        assert_eq!(bill[0].takes, 3.0 * timber);
        assert_eq!(bill[0].have, 0.0);
        assert_eq!(bill[0].boxes, (3.0 * timber / Good::Timber.per_box()).ceil() as u32);
    }
}
