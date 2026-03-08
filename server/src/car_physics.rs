pub const CRUISE_SPEED: f64 = 2.0; // tiles/sec
pub const MIN_TURN_SPEED: f64 = 0.5; // tiles/sec
pub const ACCELERATION: f64 = 1.0; // tiles/sec²
pub const DECELERATION: f64 = 1.0; // tiles/sec²
pub const SAFE_FOLLOWING_GAP: f64 = 0.3; // tiles

/// Max speed allowed at a node given the cosine of the turn angle.
/// cos_angle = 1.0 means straight, 0.0 means 90°, -1.0 means U-turn.
pub fn max_speed_at_node(cos_angle: f64) -> f64 {
    let factor = cos_angle.clamp(0.0, 1.0);
    MIN_TURN_SPEED + factor * (CRUISE_SPEED - MIN_TURN_SPEED)
}

/// Compute progress and speed after dt seconds, given initial state and constant acceleration.
pub fn update_kinematics(progress: f64, speed: f64, accel: f64, dt: f64) -> (f64, f64) {
    let new_progress = progress + speed * dt + 0.5 * accel * dt * dt;
    let new_speed = (speed + accel * dt).max(0.0);
    (new_progress, new_speed)
}

/// Braking distance from current speed to target speed using DECELERATION.
pub fn braking_distance(from_speed: f64, to_speed: f64) -> f64 {
    if from_speed <= to_speed {
        return 0.0;
    }
    let t = (from_speed - to_speed) / DECELERATION;
    from_speed * t - 0.5 * DECELERATION * t * t
}
