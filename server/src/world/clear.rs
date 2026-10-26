//! Where a road lies on the map, and whether two keep clear of each other:
//! the one rule of where a road may stand that is about its shape.
//!
//! A node's road is the lane curves through it, as cars drive them and the
//! client draws them (`intersection::track`, `surface.ts`'s `laneOf`): from
//! the seam with each arm, halfway to where that arm's node stands, round
//! through where it stands, to the seam with each other arm; a dead end,
//! from where it stands to its one seam. As wide as it is drawn: a one-way
//! of one lane `LANE` each side of its middle, anything else `ROAD`. As
//! high as its node at its middle, and at a seam, the level a slope climbs
//! from or to.
//!
//! Two roads keep clear where, all along them, they are their widths apart
//! on the map, give or take their kerbs touching, or a level apart in
//! height. Roads joined need not: two
//! links that meet at a node are a junction there, whatever their angle
//! (`World::leads_nowhere` says which angles cars may take). Nor two
//! diagonal links across one corner: there they cross, their cars taking
//! turns (`World::crossing_of`), or pass a level apart.
//!
//! So everything about where roads may stand beside, over and across each
//! other follows from this: two one-ways side by side on a tile, round a
//! bend or parting; a slope over a road, clear only where it is a level
//! up; a ramp beside a road on one tile.

use fixed::HashMap;

use super::decks::{spot, Side, MIDDLE};
use super::World;
use crate::intersection::{track, TRACK_POINTS};
use model::{EntityId, GridCoord};

/// Half a road's width as drawn, in tiles: a one-way's one lane, and
/// anything wider (`surface.ts`'s `THIN`, `HALF_W`).
pub(crate) const LANE: f64 = 0.13;
pub(crate) const ROAD: f64 = 0.22;
/// How far apart in height two roads must be to pass, in half-levels.
const LEVEL: f64 = 2.0;
/// How far two roads' edges may run into each other, in tiles: kerbs
/// may touch where two lanes bend to meet a road, as they do drawn.
const TOUCH: f64 = 0.02;
const EPS: f64 = 1e-6;

/// One end of a link: a tile, a height, a side.
pub(crate) type End = (GridCoord, u8, Side);

/// What a change would do to where roads stand: links laid between ends,
/// any of which may be new, each as wide as its `half` each side; and the
/// nodes moved to another side of their tiles to make room.
#[derive(Default)]
pub(crate) struct Sketch {
    pub links: Vec<([End; 2], f64)>,
    pub moves: Vec<(EntityId, Side)>,
}

/// The ids new nodes go by in a sketch, before they have their own.
const FRESH: EntityId = EntityId::MAX - 16;

/// A short piece of a node's road: from `a` to `b` on the map, at heights
/// `ha` and `hb`, `half` its half-width, part of the link `link`.
#[derive(Clone, Copy)]
struct Piece {
    a: [f64; 2],
    b: [f64; 2],
    ha: f64,
    hb: f64,
    half: f64,
    link: [EntityId; 2],
}

/// The world as a sketch would leave it, as far as where roads lie.
struct Drawn<'a> {
    world: &'a World,
    sketch: &'a Sketch,
    /// Each new node's end, by its id less `FRESH`.
    fresh: Vec<End>,
    /// Each link's two ends, by id.
    links: Vec<([EntityId; 2], f64)>,
}

impl<'a> Drawn<'a> {
    fn new(world: &'a World, sketch: &'a Sketch) -> Drawn<'a> {
        let mut fresh: Vec<End> = Vec::new();
        let mut id = |e: End| {
            world.node_in(e.0, e.1, e.2).unwrap_or_else(|| {
                let k = fresh.iter().position(|&f| f == e).unwrap_or_else(|| (fresh.push(e), fresh.len() - 1).1);
                FRESH + k as EntityId
            })
        };
        let links = sketch.links.iter().map(|&(ends, half)| ([id(ends[0]), id(ends[1])], half)).collect();
        Drawn { world, sketch, fresh, links }
    }

    fn new_end(&self, id: EntityId) -> Option<End> {
        id.checked_sub(FRESH).and_then(|k| self.fresh.get(k as usize)).copied()
    }

    fn tile(&self, id: EntityId) -> Option<GridCoord> {
        match self.new_end(id) {
            Some(e) => Some(e.0),
            None => self.world.objects.get(id)?.position,
        }
    }

    fn height(&self, id: EntityId) -> u8 {
        self.new_end(id).map_or_else(|| self.world.height_of(id), |e| e.1)
    }

    fn pos(&self, id: EntityId) -> Option<[f64; 2]> {
        if let Some(e) = self.new_end(id) {
            return Some(spot(e.0, e.2));
        }
        match self.sketch.moves.iter().find(|m| m.0 == id) {
            Some(&(_, side)) => Some(spot(self.tile(id)?, side)),
            None => self.world.node_pos(id),
        }
    }

    /// A node's arms as they would be, each once.
    fn arms(&self, id: EntityId) -> Vec<EntityId> {
        let mut arms = if self.new_end(id).is_some() { Vec::new() } else { self.world.arms_of(id, false) };
        for (l, _) in &self.links {
            if l[0] == id {
                arms.push(l[1]);
            } else if l[1] == id {
                arms.push(l[0]);
            }
        }
        arms.sort_unstable();
        arms.dedup();
        arms
    }

    /// Half the width of the link between two nodes.
    fn half(&self, a: EntityId, b: EntityId) -> f64 {
        if let Some(&(_, half)) = self.links.iter().find(|(l, _)| *l == [a, b] || *l == [b, a]) {
            return half;
        }
        let world = self.world;
        let lanes = |p, q| world.edges.get(&(p, q)).map(|s| s.lanes);
        match (lanes(a, b), lanes(b, a)) {
            (Some(1), None) | (None, Some(1)) => LANE,
            _ => ROAD,
        }
    }

    /// Where a node's road lies, piece by piece.
    fn pieces(&self, id: EntityId) -> Vec<Piece> {
        let (Some(p), h) = (self.pos(id), self.height(id) as f64) else { return Vec::new() };
        let arms: Vec<(EntityId, [f64; 2], f64, f64)> = self
            .arms(id)
            .into_iter()
            .filter_map(|a| Some((a, self.pos(a)?, seam(self.height(id), self.height(a)), self.half(id, a))))
            .collect();
        let mut out = Vec::new();
        if let [(a, q, s, half)] = arms[..] {
            // A dead end: from where it stands to its seam.
            let m = [(p[0] + q[0]) / 2.0, (p[1] + q[1]) / 2.0];
            let at = |t: f64| [p[0] + (m[0] - p[0]) * t, p[1] + (m[1] - p[1]) * t];
            for k in 0..4 {
                let (t0, t1) = (k as f64 / 4.0, (k + 1) as f64 / 4.0);
                let (h0, h1) = (h + (s - h) * t0, h + (s - h) * t1);
                out.push(Piece { a: at(t0), b: at(t1), ha: h0, hb: h1, half, link: [id, a] });
            }
        }
        for (i, &(ai, qi, si, wi)) in arms.iter().enumerate() {
            for &(aj, qj, sj, wj) in &arms[i + 1..] {
                // Every other point of the curve: four pieces.
                let curve = track(qi, p, qj, 0.0, 0.0);
                let n = (TRACK_POINTS - 1) as f64;
                // Its height: the seam's at either end, the node's halfway.
                let height = |t: f64| if t <= 0.5 { si + (h - si) * t * 2.0 } else { h + (sj - h) * (t * 2.0 - 1.0) };
                for k in (0..TRACK_POINTS - 1).step_by(2) {
                    let (t0, t1) = (k as f64 / n, (k + 2) as f64 / n);
                    let (h0, h1) = (height(t0), height(t1));
                    let (half, link) = if t1 <= 0.5 { (wi, [id, ai]) } else { (wj, [id, aj]) };
                    let pt = |c: [f32; 2]| [p[0] + c[0] as f64, p[1] + c[1] as f64];
                    out.push(Piece { a: pt(curve[k]), b: pt(curve[k + 2]), ha: h0, hb: h1, half, link });
                }
            }
        }
        out
    }

    /// Every node standing within a tile of this one, as it would be.
    fn near(&self, at: GridCoord) -> Vec<EntityId> {
        let mut out: Vec<EntityId> = (-1..=1)
            .flat_map(|dy| (-1..=1).map(move |dx| GridCoord { x: at.x + dx, y: at.y + dy }))
            .flat_map(|t| self.world.nodes_on(t).into_iter().map(|(_, id)| id))
            .collect();
        out.extend((0..self.fresh.len() as EntityId).map(|k| FRESH + k).filter(|&f| self.tile(f).is_some_and(|t| (t.x - at.x).abs() <= 1 && (t.y - at.y).abs() <= 1)));
        out
    }
}

/// How high the seam between two linked nodes is, in half-levels: a
/// slope's end is the level it climbs from or to; two slopes on, the level
/// between them.
fn seam(a: u8, b: u8) -> f64 {
    match (a % 2, b % 2) {
        (0, 1) => a as f64,
        (1, 0) => b as f64,
        _ => (a as f64 + b as f64) / 2.0,
    }
}

/// Do two pieces of road run into each other: nearer on the map than
/// their widths, and, where they come nearest, less than a level apart in
/// height; not where their links meet, nor where two diagonal links cross
/// at a corner.
fn clash(world: &Drawn, p: &Piece, q: &Piece) -> bool {
    if p.link.iter().any(|n| q.link.contains(n)) {
        return false;
    }
    let (d, s, t) = nearest(p.a, p.b, q.a, q.b);
    if d >= p.half + q.half - TOUCH {
        return false;
    }
    let (hp, hq) = (p.ha + (p.hb - p.ha) * s, q.ha + (q.hb - q.ha) * t);
    (hp - hq).abs() < LEVEL - EPS && !across(world, p.link, q.link)
}

/// A node's road, piece by piece, and the box it all lies in, widths and
/// all.
struct Shape {
    pieces: Vec<Piece>,
    lo: [f64; 2],
    hi: [f64; 2],
}

impl Shape {
    fn of(pieces: Vec<Piece>) -> Shape {
        let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
        for p in &pieces {
            for k in 0..2 {
                lo[k] = lo[k].min(p.a[k].min(p.b[k]) - p.half);
                hi[k] = hi[k].max(p.a[k].max(p.b[k]) + p.half);
            }
        }
        Shape { pieces, lo, hi }
    }

    /// Does any piece of one run into any of the other.
    fn clashes(&self, other: &Shape, world: &Drawn) -> bool {
        let apart = (0..2).any(|k| self.lo[k] > other.hi[k] || other.lo[k] > self.hi[k]);
        !apart && self.pieces.iter().any(|p| other.pieces.iter().any(|q| clash(world, p, q)))
    }
}

/// Are two links the two diagonals of one square of four tiles.
fn across(world: &Drawn, a: [EntityId; 2], b: [EntityId; 2]) -> bool {
    let tiles = |l: [EntityId; 2]| Some([world.tile(l[0])?, world.tile(l[1])?]);
    let (Some([a0, a1]), Some([b0, b1])) = (tiles(a), tiles(b)) else { return false };
    let diagonal = |p: GridCoord, q: GridCoord| (p.x - q.x).abs() == 1 && (p.y - q.y).abs() == 1;
    let corner = |p: GridCoord, q: GridCoord| (p.x.max(q.x), p.y.max(q.y));
    diagonal(a0, a1) && diagonal(b0, b1) && corner(a0, a1) == corner(b0, b1) && ![a0, a1].contains(&b0) && ![a0, a1].contains(&b1)
}

/// How near two segments come, and where along each, from 0 at its start
/// to 1 at its end: none if they cross, where they cross.
fn nearest(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> (f64, f64, f64) {
    let side = |p: [f64; 2], q: [f64; 2], r: [f64; 2]| (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    let (abc, abd, cda, cdb) = (side(a, b, c), side(a, b, d), side(c, d, a), side(c, d, b));
    if abc * abd < 0.0 && cda * cdb < 0.0 {
        return (0.0, cda / (cda - cdb), abc / (abc - abd));
    }
    // Else at an end of one or the other: the point nearest it on the other.
    let onto = |p: [f64; 2], a: [f64; 2], b: [f64; 2]| {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l = dx * dx + dy * dy;
        let t = if l == 0.0 { 0.0 } else { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l).clamp(0.0, 1.0) };
        ((p[0] - a[0] - dx * t).hypot(p[1] - a[1] - dy * t), t)
    };
    let tries = [(onto(a, c, d), 0.0, None), (onto(b, c, d), 1.0, None), (onto(c, a, b), 0.0, Some(())), (onto(d, a, b), 1.0, Some(()))];
    let ((dist, t), end, flip) = tries.into_iter().min_by(|x, y| x.0 .0.total_cmp(&y.0 .0)).expect("four");
    if flip.is_some() { (dist, t, end) } else { (dist, end, t) }
}

impl World {
    /// Would every road the sketch changes keep clear of every road near
    /// it: its links' ends, the nodes it moves, and the roads joined to
    /// those, whose seams move with them.
    pub(crate) fn lies_clear(&self, sketch: &Sketch) -> bool {
        let drawn = Drawn::new(self, sketch);
        let mut changed: Vec<EntityId> = drawn.links.iter().flat_map(|(l, _)| *l).collect();
        for &(id, _) in &sketch.moves {
            changed.push(id);
            changed.extend(self.arms_of(id, false));
        }
        changed.sort_unstable();
        changed.dedup();
        let near: Vec<(EntityId, Vec<EntityId>)> = changed.iter().filter_map(|&c| Some((c, drawn.near(drawn.tile(c)?).into_iter().filter(|&o| o != c).collect()))).collect();
        // Nothing else near: nothing to run into.
        if near.iter().all(|(_, os)| os.iter().all(|&o| drawn.new_end(o).is_some())) {
            return true;
        }
        let mut shapes: HashMap<EntityId, Shape> = HashMap::default();
        for (c, os) in near {
            for id in std::iter::once(c).chain(os.iter().copied()) {
                shapes.entry(id).or_insert_with(|| Shape::of(drawn.pieces(id)));
            }
            if os.iter().any(|o| shapes[&c].clashes(&shapes[o], &drawn)) {
                return false;
            }
        }
        true
    }

    /// Every two roads that run into each other as they stand: none, if
    /// every change was judged by `lies_clear`. What the drag tests check
    /// after every drag (`client/src/engine/pen.test.ts`).
    pub fn clashing(&self) -> Vec<[EntityId; 2]> {
        let sketch = Sketch::default();
        let drawn = Drawn::new(self, &sketch);
        let shapes: HashMap<EntityId, Shape> = self.objects.roads().map(|e| (e.id, Shape::of(drawn.pieces(e.id)))).collect();
        let mut out = Vec::new();
        for (&c, mine) in &shapes {
            let Some(at) = drawn.tile(c) else { continue };
            for o in drawn.near(at).into_iter().filter(|&o| o > c) {
                if shapes.get(&o).is_some_and(|theirs| mine.clashes(theirs, &drawn)) {
                    out.push([c, o]);
                }
            }
        }
        out.sort_unstable();
        out
    }

    /// The nodes on a tile that move over to the other side when a road is
    /// laid on this side at this height: those in the middle less than a
    /// level from it, narrow enough to share their tile, a lane beside a
    /// lane, where the other side at their height is free.
    pub(crate) fn moving_over(&self, at: GridCoord, height: u8, side: Side) -> Vec<(EntityId, Side)> {
        if side == MIDDLE {
            return Vec::new();
        }
        let away = [-side[0], -side[1]];
        let sketch = Sketch::default();
        let drawn = Drawn::new(self, &sketch);
        let narrow = |id: EntityId| self.arms_of(id, false).into_iter().all(|a| drawn.half(id, a) == LANE);
        self.nodes_on(at)
            .into_iter()
            .filter(|&(h, id)| self.side_of(id) == MIDDLE && (h as f64 - height as f64).abs() < LEVEL && self.node_in(at, h, away).is_none() && narrow(id))
            .map(|(_, id)| (id, away))
            .collect()
    }
}
