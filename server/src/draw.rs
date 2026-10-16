//! A drag of road, laid as a whole (docs/plan-interchange.md §A drag joins
//! only at its ends). The hand sends the whole drag so far each time it
//! reaches a tile (`Stroke`), and the drag is planned from end to end: what
//! a tile becomes depends on where the drag goes next, so a step is not
//! settled until the one after it is drawn. What was laid of it before
//! stands where the plan still says so; from the first tile whose plan may
//! have changed, what was laid is taken back and laid again.
//!
//! Each tile of the drag stands somewhere on its tile (`Place`): a height,
//! toward the pen's (a level, or a slope on to the next), and a side. The
//! plan offers the places a tile may stand in the order a hand would mean
//! them (`sides`): along a road already there, followed, nothing laid; a
//! one-way beside a road that runs against it, the road moving over
//! (`World::moving_over`); into a road there; the middle; on along the
//! side it is on. Of these, the first the world allows (`game::may_step`),
//! judged with the drag's next step where it is drawn (`plan`); where
//! nothing may, the drag stops there. Where roads may stand is the world's
//! one rule of their shapes (`world/clear.rs`), not the plan's.
//!
//! Wherever the drag meets a road on its level, it joins it: a junction,
//! with every turn its angles allow. A road to cross with no turns goes
//! over or under. A drag is one action to undo (`undo::Act::Drawn`).

use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::intersection::IntersectionRegistry;
use crate::protocol::{Build, EntityId, GridCoord, News, OwnerId, Spot, Stand, Stroke, Tool};
use crate::undo::{Act, Done, Laid, Link, Purse, WINDOW};
use crate::world::decks::{across, other, toward, Side, MIDDLE};
use crate::world::clear::End;
use crate::world::World;

/// Where on its tile a drag stands: how high, in half-levels, and on which
/// side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Place {
    pub h: u8,
    pub s: Side,
}

type Step = (i32, i32);

/// The eight steps from a tile, as the hand numbers them: east, and on
/// round toward +y.
pub const STEPS: [Step; 8] = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)];

/// Where a drag may go on from its last tile (`hint.rs`): for each of the
/// eight steps, where it would stand on the tile it steps to, as the plan
/// would lay it now; none where it may not. From where it stands as laid,
/// or, a drag only pressed, from where it may start.
pub fn reach(world: &World, owner: OwnerId, stroke: &Stroke) -> Vec<Option<Stand>> {
    let n = stroke.tiles.len();
    let Some(&last) = stroke.tiles.last() else { return vec![None; 8] };
    let laid = world.undo.get(&owner).and_then(|h| h.last()).and_then(|d| match &d.act {
        Act::Drawn { stroke: was, steps } if was.id == stroke.id && steps.len() + 1 == n => steps.last().map(|s| place_of(world, s.nodes[1])),
        _ => None,
    });
    if n > 1 && laid.is_none() {
        return vec![None; 8];
    }
    STEPS
        .iter()
        .map(|&(dx, dy)| {
            let mut on = stroke.clone();
            on.tiles.push(Spot { at: GridCoord { x: last.at.x + dx, y: last.at.y + dy }, want: last.want });
            let tiles: Vec<GridCoord> = on.tiles.iter().map(|s| s.at).collect();
            let froms = laid.map_or_else(|| starts(world, &on, &tiles), |p| vec![p]);
            plan(world, &on, &tiles, n, &froms).map(|(_, p)| Stand { h: p.h, side: p.s })
        })
        .collect()
}

/// May a drag with this tool start on this tile: a step out of it, from
/// anywhere on it, at the pen's height or on a road there.
pub fn may_start(world: &World, tool: Tool, road: bool, want: u8, at: GridCoord) -> bool {
    let on: Vec<Place> = world.nodes_on(at).into_iter().map(|(_, id)| place_of(world, id)).collect();
    STEPS.iter().any(|&(dx, dy)| {
        let tiles = [at, GridCoord { x: at.x + dx, y: at.y + dy }];
        let stroke = Stroke { id: 0, tool, road, tiles: tiles.iter().map(|&at| Spot { at, want }).collect(), start: None };
        let mut froms = on.clone();
        froms.extend(starts(world, &stroke, &tiles));
        plan(world, &stroke, &tiles, 1, &dedup(froms)).is_some()
    })
}

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
            && world.is_road_between(a, b) != stroke.road
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
/// it was pressed; a one-way pressed in the middle, beside a road there it
/// sets off against, before that.
fn starts(world: &World, stroke: &Stroke, tiles: &[GridCoord]) -> Vec<Place> {
    let p = stroke.start.map_or(Place { h: stroke.tiles[0].want, s: MIDDLE }, |s| Place { h: s.h, s: s.side });
    let mut out = Vec::new();
    if stroke.tool == Tool::OneWay && p.s == MIDDLE {
        out.extend(beside(world, tiles, 0, p.h, MIDDLE).into_iter().map(|s| Place { h: p.h, s }));
    }
    out.push(p);
    out
}

/// Where tile `i` of the drag stands, coming from one of `froms` on the
/// tile before: the first of what may be that the world allows, alone or
/// with the drag's next step, and which of `froms` it came from; none,
/// where nothing may. The next step is where it is drawn already; at the
/// drag's end, where it is likeliest to go: on along the road it goes
/// beside, as a drag round the inside of a bend beside another must have
/// that road's next stretch moved over to fit.
fn plan(world: &World, stroke: &Stroke, tiles: &[GridCoord], i: usize, froms: &[Place]) -> Option<(Place, Place)> {
    let (from, to) = (tiles[i - 1], tiles[i]);
    for &pf in froms {
        for h in heights(world, to, pf.h, stroke.tiles[i].want) {
            for s in sides(world, stroke.tool, tiles, i, h, pf) {
                let pt = Place { h, s };
                // Its cars go on as the drag does; at its end, as it may
                // yet: straight on.
                let on = Some(tiles.get(i + 1).map_or(step(from, to), |&n| step(to, n)));
                if follows(world, stroke.tool, from, pf, to, pt) || may(world, stroke, from, pf, to, pt, on, None) {
                    return Some((pf, pt));
                }
                // Laid with the next, as a drag beside a road moves it over.
                let ahead: Vec<GridCoord> = match tiles.get(i + 1) {
                    Some(&next) => vec![next],
                    None => world.moving_over(to, h, s).into_iter().flat_map(|(m, _)| world.arms_of(m, false)).filter_map(|a| world.objects.get(a)?.position).filter(|&t| t != from).collect(),
                };
                for next in ahead {
                    let mut on_to = tiles.to_vec();
                    on_to.truncate(i + 1);
                    on_to.push(next);
                    let want = stroke.tiles.get(i + 1).unwrap_or(&stroke.tiles[i]).want;
                    let thens: Vec<End> = heights(world, next, h, want).into_iter().flat_map(|g| sides(world, stroke.tool, &on_to, i + 1, g, pt).into_iter().map(move |s| (next, g, s))).collect();
                    if thens.into_iter().any(|then| may(world, stroke, from, pf, to, pt, on, Some(then))) {
                        return Some((pf, pt));
                    }
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

/// The sides tile `i` may stand on at height `h`, coming from `pf` on the
/// tile before, the likeliest first: along a road already there, that
/// road; a one-way, beside a road there that runs against it (`beside`);
/// into a road there, the one running its way first, then the nearest the
/// side it is on; the middle; else on along the side it is on, as a ramp
/// keeps beside the road it climbed beside until it is clear of it.
/// Which may be, the world says.
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
        out.extend(beside(world, tiles, i, h, pf.s));
    }
    let travel = tiles.get(i + 1).map_or(step(from, to), |&n| step(to, n));
    let mut into: Vec<(EntityId, Side)> = world.nodes_on(to).into_iter().filter(|&(g, _)| g == h).map(|(_, id)| (id, world.side_of(id))).collect();
    into.sort_by_key(|&(id, s)| (!runs(world, id, travel), -toward(wide(pf.s), s).signum()));
    out.extend(into.into_iter().map(|(_, s)| s));
    out.extend([MIDDLE, pf.s]);
    dedup(out)
}

/// The free sides of tile `i` beside the roads there, within a level of
/// `h`, that run against the drag, along the way it comes in or goes on:
/// the side it is on (`came`) first, then the side it comes from, then its
/// right. The road there moves over (`World::moving_over`).
fn beside(world: &World, tiles: &[GridCoord], i: usize, h: u8, came: Side) -> Vec<Side> {
    let at = tiles[i];
    let inn = i.checked_sub(1).map(|j| step(tiles[j], at));
    let out = tiles.get(i + 1).map(|&n| step(at, n));
    let back = inn.map(|(x, y)| (-x, -y));
    let mut found = Vec::new();
    for (g, m) in world.nodes_on(at) {
        let mut arms = world.arms_of(m, false);
        arms.sort_unstable();
        arms.dedup();
        let Some(steps) = world.steps_to(m, &arms).filter(|_| g.abs_diff(h) < 2) else { continue };
        // Against it: come in along it, it runs out the way the drag came;
        // or going on along it, it runs in from where the drag goes.
        let in_along = back.filter(|b| steps.contains(b));
        let against = match (in_along, out.filter(|o| steps.contains(o))) {
            (Some(b), _) => runs(world, m, b),
            (None, Some(o)) => runs(world, m, (-o.0, -o.1)),
            _ => false,
        };
        let way = match world.side_of(m) {
            MIDDLE => across(&steps),
            s => Some(s),
        };
        if let Some(w) = way.filter(|_| against) {
            found.extend([w, other(w)]);
        }
    }
    found.retain(|&s| s != MIDDLE && world.node_in(at, h, s).is_none());
    let right = inn.or(out).map(|(x, y)| (-y, x));
    let key = |s: Side| [toward(wide(came), s).signum(), back.map_or(0, |b| toward(b, s)).signum(), right.map_or(0, |r| toward(r, s)).signum()];
    found.sort_by_key(|&s| std::cmp::Reverse(key(s)));
    dedup(found)
}

/// A side as a step.
fn wide(s: Side) -> Step {
    (s[0] as i32, s[1] as i32)
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

/// May the step be laid, the drag going on from it that way, if it does,
/// and to `then`, if that is known (`game::may_step_on`).
#[allow(clippy::too_many_arguments)]
fn may(world: &World, stroke: &Stroke, from: GridCoord, pf: Place, to: GridCoord, pt: Place, on: Option<Step>, then: Option<End>) -> bool {
    let up = (pf.h > 0 || pt.h > 0).then_some([pf.h, pt.h]);
    let sides = (pf.s != MIDDLE || pt.s != MIDDLE).then_some([pf.s, pt.s]);
    crate::game::may_step_on(world, Build { tool: stroke.tool, from, to, up, sides, road: stroke.road }, on, then)
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

    /// A drag joins every road it meets on its level: straight over one, a
    /// crossroads, every turn there.
    #[test]
    fn a_drag_joins_what_it_meets() {
        let mut f = Field::new();
        let row: Vec<(i32, i32)> = (0..5).map(|x| (x, 0)).collect();
        f.drag(Tool::Street, &row);
        f.drag(Tool::Street, &[(2, 3), (2, 2), (2, 1), (2, 0), (2, -1), (2, -2)]);
        for (a, c) in [((2, 1), (2, -1)), ((1, 0), (3, 0)), ((2, 1), (1, 0)), ((2, 1), (3, 0)), ((1, 0), (2, -1)), ((3, 0), (2, 1))] {
            assert!(f.turn(a, (2, 0), c), "no way from {a:?} to {c:?} at the crossroads");
        }
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
    /// one junction, its bends driven.
    #[test]
    fn two_bends_through_one_tile_meet_in_a_junction() {
        let mut f = Field::new();
        f.drag(Tool::OneWay, &[(0, 0), (1, 0), (2, 0), (2, -1), (2, -2)]);
        f.drag(Tool::OneWay, &[(2, 2), (2, 1), (2, 0), (3, 0), (4, 0)]);
        assert!(f.turn((1, 0), (2, 0), (2, -1)) && f.turn((2, 1), (2, 0), (3, 0)), "the bends are not driven");
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

    /// A one-way round a corner, and one drawn back against it along the
    /// same tiles: round the inside of the corner or the outside, as it
    /// keeps to its own side, all the way round either way.
    #[test]
    fn a_pair_goes_round_a_corner_inside_or_out() {
        for turn in [-1, 1] {
            let mut f = Field::new();
            let first: Vec<(i32, i32)> = (3..=9).rev().map(|x| (x, -8)).chain((1..7).map(|k| (3, -8 + turn * k))).collect();
            f.drag(Tool::OneWay, &first);
            let back: Vec<(i32, i32)> = first.iter().rev().copied().collect();
            f.drag(Tool::OneWay, &back);
            for &(x, y) in &first[1..first.len() - 1] {
                assert_eq!(f.world.nodes_on(GridCoord { x, y }).len(), 2, "({x}, {y}) not a pair, turning {turn}");
            }
            assert!(f.world.clashing().is_empty(), "roads run into each other, turning {turn}");
        }
    }

    /// A street split into a divided road: a one-way out of its end and
    /// one back in beside it along the same tiles, drawn either first, both
    /// joined to the street's end.
    #[test]
    fn a_street_splits_into_a_pair() {
        for out_first in [true, false] {
            let mut f = Field::new();
            f.drag(Tool::Street, &[(2, -5), (3, -5), (4, -5), (5, -5), (6, -5)]);
            let out: Vec<(i32, i32)> = (6..=12).map(|x| (x, -5)).collect();
            let back: Vec<(i32, i32)> = out.iter().rev().copied().collect();
            for path in if out_first { [&out, &back] } else { [&back, &out] } {
                f.drag(Tool::OneWay, path);
            }
            let end = f.node(6, -5);
            let mut arms = f.world.arms_of(end, false);
            arms.sort_unstable();
            arms.dedup();
            assert_eq!(arms.len(), 3, "the street's end joins both, out first: {out_first}");
            for x in 7..=11 {
                assert_eq!(f.world.nodes_on(GridCoord { x, y: -5 }).len(), 2, "({x}, -5) not a pair, out first: {out_first}");
            }
            assert!(f.world.clashing().is_empty(), "roads run into each other, out first: {out_first}");
        }
    }
}
