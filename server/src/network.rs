use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use futures::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::mpsc;

use crate::game_loop::Command;
use crate::protocol::{ClientMessage, ServerMessage};

static NEXT_CLIENT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct AppState {
    pub command_tx: mpsc::UnboundedSender<Command>,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed);
    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<ServerMessage>();

    let _ = state.command_tx.send(Command::ClientConnect {
        id: client_id,
        sender: msg_tx,
    });

    let (mut sink, mut stream) = socket.split();

    // Write task: forward ServerMessages from game loop to WebSocket
    let write_task = tokio::spawn(async move {
        while let Some(msg) = msg_rx.recv().await {
            let bytes = rmp_serde::to_vec_named(&msg).unwrap();
            if sink.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
    });

    // Read task: forward ClientMessages to game loop as Commands
    let command_tx = state.command_tx.clone();
    while let Some(Ok(msg)) = stream.next().await {
        let Message::Binary(data) = msg else {
            continue;
        };

        match rmp_serde::from_slice::<ClientMessage>(&data) {
            Ok(msg) => {
                let _ = command_tx.send(Command::PlayerAction {
                    client_id,
                    message: msg,
                });
            }
            Err(e) => {
                eprintln!("deserialize error from client {client_id}: {e}");
            }
        }
    }

    let _ = state.command_tx.send(Command::ClientDisconnect { id: client_id });
    write_task.abort();
}
