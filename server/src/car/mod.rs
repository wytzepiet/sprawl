pub mod physics;
pub mod simulation;
pub mod spawn;

pub const CRUISE_SPEED: f64 = 1.5;
/// What a vehicle drives in a lot: a manoeuvring pace, under twenty
/// kilometres an hour.
pub const LOT_SPEED: f64 = 0.4;
/// Backing, about nine kilometres an hour: two and a half metres a second.
pub const REVERSE_SPEED: f64 = 0.2;
/// Where the gear changes the vehicle stops, and stands this long before
/// it pulls the other way, as a driver does.
pub const CUSP_MS: u64 = 500;
pub const MIN_GAP: f64 = 0.5;
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

/// What a car slows or stops for (`World::why`): read by a replay, to
/// say what a car was doing, never by the game.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Cause {
    /// The car ahead in its lane.
    Ahead(crate::protocol::EntityId),
    /// A car coming into its lane at the junction ahead from another arm.
    Merging(crate::protocol::EntityId),
    /// A car in the other lane it lets in ahead of it.
    LettingIn(crate::protocol::EntityId),
    /// The lane its way out asks for, not yet got into: the car in the way
    /// there, if it has tried.
    GettingIn(Option<crate::protocol::EntityId>),
    /// A junction or crossing it has no passage at yet.
    Junction(crate::protocol::EntityId),
    /// A car turning into or out of a lot across its way.
    Turn(crate::protocol::EntityId),
    /// Its give-way line out of a lot, with no gap yet.
    Line,
    /// About to turn into a lot across the oncoming lane.
    TurningIn,
    /// A bend.
    Bend,
    /// A lot, or backing.
    Slow,
    /// A stop it plans: where the gear changes, or its way's end.
    Stop,
}

#[derive(Clone, Copy)]
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
    /// A stop the driver plans: where the gear changes, or at the end of
    /// the way, braking gently all the way in (`HALT`).
    Halt {
        distance: f64,
    },
}
