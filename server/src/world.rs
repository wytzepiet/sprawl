//! The town: its map (`map::Map`), and the life on it, which the sim
//! runs over the map: its books and calls, its market, its
//! ferries' lines and voyages, the mayor's undo.

use fixed::HashMap;
use map::tracked::Tracked;
use map::Map;
use model::EntityId;

/// The town: its map, and the life on it, its books and calls, its
/// market, its ferries' lines.
pub struct World {
    pub map: Map,
    /// Every building's books: what its taps served, a season of days. Learned, not saved — a loaded world
    /// starts counting afresh.
    pub books: HashMap<EntityId, crate::economy::Books>,
    /// The town's own books: what it served, and what crossed the border.
    pub town: crate::economy::Books<crate::economy::Town>,
    /// GDP to date: the value the town has added, banked as it appears
    /// (`economy`). The level is its running sum.
    pub gdp: f64,
    /// The mayor's coins: the town's balance of trade, less what it built.
    /// docs/trade.md, Coins.
    pub treasury: f64,
    /// Coins and GDP that landed on buildings since the last flush, for
    /// the clients looking at them.
    pub lumps: Vec<model::Lump>,
    /// What the town bought of its own accord since the last flush, said
    /// to every player.
    pub news: Vec<model::News>,
    /// The sea, read from the terrain the first time a way over it is
    /// wanted (`traffic::sea::water`).
    pub water: std::sync::OnceLock<traffic::sea::water::Water>,
    /// Each harbour's line to the world, its ways found when it is
    /// commissioned. Derived, like every other index.
    pub lines: std::collections::BTreeMap<EntityId, traffic::sea::lines::Line>,
    /// The lanes those ways are laid as, the junctions where they share
    /// or cross water, and each ship's leg through them: derived too, and
    /// a ship saved at sea comes back moored.
    pub lanes: Option<traffic::sea::lanes::Lanes>,
    pub voyages: HashMap<EntityId, traffic::sea::voyage::Voyage>,
    /// Calls raised and not yet resolved. Not saved: a shop still low when
    /// the world comes back calls again at its next visit.
    pub calls: Vec<crate::calls::Call>,
    /// What each player did lately, to take back (`undo.rs`). Not saved.
    pub undo: HashMap<model::OwnerId, Vec<crate::undo::Done>>,
    /// The buildings placed lately, for razing to give back (`undo::raze`).
    /// Not saved.
    pub placed: Vec<crate::undo::Placed>,
    /// Who goes first at each sea junction and berth: its ships' claims.
    pub junctions: traffic::intersection::IntersectionRegistry,
    /// Who goes first at each road junction and crossing: its cars'
    /// claims, keyed by node or crossing. Never saved: trips are not.
    pub streets: traffic::intersection::IntersectionRegistry,
    /// Every line that may have a desk free: each one settled, and each
    /// that lost a worker. Some are full; `settle` sees which, by id.
    pub vacancies: std::collections::BTreeSet<EntityId>,
    /// Every building settled as a site, standing or not since: those
    /// still waiting call for their timber (`game::settle_and_wake`).
    pub sites: std::collections::BTreeSet<EntityId>,
    /// Buildings whose trips changed since the last settle, to look at
    /// again for what they wait on (`waits::look`). Not saved: every
    /// building is looked at on load.
    pub waiting: std::collections::BTreeSet<EntityId>,
    /// The market's prices and the orders waiting on them (`market.rs`). Saved.
    pub market: crate::market::Market,
    /// What the town may build, and what its labs are learning (`research.rs`). Saved.
    pub research: crate::research::Research,
}

/// A town on this map, from its first day: the mayor's stake, nothing booked.
impl From<Map> for World {
    fn from(map: Map) -> World {
        World { map, ..World::new() }
    }
}

impl World {
    pub fn new() -> Self {
        Self {
            map: Map::new(),
            books: HashMap::default(),
            town: Default::default(),
            gdp: 0.0,
            treasury: crate::economy::STAKE,
            lumps: Vec::new(),
            news: Vec::new(),
            water: Default::default(),
            lines: Default::default(),
            lanes: None,
            voyages: HashMap::default(),
            calls: Vec::new(),
            undo: HashMap::default(),
            placed: Vec::new(),
            junctions: traffic::intersection::IntersectionRegistry::new(),
            streets: traffic::intersection::IntersectionRegistry::new(),
            vacancies: Default::default(),
            sites: Default::default(),
            waiting: Default::default(),
            market: Default::default(),
            research: Default::default(),
        }
    }

    /// A saved world's map; its coins, market and research are the save's to set.
    pub fn from_loaded(objects: Tracked, terrain_seed: u32) -> Self {
        Self { map: Map::from_loaded(objects, terrain_seed), treasury: 0.0, ..Self::new() }
    }

    /// Traffic over the map, and then whoever stepped out of a car on the
    /// way steps in where it stopped (`resident::set_at`).
    pub fn drive<R>(&mut self, events: &mut traffic::event_queue::EventQueue, f: impl FnOnce(&mut traffic::Traffic, &mut traffic::event_queue::EventQueue) -> R) -> R {
        let mut t = traffic::Traffic { map: &mut self.map, streets: &mut self.streets, arrived: Vec::new() };
        let r = f(&mut t, events);
        for (who, at) in t.arrived {
            crate::resident::set_at(self, events, who, at, events.now());
        }
        r
    }
}
