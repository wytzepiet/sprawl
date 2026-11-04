//! How things move: cars along the roads (`car`), taking turns where
//! their ways meet (`intersection`), each
//! woken when it next has something to decide (`event_queue`). Why
//! anything goes where it goes is the game's: traffic says who stepped
//! out where, and the game takes it from there.

pub mod car;
pub mod event_queue;
pub mod intersection;


/// The roads as traffic drives them: the map, and who goes first at each
/// junction and crossing. A car that stops is woken, for the game to say
/// what it does next.
pub struct Traffic<'a> {
    pub map: &'a mut map::Map,
    pub streets: &'a mut intersection::IntersectionRegistry,
}
