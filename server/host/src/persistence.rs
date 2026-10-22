use std::path::Path;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use sprawl::protocol::{GameObject, GameObjectEntry};

/// Every object a row of its JSON, and the rest of the world one row more.
/// A save is this build's: a change to either shape means starting over
/// (`rm sprawl.db`), and a row this build cannot read says so.
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS objects (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 0), data TEXT NOT NULL);
";

/// Everything about a world that is not one of its objects.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meta {
    pub next_id: u64,
    pub terrain_seed: u32,
    /// So a restart continues the day rather than snapping the world back
    /// to midnight.
    pub sim_time: u64,
    /// GDP to date: the level.
    pub gdp: f64,
    /// The mayor's coins.
    pub treasury: f64,
    /// The town's missions, open and finished, in order.
    pub missions: Vec<sprawl::missions::Mission>,
    /// The market's prices, their week and the orders waiting.
    pub market: sprawl::market::Market,
}

impl Default for Meta {
    fn default() -> Self {
        Meta { next_id: 1, terrain_seed: 0, sim_time: 0, gdp: 0.0, treasury: 0.0, missions: Vec::new(), market: Default::default() }
    }
}

/// The save, open for as long as the game runs.
pub struct Db {
    conn: Connection,
    path: String,
}

impl Db {
    pub fn open(path: &Path) -> Db {
        let conn = Connection::open(path).expect("failed to open db");
        conn.execute_batch(SCHEMA).expect("failed to create schema");
        Db { conn, path: path.display().to_string() }
    }

    /// What was saved: none of it for a new file.
    pub fn load(&self) -> (Vec<GameObjectEntry>, Meta) {
        // Dropping a row this build cannot read would leave a world with
        // roads and no buildings, which reveals nothing and shows as fog to
        // the horizon.
        let unreadable = |e: &dyn std::fmt::Display| -> ! { panic!("{} was written by another build ({e}); delete it to start over", self.path) };
        let mut stmt = self.conn.prepare("SELECT data FROM objects").expect("failed to prepare select");
        let entries: Vec<GameObjectEntry> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .expect("failed to query objects")
            .map(|json| serde_json::from_str(&json.expect("failed to read a row")).unwrap_or_else(|e| unreadable(&e)))
            .collect();
        let meta = self.conn.query_row("SELECT data FROM meta", [], |row| row.get::<_, String>(0)).optional().expect("failed to read meta");
        let meta = match meta {
            Some(json) => serde_json::from_str(&json).unwrap_or_else(|e| unreadable(&e)),
            None if entries.is_empty() => Meta::default(),
            None => unreadable(&"objects and no meta"),
        };
        (entries, meta)
    }

    /// The objects changed and removed since the last save, and the rest
    /// as it stands now.
    pub fn save(&mut self, changed: &[&GameObjectEntry], removed: &[u64], meta: &Meta) {
        let tx = self.conn.transaction().expect("failed to begin transaction");
        for entry in changed {
            let json = serde_json::to_string(entry).expect("failed to serialize");
            tx.execute("INSERT OR REPLACE INTO objects (id, data) VALUES (?1, ?2)", rusqlite::params![entry.id, json]).expect("failed to upsert object");
        }
        for &id in removed {
            tx.execute("DELETE FROM objects WHERE id = ?1", [id]).expect("failed to delete object");
        }
        let json = serde_json::to_string(meta).expect("failed to serialize");
        tx.execute("INSERT OR REPLACE INTO meta (id, data) VALUES (0, ?1)", [json]).expect("failed to save meta");
        tx.commit().expect("failed to commit");
    }

    /// Nothing saved: a world reset starts its save over.
    pub fn clear(&mut self) {
        self.conn.execute_batch("DELETE FROM objects; DELETE FROM meta;").expect("failed to clear the save");
    }
}

/// Whether an object is worth saving. A journey is not — a trip's route
/// references live world state, and a run or a voyage is timed by wakes
/// that die with the process, so a restart ends all of them anyway. The parked car is; a save mid-journey keeps the
/// version last seen parked, and the driver self-heals home, or the
/// shelves the ship was fetching for call again.
pub fn kept(entry: &GameObjectEntry) -> bool {
    !matches!(entry.object, GameObject::Car(ref c) if c.trip.is_some() || c.run.is_some() || c.sail.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sprawl::protocol::{Car, CarRole, GridCoord, Sail};

    /// A save of its own, gone when the test is.
    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(name: &str) -> Scratch {
            let path = std::env::temp_dir().join(format!("sprawl-{name}-{}", std::process::id()));
            let _ = std::fs::remove_file(&path);
            Scratch(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    /// A ship saved mid-voyage comes back as it was last seen at the quay:
    /// the wakes that time a voyage die with the process, so a saved one
    /// would stand at sea with no clock to bring it home.
    #[test]
    fn a_journey_is_not_saved() {
        let scratch = Scratch::new("journey");
        let mut db = Db::open(&scratch.0);
        let mut save = |e: GameObjectEntry| {
            let saved: Vec<_> = Some(&e).into_iter().filter(|e| kept(e)).collect();
            db.save(&saved, &[], &Meta::default());
        };
        let quay = GridCoord { x: 5, y: 5 };
        let mut ship = Car::new(1, CarRole::Ferry);
        save(GameObjectEntry { id: 2, object: GameObject::Car(ship.clone()), position: Some(quay) });
        ship.sail = Some(Sail { path: vec![[5.5, 5.5], [5.5, 9.5]], started: 0, ends: 1, ease: [true, false], astern: true });
        save(GameObjectEntry { id: 2, object: GameObject::Car(ship), position: Some(GridCoord { x: 5, y: 6 }) });
        let (loaded, _) = Db::open(&scratch.0).load();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].position, Some(quay), "the ship is not where it was last moored");
        assert!(matches!(loaded[0].object, GameObject::Car(ref c) if c.sail.is_none()));
    }

    /// The rest of the world outlives a restart as it stood, the town's
    /// missions with their steps and the market's week among it, whether or not an object
    /// changed with it; and a reset leaves nothing to load.
    #[test]
    fn the_world_beside_its_objects_is_saved() {
        let scratch = Scratch::new("meta");
        let mut missions = sprawl::missions::Missions::default().list;
        missions[0].steps[1].done = true;
        missions[0].finished = Some(7);
        let market = serde_json::from_str(r#"{"hour":3,"at":{"Timber":0.5},"push":{"Timber":0.1},"history":{"Timber":[1.0,1.5,2.0]},"orders":[]}"#).unwrap();
        let meta = Meta { next_id: 40, terrain_seed: 7, sim_time: 12_345, gdp: 1.25, treasury: 99.5, missions, market };
        let mut db = Db::open(&scratch.0);
        db.save(&[], &[], &meta);
        let (_, loaded) = Db::open(&scratch.0).load();
        assert_eq!(serde_json::to_string(&loaded).unwrap(), serde_json::to_string(&meta).unwrap());
        db.clear();
        let (entries, loaded) = Db::open(&scratch.0).load();
        assert!(entries.is_empty() && loaded.next_id == 1);
    }
}
