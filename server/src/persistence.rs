use std::path::Path;

use rusqlite::Connection;

use crate::protocol::{GameObjectEntry, GameObject};
use crate::tree::Cell;

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

/// Everything about a world that is not one of its objects.
///
/// Bundled rather than passed one by one: the list only ever grows, and a
/// function of eight scalars is one whose call sites nobody can read.
#[derive(Debug, Clone, Default)]
pub struct Meta {
    pub next_id: u64,
    pub terrain_seed: u32,
    pub sim_time: u64,
    /// Hours of need served, ever, and what that stood at when the city last
    /// made an offer. Kept to the hundredth, which is far finer than a bar can
    /// show — the metadata column holds whole numbers.
    pub earned: f64,
    /// Stored under the key it was born with, so a save keeps its balance.
    pub spent: f64,
    /// The nodes of the tree taken, one metadata row each.
    pub taken: Vec<Cell>,
}

/// A whole number of hundredths, which is what the metadata table can hold.
fn centi(v: f64) -> i64 {
    (v * 100.0).round() as i64
}

pub fn load(path: &Path) -> (Vec<GameObjectEntry>, Meta) {
    if !path.exists() {
        return (vec![], Meta { next_id: 1, ..Meta::default() });
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

    // Sim time is persisted so a restart continues the day rather than
    // snapping the world back to midnight.
    let sim_time: u64 = conn
        .query_row(
            "SELECT value FROM metadata WHERE key = 'sim_time'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let read = |key: &str| -> i64 {
        conn.query_row("SELECT value FROM metadata WHERE key = ?1", [key], |row| row.get(0))
            .unwrap_or(0)
    };

    let taken = conn
        .prepare("SELECT key FROM metadata WHERE key LIKE 'taken:%'")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get::<_, String>(0))
                .map(|rows| rows.filter_map(|r| r.ok()).filter_map(|k| {
                    let (x, y) = k.strip_prefix("taken:")?.split_once(',')?;
                    Some(Cell { x: x.parse().ok()?, y: y.parse().ok()? })
                }).collect::<Vec<_>>())
        })
        .unwrap_or_default();

    (
        entries,
        Meta {
            next_id,
            terrain_seed,
            sim_time,
            earned: read("earned") as f64 / 100.0,
            spent: read("offered_at") as f64 / 100.0,
            taken,
        },
    )
}

pub fn save(path: &Path, changed: &[GameObjectEntry], removed: &[u64], meta: Meta) {
    let mut conn = Connection::open(path).expect("failed to open db");
    conn.execute_batch(SCHEMA).expect("failed to create schema");
    let tx = conn.transaction().expect("failed to begin transaction");

    for entry in changed {
        // A trip is not worth saving — its route references live world state
        // and a restart ends it anyway. The parked car is; a save mid-trip
        // keeps the version last seen parked, and the driver self-heals home.
        if matches!(entry.object, GameObject::Car(ref c) if c.trip.is_some()) {
            continue;
        }
        // Nor is the edge: it is derived from where the roads run off the
        // map, and it is stood again from the road graph on the way back in.
        // Saved, it would be a building beyond the frontier revealing the
        // ground around itself on every load.
        if matches!(entry.object, GameObject::Building(ref b) if b.kind == crate::protocol::BuildingKind::Edge) {
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

    let taken: Vec<(String, i64)> = meta.taken.iter().map(|c| (format!("taken:{},{}", c.x, c.y), 1)).collect();
    for (key, value) in [
        ("next_id".to_string(), meta.next_id as i64),
        ("terrain_seed".to_string(), meta.terrain_seed as i64),
        ("sim_time".to_string(), meta.sim_time as i64),
        ("earned".to_string(), centi(meta.earned)),
        ("offered_at".to_string(), centi(meta.spent)),
    ]
    .into_iter()
    .chain(taken)
    {
        tx.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES (?1, ?2)",
            rusqlite::params![key, value],
        )
        .unwrap_or_else(|e| panic!("failed to save {key}: {e}"));
    }

    tx.commit().expect("failed to commit");
}
