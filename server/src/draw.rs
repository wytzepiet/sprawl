//! A drag of road, laid as a whole (docs/plan-interchange.md §A drag joins
//! only at its ends). The hand sends the whole drag so far each time it
//! reaches a tile (`Stroke`), and the drag is planned from end to end: what
//! a tile becomes depends on where the drag goes next, so a step is not
//! settled until the one after it is drawn. What was laid of it before
//! stands where the plan still says so; from the first tile whose plan may
//! have changed, what was laid is taken back and laid again.
//!
//! Each tile of the drag stands somewhere on its tile (`Place`): a height,
//! toward the pen's (a level, or a slope on to the next), and a side. A
//! road already there, along the way the drag goes, is followed, nothing
//! laid. A one-way run along a one-way that runs against it, going in along
//! it or going on along it, goes beside it, on the right of the way it is
//! drawn, the other moving over (`World::moves_over`); along a pair, on to
//! the one on its right; into one from the side, the near one. A drag that
//! starts on a one-way and sets off against it starts beside it. Anything
//! else is the middle. Of what may be, the first the world allows
//! (`game::may_step`); where nothing may, the drag stops there.
//!
//! The drag joins what it meets where it starts and where it ends: in
//! between, it turns only as it went (`RoadNode::banned`): its new links
//! turn to no other road on the tiles it passes through, nor any other
//! road to them. A drag is one action to undo (`undo::Act::Drawn`).

use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::intersection::IntersectionRegistry;
use crate::protocol::{Build, EntityId, GameObject, GridCoord, News, OwnerId, Stroke, Tool};
use crate::undo::{Act, Done, Laid, Link, Purse, WINDOW};
use crate::world::decks::{across, other, toward, Side, MIDDLE};
use crate::world::World;

/// Where on its tile a drag stands: how high, in half-levels, and on which
/// side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Place {
    pub h: u8,
    pub s: Side,
}

type Step = (i32, i32);

/// A drag drawn on, or a new one: laid as planned, what stands of it as
/// it was kept. Says so the first time the drag buys stone express.
pub fn draw(world: &mut World, events: &mut EventQueue, intersections: &mut IntersectionRegistry, owner: OwnerId, stroke: Stroke, now: GameTime) -> Option<News> {
    if !matches!(stroke.tool, Tool::Street | Tool::OneWay | Tool::Wide) || stroke.tiles.is_empty() {
        return None;
    }
    let history = world.undo.entry(owner).or_default();
    history.retain(|d| now.saturating_sub(d.at) <= WINDOW);
    // The drag drawn on: what it laid, and how much of it may stand.
    let mine = matches!(history.last(), Some(Done { act: Act::Drawn { stroke: was, .. }, .. }) if was.id == stroke.id);
    let (was, mut steps, after) = match mine.then(|| history.pop()).flatten() {
        Some(Done { act: Act::Drawn { stroke: was, steps }, after, .. }) => (Some(was), steps, after),
        _ => (None, Vec::new(), world.objects.next_id()),
    };
    let express = |steps: &[Laid]| steps.iter().map(|s| s.paid.coins).sum::<f64>();
    let paid_before = express(&steps);
    // A step lays its tile with the next in sight: while the tiles up to
    // the one after it are as they were, it stands.
    let same = was.as_ref().filter(|w| w.tool == stroke.tool && w.road == stroke.road && w.start == stroke.start).map_or(0, |w| w.tiles.iter().zip(&stroke.tiles).take_while(|(a, b)| a == b).count());
    let gone = steps.split_off(steps.len().min(same.saturating_sub(2)));
    crate::undo::take_back(world, events, intersections, &gone, now);
    lay_on(world, &stroke, &mut steps, now);
    turns(world, &steps);
    let coins = express(&steps);
    world.undo.entry(owner).or_default().push(Done { act: Act::Drawn { stroke, steps }, at: now, after });
    (paid_before == 0.0 && coins > 0.0).then(|| News {
        text: format!("Stone bought express, {coins:.0} coins"),
        sub: "the depots have none for the road; a rule on a depot keeps some in".into(),
        at: world.harbours.keys().next().copied().unwrap_or(0),
    })
}

/// The drag laid on from the last step standing, tile by tile, each where
/// the plan puts it, until it is done or one may not be.
fn lay_on(world: &mut World, stroke: &Stroke, steps: &mut Vec<Laid>, now: GameTime) {
    let tiles: Vec<GridCoord> = stroke.tiles.iter().map(|s| s.at).collect();
    for i in steps.len() + 1..tiles.len() {
        let froms = match steps.last() {
            Some(last) => vec![place_of(world, last.nodes[1])],
            None => starts(world, stroke, &tiles),
        };
        let Some((pf, pt)) = plan(world, stroke, &tiles, i, &froms) else { return };
        let (from, to) = (tiles[i - 1], tiles[i]);
        let link = Link { from, to, one_way: stroke.tool != Tool::Street, road: stroke.road, up: [pf.h, pt.h], sides: [pf.s, pt.s], wide: stroke.tool == Tool::Wide };
        let fresh = world.link_between_at(from, pf.h, pf.s, to, pt.h, pt.s).is_none();
        let purse = Purse::of(world);
        if fresh {
            let laid = crate::game::lay(world, link);
            crate::economy::paved(world, to, laid, now);
        } else if let Some((a, b)) = world.link_between_at(from, pf.h, pf.s, to, pt.h, pt.s)
            && (world.is_road(a) && world.is_road(b)) != stroke.road
        {
            world.set_priority(a, b, stroke.road);
        }
        let (Some(a), Some(b)) = (world.node_in(from, pf.h, pf.s), world.node_in(to, pt.h, pt.s)) else { return };
        steps.push(Laid { link, nodes: [a, b], fresh, paid: purse.paid(world) });
    }
}

/// Where a node stands on its tile.
fn place_of(world: &World, id: EntityId) -> Place {
    Place { h: world.height_of(id), s: world.side_of(id) }
}

/// Where the drag may start on its first tile, the likeliest first: where
/// it was pressed; beside the one-way it was pressed on, if it sets off
/// against it, before that.
fn starts(world: &World, stroke: &Stroke, tiles: &[GridCoord]) -> Vec<Place> {
    let p = stroke.start.map_or(Place { h: stroke.tiles[0].want, s: MIDDLE }, |s| Place { h: s.h, s: s.side });
    let mut out = Vec::new();
    if stroke.tool == Tool::OneWay && p.s == MIDDLE && tiles.len() > 1 {
        let on = step(tiles[0], tiles[1]);
        out.extend(beside(world, tiles[0], p.h, None, Some(on), None).into_iter().map(|s| Place { h: p.h, s }));
    }
    out.push(p);
    out
}

/// Where tile `i` of the drag stands, coming from one of `froms` on the
/// tile before: the first of what may be that the world allows, and which
/// of `froms` it came from; none, where nothing may.
fn plan(world: &World, stroke: &Stroke, tiles: &[GridCoord], i: usize, froms: &[Place]) -> Option<(Place, Place)> {
    let (from, to) = (tiles[i - 1], tiles[i]);
    for &pf in froms {
        for h in heights(world, to, pf.h, stroke.tiles[i].want) {
            for s in sides(world, stroke.tool, tiles, i, h, pf) {
                let pt = Place { h, s };
                // Its cars go on as the drag does; at its end, as it may
                // yet: straight on.
                let on = Some(tiles.get(i + 1).map_or(step(from, to), |&n| step(to, n)));
                if follows(world, stroke.tool, from, pf, to, pt) || may(world, stroke, from, pf, to, pt, on) {
                    return Some((pf, pt));
                }
            }
        }
    }
    None
}

/// The heights a step from `h` toward the pen's height `want` may stand
/// at, the likeliest first: from a level, a level on or a slope toward it;
/// from a slope, the next slope on while a level or more is left to climb,
/// else the level it climbs to. Where that may not be, the level it is
/// on, and the road comes up on the next tile; and the heights of the
/// roads there it may join.
fn heights(world: &World, to: GridCoord, h: u8, want: u8) -> Vec<u8> {
    let plan = if h == want {
        want
    } else if h % 2 == 1 && h.abs_diff(want) > 1 {
        if want > h { h + 2 } else { h - 2 }
    } else if want > h {
        h + 1
    } else {
        h - 1
    };
    let mut out = vec![plan];
    if h % 2 == 0 {
        out.push(h);
    }
    let mut there: Vec<u8> = world.nodes_on(to).into_iter().map(|(g, _)| g).filter(|g| g.abs_diff(h) <= 1).collect();
    there.sort_by_key(|g| g.abs_diff(want));
    out.extend(there);
    dedup(out)
}

/// The sides tile `i` may stand on at height `h`, the likeliest first:
/// along a road already there, that road; a one-way, beside or into a
/// one-way there (`beside`); the middle.
fn sides(world: &World, tool: Tool, tiles: &[GridCoord], i: usize, h: u8, pf: Place) -> Vec<Side> {
    let (from, to) = (tiles[i - 1], tiles[i]);
    let mut out = Vec::new();
    if let Some(a) = world.node_in(from, pf.h, pf.s) {
        for (g, id) in world.nodes_on(to) {
            if g == h && linked(world, a, id) {
                out.push(world.side_of(id));
            }
        }
    }
    if tool == Tool::OneWay {
        out.extend(beside(world, to, h, Some(step(from, to)), tiles.get(i + 1).map(|&n| step(to, n)), Some(pf.s)));
    }
    out.push(MIDDLE);
    dedup(out)
}

/// Where on a tile a one-way stands among the one-ways there at height
/// `h`, coming in by `inn` and going on by `out`, from a tile it stood on
/// `came` on: among a pair, the one running its way, else the one on the
/// side it is on or comes from; beside a one-way in the middle that runs
/// against it, along it, the other moving over: on the side it is on,
/// else, come along it, on its right, else, come across it, on the side
/// it comes from, never across it. Nothing else.
fn beside(world: &World, at: GridCoord, h: u8, inn: Option<Step>, out: Option<Step>, came: Option<Side>) -> Vec<Side> {
    let on: Vec<(EntityId, Side)> = world.nodes_on(at).into_iter().filter(|&(g, _)| g == h).map(|(_, id)| (id, world.side_of(id))).collect();
    let back = inn.map(|(x, y)| (-x, -y));
    let came = came.filter(|&s| s != MIDDLE);
    // The side nearest: the one it is on, else the one it comes from.
    let near = |s: Side| came.map_or(0, |c| toward((c[0] as i32, c[1] as i32), s)) * 2 + back.map_or(0, |b| toward(b, s));
    let pair: Vec<(EntityId, Side)> = on.iter().copied().filter(|&(_, s)| s != MIDDLE).collect();
    if !pair.is_empty() {
        let travel = inn.or(out);
        let mut pair = pair;
        pair.sort_by_key(|&(id, s)| (!travel.is_some_and(|t| runs(world, id, t)), -near(s)));
        return pair.into_iter().map(|(_, s)| s).collect();
    }
    let Some(m) = world.node_at(at, h) else { return Vec::new() };
    let mut arms = world.arms_of(m, false);
    arms.sort_unstable();
    arms.dedup();
    let Some(steps) = world.steps_to(m, &arms) else { return Vec::new() };
    // Against it: come in along it, it runs out the way the drag came; or
    // going on along it, it runs in from where the drag goes.
    let in_along = back.filter(|b| steps.contains(b));
    let out_along = out.filter(|o| steps.contains(o));
    let against = in_along.zip(inn).is_some_and(|(_, t)| runs(world, m, (-t.0, -t.1))) || (in_along.is_none() && out_along.is_some_and(|o| runs(world, m, (-o.0, -o.1))));
    let Some(way) = across(&steps).filter(|_| against) else { return Vec::new() };
    let right = |(x, y): Step| (-y, x);
    let toward_s = |s: Side| match (came, in_along, back) {
        (Some(c), _, _) => toward((c[0] as i32, c[1] as i32), s),
        (None, Some(_), _) => toward(right(inn.unwrap()), s),
        (None, None, Some(b)) => toward(b, s),
        (None, None, None) => out.map_or(0, |o| toward(right(o), s)),
    };
    let s = if toward_s(way) > 0 { way } else { other(way) };
    [s, other(s)].into_iter().filter(|&s| world.moves_over(at, h, s).is_some()).collect()
}

/// Does a road run this way through a node: out by an arm that way, or in
/// by one from the other.
fn runs(world: &World, id: EntityId, (x, y): Step) -> bool {
    world.arms_of(id, false).into_iter().any(|a| {
        let Some(s) = world.steps_to(id, &[a]).map(|v| v[0]) else { return false };
        (s == (x, y) && world.edges.contains_key(&(id, a))) || (s == (-x, -y) && world.edges.contains_key(&(a, id)))
    })
}

/// Is there a road already from here to there that a drag with this tool
/// runs along: either way for a street, its way for a one-way.
fn follows(world: &World, tool: Tool, from: GridCoord, pf: Place, to: GridCoord, pt: Place) -> bool {
    let (Some(a), Some(b)) = (world.node_in(from, pf.h, pf.s), world.node_in(to, pt.h, pt.s)) else { return false };
    world.edges.contains_key(&(a, b)) && (tool == Tool::Street) == world.edges.contains_key(&(b, a))
}

/// May the step be laid, the drag going on from it that way, if it does
/// (`game::may_step_on`).
fn may(world: &World, stroke: &Stroke, from: GridCoord, pf: Place, to: GridCoord, pt: Place, on: Option<Step>) -> bool {
    let up = (pf.h > 0 || pt.h > 0).then_some([pf.h, pt.h]);
    let sides = (pf.s != MIDDLE || pt.s != MIDDLE).then_some([pf.s, pt.s]);
    crate::game::may_step_on(world, Build { tool: stroke.tool, from, to, up, sides, road: stroke.road }, on)
}

/// The turns the drag drew, on the tiles it passes through: its new links
/// turn to no other road there, nor any other road to them; where it starts
/// and ends, they join what is there.
fn turns(world: &mut World, steps: &[Laid]) {
    let Some(first) = steps.first() else { return };
    let nodes: Vec<EntityId> = std::iter::once(first.nodes[0]).chain(steps.iter().map(|s| s.nodes[1])).collect();
    for (k, &x) in nodes.iter().enumerate() {
        let came = k.checked_sub(1).map(|j| (steps[j].nodes[0], steps[j].fresh));
        let goes = steps.get(k).map(|s| (s.nodes[1], s.fresh));
        let ends: Vec<EntityId> = [came, goes].into_iter().flatten().map(|(n, _)| n).collect();
        let fresh: Vec<EntityId> = [came, goes].into_iter().flatten().filter(|&(_, f)| f).map(|(n, _)| n).collect();
        let mut others = world.arms_of(x, false);
        others.sort_unstable();
        others.dedup();
        others.retain(|o| !ends.contains(o));
        let through = came.is_some() && goes.is_some();
        let Some(GameObject::RoadNode(n)) = world.objects.get_mut(x).map(|e| &mut e.object) else { continue };
        let was = n.banned.clone();
        n.banned.retain(|t| !fresh.iter().any(|f| t.contains(f)));
        for &f in fresh.iter().filter(|_| through) {
            for &o in &others {
                n.banned.extend([[f, o], [o, f]]);
            }
        }
        if n.banned != was
            && let Some(at) = world.objects.get(x).and_then(|e| e.position)
        {
            world.unsettle_round(at);
        }
    }
}

fn linked(world: &World, a: EntityId, b: EntityId) -> bool {
    world.edges.contains_key(&(a, b)) || world.edges.contains_key(&(b, a))
}

fn step(a: GridCoord, b: GridCoord) -> Step {
    (b.x - a.x, b.y - a.y)
}

fn dedup<T: PartialEq>(v: Vec<T>) -> Vec<T> {
    let mut out: Vec<T> = Vec::new();
    for x in v {
        if !out.contains(&x) {
            out.push(x);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Spot, TerrainType};

    /// Open grass, and a hand that draws on it as the brush does: the
    /// whole drag so far, a tile on each time.
    struct Field {
        world: World,
        events: EventQueue,
        intersections: IntersectionRegistry,
        id: u32,
    }

    impl Field {
        fn new() -> Field {
            let mut world = World::new();
            for y in -10..10 {
                for x in -10..16 {
                    world.terrain.insert((x, y), TerrainType::Grass);
                }
            }
            world.build = crate::tree::Build::all();
            world.treasury = 1e9;
            Field { world, events: EventQueue::new(), intersections: IntersectionRegistry::new(), id: 0 }
        }

        fn drag(&mut self, tool: Tool, tiles: &[(i32, i32)]) {
            self.id += 1;
            for n in 1..=tiles.len() {
                let spots = tiles[..n].iter().map(|&(x, y)| Spot { at: GridCoord { x, y }, want: 0 }).collect();
                draw(&mut self.world, &mut self.events, &mut self.intersections, 1, Stroke { id: self.id, tool, road: false, tiles: spots, start: None }, 0);
            }
        }

        fn node(&self, x: i32, y: i32) -> EntityId {
            self.world.road_node_at(GridCoord { x, y }).unwrap()
        }

        fn turn(&self, a: (i32, i32), b: (i32, i32), c: (i32, i32)) -> bool {
            crate::world::pathfinding::may_turn(&self.world, self.node(a.0, a.1), self.node(b.0, b.1), self.node(c.0, c.1))
        }
    }

    /// A drag joins the roads it meets where it starts and where it ends;
    /// between, it turns only as it went: straight over a road, a
    /// crossing; along one, from where it came to where it went on.
    #[test]
    fn a_drag_joins_only_at_its_ends() {
        let mut f = Field::new();
        let row: Vec<(i32, i32)> = (0..9).map(|x| (x, 0)).collect();
        f.drag(Tool::Street, &row);
        // Straight over it, and up to it and away from it, two drags.
        f.drag(Tool::Street, &[(2, 3), (2, 2), (2, 1), (2, 0), (2, -1), (2, -2)]);
        f.drag(Tool::Street, &[(4, 3), (4, 2), (4, 1), (4, 0)]);
        f.drag(Tool::Street, &[(4, 0), (4, -1), (4, -2)]);
        // Up to it and on along it, one drag.
        f.drag(Tool::Street, &[(6, 3), (6, 2), (6, 1), (6, 0), (7, 0)]);
        assert!(f.turn((2, 1), (2, 0), (2, -1)) && f.turn((1, 0), (2, 0), (3, 0)), "a crossing goes straight on");
        assert!(!f.turn((2, 1), (2, 0), (1, 0)) && !f.turn((1, 0), (2, 0), (2, -1)), "a crossing turns");
        for (a, c) in [((4, 1), (3, 0)), ((4, 1), (5, 0)), ((3, 0), (4, -1)), ((4, 1), (4, -1))] {
            assert!(f.turn(a, (4, 0), c), "the drags that end and start at (4, 0) do not join it: {a:?} to {c:?}");
        }
        assert!(f.turn((6, 1), (6, 0), (7, 0)) && f.turn((7, 0), (6, 0), (6, 1)) && f.turn((5, 0), (6, 0), (7, 0)), "the drag along the road does not go as it went");
        assert!(!f.turn((6, 1), (6, 0), (5, 0)) && !f.turn((5, 0), (6, 0), (6, 1)), "the drag along the road turns as it did not");
    }

    /// Drawn on a tile at a time, a drag keeps what it laid: only the
    /// last step, whose tile now has a next, is laid again.
    #[test]
    fn a_drag_drawn_on_keeps_what_it_laid() {
        let mut f = Field::new();
        let row: Vec<(i32, i32)> = (0..6).map(|x| (x, 0)).collect();
        f.drag(Tool::OneWay, &row[..4]);
        let kept = f.node(1, 0);
        let spots = row.iter().map(|&(x, y)| Spot { at: GridCoord { x, y }, want: 0 }).collect();
        draw(&mut f.world, &mut f.events, &mut f.intersections, 1, Stroke { id: f.id, tool: Tool::OneWay, road: false, tiles: spots, start: None }, 0);
        assert_eq!(f.node(1, 0), kept, "a step standing as planned was laid again");
        assert!(f.world.road_node_at(GridCoord { x: 5, y: 0 }).is_some(), "the drag was not drawn on");
        match f.world.undo.get(&1).and_then(|h| h.last()).map(|d| &d.act) {
            Some(Act::Drawn { steps, .. }) => assert_eq!(steps.len(), 5),
            other => panic!("the drag is not one action: {other:?}"),
        }
    }

    /// A street joining another at 45 degrees: its cars turn the shallow
    /// way, and none turns sharper than a right angle.
    #[test]
    fn a_junction_at_45_degrees_turns_the_shallow_way() {
        let mut f = Field::new();
        let row: Vec<(i32, i32)> = (0..9).map(|x| (x, 0)).collect();
        f.drag(Tool::Street, &row);
        f.drag(Tool::Street, &[(1, 4), (2, 3), (3, 2), (4, 1), (5, 0)]);
        assert!(f.world.road_node_at(GridCoord { x: 4, y: 1 }).is_some(), "the diagonal was not laid");
        assert!(f.turn((4, 1), (5, 0), (6, 0)) && f.turn((6, 0), (5, 0), (4, 1)), "the shallow turns are not there");
        assert!(!f.turn((4, 1), (5, 0), (4, 0)) && !f.turn((4, 0), (5, 0), (4, 1)), "a car turns sharper than a right angle");
    }

    /// Two one-ways bending through one tile, each round its own corner:
    /// one junction, each turning only as it was drawn.
    #[test]
    fn two_bends_through_one_tile_keep_to_their_corners() {
        let mut f = Field::new();
        f.drag(Tool::OneWay, &[(0, 0), (1, 0), (2, 0), (2, -1), (2, -2)]);
        f.drag(Tool::OneWay, &[(2, 2), (2, 1), (2, 0), (3, 0), (4, 0)]);
        assert!(f.turn((1, 0), (2, 0), (2, -1)) && f.turn((2, 1), (2, 0), (3, 0)), "the bends are not driven");
        assert!(!f.turn((1, 0), (2, 0), (3, 0)) && !f.turn((2, 1), (2, 0), (2, -1)), "a bend turns into the other");
    }

    /// A diagonal past a one-way's bend, its cars arriving where the bend
    /// only turns back sharp: the drag goes on, so they go on with it.
    #[test]
    fn a_diagonal_past_a_bend_that_turns_back() {
        let mut f = Field::new();
        f.drag(Tool::OneWay, &[(2, -2), (2, -1), (2, 0), (1, 0), (0, 0)]);
        f.drag(Tool::OneWay, &[(0, 2), (1, 1), (2, 0), (3, -1), (4, -2)]);
        assert!(f.world.road_node_at(GridCoord { x: 4, y: -2 }).is_some(), "the diagonal stopped at the bend");
        assert!(f.turn((1, 1), (2, 0), (3, -1)) && f.turn((2, -1), (2, 0), (1, 0)), "the two do not go on");
        assert!(!f.turn((1, 1), (2, 0), (1, 0)) && !f.turn((2, -1), (2, 0), (3, -1)), "the two turn into each other");
    }

    /// A pair round a bend: the one on the outside may go on straight
    /// past the other's bend, keeping clear of it; the one on the inside
    /// may not cut across it.
    #[test]
    fn the_outside_of_a_pair_goes_on_past_its_bend() {
        let mut f = Field::new();
        f.drag(Tool::OneWay, &[(8, 0), (7, 0), (6, 0), (5, 0), (4, 0), (4, 1), (4, 2), (4, 3)]);
        f.drag(Tool::OneWay, &[(4, 3), (4, 2), (4, 1), (4, 0), (5, 0), (6, 0), (7, 0), (8, 0)]);
        let pair = |f: &Field| f.world.nodes_on(GridCoord { x: 4, y: 0 }).len();
        assert_eq!(pair(&f), 2, "no pair round the bend");
        // The westbound one, outside the bend, drawn on west.
        let outer = f.world.nodes_on(GridCoord { x: 4, y: 0 }).into_iter().map(|(_, id)| id).find(|&id| f.world.arms_of(id, false).len() == 1 || f.world.side_of(id)[1] < 0).unwrap();
        let side = f.world.side_of(outer);
        f.id += 1;
        let spots = [(4, 0), (3, 0), (2, 0)].iter().map(|&(x, y)| Spot { at: GridCoord { x, y }, want: 0 }).collect();
        draw(&mut f.world, &mut f.events, &mut f.intersections, 1, Stroke { id: f.id, tool: Tool::OneWay, road: false, tiles: spots, start: Some(crate::protocol::Stand { h: 0, side }) }, 0);
        assert!(f.world.road_node_at(GridCoord { x: 2, y: 0 }).is_some(), "the outer road could not go on past the bend");
        assert_eq!(pair(&f), 2, "the pair came apart");
    }

    #[test]
    fn a_pair_parts_one_round_a_bend_and_one_down_a_diagonal() {
        // Two pairs a row apart, and between them, from the lower pair's
        // westbound road, one up a step and on east along the upper pair,
        // and from the upper pair's westbound road, one on west and down a
        // diagonal to the lower's. On the tile they share, each keeps to
        // its own side, whichever is drawn first.
        for up_first in [true, false] {
            let mut f = Field::new();
            f.drag(Tool::OneWay, &[(0, -4), (1, -4), (2, -4), (3, -4), (4, -4), (5, -4), (6, -4), (7, -4), (8, -4), (9, -4), (10, -4)]);
            f.drag(Tool::OneWay, &[(10, -4), (9, -4), (8, -4), (7, -4), (6, -4), (5, -4), (4, -4), (3, -4), (2, -4), (1, -4), (0, -4)]);
            let westbound = f.world.nodes_on(GridCoord { x: 4, y: -4 }).into_iter().map(|(_, id)| f.world.side_of(id)).find(|s| s[1] < 0).unwrap();
            let up = |f: &mut Field| {
                f.id += 1;
                let tiles = [(4, -4), (4, -5), (5, -5), (6, -5), (7, -5), (8, -5), (9, -5)];
                for n in 2..=tiles.len() {
                    let spots = tiles[..n].iter().map(|&(x, y)| Spot { at: GridCoord { x, y }, want: 0 }).collect();
                    draw(&mut f.world, &mut f.events, &mut f.intersections, 1, Stroke { id: f.id, tool: Tool::OneWay, road: false, tiles: spots, start: Some(crate::protocol::Stand { h: 0, side: westbound }) }, 0);
                }
            };
            let down = |f: &mut Field| f.drag(Tool::OneWay, &[(9, -5), (8, -5), (7, -5), (6, -5), (5, -5), (4, -5), (3, -4)]);
            if up_first {
                up(&mut f);
                down(&mut f);
            } else {
                down(&mut f);
                up(&mut f);
            }
            for (x, y) in [(4, -5), (9, -5)] {
                assert_eq!(f.world.nodes_on(GridCoord { x, y }).len(), 2, "({x}, {y}) not a pair, up first: {up_first}");
            }
        }
    }
}
