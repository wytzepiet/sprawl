use std::path::Path;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use model::{GameObject, GameObjectEntry};

/// Every object a row of its JSON, and the rest of the world one row more.
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS objects (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 0), data TEXT NOT NULL);
";

/// One step of a save from its version to the next, its objects' JSON and
/// its meta's rewritten in place; `None` where an old save is not worth
/// keeping, and starts over. A change that makes old saves wrong or
/// unreadable pushes one, and the save's version is how many there are,
/// stamped in SQLite's own `user_version` by every save. A save that
/// cannot be brought up to date is set aside beside the file as
/// `<file>.v<version>.bak`, and so is one before it is.
type Migration = Option<fn(&mut [Value], &mut Value)>;

const MIGRATIONS: &[Migration] = &[
    // Saves from before the stamp are version 0, and already today's.
    Some(|_, _| {}),
];

pub const SAVE_VERSION: u32 = MIGRATIONS.len() as u32;

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
    pub missions: Vec<model::missions::Mission>,
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

    /// What was saved, brought up to date: none of it for a new file, or
    /// for one that cannot be.
    pub fn load(&mut self) -> (Vec<GameObjectEntry>, Meta) {
        let version: u32 = self.conn.pragma_query_value(None, "user_version", |r| r.get(0)).expect("failed to read the save's version");
        match self.read(version) {
            Ok(save) if version == SAVE_VERSION => save,
            Ok((entries, meta)) => {
                let backup = self.set_aside(version);
                self.save(&entries.iter().collect::<Vec<_>>(), &[], &meta);
                println!("{} migrated from save version {version} to {SAVE_VERSION}, the old one set aside as {backup}", self.path);
                (entries, meta)
            }
            Err(why) => {
                let backup = self.set_aside(version);
                self.clear();
                println!("{} {why}: set aside as {backup}, starting over", self.path);
                (Vec::new(), Meta::default())
            }
        }
    }

    /// The save, if this build can read all of it. Dropping only the rows
    /// it cannot read would leave a world with roads and no buildings.
    fn read(&self, version: u32) -> Result<(Vec<GameObjectEntry>, Meta), String> {
        let rows = |sql| -> Vec<String> {
            let mut stmt = self.conn.prepare(sql).expect("failed to prepare select");
            stmt.query_map([], |row| row.get(0)).expect("failed to query").map(|r| r.expect("failed to read a row")).collect()
        };
        let (objects, meta) = (rows("SELECT data FROM objects"), rows("SELECT data FROM meta"));
        if objects.is_empty() && meta.is_empty() {
            return Ok((Vec::new(), Meta::default()));
        }
        let unreadable = |e: serde_json::Error| format!("holds what this build cannot read ({e}); push a migration with such a change");
        let mut objects = objects.iter().map(|json| serde_json::from_str(json)).collect::<Result<Vec<Value>, _>>().map_err(unreadable)?;
        let mut meta = serde_json::from_str(meta.first().ok_or("has objects and no meta")?).map_err(unreadable)?;
        let steps = MIGRATIONS.get(version as usize..).ok_or(format!("is save version {version}, newer than this build's {SAVE_VERSION}"))?;
        for (v, step) in (version..).zip(steps) {
            step.ok_or(format!("is save version {v}, which version {} does not keep", v + 1))?(&mut objects, &mut meta);
        }
        let entries = objects.into_iter().map(serde_json::from_value).collect::<Result<_, _>>().map_err(unreadable)?;
        Ok((entries, serde_json::from_value(meta).map_err(unreadable)?))
    }

    /// A copy of the save as it stands, beside it.
    fn set_aside(&self, version: u32) -> String {
        let backup = format!("{}.v{version}.bak", self.path);
        let _ = std::fs::remove_file(&backup);
        self.conn.execute("VACUUM INTO ?1", [&backup]).expect("failed to set the save aside");
        backup
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
        tx.pragma_update(None, "user_version", SAVE_VERSION).expect("failed to stamp the save");
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
    use model::{Car, CarRole, GridCoord, Sail};

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

    /// An old save is brought up to date and kept, the old one set aside
    /// beside it; one that cannot be, newer or unreadable, is set aside
    /// whole and the world starts over.
    #[test]
    fn an_old_save_is_migrated_or_set_aside() {
        let scratch = Scratch::new("old");
        let backup = |v: u32| std::path::PathBuf::from(format!("{}.v{v}.bak", scratch.0.display()));
        let meta = Meta { next_id: 40, ..Meta::default() };
        let version = |db: &Db| db.conn.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0)).unwrap();
        let mut db = Db::open(&scratch.0);
        db.save(&[], &[], &meta);
        db.conn.pragma_update(None, "user_version", 0).unwrap();
        let (_, loaded) = Db::open(&scratch.0).load();
        assert_eq!(loaded.next_id, 40, "a save from before the stamp was not kept");
        assert_eq!(version(&db), SAVE_VERSION);
        assert!(backup(0).exists());
        db.conn.pragma_update(None, "user_version", SAVE_VERSION + 1).unwrap();
        let (_, loaded) = Db::open(&scratch.0).load();
        assert_eq!(loaded.next_id, 1, "a newer save was loaded");
        assert!(backup(SAVE_VERSION + 1).exists());
        db.save(&[], &[], &meta);
        db.conn.execute("INSERT INTO objects (id, data) VALUES (1, '{}')", []).unwrap();
        let (entries, loaded) = Db::open(&scratch.0).load();
        assert!(entries.is_empty() && loaded.next_id == 1, "an unreadable save was loaded");
        assert!(backup(SAVE_VERSION).exists());
        for v in [0, SAVE_VERSION, SAVE_VERSION + 1] {
            let _ = std::fs::remove_file(backup(v));
        }
    }
}
