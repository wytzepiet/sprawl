//! The town: its map (`map::Map`), and the life on it (`town`), which the
//! sim runs over the map, and the mayor's undo.

use fixed::HashMap;
use map::tracked::Tracked;
use map::Map;

/// The town: its map, its rules' state, and who goes first where.
pub struct World {
    pub map: Map,
    /// What the town has to build with, who came and went, the pick on
    /// the table, and every errand under way (`town`). Saved.
    pub town: crate::town::Town,
    /// What happened since the last flush, said to every player.
    pub news: Vec<model::News>,
    /// The town as last sent to the players (`view::flush_dirty`).
    pub shown: Option<model::Town>,
    /// What each player did lately, to take back (`undo.rs`). Not saved.
    pub undo: HashMap<model::OwnerId, Vec<crate::undo::Done>>,
    /// Who goes first at each road junction and crossing: its cars'
    /// claims, keyed by node or crossing. Never saved: trips are not.
    pub streets: traffic::intersection::IntersectionRegistry,
}

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
            shown: None,
            undo: HashMap::default(),
            streets: traffic::intersection::IntersectionRegistry::new(),
        }
    }

    /// A saved world's map; its town is the save's to set.
    pub fn from_loaded(objects: Tracked, terrain_seed: u32) -> Self {
        Self { map: Map::from_loaded(objects, terrain_seed), ..Self::new() }
    }

    /// Traffic over the map, and then every car that stopped on the way
    /// is the town's again: what it does next (`town::arrived`).
    pub fn drive<R>(&mut self, events: &mut traffic::event_queue::EventQueue, f: impl FnOnce(&mut traffic::Traffic, &mut traffic::event_queue::EventQueue) -> R) -> R {
        let mut t = traffic::Traffic { map: &mut self.map, streets: &mut self.streets };
        let r = f(&mut t, events);
        for lorry in std::mem::take(&mut self.map.docks_freed) {
            events.wake(0, lorry);
        }
        r
    }
}
