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
use crate::protocol::{BuildingKind, ChunkBounds, ChunkCoord, ClientMessage, Clock, DAY_MS, EntityId, GameObject, GameObjectEntry, Operation, OwnerId, Sale, ServerMessage, StateUpdate};
use crate::world::chunk_of;
use crate::world::World;
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
/// drive to and from before the mayor has placed anything.
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

        // The road brush sends a command per tile, so what a road changed is
        // settled once for the whole batch rather than once per tile.
        let mut roads_laid = false;
        while let Ok(cmd) = commands.try_recv() {
            match cmd {
                Command::PlayerAction { client_id, message } => {
                    roads_laid |= matches!(message, ClientMessage::PlaceRoad(_));
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
                            let _ = cs.sender.send(state_update(&world, vec![], vec![], clk));
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
                                let _ = cs.sender.send(state_update(&world, ops, vec![], clock(now, speed)));
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
                    let _ = sender.send(state_update(&world, vec![], vec![], clock(now, speed)));
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
                        Ask::Lot(id) => world.inspect_lot(id, now),
                        Ask::Card(id) => crate::card::card(&world, id, now),
                        Ask::Site { kind, x, y } => serde_json::to_value(world.site_under(x, y, kind)).unwrap_or_default(),
                        Ask::Call(id) => {
                            // Its shelf, emptied: a depot fetches, a maker
                            // is full again by tomorrow, anything else
                            // calls for stock.
                            if let Some(GameObject::Building(b)) = world.objects.get_mut(id).map(|e| &mut e.object)
                                && let Some(stock) = b.stocks.get_mut(&crate::economy::shelf_need(b.kind))
                            {
                                stock.level = 0.0;
                            }
                            crate::calls::turn(&mut world, &mut events, id, now);
                            serde_json::json!({ "calls": world.calls.iter().map(|c| serde_json::json!({ "kind": format!("{:?}", c.kind), "good": c.good, "at": c.at, "answered_by": c.answered_by })).collect::<Vec<_>>() })
                        }
                    };
                    let _ = reply.send(serde_json::to_string_pretty(&v).unwrap_or_default());
                }
                Command::ClientDisconnect { id } => {
                    clients.remove(&id);
                }
            }
        }
        // A road laid is a road that may have reached a building standing
        // dormant, or run off the map and made a new way in. Placing and
        // demolishing settle for themselves; drawing road did not, so a
        // street to a finished house left nobody living in it.
        if roads_laid {
            settle_and_wake(&mut world, &mut events);
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
        // wake storm or a dear arrival shows in the log rather than in the fan.
        let took = started.elapsed();
        if took >= BEHIND {
            eprintln!("behind: {wakes} wakes took {} ms at speed {speed}", took.as_millis());
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
            // That road can cross the new frontier, and a road crossing the
            // frontier is a way out; `reveal_around` stood the doors before
            // it was laid.
            world.stand_edges();
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
fn state_update(world: &World, ops: Vec<Operation>, sales: Vec<Sale>, clk: Clock) -> ServerMessage {
    ServerMessage::Update(StateUpdate {
        ops,
        sales,
        clock: clk,
        growth: crate::economy::growth(world, clk.now),
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
    // What the city has served, and what the mayor has, outlive a restart.
    world.gdp = meta.gdp;
    world.gdp_at_midnight = meta.gdp;
    world.treasury = meta.treasury;
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
            gdp: world.gdp,
            treasury: world.treasury,
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
            world.handle_place_road(place.from, place.to, place.one_way, place.road);

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
            // Exactly what the ghost showed: the site is decided once, by the
            // same call, from the point the building was held over. The
            // mayor pays for it from what the city has earned.
            let site = world.site_under(place.at[0], place.at[1], place.kind);
            let price = crate::economy::price(world, place.kind);
            let allowed = world.build.may_place(place.kind) && world.treasury >= price;
            let placed = allowed.then(|| world.place_site(site, place.kind)).flatten();
            match placed {
                Some(_) => {
                    world.treasury -= price;
                    settle_and_wake(world, events);
                }
                // Said out loud: a click that does nothing is the kind of
                // bug that otherwise takes an afternoon to find.
                None => println!("place refused: {:?} at {:?}: allowed {}, site {:?}", place.kind, place.at, allowed, site),
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
            let (level, _) = crate::economy::level(world.gdp);
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

        if try_reroute(world, intersections, events, car_id, from_node, dest, now) {
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
    now: GameTime,
) -> bool {
    let Some(to_node) = world.approach(dest) else { return false };
    let path = match pathfinding::Routes::from(world, from_node).route_to(to_node) {
        Some(r) if r.len() >= 2 => r,
        _ => return false,
    };
    // The spot it was heading for is still its own.
    let Some(way_in) = world.way_in(dest, car_id, now, GameTime::MAX) else { return false };
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

    // Out of every queue on the old route: a car stands in the queues of the
    // whole run ahead of it, not just the tile it is on.
    world.unregister_car_route(car_id, &old_route);
    world.remove_car_from_edges(car_id);
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

    let reverse = world.reverse_tail(car_id);
    if let Some(entry) = world.objects.get_mut(car_id)
        && let GameObject::Car(ref mut car) = entry.object
        && let Some(ref mut t) = car.trip
    {
        t.route = new_route;
        t.route_positions = route_positions;
        t.from_lot = 0;
        t.to_lot = to_lot;
        t.reverse = reverse;
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
        // Midnight: every till is counted, every price steps, and everyone
        // looks at the openings again.
        None if id == MIDNIGHT => {
            crate::economy::day(world, now);
            crate::calls::turns(world, events, now);
            settle_and_wake(world, events);
        }
        // A call nothing could answer, tried again.
        None if id == crate::calls::RETRY => crate::calls::dispatch(world, events, now),
        _ => {}
    }
}

/// The wake that is nobody's: the day turning. No entity has this id.
const MIDNIGHT: EntityId = EntityId::MAX;

/// Population follows what is standing, and whoever's situation changed gets
/// to think about it. And the day is always due to turn.
fn settle_and_wake(world: &mut World, events: &mut EventQueue) {
    for id in world.settle() {
        wake_resident(world, events, id);
    }
    let day = DAY_MS as u64;
    events.wake(day - events.now() % day, MIDNIGHT);
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
        let _ = cs.sender.send(state_update(world, ops, vec![], clk));
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
    // Money that landed, for whoever is looking at where it landed.
    let sales: Vec<(ChunkCoord, Sale)> = std::mem::take(&mut world.sales)
        .into_iter()
        .filter_map(|s| Some((chunk_of(world.objects.get(s.building)?.position?), s)))
        .collect();

    if changed.is_empty() && removed.is_empty() && crossings.is_empty() && newly_revealed.is_empty() && sales.is_empty()
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
        let sales: Vec<Sale> = sales.iter().filter(|(c, _)| cs.known_chunks.contains(c)).map(|(_, s)| *s).collect();

        if !ops.is_empty() || !sales.is_empty() {
            let _ = cs.sender.send(state_update(world, ops, sales, clk));
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
    use crate::calls;
    use crate::protocol::{BuildingKind, GridCoord, TerrainType};

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

    /// Sell `units` off a shop's shelf, as visits would, and let it call.
    fn sell(world: &mut World, events: &mut EventQueue, shop: EntityId, units: f64, now: GameTime) {
        if let Some(GameObject::Building(b)) = world.objects.get_mut(shop).map(|e| &mut e.object) {
            b.stocks.get_mut(&crate::needs::Need::Eat).unwrap().take(units);
        }
        calls::turn(world, events, shop, now);
    }

    /// A shelf, as a fraction of full.
    fn stock(world: &World, building: EntityId) -> f64 {
        match world.objects.get(building).unwrap().object {
            GameObject::Building(ref b) => b.stocks[&crate::economy::shelf_need(b.kind)].level / b.stocks[&crate::economy::shelf_need(b.kind)].cap,
            _ => unreachable!(),
        }
    }

    /// A tick of run(): `now` moves to the next tick with something due —
    /// or the one that reaches `to` — and everything due thinks at it. The
    /// ticks in between, where nothing is due, are skipped rather than
    /// stepped: nothing but handle_wake changes the world, so a test that
    /// looks at the world after every tick sees the same thing either way,
    /// in a hundredth of the time. False once `to` is reached.
    fn step(
        world: &mut World,
        events: &mut EventQueue,
        intersections: &mut IntersectionRegistry,
        now: &mut GameTime,
        to: GameTime,
    ) -> bool {
        step_counting(world, events, intersections, now, to, &mut 0)
    }

    /// `step`, counting how many times a resident thought: the budget.
    fn step_counting(
        world: &mut World,
        events: &mut EventQueue,
        intersections: &mut IntersectionRegistry,
        now: &mut GameTime,
        to: GameTime,
        wakes: &mut u64,
    ) -> bool {
        if *now >= to {
            return false;
        }
        let due = events.next_due().map_or(to, |t| t.min(to));
        *now += due.saturating_sub(*now).div_ceil(STEP_MS).max(1) * STEP_MS;
        events.set_now(*now);
        while let Some(id) = events.pop_due() {
            if matches!(world.objects.get(id).map(|e| &e.object), Some(GameObject::Resident(_))) {
                *wakes += 1;
            }
            handle_wake(world, events, intersections, id, *now);
        }
        true
    }

    /// Run the simulation from `from` to `to`.
    fn pump(
        world: &mut World,
        events: &mut EventQueue,
        intersections: &mut IntersectionRegistry,
        from: GameTime,
        to: GameTime,
    ) {
        let mut now = from;
        while step(world, events, intersections, &mut now, to) {}
    }

    /// The whole loop watched from above: people immigrate from past the
    /// frontier, drive to work in the morning, and are home again at night —
    /// and nobody told them to; the shift did.
    /// One long street with room to build beside it. It runs far past what
    /// the buildings will reveal, the way road generation always leaves a way
    /// in from outside: immigrants need somewhere unseen to come from.
    fn street() -> World {
        let mut world = World::new();
        // Deep enough for a supermarket and its lot behind the street.
        for y in -6..6 {
            for x in -4..170 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        let street: Vec<GridCoord> = (-2..168).map(|x| GridCoord { x, y: 0 }).collect();
        world.place_road_path(&street);
        world
    }

    fn build(world: &mut World, x: i32, kind: BuildingKind, _w: u8) -> EntityId {
        world
            .place_on_street(GridCoord { x, y: 1 }, kind)
            .unwrap_or_else(|| panic!("the street should give a {kind:?} at x={x} its driveway"))
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
        let mut world = street();
        build(&mut world, 0, BuildingKind::House, 1);
        let shop = build(&mut world, 20, BuildingKind::Shop, 1);
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        // Nobody lives here yet: the sales are ours, so the shelves and
        // the truck are the only things moving. A few short of the reorder
        // point, nothing stirs; past it, the shelf calls.
        let s = crate::economy::reorder(&world, shop, crate::needs::Need::Eat);
        sell(&mut world, &mut events, shop, 40.0 - s - 1.0, 0);
        assert!(world.calls.is_empty(), "a shelf over its reorder point called");
        sell(&mut world, &mut events, shop, 2.0, 0);
        assert_eq!(world.calls.len(), 1, "a shelf at its reorder point calls for stock");
        let truck = world.calls[0].answered_by.expect("a truck from beyond the edge answers");
        assert!(matches!(world.objects.get(truck).unwrap().object, GameObject::Car(ref c) if c.role == crate::protocol::CarRole::Truck && c.trip.is_some()));

        pump(&mut world, &mut events, &mut intersections, 0, 2 * DAY_MS as u64 / 24);
        assert!(world.calls.is_empty(), "the call was answered");
        assert_eq!(stock(&world, shop), 1.0, "the shelves are full again");
        assert!(world.objects.get(truck).is_none(), "the truck from beyond the edge is gone");
    }

    /// With a warehouse in town nearer than the edge, at the same price,
    /// its own van answers, and comes home.
    #[test]
    fn a_warehouse_sends_its_own_truck_and_it_comes_home() {
        let mut world = street();
        let shop = build(&mut world, 20, BuildingKind::Shop, 1);
        let warehouse = build(&mut world, 60, BuildingKind::Warehouse, 1);
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        sell(&mut world, &mut events, shop, 35.0, 0);
        let truck = world.calls[0].answered_by.expect("the warehouse answers");
        assert!(matches!(world.objects.get(truck).unwrap().object, GameObject::Car(ref c) if c.owner == warehouse));
        // The shop learned how long a delivery from next door takes, and
        // reorders later for it.
        let before = crate::economy::reorder(&world, shop, crate::needs::Need::Eat);

        // Out through one ring and home through another, at lot speed, on
        // top of the drive: under three hours.
        pump(&mut world, &mut events, &mut intersections, 0, 3 * DAY_MS as u64 / 24);
        assert!(world.calls.is_empty());
        let e = world.objects.get(truck).expect("the warehouse keeps its truck");
        assert!(matches!(e.object, GameObject::Car(ref c) if c.trip.is_none()));
        assert_eq!(e.position, world.objects.get(warehouse).unwrap().position, "parked back at the warehouse");
        assert_eq!(stock(&world, shop), 1.0, "the shelves are full again");
        assert!(crate::economy::reorder(&world, shop, crate::needs::Need::Eat) < before, "the shop did not learn the lead time");
    }

    /// The building's turn (docs/economy.md §6.2): a depot that posts a
    /// price the drive it saves cannot pay for loses the order to the edge,
    /// and wins it back when it comes down.
    #[test]
    fn a_dear_depot_loses_the_order_to_the_edge() {
        let mut world = street();
        let shop = build(&mut world, 20, BuildingKind::Shop, 1);
        let warehouse = build(&mut world, 60, BuildingKind::Warehouse, 1);
        let mut events = EventQueue::new();
        let post = |world: &mut World, price: f64| {
            if let Some(GameObject::Building(b)) = world.objects.get_mut(warehouse).map(|e| &mut e.object) {
                b.prices.insert(crate::needs::Need::Eat, price);
            }
        };
        let answered_by_the_warehouse = |world: &World| {
            let truck = world.calls[0].answered_by.expect("somebody answers");
            matches!(world.objects.get(truck).unwrap().object, GameObject::Car(ref c) if c.owner == warehouse)
        };
        post(&mut world, 2.0 * crate::economy::wholesale(crate::needs::Need::Eat));
        sell(&mut world, &mut events, shop, 35.0, 0);
        assert!(!answered_by_the_warehouse(&world), "the shop paid double to save a short drive");
        // The order stands until it lands; a second shop asks fresh.
        let other = build(&mut world, 30, BuildingKind::Shop, 1);
        post(&mut world, crate::economy::wholesale(crate::needs::Need::Eat));
        sell(&mut world, &mut events, other, 35.0, 0);
        assert_eq!(world.calls.len(), 2);
        let truck = world.calls[1].answered_by.expect("somebody answers");
        assert!(matches!(world.objects.get(truck).unwrap().object, GameObject::Car(ref c) if c.owner == warehouse), "at the edge's price the nearer seller wins");
    }

    /// Services, docs/economy.md §4: a home's stock run low calls, the
    /// office's car answers with what the office's staff made, unloads
    /// at the door and comes home, and no money crosses; a shift that
    /// fills the office's shelf sends the car out past the edge with the
    /// load, and it comes home paid.
    #[test]
    fn an_office_serves_a_home_by_car_and_ships_the_rest_to_the_edge() {
        use crate::needs::Need;
        let mut world = street();
        let home = build(&mut world, 0, BuildingKind::House, 1);
        let office = build(&mut world, 20, BuildingKind::Office, 1);
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        let staff = world.resident_ids().into_iter().find(|&id| matches!(world.objects.get(id).map(|e| &e.object), Some(GameObject::Resident(r)) if r.work == Some(office))).expect("the office hired");
        let level = |world: &World, id: EntityId| match world.objects.get(id).unwrap().object {
            GameObject::Building(ref b) => b.stocks[&Need::Services].level,
            _ => unreachable!(),
        };
        let week = level(&world, home);
        let day = level(&world, office);
        assert!(day > week, "an office's day does not cover a house's week");
        world.treasury = 100.0;
        if let Some(GameObject::Building(b)) = world.objects.get_mut(home).map(|e| &mut e.object) {
            b.stocks.get_mut(&Need::Services).unwrap().level = 0.0;
        }
        calls::turn(&mut world, &mut events, home, 0);
        let car = world.calls[0].answered_by.expect("the office answers");
        assert!(matches!(world.objects.get(car).unwrap().object, GameObject::Car(ref c) if c.owner == office && c.role == crate::protocol::CarRole::Company), "not the office's car");
        assert_eq!(level(&world, office), day - week, "the car loaded the order");
        pump(&mut world, &mut events, &mut intersections, 0, 2 * DAY_MS as u64 / 24);
        assert!(world.calls.is_empty(), "the call was answered");
        assert!(week - level(&world, home) < crate::economy::draw(BuildingKind::House), "the home's stock is not full again: {}", level(&world, home));
        assert_eq!(world.treasury, 100.0, "a delivery inside the town moved money");
        let e = world.objects.get(car).expect("the office keeps its car");
        assert!(matches!(e.object, GameObject::Car(ref c) if c.trip.is_none()) && e.position == world.objects.get(office).unwrap().position, "not parked back at the office");

        // A shift fills the shelf, and what nobody in town buys goes out.
        let now = 2 * DAY_MS as u64 / 24;
        let sold_in_town = world.books[&office].on(now).revenue;
        crate::economy::sale(&mut world, staff, office, Need::Work, week, now);
        assert_eq!(level(&world, office), day, "the shift did not fill the shelf");
        calls::turn(&mut world, &mut events, office, now);
        assert_eq!(world.calls.len(), 1, "a full shelf did not ship");
        assert_eq!(world.calls[0].answered_by, Some(car), "the car did not take it");
        assert_eq!(level(&world, office), 0.0, "the car left the shelf behind");
        // The shelf, less the office's own draw since it was last looked at.
        let load = world.calls[0].load;
        assert!(load > day - crate::economy::draw(BuildingKind::Office) && load <= day, "the car took {load} of {day}");
        pump(&mut world, &mut events, &mut intersections, now, now + 12 * DAY_MS as u64 / 24);
        assert!(world.calls.is_empty(), "the car did not come home");
        let paid = crate::economy::export(load * crate::economy::edge_price(Need::Services));
        let took = world.books[&office].on(now).revenue - sold_in_town;
        assert!((took - paid).abs() < 1e-9, "the edge paid {took} for the load");
        // Less what the town bought meanwhile: a meal at the edge, a lunch.
        assert!(world.treasury > 100.0 + paid - 1.0, "the treasury rose by {}", world.treasury - 100.0);
    }

    /// A street of homes and nothing else: every home calls for services
    /// at midnight, with the household's car in the driveway, and nothing
    /// in town to answer. A consultant from beyond the edge comes once
    /// the driveway clears, paid at the door, and no home runs dry. The
    /// bedroom town of 2026-09-10 sat with forty calls open for ten days
    /// because nothing ever tried again.
    #[test]
    fn a_bedroom_street_is_served_by_consultants() {
        use crate::needs::Need;
        let mut world = street();
        let mut homes: Vec<EntityId> = [0, 4, 8].into_iter().map(|x| build(&mut world, x, BuildingKind::House, 1)).collect();
        homes.push(build(&mut world, 12, BuildingKind::Apartment, 1));
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        world.treasury = 1000.0;
        let level = |world: &World, id: EntityId| match world.objects.get(id).unwrap().object {
            GameObject::Building(ref b) => b.stocks[&Need::Services].level,
            _ => unreachable!(),
        };
        // Two days of stock to run through, and a day for the calls to land.
        let day = DAY_MS as u64;
        pump(&mut world, &mut events, &mut intersections, 0, 4 * day - day / 24);
        for &home in &homes {
            assert!(level(&world, home) > 0.0, "home {home} ran dry: {:?}", world.calls);
        }
        let bought = world.income.on(3 * day).purchases + world.income.before(3 * day).purchases;
        let heads = world.resident_ids().len() as f64;
        let a_day = heads * crate::economy::import(crate::economy::services());
        assert!(bought > a_day, "the consultants were paid {bought} over two days for {heads} heads");
    }

    /// A depot draws on its own stock with every van it sends; when that
    /// runs low a lorry of its own drives out past the edge, is away a
    /// while, and comes home full.
    #[test]
    fn a_depot_fetches_from_beyond_the_edge() {
        let mut world = street();
        let shop = build(&mut world, 20, BuildingKind::Shop, 1);
        let depot = build(&mut world, 60, BuildingKind::Warehouse, 1);
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        let lorries = |w: &World| w.objects.all_entries().iter().filter(|e| matches!(e.object, GameObject::Car(ref c) if c.owner == depot && c.role == crate::protocol::CarRole::Truck)).map(|e| e.id).collect::<Vec<_>>();
        let fleet = lorries(&world);
        assert_eq!(fleet.len(), 2, "two lorries from the day it is reached");
        // The fetch can be raised, answered and finished inside one stretch
        // of pumping, so the run is watched all the way through rather than
        // sampled: who answered, and whether they were ever off the map.
        let mut answered: Option<EntityId> = None;
        let mut away = false;
        let watch = |world: &World, answered: &mut Option<EntityId>, away: &mut bool| {
            if let Some(car) = world.calls.iter().find(|c| c.kind == calls::CallKind::Edge).and_then(|c| c.answered_by) {
                *answered = Some(car);
            }
            *away |= answered.is_some_and(|car| world.objects.get(car).is_some_and(|e| e.position.is_none()));
        };
        // Six shops' worth on the depot's shelves: deliveries of most of a
        // shop take it down to its reorder point within a week of them.
        let mut t = 0;
        let mut rounds = 0;
        while world.calls.iter().all(|c| c.kind != calls::CallKind::Edge) {
            rounds += 1;
            assert!(rounds <= 8, "the depot never ran low: {}", stock(&world, depot));
            sell(&mut world, &mut events, shop, 35.0, t);
            let van = world.calls.iter().find(|c| c.kind == calls::CallKind::Stock).and_then(|c| c.answered_by).expect("a van answers");
            assert!(matches!(world.objects.get(van).unwrap().object, GameObject::Car(ref c) if c.role == crate::protocol::CarRole::Van));
            let until = t + 3 * DAY_MS as u64 / 24;
            while step(&mut world, &mut events, &mut intersections, &mut t, until) {
                watch(&world, &mut answered, &mut away);
            }
        }
        assert!(rounds >= 4, "the depot ran low after {rounds} deliveries");
        // Out past the edge and gone for a while, then home.
        for _ in 0..40 {
            let until = t + calls::AWAY_MS / 4;
            while step(&mut world, &mut events, &mut intersections, &mut t, until) {
                watch(&world, &mut answered, &mut away);
            }
            if answered.is_some() && world.calls.iter().all(|c| c.kind != calls::CallKind::Edge) {
                break;
            }
        }
        let lorry = answered.expect("one of its lorries answers the fetch");
        assert!(fleet.contains(&lorry), "the fetch went to one of the depot's own lorries");
        assert!(away, "the lorry was never beyond the edge");
        assert!(world.calls.iter().all(|c| c.kind != calls::CallKind::Edge), "the fetch is done");
        assert_eq!(stock(&world, depot), 1.0, "the depot is full again");
        let e = world.objects.get(lorry).unwrap();
        assert_eq!(e.position, world.objects.get(depot).unwrap().position, "the lorry is back in its dock");
        assert!(matches!(e.object, GameObject::Car(ref c) if c.trip.is_none() && c.spot.is_some()));
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
        // Fuel, or every few days the whole town drives to the edge for it
        // and makes an evening of it, which is a test of something else.
        build(&mut world, 18, BuildingKind::GasStation, 1);

        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        // Fourteen households in the two blocks, and three desks over: the
        // office's last two and the pump are filled from beyond the edge,
        // by people who drive in and are gone again by night.
        let people = world.resident_ids();
        assert_eq!(people.len(), 17);

        let mut log = Vec::new();
        let mut last: Vec<Option<EntityId>> = people.iter().map(|_| None).collect();
        let mut last_doing: Vec<(Option<EntityId>, Option<crate::needs::Need>)> = people.iter().map(|_| (None, None)).collect();
        let mut now = 0;
        while step(&mut world, &mut events, &mut intersections, &mut now, days * DAY_MS as u64) {
            for (i, &id) in people.iter().enumerate() {
                let at = at_of(&world, id);
                // `TRACE=1 cargo test the_same_town -- --nocapture` prints
                // the last day's log, one line a move or a change of mind,
                // to read by hand.
                if std::env::var("TRACE").is_ok() && now >= (days - 1) * DAY_MS as u64 && (at, doing(&world, id)) != last_doing[i] {
                    eprintln!("{i} {} {:?} {:?}", crate::card::card(&world, id, now)["since"], at.map(|a| crate::card::card(&world, a, now)["label"].to_string()), doing(&world, id));
                    last_doing[i] = (at, doing(&world, id));
                }
                if at != last[i] {
                    log.push((now, id, at, doing(&world, id)));
                    last[i] = at;
                }
            }
        }
        // Section 6, the demand side. Nobody here wants for anything, and
        // the office's books show what it received on the last whole day:
        // twelve people, nine hours, less the lunches — and the lunch shop
        // sold them. The last day, not the second: everyone arrives with
        // no time off owed, and the first evening nobody goes out, so the
        // second afternoon a few settle it in work time. Priced, an evening
        // out is had every other night rather than every night.
        if days >= 3 {
            let d = crate::resident::demand(&world, days * DAY_MS as u64);
            assert_eq!(d["unmet"].as_array().unwrap().len(), 0, "{}", d["unmet"]);
            let sold = |b: EntityId, need: &str, day: &str| {
                d["delivered"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|v| v["building"] == b && v["need"] == need)
                    .map_or(0.0, |v| v[day].as_f64().unwrap())
            };
            let office = sold(office, "Work", "yesterday_h");
            // Fourteen people, two apartments of seven, less the shop's two,
            // nine hours each, less the odd late morning, a lunch out and
            // a dinner near work.
            assert!((85.0..=108.0).contains(&office), "office received {office}h");
            // Lunches over a whole day.
            assert!(sold(lunch, "Eat", "yesterday_h") > 2.0, "lunch shop sold {}h", sold(lunch, "Eat", "yesterday_h"));
        }
        (log, [shop, lunch])
    }

    /// After dark the bar is the only thing open, and people go: it sells
    /// evenings out, and every one of them begins after eight. An evening
    /// costs about an hour's wage, so it is had every few days, not every
    /// night: four days, for a crowd.
    #[test]
    fn the_bar_gets_an_evening_crowd() {
        let mut world = street();
        build(&mut world, 0, BuildingKind::Apartment, 2);
        build(&mut world, 6, BuildingKind::Apartment, 2);
        build(&mut world, 40, BuildingKind::Office, 2);
        let bar = build(&mut world, 12, BuildingKind::Bar, 1);
        // Fuel in town, or the trip to the edge for it is the evening out.
        build(&mut world, 20, BuildingKind::GasStation, 1);

        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        let people = world.resident_ids();

        let day = DAY_MS as u64;
        let mut outings: Vec<GameTime> = Vec::new();
        let mut last: Vec<(Option<EntityId>, Option<crate::needs::Need>)> = people.iter().map(|_| (None, None)).collect();
        let mut now = 0;
        while step(&mut world, &mut events, &mut intersections, &mut now, 4 * day) {
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
        // The bar's lot decides its crowd: two spots, so two out at a time,
        // and nobody turns to it before the doors open at six.
        let d = crate::resident::demand(&world, 4 * day);
        assert!(outings.len() >= 2, "only {} evenings out", outings.len());
        let h = |t: GameTime| t as f64 / (day as f64 / 24.0);
        assert!(
            outings.iter().all(|&t| h(t) >= 18.0 || h(t) < 2.0),
            "an outing outside opening hours: {:?}",
            outings.iter().map(|&t| h(t)).collect::<Vec<_>>()
        );

        // And the evenings were had: the bar's books show Leisure sold.
        let d = crate::resident::demand(&world, 4 * day);
        let sold = d["delivered"].as_array().unwrap().iter()
            .find(|v| v["building"] == bar && v["need"] == "Leisure")
            .map_or(0.0, |v| v["today_h"].as_f64().unwrap() + v["yesterday_h"].as_f64().unwrap());
        // Two spots' worth of evenings, not twelve slots' worth.
        assert!(sold > 1.0, "the bar sold {sold}h of evenings");
    }

    #[test]
    fn cars_stop_for_fuel_now_and_then() {
        let mut world = street();
        build(&mut world, 0, BuildingKind::Apartment, 2);
        build(&mut world, 6, BuildingKind::Apartment, 2);
        build(&mut world, 60, BuildingKind::Office, 2);
        build(&mut world, 40, BuildingKind::Shop, 1);
        let station = build(&mut world, 30, BuildingKind::GasStation, 1);

        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        let people = world.resident_ids();

        let day = DAY_MS as u64;
        let mut stops = 0;
        let mut last: Vec<(Option<EntityId>, Option<crate::needs::Need>)> = people.iter().map(|_| (None, None)).collect();
        let mut now = 0;
        while step(&mut world, &mut events, &mut intersections, &mut now, 6 * day) {
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
        // Fourteen commuters, 120 tiles a day, a 500-tile tank: a stop each
        // every few days — and not one a day, which would be a nag.
        println!("{stops} fuel stops in six days");
        assert!((12..=48).contains(&stops), "{stops} fuel stops in six days");
        let d = crate::resident::demand(&world, 6 * day);
        assert_eq!(d["unmet"].as_array().unwrap().len(), 0, "{}", d["unmet"]);
    }

    /// Every kind the mayor could put down: everything with a price. The
    /// edge has none, and is not placed by anyone.
    fn placeable() -> Vec<BuildingKind> {
        BuildingKind::ALL.into_iter().filter(|&k| crate::blueprint::blueprint(k).price.is_finite()).collect()
    }

    /// A town shaped like a town, for the seasons: mostly homes, an export
    /// base of offices, factories and workshops with about as many desks
    /// as the homes have people, and one of each shop. Forty plots.
    /// `placeable` cycles every kind equally, which is seventeen shops,
    /// bars, supermarkets and warehouses for 177 people — the mix for a
    /// wake budget, not for a purse.
    fn town_mix() -> Vec<BuildingKind> {
        use BuildingKind::*;
        vec![
            House, Apartment, Office, House, Apartment, Shop, House, Factory, Apartment, House,
            Workshop, Apartment, House, Bar, Office, House, Apartment, Restaurant, House, Factory,
            Apartment, House, GasStation, Apartment, Office, House, Supermarket, Apartment, House, Workshop,
            Factory, House, Apartment, Warehouse, House, Apartment, House, Apartment, House, Apartment,
        ]
    }

    /// A street drawn to a house that was standing dormant moves people in.
    ///
    /// Placing and demolishing settle for themselves; drawing road did not,
    /// so the house stayed empty until the mayor happened to place something
    /// else. Everything here but the one line in the tick loop that decides
    /// to settle after a batch of road.
    #[test]
    fn a_street_drawn_to_a_dormant_house_fills_it() {
        let mut world = street();
        // Three tiles off the street, so no driveway forms with it.
        let home = world
            .place_building(GridCoord { x: 10, y: 3 }, BuildingKind::House, 2)
            .expect("land is land");
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        assert!(world.resident_ids().is_empty(), "nobody lives where no road goes");

        // The mayor draws a street to it, tile by tile, as the brush does.
        for (from, to) in [
            (GridCoord { x: 10, y: 0 }, GridCoord { x: 10, y: 1 }),
            (GridCoord { x: 10, y: 1 }, GridCoord { x: 10, y: 2 }),
            // Onto the plot: a road that ends on one is a driveway.
            (GridCoord { x: 10, y: 2 }, GridCoord { x: 10, y: 3 }),
        ] {
            let place = crate::protocol::PlaceRoad { from, to, one_way: false, road: false };
            handle_player_action(&mut world, &mut events, &mut intersections, ClientMessage::PlaceRoad(place), 0);
        }
        assert!(world.road_node_for_building(home).is_some(), "the driveway formed itself");

        // Which is what the tick settles for, once, after the batch.
        settle_and_wake(&mut world, &mut events);
        assert_eq!(
            world.resident_ids().len(),
            crate::blueprint::blueprint(BuildingKind::House).homes as usize,
            "the street reached it and nobody moved in",
        );
    }

    /// A town along the street, settled and thinking, run for a while: a
    /// mix of every kind, and the street running out past the frontier for
    /// people to arrive by. Returns it and how many times a resident thought.
    ///
    /// The street has to leave the survey, or there is no road exit — and
    /// with no road exit nobody can drive in at all. The town then stands
    /// empty while every resident spends the day retrying an arrival that
    /// can never happen, which is a measurement of nothing.
    fn live(mix: &[BuildingKind], days: u64) -> (World, u64) {
        season(mix, days, |_, _, _| {})
    }

    /// `live`, with a look at the town at the end of every day: after the
    /// midnight wake, so the tills are counted and the prices stepped.
    fn season(mix: &[BuildingKind], days: u64, mut each_day: impl FnMut(&World, u64, u64)) -> (World, u64) {
        let mut world = street();
        // Forty plots in a row, a tile apart: a lot claims the tile beside
        // it for its ring, and a house may not stand on it.
        let mut x = 0;
        for i in 0..40 {
            let kind = mix[i % mix.len()];
            build(&mut world, x, kind, 1);
            x += crate::blueprint::plot(kind, 0).size.0 as i32 + 1;
        }
        // The street runs on well past anything built on it, so it leaves
        // the survey: a town with a way off the map is the one being
        // measured, since the edge is an option for every bucket.
        for y in -6..6 {
            for x in 170..400 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        world.place_road_path(&(167..400).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>());
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        assert!(!world.edge.is_empty(), "the street has to run off the map, or nobody can arrive at all");
        // Forty buildings placed at once are a town that grew; give it the
        // working capital one would have, a week of its households' row,
        // and measure from there.
        world.treasury = crate::economy::STAKE + 7.0 * world.resident_ids().len() as f64 * crate::economy::household();
        let mut wakes = 0;
        let mut now = 0;
        let end = days * DAY_MS as u64;
        // A day at a time, so the look at the end of each is on the tick
        // that turns it, with the midnight wake taken.
        for day in 1..=days {
            let midnight = day * DAY_MS as u64;
            while step_counting(&mut world, &mut events, &mut intersections, &mut now, midnight.min(end), &mut wakes) {}
            each_day(&world, day, wakes);
        }
        (world, wakes)
    }

    /// The budget: how much thinking a day of town life is allowed to take.
    /// A resident wakes when something changes for them — a shift, a meal,
    /// an arrival — which is a few dozen times a day. A storm is thousands.
    /// Counted, not timed, so it is the same on every machine. The two
    /// towns take half a minute even optimised, so they are not in the
    /// everyday run: `cargo test town -- --ignored --nocapture` runs them
    /// with the benchmark below, for a look every now and then.
    ///
    /// Two towns: one with everything, and one with nothing but homes and
    /// jobs, where meals and evenings out go wanting. Wanting is where the
    /// storm of 2026-09-04 lived — a bucket with nothing on offer was asked
    /// again every step — so the bare town is the one that stands guard.
    #[test]
    #[ignore]
    fn a_town_thinks_within_budget() {
        // Everything with a price is everything the mayor could build. The
        // edge has none — it is not a town's to have — so it is not in the mix.
        let every_kind = placeable();
        for (name, mix) in [("full", &every_kind[..]), ("bare", &[BuildingKind::House, BuildingKind::Office][..])] {
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
        let (world, wakes) = live(&placeable(), 3);
        let secs = started.elapsed().as_secs_f64();
        println!(
            "{} residents, {wakes} wakes: {:.2} sim days per second",
            world.resident_ids().len(),
            3.0 / secs
        );
    }

    /// The equilibria docs/economy.md §11 asserts rather than codes, the
    /// ones that need weeks to show: prices nudged for a month, a purse
    /// run down, jobs changed. Each runs a season of the same town as
    /// `a_town_thinks_within_budget`, and each is `#[ignore]`d for the
    /// same reason: `cargo test season -- --ignored --nocapture`. What a
    /// single sale or delivery guarantees is a unit test in `economy.rs`.
    ///
    /// Everything the mayor could place, and a warehouse to feed it. Thirty
    /// days is a season until something says otherwise; `DAYS=8` runs a
    /// shorter one, to see a town drift in a few minutes rather than ten.
    fn season_days() -> u64 {
        std::env::var("DAYS").ok().and_then(|d| d.parse().ok()).unwrap_or(30)
    }

    /// §11.5, the band: over a season no posted price leaves the band
    /// between the edge's price less the delivery and the edge's price
    /// plus the drive to the edge in the resident's hours, and no wage
    /// falls below the edge's less the commute. §11.8, no ringing: at
    /// steady state a price's day-to-day variance stays under a bound.
    #[test]
    #[ignore]
    fn season_the_band_holds_and_nothing_rings() {
        use crate::economy::{edge_price, EDGE_WAGE};
        let mut prices: std::collections::BTreeMap<(EntityId, crate::needs::Need), Vec<f64>> = Default::default();
        let (world, _) = season(&town_mix(), season_days(), |world, _, _| {
            for e in world.objects.iter() {
                let GameObject::Building(ref b) = e.object else { continue };
                if world.edge.contains(&e.id) {
                    continue;
                }
                for (&need, &p) in &b.prices {
                    prices.entry((e.id, need)).or_default().push(p);
                }
            }
        });
        // The drive to the edge, in hours: what the edge's price is plus.
        let hour = DAY_MS as f64 / 24.0;
        let drive_h = |id: EntityId| {
            let p = world.objects.get(id).unwrap().position.unwrap();
            let e = world.objects.get(world.nearest_edge(p).unwrap()).unwrap().position.unwrap();
            ((p.x - e.x).abs().max((p.y - e.y).abs()) as f64 / crate::car::CRUISE_SPEED * 1000.0) / hour
        };
        for (&(id, need), series) in &prices {
            let kind = match world.objects.get(id).map(|e| &e.object) {
                Some(GameObject::Building(b)) => b.kind,
                _ => unreachable!(),
            };
            let (lo, hi) = (crate::economy::unit_cost(kind, need), edge_price(need) + drive_h(id) * EDGE_WAGE);
            for &p in series {
                assert!(p >= lo - 1e-9 && p <= hi + 1e-9, "building {id} sold {need:?} at {p}, outside [{lo}, {hi}]: {series:.2?}");
            }
            // Steady state is the last third of the season. Ringing is a
            // price that turns around day after day; a price still
            // settling turns around never, and one pinned to the band's
            // edge steps a notch up and back — over the edge's delivered
            // price it piles up, under it it sells out — which is the
            // step's own size, not a ring.
            let tail = &series[series.len().saturating_sub((series.len() / 3).max(3))..];
            let turns = tail.windows(3).filter(|w| (w[1] - w[0]) * (w[2] - w[1]) < 0.0).count();
            let (lo, hi) = tail.iter().fold((f64::INFINITY, 0.0f64), |(lo, hi), &p| (lo.min(p), hi.max(p)));
            assert!(turns <= 2 || hi / lo <= (1.0 + crate::economy::PRICE_UP).powi(2) + 1e-9, "building {id}'s {need:?} price rings: {tail:.2?}");
            println!("{id} {need:?}: {:.2} → {:.2}", series[0], series[series.len() - 1]);
        }
    }

    /// The services picture at a midnight: stocks empty, calls open,
    /// and what the town's homes drew against what they were served.
    fn services_report(world: &World) -> String {
        use crate::needs::Need;
        let (mut empty, mut homes_empty) = (0, 0);
        for e in world.objects.iter() {
            let GameObject::Building(ref b) = e.object else { continue };
            if b.stocks.get(&Need::Services).is_some_and(|s| s.level <= 0.0) {
                empty += 1;
                if crate::blueprint::blueprint(b.kind).homes > 0 {
                    homes_empty += 1;
                }
            }
        }
        let open = world.calls.iter().filter(|c| c.good == Need::Services).count();
        let waiting = world.calls.iter().filter(|c| c.good == Need::Services && c.answered_by.is_none()).count();
        format!("{empty} services stocks empty ({homes_empty} homes), {open} services calls open, {waiting} unanswered")
    }

    /// §11.6, no harm: a town built ignoring every price ends the season
    /// with more in the treasury than it began. Every building in the red
    /// on the last day is printed with what it cost, and every one that
    /// took nothing: that is the town's to read (§9), not a failure.
    #[test]
    #[ignore]
    fn season_no_harm() {
        let days = season_days();
        let mut last_gdp = 0.0;
        let mut began = 0.0;
        let (world, _) = season(&town_mix(), days, |world, day, _| {
            if day == 1 {
                let door = world.income.before(DAY_MS as u64);
                began = world.treasury - door.revenue + door.purchases;
            }
            let door = world.income.before(day * DAY_MS as u64);
            println!("day {day}: treasury {:.1}, GDP {:.1}, at the door in {:.1} out {:.1}; {}", world.treasury, world.gdp - last_gdp, door.revenue, door.purchases, services_report(world));
            last_gdp = world.gdp;
            for e in world.objects.iter() {
                let GameObject::Building(ref b) = e.object else { continue };
                if crate::economy::sells(b.kind).next().is_some() && !crate::economy::depot(b.kind) && !world.edge.contains(&e.id) {
                    let page = world.books.get(&e.id).map(|k| k.before(day * DAY_MS as u64).clone()).unwrap_or_default();
                    if page.revenue == 0.0 {
                        println!("  {} {:?} took nothing: stocks {:?}, prices {:?}, wages {:.2}", e.id, b.kind, b.stocks, b.prices, page.wages);
                    }
                }
            }
        });
        let mut ids: Vec<EntityId> = world.objects.iter().filter(|e| matches!(e.object, GameObject::Building(_)) && !world.edge.contains(&e.id)).map(|e| e.id).collect();
        ids.sort_unstable();
        for id in ids {
            let GameObject::Building(ref b) = world.objects.get(id).unwrap().object else { unreachable!() };
            let page = world.books.get(&id).map(|k| k.before(days * DAY_MS as u64).clone()).unwrap_or_default();
            let margin = page.revenue - page.purchases - page.wages;
            let staff = world.objects.iter().filter(|e| matches!(e.object, GameObject::Resident(ref r) if r.work == Some(id))).count();
            println!("{id} {:?}: {staff} of {} desks, {:.1} hours; in {:.1} out {:.1} wages {:.1} margin {margin:.1}{}", b.kind, crate::blueprint::blueprint(b.kind).jobs, page.hours, page.revenue, page.purchases, page.wages, if margin < 0.0 { " — in the red" } else { "" });
        }
        let at_the_edge = world.objects.iter().filter(|e| matches!(e.object, GameObject::Resident(ref r) if r.work.is_some_and(|w| world.edge.contains(&w)))).count();
        println!("{at_the_edge} residents work beyond the edge");
        assert!(world.treasury > began, "the season ended with {} in the treasury, from {began}", world.treasury);
    }

    /// §11.12, the bare towns: a street of homes and nothing else, whose
    /// people commute to the edge; a street of workplaces and nothing
    /// else, staffed from beyond it; and the full town. Treasury and GDP
    /// per resident-day for each. A house nets its household's saving and
    /// no more, so the bedroom town may not beat the full town by more
    /// than that, and it is the poorer town by GDP; imported labour pays
    /// the crossing and the drive, so the job centre earns less than the
    /// full town.
    #[test]
    #[ignore]
    fn season_bare_towns() {
        use BuildingKind::*;
        let days = season_days();
        let mut rates = Vec::new();
        let mut gdps = Vec::new();
        for (name, mix) in [("full", town_mix()), ("bedroom", vec![House, Apartment]), ("job centre", vec![Office, Factory, Workshop])] {
            let mut began = 0.0;
            let (world, _) = season(&mix, days, |world, day, _| {
                if day == 1 {
                    let door = world.income.before(DAY_MS as u64);
                    began = world.treasury - door.revenue + door.purchases;
                }
                let door = world.income.before(day * DAY_MS as u64);
                println!("{name} day {day}: treasury {:.1}, at the door in {:.1} out {:.1}; {}", world.treasury, door.revenue, door.purchases, services_report(world));
            });
            let residents = world.resident_ids().len().max(1);
            let rate = (world.treasury - began) / residents as f64 / days as f64;
            let gdp = world.gdp / residents as f64 / days as f64;
            println!("{name}: treasury {:.1} and GDP {:.1} over {days} days, {residents} residents: {rate:.3} and {gdp:.2} GDP a resident-day", world.treasury, world.gdp);
            rates.push(rate);
            gdps.push(gdp);
        }
        let saving = 8.0 * crate::economy::EDGE_WAGE * crate::economy::SAVING;
        assert!(rates[1] <= rates[0] + saving, "the bedroom town is a mint: {rates:.3?}");
        assert!(gdps[1] < gdps[0], "the bedroom town is the richer one: {gdps:.2?}");
        assert!(rates[2] <= rates[0], "the job centre out-earns the full one: {rates:.3?}");
    }

    /// §11.11, tenure: over a season the share of residents who change
    /// jobs in a month is nowhere near a storm. The referent is about one
    /// in forty; what this town can show is that wages do not churn it.
    #[test]
    #[ignore]
    fn season_tenure() {
        let mut jobs: std::collections::BTreeMap<EntityId, Option<EntityId>> = Default::default();
        let mut changes = 0u32;
        let mut wakes_so_far = 0u64;
        let (world, _) = season(&town_mix(), season_days(), |world, day, wakes| {
            // Wakes per resident-day, day by day: a storm shows here first.
            println!("day {day}: {} wakes per resident", (wakes - wakes_so_far) / world.resident_ids().len().max(1) as u64);
            wakes_so_far = wakes;
            let kind_of = |b: Option<EntityId>| match b.and_then(|b| world.objects.get(b)).map(|e| &e.object) {
                Some(GameObject::Building(b)) => format!("{:?}", b.kind),
                _ => "none".into(),
            };
            let mut today: Vec<String> = Vec::new();
            for id in world.resident_ids() {
                let work = match world.objects.get(id).map(|e| &e.object) {
                    Some(GameObject::Resident(r)) => r.work,
                    _ => None,
                };
                if let Some(&had) = jobs.get(&id)
                    && had != work
                    && day > 1
                {
                    changes += 1;
                    today.push(format!("{} → {}", kind_of(had), kind_of(work)));
                }
                jobs.insert(id, work);
            }
            if !today.is_empty() {
                println!("day {day}: {}", today.join(", "));
            }
        });
        let share = changes as f64 / world.resident_ids().len() as f64;
        println!("{changes} job changes among {} residents in a season: {:.3} a month", world.resident_ids().len(), share);
        assert!(share <= 0.25, "{share} of residents changed jobs in a month");
    }

    #[test]
    fn the_same_town_lives_the_same_days() {
        let (three, [shop, lunch]) = arrival_log(3);
        let (one, _) = arrival_log(1);
        // Seventeen people, each at least driving in, to work, and home.
        assert!(one.len() >= 17 * 3, "only {} moves logged", one.len());
        assert_eq!(three[..one.len()], one[..], "the first day differs between runs");
        assert!(three.len() > one.len(), "nobody moved on the second day");

        // The third day is a settled one. Every trip is two changes of
        // `at` — into the car, out at the door — and a day is at most seven
        // trips: to the pump and back, if the tank ran dry overnight; to
        // work; out for lunch and back; out for the evening near work; and
        // home. The shop workers eat where they stand; the office has a
        // shop next door, so its workers drive to it.
        let day = DAY_MS as u64;
        let two = &three[..];
        let settled = 2 * day;
        let mut moves = std::collections::BTreeMap::new();
        for &(_, id, ..) in two.iter().filter(|&&(t, ..)| t >= settled) {
            *moves.entry(id).or_insert(0) += 1;
        }
        assert_eq!(moves.len(), 17, "everyone went out on day three");
        assert!(moves.values().all(|&n| n % 2 == 0 && (4..=14).contains(&n)), "someone thrashed: {moves:?}");
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
            .filter(|&&(t, _, at, sel)| t >= settled && at == Some(lunch) && sel == Some(Need::Eat))
            .map(|&(t, ..)| t)
            .collect();
        // A meal out costs a fifth of an hour's wage, so some wait for
        // dinner and some eat at home: half the office, not all of it.
        assert!(arrivals.len() >= 6, "only {} came for lunch", arrivals.len());
        let span = arrivals.iter().max().unwrap() - arrivals.iter().min().unwrap();
        assert!(span >= 2 * hour, "lunch was a crush: {:.1}h", span as f64 / hour as f64);
        let (mut present, mut most) = (std::collections::BTreeSet::new(), 0);
        for &(_, id, at, sel) in two.iter().filter(|&&(t, ..)| t >= settled) {
            if at == Some(lunch) && sel == Some(Need::Eat) { present.insert(id); } else { present.remove(&id); }
            most = most.max(present.len());
        }
        assert!(most <= 12, "{most} eating at a twelve-spot shop at once");

        // Time off is never more important than work (its rate is below the
        // job's), so an outing happens after the shift, on an evening when
        // enough of it has piled up: never for everyone at once.
        let outings: Vec<f64> = two
            .iter()
            .filter(|&&(t, _, _, sel)| t >= settled && sel == Some(Need::Leisure))
            .filter(|&&(_, _, at, _)| at == Some(shop) || at == Some(lunch))
            .map(|&(t, ..)| (t % day) as f64 / hour as f64)
            .collect();
        assert!(outings.iter().all(|&h| h >= 17.0), "an outing during the shift: {outings:.1?}");
        assert!(outings.len() < 17, "everyone out every night: {outings:.1?}");
    }

    /// A household with nowhere in town to work still works: the job is
    /// beyond the edge, and the commute out to it is the whole price of not
    /// having built one. Nothing is missing, so nothing shows as missing —
    /// that is what the edge is for.
    #[test]
    fn a_town_without_jobs_sends_its_people_beyond_the_edge() {
        let mut world = street();
        let home = build(&mut world, 0, BuildingKind::House, 1);
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        let people = world.resident_ids();
        assert_eq!(people.len(), 2);
        let work: Vec<EntityId> = people
            .iter()
            .filter_map(|&id| match world.objects.get(id).unwrap().object {
                GameObject::Resident(ref r) => r.work,
                _ => None,
            })
            .collect();
        assert_eq!(work.len(), 2, "both took a job");
        assert!(work.iter().all(|w| world.edge.contains(w)), "both work beyond the edge");

        // And they drive there: a day of it puts them at the edge, on the
        // clock, and back home again.
        let day = DAY_MS as u64;
        let mut seen_at_work = false;
        let mut now = 0;
        while step(&mut world, &mut events, &mut intersections, &mut now, day) {
            seen_at_work |= people.iter().any(|&id| {
                at_of(&world, id) == Some(work[0]) && doing(&world, id) == Some(crate::needs::Need::Work)
            });
        }
        assert!(seen_at_work, "nobody ever got to the job beyond the edge");
        assert!(people.iter().any(|&id| at_of(&world, id) == Some(home)), "and somebody came home");

        // Nothing at all was on offer nowhere: the edge answers everything.
        let d = crate::resident::demand(&world, day);
        assert_eq!(d["unmet"].as_array().unwrap().len(), 0, "{}", d["unmet"]);
    }

    /// Nothing crosses the door at zero (docs/economy.md §8.2, §9): a
    /// broke town's desks are not filled from beyond the edge, and nobody
    /// eats there until the first shift is sold; then the door has
    /// something in it and they do, which is labour as the export of last
    /// resort, and why zero is a slump and not an end.
    #[test]
    fn a_broke_town_buys_nothing_beyond_the_edge_until_it_sells() {
        let mut world = street();
        build(&mut world, 0, BuildingKind::Apartment, 2); // seven people
        let office = build(&mut world, 30, BuildingKind::Office, 2); // twelve desks
        world.treasury = 0.0;
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        let people = world.resident_ids();
        let is = |world: &World, id: EntityId, f: &dyn Fn(&crate::protocol::Resident) -> bool| matches!(world.objects.get(id).unwrap().object, GameObject::Resident(ref r) if f(r));
        assert!(people.iter().all(|&id| is(&world, id, &|r| !world.edge.contains(&r.home))), "the edge sold labour to a town that cannot pay");
        assert_eq!(people.iter().filter(|&&id| is(&world, id, &|r| r.work == Some(office))).count(), 7, "the office has its town's seven and no more");
        let day = DAY_MS as u64;
        let (mut ate_out_broke, mut ate_out_paid, mut first_sale) = (false, false, None);
        let mut now = 0;
        while step(&mut world, &mut events, &mut intersections, &mut now, 2 * day) {
            let door = world.income.on(now).revenue + world.income.before(now).revenue;
            if door > 0.0 && first_sale.is_none() {
                first_sale = Some(now);
            }
            let out = people.iter().any(|&id| at_of(&world, id).is_some_and(|a| world.edge.contains(&a)) && doing(&world, id) == Some(crate::needs::Need::Eat));
            if first_sale.is_none() {
                ate_out_broke |= out;
            } else {
                ate_out_paid |= out;
            }
        }
        assert!(!ate_out_broke, "somebody ate beyond the edge on the town's empty purse");
        assert!(first_sale.is_some(), "the office never sold a shift");
        assert!(ate_out_paid, "with money in the door nobody ate beyond the edge");
    }

    /// A vacancy the city cannot fill from among its own is filled from off
    /// the map: someone whose home is the road exit, who drives in to work
    /// and is gone again by night.
    #[test]
    fn a_job_nobody_in_town_fills_is_filled_from_the_edge() {
        let mut world = street();
        build(&mut world, 0, BuildingKind::House, 1); // two people
        let office = build(&mut world, 30, BuildingKind::Office, 2); // twelve jobs
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);

        let jobs = crate::blueprint::blueprint(BuildingKind::Office).jobs as usize;
        let staff: Vec<EntityId> = world
            .resident_ids()
            .into_iter()
            .filter(|&id| matches!(world.objects.get(id).unwrap().object, GameObject::Resident(ref r) if r.work == Some(office)))
            .collect();
        assert_eq!(staff.len(), jobs, "every desk is taken");
        let commuters: Vec<EntityId> = staff
            .iter()
            .copied()
            .filter(|&id| matches!(world.objects.get(id).unwrap().object, GameObject::Resident(ref r) if world.edge.contains(&r.home)))
            .collect();
        assert_eq!(commuters.len(), jobs - 2, "the ten the town cannot house live off the map");

        // They drive in like anyone else, and the office fills up.
        let day = DAY_MS as u64;
        let mut at_desk = 0;
        let mut now = 0;
        while step(&mut world, &mut events, &mut intersections, &mut now, day) {
            at_desk = at_desk.max(commuters.iter().filter(|&&id| at_of(&world, id) == Some(office)).count());
        }
        assert!(at_desk >= 2, "only {at_desk} of the commuters ever reached the office");

        // Pull the office down and the commuters go with it: nobody lives at
        // the edge for its own sake.
        world.remove_building(office);
        world.settle();
        assert!(
            commuters.iter().all(|&id| world.objects.get(id).is_none()),
            "someone stayed on at the edge with no job to come in for",
        );
    }

    /// With no shop in town, a hungry resident drives out to the edge for a
    /// meal — the edge is a building with a kitchen like any other, found by
    /// the same search.
    #[test]
    fn with_nothing_in_town_a_meal_is_had_beyond_the_edge() {
        let mut world = street();
        build(&mut world, 0, BuildingKind::Apartment, 2);
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        let people = world.resident_ids();

        let day = DAY_MS as u64;
        let mut ate_out = 0;
        let mut now = 0;
        while step(&mut world, &mut events, &mut intersections, &mut now, 2 * day) {
            ate_out = ate_out.max(
                people
                    .iter()
                    .filter(|&&id| {
                        at_of(&world, id).is_some_and(|a| world.edge.contains(&a))
                            && doing(&world, id) == Some(crate::needs::Need::Eat)
                    })
                    .count(),
            );
        }
        assert!(ate_out > 0, "nobody drove to the edge to eat");
        // And the city earned nothing by it: that meal was sold off the map.
        let d = crate::resident::demand(&world, 2 * day);
        let sold_at_the_edge = d["delivered"].as_array().unwrap().iter().any(|v| {
            world.edge.contains(&(v["building"].as_u64().unwrap() as EntityId)) && v["need"] == "Eat"
        });
        assert!(sold_at_the_edge, "the edge's books show no meals");
        // And GDP is the town's value only: what the books of everything
        // in town served, over the two pages they keep, at the world's
        // prices, plus the nights — never the edge's meals.
        let hour = DAY_MS as f64 / 24.0;
        let worth = |id: &EntityId, page: &crate::economy::Day| -> f64 {
            let kind = match world.objects.get(*id).map(|e| &e.object) {
                Some(GameObject::Building(b)) => b.kind,
                _ => return 0.0,
            };
            page.served.iter().map(|(&need, h)| h * hour / need.unit() * crate::economy::value(kind, need)).sum()
        };
        let in_town: f64 = world.books.iter().filter(|(id, _)| !world.edge.contains(id)).map(|(id, k)| worth(id, k.before(2 * day)) + worth(id, k.on(2 * day))).sum();
        let with_edge: f64 = world.books.iter().map(|(id, k)| worth(id, k.before(2 * day)) + worth(id, k.on(2 * day))).sum();
        // What is over the town's books is nights: the households'
        // services, drawn as the two days passed, and no more than that.
        let nights = world.gdp - in_town;
        let two_days = 2.0 * people.len() as f64 * crate::economy::services();
        assert!(nights > 0.0 && nights <= two_days + 1e-6, "GDP is not the town's value plus its nights: {} against {in_town}", world.gdp);
        assert!(with_edge > in_town, "GDP counts the edge's meals: {} against {in_town} in town, {with_edge} with the edge", world.gdp);
    }
}
