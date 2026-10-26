//! How things move: cars along the roads (`car`) and ships over the sea
//! (`sea`), taking turns where their ways meet (`intersection`), each
//! woken when it next has something to decide (`event_queue`). Why
//! anything goes where it goes is the game's: traffic says who stepped
//! out where, and the game takes it from there.

pub mod car;
pub mod event_queue;
pub mod intersection;
pub mod sea;

use model::EntityId;

/// The roads as traffic drives them: the map, who goes first at each
/// junction and crossing, and every driver who stepped out of a car
/// since, and where.
pub struct Traffic<'a> {
    pub map: &'a mut map::Map,
    pub streets: &'a mut intersection::IntersectionRegistry,
    pub arrived: Vec<(EntityId, EntityId)>,
}
