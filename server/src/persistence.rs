use std::path::Path;

use rusqlite::Connection;

use crate::protocol::{GameObjectEntry, GameObject};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS objects (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    pos_x INTEGER,
    pos_y INTEGER
);
CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);
";

pub fn load(path: &Path) -> (Vec<GameObjectEntry>, u64, u32) {
    if !path.exists() {
        return (vec![], 1, 0);
    }

    let conn = Connection::open(path).expect("failed to open db");
    let mut stmt = conn
        .prepare("SELECT id, data FROM objects")
        .expect("failed to prepare select");

    let entries: Vec<GameObjectEntry> = stmt
        .query_map([], |row| {
            let _id: u64 = row.get(0)?;
            let json: String = row.get(1)?;
            Ok(json)
        })
        .expect("failed to query objects")
        .filter_map(|r| r.ok())
        .filter_map(|json| serde_json::from_str::<GameObjectEntry>(&json).ok())
        .filter(|e| !matches!(e.object, GameObject::Car(_)))
        .collect();

    let next_id: u64 = conn
        .query_row(
            "SELECT value FROM metadata WHERE key = 'next_id'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(1);

    let terrain_seed: u32 = conn
        .query_row(
            "SELECT value FROM metadata WHERE key = 'terrain_seed'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    (entries, next_id, terrain_seed)
}

pub fn save(path: &Path, changed: &[GameObjectEntry], removed: &[u64], next_id: u64, terrain_seed: u32) {
    let mut conn = Connection::open(path).expect("failed to open db");
    conn.execute_batch(SCHEMA).expect("failed to create schema");
    let tx = conn.transaction().expect("failed to begin transaction");

    for entry in changed {
        if matches!(entry.object, GameObject::Car(_)) {
            continue;
        }
        let json = serde_json::to_string(entry).expect("failed to serialize");
        let (px, py) = entry
            .position
            .map(|p| (Some(p.x), Some(p.y)))
            .unwrap_or((None, None));
        tx.execute(
            "INSERT OR REPLACE INTO objects (id, data, pos_x, pos_y) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![entry.id, json, px, py],
        )
        .expect("failed to upsert object");
    }

    for &id in removed {
        tx.execute("DELETE FROM objects WHERE id = ?1", [id])
            .expect("failed to delete object");
    }

    tx.execute(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('next_id', ?1)",
        [next_id as i64],
    )
    .expect("failed to save next_id");

    tx.execute(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('terrain_seed', ?1)",
        [terrain_seed as i64],
    )
    .expect("failed to save terrain_seed");

    tx.commit().expect("failed to commit");
}
