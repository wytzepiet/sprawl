//! The town: its map (`map::Map`), and what is in the mayor's hand to
//! build it with (`town::Town`).

use fixed::HashMap;
use map::tracked::Tracked;
use map::Map;

/// The town: its map, the mayor's hand, and the road's junctions.
pub struct World {
    pub map: Map,
    /// What the mayor has to build with, who has come and gone, the pick
    /// on the table (`town.rs`). Saved.
    pub town: crate::town::Town,
    /// What the hand said to everyone since the last flush.
    pub news: Vec<model::News>,
    /// What each player did lately, to take back (`undo.rs`). Not saved.
    pub undo: HashMap<model::OwnerId, Vec<crate::undo::Done>>,
    /// Who goes first at each road junction and crossing: its cars'
    /// claims, keyed by node or crossing. Never saved: trips are not.
    pub streets: traffic::intersection::IntersectionRegistry,
}

/// A town on this map, from its first day.
impl From<Map> for World {
    fn from(map: Map) -> World {
        World { map, ..World::new() }
    }
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

impl World {
    pub fn new() -> Self {
        Self {
            map: Map::new(),
            town: Default::default(),
            news: Vec::new(),
            undo: HashMap::default(),
            streets: traffic::intersection::IntersectionRegistry::new(),
        }
    }

    /// A saved world's map; its town is the save's to set.
    pub fn from_loaded(objects: Tracked, terrain_seed: u32) -> Self {
        Self { map: Map::from_loaded(objects, terrain_seed), ..Self::new() }
    }

    /// May a road be laid: a level's map has road to spare, a town as
    /// much as its allowance.
    pub fn affords(&self, _link: crate::undo::Link) -> bool {
        self.map.frame.is_some() || self.map.laid < self.town.allowance
    }

    /// Traffic over the map.
    pub fn drive<R>(&mut self, events: &mut traffic::event_queue::EventQueue, f: impl FnOnce(&mut traffic::Traffic, &mut traffic::event_queue::EventQueue) -> R) -> R {
        let mut t = traffic::Traffic { map: &mut self.map, streets: &mut self.streets };
        f(&mut t, events)
    }
}
