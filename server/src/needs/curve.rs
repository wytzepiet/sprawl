use crate::engine::GameTime;
use crate::protocol::DAY_MS;

const DAY: f64 = DAY_MS as f64;

/// When, and how well, a place serves: availability in [0, 1] over a day,
/// linearly interpolated between keyframes and wrapping at midnight.
///
/// Built once from a fixed definition. Every keyframe carries the integral
/// from midnight to itself, so integrating over any interval is two lookups
/// and a subtraction, and finding where an integral runs out is a scan plus
/// one quadratic.
#[derive(Debug, Clone)]
pub struct Curve {
    /// Sorted by time, first at 0, last strictly before DAY. The segment
    /// after the last key runs to the first key at DAY.
    keys: Vec<Key>,
    /// Integral over one whole day.
    per_day: f64,
}

#[derive(Debug, Clone, Copy)]
struct Key {
    t: f64,
    v: f64,
    /// Integral from midnight to `t`.
    cum: f64,
}

impl Curve {
    /// From `(time_of_day_ms, value)` pairs in any order. A key at midnight
    /// is synthesised if none is given, so every segment lies within a day.
    pub fn new(points: &[(u32, f64)]) -> Curve {
        assert!(!points.is_empty(), "a curve needs at least one keyframe");
        let mut pts: Vec<(f64, f64)> = points
            .iter()
            .map(|&(t, v)| {
                assert!((0.0..=1.0).contains(&v), "availability {v} outside [0, 1]");
                assert!(t < DAY_MS, "keyframe {t} beyond the day");
                (t as f64, v)
            })
            .collect();
        pts.sort_by(|a, b| a.0.total_cmp(&b.0));
        assert!(pts.windows(2).all(|w| w[0].0 < w[1].0), "duplicate keyframe time");

        if pts[0].0 != 0.0 {
            // Midnight falls on the wrap segment: last key -> first key + DAY.
            let (t0, v0) = pts[pts.len() - 1];
            let (t1, v1) = (pts[0].0 + DAY, pts[0].1);
            let v = v0 + (v1 - v0) * (DAY - t0) / (t1 - t0);
            pts.insert(0, (0.0, v));
        }

        let mut keys = Vec::with_capacity(pts.len());
        let mut cum = 0.0;
        for i in 0..pts.len() {
            let (t, v) = pts[i];
            keys.push(Key { t, v, cum });
            let (t1, v1) = if i + 1 < pts.len() { pts[i + 1] } else { (DAY, pts[0].1) };
            cum += (v + v1) / 2.0 * (t1 - t);
        }
        Curve { keys, per_day: cum }
    }

    /// Always open, at full effect.
    pub fn always() -> Curve {
        Curve::new(&[(0, 1.0)])
    }

    /// Fully open on [open, close), closed elsewhere, sharp edges. Wraps
    /// midnight when `close < open`.
    pub fn hours(open: u32, close: u32) -> Curve {
        // Two keys a millisecond apart make the edge; interpolation over one
        // millisecond is as sharp as game time can tell.
        let mut pts = vec![(open, 1.0), (close, 0.0)];
        if open > 0 {
            pts.push((open - 1, 0.0));
        } else {
            pts.push((DAY_MS - 1, 0.0));
        }
        pts.push((close - 1, 1.0));
        Curve::new(&pts)
    }

    /// Integral over one whole day: how many availability-milliseconds it offers.
    pub fn per_day(&self) -> f64 {
        self.per_day
    }

    /// Value at time `t`.
    pub fn at(&self, t: GameTime) -> f64 {
        let (i, tod) = self.locate(t);
        let (a, b) = self.segment(i);
        a.v + (b.v - a.v) * (tod - a.t) / (b.t - a.t)
    }

    /// Integral over `[x, y]`, in availability-milliseconds.
    pub fn integral(&self, x: GameTime, y: GameTime) -> f64 {
        debug_assert!(x <= y);
        let days = (y / DAY_MS as u64 - x / DAY_MS as u64) as f64;
        self.cum(y) - self.cum(x) + days * self.per_day
    }

    /// The least `t >= x` at which `integral(x, t) == q`, or None if a whole
    /// day from `x` does not reach it. Continuous: the caller rounds when it
    /// schedules, and divides before then.
    pub fn advance(&self, x: GameTime, q: f64) -> Option<f64> {
        if q <= 0.0 {
            return Some(x as f64);
        }
        let (mut i, tod) = self.locate(x);
        let day_start = x - (x % DAY_MS as u64);
        let mut remaining = q;
        // Start partway through segment `i`.
        let mut from = tod;
        let mut wrapped = 0.0;
        loop {
            if remaining <= 0.0 {
                // Ran out exactly on a keyframe.
                return Some(day_start as f64 + wrapped + from);
            }
            let (a, b) = self.segment(i);
            let slope = (b.v - a.v) / (b.t - a.t);
            let v0 = a.v + slope * (from - a.t);
            let span = b.t - from;
            let here = (v0 + (v0 + slope * span)) / 2.0 * span;
            if here >= remaining {
                let d = if slope == 0.0 {
                    remaining / v0
                } else {
                    // Smallest positive root of slope/2 d^2 + v0 d - remaining,
                    // in the form that does not cancel when slope is tiny.
                    2.0 * remaining / (v0 + (v0 * v0 + 2.0 * slope * remaining).sqrt())
                };
                return Some(day_start as f64 + wrapped + from + d);
            }
            remaining -= here;
            i += 1;
            if i == self.keys.len() {
                i = 0;
                wrapped += DAY;
                if wrapped > DAY {
                    return None;
                }
            }
            from = self.keys[i].t;
        }
    }

    /// The first `t >= x` from which the curve is zero — closed for a while,
    /// not merely touching zero at the foot of a ramp — capped at a day out:
    /// a curve that never closes closes at the horizon.
    pub fn next_zero(&self, x: GameTime) -> GameTime {
        self.scan(x, |a, b| {
            if a.v == 0.0 && b.v == 0.0 {
                Some(a.t)
            } else if b.v == 0.0 && a.v > 0.0 {
                Some(b.t)
            } else {
                None
            }
        })
        .unwrap_or(x + DAY_MS as u64)
    }

    /// The first `t >= x` from which the curve is positive, or None if it
    /// never opens.
    pub fn next_nonzero(&self, x: GameTime) -> Option<GameTime> {
        self.scan(x, |a, b| if a.v > 0.0 || b.v > 0.0 { Some(a.t) } else { None })
    }

    /// Walk segments from `x` for a day, returning the first hit at or after
    /// `x`. `f` sees each segment as (start, end) keys with times within a
    /// day and answers with a time on it.
    fn scan(&self, x: GameTime, f: impl Fn(&Key, &Key) -> Option<f64>) -> Option<GameTime> {
        let (mut i, tod) = self.locate(x);
        let day_start = x - (x % DAY_MS as u64);
        let mut wrapped = 0.0;
        loop {
            let (a, b) = self.segment(i);
            if let Some(t) = f(&a, &b) {
                let t = t.max(if wrapped == 0.0 { tod } else { 0.0 });
                return Some(day_start + (wrapped + t).round() as GameTime);
            }
            i += 1;
            if i == self.keys.len() {
                i = 0;
                wrapped += DAY;
                if wrapped > DAY {
                    return None;
                }
            }
        }
    }

    /// Integral from the epoch to `t`.
    fn cum(&self, t: GameTime) -> f64 {
        let (i, tod) = self.locate(t);
        let (a, b) = self.segment(i);
        let slope = (b.v - a.v) / (b.t - a.t);
        let span = tod - a.t;
        a.cum + (a.v + slope * span / 2.0) * span
    }

    /// Segment index containing `t`, and `t` within its day.
    fn locate(&self, t: GameTime) -> (usize, f64) {
        let tod = (t % DAY_MS as u64) as f64;
        let i = self.keys.partition_point(|k| k.t <= tod) - 1;
        (i, tod)
    }

    /// Segment `i` as its two endpoints, the last one running to the first
    /// key at DAY.
    fn segment(&self, i: usize) -> (Key, Key) {
        let a = self.keys[i];
        let b = match self.keys.get(i + 1) {
            Some(k) => *k,
            None => Key { t: DAY, v: self.keys[0].v, cum: self.per_day },
        };
        (a, b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: u32 = DAY_MS / 24;
    const D: u64 = DAY_MS as u64;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() <= 1e-6 * DAY.max(a.abs()).max(b.abs())
    }

    /// Brute-force integral, the arithmetic the prefix table must agree with.
    fn riemann(c: &Curve, x: GameTime, y: GameTime) -> f64 {
        let n = ((y - x) / 20).max(1);
        let dt = (y - x) as f64 / n as f64;
        (0..n)
            .map(|k| c.at(x + (k as f64 * dt + dt / 2.0) as u64) * dt)
            .sum()
    }

    /// A deterministic scatter of times, so failures reproduce.
    fn times(n: usize) -> Vec<GameTime> {
        let mut s = 0x2545_F491_4F6C_DD1Du64;
        (0..n)
            .map(|_| {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                s % (3 * D)
            })
            .collect()
    }

    fn ramp() -> Curve {
        Curve::new(&[(6 * H, 0.0), (9 * H, 1.0), (14 * H, 0.4), (23 * H, 0.0)])
    }

    #[test]
    fn always_open_integrates_to_elapsed_time() {
        let c = Curve::always();
        assert!(close(c.integral(5 * D + 3, 7 * D + 100), (2 * D + 97) as f64));
        assert_eq!(c.advance(1000, 5000.0), Some(6000.0));
        assert_eq!(c.next_zero(1000), 1000 + D);
        assert_eq!(c.next_nonzero(1000), Some(1000));
    }

    #[test]
    fn never_open_serves_nothing() {
        let c = Curve::new(&[(0, 0.0)]);
        assert_eq!(c.integral(0, 3 * D), 0.0);
        assert_eq!(c.advance(0, 1.0), None);
        assert_eq!(c.next_zero(5000), 5000);
        assert_eq!(c.next_nonzero(5000), None);
    }

    #[test]
    fn opening_hours_are_a_box() {
        let c = Curve::hours(9 * H, 18 * H);
        assert!(close(c.integral(0, D), (9 * H) as f64), "nine hours a day");
        assert!(close(c.integral(8 * H as u64, 10 * H as u64), H as f64), "one open hour of two");
        assert_eq!(c.next_nonzero(3 * H as u64), Some(9 * H as u64 - 1), "opens at nine");
        assert_eq!(c.next_zero(12 * H as u64), 18 * H as u64, "closes at six");
        assert_eq!(c.next_nonzero(20 * H as u64), Some(D + 9 * H as u64 - 1), "tomorrow");
        // Opening and closing agree: what opens is not also closed.
        let opens = c.next_nonzero(3 * H as u64).unwrap();
        assert_eq!(c.next_zero(opens), 18 * H as u64);
    }

    #[test]
    fn a_night_shift_wraps_midnight() {
        let c = Curve::hours(22 * H, 2 * H);
        assert!(close(c.integral(0, D), (4 * H) as f64));
        assert!(close(c.at(0), 1.0), "open at midnight");
        assert_eq!(c.next_zero(23 * H as u64), D + 2 * H as u64);
        assert_eq!(c.next_nonzero(3 * H as u64), Some(22 * H as u64 - 1));
    }

    #[test]
    fn prefix_integral_agrees_with_brute_force() {
        let c = ramp();
        let ts = times(40);
        for w in ts.windows(2) {
            let (x, y) = (w[0].min(w[1]), w[0].max(w[1]));
            let got = c.integral(x, y);
            let want = riemann(&c, x, y);
            // Loose: the quadrature samples on whole milliseconds.
            assert!((got - want).abs() <= 1e-4 * want.max(1.0), "[{x}, {y}]: {got} vs {want}");
        }
    }

    #[test]
    fn advance_inverts_integral() {
        let c = ramp();
        for &x in &times(40) {
            // Only where the curve is live: where it is flat zero, the
            // least t reaching q is earlier than any t we pick.
            let y = x + 3 * H as u64;
            if c.at(y) == 0.0 || c.integral(x, y) == 0.0 {
                continue;
            }
            let q = c.integral(x, y);
            let t = c.advance(x, q).expect("within a day");
            assert!((t - y as f64).abs() <= 2.0, "advance({x}, {q}) = {t}, want {y}");
        }
    }

    #[test]
    fn advance_walks_across_a_closed_night() {
        let c = Curve::hours(9 * H, 18 * H);
        // Asking at 17:00 for two hours of service gets one today, one
        // tomorrow — done at 10:00.
        let t = c.advance(17 * H as u64, 2.0 * H as f64).unwrap();
        assert!((t - (D + 10 * H as u64) as f64).abs() <= 2.0, "{t}");
        assert_eq!(c.advance(17 * H as u64, 30.0 * H as f64), None, "more than a day holds");
    }
}
