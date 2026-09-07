use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;
use tokio::time::{Instant, interval, Duration};

use crate::car::simulation::{handle_car_wake_up, park_at_home};
use crate::car::ACCELERATION;
use crate::resident::handle_resident_wake;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::engine::tracked::Tracked;
use crate::intersection::IntersectionRegistry;
use crate::network::{ClientId, Command};
use crate::persistence;
use crate::protocol::{BuildingKind, ChunkBounds, ChunkCoord, ClientMessage, Clock, DAY_MS, EntityId, GameObject, GameObjectEntry, Operation, OwnerId, ServerMessage, StateUpdate};
use crate::world::chunk_of;
use crate::world::World;
use crate::protocol::GridCoord;
use crate::world::pathfinding;

struct ClientState {
    /// Who is playing. Several sockets can share one.
    owner: OwnerId,
    sender: mpsc::UnboundedSender<ServerMessage>,
    subscribed: Option<ChunkBounds>,
    known: HashSet<EntityId>,
    known_chunks: HashSet<ChunkCoord>,
}

fn db_path() -> PathBuf {
    std::env::var("SPRAWL_DB").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("sprawl.db"))
}

/// The seed a fresh world gets. Set SPRAWL_SEED to get the same map back every
/// time — the point of a test world is that what you saw yesterday is still
/// there today, so a change in behaviour is a change in the code.
fn new_seed() -> u32 {
    std::env::var("SPRAWL_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(rand::random::<u32>)
}
const PERSIST_INTERVAL: Duration = Duration::from_secs(1);
/// How far one tick may overrun before the loop says so: a quarter of a
/// second is twenty-five ticks of lag, well past anything a debug build
/// takes for one, and short enough to be seen the moment it starts.
const BEHIND: Duration = Duration::from_millis(250);
/// Simulated milliseconds per step. Fixed: speed adds steps rather than making
/// them longer, so running fast cannot change what the simulation does.
const STEP_MS: GameTime = 10;
/// Guards against a speed that would peg the loop and stall the socket.
const MAX_SPEED: u32 = 50;
/// The starting network gets a spread of kinds so there is somewhere to
/// drive to and from, and something for the spawner to grow beside.
const STARTING_MIX: [BuildingKind; 3] = [BuildingKind::House, BuildingKind::Shop, BuildingKind::Workshop];

pub async fn run(mut commands: mpsc::UnboundedReceiver<Command>) {
    let db_path = db_path();
    let (mut world, mut sim_time) = load_world(&db_path);
    let mut events: EventQueue = EventQueue::new();
    let mut intersections = IntersectionRegistry::new();
    let mut clients: HashMap<ClientId, ClientState> = HashMap::new();

    // Terrain is derived from the seed, so it is regenerated on every start
    // rather than persisted. A fresh world also gets its roads laid out.
    let fresh = world.objects.all_entries().is_empty();
    if fresh {
        world.terrain_seed = new_seed();
    }
    world.terrain = crate::terrain::generate(world.terrain_seed);
    println!("terrain: {} tiles from seed {}", world.terrain.len(), world.terrain_seed);

    if fresh {
        let seed = world.terrain_seed;
        let terrain = world.terrain.clone();
        if let Some(anchor) = crate::road_gen::generate(&mut world, seed, &terrain) {
            crate::road_gen::start_town(&mut world, &terrain, anchor, &STARTING_MIX);
        }
    }

    // Rebuild edges/indices and schedule car spawns for loaded buildings
    if !world.objects.all_entries().is_empty() {
        world.rebuild_revealed();
        world.rebuild_edges();
        world.rebuild_node_cars();
        world.rebuild_occupied();
        world.restore_spots();
        world.rebuild_roads_generated();
        world.rebuild_laid();
        // A saved world may have been revealed further than its roads reach,
        // if it was saved before this existed.
        let terrain = world.terrain.clone();
        let (seed, bounds) = (world.terrain_seed, world.revealed_bounds);
        crate::road_gen::extend_to(&mut world, seed, &terrain, bounds);
        println!("loaded {} objects from db", world.objects.all_entries().len());
    }
    // Whatever is standing gets its people, whether it was just laid out or
    // loaded from a save written before anyone lived here. Then everyone
    // thinks once — trips do not survive a save, so a loaded world is
    // entirely people standing still until they do.
    world.settle();
    for id in world.resident_ids() {
        wake_resident(&world, &mut events, id);
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
                        let seed = new_seed();
                        world.terrain_seed = seed;
                        world.terrain = crate::terrain::generate(seed);
                        let terrain = world.terrain.clone();
                        if let Some(anchor) = crate::road_gen::generate(&mut world, seed, &terrain) {
                            crate::road_gen::start_town(&mut world, &terrain, anchor, &STARTING_MIX);
                        }
                        settle_and_wake(&mut world, &mut events);
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
                        handle_player_action(&mut world, &mut events, &mut intersections, message, now);
                    }
                }
                Command::ClientConnect { id, owner, sender } => {
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
                Command::Inspect { query, reply } => {
                    use crate::network::Ask;
                    let v = match query {
                        Ask::Resident(id) => crate::resident::inspect(&world, id, now),
                        Ask::Residents => crate::resident::inspect_all(&world, now),
                        Ask::Demand => crate::resident::demand(&world, now),
                        Ask::Spawner => crate::spawner::inspect(&world, now),
                    };
                    let _ = reply.send(serde_json::to_string_pretty(&v).unwrap_or_default());
                }
                Command::ClientDisconnect { id } => {
                    clients.remove(&id);
                }
            }
        }

        // One step per unit of speed, each the same length as at speed 1, so a
        // fast-forwarded hour is the same hour — just less wall time spent on it.
        let started = Instant::now();
        let mut wakes = 0u32;
        for _ in 0..speed {
            now += STEP_MS;
            events.set_now(now);
            while let Some(id) = events.pop_due() {
                handle_wake(&mut world, &mut events, &mut intersections, id, now);
                wakes += 1;
            }
        }
        // A tick that overruns is the clock falling behind the wall, and every
        // command queued behind it. Said out loud the moment it happens, so a
        // wake storm shows in the log rather than in the fan.
        let took = started.elapsed();
        if took >= BEHIND {
            eprintln!("behind: {wakes} wakes took {} ms at speed {speed}", took.as_millis());
        }
        // The city offers a building once it has earned one, while the mayor
        // has room to answer. Cheap to ask — it is a subtraction until the
        // meter is actually full.
        // A building that lands beside a road is lived in at once.
        if crate::spawner::spawn(&mut world, now).is_some() {
            settle_and_wake(&mut world, &mut events);
        }
        sim_time = now;
        // Published for /health, which is how anything outside this loop can
        // tell the difference between a live world and a socket that outlived
        // it.
        crate::health::SIM_TIME.store(sim_time, std::sync::atomic::Ordering::Relaxed);

        // Road follows the survey outward, so there is always a way in from
        // beyond the frontier. Laid in the same tick as the survey grew, before
        // anything is flushed, so the network is never seen cut off from the
        // world in between. Only new chunks cost anything: extend_to skips
        // whatever it has already laid.
        if !world.newly_revealed.is_empty() {
            let terrain = world.terrain.clone();
            let (seed, bounds) = (world.terrain_seed, world.revealed_bounds);
            crate::road_gen::extend_to(&mut world, seed, &terrain, bounds);
        }

        flush_dirty(&mut world, &mut clients, clock(now, speed));

        if last_persist.elapsed() >= PERSIST_INTERVAL {
            persist(&mut world, &db_path, sim_time);
            last_persist = Instant::now();
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
        growth: crate::spawner::growth(world, clk.now),
        terrain_seed: world.terrain_seed,
        revealed_bounds: world.revealed_bounds,
    })
}

fn load_world(db_path: &Path) -> (World, GameTime) {
    let (entries, meta) = persistence::load(db_path);
    let mut world = if entries.is_empty() {
        World::new()
    } else {
        World::from_loaded(Tracked::load(entries, meta.next_id), meta.terrain_seed)
    };
    // What the city has produced outlives a restart; what it was about to offer
    // is drawn again, since it depends on demand as it stands now.
    world.xp = crate::xp::Ledger::load(meta.earned, meta.sim_time);
    world.offered_at = meta.offered_at;
    world.build = crate::tree::Build::load(meta.taken);
    (world, meta.sim_time)
}

fn persist(world: &mut World, db_path: &Path, sim_time: GameTime) {
    let (changed_ids, removed_ids) = world.objects.drain_persist_dirty();
    if changed_ids.is_empty() && removed_ids.is_empty() {
        return;
    }

    let changed: Vec<_> = changed_ids
        .iter()
        .filter_map(|id| world.objects.get(*id))
        .cloned()
        .collect();

    persistence::save(
        db_path,
        &changed,
        &removed_ids,
        persistence::Meta {
            next_id: world.objects.next_id(),
            terrain_seed: world.terrain_seed,
            sim_time,
            earned: world.xp.at(sim_time),
            offered_at: world.offered_at,
            taken: world.build.taken(),
        },
    );
    println!("persisted {} changed, {} removed", changed.len(), removed_ids.len());
}

fn handle_player_action(
    world: &mut World,
    events: &mut EventQueue,
    intersections: &mut IntersectionRegistry,
    message: ClientMessage,
    now: GameTime,
) {
    match message {
        ClientMessage::PlaceRoad(place) => {
            let from_id = world.road_node_at(place.from);
            let to_id = world.road_node_at(place.to);

            // The build is the gate: what kinds of road, and how much of it.
            // Each end that is not standing yet is a tile laid.
            let new_tiles = from_id.is_none() as u32 + to_id.is_none() as u32;
            if !world.build.may_draw(place.one_way, place.road) || world.laid + new_tiles > world.build.road_tiles() {
                return;
            }
            world.handle_place_road(place.from, place.to, place.one_way, place.road, now);

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
            // Anywhere the land allows: a plot with no street yet stands red
            // until the mayor draws one to it, which is the mayor's to do.
            let size = crate::blueprint::blueprint(place.kind).size;
            let placed = world.build.may_place(place.kind).then(|| world.place_building(place.pos, place.kind, size)).flatten();
            match placed {
                Some(id) => {
                    world.attach_driveway(id);
                    settle_and_wake(world, events);
                }
                // Said out loud: a click that does nothing is the kind of
                // bug that otherwise takes an afternoon to find.
                None => println!(
                    "place refused: {:?} at {:?}: allowed {}, land {}",
                    place.kind,
                    place.pos,
                    world.build.may_place(place.kind),
                    World::footprint(place.pos, size).all(|t| world.is_buildable(t))
                ),
            }
        }
        ClientMessage::DemolishRoad(demolish) => {
            // What goes follows from what was clicked: a road, or the building
            // standing there. Either way the population is settled against
            // what is left.
            let pos = demolish.pos;
            if let Some(id) = world.road_node_at(pos) {
                handle_road_demolish(world, events, intersections, id, now);
            } else if let Some(id) = world.occupied.get(&(pos.x, pos.y)).copied() {
                world.remove_building(id);
            } else {
                return;
            }
            settle_and_wake(world, events);
        }
        ClientMessage::DespawnAllCars => {
            let car_ids: Vec<EntityId> = world.objects.all_entries()
                .iter()
                .filter(|e| matches!(e.object, GameObject::Car(ref c) if c.trip.is_some()))
                .map(|e| e.id)
                .collect();
            for car_id in car_ids {
                park_at_home(world, intersections, events, car_id);
            }
        }
        ClientMessage::Take(cell) => {
            let (level, _) = crate::spawner::level(world.xp.at(now));
            world.build.take(cell, level);
        }
        ClientMessage::SetSpeed(_) => unreachable!("handled in run()"),
        ClientMessage::ResetWorld => unreachable!("handled in run()"),
        ClientMessage::SetChunks(_) => unreachable!("handled in run()"),
        ClientMessage::Ping => {}
    }
}

/// Take a road out of the world, rerouting or despawning whatever was on it.
///
/// By id rather than by tile: while a new road crosses one being demolished the
/// tile holds a node for each world, and only one of them is going.
fn handle_road_demolish(
    world: &mut World,
    events: &mut EventQueue,
    intersections: &mut IntersectionRegistry,
    node_id: EntityId,
    now: GameTime,
) {

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
                let trip = car.trip.as_ref()?;
                Some((car_id, trip.route.clone(), trip.route_index, trip.destination))
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
    world.demolish_node(node_id);

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

        // Destination unreachable: the trip dies here, and the car goes home
        // with its driver to think again.
        park_at_home(world, intersections, events, car_id);
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
            // Any car routed over this orphan has nowhere left to drive
            let orphan_cars: Vec<EntityId> = world.node_cars.get(&nid).cloned().unwrap_or_default().into_iter().collect();
            for car_id in orphan_cars {
                park_at_home(world, intersections, events, car_id);
            }
            intersections.remove_node(nid);
            world.demolish_node(nid);
        }
    }
}

fn try_reroute(
    world: &mut World,
    intersections: &mut IntersectionRegistry,
    events: &mut EventQueue,
    car_id: EntityId,
    from_node: EntityId,
    dest: EntityId,
    ri: usize,
    now: GameTime,
) -> bool {
    let Some(to_node) = world.road_node_for_building(dest) else { return false };
    let path = match pathfinding::find_path(world, from_node, to_node) {
        Some(r) if r.len() >= 2 => r,
        _ => return false,
    };
    // The spot it was heading for is still its own.
    let Some(way_in) = world.way_in(dest, car_id) else { return false };
    let to_lot = way_in.len() - 1;
    let new_route: Vec<EntityId> = path.into_iter().chain(way_in[1..].iter().copied()).collect();

    let old_route = match world.objects.get(car_id) {
        Some(e) => match &e.object {
            GameObject::Car(car) => match car.trip {
                Some(ref t) => t.route.clone(),
                None => return false,
            },
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
        events.wake(0, woken_id);
    }

    // Set up new route
    world.register_car_route(car_id, &new_route);
    let segment_lengths = world.compute_segment_lengths(&new_route, 0, to_lot);
    let total: f64 = segment_lengths.iter().sum();
    let route_positions = world.route_positions(&new_route);

    if let Some(pos) = world.objects.get(new_route[0]).and_then(|e| e.position) {
        world.update_position(car_id, pos);
    }

    if let Some(entry) = world.objects.get_mut(car_id)
        && let GameObject::Car(ref mut car) = entry.object
        && let Some(ref mut t) = car.trip
    {
        t.route = new_route;
        t.route_positions = route_positions;
        t.from_lot = 0;
        t.to_lot = to_lot;
        t.segment_lengths = segment_lengths;
        t.total_route_length = total;
        t.route_index = 1;
        t.progress = 0.0;
        t.speed = 0.0;
        t.acceleration = ACCELERATION;
        t.updated_at = now;
        t.seg_start_dist = 0.0;
        t.seg_fraction = 0.0;
        t.seg_length = t.segment_lengths[1];
    }

    // Register on first edge and wake up
    let first_edge = world.objects.get(car_id).and_then(|e| {
        if let GameObject::Car(ref car) = e.object {
            car.trip.as_ref().map(|t| (t.route[0], t.route[1]))
        } else { None }
    });
    if let Some(edge) = first_edge
        && let Some(seg) = world.edges.get_mut(&edge)
            && !seg.cars.contains(&car_id) {
                seg.cars.push_back(car_id);
            }
    events.wake(0, car_id);
    true
}

/// One wake-up, dispatched on what the entity is. A car's decision is
/// physics; a resident's is where to be.
fn handle_wake(
    world: &mut World,
    events: &mut EventQueue,
    intersections: &mut IntersectionRegistry,
    id: EntityId,
    now: GameTime,
) {
    match world.objects.get(id).map(|e| &e.object) {
        Some(GameObject::Car(_)) => handle_car_wake_up(world, events, intersections, id, now),
        Some(GameObject::Resident(_)) => handle_resident_wake(world, events, id, now),
        _ => {}
    }
}

/// Population follows what is standing, and whoever's situation changed gets
/// to think about it.
fn settle_and_wake(world: &mut World, events: &mut EventQueue) {
    world.xp.settle(events.now());
    for id in world.settle() {
        wake_resident(world, events, id);
    }
    world.xp.streams = crate::resident::served(world);
}

/// Someone already here thinks immediately; someone still off-map gets a
/// staggered start, so a freshly zoned block fills in over the next hours
/// rather than arriving as a convoy. The delay is a hash of who they are,
/// not a roll of the dice — settling again cannot reshuffle it, and the
/// earliest pending wake always wins in the queue anyway.
fn wake_resident(world: &World, events: &mut EventQueue, id: EntityId) {
    const TRICKLE_MS: u64 = 3 * (DAY_MS as u64) / 24;
    let off_map = matches!(
        world.objects.get(id).map(|e| &e.object),
        Some(GameObject::Resident(r)) if r.at.is_none()
    );
    let delay = if off_map {
        let mut h = id.wrapping_mul(0x9E37_79B9_7F4A_7C15);
        h ^= h >> 33;
        h % TRICKLE_MS
    } else {
        0
    };
    events.wake(delay, id);
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


#[cfg(test)]
mod tests {
    /// Wakes one resident may take in a day. The full town takes about 30,
    /// the bare one about 58; with the overtake bug of 2026-09-04 put back
    /// they take 146 and 231 in a day, and thousands once the storm has
    /// grown. A change that legitimately moves the count moves this number
    /// with it, on purpose.
    const WAKE_BUDGET: u64 = 120;
    use super::*;
    use crate::protocol::{BuildingKind, TerrainType};

    fn at_of(world: &World, id: EntityId) -> Option<EntityId> {
        match &world.objects.get(id)?.object {
            GameObject::Resident(r) => r.at,
            _ => None,
        }
    }

    fn doing(world: &World, id: EntityId) -> Option<crate::needs::Need> {
        match &world.objects.get(id)?.object {
            GameObject::Resident(r) => r.selected,
            _ => None,
        }
    }

    /// Run the simulation from `from` to `to`, the same way run() does.
    fn pump(
        world: &mut World,
        events: &mut EventQueue,
        intersections: &mut IntersectionRegistry,
        from: GameTime,
        to: GameTime,
    ) {
        let mut now = from;
        while now < to {
            now += STEP_MS;
            events.set_now(now);
            while let Some(id) = events.pop_due() {
                handle_wake(world, events, intersections, id, now);
            }
        }
    }

    /// The whole loop watched from above: people immigrate from past the
    /// frontier, drive to work in the morning, and are home again at night —
    /// and nobody told them to; the shift did.
    /// One long street with room to build beside it. It runs far past what
    /// the buildings will reveal, the way road generation always leaves a way
    /// in from outside: immigrants need somewhere unseen to come from.
    fn street() -> World {
        let mut world = World::new();
        for y in -4..4 {
            for x in -4..170 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        let street: Vec<GridCoord> = (-2..168).map(|x| GridCoord { x, y: 0 }).collect();
        world.place_road_path(&street);
        world
    }

    fn build(world: &mut World, x: i32, kind: BuildingKind, w: u8) -> EntityId {
        world
            .spawn_building(GridCoord { x, y: 1 }, kind, (w, 1))
            .expect("the street should give it a driveway")
    }

    /// A fresh world is not empty land: the survey's anchors each get a
    /// starting building beside the road, and a house among them has
    /// people in it.
    #[test]
    fn a_fresh_world_has_a_starting_town() {
        let mut world = World::new();
        world.terrain_seed = 7;
        world.terrain = crate::terrain::generate(7);
        let terrain = world.terrain.clone();
        let anchor = crate::road_gen::generate(&mut world, 7, &terrain).expect("no anchor near the middle");
        crate::road_gen::start_town(&mut world, &terrain, anchor, &STARTING_MIX);
        assert_eq!(world.all_buildings().len(), STARTING_MIX.len(), "not every starting building was placed");
        eprintln!("anchor {:?}", anchor);
        // The town, drawn: streets as dots, roads as bars, plots as letters.
        for y in (anchor.y - 12)..=(anchor.y + 12) {
            let row: String = ((anchor.x - 16)..=(anchor.x + 16))
                .map(|x| {
                    let t = GridCoord { x, y };
                    if let Some(&b) = world.occupied.get(&(x, y)) {
                        return match world.objects.get(b).map(|e| &e.object) {
                            Some(GameObject::Building(b)) => format!("{:?}", b.kind).chars().next().unwrap(),
                            _ => '?',
                        };
                    }
                    match world.road_node_at(t).map(|id| matches!(world.objects.get(id).map(|e| &e.object), Some(GameObject::RoadNode(n)) if n.road)) {
                        Some(true) => '=',
                        Some(false) => '.',
                        None if t == anchor => '+',
                        None => ' ',
                    }
                })
                .collect();
            eprintln!("{row}");
        }
        // Every junction is one the mayor could have drawn: no two arms at
        // an acute angle.
        for e in world.objects.all_entries() {
            let (GameObject::RoadNode(n), Some(p)) = (&e.object, e.position) else { continue };
            let arms: Vec<(i32, i32)> = n.outgoing.iter().chain(&n.incoming).filter_map(|&a| world.objects.get(a)?.position).map(|q| (q.x - p.x, q.y - p.y)).collect();
            for (i, a) in arms.iter().enumerate() {
                for b in &arms[i + 1..] {
                    assert!(a == b || a.0 * b.0 + a.1 * b.1 <= 0, "acute junction at {:?}: arms {:?} and {:?}", p, a, b);
                }
            }
        }
        world.settle();
        assert!(!world.resident_ids().is_empty(), "nobody moved into the starting town");
    }

    #[test]
    fn residents_commute_and_come_home() {
        let mut world = street();
        let home = build(&mut world, 0, BuildingKind::House, 1);
        let shop = build(&mut world, 20, BuildingKind::Shop, 1);

        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        let people = world.resident_ids();
        assert_eq!(people.len(), 2);

        let shift = crate::blueprint::blueprint(BuildingKind::Shop).taps
            .iter()
            .find(|t| t.need == crate::needs::Need::Work)
            .unwrap();
        let open = shift.curve.next_nonzero(0).unwrap();
        let close = shift.curve.next_zero(open);

        pump(&mut world, &mut events, &mut intersections, 0, open + 60_000);
        for &id in &people {
            assert_eq!(at_of(&world, id), Some(shop), "at work once the shift is on");
        }

        pump(&mut world, &mut events, &mut intersections, open + 60_000, close + 120_000);
        for &id in &people {
            assert_eq!(at_of(&world, id), Some(home), "home once the shift is over");
        }
    }

    /// Shelves run low, a truck comes from beyond the edge, unloads, and
    /// goes: the whole of a call-out with no facility in the city.
    #[test]
    fn a_shop_that_runs_low_is_restocked_from_beyond_the_edge() {
        use crate::calls;
        let mut world = street();
        build(&mut world, 0, BuildingKind::House, 1);
        let shop = build(&mut world, 20, BuildingKind::Shop, 1);
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        // Nobody lives here yet: the visits are ours, so the shelves and
        // the truck are the only things moving.
        let stock = |w: &World| match w.objects.get(shop).unwrap().object {
            GameObject::Building(ref b) => b.stock,
            _ => unreachable!(),
        };
        for _ in 0..21 {
            calls::visit(&mut world, &mut events, shop, 0);
        }
        assert!(stock(&world) < 0.5);
        assert_eq!(world.calls.len(), 1, "low shelves call for stock");
        let truck = world.calls[0].answered_by.expect("a truck from beyond the edge answers");
        assert!(matches!(world.objects.get(truck).unwrap().object, GameObject::Car(ref c) if c.role == crate::protocol::CarRole::Truck && c.trip.is_some()));

        pump(&mut world, &mut events, &mut intersections, 0, 2 * DAY_MS as u64 / 24);
        assert!(world.calls.is_empty(), "the call was answered");
        assert_eq!(stock(&world), 1.0, "the shelves are full again");
        assert!(world.objects.get(truck).is_none(), "the truck from beyond the edge is gone");
    }

    /// With a warehouse in town, its own truck answers, and comes home.
    #[test]
    fn a_warehouse_sends_its_own_truck_and_it_comes_home() {
        use crate::calls;
        let mut world = street();
        let shop = build(&mut world, 20, BuildingKind::Shop, 1);
        let warehouse = build(&mut world, 60, BuildingKind::Warehouse, 1);
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        for _ in 0..21 {
            calls::visit(&mut world, &mut events, shop, 0);
        }
        let truck = world.calls[0].answered_by.expect("the warehouse answers");
        assert!(matches!(world.objects.get(truck).unwrap().object, GameObject::Car(ref c) if c.owner == warehouse));

        pump(&mut world, &mut events, &mut intersections, 0, 2 * DAY_MS as u64 / 24);
        assert!(world.calls.is_empty());
        let e = world.objects.get(truck).expect("the warehouse keeps its truck");
        assert!(matches!(e.object, GameObject::Car(ref c) if c.trip.is_none()));
        assert_eq!(e.position, world.objects.get(warehouse).unwrap().position, "parked back at the warehouse");
    }

    /// Every wake, every arrival: the log the model in docs/residents.md is
    /// held to. Two runs of the same town must write the same one — down to
    /// the millisecond — or something is iterating a hash map.
    type Move = (GameTime, EntityId, Option<EntityId>, Option<crate::needs::Need>);

    fn arrival_log(days: u64) -> (Vec<Move>, [EntityId; 2]) {
        let mut world = street();
        build(&mut world, 0, BuildingKind::Apartment, 2);
        build(&mut world, 6, BuildingKind::Apartment, 2);
        let shop = build(&mut world, 30, BuildingKind::Shop, 1);
        let office = build(&mut world, 60, BuildingKind::Office, 2);
        // Lunch: a shop beside the office, too far from home to staff.
        let lunch = build(&mut world, 64, BuildingKind::Shop, 1);

        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        let people = world.resident_ids();
        assert_eq!(people.len(), 16);

        let mut log = Vec::new();
        let mut last: Vec<Option<EntityId>> = people.iter().map(|_| None).collect();
        let mut now = 0;
        while now < days * DAY_MS as u64 {
            now += STEP_MS;
            events.set_now(now);
            while let Some(id) = events.pop_due() {
                handle_wake(&mut world, &mut events, &mut intersections, id, now);
            }
            for (i, &id) in people.iter().enumerate() {
                let at = at_of(&world, id);
                if at != last[i] {
                    log.push((now, id, at, doing(&world, id)));
                    last[i] = at;
                }
            }
        }
        // Sixteen cars on one street: journeys run somewhat over the
        // free-flow promise, and the estimate has learned roughly that.
        assert!((1.0..3.0).contains(&world.delay), "learned delay {}", world.delay);

        // Section 6, the demand side. Nobody here wants for anything, and
        // the office's books show what it received: twelve people, nine
        // hours, less the lunches — and the lunch shop sold them.
        if days >= 2 {
            let d = crate::resident::demand(&world, days * DAY_MS as u64);
            assert_eq!(d["unmet"].as_array().unwrap().len(), 0, "{}", d["unmet"]);
            let sold = |b: EntityId, need: &str| {
                d["delivered"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|v| v["building"] == b && v["need"] == need)
                    .map_or(0.0, |v| v["yesterday_h"].as_f64().unwrap())
            };
            let office = sold(office, "Work");
            assert!((80.0..=108.0).contains(&office), "office received {office}h");
            assert!(sold(lunch, "Eat") > 2.0, "lunch shop sold {}h", sold(lunch, "Eat"));
        }
        (log, [shop, lunch])
    }

    /// After dark the bar is the only thing open, and people go: it sells
    /// evenings out, and every one of them begins after eight.
    #[test]
    fn the_bar_gets_an_evening_crowd() {
        let mut world = street();
        build(&mut world, 0, BuildingKind::Apartment, 2);
        build(&mut world, 6, BuildingKind::Apartment, 2);
        build(&mut world, 40, BuildingKind::Office, 2);
        let bar = build(&mut world, 12, BuildingKind::Bar, 1);

        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        let people = world.resident_ids();

        let day = DAY_MS as u64;
        let mut outings: Vec<GameTime> = Vec::new();
        let mut last: Vec<(Option<EntityId>, Option<crate::needs::Need>)> = people.iter().map(|_| (None, None)).collect();
        let mut now = 0;
        while now < 2 * day {
            now += STEP_MS;
            events.set_now(now);
            while let Some(id) = events.pop_due() {
                handle_wake(&mut world, &mut events, &mut intersections, id, now);
            }
            for (i, &id) in people.iter().enumerate() {
                let state = (at_of(&world, id), doing(&world, id));
                if state != last[i] {
                    // An evening out begins when someone at the bar turns to
                    // it — whether they drove over for it or stayed on after
                    // dinner.
                    if state == (Some(bar), Some(crate::needs::Need::Leisure)) {
                        outings.push(now % day);
                    }
                    last[i] = state;
                }
            }
        }
        // Some settle in after dinner and wait for the evening to start;
        // nobody turns to it before the doors open at six.
        assert!(outings.len() >= 4, "only {} evenings out", outings.len());
        let h = |t: GameTime| t as f64 / (day as f64 / 24.0);
        assert!(
            outings.iter().all(|&t| h(t) >= 18.0 || h(t) < 2.0),
            "an outing outside opening hours: {:?}",
            outings.iter().map(|&t| h(t)).collect::<Vec<_>>()
        );

        // And the evenings were had: the bar's books show Leisure sold.
        let d = crate::resident::demand(&world, 2 * day);
        let sold = d["delivered"].as_array().unwrap().iter()
            .find(|v| v["building"] == bar && v["need"] == "Leisure")
            .map_or(0.0, |v| v["today_h"].as_f64().unwrap() + v["yesterday_h"].as_f64().unwrap());
        assert!(sold > 2.0, "the bar sold {sold}h of evenings");
    }

    #[test]
    fn cars_stop_for_fuel_now_and_then() {
        let mut world = street();
        build(&mut world, 0, BuildingKind::Apartment, 2);
        build(&mut world, 6, BuildingKind::Apartment, 2);
        build(&mut world, 60, BuildingKind::Office, 2);
        let station = build(&mut world, 30, BuildingKind::GasStation, 1);

        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        let people = world.resident_ids();

        let day = DAY_MS as u64;
        let mut stops = 0;
        let mut last: Vec<(Option<EntityId>, Option<crate::needs::Need>)> = people.iter().map(|_| (None, None)).collect();
        let mut now = 0;
        while now < 6 * day {
            now += STEP_MS;
            events.set_now(now);
            while let Some(id) = events.pop_due() {
                handle_wake(&mut world, &mut events, &mut intersections, id, now);
            }
            for (i, &id) in people.iter().enumerate() {
                let state = (at_of(&world, id), doing(&world, id));
                if state != last[i] {
                    if state == (Some(station), Some(crate::needs::Need::Fuel)) {
                        stops += 1;
                    }
                    last[i] = state;
                }
            }
        }
        // Sixteen commuters, 120 tiles a day, a 500-tile tank: a stop each
        // every few days — and not one a day, which would be a nag.
        println!("{stops} fuel stops in six days");
        assert!((12..=48).contains(&stops), "{stops} fuel stops in six days");
        let d = crate::resident::demand(&world, 6 * day);
        assert_eq!(d["unmet"].as_array().unwrap().len(), 0, "{}", d["unmet"]);
    }

    /// A town along the street, settled and thinking, run for a while: a
    /// mix of every kind, and the street running out past the frontier for
    /// people to arrive by. Returns it and how many times a resident thought.
    fn live(mix: &[BuildingKind], days: u64) -> (World, u64) {
        let mut world = street();
        for i in 0..40 {
            build(&mut world, i, mix[i as usize % mix.len()], 1);
        }
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        let mut wakes = 0;
        let mut now = 0;
        while now < days * DAY_MS as u64 {
            now += STEP_MS;
            events.set_now(now);
            while let Some(id) = events.pop_due() {
                if matches!(world.objects.get(id).map(|e| &e.object), Some(GameObject::Resident(_))) {
                    wakes += 1;
                }
                handle_wake(&mut world, &mut events, &mut intersections, id, now);
            }
        }
        (world, wakes)
    }

    /// The budget: how much thinking a day of town life is allowed to take.
    /// A resident wakes when something changes for them — a shift, a meal,
    /// an arrival — which is a few dozen times a day. A storm is thousands.
    /// Counted, not timed, so it is the same on every machine. A day of
    /// town takes most of a minute in debug, so it is not in the everyday
    /// run: `cargo test --release town -- --ignored --nocapture` runs it
    /// with the benchmark below, for a look every now and then.
    ///
    /// Two towns: one with everything, and one with nothing but homes and
    /// jobs, where meals and evenings out go wanting. Wanting is where the
    /// storm of 2026-09-04 lived — a bucket with nothing on offer was asked
    /// again every step — so the bare town is the one that stands guard.
    #[test]
    #[ignore]
    fn a_town_thinks_within_budget() {
        for (name, mix) in [("full", &BuildingKind::ALL[..]), ("bare", &[BuildingKind::House, BuildingKind::Office][..])] {
            let (world, wakes) = live(mix, 1);
            let residents = world.resident_ids().len() as u64;
            let per_resident_day = wakes / residents.max(1);
            println!("{name}: {wakes} wakes for {residents} residents: {per_resident_day} per resident-day");
            assert!(per_resident_day <= WAKE_BUDGET, "{name}: {per_resident_day} wakes per resident-day, budget {WAKE_BUDGET}");
        }
    }

    /// How fast the same town runs, in simulated days per wall second. Not
    /// asserted: wall time is the laptop's, not the code's. Printed for the
    /// same occasional look as the budget, to see whether it has drifted.
    #[test]
    #[ignore]
    fn how_fast_a_town_runs() {
        let started = Instant::now();
        let (world, wakes) = live(&BuildingKind::ALL, 3);
        let secs = started.elapsed().as_secs_f64();
        println!(
            "{} residents, {wakes} wakes: {:.1} sim days per second",
            world.resident_ids().len(),
            3.0 / secs
        );
    }

    #[test]
    fn the_same_town_lives_the_same_days() {
        let (two, [shop, lunch]) = arrival_log(2);
        let (one, _) = arrival_log(1);
        // Sixteen people, each at least driving in, to work, and home.
        assert!(one.len() >= 16 * 3, "only {} moves logged", one.len());
        assert_eq!(two[..one.len()], one[..], "the first day differs between runs");
        assert!(two.len() > one.len(), "nobody moved on the second day");

        // The second day is a settled one. Every trip is two changes of
        // `at` — into the car, out at the door — and a day is at most five
        // trips: to work, out for lunch and back, out for dinner near work,
        // and home. The shop workers eat where they stand; the office has a
        // shop next door, so its workers drive to it.
        let day = DAY_MS as u64;
        let mut moves = std::collections::BTreeMap::new();
        for &(_, id, ..) in two.iter().filter(|&&(t, ..)| t >= day) {
            *moves.entry(id).or_insert(0) += 1;
        }
        assert_eq!(moves.len(), 16, "everyone went out on day two");
        assert!(moves.values().all(|&n| n % 2 == 0 && (4..=10).contains(&n)), "someone thrashed: {moves:?}");
        assert!(moves.values().any(|&n| n >= 8), "nobody went out for lunch: {moves:?}");
        let last: std::collections::BTreeMap<_, _> = two.iter().map(|&(_, id, at, _)| (id, at)).collect();
        assert!(last.values().all(|at| at.is_some()), "someone ended the day in a car");

        // The lunch shop seats four. Twelve office workers want it, so the
        // afternoon is a succession of small sittings rather than one crush:
        // arrivals spread over hours, and the room is never far over full.
        let hour = day / 24;
        use crate::needs::Need;
        let arrivals: Vec<GameTime> = two
            .iter()
            .filter(|&&(t, _, at, sel)| t >= day && at == Some(lunch) && sel == Some(Need::Eat))
            .map(|&(t, ..)| t)
            .collect();
        assert!(arrivals.len() >= 8, "only {} came for lunch", arrivals.len());
        let span = arrivals.iter().max().unwrap() - arrivals.iter().min().unwrap();
        assert!(span >= 2 * hour, "lunch was a crush: {:.1}h", span as f64 / hour as f64);
        let (mut present, mut most) = (std::collections::BTreeSet::new(), 0);
        for &(_, id, at, sel) in two.iter().filter(|&&(t, ..)| t >= day) {
            if at == Some(lunch) && sel == Some(Need::Eat) { present.insert(id); } else { present.remove(&id); }
            most = most.max(present.len());
        }
        assert!(most <= 6, "{most} eating at a four-seat shop at once");

        // Time off is never more important than work (its rate is below the
        // job's), so an outing happens after the shift, from home, on an
        // evening when enough of it has piled up. Not nightly.
        let outings: Vec<f64> = two
            .iter()
            .filter(|&&(t, _, _, sel)| t >= day && sel == Some(Need::Leisure))
            .filter(|&&(_, _, at, _)| at == Some(shop) || at == Some(lunch))
            .map(|&(t, ..)| (t % day) as f64 / hour as f64)
            .collect();
        assert!(!outings.is_empty(), "nobody went out");
        assert!(outings.iter().all(|&h| h >= 17.0), "an outing during the shift: {outings:.1?}");
        assert!(outings.len() < 8, "everyone out every night: {outings:.1?}");
    }

    /// The demand readout names what is missing: a household with nowhere
    /// to work is two people short of a job, in the chunk they live in.
    #[test]
    fn a_town_without_jobs_says_so() {
        let mut world = street();
        build(&mut world, 0, BuildingKind::House, 1);
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        pump(&mut world, &mut events, &mut intersections, 0, 4 * (DAY_MS as u64) / 24);
        let d = crate::resident::demand(&world, 4 * (DAY_MS as u64) / 24);
        let unmet = d["unmet"].as_array().unwrap();
        assert_eq!(unmet.len(), 1, "{unmet:?}");
        assert_eq!(unmet[0]["need"], "Work");
        assert_eq!(unmet[0]["people"], 2);
        assert_eq!(unmet[0]["chunk"], serde_json::json!([0, 0]));
    }
}
