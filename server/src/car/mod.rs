pub mod physics;
pub mod reroute;
pub mod simulation;
pub mod spawn;

/// What a vehicle drives in a lot: a manoeuvring pace, under twenty
/// kilometres an hour.
pub const LOT_SPEED: f64 = 0.4;
/// Backing, about nine kilometres an hour: two and a half metres a second.
pub const REVERSE_SPEED: f64 = 0.2;
/// Where the gear changes the vehicle stops, and stands this long before
/// it pulls the other way, as a driver does.
pub const CUSP_MS: u64 = 500;
pub const MIN_GAP: f64 = 0.5;
/// How far behind the car ahead a driver likes to keep, in time, besides
/// `MIN_GAP`: further the faster they go, so a slowing at the front
/// reaches each one behind a little harder, and a jam spreads back. Not a
/// wall: caught inside it, a driver brakes only as hard as keeping clear
/// of `MIN_GAP` asks.
pub const FOLLOW_S: f64 = 0.25;
pub const MIN_TURN_SPEED: f64 = 0.5;
pub const ACCELERATION: f64 = 0.45;
pub const DECELERATION: f64 = 0.4;
/// Braking for a stop the driver plans: a tile and a half a second
/// squared, under two metres a second lost each second.
pub const HALT: f64 = 0.15;
pub const INTERSECTION_STOP_MARGIN: f64 = 0.4;
/// How far a vehicle reaches ahead of and behind the point the simulation
/// moves. A car is 0.29 tiles about its middle; a lorry is a cab-over
/// tractor with a semi-trailer behind it, 0.67 tiles in all, and the point
/// is the tractor. Following distance and the hold on a junction are by
/// the vehicle's own length.
pub fn nose(role: model::CarRole) -> f64 {
    match role {
        model::CarRole::Private => 0.145,
        model::CarRole::Van | model::CarRole::Tractor => 0.185,
        model::CarRole::Truck => 0.085,
        // Never on a road; the water has no queue.
        model::CarRole::Ferry => 0.5,
    }
}
pub fn tail(role: model::CarRole) -> f64 {
    match role {
        model::CarRole::Private => 0.145,
        model::CarRole::Van | model::CarRole::Tractor => 0.185,
        model::CarRole::Truck => 0.58,
        model::CarRole::Ferry => 0.5,
    }
}

#[derive(Clone, Copy)]
pub enum Obstacle {
    SpeedLimit {
        distance: f64,
        speed: f64,
    },
    /// `distance` to where it would be `MIN_GAP` behind the car ahead.
    LeadCar {
        distance: f64,
        speed: f64,
        accel: f64,
    },
    MustStop {
        distance: f64,
    },
    /// A stop the driver plans: where the gear changes, or at the end of
    /// the way, braking gently all the way in (`HALT`).
    Halt {
        distance: f64,
    },
}

