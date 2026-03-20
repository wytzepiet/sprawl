pub mod physics;
pub mod simulation;
pub mod spawn;

use crate::protocol::EntityId;

pub const CRUISE_SPEED: f64 = 1.5;
pub const MIN_GAP: f64 = 0.5;
pub const MIN_TURN_SPEED: f64 = 0.5;
pub const ACCELERATION: f64 = 0.3;
pub const DECELERATION: f64 = 0.4;
pub const INTERSECTION_STOP_MARGIN: f64 = 0.4;
pub const CAR_NOSE: f64 = 0.175;
pub const CAR_TAIL: f64 = 0.175;

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

pub enum GameEvent {
    CarSpawn { building_id: EntityId },
    CarWakeUp { car_id: EntityId },
}
