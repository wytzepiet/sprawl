mod game_loop;
mod health;
mod network;
mod perf;
mod persistence;

use model::{blueprint, needs};
use map::fixtures;
use axum::Router;
use tokio::sync::mpsc;
use axum::http::{HeaderName, HeaderValue};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use network::AppState;

#[tokio::main]
async fn main() {
    needs::check();
    blueprint::check();
    let (command_tx, command_rx) = mpsc::unbounded_channel();

    tokio::spawn(game_loop::run(command_rx));

    let client_dir = std::env::var("CLIENT_DIR").unwrap_or_else(|_| "../client/dist".into());
    let index = format!("{}/index.html", client_dir);

    let app = Router::new()
        .route("/ws", axum::routing::get(network::ws_handler))
        .route("/health", axum::routing::get(health::health))
        .route("/debug/lot/{id}", axum::routing::get(health::inspect_lot))
        .route("/town", axum::routing::get(health::town))
        .route("/sea", axum::routing::get(health::sea))
        .route("/map", axum::routing::get(health::map))
        .route("/perf", axum::routing::get(perf::get).post(perf::post))
        .route("/fixtures", axum::routing::get(|| async { axum::Json(fixtures::PLACED.get().cloned().unwrap_or_default()) }))
        .with_state(AppState { command_tx })
        .fallback_service(ServeDir::new(&client_dir).fallback(ServeFile::new(&index)))
        // A page may sample its own JavaScript only when it is served asking to.
        .layer(SetResponseHeaderLayer::overriding(HeaderName::from_static("document-policy"), HeaderValue::from_static("js-profiling")));

    // Another port lets a fixture server stand beside the game's.
    let port = std::env::var("SPRAWL_PORT").unwrap_or_else(|_| "4801".into());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .unwrap();
    println!("server listening on :{port}");
    axum::serve(listener, app).await.unwrap();
}
