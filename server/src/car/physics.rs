use super::{ACCELERATION, CRUISE_SPEED, DECELERATION, MIN_TURN_SPEED, Obstacle};

/// Max speed allowed at a node given the cosine of the turn angle.
pub fn turn_speed(cos_angle: f64) -> f64 {
    let factor = cos_angle.clamp(0.0, 1.0);
    MIN_TURN_SPEED + factor * (CRUISE_SPEED - MIN_TURN_SPEED)
}

/// Advance kinematics by dt seconds with constant acceleration.
/// Clamps dt so the car stops rather than reversing when braking.
pub fn catch_up(progress: f64, speed: f64, accel: f64, dt: f64) -> (f64, f64) {
    let dt = if accel < 0.0 {
        dt.min(-speed / accel)
    } else {
        dt
    };
    let new_progress = progress + speed * dt + 0.5 * accel * dt * dt;
    let new_speed = (speed + accel * dt).max(0.0);
    (new_progress, new_speed)
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
            if my_speed > target_speed + 0.05 {
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
    fn at_a_steady_speed_it_is_just_distance_over_speed() {
        assert_eq!(time_to_reach(0.0, 2.0, 0.0, 10.0), Some(5.0));
    }

    #[test]
    fn from_rest_it_accounts_for_the_pulling_away() {
        // 0.5 * 2 * t^2 = 4  ->  t = 2
        let t = time_to_reach(0.0, 0.0, 2.0, 4.0).unwrap();
        assert!((t - 2.0).abs() < 1e-9, "got {t}");
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
