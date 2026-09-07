use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use futures::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::mpsc;

use crate::protocol::{EntityId, 
    ChunkBounds, ClientMessage, Clock, Growth, DAY_MS, Operation, OwnerId, ServerMessage, StateUpdate,
};

/// One socket. Dies with the connection.
pub type ClientId = u64;

pub enum Command {
    PlayerAction { client_id: ClientId, message: ClientMessage },
    ClientConnect {
        id: ClientId,
        /// Who is behind the socket. Outlives it, so a reload rejoins as the
        /// same person and finds their drafts still standing.
        owner: OwnerId,
        sender: mpsc::UnboundedSender<ServerMessage>,
    },
    ClientDisconnect { id: ClientId },
    /// Ask the game loop a question about the world. It lives on that
    /// task; this is the only way to read it.
    Inspect { query: Ask, reply: tokio::sync::oneshot::Sender<String> },
}

/// What the debug endpoints can ask.
pub enum Ask {
    /// What one resident is thinking.
    Resident(EntityId),
    /// Everyone, one line each.
    Residents,
    /// Who cannot be served, where; and what each building delivered.
    Demand,
    /// What the city is offering, and the shape of what stands.
    Spawner,
    /// A building's lot: its spots, their windows, and what it has seen.
    Lot(EntityId),
    /// Raise a call at a building now, to watch it answered: a shop calls
    /// for stock, a depot for a fetch from beyond the edge.
    Call(EntityId),
}

static NEXT_CLIENT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct AppState {
    pub command_tx: mpsc::UnboundedSender<Command>,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    // The browser keeps this, so identity survives a reload. Nothing verifies
    // it -- anyone can claim to be anyone until players have real accounts.
    let owner = params.get("player").and_then(|s| s.parse::<OwnerId>().ok());
    ws.on_upgrade(move |socket| handle_socket(socket, state, owner))
}

async fn handle_socket(socket: WebSocket, state: AppState, owner: Option<OwnerId>) {
    let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed);
    // A client that brought no identity gets one for this session only.
    let owner = owner.unwrap_or(client_id);
    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<ServerMessage>();

    let _ = state.command_tx.send(Command::ClientConnect {
        id: client_id,
        owner,
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
            let mut clock = Clock { now: 0, speed: 1, day_ms: DAY_MS };
            let mut growth = Growth::default();
            let mut terrain_seed: u32 = 0;
            let mut revealed_bounds = ChunkBounds { min_cx: 0, min_cy: 0, max_cx: -1, max_cy: -1 };
            let mut has_update = false;

            for msg in buf.drain(..) {
                match msg {
                    ServerMessage::Update(su) => {
                        has_update = true;
                        ops.extend(su.ops);
                        clock = su.clock;
                        growth = su.growth.clone();
                        terrain_seed = su.terrain_seed;
                        revealed_bounds = su.revealed_bounds;
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
                let merged = ServerMessage::Update(StateUpdate {
                    ops,
                    clock,
                    growth,
                    terrain_seed,
                    revealed_bounds,
                });
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
