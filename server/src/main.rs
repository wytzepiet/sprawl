mod blueprint;
mod calls;
mod card;
mod car;
mod drafts;
mod economy;
mod engine;
mod fixtures;
mod game_loop;
mod haul;
mod health;
mod intersection;
mod mountains;
mod needs;
mod network;
mod persistence;
mod protocol;
mod resident;
mod terrain;
mod tree;
mod world;

use axum::Router;
use tokio::sync::mpsc;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

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
        .route("/debug/residents", axum::routing::get(health::inspect_residents))
        .route("/debug/resident/{id}", axum::routing::get(health::inspect_resident))
        .route("/debug/demand", axum::routing::get(health::inspect_demand))
        .route("/debug/lot/{id}", axum::routing::get(health::inspect_lot))
        .route("/debug/call/{id}", axum::routing::get(health::call))
        .route("/debug/blueprints", axum::routing::get(health::inspect_blueprints))
        .route("/inspect/{id}", axum::routing::get(health::card))
        .route("/town", axum::routing::get(health::town))
        .route("/sea", axum::routing::get(health::sea))
        .route("/map", axum::routing::get(health::map))
        .route("/fixtures", axum::routing::get(|| async { axum::Json(fixtures::PLACED.get().cloned().unwrap_or_default()) }))
        .layer(CorsLayer::permissive())
        .with_state(AppState { command_tx })
        .fallback_service(ServeDir::new(&client_dir).fallback(ServeFile::new(&index)));

    // Another port lets a fixture server stand beside the game's.
    let port = std::env::var("SPRAWL_PORT").unwrap_or_else(|_| "4801".into());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .unwrap();
    println!("server listening on :{port}");
    axum::serve(listener, app).await.unwrap();
}
