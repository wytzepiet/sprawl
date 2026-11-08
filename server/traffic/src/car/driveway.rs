//! A driveway: where a car turns between the street and the place it
//! stands, a junction like any other (`IntersectionManager`), known by
//! the street node its way joins or leaves the street at (`Map::driveways`).
//!
//! Each car says its way through it, as it drives it: one turning in, from
//! the street node it turns off after to where it stands; one pulling out,
//! from where it stands to the street node it joins the street at; one
//! driving by, along its lane from the node before to the node after.
//! Who goes first is the junction's rule: the street has priority,
//! so one pulling out waits for a gap (and, waited long enough, takes its
//! turn as anyone does, `EXIT_PATIENCE`), one turning in goes in the order
//! it comes, and anyone held up stops just short of where its way first
//! meets the way of the one it waits for.

use map::bezier::{offset_positions, LANE_OFFSET};
use map::track::{Track, TRACK_POINTS};
use model::{EntityId, GameTime, Trip};

use crate::Traffic;

/// Driveways' ids: apart from every entity's and every crossing's.
pub const DRIVEWAYS: EntityId = 1 << 63;

/// How long one pulling out waits for a gap in the street before it takes
/// its turn as anyone does: the street gives way to it then.
pub const EXIT_PATIENCE: GameTime = 12_000;

/// A way through a driveway: its id, the track (from the street node
/// beside it), how far before route node `k` the track begins, how far
/// past it it ends, and whether the car turns there.
pub struct Way {
    pub id: EntityId,
    pub track: Track,
    pub start: f64,
    pub past: f64,
    pub turns: bool,
}

/// Where each node of a trip is driven: a street node on its lane, a lot
/// node where it is.
fn lane(trip: &Trip) -> Vec<[f64; 2]> {
    let n = trip.route_positions.len();
    let lane = offset_positions(&trip.route_positions, LANE_OFFSET);
    (0..n).map(|k| if k < trip.from_lot || k >= n - trip.to_lot { trip.route_positions[k] } else { lane[k] }).collect()
}

/// The trip's way from node `a` to node `b`: each edge a straight between
/// its nodes, or a parking move's curve.
fn way(trip: &Trip, at: &[[f64; 2]], a: usize, b: usize) -> Vec<[f64; 2]> {
    let mut out = vec![at[a]];
    for k in a + 1..=b {
        match trip.manoeuvres.iter().find(|m| m.edge == k - 1) {
            Some(m) => out.extend(m.points().into_iter().skip(1)),
            None => out.push(at[k]),
        }
    }
    out
}

/// A way as a track: `TRACK_POINTS` evenly along it, from `o`.
fn track(points: &[[f64; 2]], o: [f64; 2]) -> Track {
    let mut along = vec![0.0];
    for w in points.windows(2) {
        along.push(along.last().unwrap() + (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]));
    }
    let whole = *along.last().unwrap();
    std::array::from_fn(|i| {
        let s = whole * i as f64 / (TRACK_POINTS - 1) as f64;
        let j = along.partition_point(|&d| d < s).clamp(1, points.len().max(2) - 1).min(points.len() - 1);
        let (p, q) = (points[j - 1], points[j]);
        let t = if along[j] > along[j - 1] { ((s - along[j - 1]) / (along[j] - along[j - 1])).clamp(0.0, 1.0) } else { 1.0 };
        [(p[0] + (q[0] - p[0]) * t - o[0]) as f32, (p[1] + (q[1] - p[1]) * t - o[1]) as f32]
    })
}

/// The driveway a trip comes to at route node `k`, if it does: turning
/// out of its place (at the first node after the one it stood at),
/// turning in (at the first lot node of its way in), or driving by one.
pub fn at(world: &Traffic, trip: &Trip, k: usize) -> Option<Way> {
    let n = trip.route.len();
    if k == 0 || k >= n || trip.route_positions.len() != n || trip.along.len() != n {
        return None;
    }
    let seg = |k: usize| trip.along[k] - trip.along[k - 1];
    let pos = |id: EntityId| world.map.node_pos(id);
    let street = |k: usize| k >= trip.from_lot && k < n - trip.to_lot;
    // Where it joins the street, and where it leaves it.
    let (out, into) = (trip.from_lot, n - 1 - trip.to_lot);
    // At a junction, the junction says who goes: the place is one more
    // of its arms.
    let junction = |k: usize| world.map.is_intersection(trip.route[k]);
    // Out and back in at one street node, next door: one way through it.
    let next_door = trip.from_lot > 0 && trip.to_lot > 0 && out == into;
    if trip.from_lot > 0 && k == 1 && !junction(out) {
        let (here, at) = (trip.route[out], lane(trip));
        let end = if next_door { n - 1 } else { out };
        return Some(Way { id: DRIVEWAYS | here, track: track(&way(trip, &at, 0, end), pos(here)?), start: seg(1), past: trip.along[end] - trip.along[1], turns: true });
    }
    if trip.to_lot > 0 && k == into + 1 && !next_door && !junction(into) {
        let (here, at) = (trip.route[into], lane(trip));
        return Some(Way { id: DRIVEWAYS | here, track: track(&way(trip, &at, into, n - 1), pos(here)?), start: seg(k), past: trip.along[n - 1] - trip.along[k], turns: true });
    }
    let here = trip.route[k];
    if k + 1 < n && street(k - 1) && street(k + 1) && world.map.driveways.contains_key(&here) && !junction(k) {
        // Its lane's way past as through a junction, from seam to seam
        // (`map::track::track`), where the street's two lanes never meet,
        // round a bend as well; and on along its lane to the node either
        // side, but into no junction there: one backing out of a bay by
        // the kerb sweeps along the street as much as across it.
        let p = &trip.route_positions;
        let o = p[k];
        let mid = map::track::track(p[k - 1], o, p[k + 1], LANE_OFFSET, LANE_OFFSET).map(|q| [q[0] as f64 + o[0], q[1] as f64 + o[1]]);
        let reach = |j: usize| if junction(j) { 0.5 } else { 1.0 };
        let end = |j: usize| offset_positions(&[o, p[j]], if j > k { LANE_OFFSET } else { -LANE_OFFSET })[1];
        let mut way = Vec::new();
        if reach(k - 1) > 0.5 {
            way.push(end(k - 1));
        }
        way.extend(mid);
        if reach(k + 1) > 0.5 {
            way.push(end(k + 1));
        }
        return Some(Way { id: DRIVEWAYS | here, track: track(&way, pos(here)?), start: seg(k) * reach(k - 1), past: seg(k + 1) * reach(k + 1), turns: false });
    }
    None
}

/// A way through a junction a place opens onto (`at` leaves those to the
/// junction): its track (`mid`, from the node `o`) run on back to where the
/// car stands, or on to where it will, since it sweeps the street as it
/// turns; and how far before route node `k` it begins and past it ends.
pub fn through_lot(trip: &Trip, k: usize, mid: &Track, o: [f64; 2], start: f64, past: f64) -> (Track, f64, f64) {
    let n = trip.route.len();
    let (out, into) = (k == trip.from_lot && k > 0, trip.to_lot > 0 && k + 1 == n - trip.to_lot);
    if (!out && !into) || trip.route_positions.len() != n || trip.along.len() != n {
        return (*mid, start, past);
    }
    let at = lane(trip);
    let mut points = if out { way(trip, &at, 0, k - 1) } else { Vec::new() };
    points.extend(mid.iter().map(|q| [q[0] as f64 + o[0], q[1] as f64 + o[1]]));
    if into {
        points.extend(way(trip, &at, k + 1, n - 1));
    }
    let start = if out { trip.along[k] } else { start };
    let past = if into { trip.along[n - 1] - trip.along[k] } else { past };
    (track(&points, o), start, past)
}

/// How far along a track its point `i` is.
pub fn along(track: &Track, i: usize) -> f64 {
    track.windows(2).take(i).map(|w| ((w[1][0] - w[0][0]) as f64).hypot((w[1][1] - w[0][1]) as f64)).sum()
}
