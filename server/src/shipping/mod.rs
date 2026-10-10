//! The sea's decisions, as pure functions over plain data: the water and
//! the ways over it (`water.rs`), the lines and their timetables
//! (`lines.rs`), and how a ship moves along a leg (here). Nothing in this
//! module names `World` or `EventQueue`: the game and the scenario
//! harness (`sim.rs`, `cargo test scenario`) call the same functions, so
//! what the harness measures is what the game does (docs/plan-sea.md).

// Until the game sails by it (stage 2), only the harness calls in.
#![cfg_attr(not(test), allow(dead_code))]

pub mod water;
#[cfg(test)]
pub mod lines;
#[cfg(test)]
mod sim;

use crate::engine::GameTime;
use crate::protocol::DAY_MS;

/// An hour of the clock.
pub const HOUR: GameTime = DAY_MS as GameTime / 24;
/// How long a ship at full speed takes to cross a tile of open water: a
/// fifth of a second, five tiles a second at speed one. The map's sea is
/// compressed (islands thirty-odd tiles apart), and so are its ships: at
/// this pace the median voyage from the home coast to the map's edge,
/// about 420 tiles, is under two hours.
pub const SEA_PACE: GameTime = 200;
/// How long a ship takes to gather way from rest to full speed, and to
/// lose it again coming in: at an even push, so it covers the first fifty
/// tiles out of a harbour at half speed on average, and the town sees it
/// come in slowly.
pub const GATHER: GameTime = 30_000;
/// How long a ship stays beyond the map's edge, at the world, between
/// sailing out and sailing back in: half an hour.
pub const WORLD_STAY: GameTime = HOUR / 2;

/// How far a ship has come from the start of a leg `len` tiles long, `t`
/// ms after it set out. A ship gathers way at an even push from rest at
/// an end that is a berth (`ease`: the start, the end), and comes in the
/// same way, so it stands still at the berth; at the map's edge it is at
/// full speed. The game and the client read a ship's pose off this
/// (`sea.ts` `sailing`), so it is all the timing a `Sail` needs.
pub fn covered(len: f64, ease: [bool; 2], t: GameTime) -> f64 {
    let t = t.min(sail_ms(len, ease)) as f64;
    let whole = sail_ms(len, ease) as f64;
    let v = 1.0 / SEA_PACE as f64;
    let r = GATHER as f64;
    // From rest at a berth, `t` ms out.
    let out = |t: f64| if t < r { v * t * t / (2.0 * r) } else { v * (t - r / 2.0) };
    match ease {
        [true, false] => out(t),
        [false, true] => len - out(whole - t),
        [true, true] if t < whole / 2.0 => out(t),
        [true, true] => len - out(whole - t),
        [false, false] => v * t,
    }
}

/// How long a leg `len` tiles long takes, eased at its berths.
pub fn sail_ms(len: f64, ease: [bool; 2]) -> GameTime {
    let v = 1.0 / SEA_PACE as f64;
    let r = GATHER as f64;
    // From rest, the time to cover `x`.
    let out = |x: f64| if x < v * r / 2.0 { (2.0 * r * x / v).sqrt() } else { x / v + r / 2.0 };
    let ms = match ease {
        [true, true] => 2.0 * out(len / 2.0),
        [false, false] => len / v,
        _ => out(len),
    };
    ms.round() as GameTime
}

/// A polyline's length.
pub fn length(path: &[[f64; 2]]) -> f64 {
    path.windows(2).map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1])).sum()
}

/// The point `d` along a polyline, and the way it runs there.
pub fn point_at(path: &[[f64; 2]], d: f64) -> ([f64; 2], f64) {
    let mut left = d.max(0.0);
    let mut way = 0.0;
    for w in path.windows(2) {
        let l = (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]);
        way = (w[1][1] - w[0][1]).atan2(w[1][0] - w[0][0]);
        if left <= l {
            let k = if l > 0.0 { left / l } else { 0.0 };
            return ([w[0][0] + (w[1][0] - w[0][0]) * k, w[0][1] + (w[1][1] - w[0][1]) * k], way);
        }
        left -= l;
    }
    (path.last().copied().unwrap_or([0.0, 0.0]), way)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A leg is covered in its time, from the start to the end, never
    /// going back, and a ship stands still at a berth.
    #[test]
    fn a_ship_covers_its_leg_in_its_time() {
        for len in [3.0, 40.0, 420.0] {
            for ease in [[true, false], [false, true], [true, true], [false, false]] {
                let ms = sail_ms(len, ease);
                assert!(covered(len, ease, 0).abs() < 0.01 && (covered(len, ease, ms) - len).abs() < 0.01, "{len} {ease:?}");
                let mut last = f64::MIN;
                for t in (0..=ms).step_by(250) {
                    let d = covered(len, ease, t);
                    assert!(d >= last - 1e-9, "went back at {t}");
                    last = d;
                }
                if ease[0] {
                    assert!(covered(len, ease, 100) < 0.01, "it left the berth at speed");
                }
                if ease[1] {
                    assert!(len - covered(len, ease, ms - 100) < 0.01, "it hit the berth at speed");
                }
            }
        }
        // The median way to the edge is under two hours.
        assert!(sail_ms(420.0, [true, false]) < 2 * HOUR);
    }

    #[test]
    fn a_point_along_a_polyline() {
        let path = [[0.0, 0.0], [2.0, 0.0], [2.0, 3.0]];
        assert_eq!(point_at(&path, 1.0).0, [1.0, 0.0]);
        assert_eq!(point_at(&path, 4.0).0, [2.0, 2.0]);
        assert_eq!(point_at(&path, 9.0).0, [2.0, 3.0]);
    }
}
