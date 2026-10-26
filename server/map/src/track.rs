//! A car's way through a junction or across a crossing, as the road lays it.

/// A car's way through a junction, as it drives it: points along its lane
/// from the seam it comes in by to the one it goes out by, in tiles from
/// the junction (`track`).
pub type Track = [[f32; 2]; TRACK_POINTS];
pub const TRACK_POINTS: usize = 9;

/// A lane's way through a junction at `at`, from the one at `from` to the
/// one at `to` (where each stands, in tiles), as a car keeps to it: from
/// where it crosses the one seam to where it crosses the other, each beside
/// its road's middle by the lane's offset (to the right of the way it is
/// driven), pulled toward where the two lanes' ways meet; straight on, or
/// nearly, straight. The client draws the same (`surface.ts`'s `laneOf`).
pub fn track(from: [f64; 2], at: [f64; 2], to: [f64; 2], lane_in: f64, lane_out: f64) -> Track {
    let unit = |p: [f64; 2]| {
        let (x, y) = (p[0] - at[0], p[1] - at[1]);
        let l = x.hypot(y).max(1e-9);
        [x / l, y / l]
    };
    let seam = |p: [f64; 2]| [(p[0] - at[0]) / 2.0, (p[1] - at[1]) / 2.0];
    let (ua, ub) = (unit(from), unit(to));
    let (ia, ob) = ([-ua[0], -ua[1]], ub);
    let (sa, sb) = (seam(from), seam(to));
    let a = [sa[0] - ia[1] * lane_in, sa[1] + ia[0] * lane_in];
    let b = [sb[0] - ob[1] * lane_out, sb[1] + ob[0] * lane_out];
    let cross = ia[0] * ob[1] - ia[1] * ob[0];
    let s = ((b[0] - a[0]) * ob[1] - (b[1] - a[1]) * ob[0]) / cross;
    let c = if cross.abs() >= 0.2 && s > 0.0 { [a[0] + ia[0] * s, a[1] + ia[1] * s] } else { [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0] };
    std::array::from_fn(|k| {
        let t = k as f64 / (TRACK_POINTS - 1) as f64;
        let (u, v, w) = ((1.0 - t) * (1.0 - t), 2.0 * t * (1.0 - t), t * t);
        [(u * a[0] + v * c[0] + w * b[0]) as f32, (u * a[1] + v * c[1] + w * b[1]) as f32]
    })
}

/// A lane's way straight from `a` to `b` (where each stands, in tiles from
/// where it is seen), beside the road's middle by the lane's offset, to the
/// right of the way it is driven: across a crossing.
pub fn straight(a: [f64; 2], b: [f64; 2], lane: f64) -> Track {
    let (x, y) = (b[0] - a[0], b[1] - a[1]);
    let l = x.hypot(y).max(1e-9);
    let (ox, oy) = (-y / l * lane, x / l * lane);
    std::array::from_fn(|k| {
        let t = k as f64 / (TRACK_POINTS - 1) as f64;
        [(a[0] + x * t + ox) as f32, (a[1] + y * t + oy) as f32]
    })
}
