//! How a vehicle gets between the road and where it stands: the moves a
//! driver makes, drawn by hand, one shape for each kind of place.
//!
//! A real driver parks with a handful of moves and makes them the same way
//! every time: swing out, full lock in, straighten; back out round, pull
//! away; pull past a dock, swing away from it and back the trailer in. So
//! does this. Each kind of place has its shape (`ways`): a few arcs and
//! straights in one gear, the wheel turned at a hand's pace between them.
//! The shape is fixed; only how long its straights run is worked out, so the
//! vehicle ends exactly where it stands. Nothing is searched, and nothing
//! is smoothed after: what is planned is what is driven, here and in the
//! client, and every place's moves can be drawn and looked at (`sheet`).
//!
//! A car is steered by its rear axle. A lorry backing is steered by its
//! trailer's, as a driver backing a trailer thinks: the trailer goes where
//! it is put and the cab follows its nose (`tow`).
//!
//! No randomness and no hashing, so the same place gives the same moves on
//! every machine.

pub mod ways;
#[cfg(test)]
mod sheet;

use std::f64::consts::PI;

/// Where a vehicle stands: its cab's rear axle, the way the cab points, and
/// the way its trailer points, if it has one (the cab's heading if not).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    pub x: f64,
    pub y: f64,
    pub heading: f64,
    pub trailer: f64,
}

impl Pose {
    pub fn new(x: f64, y: f64, heading: f64) -> Pose {
        Pose { x, y, heading, trailer: heading }
    }

    /// Moved `d` along its heading.
    pub fn ahead(self, d: f64) -> Pose {
        Pose { x: self.x + self.heading.cos() * d, y: self.y + self.heading.sin() * d, ..self }
    }
}

/// A body round its axle: how far it reaches ahead of it and behind, and
/// half its width.
#[derive(Clone, Copy, Debug)]
pub struct Body {
    pub ahead: f64,
    pub behind: f64,
    pub half: f64,
}

impl Body {
    /// How far its axle is behind its middle.
    pub fn axle(&self) -> f64 {
        (self.ahead - self.behind) / 2.0
    }
}

/// A trailer hitched on its cab's rear axle: how far behind the hitch its
/// axle is, its body round that axle, and the most it may fold against
/// the cab.
#[derive(Clone, Copy, Debug)]
pub struct Trailer {
    pub length: f64,
    pub body: Body,
    pub fold: f64,
}

/// A vehicle as it steers: the tightest its rear axle turns, as a
/// curvature, its cab, and its trailer.
#[derive(Clone, Copy, Debug)]
pub struct Rig {
    pub lock: f64,
    pub cab: Body,
    pub trailer: Option<Trailer>,
}

/// A car, 0.29 tiles long and 0.15 wide, its rear axle a third of its
/// length behind its middle; turning no tighter than 0.3 tiles.
pub const CAR: Rig = Rig { lock: 1.0 / 0.3, cab: Body { ahead: 0.145 + 0.29 / 3.0, behind: 0.145 - 0.29 / 3.0, half: 0.075 }, trailer: None };

/// A cab-over tractor, 0.17 long, and a semi-trailer 0.46 long hitched on
/// its rear axle: the trailer's axle 0.37 behind the hitch, its nose 0.025
/// ahead of the hitch and its tail 0.065 behind the axle (the client's
/// `CAB` and `TRAILER`). It folds no further than 75 degrees.
pub const LORRY: Rig = Rig {
    lock: 1.0 / 0.3,
    cab: Body { ahead: 0.085 + 0.17 / 3.0, behind: 0.085 - 0.17 / 3.0, half: 0.085 },
    trailer: Some(Trailer { length: 0.37, body: Body { ahead: 0.395, behind: 0.065, half: 0.085 }, fold: 1.3 }),
};

/// A rectangle, turned: its middle, half its length and half its width,
/// and the way its length runs.
#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub half_l: f64,
    pub half_w: f64,
    pub heading: f64,
}

impl Rect {
    /// From one corner to the other, square to the grid.
    pub fn span(x0: f64, y0: f64, x1: f64, y1: f64) -> Rect {
        Rect { x: (x0 + x1) / 2.0, y: (y0 + y1) / 2.0, half_l: (x1 - x0).abs() / 2.0, half_w: (y1 - y0).abs() / 2.0, heading: 0.0 }
    }

    pub fn holds(&self, (px, py): (f64, f64)) -> bool {
        let (c, s) = (self.heading.cos(), self.heading.sin());
        let (dx, dy) = (px - self.x, py - self.y);
        (dx * c + dy * s).abs() <= self.half_l + 1e-9 && (-dx * s + dy * c).abs() <= self.half_w + 1e-9
    }

    pub fn corners(&self) -> [(f64, f64); 4] {
        let (c, s) = (self.heading.cos(), self.heading.sin());
        let p = |l: f64, w: f64| (self.x + c * l - s * w, self.y + s * l + c * w);
        [p(self.half_l, self.half_w), p(-self.half_l, self.half_w), p(-self.half_l, -self.half_w), p(self.half_l, -self.half_w)]
    }

    /// Do the two overlap? Separating axes: each one's two.
    pub fn meets(&self, o: &Rect) -> bool {
        let gap = |a: &Rect, b: &Rect| {
            let (c, s) = (a.heading.cos(), a.heading.sin());
            [(c, s, a.half_l), (-s, c, a.half_w)].into_iter().any(|(ux, uy, half)| {
                let mid = (b.x - a.x) * ux + (b.y - a.y) * uy;
                let reach = b.corners().iter().map(|&(x, y)| (x - b.x) * ux + (y - b.y) * uy).fold(0.0f64, |m, v| m.max(v.abs()));
                mid.abs() > half + reach
            })
        };
        !gap(self, o) && !gap(o, self)
    }
}

/// One gear's drive: backwards or not, the wheel turning evenly from one
/// curvature to another (positive to the left), so far.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Move {
    pub back: bool,
    pub from: f64,
    pub to: f64,
    pub length: f64,
}

pub(crate) fn wrap(a: f64) -> f64 {
    (a + PI).rem_euclid(2.0 * PI) - PI
}

/// How far a step of a drive is.
pub const SUB: f64 = 0.02;

/// A point driven `ds` along heading `h` (negative backing) with the wheel
/// at curvature `k`: where it ends, and its heading.
fn arc(x: f64, y: f64, h: f64, k: f64, ds: f64) -> (f64, f64, f64) {
    let e = h + k * ds;
    if k.abs() < 1e-9 { (x + h.cos() * ds, y + h.sin() * ds, e) } else { (x + (e.sin() - h.sin()) / k, y - (e.cos() - h.cos()) / k, e) }
}

/// Each step of some moves: its curvature and signed length.
fn steps(moves: &[Move]) -> impl Iterator<Item = (f64, f64)> + '_ {
    moves.iter().flat_map(|m| {
        let n = (m.length / SUB - 1e-6).ceil().max(1.0) as usize;
        let ds = m.length / n as f64;
        (0..n).map(move |i| (m.from + (m.to - m.from) * (i as f64 + 0.5) / n as f64, if m.back { -ds } else { ds }))
    })
}

/// Moves driven from `from` by the cab's rear axle, every fiftieth of a
/// tile or so, the trailer drawn after its hitch: each pose, with how far
/// it has gone.
pub fn drive(rig: &Rig, from: Pose, moves: &[Move]) -> Vec<(f64, Pose)> {
    let mut out = vec![(0.0, from)];
    let (mut p, mut s) = (from, 0.0);
    for (k, ds) in steps(moves) {
        let (x, y, h) = arc(p.x, p.y, p.heading, k, ds);
        let trailer = match rig.trailer {
            // The trailer's axle follows the hitch: it turns toward the cab
            // by as much as the hitch moves across it.
            Some(t) => p.trailer + ds / t.length * wrap((p.heading + h) / 2.0 - p.trailer).sin(),
            None => h,
        };
        p = Pose { x, y, heading: h, trailer };
        s += ds.abs();
        out.push((s, p));
    }
    out
}

/// Moves driven from `from` by its trailer's axle, the way a lorry is
/// backed: the trailer goes where the moves take it, and the cab's rear
/// axle, on the hitch, points the way the hitch is moving. A cab standing
/// at an angle to its trailer turns it as it starts, so the first move's
/// curvature is that angle's (`ways::towing`).
pub fn tow(rig: &Rig, from: Pose, moves: &[Move]) -> Vec<(f64, Pose)> {
    let Some(t) = rig.trailer else { return drive(rig, from, moves) };
    let mut out = vec![(0.0, from)];
    let (mut tx, mut ty, mut th) = (from.x - from.trailer.cos() * t.length, from.y - from.trailer.sin() * t.length, from.trailer);
    let (mut p, mut s) = (from, 0.0);
    for (k, ds) in steps(moves) {
        (tx, ty, th) = arc(tx, ty, th, k, ds);
        let (hx, hy) = (tx + th.cos() * t.length, ty + th.sin() * t.length);
        let (mx, my) = (hx - p.x, hy - p.y);
        let heading = if mx.hypot(my) < 1e-12 { p.heading } else if ds < 0.0 { (-my).atan2(-mx) } else { my.atan2(mx) };
        p = Pose { x: hx, y: hy, heading, trailer: th };
        s += ds.abs();
        out.push((s, p));
    }
    out
}

/// The rectangles a vehicle stands in.
pub fn bodies(rig: &Rig, p: Pose) -> impl Iterator<Item = Rect> {
    let rect = |x: f64, y: f64, h: f64, b: &Body| {
        let mid = (b.ahead - b.behind) / 2.0;
        Rect { x: x + h.cos() * mid, y: y + h.sin() * mid, half_l: (b.ahead + b.behind) / 2.0, half_w: b.half, heading: h }
    };
    let cab = rect(p.x, p.y, p.heading, &rig.cab);
    let trailer = rig.trailer.map(|t| rect(p.x - p.trailer.cos() * t.length, p.y - p.trailer.sin() * t.length, p.trailer, &t.body));
    std::iter::once(cab).chain(trailer)
}
