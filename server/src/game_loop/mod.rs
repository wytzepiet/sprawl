use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;
use tokio::time::{Instant, interval, Duration};

use crate::car::spawn::schedule_car_spawn;
use crate::car::simulation::handle_car_wake_up;
use crate::car::{GameEvent, spawn::handle_car_spawn};
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::engine::tracked::Tracked;
use crate::intersection::IntersectionRegistry;
use crate::network::{ClientId, Command};
use crate::persistence;
use crate::protocol::{BuildingType, ClientMessage, EntityId, GameObject, Operation, ServerMessage, StateUpdate};
use crate::world::World;

const DB_FILE: &str = "sprawl.db";
const PERSIST_INTERVAL: Duration = Duration::from_secs(1);

pub async fn run(mut commands: mpsc::UnboundedReceiver<Command>) {
    let db_path = PathBuf::from(DB_FILE);
    let mut world = load_world(&db_path);
    let mut events: EventQueue<GameEvent> = EventQueue::new();
    let mut intersections = IntersectionRegistry::new();
    let mut clients: HashMap<ClientId, mpsc::UnboundedSender<ServerMessage>> = HashMap::new();

    // Rebuild segments and schedule car spawns for loaded buildings
    if !world.objects.all_entries().is_empty() {
        world.rebuild_segments();
        for entry in world.objects.all_entries() {
            if let GameObject::Building(ref b) = entry.object
                && b.building_type == BuildingType::CarSpawner
            {
                schedule_car_spawn(&mut events, entry.id);
            }
        }
        println!("loaded {} objects from db", world.objects.all_entries().len());
    }

    let mut tick_interval = interval(Duration::from_millis(10));
    let start = Instant::now();
    let mut last_persist = Instant::now();

    loop {
        tick_interval.tick().await;
        let now: GameTime = start.elapsed().as_millis() as u64;

        while let Ok(cmd) = commands.try_recv() {
            match cmd {
                Command::PlayerAction { client_id, message } => {
                    if let ClientMessage::Ping = &message
                        && let Some(sender) = clients.get(&client_id) {
                            let _ = sender.send(ServerMessage::Pong(now));
                        }
                    if let ClientMessage::ResetWorld = &message {
                        // Broadcast deletes for every object, then reset all state in-place
                        let all_ids: Vec<EntityId> = world.objects.all_entries().iter().map(|e| e.id).collect();
                        let ops = all_ids.iter().map(|&id| Operation::Delete(id)).collect();
                        broadcast(&clients, &ServerMessage::Update(StateUpdate { ops, server_time: now }));
                        world = World::new();
                        events = EventQueue::new();
                        intersections = IntersectionRegistry::new();
                        let _ = std::fs::remove_file(&db_path);
                        println!("reset: world cleared, db deleted");
                    } else {
                        handle_player_action(&mut world, &mut events, &mut intersections, message, now);
                    }
                }
                Command::ClientConnect { id, sender } => {
                    let ops: Vec<Operation> = world.objects.all_entries()
                        .into_iter()
                        .map(|e| Operation::Upsert(Box::new(e)))
                        .collect();
                    if !ops.is_empty() {
                        let _ = sender.send(ServerMessage::Update(StateUpdate { ops, server_time: now }));
                    }
                    clients.insert(id, sender);
                }
                Command::ClientDisconnect { id } => {
                    clients.remove(&id);
                }
            }
        }

        events.set_now(now);
        while let Some(scheduled) = events.pop_due() {
            handle_game_event(&mut world, &mut events, &mut intersections, scheduled.event, now);
        }

        flush_dirty(&mut world, &clients, now);

        if last_persist.elapsed() >= PERSIST_INTERVAL {
            persist(&mut world, &db_path);
            last_persist = Instant::now();
        }
    }
}

fn load_world(db_path: &Path) -> World {
    let (entries, next_id) = persistence::load(db_path);
    if entries.is_empty() {
        World::new()
    } else {
        World::from_loaded(Tracked::load(entries, next_id))
    }
}

fn persist(world: &mut World, db_path: &Path) {
    let (changed_ids, removed_ids) = world.objects.drain_persist_dirty();
    if changed_ids.is_empty() && removed_ids.is_empty() {
        return;
    }

    let changed: Vec<_> = changed_ids
        .iter()
        .filter_map(|id| world.objects.get(*id))
        .cloned()
        .collect();

    persistence::save(db_path, &changed, &removed_ids, world.objects.next_id());
    println!("persisted {} changed, {} removed", changed.len(), removed_ids.len());
}

/// Despawn all cars, clear intersections, and rebuild the segment graph.
fn despawn_all_cars_and_rebuild(
    world: &mut World,
    events: &mut EventQueue<GameEvent>,
    intersections: &mut IntersectionRegistry,
) {
    for entry in world.objects.all_entries() {
        if matches!(entry.object, GameObject::Car(_)) {
            events.clear_dedup(entry.id);
        }
    }
    world.despawn_all_cars();
    intersections.clear();
    world.rebuild_segments();
}

fn handle_player_action(
    world: &mut World,
    events: &mut EventQueue<GameEvent>,
    intersections: &mut IntersectionRegistry,
    message: ClientMessage,
    _now: GameTime,
) {
    match message {
        ClientMessage::PlaceRoad(place) => {
            world.handle_place_road(place.from, place.to, place.one_way);
            despawn_all_cars_and_rebuild(world, events, intersections);
        }
        ClientMessage::PlaceBuilding(place) => {
            if let Some(building_id) = world.handle_place_building(place.pos, place.building_type)
                && place.building_type == BuildingType::CarSpawner {
                    schedule_car_spawn(events, building_id);
                }
        }
        ClientMessage::DemolishRoad(demolish) => {
            if let Some(node_id) = world.road_node_at(demolish.pos) {
                intersections.remove_node(node_id);
            }
            world.handle_demolish_road(demolish.pos);
            despawn_all_cars_and_rebuild(world, events, intersections);
        }
        ClientMessage::ResetWorld => unreachable!("handled in run()"),
        ClientMessage::Ping => {}
    }
}

fn handle_game_event(
    world: &mut World,
    events: &mut EventQueue<GameEvent>,
    intersections: &mut IntersectionRegistry,
    event: GameEvent,
    now: GameTime,
) {
    match event {
        GameEvent::CarSpawn { building_id } => {
            handle_car_spawn(world, events, building_id, now);
        }
        GameEvent::CarWakeUp { car_id } => {
            handle_car_wake_up(world, events, intersections, car_id, now);
        }
    }
}

fn flush_dirty(
    world: &mut World,
    clients: &HashMap<ClientId, mpsc::UnboundedSender<ServerMessage>>,
    now: GameTime,
) {
    let (changed, removed) = world.objects.drain_dirty();

    let mut ops = Vec::new();
    for id in &changed {
        if let Some(entry) = world.objects.get(*id) {
            ops.push(Operation::Upsert(Box::new(entry.clone())));
        }
    }
    for id in removed {
        ops.push(Operation::Delete(id));
    }

    if !ops.is_empty() {
        let msg = ServerMessage::Update(StateUpdate { ops, server_time: now });
        broadcast(clients, &msg);
    }
}

fn broadcast(
    clients: &HashMap<ClientId, mpsc::UnboundedSender<ServerMessage>>,
    msg: &ServerMessage,
) {
    for sender in clients.values() {
        let _ = sender.send(msg.clone());
    }
}
