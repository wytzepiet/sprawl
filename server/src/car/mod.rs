pub mod physics;
pub mod simulation;
pub mod spawn;

pub const CRUISE_SPEED: f64 = 1.5;
/// What a vehicle drives in a lot: a manoeuvring pace, about fifteen
/// kilometres an hour.
pub const LOT_SPEED: f64 = 0.35;
/// Backing, a brisk walk: under two metres a second.
pub const REVERSE_SPEED: f64 = 0.15;
/// Where the gear changes the vehicle stops, and stands this long before
/// it pulls the other way, as a driver does.
pub const CUSP_MS: u64 = 500;
pub const MIN_GAP: f64 = 0.5;
pub const MIN_TURN_SPEED: f64 = 0.5;
pub const ACCELERATION: f64 = 0.45;
pub const DECELERATION: f64 = 0.4;
pub const INTERSECTION_STOP_MARGIN: f64 = 0.4;
/// How far a vehicle reaches ahead of and behind the point the simulation
/// moves. A car is 0.29 tiles about its middle; a lorry is a cab-over
/// tractor with a semi-trailer behind it, 0.67 tiles in all, and the point
/// is the tractor. Following distance and the hold on a junction are by
/// the vehicle's own length.
pub fn nose(role: crate::protocol::CarRole) -> f64 {
    match role {
        crate::protocol::CarRole::Private => 0.145,
        crate::protocol::CarRole::Van | crate::protocol::CarRole::Tractor => 0.185,
        crate::protocol::CarRole::Truck => 0.085,
        // Never on a road; the water has no queue.
        crate::protocol::CarRole::Ferry | crate::protocol::CarRole::Tug => 0.5,
    }
}
pub fn tail(role: crate::protocol::CarRole) -> f64 {
    match role {
        crate::protocol::CarRole::Private => 0.145,
        crate::protocol::CarRole::Van | crate::protocol::CarRole::Tractor => 0.185,
        crate::protocol::CarRole::Truck => 0.58,
        crate::protocol::CarRole::Ferry | crate::protocol::CarRole::Tug => 0.5,
    }
}

pub enum Obstacle {
    SpeedLimit {
        distance: f64,
        speed: f64,
    },
    LeadCar {
        distance: f64,
        speed: f64,
        accel: f64,
    },
    MustStop {
        distance: f64,
    },
}
