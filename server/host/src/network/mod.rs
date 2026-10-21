use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use futures::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::mpsc;

use sprawl::protocol::{
    ClientMessage, EntityId, OwnerId, ServerMessage, StateUpdate,
};

/// One socket. Dies with the connection.
pub use sprawl::game::ClientId;

pub enum Command {
    PlayerAction { client_id: ClientId, message: ClientMessage },
    ClientConnect {
        id: ClientId,
        /// Who is behind the socket. Outlives it, so a reload rejoins as the
        /// same person and finds their history to undo.
        owner: OwnerId,
        sender: mpsc::UnboundedSender<ServerMessage>,
    },
    ClientDisconnect { id: ClientId },
    /// Ask the game loop a question about the world. It lives on that
    /// task; this is the only way to read it.
    Inspect { query: Debug, reply: tokio::sync::oneshot::Sender<String> },
}

/// What the debug endpoints can ask.
pub enum Debug {
    /// A building's lot: its spots, their windows, and what it has seen.
    Lot(EntityId),
    /// The card for one thing on the map, whatever it is.
    Card(EntityId),
    /// The town's page: what it served and what crossed the door.
    Town,
    /// Every shipment, every timetable, every harbour's park and every
    /// box on a hitch: the sea as the server has it.
    Sea,
    /// The tiles round a point as a fixture's text.
    Map { x: i32, y: i32, r: i32 },
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

    // Write task: send what is queued as soon as it is, in order, the
    // updates that came one after another merged into one. Waiting for more
    // would only delay the first; a socket that cannot keep up lets a queue
    // grow, and that is what gets merged. Only neighbours merge: a chunk
    // unloaded between two updates must not overtake the ops before it.
    let write_task = tokio::spawn(async move {
        let mut out: Vec<ServerMessage> = Vec::new();
        while let Some(first) = msg_rx.recv().await {
            let mut next = Some(first);
            while let Some(msg) = next {
                queue(&mut out, msg);
                next = msg_rx.try_recv().ok();
            }
            for msg in out.drain(..) {
                let bytes = rmp_serde::to_vec_named(&msg).unwrap();
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

/// A message on to what the socket sends next: an update straight after
/// another is merged into it, its ops after theirs and the rest as of the
/// later; anything else keeps its place.
fn queue(out: &mut Vec<ServerMessage>, msg: ServerMessage) {
    match (out.last_mut(), msg) {
        (Some(ServerMessage::Update(last)), ServerMessage::Update(su)) => {
            let (mut ops, mut lumps) = (std::mem::take(&mut last.ops), std::mem::take(&mut last.lumps));
            ops.extend(su.ops);
            lumps.extend(su.lumps);
            *last = StateUpdate { ops, lumps, ..su };
        }
        (_, msg) => out.push(msg),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sprawl::protocol::{ChunkCoord, Clock, Operation, DAY_MS};

    /// A chunk unloaded between two updates goes out between them: merged
    /// past it, the second's ops would land after the chunk they belong to
    /// was let go.
    #[test]
    fn only_neighbouring_updates_merge() {
        let world = sprawl::world::World::new();
        let update = |id| ServerMessage::Update(StateUpdate { ops: vec![Operation::Delete(id)], ..sprawl::view::state_update(&world, Clock { now: id, speed: 1, day_ms: DAY_MS }) });
        let mut out = Vec::new();
        for msg in [update(1), update(2), ServerMessage::UnloadChunk(ChunkCoord { cx: 0, cy: 0 }), update(3), update(4)] {
            queue(&mut out, msg);
        }
        let shape: Vec<String> = out
            .iter()
            .map(|m| match m {
                ServerMessage::Update(su) => format!("{:?}@{}", su.ops.iter().map(|o| match o { Operation::Delete(id) => *id, _ => 0 }).collect::<Vec<_>>(), su.clock.now),
                _ => "unload".into(),
            })
            .collect();
        assert_eq!(shape, ["[1, 2]@2", "unload", "[3, 4]@4"]);
    }
}
