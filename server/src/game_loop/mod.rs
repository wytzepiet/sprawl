use std::collections::{HashMap, HashSet};
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
use crate::protocol::{BuildingKind, Category, ChunkBounds, ChunkCoord, ClientMessage, Clock, DAY_MS, EntityId, GameObject, GameObjectEntry, Operation, OwnerId, ServerMessage, StateUpdate};
use crate::world::chunk_of;
use crate::world::World;
use crate::protocol::GridCoord;
use crate::world::pathfinding;

struct ClientState {
    /// Who is playing. Several sockets can share one, and drafts belong to it
    /// rather than to any one connection.
    owner: OwnerId,
    sender: mpsc::UnboundedSender<ServerMessage>,
    subscribed: Option<ChunkBounds>,
    known: HashSet<EntityId>,
    known_chunks: HashSet<ChunkCoord>,
}

fn db_path() -> PathBuf {
    std::env::var("SPRAWL_DB").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("sprawl.db"))
}
const PERSIST_INTERVAL: Duration = Duration::from_secs(1);
/// How long an abandoned draft holds its land. Long enough that a reload or a
/// dropped connection does not cost you the work; short enough that walking
/// away does not freeze the ground for everyone else.
const DRAFT_GRACE: Duration = Duration::from_secs(120);
/// Simulated milliseconds per step. Fixed: speed adds steps rather than making
/// them longer, so running fast cannot change what the simulation does.
const STEP_MS: GameTime = 10;
/// Guards against a speed that would peg the loop and stall the socket.
const MAX_SPEED: u32 = 50;
/// Until zoning exists, the starting network gets a spread of categories so
/// there is somewhere to drive to and from.
const STARTING_MIX: [Category; 3] = [Category::Residential, Category::Commercial, Category::Industrial];

pub async fn run(mut commands: mpsc::UnboundedReceiver<Command>) {
    let db_path = db_path();
    let (mut world, mut sim_time) = load_world(&db_path);
    let mut events: EventQueue<GameEvent> = EventQueue::new();
    let mut intersections = IntersectionRegistry::new();
    let mut clients: HashMap<ClientId, ClientState> = HashMap::new();
    // Owners with no socket, and when their drafts run out of time.
    let mut abandoned: HashMap<OwnerId, Instant> = HashMap::new();

    // Terrain is derived from the seed, so it is regenerated on every start
    // rather than persisted. A fresh world also gets its roads laid out.
    let fresh = world.objects.all_entries().is_empty();
    if fresh {
        world.terrain_seed = rand::random::<u32>();
    }
    world.terrain = crate::terrain::generate(world.terrain_seed);
    println!("terrain: {} tiles from seed {}", world.terrain.len(), world.terrain_seed);

    if fresh {
        let seed = world.terrain_seed;
        let terrain = world.terrain.clone();
        let anchors = crate::road_gen::generate(&mut world, seed, &terrain);
        for (i, pos) in anchors.into_iter().enumerate() {
            seed_building(&mut world, pos, STARTING_MIX[i % STARTING_MIX.len()]);
        }
    }

    // Rebuild edges/indices and schedule car spawns for loaded buildings
    if !world.objects.all_entries().is_empty() {
        world.rebuild_edges();
        world.rebuild_node_cars();
        world.rebuild_occupied();
        world.rebuild_revealed();
        for entry in world.objects.all_entries() {
            if matches!(entry.object, GameObject::Building(_)) {
                schedule_car_spawn(&mut events, entry.id);
            }
        }
        println!("loaded {} objects from db", world.objects.all_entries().len());
    }

    let mut tick_interval = interval(Duration::from_millis(STEP_MS));
    let mut last_persist = Instant::now();
    let mut speed: u32 = 1;

    loop {
        tick_interval.tick().await;
        let mut now: GameTime = sim_time;

        while let Ok(cmd) = commands.try_recv() {
            match cmd {
                Command::PlayerAction { client_id, message } => {
                    if let ClientMessage::Ping = &message {
                        if let Some(cs) = clients.get(&client_id) {
                            let _ = cs.sender.send(ServerMessage::Pong(now));
                        }
                        continue;
                    }
                    if let ClientMessage::SetSpeed(s) = &message {
                        speed = (*s).min(MAX_SPEED);
                        println!("speed: {speed} steps/tick");
                        // Paused, nothing goes dirty and no update would ever be
                        // sent — so clients would keep extrapolating cars against
                        // a stopped world. Push the new clock instead of waiting.
                        let clk = clock(now, speed);
                        for cs in clients.values() {
                            let _ = cs.sender.send(state_update(&world, vec![], clk));
                        }
                        continue;
                    }
                    if let ClientMessage::SetChunks(bounds) = &message {
                        handle_set_chunks(&world, &mut clients, client_id, *bounds, clock(now, speed));
                    } else if let ClientMessage::ResetWorld = &message {
                        // Send deletes for each client's known set, then clear.
                        // Terrain is regenerated below, so drop the known chunks
                        // too or the client keeps the old seed's tiles.
                        for cs in clients.values_mut() {
                            let ops: Vec<Operation> = cs.known.drain().map(Operation::Delete).collect();
                            if !ops.is_empty() {
                                let _ = cs.sender.send(state_update(&world, ops, clock(now, speed)));
                            }
                            for coord in cs.known_chunks.drain() {
                                let _ = cs.sender.send(ServerMessage::UnloadChunk(coord));
                            }
                        }
                        world = World::new();
                        events = EventQueue::new();
                        intersections = IntersectionRegistry::new();
                        let _ = std::fs::remove_file(&db_path);
                        let seed = rand::random::<u32>();
                        world.terrain_seed = seed;
                        world.terrain = crate::terrain::generate(seed);
                        let terrain = world.terrain.clone();
                        let anchors = crate::road_gen::generate(&mut world, seed, &terrain);
                        for (i, pos) in anchors.into_iter().enumerate() {
                            seed_building(&mut world, pos, STARTING_MIX[i % STARTING_MIX.len()]);
                        }
                        world.newly_revealed.clear();
                        // Re-send subscribed chunks for all connected clients
                        let subs: Vec<_> = clients.iter()
                            .filter_map(|(id, cs)| cs.subscribed.map(|b| (*id, b)))
                            .collect();
                        for (cid, bounds) in subs {
                            handle_set_chunks(&world, &mut clients, cid, bounds, clock(now, speed));
                        }
                        println!("reset: world cleared, terrain regenerated");
                    } else {
                        world.acting_as = clients.get(&client_id).map(|c| c.owner);
                        handle_player_action(&mut world, &mut events, &mut intersections, message, now);
                        world.acting_as = None;
                    }
                }
                Command::ClientConnect { id, owner, sender } => {
                    // Back before the drafts expired: the land is still theirs.
                    abandoned.remove(&owner);
                    let _ = sender.send(ServerMessage::Welcome(owner));
                    // Send empty update with terrain_seed; objects come via SetViewport
                    let _ = sender.send(state_update(&world, vec![], clock(now, speed)));
                    clients.insert(id, ClientState {
                        owner,
                        sender,
                        subscribed: None,
                        known_chunks: HashSet::new(),
                        known: HashSet::new(),
                    });
                }
                Command::ClientDisconnect { id } => {
                    let Some(gone) = clients.remove(&id) else { continue };
                    // An abandoned draft is a land claim, so it cannot be held
                    // forever -- but a reload should not cost you the work
                    // either, and identity outlives the socket, so the claim is
                    // given a while to be reclaimed. Another tab of the same
                    // player still being open means it never lapsed at all.
                    if !clients.values().any(|c| c.owner == gone.owner) {
                        abandoned.insert(gone.owner, Instant::now() + DRAFT_GRACE);
                    }
                }
            }
        }

        // Claims nobody came back for.
        if !abandoned.is_empty() {
            let lapsed = Instant::now();
            abandoned.retain(|&owner, &mut deadline| {
                if deadline > lapsed {
                    return true;
                }
                world.discard_drafts(owner);
                false
            });
        }

        // One step per unit of speed, each the same length as at speed 1, so a
        // fast-forwarded hour is the same hour — just less wall time spent on it.
        for _ in 0..speed {
            now += STEP_MS;
            events.set_now(now);
            while let Some(scheduled) = events.pop_due() {
                handle_game_event(&mut world, &mut events, &mut intersections, scheduled.event, now);
            }
        }
        sim_time = now;

        flush_dirty(&mut world, &mut clients, clock(now, speed));

        if last_persist.elapsed() >= PERSIST_INTERVAL {
            persist(&mut world, &db_path, sim_time);
            last_persist = Instant::now();
        }
    }
}

/// Put a starting building on a free tile beside a road node, facing it.
fn seed_building(world: &mut World, road: GridCoord, category: Category) {
    // All eight, not just the four: beside a diagonal street the only legal
    // driveway is itself diagonal, so the orthogonal offsets are dead ends.
    const AROUND: [(i32, i32); 8] =
        [(0, 1), (1, 0), (0, -1), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1)];
    for (dx, dy) in AROUND {
        let pos = GridCoord { x: road.x + dx, y: road.y + dy };
        if !world.is_buildable(pos) {
            continue;
        }
        let Some((node, _)) = world.road_for_plot(pos, (1, 1)) else {
            continue;
        };
        let rotation = world.rotation_toward(pos, (1, 1), node);
        let kind = BuildingKind::for_plot(category, 1);
        if world.spawn_building(pos, kind, (1, 1), rotation).is_some() {
            return;
        }
    }
}

fn clock(now: GameTime, speed: u32) -> Clock {
    Clock { now, speed, day_ms: DAY_MS }
}

/// Every update carries the ambient world state alongside its ops, so a client
/// never has to ask for the seed or the surveyed extent separately.
fn state_update(world: &World, ops: Vec<Operation>, clk: Clock) -> ServerMessage {
    ServerMessage::Update(StateUpdate {
        ops,
        clock: clk,
        terrain_seed: world.terrain_seed,
        revealed_bounds: world.revealed_bounds,
    })
}

fn load_world(db_path: &Path) -> (World, GameTime) {
    let (entries, next_id, terrain_seed, sim_time) = persistence::load(db_path);
    let world = if entries.is_empty() {
        World::new()
    } else {
        World::from_loaded(Tracked::load(entries, next_id), terrain_seed)
    };
    (world, sim_time)
}

fn persist(world: &mut World, db_path: &Path, sim_time: GameTime) {
    let (changed_ids, removed_ids) = world.objects.drain_persist_dirty();
    if changed_ids.is_empty() && removed_ids.is_empty() {
        return;
    }

    // Drafts are not part of the world yet, so they are not part of the save.
    let changed: Vec<_> = changed_ids
        .iter()
        .filter_map(|id| world.objects.get(*id))
        .filter(|e| e.draft.is_none())
        .cloned()
        .collect();

    persistence::save(db_path, &changed, &removed_ids, world.objects.next_id(), world.terrain_seed, sim_time);
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
            if let Some((road, _)) = world.road_for_plot(place.pos, (1, 1)) {
                let rotation = world.rotation_toward(place.pos, (1, 1), road);
                if let Some(id) = world.spawn_building(place.pos, place.kind, (1, 1), rotation) {
                    schedule_car_spawn(events, id);
                }
            }
        }
        ClientMessage::PaintArea(paint) => {
            for id in world.paint_area(&paint.tiles, paint.category) {
                schedule_car_spawn(events, id);
            }
        }
        ClientMessage::DemolishRoad(demolish) => {
            // Which of the two things this does follows from what was clicked,
            // not from a parameter: erasing something you just drew removes it,
            // erasing something real stages it for the commit.
            let pos = demolish.pos;
            let target = world
                .any_road_node_at(pos)
                .or_else(|| world.occupied.get(&(pos.x, pos.y)).copied());
            let Some(id) = target else { return };
            if !world.erase_draft(id) && world.draft_of(id).is_none() {
                world.draft_remove(id);
            }
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
        ClientMessage::Commit => {
            let Some(owner) = world.acting_as else { return };
            let committed = world.commit_drafts(owner);
            for id in committed.added {
                if matches!(world.objects.get(id).map(|e| &e.object), Some(GameObject::Building(_))) {
                    schedule_car_spawn(events, id);
                }
            }
            // Demolition last: it has to see the network as the commit left it,
            // and it despawns the cars that were using what is going away.
            for id in committed.removed {
                let Some(pos) = world.objects.get(id).and_then(|e| e.position) else { continue };
                match world.objects.get(id).map(|e| &e.object) {
                    Some(GameObject::RoadNode(_)) => {
                        handle_road_demolish(world, events, intersections, pos, now)
                    }
                    Some(GameObject::Building(_)) => world.remove_building(id),
                    _ => {}
                }
            }
        }
        ClientMessage::Discard => {
            if let Some(owner) = world.acting_as {
                world.discard_drafts(owner);
            }
        }
        ClientMessage::SetSpeed(_) => unreachable!("handled in run()"),
        ClientMessage::ResetWorld => unreachable!("handled in run()"),
        ClientMessage::SetChunks(_) => unreachable!("handled in run()"),
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
    let node_id = match world.any_road_node_at(pos) {
        Some(id) => id,
        None => return,
    };

    // Collect neighbor IDs before removing anything (to check for orphans later)
    let neighbor_ids: Vec<EntityId> = match world.objects.get(node_id) {
        Some(entry) => if let GameObject::RoadNode(ref node) = entry.object {
            node.outgoing.iter().chain(node.incoming.iter()).copied().collect()
        } else { vec![] },
        None => vec![],
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
        let alt_dest = world.all_buildings().into_iter()
            .filter_map(|(bid, _)| world.road_node_for_building(bid))
            .find(|&n| n != from_node && n != dest);

        if let Some(alt) = alt_dest
            && try_reroute(world, intersections, events, car_id, from_node, alt, ri, now) {
                continue;
            }

        despawn_car_fully(world, intersections, events, car_id);
    }

    // Clean up neighbors left with 0 connections
    for nid in neighbor_ids {
        let is_orphan = match world.objects.get(nid) {
            Some(entry) => if let GameObject::RoadNode(ref node) = entry.object {
                node.outgoing.is_empty() && node.incoming.is_empty()
            } else { false },
            None => false,
        };
        if is_orphan {
            if let Some(pos) = world.objects.get(nid).and_then(|e| e.position) {
                // Despawn any cars registered on this orphan
                let orphan_cars: Vec<EntityId> = world.node_cars.get(&nid).cloned().unwrap_or_default().into_iter().collect();
                for car_id in orphan_cars {
                    despawn_car_fully(world, intersections, events, car_id);
                }
                intersections.remove_node(nid);
                world.objects.remove(nid);
                world.unindex(nid, pos);
            }
        }
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
    let route_positions = world.route_positions(&new_route);

    if let Some(pos) = world.objects.get(new_route[0]).and_then(|e| e.position) {
        world.update_position(car_id, pos);
    }

    if let Some(entry) = world.objects.get_mut(car_id)
        && let GameObject::Car(ref mut car) = entry.object
    {
        car.route = new_route;
        car.route_positions = route_positions;
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
    if let Some(edge) = first_edge
        && let Some(seg) = world.edges.get_mut(&edge)
            && !seg.cars.contains(&car_id) {
                seg.cars.push_back(car_id);
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

/// Reconcile a client's subscription. Chunk-granular, so panning within a
/// chunk produces no work at all — which is why there is no throttle.
fn handle_set_chunks(
    world: &World,
    clients: &mut HashMap<ClientId, ClientState>,
    client_id: ClientId,
    bounds: ChunkBounds,
    clk: Clock,
) {
    let visible_chunks: HashSet<ChunkCoord> = bounds.coords().collect();
    let in_view = world.entities_in_chunks(&visible_chunks);

    let cs = match clients.get_mut(&client_id) {
        Some(cs) => cs,
        None => return,
    };
    cs.subscribed = Some(bounds);

    // Terrain travels per chunk, so only the chunks that just came into view
    // are sent, and panning inside a chunk sends nothing at all. Unrevealed
    // chunks are withheld entirely — that withholding is the fog.
    for &coord in visible_chunks.iter() {
        if world.revealed.contains(&coord) && cs.known_chunks.insert(coord) {
            let _ = cs.sender.send(ServerMessage::TerrainChunk(world.terrain_chunk(coord)));
        }
    }
    let dropped: Vec<ChunkCoord> = cs.known_chunks
        .iter()
        .filter(|c| !visible_chunks.contains(c))
        .copied()
        .collect();
    for coord in dropped {
        cs.known_chunks.remove(&coord);
        let _ = cs.sender.send(ServerMessage::UnloadChunk(coord));
    }

    // Enter: in view but not known
    let mut ops = Vec::new();
    for &id in &in_view {
        if !cs.known.contains(&id)
            && let Some(entry) = world.objects.get(id) {
                ops.push(Operation::Upsert(Box::new(entry.clone())));
            }
    }

    // Exit: known but no longer in view
    let exits: Vec<EntityId> = cs.known.iter()
        .filter(|id| !in_view.contains(id))
        .copied()
        .collect();
    for id in &exits {
        ops.push(Operation::Delete(*id));
    }

    cs.known = in_view;

    if !ops.is_empty() {
        let _ = cs.sender.send(state_update(world, ops, clk));
    }
}

fn flush_dirty(
    world: &mut World,
    clients: &mut HashMap<ClientId, ClientState>,
    clk: Clock,
) {
    let (changed, removed) = world.objects.drain_dirty();
    let crossings: Vec<(EntityId, ChunkCoord, ChunkCoord)> =
        std::mem::take(&mut world.chunk_crossings)
            .into_iter()
            .filter(|(id, ..)| !removed.contains(id))
            .collect();
    let newly_revealed = std::mem::take(&mut world.newly_revealed);

    if changed.is_empty() && removed.is_empty() && crossings.is_empty() && newly_revealed.is_empty()
    {
        return;
    }

    // A building can reveal ground someone is already looking at, and nothing
    // about their subscription changed — so the terrain has to be pushed.
    for cs in clients.values_mut() {
        let Some(bounds) = cs.subscribed else { continue };
        for &coord in &newly_revealed {
            if bounds.contains(coord) && cs.known_chunks.insert(coord) {
                let _ = cs.sender.send(ServerMessage::TerrainChunk(world.terrain_chunk(coord)));
            }
        }
    }

    // Group by chunk so a client walks the chunks it subscribes to rather than
    // every entity that changed. A client sees a handful of chunks; the world
    // can have hundreds of moving cars.
    let mut by_chunk: HashMap<ChunkCoord, Vec<GameObjectEntry>> = HashMap::new();
    for id in &changed {
        if let Some(entry) = world.objects.get(*id)
            && let Some(pos) = entry.position
        {
            by_chunk.entry(chunk_of(pos)).or_default().push(entry.clone());
        }
    }

    for cs in clients.values_mut() {
        if cs.subscribed.is_none() {
            continue;
        }

        let mut ops = Vec::new();

        for coord in &cs.known_chunks {
            for entry in by_chunk.get(coord).into_iter().flatten() {
                cs.known.insert(entry.id);
                ops.push(Operation::Upsert(Box::new(entry.clone())));
            }
        }

        // A crossing is the only way an entity leaves a view without being
        // deleted, and the only way one enters without being dirty.
        for &(id, from, to) in &crossings {
            let had = cs.known_chunks.contains(&from);
            let has = cs.known_chunks.contains(&to);
            if had && !has {
                if cs.known.remove(&id) {
                    ops.push(Operation::Delete(id));
                }
            } else if has && !had && !cs.known.contains(&id)
                && let Some(entry) = world.objects.get(id)
            {
                cs.known.insert(id);
                ops.push(Operation::Upsert(Box::new(entry.clone())));
            }
        }

        for id in &removed {
            if cs.known.remove(id) {
                ops.push(Operation::Delete(*id));
            }
        }

        if !ops.is_empty() {
            let _ = cs.sender.send(state_update(world, ops, clk));
        }
    }
}

