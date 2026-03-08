mod car_physics;
mod bezier;
mod event_queue;
mod game_loop;
mod intersection;
mod network;
mod pathfinding;
mod protocol;
mod segment_tracker;
mod tracked;
mod world;

use axum::Router;
use tokio::sync::mpsc;
use tower_http::cors::CorsLayer;

use network::AppState;

#[tokio::main]
async fn main() {
    let (command_tx, command_rx) = mpsc::unbounded_channel();

    tokio::spawn(game_loop::run(command_rx));

    let app = Router::new()
        .route("/ws", axum::routing::get(network::ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(AppState { command_tx });

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3001")
        .await
        .unwrap();
    println!("server listening on :3001");
    axum::serve(listener, app).await.unwrap();
}
