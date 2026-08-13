use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

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
