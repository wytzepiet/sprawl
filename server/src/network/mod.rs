use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use futures::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::mpsc;

use crate::protocol::{ClientMessage, Operation, ServerMessage, StateUpdate};

pub type ClientId = u64;

pub enum Command {
    PlayerAction { client_id: ClientId, message: ClientMessage },
    ClientConnect { id: ClientId, sender: mpsc::UnboundedSender<ServerMessage> },
    ClientDisconnect { id: ClientId },
}

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

    // Write task: batch ServerMessages over a 50ms window before sending
    let write_task = tokio::spawn(async move {
        let mut buf: Vec<ServerMessage> = Vec::new();
        loop {
            let first = match msg_rx.recv().await {
                Some(msg) => msg,
                None => return,
            };
            buf.push(first);

            tokio::time::sleep(std::time::Duration::from_millis(50)).await;

            while let Ok(msg) = msg_rx.try_recv() {
                buf.push(msg);
            }

            let mut ops: Vec<Operation> = Vec::new();
            let mut server_time: u64 = 0;
            let mut terrain_seed: u32 = 0;
            let mut has_update = false;

            for msg in buf.drain(..) {
                match msg {
                    ServerMessage::Update(su) => {
                        has_update = true;
                        ops.extend(su.ops);
                        server_time = server_time.max(su.server_time);
                        terrain_seed = su.terrain_seed;
                    }
                    other => {
                        let bytes = rmp_serde::to_vec_named(&other).unwrap();
                        if sink.send(Message::Binary(bytes.into())).await.is_err() {
                            return;
                        }
                    }
                }
            }

            if has_update {
                let merged = ServerMessage::Update(StateUpdate { ops, server_time, terrain_seed });
                let bytes = rmp_serde::to_vec_named(&merged).unwrap();
                if sink.send(Message::Binary(bytes.into())).await.is_err() {
                    return;
                }
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
