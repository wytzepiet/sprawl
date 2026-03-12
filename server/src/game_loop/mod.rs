use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;
use tokio::time::{Instant, interval, Duration};

use crate::car::spawn::schedule_car_spawn;
use crate::car::simulation::{handle_car_wake_up, despawn_car_fully};
use crate::car::{ACCELERATION, GameEvent, spawn::handle_car_spawn};
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::engine::tracked::Tracked;
use crate::intersection::IntersectionRegistry;
use crate::network::{ClientId, Command};
use crate::persistence;
use crate::protocol::{BuildingType, ClientMessage, EntityId, GameObject, Operation, ServerMessage, StateUpdate};
use crate::world::World;
use crate::world::pathfinding;

const DB_FILE: &str = "sprawl.db";
const PERSIST_INTERVAL: Duration = Duration::from_secs(1);

pub async fn run(mut commands: mpsc::UnboundedReceiver<Command>) {
    let db_path = PathBuf::from(DB_FILE);
    let mut world = load_world(&db_path);
    let mut events: EventQueue<GameEvent> = EventQueue::new();
    let mut intersections = IntersectionRegistry::new();
    let mut clients: HashMap<ClientId, mpsc::UnboundedSender<ServerMessage>> = HashMap::new();

    // Generate terrain if world is empty (first startup)
    if world.objects.all_entries().is_empty() {
        let seed = rand::random::<u32>();
        crate::terrain::generate(&mut world, seed);
        println!("generated terrain ({} tiles)", world.objects.all_entries().len());
    }

    // Rebuild edges/indices and schedule car spawns for loaded buildings
    if !world.objects.all_entries().is_empty() {
        world.rebuild_edges();
        world.rebuild_node_cars();
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
                        let all_ids: Vec<EntityId> = world.objects.all_entries().iter().map(|e| e.id).collect();
                        let ops = all_ids.iter().map(|&id| Operation::Delete(id)).collect();
                        broadcast(&clients, &ServerMessage::Update(StateUpdate { ops, server_time: now }));
                        world = World::new();
                        events = EventQueue::new();
                        intersections = IntersectionRegistry::new();
                        let _ = std::fs::remove_file(&db_path);
                        crate::terrain::generate(&mut world, rand::random::<u32>());
                        let terrain_ops: Vec<Operation> = world.objects.all_entries()
                            .into_iter()
                            .map(|e| Operation::Upsert(Box::new(e)))
                            .collect();
                        broadcast(&clients, &ServerMessage::Update(StateUpdate { ops: terrain_ops, server_time: now }));
                        println!("reset: world cleared, terrain regenerated");
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

fn handle_player_action(
    world: &mut World,
    events: &mut EventQueue<GameEvent>,
    intersections: &mut IntersectionRegistry,
    message: ClientMessage,
    now: GameTime,
) {
    match message {
        ClientMessage::PlaceRoad(place) => {
            let from_id = world.road_node_at(place.from);
            let to_id = world.road_node_at(place.to);

            world.handle_place_road(place.from, place.to, place.one_way);

            // Insert edges for newly created connections
            let new_from = world.road_node_at(place.from);
            let new_to = world.road_node_at(place.to);
            if let (Some(f), Some(t)) = (new_from, new_to) {
                // Only insert if the road was actually placed (nodes exist now)
                if from_id.is_none() || to_id.is_none() || !world.edges.contains_key(&(f, t)) {
                    world.insert_edge(f, t);
                    if !place.one_way {
                        world.insert_edge(t, f);
                    }
                }
            }
        }
        ClientMessage::PlaceBuilding(place) => {
            if let Some(building_id) = world.handle_place_building(place.pos, place.building_type)
                && place.building_type == BuildingType::CarSpawner {
                    schedule_car_spawn(events, building_id);
                }
        }
        ClientMessage::DemolishRoad(demolish) => {
            handle_road_demolish(world, events, intersections, demolish.pos, now);
        }
        ClientMessage::DespawnAllCars => {
            let car_ids: Vec<EntityId> = world.objects.all_entries()
                .iter()
                .filter(|e| matches!(e.object, GameObject::Car(_)))
                .map(|e| e.id)
                .collect();
            for car_id in car_ids {
                despawn_car_fully(world, intersections, events, car_id);
            }
        }
        ClientMessage::ResetWorld => unreachable!("handled in run()"),
        ClientMessage::Ping => {}
    }
}

fn handle_road_demolish(
    world: &mut World,
    events: &mut EventQueue<GameEvent>,
    intersections: &mut IntersectionRegistry,
    pos: crate::protocol::GridCoord,
    now: GameTime,
) {
    let node_id = match world.road_node_at(pos) {
        Some(id) => id,
        None => return,
    };

    // Snapshot affected cars before removing anything
    let affected_car_ids: Vec<EntityId> = world.node_cars.get(&node_id).cloned().unwrap_or_default().into_iter().collect();
    let car_entries: Vec<(EntityId, Vec<EntityId>, usize, EntityId)> = affected_car_ids
        .iter()
        .filter_map(|&car_id| {
            let entry = world.objects.get(car_id)?;
            if let GameObject::Car(ref car) = entry.object {
                let dest = *car.route.last()?;
                Some((car_id, car.route.clone(), car.route_index, dest))
            } else {
                None
            }
        })
        .collect();

    // Fully remove the node and update the graph BEFORE rerouting
    intersections.remove_node(node_id);
    let removed_edges = world.edges_involving(node_id);
    for &edge in &removed_edges {
        world.remove_edge(edge.0, edge.1);
    }
    world.handle_demolish_road(pos);

    // Now reroute — pathfinder sees the correct graph
    for (car_id, route, ri, dest) in car_entries {
        let from_node = if route[ri] == node_id {
            route[ri - 1]
        } else {
            route[ri]
        };

        if try_reroute(world, intersections, events, car_id, from_node, dest, ri, now) {
            continue;
        }

        // Original destination unreachable — try any other car spawner
        let alt_dest = world.all_car_spawners().into_iter()
            .filter_map(|(bid, _)| world.road_node_for_building(bid))
            .find(|&n| n != from_node && n != dest);

        if let Some(alt) = alt_dest {
            if try_reroute(world, intersections, events, car_id, from_node, alt, ri, now) {
                continue;
            }
        }

        despawn_car_fully(world, intersections, events, car_id);
    }
}

fn try_reroute(
    world: &mut World,
    intersections: &mut IntersectionRegistry,
    events: &mut EventQueue<GameEvent>,
    car_id: EntityId,
    from_node: EntityId,
    dest: EntityId,
    ri: usize,
    now: GameTime,
) -> bool {
    let new_route = match pathfinding::find_path(world, from_node, dest) {
        Some(r) if r.len() >= 2 => r,
        _ => return false,
    };

    let old_route = match world.objects.get(car_id) {
        Some(e) => match &e.object {
            GameObject::Car(car) => car.route.clone(),
            _ => return false,
        },
        None => return false,
    };

    // Clean up old state (mirror despawn_car's edge cleanup)
    world.unregister_car_route(car_id, &old_route);
    if ri >= 1 {
        let old_edge = (old_route[ri - 1], old_route[ri]);
        if let Some(seg) = world.edges.get_mut(&old_edge) {
            seg.cars.retain(|&id| id != car_id);
        }
    }
    if ri + 1 < old_route.len() {
        let next_edge = (old_route[ri], old_route[ri + 1]);
        if let Some(seg) = world.edges.get_mut(&next_edge) {
            seg.cars.retain(|&id| id != car_id);
        }
    }
    let woken = intersections.remove_car_from_all(car_id);
    for (_node, woken_id) in woken {
        events.schedule(0, GameEvent::CarWakeUp { car_id: woken_id }, Some(woken_id));
    }

    // Set up new route
    world.register_car_route(car_id, &new_route);
    let segment_lengths = world.compute_segment_lengths(&new_route);
    let total: f64 = segment_lengths.iter().sum();

    if let Some(entry) = world.objects.get_mut(car_id)
        && let GameObject::Car(ref mut car) = entry.object
    {
        car.route = new_route;
        car.segment_lengths = segment_lengths;
        car.total_route_length = total;
        car.route_index = 1;
        car.progress = 0.0;
        car.speed = 0.0;
        car.acceleration = ACCELERATION;
        car.updated_at = now;
        car.seg_start_dist = 0.0;
        car.seg_fraction = 0.0;
        car.seg_length = car.segment_lengths[1];
    }

    // Register on first edge and wake up
    let first_edge = world.objects.get(car_id).and_then(|e| {
        if let GameObject::Car(ref car) = e.object {
            Some((car.route[0], car.route[1]))
        } else { None }
    });
    if let Some(edge) = first_edge {
        if let Some(seg) = world.edges.get_mut(&edge) {
            if !seg.cars.contains(&car_id) {
                seg.cars.push_back(car_id);
            }
        }
    }
    events.schedule(0, GameEvent::CarWakeUp { car_id }, Some(car_id));
    true
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
        broadcast(clients, &ServerMessage::Update(StateUpdate { ops, server_time: now }));
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
