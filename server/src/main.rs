mod game_loop;
mod protocol;
mod tracked;
mod world;

use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use protocol::{ClientMessage, ServerMessage};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::mpsc;
use tower_http::cors::CorsLayer;

use game_loop::Command;

static NEXT_CLIENT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct AppState {
    command_tx: mpsc::UnboundedSender<Command>,
}

#[tokio::main]
async fn main() {
    let (command_tx, command_rx) = mpsc::unbounded_channel();

    tokio::spawn(game_loop::run(command_rx));

    let state = AppState { command_tx };

    let app = Router::new()
        .route("/ws", axum::routing::get(ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3001")
        .await
        .unwrap();
    println!("server listening on :3001");
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed);
    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<ServerMessage>();

    // Register with game loop
    let _ = state.command_tx.send(Command::ClientConnect {
        id: client_id,
        sender: msg_tx,
    });

    let (mut sink, mut stream) = socket.split();

    // Write task: forward ServerMessages from game loop to WS
    let write_task = tokio::spawn(async move {
        while let Some(msg) = msg_rx.recv().await {
            let bytes = rmp_serde::to_vec_named(&msg).unwrap();
            if sink.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
    });

    // Read task: deserialize ClientMessages and send Commands to game loop
    let command_tx = state.command_tx.clone();
    while let Some(Ok(msg)) = stream.next().await {
        let Message::Binary(data) = msg else {
            continue;
        };

        match rmp_serde::from_slice::<ClientMessage>(&data) {
            Ok(ClientMessage::PlaceRoad(place)) => {
                let _ = command_tx.send(Command::PlaceRoad {
                    from: place.from,
                    to: place.to,
                    one_way: place.one_way,
                });
            }
            Ok(ClientMessage::PlaceBuilding(place)) => {
                let _ = command_tx.send(Command::PlaceBuilding {
                    pos: place.pos,
                    building_type: place.building_type,
                });
            }
            Ok(ClientMessage::DemolishRoad(demolish)) => {
                let _ = command_tx.send(Command::DemolishRoad {
                    pos: demolish.pos,
                });
            }
            Ok(ClientMessage::ResetWorld) => {
                let _ = command_tx.send(Command::ResetWorld);
            }
            Ok(ClientMessage::Ping) => {
                // handled outside game loop — no need to skip
            }
            Err(e) => {
                eprintln!("deserialize error from client {client_id}: {e}");
            }
        }
    }

    // Client disconnected
    let _ = state.command_tx.send(Command::ClientDisconnect { id: client_id });
    write_task.abort();
}
