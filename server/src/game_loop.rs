use std::collections::HashMap;
use tokio::sync::mpsc;
use tokio::time::{interval, Duration};

use crate::protocol::{GridCoord, Operation, ServerMessage};
use crate::world::World;

pub type ClientId = u64;

pub enum Command {
    PlaceRoad { from: GridCoord, to: GridCoord, one_way: bool },
    PlaceBuilding { pos: GridCoord, building_type: String },
    DemolishRoad { pos: GridCoord },
    ResetWorld,
    ClientConnect { id: ClientId, sender: mpsc::UnboundedSender<ServerMessage> },
    ClientDisconnect { id: ClientId },
}

pub async fn run(mut commands: mpsc::UnboundedReceiver<Command>) {
    let mut world = World::new();
    let mut clients: HashMap<ClientId, mpsc::UnboundedSender<ServerMessage>> = HashMap::new();
    let mut tick_interval = interval(Duration::from_millis(10)); // 100hz
    let mut tick_count: u64 = 0;

    loop {
        tick_interval.tick().await;
        tick_count += 1;

        // Drain all pending commands
        while let Ok(cmd) = commands.try_recv() {
            match cmd {
                Command::PlaceRoad { from, to, one_way } => {
                    world.handle_place_road(from, to, one_way);
                }
                Command::PlaceBuilding { pos, building_type } => {
                    world.handle_place_building(pos, building_type);
                }
                Command::DemolishRoad { pos } => {
                    world.handle_demolish_road(pos);
                }
                Command::ResetWorld => {
                    world.reset();
                }
                Command::ClientConnect { id, sender } => {
                    // Send full state snapshot as a single Update
                    let ops: Vec<Operation> = world.objects.all_entries()
                        .into_iter()
                        .map(Operation::Upsert)
                        .collect();
                    if !ops.is_empty() {
                        let _ = sender.send(ServerMessage::Update(ops));
                    }
                    clients.insert(id, sender);
                }
                Command::ClientDisconnect { id } => {
                    clients.remove(&id);
                }
            }
        }

        // Every 5th tick (~20hz): flush dirty state to clients
        if tick_count % 5 == 0 {
            let (changed, removed) = world.objects.drain_dirty();

            let mut ops = Vec::new();

            for id in &changed {
                if let Some(entry) = world.objects.get(*id) {
                    ops.push(Operation::Upsert(entry.clone()));
                }
            }

            for id in removed {
                ops.push(Operation::Delete(id));
            }

            if !ops.is_empty() {
                let msg = ServerMessage::Update(ops);
                broadcast(&clients, &msg);
            }
        }
    }
}

fn broadcast(clients: &HashMap<ClientId, mpsc::UnboundedSender<ServerMessage>>, msg: &ServerMessage) {
    for sender in clients.values() {
        let _ = sender.send(msg.clone());
    }
}
