//! How a browser draws the game, as the browser reports it
//! (`client/src/engine/PerfReport.tsx`): any device that opens the game with
//! `?bench` or `?tab=` posts a report every few seconds, appended here a line
//! a report beside the save, and read back by its run's name, so a phone's
//! frames can be read from anywhere (`bun run pan --read <run>`).
use std::io::Write;

use axum::extract::Query;
use std::collections::HashMap;

fn file() -> std::path::PathBuf {
    crate::game_loop::db_path().with_extension("perf.jsonl")
}

pub async fn post(body: String) -> axum::http::StatusCode {
    let line = body.replace('\n', " ");
    let ok = std::fs::OpenOptions::new().create(true).append(true).open(file()).and_then(|mut f| writeln!(f, "{line}"));
    if ok.is_ok() { axum::http::StatusCode::NO_CONTENT } else { axum::http::StatusCode::INTERNAL_SERVER_ERROR }
}

/// The reports of one run (`?tab=`), a line each; with no run, the last
/// line of each run, newest last: which runs there are.
pub async fn get(Query(q): Query<HashMap<String, String>>) -> String {
    let all = std::fs::read_to_string(file()).unwrap_or_default();
    match q.get("tab") {
        Some(tab) => {
            let needle = format!("\"tab\":\"{tab}\"");
            all.lines().filter(|l| l.contains(&needle)).map(|l| format!("{l}\n")).collect()
        }
        None => {
            let mut last: Vec<(String, &str)> = Vec::new();
            for l in all.lines() {
                let tab = l.split("\"tab\":\"").nth(1).and_then(|r| r.split('"').next()).unwrap_or("").to_string();
                last.retain(|(t, _)| *t != tab);
                last.push((tab, l));
            }
            last.iter().map(|(_, l)| format!("{l}\n")).collect()
        }
    }
}
