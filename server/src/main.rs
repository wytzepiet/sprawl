mod blueprint;
mod car;
mod engine;
mod game_loop;
mod health;
mod intersection;
mod needs;
mod road_gen;
mod spawner;
mod network;
mod persistence;
mod protocol;
mod resident;
mod terrain;
mod tree;
mod world;
mod xp;

use axum::Router;
use tokio::sync::mpsc;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use network::AppState;

#[tokio::main]
async fn main() {
    needs::check();
    blueprint::check();
    tree::check();
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
        .route("/debug/spawner", axum::routing::get(health::inspect_spawner))
        .route("/debug/blueprints", axum::routing::get(health::inspect_blueprints))
        .route("/tree", axum::routing::get(health::tree))
        .layer(CorsLayer::permissive())
        .with_state(AppState { command_tx })
        .fallback_service(ServeDir::new(&client_dir).fallback(ServeFile::new(&index)));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3001")
        .await
        .unwrap();
    println!("server listening on :3001");
    axum::serve(listener, app).await.unwrap();
}
