//! The moves for each kind of place, as a driver makes them.
//!
//! A shape is a few pieces in one gear: straights and turns, each turn a
//! change of heading at a radius, the wheel wound on and off at a hand's
//! pace either side (`HAND`). A shape's turns are fixed; one or two of its
//! straights are left free and worked out, so it ends exactly where it
//! must. Where a shape has a choice to make, how far to swing out, how
//! tight to turn, it tries the gentlest first, as a driver with room does.

use crate::{Move, Pose, Rect, Rig, drive, wrap};

/// How fast a driver winds the wheel as the vehicle creeps: curvature a
/// tile, so full lock in about a tenth of a tile, a metre and a half.
pub const HAND: f64 = 30.0;
/// The radii a car's rear axle turns on, the easiest first: a driver uses
/// full lock (0.3) only where the room asks for it.
pub const RADII: [f64; 3] = [0.42, 0.36, 0.3];
/// How far a car swings out away from the way it is turning before it
/// turns in, at most, in steps: none first.
const SWINGS: usize = 10;
const SWING: f64 = 5.0 * std::f64::consts::PI / 180.0;
/// How far a car comes in straight at the end, settling into its place, or
/// backs straight out of it before it turns: clear of its neighbours.
pub const SETTLE: f64 = 0.06;

/// A lane: a point on it and the way it runs.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Line {
    pub x: f64,
    pub y: f64,
    pub heading: f64,
}

impl Line {
    pub fn at(&self, d: f64) -> Pose {
        Pose::new(self.x + self.heading.cos() * d, self.y + self.heading.sin() * d, self.heading)
    }

    /// How far a point is to the left of it.
    pub fn left(&self, x: f64, y: f64) -> f64 {
        -(x - self.x) * self.heading.sin() + (y - self.y) * self.heading.cos()
    }

    fn left_of(&self, p: Pose) -> f64 {
        self.left(p.x, p.y)
    }

    /// How far along it a point is.
    pub fn along(&self, x: f64, y: f64) -> f64 {
        (x - self.x) * self.heading.cos() + (y - self.y) * self.heading.sin()
    }
}

/// One gear's part of a way: where it starts, whether it backs, and the
/// moves.
#[derive(Clone, Debug, PartialEq)]
pub struct Leg {
    pub from: Pose,
    pub back: bool,
    pub moves: Vec<Move>,
}

impl Leg {
    pub fn poses(&self) -> Vec<(f64, Pose)> {
        drive(self.from, &self.moves)
    }

    pub fn end(&self) -> Pose {
        self.poses().last().unwrap().1
    }

    pub fn length(&self) -> f64 {
        self.moves.iter().map(|m| m.length).sum()
    }
}

/// A piece of a shape: a straight so long, a straight left free, or a
/// turn through so much heading (positive left) at so much radius.
#[derive(Clone, Copy, Debug)]
enum Piece {
    Straight(f64),
    Free,
    Turn(f64, f64),
    /// A turn begun standing, the wheel wound before it moves.
    Wound(f64, f64),
}

/// A turn as moves: wheel wound on, held, wound off. Backing, a left turn
/// of the heading is the wheel to the right.
fn turn(dh: f64, radius: f64, back: bool, standing: bool) -> Vec<Move> {
    if dh.abs() < 1e-9 {
        return Vec::new();
    }
    let sign = dh.signum() * if back { -1.0 } else { 1.0 };
    let k = 1.0 / radius;
    let ramp = k / HAND;
    if standing {
        let hold = (dh.abs() * radius - ramp / 2.0).max(0.0);
        return vec![Move { back, from: sign * k, to: sign * k, length: hold }, Move { back, from: sign * k, to: 0.0, length: ramp }];
    }
    let hold = dh.abs() * radius - ramp;
    if hold < 0.0 {
        // Too little to reach the radius: wound on and straight off again.
        let peak = (dh.abs() * HAND).sqrt();
        let r = peak / HAND;
        return vec![Move { back, from: 0.0, to: sign * peak, length: r }, Move { back, from: sign * peak, to: 0.0, length: r }];
    }
    vec![
        Move { back, from: 0.0, to: sign * k, length: ramp },
        Move { back, from: sign * k, to: sign * k, length: hold },
        Move { back, from: sign * k, to: 0.0, length: ramp },
    ]
}

/// A shape's moves, its free straights so long.
fn moves(pieces: &[Piece], free: &[f64], back: bool) -> Vec<Move> {
    let mut free = free.iter();
    let mut out = Vec::new();
    for p in pieces {
        match *p {
            Piece::Straight(l) => out.push(Move { back, from: 0.0, to: 0.0, length: l }),
            Piece::Free => out.push(Move { back, from: 0.0, to: 0.0, length: *free.next().unwrap() }),
            Piece::Turn(dh, r) => out.extend(turn(dh, r, back, false)),
            Piece::Wound(dh, r) => out.extend(turn(dh, r, back, true)),
        }
    }
    out.retain(|m| m.length > 1e-9);
    out
}

/// Where a shape ends, its free straights so long.
fn end(from: Pose, pieces: &[Piece], free: &[f64], back: bool) -> Pose {
    drive(from, &moves(pieces, free, back)).last().unwrap().1
}

/// The way each free straight runs, by the heading it is driven at.
fn free_ways(from: Pose, pieces: &[Piece], back: bool) -> Vec<(f64, f64)> {
    let mut h = from.heading;
    let mut out = Vec::new();
    for p in pieces {
        match *p {
            Piece::Turn(dh, _) | Piece::Wound(dh, _) => h += dh,
            Piece::Free => out.push(if back { (-h.cos(), -h.sin()) } else { (h.cos(), h.sin()) }),
            Piece::Straight(_) => {}
        }
    }
    out
}

/// A shape's two free straights, so it ends at (x, y). Straights add
/// along their ways, so this is two equations in two lengths.
fn fit_point(from: Pose, pieces: &[Piece], back: bool, (x, y): (f64, f64)) -> Option<[f64; 2]> {
    let e = end(from, pieces, &[0.0, 0.0], back);
    let w = free_ways(from, pieces, back);
    let [(ax, ay), (bx, by)] = [w[0], w[1]];
    let det = ax * by - ay * bx;
    if det.abs() < 1e-6 {
        return None;
    }
    let (dx, dy) = (x - e.x, y - e.y);
    Some([(dx * by - dy * bx) / det, (ax * dy - ay * dx) / det])
}

/// A shape's one free straight, so it ends on a line.
fn fit_line(from: Pose, pieces: &[Piece], back: bool, line: Line) -> Option<f64> {
    let e = end(from, pieces, &[0.0], back);
    let (wx, wy) = free_ways(from, pieces, back)[0];
    let across = -wx * line.heading.sin() + wy * line.heading.cos();
    let off = line.left(e.x, e.y);
    // Running along it already: on it, or never.
    if across.abs() < 1e-6 {
        return (off.abs() < 1e-6).then_some(0.0);
    }
    Some(-off / across)
}

/// Whether a way is clear of everything round it: the place's
/// neighbours, walls, the kerb.
pub type Clear<'a> = &'a dyn Fn(&[Leg]) -> bool;

/// Into a place nose first from a lane: along it, swung out away from the
/// turn as far as needs be, round, and straight in. A place across the
/// road is turned into without a swing; one on the near side, close by, is
/// swung out for, as a driver swings out to the middle of the road. The
/// way starts on the lane, wherever along it the shape asks.
pub fn nose_in(lane: Line, spot: Pose, clear: Clear) -> Option<Leg> {
    let turn = wrap(spot.heading - lane.heading);
    let out = -turn.signum();
    let from = lane.at(0.0);
    for i in 0..SWINGS {
        let swing = out * SWING * i as f64;
        for r in RADII {
            let pieces = [Piece::Free, Piece::Turn(swing, r), Piece::Turn(turn - swing, r), Piece::Free];
            let Some([a, b]) = fit_point(from, &pieces, false, (spot.x, spot.y)) else { continue };
            let leg = Leg { from: lane.at(a), back: false, moves: moves(&pieces[1..], &[b], false) };
            if b >= SETTLE && clear(std::slice::from_ref(&leg)) {
                return Some(leg);
            }
        }
    }
    None
}

/// Out of a place nose first in, backwards: straight out until the nose
/// clears what stands either side, round onto the lane's heading, and,
/// where that lands it past the lane, pulled forward over into it. Landing
/// on the lane in one go is best; then the shortest straight back.
pub fn back_out(spot: Pose, lane: Line, clear: Clear) -> Vec<Leg> {
    let turn = wrap(lane.heading - spot.heading);
    for r in RADII {
        let pieces = [Piece::Free, Piece::Turn(turn, r)];
        if let Some(c) = fit_line(spot, &pieces, true, lane)
            && c >= SETTLE
        {
            let legs = vec![Leg { from: spot, back: true, moves: moves(&pieces, &[c], true) }];
            if clear(&legs) {
                return legs;
            }
        }
    }
    for i in 0..12 {
        let c = SETTLE + 0.025 * i as f64;
        for r in RADII.iter().rev() {
            let leg = Leg { from: spot, back: true, moves: moves(&[Piece::Straight(c), Piece::Turn(turn, *r)], &[], true) };
            let stood = leg.end();
            for s in DRIFTS {
                let Some(over) = s_curve(stood, lane, false, s, true) else { continue };
                let legs = vec![leg.clone(), Leg { from: stood, back: false, moves: over }];
                if clear(&legs) {
                    return legs;
                }
            }
        }
    }
    Vec::new()
}

/// Into a place tail first, as a driver parks to leave forward: past it
/// along the lane, stopped, the wheel wound standing, and backed round
/// into it, straight the last of the way. Where along the lane it stops,
/// the shape says.
pub fn tail_in(lane: Line, spot: Pose, clear: Clear) -> Option<Leg> {
    let turn = wrap(spot.heading - lane.heading);
    let from = lane.at(0.0);
    for r in RADII.iter().rev() {
        for wound in [true, false] {
            let first = if wound { Piece::Wound(turn, *r) } else { Piece::Turn(turn, *r) };
            let pieces = [Piece::Free, first, Piece::Free];
            let Some([a, b]) = fit_point(from, &pieces, true, (spot.x, spot.y)) else { continue };
            let leg = Leg { from: lane.at(-a), back: true, moves: moves(&pieces[1..], &[b], true) };
            if b >= 0.0 && clear(std::slice::from_ref(&leg)) {
                return Some(leg);
            }
        }
    }
    None
}

/// Out of a place tail first in, forward: straight out until it can turn,
/// round onto the lane's heading, and over into the lane if that lands it
/// beside it.
pub fn nose_out(spot: Pose, lane: Line, clear: Clear) -> Vec<Leg> {
    let turn = wrap(lane.heading - spot.heading);
    for r in RADII {
        let pieces = [Piece::Free, Piece::Turn(turn, r)];
        if let Some(c) = fit_line(spot, &pieces, false, lane)
            && c >= 0.0
        {
            let legs = vec![Leg { from: spot, back: false, moves: moves(&pieces, &[c], false) }];
            if clear(&legs) {
                return legs;
            }
        }
    }
    for i in 0..12 {
        let c = 0.025 * i as f64;
        for r in RADII.iter().rev() {
            let m = moves(&[Piece::Straight(c), Piece::Turn(turn, *r)], &[], false);
            let stood = drive(spot, &m).last().unwrap().1;
            for s in DRIFTS {
                let Some(over) = s_curve(stood, lane, false, s, false) else { continue };
                let legs = vec![Leg { from: spot, back: false, moves: [m.clone(), over].concat() }];
                if clear(&legs) {
                    return legs;
                }
            }
        }
    }
    Vec::new()
}

/// The radii of an S over into a lane, gentlest first: a driver drifts
/// over, never darts.
const DRIFTS: [f64; 3] = [0.9, 0.6, 0.42];

/// The S onto a line: the steepest it gets.
const STEEPEST: f64 = 55.0 * std::f64::consts::PI / 180.0;

/// From where a vehicle stands, pointing along a lane beside it, over onto
/// the lane: an S at radius `r`, as steep as gets it there, a straight
/// between its halves if the steepest is not enough. Forward or backing;
/// `standing`, the wheel wound before it moves.
fn s_curve(from: Pose, lane: Line, back: bool, r: f64, standing: bool) -> Option<Vec<Move>> {
    let off = lane.left(from.x, from.y);
    if off.abs() < 1e-4 {
        return Some(Vec::new());
    }
    // Moving forward, a left turn moves the vehicle left; backing, right.
    let dir = -off.signum() * if back { -1.0 } else { 1.0 };
    let first = |a: f64| if standing { Piece::Wound(dir * a, r) } else { Piece::Turn(dir * a, r) };
    let second = |a: f64| Piece::Turn(-dir * a, r);
    let shape = |a: f64| [first(a), second(a)];
    let left = |a: f64| lane.left_of(end(from, &shape(a), &[], back));
    if left(STEEPEST).signum() == off.signum() {
        let pieces = [first(STEEPEST), Piece::Free, second(STEEPEST)];
        let m = fit_line(from, &pieces, back, lane).filter(|&m| m >= 0.0)?;
        return Some(moves(&pieces, &[m], back));
    }
    let (mut lo, mut hi) = (0.0, STEEPEST);
    for _ in 0..40 {
        let mid = (lo + hi) / 2.0;
        if left(mid).signum() == off.signum() { lo = mid } else { hi = mid }
    }
    Some(moves(&shape(hi), &[], back))
}

/// A street as a place off it sees it: its middle line along x, half its
/// width, and how far each lane is from the middle; the kerb the place is
/// behind is on the right of +x, at -y.
#[derive(Clone, Copy, Debug)]
pub struct Road {
    pub half: f64,
    pub lane: f64,
}

impl Road {
    /// The lane beside the kerb, driven +x; and the far one, driven -x.
    pub fn near(&self) -> Line {
        Line { x: 0.0, y: -self.lane, heading: 0.0 }
    }
    pub fn far(&self) -> Line {
        Line { x: 0.0, y: self.lane, heading: std::f64::consts::PI }
    }
}

/// A place and its ways, from one way along the street: in, where the car
/// then stands (its axle), and out onto each exit it was given, in order,
/// empty where none fits.
#[derive(Clone, Debug)]
pub struct Place {
    pub into: Vec<Leg>,
    pub stands: Pose,
    pub outs: Vec<Vec<Leg>>,
}

/// A place square to the street behind its kerb, for `rig`, its middle at
/// (x, -depth), and its ways from the near lane (+x) and from the far one
/// (-x), each clear of what may stand about it (`parked`), of the far
/// side of the road, and of the kerb (y = -0.5). A dock is in a notch in
/// a building's front, reaching `notch` either side of its middle behind
/// the kerb, and is only backed into, its tail to the loading door. From its own
/// lane a car goes past and backs in, to leave forward either way; from
/// across the road it turns straight in nose first and backs out the way
/// it came, or forward across if it must. A way none of these fit is
/// `None`.
pub fn square(rig: &Rig, x: f64, depth: f64, notch: Option<f64>, parked: &[Rect], road: Road) -> [Option<Place>; 2] {
    let room = notch.unwrap_or(f64::INFINITY);
    let stand = |h: f64| Pose::new(x, -depth, h).ahead(-rig.cab.axle());
    let clear = |legs: &[Leg]| {
        legs.iter().all(|l| {
            l.moves.iter().all(|m| m.from.abs().max(m.to.abs()) <= rig.lock * 1.001)
                && l.poses().iter().all(|(_, p)| crate::bodies(rig, *p).all(|b| parked.iter().all(|c| !b.meets(c)) && b.corners().iter().all(|c| c.1 < road.half + 0.08 && (c.1 > -0.5 || (c.0 - x).abs() <= room))))
        })
    };
    let (near, far) = (road.near(), road.far());
    let way = |lane: Line, tail: bool, exits: [Line; 2]| -> Option<Place> {
        let stands = stand(if tail { std::f64::consts::FRAC_PI_2 } else { -std::f64::consts::FRAC_PI_2 });
        let into = if tail { tail_in(lane, stands, &clear)? } else { nose_in(lane, stands, &clear)? };
        let out = |l: Line| if tail { nose_out(stands, l, &clear) } else { back_out(stands, l, &clear) };
        let outs = vec![out(exits[0]), out(exits[1])];
        (!outs[0].is_empty()).then_some(Place { into: vec![into], stands, outs })
    };
    if notch.is_some() {
        return [way(near, true, [near, far]), way(far, true, [far, near])];
    }
    [
        way(near, true, [near, far]).or_else(|| way(near, false, [near, far])),
        way(far, false, [far, near]).or_else(|| way(far, true, [far, near])),
    ]
}
