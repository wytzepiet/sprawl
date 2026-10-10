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
use crate::protocol::{Build, ChunkBounds, ChunkCoord, ClientMessage, Clock, DAY_MS, EntityId, GameObject, GameObjectEntry, Operation, OwnerId, Lump, ServerMessage, StateUpdate, Tool, GridCoord};
use crate::world::chunk_of;
use crate::world::{Link, World};

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

/// What a save does not keep, rebuilt from what it does, as the game
/// opens it.
fn restore(world: &mut World) {
    world.rebuild_edges();
    world.rebuild_node_cars();
    world.rebuild_occupied();
    world.restore_spots();
    world.rebuild_laid();
    world.doors_from_drives();
}

pub async fn run(mut commands: mpsc::UnboundedReceiver<Command>) {
    let db_path = db_path();
    let fixtures = std::env::var("SPRAWL_FIXTURES").ok();
    // Fixtures are built fresh on every start, at noon, standing still: the
    // same pictures every time, lit the same way.
    let (mut world, mut sim_time) = if fixtures.is_some() { (World::new(), DAY_MS as GameTime / 2) } else { load_world(&db_path) };
    let mut events: EventQueue = EventQueue::new();
    let mut intersections = IntersectionRegistry::new();
    let mut clients: HashMap<ClientId, ClientState> = HashMap::new();

    // Terrain is derived from the seed, so it is regenerated on every start
    // rather than persisted. A fresh world is the bare island: no road is
    // born with the map.
    let fresh = world.objects.is_empty();
    if let Some(dir) = &fixtures {
        crate::fixtures::build(&mut world, std::path::Path::new(dir));
    } else {
        if fresh {
            world.terrain_seed = new_seed();
        }
        world.terrain = crate::terrain::generate(world.terrain_seed);
        println!("terrain: {} tiles from seed {}", world.terrain.len(), world.terrain_seed);
        world.raise_mountains();
    }

    // Rebuild edges/indices and schedule car spawns for loaded buildings
    if !world.objects.is_empty() && fixtures.is_none() {
        restore(&mut world);
        println!("loaded {} objects from db", world.objects.len());
    }
    // Whatever is standing gets its people, whether it was just laid out or
    // loaded from a save written before anyone lived here, and the day is
    // due to turn. Then everyone thinks once — trips do not survive a save,
    // so a loaded world is entirely people standing still until they do.
    world.resettle();
    settle_and_wake(&mut world, &mut events);
    for id in world.resident_ids() {
        wake_resident(&world, &mut events, id);
    }

    let mut tick_interval = interval(Duration::from_millis(STEP_MS));
    let mut last_persist = Instant::now();
    let mut speed: u32 = if fixtures.is_some() { 0 } else { 1 };

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
                        world.raise_mountains();
                        world.resettle();
                        settle_and_wake(&mut world, &mut events);
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
                        Ask::Town => crate::economy::town(&world, now),
                        Ask::Map { x, y, r } => crate::fixtures::draw(&world, x, y, r).into(),
                        Ask::Call(id) => {
                            // Its shelf, emptied: a depot fetches, a maker
                            // is full again by tomorrow, anything else
                            // calls for stock.
                            if let Some(GameObject::Building(b)) = world.objects.get_mut(id).map(|e| &mut e.object) {
                                for need in crate::economy::shelves(b.kind) {
                                    if let Some(stock) = b.stocks.get_mut(&need) {
                                        stock.level = 0.0;
                                    }
                                }
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
        // Whatever the commands built, reached, cut off or took away
        // settles once for the batch: the road brush sends a command a tile.
        settle_and_wake(&mut world, &mut events);

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
/// never has to ask for the seed or the island's extent separately.
fn state_update(world: &World, ops: Vec<Operation>, lumps: Vec<Lump>, clk: Clock) -> ServerMessage {
    ServerMessage::Update(StateUpdate {
        ops,
        lumps,
        clock: clk,
        growth: crate::economy::growth(world, clk.now),
        sea: crate::haul::sea(world, clk.now),
        terrain_seed: world.terrain_seed,
        island: ChunkBounds { min_cx: crate::terrain::CHUNKS_MIN, min_cy: crate::terrain::CHUNKS_MIN, max_cx: crate::terrain::CHUNKS_MAX, max_cy: crate::terrain::CHUNKS_MAX },
    })
}

fn load_world(db_path: &Path) -> (World, GameTime) {
    let (entries, meta) = persistence::load(db_path);
    let mut world = if entries.is_empty() {
        World::new()
    } else {
        // What the city has served, and what the mayor has, outlive a
        // restart; a fresh world keeps its stake.
        let mut world = World::from_loaded(Tracked::load(entries, meta.next_id), meta.terrain_seed);
        world.gdp = meta.gdp;
        world.treasury = meta.treasury;
        world.build = crate::tree::Build::load(meta.taken);
        world
    };
    // SPRAWL_ALL: the whole tree and a bottomless treasury, to test any building.
    if std::env::var("SPRAWL_ALL").is_ok() {
        world.build = crate::tree::Build::all();
        world.treasury = 1_000_000.0;
    }
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
        ClientMessage::Build(Build { tool, from, to }) => {
            // Said out loud: a click that does nothing is the kind of bug
            // that otherwise takes an afternoon to find.
            if !may(world, tool, from, to) {
                println!("refused: {tool:?} from {from:?} to {to:?}");
                return;
            }
            match tool {
                Tool::Street | Tool::OneWay | Tool::Road => {
                    let one_way = tool == Tool::OneWay;
                    let (from_id, to_id) = (world.road_node_at(from), world.road_node_at(to));
                    world.handle_place_road(from, to, one_way, tool == Tool::Road);
                    // Insert edges for newly created connections
                    if let (Some(f), Some(t)) = (world.road_node_at(from), world.road_node_at(to))
                        && (from_id.is_none() || to_id.is_none() || !world.edges.contains_key(&(f, t)))
                    {
                        world.insert_edge(f, t);
                        if !one_way {
                            world.insert_edge(t, f);
                        }
                    }
                }
                Tool::Building(kind) => {
                    world.paint(kind, from, to);
                }
                Tool::Demolish => {
                    // A tap takes everything on the tile: its road and all
                    // its links, the cars on it rerouted, or the building's
                    // tile. A step cuts only what joins the two tiles: the
                    // road between them, a door, a row.
                    if from == to {
                        if let Some(id) = world.road_node_at(to) {
                            handle_road_demolish(world, events, intersections, id, now);
                        }
                        world.unpaint(to);
                    } else {
                        match world.link_between(from, to) {
                            Some(Link::Road(a, b)) => handle_link_demolish(world, events, intersections, a, b, now),
                            Some(Link::Door(id)) => world.close_door(id),
                            Some(Link::Row(a, b)) => world.unlink(a, b),
                            None => {}
                        }
                    }
                }
            }
        }
        ClientMessage::DespawnAllCars => {
            let car_ids: Vec<EntityId> = world.objects.iter()
                .filter(|e| matches!(e.object, GameObject::Car(ref c) if c.trip.is_some()))
                .map(|e| e.id)
                .collect();
            for car_id in car_ids {
                park_at_home(world, intersections, events, car_id);
            }
        }
        ClientMessage::Order { depot, good, boxes } => crate::haul::order(world, events, depot, good, boxes),
        ClientMessage::SetRule { depot, good, rule } => crate::haul::set_rule(world, events, depot, good, rule, now),
        ClientMessage::Standing { depot, on } => crate::haul::set_standing(world, events, depot, on),
        ClientMessage::Send { depot } => crate::haul::send(world, events, depot),
        ClientMessage::Sell { depot, good } => crate::haul::sell(world, events, depot, good),
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

/// May the mayor's hand take this step with this tool: the build's gate
/// (what it has opened, how much road is left to lay, what a tile costs),
/// and the world's own rule for the step. The one rule a step is refused
/// by. The client works out the same where it draws the hand's dots
/// (`client/src/engine/may.ts`): a change here is a change there.
pub fn may(world: &World, tool: Tool, from: GridCoord, to: GridCoord) -> bool {
    match tool {
        Tool::Street | Tool::OneWay | Tool::Road => {
            let one_way = tool == Tool::OneWay;
            // Into a building is its door: nothing is laid on its tile, and
            // a through road is no door, nothing fronting onto one.
            let door = world.occupied.contains_key(&(to.x, to.y));
            // Each end that is not standing yet is a tile laid.
            let new_tiles = world.road_node_at(from).is_none() as u32 + (!door && world.road_node_at(to).is_none()) as u32;
            !(door && tool == Tool::Road)
                && world.build.may_draw(one_way, tool == Tool::Road)
                && world.laid + new_tiles <= world.build.road_tiles()
                && world.may_lay(from, to, one_way)
        }
        // A building costs timber, not coins: it is placed as a site and
        // waits for its timber (docs/game.md §Buildings).
        Tool::Building(kind) => {
            world.build.may_place(kind)
                && world.may_paint(kind, from, to)
                && world.would_be_reached(kind, from, to)
        }
        Tool::Demolish if from == to => world.road_node_at(to).is_some() || world.occupied.contains_key(&(to.x, to.y)),
        Tool::Demolish => world.link_between(from, to).is_some(),
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

    drop_orphans(world, intersections, events, &neighbor_ids);
}

/// Cut the road between two nodes, both ways, rerouting whatever was to
/// drive it; a node left with no road goes.
fn handle_link_demolish(
    world: &mut World,
    events: &mut EventQueue,
    intersections: &mut IntersectionRegistry,
    a: EntityId,
    b: EntityId,
    now: GameTime,
) {
    let cut = |x: EntityId, y: EntityId| (x == a && y == b) || (x == b && y == a);
    let cars: Vec<(EntityId, EntityId, EntityId)> = world
        .node_cars
        .get(&a)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|car_id| {
            let GameObject::Car(ref car) = world.objects.get(car_id)?.object else { return None };
            let trip = car.trip.as_ref()?;
            let (route, ri) = (&trip.route, trip.route_index);
            if !route[ri.saturating_sub(1)..].windows(2).any(|w| cut(w[0], w[1])) {
                return None;
            }
            // On the link itself, it turns back from where it came onto it.
            let from = if ri > 0 && cut(route[ri - 1], route[ri]) { route[ri - 1] } else { route[ri] };
            Some((car_id, from, trip.destination))
        })
        .collect();
    world.unlink_roads(a, b);
    for (car_id, from, dest) in cars {
        if !try_reroute(world, intersections, events, car_id, from, dest, now) {
            park_at_home(world, intersections, events, car_id);
        }
    }
    drop_orphans(world, intersections, events, &[a, b]);
}

/// Road nodes among these left with no road: gone, and anything routed
/// over one sent home.
fn drop_orphans(world: &mut World, intersections: &mut IntersectionRegistry, events: &mut EventQueue, nodes: &[EntityId]) {
    for &nid in nodes {
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
    let Some(ways) = world.ways_to(dest, from_node) else { return false };
    // The spot it was heading for is still its own.
    let Some((new_route, to_lot)) = world.way_in(dest, car_id, &ways, now, GameTime::MAX) else { return false };

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
    let woken = intersections.remove_car_from_all(car_id, now);
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

    let backing = crate::car::spawn::backing(0, world.reverse_tail(car_id), new_route.len());
    let arriving = world.kerb_stretch(car_id);
    if let Some(entry) = world.objects.get_mut(car_id)
        && let GameObject::Car(ref mut car) = entry.object
        && let Some(ref mut t) = car.trip
    {
        t.route = new_route;
        t.route_positions = route_positions;
        t.from_lot = 0;
        t.to_lot = to_lot;
        t.backing = backing;
        t.stretches[1] = arriving;
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
        // A building's wake is its turn: a farm whose crop has ripened.
        Some(GameObject::Building(_)) => crate::calls::turn(world, events, id, now),
        // Midnight: every building takes its turn, and every line reads
        // the labour market again.
        None if id == MIDNIGHT => {
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

/// Population follows what changed, and whoever's situation changed gets to
/// think about it. And the day is always due to turn.
fn settle_and_wake(world: &mut World, events: &mut EventQueue) {
    for id in world.settle() {
        wake_resident(world, events, id);
    }
    // A harbour reached, or cut off: the town's way out, and its ferry.
    world.mark_harbours(events.now());
    // Their ferries and tugs read the time from where they stand, so a
    // wake too many is no harm, and one too few after a load would be.
    let harbours: Vec<EntityId> = world.harbours.keys().copied().collect();
    for h in harbours {
        for id in [world.ferry_of(h), world.tug_of(h)].into_iter().flatten() {
            events.wake(0, id);
        }
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
    // are sent, and panning inside a chunk sends nothing at all. The whole
    // island is seen from the first minute: there is no fog.
    for &coord in visible_chunks.iter() {
        if cs.known_chunks.insert(coord) {
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
    // Money that landed, for whoever is looking at where it landed.
    let lumps: Vec<(ChunkCoord, Lump)> = std::mem::take(&mut world.lumps)
        .into_iter()
        .filter_map(|s| Some((chunk_of(world.objects.get(s.building)?.position?), s)))
        .collect();

    if changed.is_empty() && removed.is_empty() && crossings.is_empty() && lumps.is_empty() {
        return;
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
        let lumps: Vec<Lump> = lumps.iter().filter(|(c, _)| cs.known_chunks.contains(c)).map(|(_, s)| *s).collect();

        if !ops.is_empty() || !lumps.is_empty() {
            let _ = cs.sender.send(state_update(world, ops, lumps, clk));
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
    use crate::protocol::{BuildingKind, Good, GridCoord, TerrainType};

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
            b.stocks.get_mut(&Good::Crates).unwrap().take(units);
        }
        calls::turn(world, events, shop, now);
    }

    /// The first shelf, as a fraction of full.
    fn stock(world: &World, building: EntityId) -> f64 {
        match world.objects.get(building).unwrap().object {
            GameObject::Building(ref b) => {
                let s = &b.stocks[&crate::economy::shelves(b.kind)[0]];
                s.level / s.cap
            }
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

    /// Where the test street's harbour stands, at its east end.
    const HARBOUR_X: i32 = 258;

    /// One long street with room to build beside it, and at its east end
    /// the coast and a harbour: the door everyone and everything comes in
    /// by. Deep enough for a supermarket and its lot behind the street, and
    /// a farm's track and fields beyond that; the sea is open to the south
    /// of the harbour, and runs off the map.
    fn street() -> World {
        let mut world = World::new();
        for y in -6..60 {
            for x in -4..300 {
                let sea = x >= HARBOUR_X - 2 && y >= 4;
                if sea || y < 14 {
                    world.terrain.insert((x, y), if sea { TerrainType::Sea } else { TerrainType::Grass });
                }
            }
        }
        let street: Vec<GridCoord> = (-2..HARBOUR_X + 6).map(|x| GridCoord { x, y: 0 }).collect();
        world.place_road_path(&street);
        world.place_on_street(GridCoord { x: HARBOUR_X, y: 1 }, BuildingKind::Harbour).expect("the coast takes a harbour");
        world
    }

    fn harbour_of(world: &World) -> EntityId {
        *world.occupied.get(&(HARBOUR_X, 1)).expect("the street's harbour")
    }

    /// The rule says what the hand will do: a house may be tapped down
    /// beside the street and not on it; a street may be drawn off the
    /// street and not along it again, nor onto water; demolishing finds
    /// what stands. The client's dots (`may.ts`) answer the same.
    #[test]
    fn the_rule_of_where_the_hand_may_go_is_what_it_does() {
        let mut world = street();
        world.build = crate::tree::Build::all();
        world.treasury = 1e9;
        let at = |x, y| GridCoord { x, y };
        let house = Tool::Building(BuildingKind::House);
        assert!(may(&world, house, at(5, 1), at(5, 1)), "beside the street");
        assert!(!may(&world, house, at(5, 0), at(5, 0)), "not on it");
        assert!(!may(&world, house, at(5, 3), at(5, 3)), "nor where no street reaches");
        world.terrain.insert((5, 1), TerrainType::Water);
        assert!(!may(&world, Tool::Street, at(5, 0), at(5, 1)), "nor a street onto water");
        world.terrain.insert((5, 1), TerrainType::Grass);
        assert!(may(&world, Tool::Street, at(5, 0), at(5, 1)), "off the street toward +y");
        assert!(!may(&world, Tool::Street, at(5, 0), at(6, 0)), "not along it again");
        assert!(!may(&world, Tool::Demolish, at(5, 3), at(5, 3)), "nothing to take");
        assert!(may(&world, Tool::Demolish, at(5, 0), at(5, 0)), "a road to take");
        // And a step the rule refuses, the hand is refused.
        for dy in -1..=1 {
            for dx in -1..=1 {
                let (from, to) = (at(5, 0), at(5 + dx, dy));
                let allowed = may(&world, Tool::Street, from, to);
                let mut events = EventQueue::new();
                let mut intersections = IntersectionRegistry::new();
                let mut probe = street();
                probe.build = crate::tree::Build::all();
                let edges = probe.edges.len();
                handle_player_action(&mut probe, &mut events, &mut intersections, ClientMessage::Build(Build { tool: Tool::Street, from, to }), 0);
                assert_eq!(probe.edges.len() != edges, allowed, "step {dx},{dy}");
            }
        }
    }

    /// One tap of the demolisher takes a house, its drive with it: the
    /// drive is the house's, not a road on its tile.
    #[test]
    fn one_tap_takes_a_house_and_its_drive_with_it() {
        let mut world = street();
        world.build = crate::tree::Build::all();
        world.treasury = 1e9;
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        let at = GridCoord { x: 5, y: 1 };
        let mut hand = |world: &mut World, tool| handle_player_action(world, &mut events, &mut intersections, ClientMessage::Build(Build { tool, from: at, to: at }), 0);
        hand(&mut world, Tool::Building(BuildingKind::House));
        let house = world.occupied[&(5, 1)];
        assert!(world.door_of(house).is_some() && world.road_node_at(at).is_none(), "a house with its door, and no road on its tile");
        hand(&mut world, Tool::Demolish);
        assert!(!world.occupied.contains_key(&(5, 1)), "the house is gone");
        assert!(world.road_node_at(GridCoord { x: 5, y: 0 }).is_some(), "and the street stands");
    }

    /// A drag of the demolisher cuts only what it crosses: the road
    /// between two tiles, a door, a row of houses. A tap takes everything
    /// at the point.
    #[test]
    fn a_drag_cuts_a_link_and_a_tap_takes_the_point() {
        let mut world = street();
        world.build = crate::tree::Build::all();
        world.treasury = 1e9;
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        let at = |x, y| GridCoord { x, y };
        let mut hand = |world: &mut World, tool, from, to| handle_player_action(world, &mut events, &mut intersections, ClientMessage::Build(Build { tool, from, to }), 0);
        // A side street, two tiles long, off the main one.
        hand(&mut world, Tool::Street, at(5, 0), at(5, 1));
        hand(&mut world, Tool::Street, at(5, 1), at(5, 2));
        hand(&mut world, Tool::Demolish, at(5, 1), at(5, 2));
        assert!(!world.are_connected(at(5, 1), at(5, 2)), "the link is cut");
        assert!(world.road_node_at(at(5, 2)).is_none(), "and the end left with no road goes");
        assert!(world.are_connected(at(5, 0), at(5, 1)), "the rest stands");
        // A house's door, cut: the house stands, cut off.
        hand(&mut world, Tool::Building(BuildingKind::House), at(8, 1), at(8, 1));
        let house = world.occupied[&(8, 1)];
        let door = world.door_of(house).expect("a door").1;
        let street = world.objects.get(door).and_then(|e| e.position).unwrap();
        hand(&mut world, Tool::Demolish, street, at(8, 1));
        assert!(world.door_of(house).is_none() && world.occupied.contains_key(&(8, 1)), "the door shut, the house standing");
        // A row of three cut in the middle of it: the house at the end,
        // joined to nothing now, goes; cut again, so do the last two.
        hand(&mut world, Tool::Building(BuildingKind::House), at(11, 1), at(11, 1));
        hand(&mut world, Tool::Building(BuildingKind::House), at(11, 1), at(12, 1));
        hand(&mut world, Tool::Building(BuildingKind::House), at(12, 1), at(13, 1));
        assert!(may(&world, Tool::Demolish, at(12, 1), at(13, 1)), "a row to cut");
        hand(&mut world, Tool::Demolish, at(12, 1), at(13, 1));
        assert!(!world.occupied.contains_key(&(13, 1)), "the end goes");
        assert!(world.occupied.contains_key(&(11, 1)) && world.occupied.contains_key(&(12, 1)), "the rest stands");
        hand(&mut world, Tool::Demolish, at(11, 1), at(12, 1));
        assert!(!world.occupied.contains_key(&(11, 1)) && !world.occupied.contains_key(&(12, 1)), "two cut apart are two ends");
        // A tap takes the point and every link at it.
        hand(&mut world, Tool::Demolish, at(5, 0), at(5, 0));
        assert!(world.road_node_at(at(5, 0)).is_none());
        assert!(world.road_node_at(at(5, 1)).is_none(), "the side street left with no road goes too");
    }

    fn build(world: &mut World, x: i32, kind: BuildingKind, _w: u8) -> EntityId {
        world
            .place_on_street(GridCoord { x, y: 1 }, kind)
            .unwrap_or_else(|| panic!("the street should give a {kind:?} at x={x} its driveway"))
    }

    /// A save from when a drive was a road the mayor laid opens with it
    /// as the house's door, and the tile back. The drive used to go
    /// before the mayor's tiles were counted, and took one from nought.
    #[test]
    fn a_saved_drive_opens_as_a_door() {
        let mut world = World::new();
        for y in -8..8 {
            for x in -8..8 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        world.place_road_path(&[GridCoord { x: 0, y: 2 }, GridCoord { x: 4, y: 2 }]);
        let house = world.place_building(GridCoord { x: 2, y: 0 }, BuildingKind::House, 2).unwrap();
        world.place_road_path(&[GridCoord { x: 2, y: 2 }, GridCoord { x: 2, y: 1 }, GridCoord { x: 2, y: 0 }]);
        let drive = world.road_node_at(GridCoord { x: 2, y: 0 }).unwrap();
        if let Some(GameObject::RoadNode(n)) = world.objects.get_mut(drive).map(|e| &mut e.object) {
            n.laid = true;
        }
        world.laid = 0;

        restore(&mut world);

        assert!(world.objects.get(drive).is_none(), "the drive went");
        let street = world.road_node_at(GridCoord { x: 2, y: 1 }).unwrap();
        assert_eq!(world.door_of(house), Some((GridCoord { x: 2, y: 0 }, street)));
        assert_eq!(world.laid, 0);
    }

    /// A fresh world is the bare island: no road is born with the map, and
    /// nothing stands on it until the mayor builds.
    #[test]
    fn a_fresh_world_is_the_bare_island() {
        let mut world = World::new();
        world.terrain = crate::terrain::generate(7);
        restore(&mut world);
        world.resettle();
        assert!(world.objects.roads().next().is_none(), "a road was born with the map");
        assert!(world.all_buildings().is_empty() && world.resident_ids().is_empty(), "something stood on the island");
    }

    /// Where a car stands on the map, and how fast it goes along its route.
    fn whereabouts(world: &World, car: EntityId, now: GameTime) -> Option<([f64; 2], f64, usize)> {
        let GameObject::Car(ref c) = world.objects.get(car)?.object else { return None };
        let t = c.trip.as_ref()?;
        let (p, v) = crate::car::physics::catch_up(t.progress, t.speed, t.acceleration, (now - t.updated_at) as f64 / 1000.0);
        let mut s = 0.0;
        for k in 1..t.route.len() {
            let len = t.segment_lengths[k];
            if p <= s + len || k == t.route.len() - 1 {
                let f = ((p - s) / len).clamp(0.0, 1.0);
                let (a, b) = (t.route_positions[k - 1], t.route_positions[k]);
                return Some(([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], v, k));
            }
            s += len;
        }
        None
    }

    /// A car backing out of its drive waits for a gap in the street, backs
    /// out at a walking pace, all but stops where it changes gear, and the
    /// street waits for it once it has gone: whenever it sets out, with a
    /// car coming either way, the two never meet.
    #[test]
    fn a_car_backs_out_into_a_gap_and_the_street_waits_for_it() {
        for (dest_x, from_x) in [(40, 2), (0, 30)] {
            for start in (0..14_000).step_by(400) {
                let mut world = street();
                let home = build(&mut world, 10, BuildingKind::House, 1);
                let from = build(&mut world, from_x, BuildingKind::House, 1);
                let shop = build(&mut world, dest_x, BuildingKind::Shop, 1);
                let mut events = EventQueue::new();
                let mut intersections = IntersectionRegistry::new();
                let car = |world: &mut World, at: EntityId| {
                    let c = world.insert_at(GameObject::Car(crate::protocol::Car::new(0, Default::default())), world.objects.get(at).unwrap().position);
                    world.park_in_lot(at, c, 0);
                    c
                };
                let (backer, through) = (car(&mut world, home), car(&mut world, from));
                let s = world.approach(from).unwrap();
                assert!(crate::car::spawn::start_trip(&mut world, &mut events, through, s, shop, 0, GameTime::MAX));
                let mut now = 0;
                let mut out = false;
                while now < 60_000 {
                    if !out && now >= start {
                        let s = world.approach(home).unwrap();
                        out = crate::car::spawn::start_trip(&mut world, &mut events, backer, s, shop, now, GameTime::MAX);
                    }
                    let to = now + 50;
                    step(&mut world, &mut events, &mut intersections, &mut now, to);
                    let (a, b) = (whereabouts(&world, backer, now), whereabouts(&world, through, now));
                    if let Some((_, v, k)) = a {
                        if k == 1 {
                            assert!(v <= crate::car::REVERSE_SPEED + 0.06, "backing at {v:.2} (start {start})");
                        }
                    }
                    if let (Some(a), Some(b)) = (a, b) {
                        let d = ((a.0[0] - b.0[0]).powi(2) + (a.0[1] - b.0[1]).powi(2)).sqrt();
                        assert!(a.2 > 2 || d > 0.45, "the backing car and the passing one met, {d:.2} apart at {now} (start {start}, from {from_x}): {a:?} {b:?}");
                    }
                }
                assert!(whereabouts(&world, backer, now).is_none() && whereabouts(&world, through, now).is_none(), "both arrived (start {start}, from {from_x})");
            }
        }
    }

    /// The whole loop watched from above: people come over on the ferry,
    /// drive to work in the morning, and are home again at night — and
    /// nobody told them to; the shift did.
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

    /// With a warehouse in town with crates on its shelf, its own van
    /// answers, and comes home.
    #[test]
    fn a_warehouse_sends_its_own_truck_and_it_comes_home() {
        let mut world = street();
        let shop = build(&mut world, 20, BuildingKind::Shop, 1);
        let warehouse = build(&mut world, 60, BuildingKind::Depot, 1);
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        sell(&mut world, &mut events, shop, 35.0, 0);
        let truck = world.calls[0].answered_by.expect("the warehouse answers");
        assert!(matches!(world.objects.get(truck).unwrap().object, GameObject::Car(ref c) if c.owner == warehouse));
        // The shop learned how long a delivery from next door takes, and
        // reorders later for it.
        let before = crate::economy::reorder(&world, shop, Good::Crates);

        // Out through one ring and home through another, at lot speed, on
        // top of the drive: under three hours.
        pump(&mut world, &mut events, &mut intersections, 0, 3 * DAY_MS as u64 / 24);
        assert!(world.calls.is_empty());
        let e = world.objects.get(truck).expect("the warehouse keeps its truck");
        assert!(matches!(e.object, GameObject::Car(ref c) if c.trip.is_none()));
        assert_eq!(e.position, world.objects.get(warehouse).unwrap().position, "parked back at the warehouse");
        assert_eq!(stock(&world, shop), 1.0, "the shelves are full again");
        assert!(crate::economy::reorder(&world, shop, Good::Crates) < before, "the shop did not learn the lead time");
    }

    /// The building's turn: a buyer takes the nearest seller with stock,
    /// by road. Of two depots the nearer answers; one with an empty shelf
    /// is no seller, and the farther answers; with nothing in town on a
    /// shelf, nobody does: the world comes only by sea.
    #[test]
    fn a_buyer_takes_the_nearest_seller_with_stock() {
        let mut world = street();
        let shop = build(&mut world, 20, BuildingKind::Shop, 1);
        let near = build(&mut world, 30, BuildingKind::Depot, 1);
        let far = build(&mut world, 60, BuildingKind::Depot, 1);
        let mut events = EventQueue::new();
        let empty = |world: &mut World, depot: EntityId| {
            if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
                b.stocks.get_mut(&Good::Crates).unwrap().level = 0.0;
            }
        };
        let answered_by = |world: &World| {
            let truck = world.calls.last().unwrap().answered_by?;
            match world.objects.get(truck).unwrap().object {
                GameObject::Car(ref c) => Some(c.owner),
                _ => unreachable!(),
            }
        };
        sell(&mut world, &mut events, shop, 35.0, 0);
        assert_eq!(answered_by(&world), Some(near), "the nearer depot did not answer");
        // The order stands until it lands; another shop asks fresh.
        let other = build(&mut world, 24, BuildingKind::Shop, 1);
        empty(&mut world, near);
        sell(&mut world, &mut events, other, 35.0, 0);
        assert_eq!(answered_by(&world), Some(far), "an empty shelf answered");
        let third = build(&mut world, 10, BuildingKind::Shop, 1);
        empty(&mut world, far);
        sell(&mut world, &mut events, third, 35.0, 0);
        assert_eq!(answered_by(&world), None, "with nothing in town somebody answered");
    }

    /// Every wake, every arrival: the log the model in docs/residents.md is
    /// held to. Two runs of the same town must write the same one — down to
    /// the millisecond — or something is iterating a hash map.
    type Move = (GameTime, EntityId, Option<EntityId>, Option<crate::needs::Need>);

    fn arrival_log(days: u64) -> (Vec<Move>, EntityId) {
        let mut world = street();
        build(&mut world, 0, BuildingKind::Apartment, 2);
        build(&mut world, 6, BuildingKind::Apartment, 2);
        build(&mut world, 30, BuildingKind::Shop, 1);
        let office = build(&mut world, 60, BuildingKind::Office, 2);
        // Lunch: a shop beside the office, too far from home to staff.
        let lunch = build(&mut world, 64, BuildingKind::Shop, 1);
        // Fuel, or every few days the town goes without.
        build(&mut world, 18, BuildingKind::GasStation, 1);

        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        // Fourteen households in the two blocks, and three desks over that
        // stay empty: nobody comes from beyond the town for a job.
        let people = world.resident_ids();
        assert_eq!(people.len(), 14);

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
        // eleven people, nine hours, less the lunches — and the lunch shop
        // served them. The last day, not the second: a settled one.
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
            // Eleven at the office: fourteen people, two apartments of
            // seven, less the shop's two and the pump's one, nine hours
            // each, less the odd late morning, a lunch out, a dinner near
            // work, and the minute or two parking at the kerb.
            assert!((70.0..=99.0).contains(&office), "office received {office}h");
            // Lunches over a whole day.
            assert!(sold(lunch, "Eat", "yesterday_h") > 2.0, "lunch shop sold {}h", sold(lunch, "Eat", "yesterday_h"));
        }
        (log, lunch)
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
        // Fourteen commuters, a 500-tile tank: a stop each every few days —
        // and not one a day, which would be a nag. The pump's ten minutes
        // a stop is what keeps it from being one: a fill costs nothing.
        println!("{stops} fuel stops in six days");
        assert!((12..=48).contains(&stops), "{stops} fuel stops in six days");
        let d = crate::resident::demand(&world, 6 * day);
        assert_eq!(d["unmet"].as_array().unwrap().len(), 0, "{}", d["unmet"]);
    }

    /// Every kind the mayor could put down along the street: the harbour
    /// aside, which stands with its back to the sea, and the street has
    /// one.
    fn placeable() -> Vec<BuildingKind> {
        BuildingKind::ALL.into_iter().filter(|&k| k != BuildingKind::Harbour).collect()
    }

    /// A town shaped like a town, for the seasons: mostly homes, offices
    /// and factories with about as many desks as the homes have people,
    /// shops, a pump, a supermarket, and a farm and a warehouse to feed
    /// them. Forty plots. `placeable` cycles every kind equally, which is
    /// a shop or a depot for every home — the mix for a wake budget, not
    /// for a town.
    fn town_mix() -> Vec<BuildingKind> {
        use BuildingKind::*;
        vec![
            House, Apartment, Office, House, Apartment, Shop, House, Factory, Apartment, House,
            House, Apartment, House, Shop, Office, House, Apartment, House, House, Factory,
            Apartment, House, GasStation, Apartment, Office, House, Supermarket, Apartment, House, Factory,
            Farm, House, Apartment, Depot, House, Apartment, House, Apartment, House, Apartment,
        ]
    }

    /// A street drawn to a house that was standing dormant moves people in.
    ///
    /// Drawing road once settled nothing, so the house stayed empty until
    /// the mayor happened to place something else. A driveway laid on a
    /// plot marks it unsettled, and the tick settles once after the batch.
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
            handle_player_action(&mut world, &mut events, &mut intersections, ClientMessage::Build(Build { tool: Tool::Street, from, to }), 0);
        }
        assert!(world.street_of(home).is_some(), "the driveway formed itself");

        // Which is what the tick settles for, once, after the batch.
        settle_and_wake(&mut world, &mut events);
        assert_eq!(
            world.resident_ids().len(),
            crate::blueprint::blueprint(BuildingKind::House).homes as usize,
            "the street reached it and nobody moved in",
        );
    }

    /// A town along the street, settled and thinking, run for a while: a
    /// mix of every kind, its people coming over on the ferry. Returns it
    /// and how many times a resident thought.
    fn live(mix: &[BuildingKind], days: u64) -> (World, u64) {
        season(mix, days, |_, _, _| {})
    }

    /// `live`, with a look at the town at the end of every day, after the
    /// midnight wake.
    fn season(mix: &[BuildingKind], days: u64, each_day: impl FnMut(&World, u64, u64)) -> (World, u64) {
        season_with(street(), mix, days, each_day)
    }

    /// `season` on a street of the caller's, founded with the stake.
    fn season_with(mut world: World, mix: &[BuildingKind], days: u64, mut each_day: impl FnMut(&World, u64, u64)) -> (World, u64) {
        // Forty plots in a row, a tile apart: a lot claims the tile beside
        // it for its ring, and a house may not stand on it.
        let mut x = 0;
        for i in 0..40 {
            let kind = mix[i % mix.len()];
            build(&mut world, x, kind, 1);
            x += crate::blueprint::plot(kind, 0).size.0 as i32 + 1;
        }
        // Its depots' lorries on standing orders, and the farm's surplus
        // sold to the world a box at a time.
        let depots: Vec<EntityId> = world.objects.iter().filter(|e| matches!(e.object, GameObject::Building(ref b) if b.kind == BuildingKind::Depot)).map(|e| e.id).collect();
        for d in depots {
            if let Some(GameObject::Building(b)) = world.objects.get_mut(d).map(|e| &mut e.object) {
                b.standing = true;
                b.rules.get_mut(&Good::Crates).unwrap().sell = Some(150.0);
            }
        }
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        // Started as the game starts one.
        world.resettle();
        settle_and_wake(&mut world, &mut events);
        assert!(!world.harbours.is_empty(), "no harbour, or nobody can arrive at all");
        let mut wakes = 0;
        let mut now = 0;
        let end = days * DAY_MS as u64;
        // A day at a time, so the look at the end of each is on the tick
        // that turns it, with the midnight wake taken.
        for day in 1..=days {
            let midnight = day * DAY_MS as u64;
            while step_counting(&mut world, &mut events, &mut intersections, &mut now, midnight.min(end), &mut wakes) {}
            // A town that gridlocks is not a town being measured: nobody is
            // a day late for anything. Two driveways two tiles apart held
            // each other for good on the third day, once the offices' cars
            // were on the street, until claims lapsed (docs/parking.md §9).
            let stuck = world.objects.iter().filter(|e| matches!(e.object, GameObject::Car(ref c) if c.trip.as_ref().is_some_and(|t| now > t.eta + DAY_MS as u64))).count();
            assert_eq!(stuck, 0, "day {day}: {stuck} cars a day past their due time — the street has gridlocked");
            println!("day {day}: {} claims lapsed so far", intersections.lapses);
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
        // Everything the mayor could build. The edge is not a town's to
        // have, so it is not in the mix.
        let every_kind = placeable();
        for (name, mix) in [("full", &every_kind[..]), ("bare", &[BuildingKind::House, BuildingKind::Office][..])] {
            let (world, wakes) = live(mix, 1);
            let residents = world.resident_ids().len() as u64;
            let per_resident_day = wakes / residents.max(1);
            println!("{name}: {wakes} wakes for {residents} residents: {per_resident_day} per resident-day");
            assert!(per_resident_day <= WAKE_BUDGET, "{name}: {per_resident_day} wakes per resident-day, budget {WAKE_BUDGET}");
        }
    }

    /// A town thinks as fast in a wide world as in a narrow one. The
    /// survey lays road out ahead of the frontier, so a played world is
    /// mostly road nodes nobody drives: 29,000 of them beside 47 buildings
    /// on 2026-10-05, when every call and every choice still walked them
    /// all to find a depot, a van or a resident, and the clock stalled for
    /// seconds at a time. The same day of the same town, with that much
    /// road laid out of reach, costs about the same.
    #[test]
    #[ignore]
    fn a_town_thinks_as_fast_in_a_wide_world() {
        let timed = |world: World| {
            let started = Instant::now();
            season_with(world, &town_mix(), 1, |_, _, _| {});
            started.elapsed().as_secs_f64()
        };
        let narrow = timed(street());
        let mut wide = street();
        for y in 1000..1100 {
            for x in 0..300 {
                wide.terrain.insert((x, y), TerrainType::Grass);
            }
            wide.place_road_path(&(0..300).map(|x| GridCoord { x, y }).collect::<Vec<_>>());
        }
        let wide = timed(wide);
        println!("a day of town: {narrow:.2} s, and {wide:.2} s among 30,000 road nodes");
        assert!(wide < 1.5 * narrow, "a day of town took {narrow:.2} s, and {wide:.2} s among 30,000 road nodes");
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

    /// `copies` of the season's town, a hundred tiles apart, each on its
    /// own street with a door out: a town twice the size, with the same
    /// neighbourhoods in it.
    fn towns(copies: i32) -> World {
        let mut world = World::new();
        let mix = town_mix();
        for k in 0..copies {
            let dy = 100 * k;
            for y in -6..14 {
                for x in -4..400 {
                    world.terrain.insert((x, y + dy), TerrainType::Grass);
                }
            }
            world.place_road_path(&(-2..400).map(|x| GridCoord { x, y: dy }).collect::<Vec<_>>());
            world.open_exit(world.road_node_at(GridCoord { x: 0, y: dy }).unwrap());
            let mut x = 0;
            for kind in &mix {
                world.place_on_street(GridCoord { x, y: dy + 1 }, *kind).expect("the street gives it a driveway");
                x += crate::blueprint::plot(*kind, 0).size.0 as i32 + 1;
            }
        }
        world
    }

    /// What builds cost the loop in a town of `copies`, in microseconds,
    /// each the median of a row of them: a house painted across the
    /// street and demolished again, a shop the same, and a side street
    /// drawn four tiles — each a batch of the brush's steps, with the
    /// settle the tick runs after it.
    fn build_cost(copies: i32) -> Vec<(&'static str, f64)> {
        let mut world = towns(copies);
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        world.resettle();
        settle_and_wake(&mut world, &mut events);
        world.build = crate::tree::Build::all();
        world.treasury = 1e9;
        // A command batch as the tick takes it: every step, then one settle.
        let mut timed = |world: &mut World, steps: Vec<(Tool, GridCoord, GridCoord)>| {
            let started = Instant::now();
            for (tool, from, to) in steps {
                handle_player_action(world, &mut events, &mut intersections, ClientMessage::Build(Build { tool, from, to }), 0);
            }
            settle_and_wake(world, &mut events);
            started.elapsed().as_secs_f64() * 1e6
        };
        let at = |x, y| GridCoord { x, y };
        let mut costs: Vec<(&'static str, Vec<f64>)> = ["a house", "its demolition", "a shop", "its demolition", "a road"].map(|n| (n, Vec::new())).into();
        for i in 0..20 {
            let x = 4 + 8 * i;
            for (k, kind) in [BuildingKind::House, BuildingKind::Shop].into_iter().enumerate() {
                // Painted across the street a row at a time, back and forth.
                let (w, h) = crate::blueprint::plot(kind, 0).size;
                let tiles: Vec<GridCoord> = (0..h as i32).flat_map(|r| (0..w as i32).map(move |c| at(x + if r % 2 == 0 { c } else { w as i32 - 1 - c }, -1 - r))).collect();
                let steps = tiles.iter().enumerate().map(|(n, &t)| (Tool::Building(kind), tiles[n.saturating_sub(1)], t)).collect();
                costs[2 * k].1.push(timed(&mut world, steps));
                let id = *world.occupied.get(&(x, -1)).unwrap_or_else(|| panic!("the {kind:?} went down"));
                let bp = crate::blueprint::blueprint(kind);
                assert_eq!((world.household(id).len(), world.staff(id).len()), (bp.homes as usize, bp.jobs as usize), "the {kind:?} filled");
                // Every tile taken out, a drive on one taken first.
                let steps = tiles.iter().flat_map(|&t| [(Tool::Demolish, t, t), (Tool::Demolish, t, t)]).collect();
                costs[2 * k + 1].1.push(timed(&mut world, steps));
                assert!(world.objects.get(id).is_none(), "the {kind:?} came down");
            }
            let steps = (0..4).map(|y| (Tool::Street, at(x + 6, -y), at(x + 6, -y - 1))).collect();
            costs[4].1.push(timed(&mut world, steps));
        }
        let costs: Vec<(&'static str, f64)> = costs
            .into_iter()
            .map(|(what, mut v)| {
                v.sort_by(f64::total_cmp);
                (what, v[v.len() / 2])
            })
            .collect();
        println!("{copies} town(s), {} residents: {}", world.resident_ids().len(), costs.iter().map(|(what, c)| format!("{what} {c:.0} µs")).collect::<Vec<_>>().join(", "));
        costs
    }

    /// A build costs the loop what it changes, not what the town holds:
    /// the same tap in a town twice the size costs about the same. Every
    /// player building at once shares the one loop, so a build that grew
    /// with the world would stall all of them. Settling the whole town
    /// after every build cost 2 ms a house here, and 6 ms in two towns.
    /// Timed, so `#[ignore]`d with the other town benchmarks.
    #[test]
    #[ignore]
    fn a_build_costs_the_same_in_a_town_twice_the_size() {
        for ((what, one), (_, two)) in build_cost(1).into_iter().zip(build_cost(2)) {
            assert!(two < 1.5 * one + 100.0, "{what} cost {one:.0} µs in one town and {two:.0} µs in two");
        }
    }

    /// What settling must leave true, whatever was built: every home a
    /// road reaches full, every line staffed while anyone is out of work,
    /// nobody living or working where no road goes, the index of who is where agreeing with the
    /// residents, and everyone with a car.
    fn assert_settled(world: &World, after: &str) {
        let jobless = world.objects.iter().filter(|e| matches!(e.object, GameObject::Resident(ref r) if r.work.is_none())).count();
        for e in world.objects.iter() {
            let GameObject::Building(ref b) = e.object else { continue };
            if b.site.is_some() {
                continue;
            }
            let bp = crate::blueprint::blueprint(b.kind);
            let reached = world.street_of(e.id).is_some();
            let want = |n: u32| if reached { n as usize } else { 0 };
            assert_eq!(world.household(e.id).len(), want(bp.homes), "after {after}: {:?} {} (reached {reached}) houses the wrong number", b.kind, e.id);
            // A desk stays empty only while nobody in town is out of work.
            assert!(world.staff(e.id).len() <= want(bp.jobs), "after {after}: {:?} {} (reached {reached}) staffs too many", b.kind, e.id);
            assert!(world.staff(e.id).len() == want(bp.jobs) || jobless == 0, "after {after}: {:?} {} has a desk free and {jobless} out of work", b.kind, e.id);
        }
        for id in world.resident_ids() {
            let Some(GameObject::Resident(r)) = world.objects.get(id).map(|e| &e.object) else { continue };
            for b in std::iter::once(r.home).chain(r.work) {
                assert!(world.street_of(b).is_some(), "after {after}: resident {id} is tied to {b}, which no road reaches");
                assert!(world.people.get(&b).is_some_and(|p| p.contains(&id)), "after {after}: the index lost resident {id} at {b}");
            }
            assert!(matches!(world.objects.get(r.car).map(|e| &e.object), Some(GameObject::Car(_))), "after {after}: resident {id} has no car");
        }
        for (&b, people) in &world.people {
            for &id in people {
                assert!(matches!(world.objects.get(id).map(|e| &e.object), Some(GameObject::Resident(r)) if r.home == b || r.work == Some(b)), "after {after}: the index ties {id} to {b}");
            }
        }
    }

    /// Settling reads only the buildings marked unsettled, so a change
    /// that forgets to mark one leaves a house empty or a cut-off shop
    /// staffed, and nothing else would say so until midnight put it
    /// right. A town is built and changed by the mayor's own commands —
    /// painted, a tile taken out, demolished, a door closed, the street
    /// before one taken up and laid again — and after every one, the town
    /// is settled.
    #[test]
    fn every_build_leaves_the_town_settled() {
        let mut world = street();
        for (x, kind) in [(0, BuildingKind::House), (3, BuildingKind::House), (6, BuildingKind::Apartment), (12, BuildingKind::Shop), (30, BuildingKind::Office)] {
            build(&mut world, x, kind, 1);
        }
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        world.resettle();
        settle_and_wake(&mut world, &mut events);
        assert_settled(&world, "the start");
        world.build = crate::tree::Build::all();
        world.treasury = 1e9;
        let at = |x, y| GridCoord { x, y };
        let mut act = |world: &mut World, tool: Tool, from: GridCoord, to: GridCoord| {
            handle_player_action(world, &mut events, &mut intersections, ClientMessage::Build(Build { tool, from, to }), 0);
            settle_and_wake(world, &mut events);
            assert_settled(world, &format!("{tool:?} from {from:?} to {to:?}"));
        };
        // Painted across the street: two houses and an office, two tiles.
        act(&mut world, Tool::Building(BuildingKind::House), at(20, -1), at(20, -1));
        act(&mut world, Tool::Building(BuildingKind::House), at(24, -1), at(24, -1));
        act(&mut world, Tool::Building(BuildingKind::Office), at(40, -1), at(40, -1));
        act(&mut world, Tool::Building(BuildingKind::Office), at(40, -1), at(41, -1));
        // The office's door tile taken out of it, which leaves too little of
        // it to work; a house taken down, a door closed, and the street
        // before a third taken up and laid again.
        let office = *world.occupied.get(&(40, -1)).unwrap();
        let (door, _) = world.door_of(office).expect("the office has a door");
        act(&mut world, Tool::Demolish, door, door);
        assert!(world.objects.get(office).is_some() || world.occupied.contains_key(&(81 - door.x, -1)), "a tile of it stands");
        act(&mut world, Tool::Demolish, at(0, 1), at(0, 1));
        let door_of = |world: &World, x, y| {
            let (door, street) = world.door_of(*world.occupied.get(&(x, y)).unwrap()).expect("painted with a door");
            (door, world.objects.get(street).unwrap().position.unwrap())
        };
        let (door, street) = door_of(&world, 20, -1);
        act(&mut world, Tool::Demolish, door, street);
        assert!(world.street_of(*world.occupied.get(&(20, -1)).unwrap()).is_none(), "the door closed");
        let (_, street) = door_of(&world, 24, -1);
        act(&mut world, Tool::Demolish, street, street);
        assert!(world.street_of(*world.occupied.get(&(24, -1)).unwrap()).is_none(), "the street went");
        act(&mut world, Tool::Street, at(street.x - 1, street.y), street);
        act(&mut world, Tool::Street, street, at(street.x + 1, street.y));
        assert!(world.street_of(*world.occupied.get(&(24, -1)).unwrap()).is_some(), "the street came back");
    }

    /// The season: a month of the same town as
    /// `a_town_thinks_within_budget`, `#[ignore]`d for the same reason:
    /// `cargo test season -- --ignored --nocapture`. Thirty days is a
    /// season; `DAYS=8` runs a shorter one, to see a town drift in a few
    /// minutes rather than ten.
    fn season_days() -> u64 {
        std::env::var("DAYS").ok().and_then(|d| d.parse().ok()).unwrap_or(30)
    }

    /// What a town is for, held over a season: its shelves stay stocked
    /// and its residents fed. Every day the town eats what its people need
    /// — at home or out — and eats out, fills up and works; no shelf in
    /// town and no car's tank stands empty two midnights running: a shelf
    /// that empties calls, and something comes. And the farm's harvests
    /// leave for the world, so the town ends the season with coins. Each
    /// day's page is printed: hours served, coins in and out at the
    /// border, the treasury, empty shelves.
    #[test]
    #[ignore]
    fn season_the_shelves_stay_stocked_and_everyone_eats() {
        use crate::needs::Need;
        let days = season_days();
        let mut empty_since: std::collections::BTreeMap<(EntityId, String), u64> = Default::default();
        let mut stood_empty = |what: (EntityId, String), empty: bool, day: u64| -> u64 {
            if empty {
                day - *empty_since.entry(what).or_insert(day)
            } else {
                empty_since.remove(&what);
                0
            }
        };
        let (world, _) = season(&town_mix(), days, |world, day, _| {
            let midnight = day * DAY_MS as u64;
            let page = world.town.before(midnight);
            let mut empty = Vec::new();
            for e in world.objects.iter() {
                let GameObject::Building(ref b) = e.object else { continue };
                for (&good, stock) in &b.stocks {
                    // A farm's yard is meant to empty: a lorry takes it.
                    if crate::economy::makes(b.kind, good) {
                        continue;
                    }
                    if stock.level <= 0.0 {
                        empty.push(format!("{:?} {} {good:?}", b.kind, e.id));
                    }
                    let days = stood_empty((e.id, format!("{good:?}")), stock.level <= 0.0, day);
                    assert!(days < 1, "day {day}: {:?} {}'s {good:?} has stood empty two midnights running; calls {:?}", b.kind, e.id, world.calls);
                }
            }
            for e in world.objects.iter() {
                let GameObject::Car(ref c) = e.object else { continue };
                if c.role == crate::protocol::CarRole::Private {
                    let dry = c.stocks.get(&Need::Fuel).is_some_and(|s| s.level <= 0.0);
                    assert!(stood_empty((e.id, "tank".into()), dry, day) < 1, "day {day}: car {} has stood dry two midnights running", e.id);
                }
            }
            // Fed: the hours of eating everyone in town did yesterday, at
            // home or out, against what a day asks of each of them.
            let eaten: f64 = world.books.values().map(|k| k.before(midnight).served.get(&Need::Eat).copied().unwrap_or(0.0)).sum();
            let asked = world.resident_ids().len() as f64 * Need::Eat.daily_ms() / (DAY_MS as f64 / 24.0);
            // Hours served out of the house, per need: work, eating out,
            // filling up.
            let mut out: std::collections::BTreeMap<Need, f64> = Default::default();
            for (id, k) in &world.books {
                if matches!(world.objects.get(*id).map(|e| &e.object), Some(GameObject::Building(b)) if crate::blueprint::blueprint(b.kind).homes == 0) {
                    for (&need, &h) in &k.before(midnight).served {
                        *out.entry(need).or_default() += h;
                    }
                }
            }
            println!(
                "day {day}: ate {eaten:.0}h of {asked:.0}h; {:.0}h work, {:.1}h eating out, {:.1}h filling up; GDP {:.1} {:.1?}, in {:.1} out {:.1}, treasury {:.1}; {} empty {:?}",
                out.get(&Need::Work).copied().unwrap_or(0.0),
                out.get(&Need::Eat).copied().unwrap_or(0.0),
                out.get(&Need::Fuel).copied().unwrap_or(0.0),
                page.gdp.values().sum::<f64>(),
                page.gdp,
                page.revenue(),
                page.purchases(),
                world.treasury,
                empty.len(),
                empty,
            );
            if day > 1 {
                assert!(eaten >= 0.9 * asked, "day {day}: the town ate {eaten:.1}h of the {asked:.1}h its people need");
                for need in [Need::Work, Need::Eat, Need::Fuel] {
                    assert!(out.get(&need).is_some_and(|&h| h > 0.0), "day {day}: nobody in town was served {need:?}");
                }
            }
        });
        let sold = world.town.season().map(|p| p.sold.get(&Good::Crates).copied().unwrap_or(0.0)).sum::<f64>();
        println!("the season: treasury {:.1}, crates sold to the world for {sold:.1}", world.treasury);
        assert!(sold > 0.0, "the farm never sold a harvest to the world");
        assert!(world.treasury > 0.0, "the town ran out of coins");
    }

    #[test]
    fn the_same_town_lives_the_same_days() {
        let (three, lunch) = arrival_log(3);
        let (one, _) = arrival_log(1);
        // Fourteen people, each at least driving in, to work, and home.
        assert!(one.len() >= 14 * 3, "only {} moves logged", one.len());
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
        assert_eq!(moves.len(), 14, "everyone went out on day three");
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
        // Some wait for dinner and some eat at home: half the office, not
        // all of it.
        assert!(arrivals.len() >= 6, "only {} came for lunch", arrivals.len());
        let span = arrivals.iter().max().unwrap() - arrivals.iter().min().unwrap();
        assert!(span >= 2 * hour, "lunch was a crush: {:.1}h", span as f64 / hour as f64);
        let (mut present, mut most) = (std::collections::BTreeSet::new(), 0);
        for &(_, id, at, sel) in two.iter().filter(|&&(t, ..)| t >= settled) {
            if at == Some(lunch) && sel == Some(Need::Eat) { present.insert(id); } else { present.remove(&id); }
            most = most.max(present.len());
        }
        assert!(most <= 12, "{most} eating at a twelve-spot shop at once");
    }

    /// Land and the tractor, docs/economy.md §12.8: a farm on a street
    /// claims its land; with a hand on shift its tractor ploughs it in a
    /// run, seeds it in the next, and a day on harvests it, each tile's
    /// crop landing in the yard as it is cut, while the hands' shifts
    /// grow nothing in the yard themselves. A depot whose shelf runs low
    /// fetches from the farm's yard with its own lorry, and no coin moves.
    #[test]
    fn a_tractor_works_the_land_and_a_lorry_fetches_from_the_yard() {
        use crate::protocol::Stage;
        let mut world = street();
        build(&mut world, 0, BuildingKind::House, 1);
        build(&mut world, 3, BuildingKind::House, 1);
        let farm = build(&mut world, 10, BuildingKind::Farm, 1);
        let depot = build(&mut world, 30, BuildingKind::Depot, 1);
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        world.treasury = 1000.0;
        let yard = |world: &World| match world.objects.get(farm).unwrap().object {
            GameObject::Building(ref b) => b.stocks[&Good::Crates].level,
            _ => unreachable!(),
        };
        let stages = |world: &World| -> Vec<Stage> {
            match world.objects.get(farm).unwrap().object {
                GameObject::Building(ref b) => b.land.iter().map(|t| t.stage).collect(),
                _ => unreachable!(),
            }
        };
        let wanted = crate::world::fields::capacity(BuildingKind::Farm) as usize;
        assert!(stages(&world).len() <= wanted && stages(&world).len() > wanted * 9 / 10, "the farm claimed {} tiles of {wanted}", stages(&world).len());
        assert_eq!(yard(&world), 0.0, "the yard is founded with a make");
        let hands = world.resident_ids().into_iter().filter(|&id| matches!(world.objects.get(id).map(|e| &e.object), Some(GameObject::Resident(r)) if r.work == Some(farm))).count();
        assert!(hands > 0, "the farm hired nobody");
        let tractor = world.objects.iter().find(|e| matches!(e.object, GameObject::Car(ref c) if c.owner == farm)).map(|e| e.id).expect("the farm keeps a tractor");
        assert!(matches!(world.objects.get(tractor).map(|e| &e.object), Some(GameObject::Car(c)) if c.role == crate::protocol::CarRole::Tractor));
        // The first day: the hands come at six and the tractor ploughs
        // the land, a shift's worth; by evening it is a field, the tractor
        // is home, and the yard is empty.
        let day = DAY_MS as u64;
        let land = stages(&world).len();
        let crop = crate::economy::crop(BuildingKind::Farm, land);
        pump(&mut world, &mut events, &mut intersections, 0, 20 * day / 24);
        assert!(stages(&world).iter().all(|&s| s == Stage::Ploughed), "by evening the land is {:?}", stages(&world));
        assert!(stages(&world).len() >= land * 9 / 10, "the plough reached {} of {land} tiles", stages(&world).len());
        assert_eq!(yard(&world), 0.0, "something landed in the yard before a harvest");
        assert!(matches!(world.objects.get(tractor).map(|e| &e.object), Some(GameObject::Car(c)) if c.run.is_none() && c.trip.is_none()), "the tractor is not home");
        // The second day: seeded. The third: ripe by morning, harvested
        // by evening, a harvest in the yard, and a lorry from beyond the
        // edge called for it.
        pump(&mut world, &mut events, &mut intersections, 20 * day / 24, day + 20 * day / 24);
        assert!(stages(&world).iter().all(|&s| s == Stage::Sown), "by the second evening the land is {:?}", stages(&world));
        assert_eq!(yard(&world), 0.0);
        pump(&mut world, &mut events, &mut intersections, day + 20 * day / 24, 2 * day + 7 * day / 24);
        // Ripe by the third morning, and cut that day: the whole harvest
        // in the yard by evening, or already on its way to the world.
        let mut harvest = 0.0f64;
        let mut t = 2 * day + 7 * day / 24;
        while step(&mut world, &mut events, &mut intersections, &mut t, 3 * day + 20 * day / 24) {
            harvest = harvest.max(yard(&world));
        }
        assert!((harvest - stages(&world).len() as f64 * crop).abs() < 1e-6, "the harvest came to {harvest}, not a yard's worth");

        // Then the depot's shelf runs low: its lorry fetches from the farm,
        // and no coin moves. The clock goes on from where the world is: an
        // event queue is not pumped backwards.
        let now = 3 * day + 20 * day / 24;
        if let Some(GameObject::Building(b)) = world.objects.get_mut(farm).map(|e| &mut e.object) {
            b.stocks.get_mut(&Good::Crates).unwrap().level = 300.0;
        }
        let before = yard(&world);
        let bought = |world: &World| world.town.on(now).bought.get(&Good::Crates).copied().unwrap_or(0.0);
        let bought_before = bought(&world);
        if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
            b.stocks.get_mut(&Good::Crates).unwrap().level = 0.0;
        }
        calls::turn(&mut world, &mut events, depot, now);
        let fetch = world.calls.iter().find(|c| c.at == depot && c.kind == calls::CallKind::Fetch).expect("the depot fetches");
        assert_eq!(fetch.from, Some(farm), "the lorry went past the farm to the edge");
        pump(&mut world, &mut events, &mut intersections, now, now + 3 * day / 24);
        assert!(world.calls.iter().all(|c| c.at != depot), "the fetch did not land: {:?}; lorries {:?}", world.calls, world.objects.iter().filter(|e| matches!(e.object, GameObject::Car(ref c) if c.role == crate::protocol::CarRole::Truck)).map(|e| (e.id, e.position, matches!(e.object, GameObject::Car(ref c) if c.trip.is_some()))).collect::<Vec<_>>());
        let fetched = before - yard(&world);
        assert!(fetched > 0.0, "the lorry took nothing from the yard");
        assert_eq!(bought(&world), bought_before, "crates fetched in town were paid for");
    }
}
