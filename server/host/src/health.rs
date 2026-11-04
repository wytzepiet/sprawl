use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path, Query, State};
use std::collections::HashMap;
use tokio::sync::oneshot;

use crate::network::{AppState, Command, Debug};
use model::EntityId;

/// Simulated time, as of the last tick. Published here rather than asked for
/// over the command channel: the question this answers is "is the game loop
/// still running", and a channel round-trip cannot answer that if it is not.
pub static SIM_TIME: AtomicU64 = AtomicU64::new(0);

/// What the server is, and whether it is alive.
///
/// Two failures have cost real time here, and both were silent. A binary that
/// was never rebuilt looks exactly like a fix that did not work — `built`
/// answers that, being the mtime of the running executable, so it moves
/// whenever the thing you are talking to was actually compiled. And the socket
/// has outlived the game loop before, leaving a server that accepts
/// connections and simulates nothing — `sim_time` answers that, because a
/// number that does not move means a world that has stopped.
pub async fn health() -> String {
    let built = std::env::current_exe()
        .and_then(std::fs::metadata)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    format!(
        "{{\"built\":{},\"built_ago_s\":{},\"sim_time\":{}}}\n",
        built,
        now.saturating_sub(built),
        SIM_TIME.load(Ordering::Relaxed),
    )
}

/// A building's lot: spots, windows, and what it has seen.
pub async fn inspect_lot(Path(id): Path<EntityId>, State(state): State<AppState>) -> String {
    ask(&state, Debug::Lot(id)).await
}

/// Every shipment, every timetable and every harbour's park: `/sea`.
pub async fn sea(State(state): State<AppState>) -> String {
    ask(&state, Debug::Sea).await
}

/// The town's page: `/town`.
pub async fn town(State(state): State<AppState>) -> String {
    ask(&state, Debug::Town).await
}

/// The tiles round a point as a fixture's text, drawn as the map is seen:
/// what `bun run plan` draws of the running game. `/map?x=0&y=0&r=20`.
pub async fn map(Query(q): Query<HashMap<String, String>>, State(state): State<AppState>) -> String {
    let at = |k: &str, or: i32| q.get(k).and_then(|v| v.parse::<i32>().ok()).unwrap_or(or);
    let text = ask(&state, Debug::Map { x: at("x", 0), y: at("y", 0), r: at("r", 20) }).await;
    serde_json::from_str::<String>(&text).unwrap_or(text)
}

async fn ask(state: &AppState, query: Debug) -> String {
    let (reply, answer) = oneshot::channel();
    if state.command_tx.send(Command::Inspect { query, reply }).is_err() {
        return "{\"error\":\"game loop gone\"}\n".into();
    }
    answer.await.unwrap_or_else(|_| "{\"error\":\"game loop gone\"}\n".into())
}

/// The world as saved, a copy of the file to download: open it with
/// `SPRAWL_DB=<file> cargo run` to play the same town anywhere.
pub async fn save() -> Result<([(axum::http::header::HeaderName, &'static str); 2], Vec<u8>), String> {
    tokio::task::spawn_blocking(|| {
        let copy = std::env::temp_dir().join(format!("sprawl-save-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&copy);
        let db = rusqlite::Connection::open_with_flags(crate::game_loop::db_path(), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
        db.execute("VACUUM INTO ?1", [copy.to_string_lossy()]).map_err(|e| e.to_string())?;
        let bytes = std::fs::read(&copy).map_err(|e| e.to_string());
        let _ = std::fs::remove_file(&copy);
        bytes
    })
    .await
    .map_err(|e| e.to_string())?
    .map(|bytes| ([(axum::http::header::CONTENT_TYPE, "application/vnd.sqlite3"), (axum::http::header::CONTENT_DISPOSITION, "attachment; filename=\"sprawl.db\"")], bytes))
}
