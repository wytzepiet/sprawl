pub mod physics;
pub mod simulation;
pub mod spawn;

pub const CRUISE_SPEED: f64 = 1.5;
/// What a car drives in a lot: a crawl, a third of cruise.
pub const LOT_SPEED: f64 = 0.5;
pub const MIN_GAP: f64 = 0.5;
pub const MIN_TURN_SPEED: f64 = 0.5;
pub const ACCELERATION: f64 = 0.45;
pub const DECELERATION: f64 = 0.4;
pub const INTERSECTION_STOP_MARGIN: f64 = 0.4;
/// How far a vehicle reaches ahead of and behind the point the simulation
/// moves. A car is 0.35 tiles about its middle; a lorry is a cab-over
/// tractor with a semi-trailer behind it, 0.8 tiles in all, and the point
/// is the tractor. Following distance and the hold on a junction are by
/// the vehicle's own length.
pub fn nose(role: crate::protocol::CarRole) -> f64 {
    match role {
        crate::protocol::CarRole::Private | crate::protocol::CarRole::Company => 0.175,
        crate::protocol::CarRole::Van => 0.225,
        crate::protocol::CarRole::Truck => 0.1,
    }
}
pub fn tail(role: crate::protocol::CarRole) -> f64 {
    match role {
        crate::protocol::CarRole::Private | crate::protocol::CarRole::Company => 0.175,
        crate::protocol::CarRole::Van => 0.225,
        crate::protocol::CarRole::Truck => 0.7,
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
