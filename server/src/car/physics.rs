use super::{ACCELERATION, CRUISE_SPEED, DECELERATION, MIN_TURN_SPEED, Obstacle};

/// Max speed allowed at a node given the cosine of the turn angle.
pub fn turn_speed(cos_angle: f64) -> f64 {
    let factor = cos_angle.clamp(0.0, 1.0);
    MIN_TURN_SPEED + factor * (CRUISE_SPEED - MIN_TURN_SPEED)
}

/// Advance kinematics by dt seconds with constant acceleration.
///
/// Braking stops the car rather than reversing it, and accelerating stops at
/// the cruising speed rather than sailing past it. Nothing else held that
/// ceiling: acceleration is only recomputed when a car wakes, so between two
/// wakes it simply kept gaining, and cars were driving stretches of road
/// faster than the road allows.
pub fn catch_up(progress: f64, speed: f64, accel: f64, dt: f64) -> (f64, f64) {
    if accel < 0.0 {
        let dt = dt.min(-speed / accel);
        return (
            progress + speed * dt + 0.5 * accel * dt * dt,
            (speed + accel * dt).max(0.0),
        );
    }
    // Pulling away up to the ceiling, then holding it for what is left.
    let to_ceiling = if accel > 0.0 { (CRUISE_SPEED - speed) / accel } else { f64::INFINITY };
    if to_ceiling >= dt {
        return (progress + speed * dt + 0.5 * accel * dt * dt, speed + accel * dt);
    }
    // A car already over the ceiling settles back onto it.
    let t = to_ceiling.max(0.0);
    (
        progress + speed * t + 0.5 * accel * t * t + CRUISE_SPEED * (dt - t),
        CRUISE_SPEED,
    )
}

/// When a car travelling like this passes `target`, in seconds from now.
///
/// Within one step the simulation's motion *is* this quadratic — `catch_up`
/// holds one acceleration for the whole of it — so this is the exact moment,
/// not an estimate. Which is why measuring a journey does not depend on a car
/// being woken at the right instant: a wake that lands late still knows when
/// the line was actually crossed.
///
/// `None` if it never gets there.
pub fn time_to_reach(progress: f64, speed: f64, accel: f64, target: f64) -> Option<f64> {
    let d = target - progress;
    if d <= 0.0 {
        return Some(0.0);
    }
    if accel.abs() < 1e-9 {
        return (speed > 1e-9).then(|| d / speed);
    }
    if accel > 0.0 {
        // Only quadratic up to the cruising speed; flat after that, and
        // `catch_up` drives it the same way, so this stays the exact moment
        // rather than an estimate of it.
        let to_ceiling = ((CRUISE_SPEED - speed) / accel).max(0.0);
        let before = speed * to_ceiling + 0.5 * accel * to_ceiling * to_ceiling;
        if d > before {
            return Some(to_ceiling + (d - before) / CRUISE_SPEED);
        }
    }
    let disc = speed * speed + 2.0 * accel * d;
    if disc < 0.0 {
        return None; // slows to a stop short of it
    }
    let t = (-speed + disc.sqrt()) / accel;
    (t >= 0.0).then_some(t)
}

/// Distance needed to brake from `from_speed` to `to_speed` at DECELERATION.
pub fn braking_distance(from_speed: f64, to_speed: f64) -> f64 {
    if from_speed <= to_speed {
        return 0.0;
    }
    let t = (from_speed - to_speed) / DECELERATION;
    from_speed * t - 0.5 * DECELERATION * t * t
}

/// When accelerating, how long until we must switch to braking to hit target speed at distance?
fn time_to_start_braking(speed: f64, remaining: f64, target_speed: f64) -> f64 {
    let a = ACCELERATION;
    let d = DECELERATION;
    let qa = a * (a + d);
    let qb = 2.0 * speed * (a + d);
    let qc = speed * speed - target_speed * target_speed - 2.0 * d * remaining;
    let discriminant = qb * qb - 4.0 * qa * qc;
    if discriminant < 0.0 {
        return 0.0;
    }
    let t = (-qb + discriminant.sqrt()) / (2.0 * qa);
    t.max(0.0)
}

impl Obstacle {
    /// Required acceleration to handle this obstacle.
    pub fn required_accel(&self, my_speed: f64) -> f64 {
        let (distance, target_speed) = match *self {
            Obstacle::SpeedLimit { distance, speed } => (distance, speed),
            Obstacle::LeadCar {
                distance,
                speed,
                accel,
            } => {
                // Dead zone: close enough to lead car, just match its acceleration.
                // Prevents accelerate→brake oscillation for micro-gaps.
                if distance < 0.05 && my_speed <= speed + 1e-3 {
                    return accel.min(0.0);
                }
                let effective = if accel < 0.0 && my_speed > 1e-6 {
                    (speed + accel * distance / my_speed).max(0.0)
                } else {
                    speed
                };
                (distance, effective)
            }
            Obstacle::MustStop { distance } => (distance, 0.0),
        };

        let brake_dist = braking_distance(my_speed, target_speed);
        if distance < 0.01 {
            // Some slack around the target keeps a car from hunting above and
            // below it. Around a *stop* there can be none: zero acceleration
            // means holding whatever speed you have, and any speed at all
            // eventually carries you over the line. Cars were creeping through
            // junctions they were still queued at, at two hundredths of a tile
            // a second, because that counted as close enough to stopped.
            let slack = if target_speed > 0.0 { 0.05 } else { 0.0 };
            if my_speed > target_speed + slack {
                -(my_speed * my_speed) / 0.02
            } else if my_speed < target_speed - 0.05 {
                ACCELERATION
            } else {
                0.0
            }
        } else if distance <= brake_dist + 0.01 {
            -((my_speed * my_speed - target_speed * target_speed) / (2.0 * distance))
        } else {
            let max_speed = (target_speed * target_speed + 2.0 * DECELERATION * distance).sqrt();
            if my_speed < CRUISE_SPEED.min(max_speed) - 0.05 {
                ACCELERATION
            } else {
                0.0
            }
        }
    }

    /// Time (ms) until we need to re-evaluate for this obstacle.
    pub fn wake_time(&self, my_speed: f64, my_accel: f64) -> u64 {
        let (distance, target_speed) = match *self {
            Obstacle::SpeedLimit { distance, speed } => (distance, speed),
            Obstacle::LeadCar {
                distance, speed, ..
            } => (distance, speed),
            Obstacle::MustStop { distance } => (distance, 0.0),
        };

        // Car is stopped or nearly stopped at/near the obstacle — wait for external wake.
        // But only if the target is also stopped; if it's moving away the gap is opening.
        if my_speed < 1e-3 && my_accel <= 0.0 && distance < 0.01 && target_speed < 1e-3 {
            return u64::MAX;
        }

        let t = if my_accel > 0.0 {
            let time_to_cruise = (CRUISE_SPEED - my_speed).max(0.0) / my_accel;
            let time_to_brake = time_to_start_braking(my_speed, distance, target_speed);
            time_to_cruise.min(time_to_brake)
        } else if my_accel < 0.0 {
            if my_speed > target_speed {
                (my_speed - target_speed) / (-my_accel)
            } else {
                return u64::MAX; // reached target speed, wait for external wake
            }
        } else {
            // Cruising — wake when we reach the braking point, not the obstacle.
            let brake_dist = braking_distance(my_speed, target_speed);
            (distance - brake_dist).max(0.0) / my_speed.max(0.1)
        };

        ((t * 1000.0) as u64).max(10)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pulling_away_stops_at_the_cruising_speed() {
        // Would reach 4.5 in 10s unchecked.
        let (_, speed) = catch_up(0.0, 0.0, ACCELERATION, 10.0);
        assert_eq!(speed, CRUISE_SPEED);
    }

    #[test]
    fn and_covers_only_what_that_allows() {
        let (progress, _) = catch_up(0.0, 0.0, ACCELERATION, 10.0);
        let unchecked = 0.5 * ACCELERATION * 100.0;
        assert!(progress < unchecked, "capped {progress} should be under {unchecked}");
        // Up to the ceiling, then holding it.
        let t = CRUISE_SPEED / ACCELERATION;
        let expected = 0.5 * ACCELERATION * t * t + CRUISE_SPEED * (10.0 - t);
        assert!((progress - expected).abs() < 1e-9, "got {progress}, want {expected}");
    }

    #[test]
    fn a_short_step_still_accelerates_normally() {
        let (progress, speed) = catch_up(0.0, 0.0, ACCELERATION, 0.5);
        assert!((speed - ACCELERATION * 0.5).abs() < 1e-9);
        assert!((progress - 0.5 * ACCELERATION * 0.25).abs() < 1e-9);
    }

    /// The two have to agree, or a wake lands somewhere the car never was.
    #[test]
    fn the_solver_and_the_motion_tell_the_same_story() {
        for target in [0.1, 1.0, 4.0, 20.0, 100.0] {
            for (v0, a) in [(0.0, ACCELERATION), (1.0, ACCELERATION), (CRUISE_SPEED, 0.0)] {
                let Some(t) = time_to_reach(0.0, v0, a, target) else { continue };
                let (progress, _) = catch_up(0.0, v0, a, t);
                assert!(
                    (progress - target).abs() < 1e-6,
                    "v0={v0} a={a} target={target}: solver said {t}s, motion reached {progress}",
                );
            }
        }
    }

    /// The creep that let cars drift through junctions they were queued at.
    #[test]
    fn a_stop_line_underfoot_means_stopped_not_nearly_stopped() {
        let line = Obstacle::MustStop { distance: 0.0 };
        assert!(line.required_accel(0.02) < 0.0, "barely moving is still moving");
        assert!(line.required_accel(1.0) < 0.0, "and so is moving properly");
        assert_eq!(line.required_accel(0.0), 0.0, "stopped is stopped");
    }

    /// A limit the car has already reached is held, not ignored: the turn
    /// limit stays in force from the start of the bend all the way to the
    /// node, and at zero distance it is what stops the car winding back up to
    /// cruise halfway round the corner.
    #[test]
    fn a_limit_underfoot_holds_the_car_at_it() {
        let here = Obstacle::SpeedLimit { distance: 0.0, speed: 0.5 };
        assert_eq!(here.required_accel(0.5), 0.0, "at the limit: hold");
        assert!(here.required_accel(0.2) > 0.0, "under the limit: pull away");
        assert!(here.required_accel(1.2) < 0.0, "over the limit: shed it");
    }

    #[test]
    fn a_limit_far_enough_off_does_not_slow_anyone_yet() {
        let far = Obstacle::SpeedLimit { distance: 50.0, speed: 0.5 };
        assert!(far.required_accel(1.0) >= 0.0, "no need to brake from that far");
    }

    #[test]
    fn at_a_steady_speed_it_is_just_distance_over_speed() {
        assert_eq!(time_to_reach(0.0, 2.0, 0.0, 10.0), Some(5.0));
    }

    #[test]
    fn from_rest_it_accounts_for_the_pulling_away() {
        // Short enough to still be gaining speed at the end: 0.5 * 2 * t^2 = 0.5
        let t = time_to_reach(0.0, 0.0, 2.0, 0.5).unwrap();
        assert!((t - 0.707_106_781).abs() < 1e-6, "got {t}");
    }

    #[test]
    fn and_over_a_longer_run_it_accounts_for_the_ceiling_too() {
        // Pulls away to CRUISE_SPEED, then holds it the rest of the way.
        let to_ceiling = CRUISE_SPEED / 2.0;
        let covered = 0.5 * 2.0 * to_ceiling * to_ceiling;
        let t = time_to_reach(0.0, 0.0, 2.0, 4.0).unwrap();
        let expected = to_ceiling + (4.0 - covered) / CRUISE_SPEED;
        assert!((t - expected).abs() < 1e-9, "got {t}, want {expected}");
    }

    #[test]
    fn a_car_already_past_it_crossed_at_once() {
        assert_eq!(time_to_reach(10.0, 2.0, 0.0, 4.0), Some(0.0));
    }

    #[test]
    fn a_car_stopping_short_never_gets_there() {
        // Braking from 1.0 covers 0.25 before stopping, so 10 is out of reach.
        assert_eq!(time_to_reach(0.0, 1.0, -2.0, 10.0), None);
    }

    #[test]
    fn standing_still_and_not_pulling_away_never_gets_there() {
        assert_eq!(time_to_reach(0.0, 0.0, 0.0, 4.0), None);
    }
}
