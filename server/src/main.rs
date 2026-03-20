mod car;
mod engine;
mod game_loop;
mod intersection;
mod road_gen;
mod network;
mod persistence;
mod protocol;
mod terrain;
mod world;

use axum::Router;
use tokio::sync::mpsc;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use network::AppState;

#[tokio::main]
async fn main() {
    let (command_tx, command_rx) = mpsc::unbounded_channel();

    tokio::spawn(game_loop::run(command_rx));

    let client_dir = std::env::var("CLIENT_DIR").unwrap_or_else(|_| "../client/dist".into());
    let index = format!("{}/index.html", client_dir);

    let app = Router::new()
        .route("/ws", axum::routing::get(network::ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(AppState { command_tx })
        .fallback_service(ServeDir::new(&client_dir).fallback(ServeFile::new(&index)));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3001")
        .await
        .unwrap();
    println!("server listening on :3001");
    axum::serve(listener, app).await.unwrap();
}
