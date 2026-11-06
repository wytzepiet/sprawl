//! Where a car turning between the street and its place will still be:
//! the way it has left to drive, body by body, and how far along its own
//! way another car can come before it would touch it.
//!
//! A car on the street waits for one parking or pulling out by what it
//! will actually drive, not by the nodes it holds: it comes up as close
//! as it can without touching that way, and drives on past a turn that
//! never crosses its lane.

use model::{CarRole, EntityId, GameObject, GameTime, Trip};
use map::bezier::{offset_positions, LANE_OFFSET};

use crate::Traffic;
use crate::car::nose;

/// How far apart the points of a way are looked at.
const STEP: f64 = 0.05;
/// How far ahead a car looks for one turning across it.
pub const REACH: f64 = 3.0;
/// The room kept between two bodies, beside each other or end on.
const ROOM: f64 = 0.04;

/// Half a body's width.
fn half_width(role: CarRole) -> f64 {
    match role {
        CarRole::Private => 0.075,
        _ => 0.085,
    }
}

/// A trip's way from `from` to `to` along it: its middle, every `STEP`
/// or so, with how far along each point is. Street nodes on their lane,
/// lot nodes where they are, each parking move its curve.
fn track(trip: &Trip, from: f64, to: f64) -> Vec<(f64, [f64; 2])> {
    let n = trip.route_positions.len();
    if n < 2 || trip.along.len() != n {
        return Vec::new();
    }
    let lane = offset_positions(&trip.route_positions, LANE_OFFSET);
    let at = |k: usize| if k < trip.from_lot || k >= n - trip.to_lot { trip.route_positions[k] } else { lane[k] };
    let mut out = Vec::new();
    for k in 1..n {
        let (a, b) = (trip.along[k - 1], trip.along[k]);
        if b < from || a > to || b <= a {
            continue;
        }
        let points = trip.manoeuvres.iter().find(|m| m.edge == k - 1).map_or_else(|| vec![at(k - 1), at(k)], |m| m.points());
        let lengths: Vec<f64> = points.windows(2).map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1])).collect();
        let whole: f64 = lengths.iter().sum::<f64>().max(1e-9);
        let mut s = 0.0;
        for (w, l) in points.windows(2).zip(&lengths) {
            let steps = (l / STEP).ceil().max(1.0) as usize;
            for i in 0..steps {
                let t = i as f64 / steps as f64;
                let d = a + (b - a) * (s + l * t) / whole;
                if d >= from && d <= to {
                    out.push((d, [w[0][0] + (w[1][0] - w[0][0]) * t, w[0][1] + (w[1][1] - w[0][1]) * t]));
                }
            }
            s += l;
        }
    }
    out
}

/// A body: its middle, the way it points, half its length and width.
struct Body {
    at: [f64; 2],
    dir: [f64; 2],
    half_l: f64,
    half_w: f64,
}

impl Body {
    /// How far a point is outside it; none inside.
    fn gap(&self, p: [f64; 2]) -> f64 {
        let (dx, dy) = (p[0] - self.at[0], p[1] - self.at[1]);
        let along = (dx * self.dir[0] + dy * self.dir[1]).abs() - self.half_l;
        let across = (-dx * self.dir[1] + dy * self.dir[0]).abs() - self.half_w;
        along.max(0.0).hypot(across.max(0.0))
    }
}

/// The bodies of a car turning between the street and its place, over
/// what it has left of the turn: from where it is to where it is in its
/// lane, pulling out, or to where it stands, turning in.
fn swept(trip: &Trip, role: CarRole, now: GameTime) -> Vec<Body> {
    let (here, _) = trip.at(now);
    let n = trip.route.len();
    let end = if trip.to_lot > 0 && trip.route_index > n - 1 - trip.to_lot {
        trip.total_route_length
    } else {
        let backed_out = trip.backing.first().is_some_and(|b| b[0] == 0);
        trip.along.get(trip.from_lot + 1 + backed_out as usize).copied().unwrap_or(trip.total_route_length)
    };
    let t = track(trip, here, end);
    (0..t.len())
        .map(|i| {
            let (a, b) = (t[i.saturating_sub(1)].1, t[(i + 1).min(t.len() - 1)].1);
            let l = (b[0] - a[0]).hypot(b[1] - a[1]).max(1e-9);
            Body { at: t[i].1, dir: [(b[0] - a[0]) / l, (b[1] - a[1]) / l], half_l: nose(role), half_w: half_width(role) }
        })
        .collect()
}

/// How far a car can drive on along its trip before its nose would touch
/// what the turning car `other` has left to drive; none if its way ahead,
/// as far as it looks, never comes near it.
pub fn short_of(world: &Traffic, trip: &Trip, role: CarRole, progress: f64, other: EntityId, now: GameTime) -> Option<f64> {
    let Some(GameObject::Car(c)) = world.map.objects.get(other).map(|e| &e.object) else { return None };
    let theirs = swept(c.trip.as_ref()?, c.role, now);
    let reach = half_width(role) + ROOM;
    let first = track(trip, progress, progress + REACH).into_iter().find(|&(_, p)| theirs.iter().any(|b| b.gap(p) < reach))?;
    Some((first.0 - progress - nose(role) - ROOM).max(0.0))
}
