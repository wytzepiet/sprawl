use std::collections::{HashMap, HashSet};

use crate::car::simulation::{handle_car_wake_up, park_at_home};
use crate::car::ACCELERATION;
use crate::resident::handle_resident_wake;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::intersection::IntersectionRegistry;
use crate::protocol::{Build, BuildingKind, CarRole, ChunkBounds, ChunkCoord, ClientMessage, Clock, DAY_MS, EntityId, GameObject, GameObjectEntry, Operation, OwnerId, Lump, News, ServerMessage, StateUpdate, Tool, GridCoord};
use crate::world::chunk_of;
use crate::world::World;

pub type ClientId = u64;

/// What the game knows of one who is watching: who they are and what they
/// have been sent. What it has to say to them waits in the outbox until
/// whatever carries it (a socket, a worker's port) takes it.
struct ClientState {
    /// Who is playing. Several sockets can share one.
    owner: OwnerId,
    subscribed: Option<ChunkBounds>,
    known: HashSet<EntityId>,
    known_chunks: HashSet<ChunkCoord>,
}

/// Simulated milliseconds per step. Fixed: speed adds steps rather than making
/// them longer, so running fast cannot change what the simulation does.
pub const STEP_MS: GameTime = 10;
/// Guards against a speed that would peg the loop and stall the socket.
const MAX_SPEED: u32 = 50;

/// What a save does not keep, rebuilt from what it does, as the game
/// opens it.
pub fn restore(world: &mut World) {
    world.rebuild_edges();
    world.rebuild_node_cars();
    world.rebuild_occupied();
    world.restore_spots();
    world.rebuild_laid();
    world.doors_from_drives();
}

/// The game, whole and without a clock on the wall: a world, what is due in
/// it, its junctions, and who is watching. Whatever drives it (the server's
/// loop, a browser's worker) calls `tick` as often as it likes and carries
/// the outbox to the clients.
pub struct Game {
    pub world: World,
    pub events: EventQueue,
    pub intersections: IntersectionRegistry,
    pub now: GameTime,
    pub speed: u32,
    clients: HashMap<ClientId, ClientState>,
    outbox: Vec<(ClientId, ServerMessage)>,
    /// The world a reset starts again from: the server's makes a new island,
    /// a level its own map.
    fresh: Box<dyn FnMut() -> World + Send>,
}

impl Game {
    /// A world laid out, brought to life: whatever is standing gets its
    /// people, the day is due to turn, and everyone thinks once.
    pub fn new(world: World, now: GameTime, speed: u32, fresh: Box<dyn FnMut() -> World + Send>) -> Self {
        let mut game = Game {
            world,
            events: EventQueue::new(),
            intersections: IntersectionRegistry::new(),
            now,
            speed,
            clients: HashMap::new(),
            outbox: Vec::new(),
            fresh,
        };
        game.events.set_now(now);
        game.wake_all();
        game
    }

    /// Trips do not survive a save, so a loaded world is entirely people
    /// standing still until they think, and working vehicles waiting on a
    /// wake that was not saved: one standing at a door it delivered to would
    /// stand there for good, holding its place and never free for a call.
    fn wake_all(&mut self) {
        self.world.resettle();
        settle_and_wake(&mut self.world, &mut self.events);
        for id in self.world.resident_ids() {
            wake_resident(&self.world, &mut self.events, id);
        }
        let standing: Vec<EntityId> = self
            .world
            .objects
            .iter()
            .filter(|e| matches!(e.object, GameObject::Car(ref c) if c.role != CarRole::Private && c.trip.is_none()))
            .map(|e| e.id)
            .collect();
        for id in standing {
            self.events.wake(0, id);
        }
    }

    fn clock(&self) -> Clock {
        clock(self.now, self.speed)
    }

    fn send(&mut self, to: ClientId, msg: ServerMessage) {
        self.outbox.push((to, msg));
    }

    /// Everything said since last asked, and to whom.
    pub fn take_outbox(&mut self) -> Vec<(ClientId, ServerMessage)> {
        std::mem::take(&mut self.outbox)
    }

    pub fn connect(&mut self, id: ClientId, owner: OwnerId) {
        self.send(id, ServerMessage::Welcome(owner));
        // Objects come with the first SetChunks.
        let update = state_update(&self.world, vec![], vec![], self.clock());
        self.send(id, update);
        self.clients.insert(id, ClientState { owner, subscribed: None, known_chunks: HashSet::new(), known: HashSet::new() });
    }

    pub fn disconnect(&mut self, id: ClientId) {
        self.clients.remove(&id);
    }

    /// A message from a client, done.
    pub fn command(&mut self, client_id: ClientId, message: ClientMessage) {
        match message {
            ClientMessage::Ping => self.send(client_id, ServerMessage::Pong(self.now)),
            ClientMessage::SetSpeed(s) => {
                self.speed = s.min(MAX_SPEED);
                // Paused, nothing goes dirty and no update would ever be
                // sent — so clients would keep extrapolating cars against
                // a stopped world. Push the new clock instead of waiting.
                let ids: Vec<ClientId> = self.clients.keys().copied().collect();
                for id in ids {
                    let update = state_update(&self.world, vec![], vec![], self.clock());
                    self.send(id, update);
                }
            }
            ClientMessage::SetChunks(bounds) => {
                let clk = self.clock();
                handle_set_chunks(&self.world, &mut self.clients, &mut self.outbox, client_id, bounds, clk);
            }
            ClientMessage::ResetWorld => {
                let world = (self.fresh)();
                self.replace(world);
            }
            message => {
                let Some(owner) = self.clients.get(&client_id).map(|cs| cs.owner) else { return };
                // What the hand did, said to its owner alone: an undo, or a
                // building refused.
                if let Some(reply) = handle_player_action(&mut self.world, &mut self.events, &mut self.intersections, owner, message, self.now) {
                    let to: Vec<ClientId> = self.clients.iter().filter(|(_, cs)| cs.owner == owner).map(|(&id, _)| id).collect();
                    for id in to {
                        self.send(id, ServerMessage::News(vec![reply.clone()]));
                    }
                }
            }
        }
    }

    /// Another world in this one's place, the clock kept: every client is
    /// told to forget what it knew, terrain included, and is sent what it
    /// looks at afresh.
    pub fn replace(&mut self, world: World) {
        let clk = self.clock();
        let ids: Vec<ClientId> = self.clients.keys().copied().collect();
        for id in &ids {
            let cs = self.clients.get_mut(id).unwrap();
            let ops: Vec<Operation> = cs.known.drain().map(Operation::Delete).collect();
            let chunks: Vec<ChunkCoord> = cs.known_chunks.drain().collect();
            if !ops.is_empty() {
                let update = state_update(&self.world, ops, vec![], clk);
                self.outbox.push((*id, update));
            }
            for coord in chunks {
                self.outbox.push((*id, ServerMessage::UnloadChunk(coord)));
            }
        }
        self.world = world;
        self.events = EventQueue::new();
        self.events.set_now(self.now);
        self.intersections = IntersectionRegistry::new();
        self.wake_all();
        for id in ids {
            if let Some(bounds) = self.clients.get(&id).and_then(|cs| cs.subscribed) {
                handle_set_chunks(&self.world, &mut self.clients, &mut self.outbox, id, bounds, clk);
            }
        }
    }

    /// One tick of the loop: what the commands built settles, then one step
    /// per unit of speed, each the same length as at speed 1, so a
    /// fast-forwarded hour is the same hour. What changed goes out. How many
    /// wakes it took.
    pub fn tick(&mut self) -> u32 {
        self.tick_with(|_| {})
    }

    /// A tick with something done before each step: a level setting off
    /// whoever is due.
    pub fn tick_with(&mut self, mut before: impl FnMut(&mut Game)) -> u32 {
        // Whatever the commands built, reached, cut off or took away
        // settles once for the batch: the road brush sends a command a tile.
        settle_and_wake(&mut self.world, &mut self.events);
        let mut wakes = 0;
        for _ in 0..self.speed {
            before(self);
            wakes += self.step();
        }
        // Before the flush, which takes the lumps a mission reads.
        crate::missions::check(&mut self.world, self.now);
        let clk = self.clock();
        flush_dirty(&mut self.world, &mut self.clients, &mut self.outbox, clk);
        wakes
    }

    /// One step of simulated time, and everything due in it. How many wakes.
    pub fn step(&mut self) -> u32 {
        self.now += STEP_MS;
        self.events.set_now(self.now);
        let mut wakes = 0;
        while let Some(id) = self.events.pop_due() {
            handle_wake(&mut self.world, &mut self.events, &mut self.intersections, id, self.now);
            wakes += 1;
        }
        wakes
    }
}

pub fn clock(now: GameTime, speed: u32) -> Clock {
    Clock { now, speed, day_ms: DAY_MS }
}

/// Every update carries the ambient world state alongside its ops, so a client
/// never has to ask for the seed or the island's extent separately.
pub fn state_update(world: &World, ops: Vec<Operation>, lumps: Vec<Lump>, clk: Clock) -> ServerMessage {
    ServerMessage::Update(StateUpdate {
        ops,
        lumps,
        clock: clk,
        growth: crate::economy::growth(world, clk.now),
        sea: crate::haul::sea(world),
        missions: world.missions.shown(clk.now),
        terrain_seed: world.terrain_seed,
        island: ChunkBounds { min_cx: crate::terrain::CHUNKS_MIN, min_cy: crate::terrain::CHUNKS_MIN, max_cx: crate::terrain::CHUNKS_MAX, max_cy: crate::terrain::CHUNKS_MAX },
    })
}

/// What a player asked of the town, done. What it has to say back to
/// them alone: an undo, or a building that may not go there.
fn handle_player_action(
    world: &mut World,
    events: &mut EventQueue,
    intersections: &mut IntersectionRegistry,
    owner: OwnerId,
    message: ClientMessage,
    now: GameTime,
) -> Option<News> {
    // Anything the mayor does may do a mission's step.
    world.missions.stir();
    match message {
        ClientMessage::Build(step) => return build(world, events, intersections, owner, step, now),
        ClientMessage::Place { kind, at, facing } => return place(world, events, intersections, owner, kind, at, facing, now),
        ClientMessage::Undo => return Some(crate::undo::undo(world, events, intersections, owner, now)),
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
        ClientMessage::BuyLorry { depot } => crate::haul::buy_lorry(world, events, depot, now),
        ClientMessage::Take(cell) => {
            let (level, _) = crate::economy::level(world.gdp);
            world.build.take(cell, level);
        }
        ClientMessage::SetSpeed(_) | ClientMessage::ResetWorld | ClientMessage::SetChunks(_) | ClientMessage::Ping => {
            unreachable!("handled by Game::command")
        }
    }
    None
}

/// A step of a road or the demolisher, built as it is sent, and kept to
/// undo: a drag is one action.
fn build(world: &mut World, events: &mut EventQueue, intersections: &mut IntersectionRegistry, owner: OwnerId, step: Build, now: GameTime) -> Option<News> {
    let purse = crate::undo::Purse::of(world);
    let after = world.objects.next_id();
    let taken = (step.tool == Tool::Demolish).then(|| crate::undo::doomed(world, step)).flatten();
    if !take_step(world, events, intersections, step, now) {
        return None;
    }
    let paid = purse.paid(world);
    crate::undo::stepped(world, owner, step, taken, paid, after, now)
}

/// A building placed whole round `at`, its front facing this way or the
/// first way it fits: a site that calls for its materials at once. A
/// harbour lays its street first. Kept to undo; refused, the reason, for
/// the hand that asked.
#[allow(clippy::too_many_arguments)]
fn place(world: &mut World, events: &mut EventQueue, intersections: &mut IntersectionRegistry, owner: OwnerId, kind: BuildingKind, at: GridCoord, facing: Option<u8>, now: GameTime) -> Option<News> {
    let refuse = |why: &str| Some(News { text: format!("No room for the {}", format!("{kind:?}").to_lowercase()), sub: why.to_string(), at: 0 });
    if !world.build.may_place(kind) {
        return refuse("not yet opened on the tree");
    }
    let facing = facing.or_else(|| world.facing_for(kind, at)).unwrap_or(2);
    let tiles = match world.fit(kind, at, facing) {
        Ok(tiles) => tiles,
        Err(why) => return refuse(why),
    };
    let purse = crate::undo::Purse::of(world);
    let after = world.objects.next_id();
    let mut laid = Vec::new();
    for (from, to) in world.stub(kind, &tiles, facing) {
        if take_step(world, events, intersections, Build { tool: Tool::Street, from, to }, now) {
            laid.push(crate::undo::Link { from, to, one_way: false, road: false });
        }
    }
    let id = world.raise(kind, tiles, facing);
    crate::calls::turn(world, events, id, now);
    let paid = purse.paid(world);
    crate::undo::placed(world, owner, id, laid, paid, after, now);
    None
}

/// A step of the hand, built. Whether the step was taken.
pub fn take_step(world: &mut World, events: &mut EventQueue, intersections: &mut IntersectionRegistry, Build { tool, from, to }: Build, now: GameTime) -> bool {
    // Said out loud: a click that does nothing is the kind of bug
    // that otherwise takes an afternoon to find.
    if !may(world, tool, from, to) {
        println!("refused: {tool:?} from {from:?} to {to:?}");
        return false;
    }
    match tool {
        Tool::Street | Tool::OneWay | Tool::Road => {
            let laid = lay(world, crate::undo::Link { from, to, one_way: tool == Tool::OneWay, road: tool == Tool::Road });
            crate::economy::paved(world, to, laid, now);
        }
        Tool::Demolish => {
            // A tap takes everything on the tile: a building whole, or its
            // road and all its links, the cars on it rerouted. A drag cuts
            // only the road between the two tiles.
            if from == to {
                if let Some(id) = world.road_node_at(to) {
                    handle_road_demolish(world, events, intersections, id, now);
                }
                if let Some(&id) = world.occupied.get(&(to.x, to.y)) {
                    world.remove_building(id);
                }
            } else if let Some((a, b)) = world.link_between(from, to) {
                handle_link_demolish(world, events, intersections, a, b, now);
            }
        }
    }
    true
}

/// A road laid between two tiles, its edges with it: how many tiles of
/// it are new.
pub(crate) fn lay(world: &mut World, crate::undo::Link { from, to, one_way, road }: crate::undo::Link) -> u32 {
    let (from_id, to_id) = (world.road_node_at(from), world.road_node_at(to));
    let laid = world.laid;
    world.handle_place_road(from, to, one_way, road);
    if let (Some(f), Some(t)) = (world.road_node_at(from), world.road_node_at(to))
        && (from_id.is_none() || to_id.is_none() || !world.edges.contains_key(&(f, t)))
    {
        world.insert_edge(f, t);
        if !one_way {
            world.insert_edge(t, f);
        }
    }
    world.laid.saturating_sub(laid)
}

/// May the mayor's hand take this step with this tool: the build's gate
/// (what it has opened, how much road is left to lay), and the world's
/// own rule for the step. The one rule a step is refused by. The client
/// works out the same where it draws the hand's dots
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
pub(crate) fn handle_link_demolish(
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
    let backing = crate::car::spawn::backing(0, world.reverse_tail(car_id), new_route.len());
    let stands = world.pose_held(car_id);
    let segment_lengths = world.compute_segment_lengths(&new_route, 0, to_lot, &backing);
    let total: f64 = segment_lengths.iter().sum();
    let route_positions = world.route_positions(&new_route);

    if let Some(pos) = world.objects.get(new_route[0]).and_then(|e| e.position) {
        world.update_position(car_id, pos);
    }

    let arriving = world.kerb_stretch(car_id);
    if let Some(entry) = world.objects.get_mut(car_id)
        && let GameObject::Car(ref mut car) = entry.object
        && let Some(ref mut t) = car.trip
    {
        t.route = new_route;
        t.route_positions = route_positions;
        t.from_lot = 0;
        t.to_lot = to_lot;
        t.cusps = crate::car::spawn::cusps(&backing, &segment_lengths);
        t.leaves = None;
        t.stands = stands;
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
    if !world.unsettled.is_empty() {
        world.missions.stir();
    }
    for id in world.settle() {
        wake_resident(world, events, id);
    }
    // A harbour reached, or cut off: the town's way out, and its ferry.
    world.mark_harbours(events.now());
    // A site reached, and not calling: it calls for its timber.
    let waiting: Vec<EntityId> = world
        .objects
        .iter()
        .filter(|e| matches!(e.object, GameObject::Building(ref b) if b.site.is_some()))
        .map(|e| e.id)
        .filter(|&id| world.street_of(id).is_some() && !world.calls.iter().any(|c| c.at == id))
        .collect();
    for id in waiting {
        crate::calls::turn(world, events, id, events.now());
    }
    // Their ferries and tugs read the time from where they stand, so a
    // wake too many is no harm, and one too few after a load would be.
    let harbours: Vec<EntityId> = world.harbours.keys().copied().collect();
    for h in harbours {
        for id in world.ferries_of(h).into_iter().chain(world.tug_of(h)) {
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
    outbox: &mut Vec<(ClientId, ServerMessage)>,
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
            outbox.push((client_id, ServerMessage::TerrainChunk(world.terrain_chunk(coord))));
        }
    }
    let dropped: Vec<ChunkCoord> = cs.known_chunks
        .iter()
        .filter(|c| !visible_chunks.contains(c))
        .copied()
        .collect();
    for coord in dropped {
        cs.known_chunks.remove(&coord);
        outbox.push((client_id, ServerMessage::UnloadChunk(coord)));
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
        outbox.push((client_id, state_update(world, ops, vec![], clk)));
    }
}

fn flush_dirty(
    world: &mut World,
    clients: &mut HashMap<ClientId, ClientState>,
    outbox: &mut Vec<(ClientId, ServerMessage)>,
    clk: Clock,
) {
    // The news, to every player, wherever they are looking.
    let news = std::mem::take(&mut world.news);
    if !news.is_empty() {
        for &id in clients.keys() {
            outbox.push((id, ServerMessage::News(news.clone())));
        }
    }
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

    for (&client_id, cs) in clients.iter_mut() {
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
            outbox.push((client_id, state_update(world, ops, lumps, clk)));
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
    use std::time::Instant;
    use crate::calls;
    use crate::protocol::{BuildingKind, Good, GridCoord, TerrainType};

    /// What a test's hand does: a step of road or the demolisher, or a
    /// building placed whole round a tile, the first way it fits.
    #[derive(Clone, Copy, Debug)]
    enum Do {
        Step(Tool, GridCoord, GridCoord),
        Place(BuildingKind, GridCoord),
    }

    /// The hand's act done, as the loop does it; a building refused is a
    /// test gone wrong.
    fn does(world: &mut World, events: &mut EventQueue, intersections: &mut IntersectionRegistry, d: Do, now: GameTime) {
        match d {
            Do::Step(tool, from, to) => {
                take_step(world, events, intersections, Build { tool, from, to }, now);
            }
            Do::Place(kind, at) => {
                if let Some(no) = place(world, events, intersections, 0, kind, at, None, now) {
                    panic!("{kind:?} at {at:?} refused: {}", no.sub);
                }
            }
        }
    }

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
        for y in -10..60 {
            for x in -4..300 {
                let sea = x >= HARBOUR_X - 2 && y >= 3;
                if sea || y < 14 {
                    world.terrain.insert((x, y), if sea { TerrainType::Sea } else { TerrainType::Grass });
                }
            }
        }
        let street: Vec<GridCoord> = (-2..HARBOUR_X + 6).map(|x| GridCoord { x, y: 0 }).collect();
        world.place_road_path(&street);
        // A back street, and lanes between the two every forty tiles, so a
        // lorry turns round in a block, not at the end of the world.
        world.place_road_path(&(-2..HARBOUR_X + 6).map(|x| GridCoord { x, y: -9 }).collect::<Vec<_>>());
        for x in (-2..HARBOUR_X + 6).step_by(40) {
            world.place_road_path(&(-9..=0).map(|y| GridCoord { x, y }).collect::<Vec<_>>());
        }
        world.place_on_street(GridCoord { x: HARBOUR_X, y: 1 }, BuildingKind::Harbour).expect("the coast takes a harbour");
        world
    }

    fn harbour_of(world: &World) -> EntityId {
        *world.occupied.get(&(HARBOUR_X, 1)).expect("the street's harbour")
    }

    /// The rule says what the hand will do: a house may be placed
    /// beside the street and not on it; a street may be drawn off the
    /// street and not along it again, nor onto water; demolishing finds
    /// what stands. The client's dots (`may.ts`) answer the same.
    #[test]
    fn the_rule_of_where_the_hand_may_go_is_what_it_does() {
        let mut world = street();
        world.build = crate::tree::Build::all();
        world.treasury = 1e9;
        let at = |x, y| GridCoord { x, y };
        assert!(world.fit(BuildingKind::House, at(5, 1), 2).is_ok(), "beside the street");
        assert!(world.fit(BuildingKind::House, at(5, 0), 2).is_err(), "not on it");
        assert!(world.fit(BuildingKind::House, at(5, 3), 2).is_err(), "nor where no street reaches");
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
                take_step(&mut probe, &mut events, &mut intersections, Build { tool: Tool::Street, from, to }, 0);
                assert_eq!(probe.edges.len() != edges, allowed, "step {dx},{dy}");
            }
        }
    }

    /// A drag of road is one action, and undo takes it back whole: the
    /// street gone, the stone back on the depot's shelf it came off, the
    /// coins paid express for what the shelf lacked back in the purse.
    #[test]
    fn undo_takes_back_a_drag_of_road_and_what_it_paid() {
        let mut world = street();
        world.build = crate::tree::Build::all();
        let depot = build(&mut world, 30, BuildingKind::Depot, 1);
        if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
            b.stocks.get_mut(&Good::Stone).unwrap().level = 2.0;
        }
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        let at = |x, y| GridCoord { x, y };
        let (roads, treasury) = (world.roads.len(), world.treasury);
        let mut hand = |world: &mut World, message| handle_player_action(world, &mut events, &mut intersections, 1, message, 0);
        let mut said = Vec::new();
        for y in 0..4 {
            said.extend(hand(&mut world, ClientMessage::Build(Build { tool: Tool::Street, from: at(10, y), to: at(10, y + 1) })));
        }
        assert_eq!(world.roads.len(), roads + 4, "the side street was not laid");
        assert!(world.treasury < treasury, "the third and fourth tiles were not bought express");
        assert_eq!(said.len(), 1, "the express is said once a drag: {said:?}");
        let undone = hand(&mut world, ClientMessage::Undo).unwrap();
        assert!(undone.text.starts_with("Undone"), "{undone:?}");
        assert_eq!(world.roads.len(), roads, "the drag was not taken back whole");
        assert!((world.treasury - treasury).abs() < 1e-9, "the express was not given back: {}", treasury - world.treasury);
        assert_eq!(building_of(&world, depot).stocks[&Good::Stone].level, 2.0, "the stone is not back on the shelf");
        assert_eq!(hand(&mut world, ClientMessage::Undo).unwrap().text, "Nothing to undo");
    }

    /// A building placed is one action: undone, it is gone, and what its
    /// site was brought goes back to the depot. A demolition undone
    /// stands again as it stood, for nothing. Undo goes back in order.
    #[test]
    fn undo_takes_back_a_placing_and_a_demolition_in_order() {
        let mut world = street();
        world.build = crate::tree::Build::all();
        let depot = build(&mut world, 30, BuildingKind::Depot, 1);
        let shop = build(&mut world, 12, BuildingKind::Shop, 1);
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        let at = |x, y| GridCoord { x, y };
        let timber = |w: &World| building_of(w, depot).stocks[&Good::Timber].level;
        if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
            b.stocks.get_mut(&Good::Timber).unwrap().level = 10.0;
        }
        let mut hand = |world: &mut World, message| handle_player_action(world, &mut events, &mut intersections, 1, message, 0);
        assert!(hand(&mut world, ClientMessage::Place { kind: BuildingKind::House, at: at(5, 1), facing: None }).is_none(), "the house was refused");
        let house = world.occupied[&(5, 1)];
        // Two of its four timber delivered.
        if let Some(GameObject::Building(b)) = world.objects.get_mut(house).map(|e| &mut e.object) {
            b.site.as_mut().unwrap().get_mut(&Good::Timber).unwrap().level = 2.0;
        }
        hand(&mut world, ClientMessage::Build(Build { tool: Tool::Demolish, from: at(12, 1), to: at(12, 1) }));
        assert!(world.objects.get(shop).is_none(), "the shop stands");
        assert!(hand(&mut world, ClientMessage::Undo).unwrap().text.contains("stands again"));
        let again = world.occupied[&(12, 1)];
        assert!(building_of(&world, again).site.is_none() && world.door_of(again).is_some(), "the shop is not as it stood");
        hand(&mut world, ClientMessage::Undo);
        assert!(!world.occupied.contains_key(&(5, 1)), "the house stands");
        assert_eq!(timber(&world), 12.0, "its delivered timber is not back at the depot");
    }

    /// Someone else's building on a street since laid holds it: undo says
    /// so and takes nothing back. Past its window, nothing is undone.
    #[test]
    fn undo_refuses_what_another_has_built_on_and_what_is_old() {
        let mut world = street();
        world.build = crate::tree::Build::all();
        world.treasury = 1e9;
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        let at = |x, y| GridCoord { x, y };
        let mut hand = |world: &mut World, owner, message, now| handle_player_action(world, &mut events, &mut intersections, owner, message, now);
        for y in 0..3 {
            hand(&mut world, 1, ClientMessage::Build(Build { tool: Tool::Street, from: at(10, y), to: at(10, y + 1) }), 0);
        }
        assert!(hand(&mut world, 2, ClientMessage::Place { kind: BuildingKind::House, at: at(11, 3), facing: None }, 0).is_none());
        let roads = world.roads.len();
        let no = hand(&mut world, 1, ClientMessage::Undo, 0).unwrap();
        assert_eq!((no.text.as_str(), world.roads.len()), ("Can't undo", roads), "{no:?}");
        // The house's player takes theirs back; then the street goes.
        hand(&mut world, 2, ClientMessage::Undo, 0);
        hand(&mut world, 1, ClientMessage::Undo, 0);
        assert!(world.road_node_at(at(10, 3)).is_none());
        hand(&mut world, 1, ClientMessage::Build(Build { tool: Tool::Street, from: at(20, 0), to: at(20, 1) }), 0);
        assert_eq!(hand(&mut world, 1, ClientMessage::Undo, crate::undo::WINDOW + 1).unwrap().text, "Nothing to undo");
    }

    /// A coast with no road on it: grass to y = 3, the sea from y = 4 out
    /// past the map's edge.
    fn bare_coast() -> World {
        let mut world = World::new();
        for y in -30..41 {
            for x in -60..100 {
                world.terrain.insert((x, y), if y >= 3 { TerrainType::Sea } else { TerrainType::Grass });
            }
        }
        world
    }

    /// A harbour is placed whole, its back to the sea, with a street of
    /// its own laid to its park. Inland it is refused, and why is said;
    /// taken down, it goes whole.
    #[test]
    fn a_harbour_is_placed_whole_with_its_street() {
        let mut world = bare_coast();
        world.build = crate::tree::Build::all();
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        let at = |x, y| GridCoord { x, y };
        let mut hand = |world: &mut World, message| handle_player_action(world, &mut events, &mut intersections, 1, message, 0);
        let no = hand(&mut world, ClientMessage::Place { kind: BuildingKind::Harbour, at: at(10, -10), facing: None }).expect("a harbour inland was placed");
        assert!(world.occupied.is_empty() && no.sub.contains("sea"), "{no:?}");
        assert!(hand(&mut world, ClientMessage::Place { kind: BuildingKind::Harbour, at: at(9, 2), facing: None }).is_none(), "the coast refused it");
        let id = world.occupied[&(9, 2)];
        assert!((8..11).all(|x| (1..3).all(|y| world.occupied.get(&(x, y)) == Some(&id))), "the harbour is not its whole plot");
        assert!(world.door_of(id).is_some(), "its street does not reach it");
        assert!(world.berth(id).is_some(), "it does not berth");
        let mut events = EventQueue::new();
        settle_and_wake(&mut world, &mut events);
        assert!(world.lines.contains_key(&id), "no ferry line");
        // One tap is the harbour gone, whole.
        let mut intersections = IntersectionRegistry::new();
        take_step(&mut world, &mut events, &mut intersections, Build { tool: Tool::Demolish, from: at(8, 2), to: at(8, 2) }, 0);
        assert!((8..11).all(|x| (1..3).all(|y| !world.occupied.contains_key(&(x, y)))), "part of the harbour stands");
        settle_and_wake(&mut world, &mut events);
    }

    /// A depot short of its plot, as a fixture may draw one, has no yard,
    /// and a road drawn into it asks of none: it once subtracted the
    /// yard's depth from a plot one tile deep, and the server crashed.
    #[test]
    fn a_road_into_a_depot_short_of_its_plot_is_asked_of_no_yard() {
        let mut world = street();
        world.build = crate::tree::Build::all();
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        let at = |x, y| GridCoord { x, y };
        world.raise(BuildingKind::Depot, vec![at(30, 1)], 2);
        take_step(&mut world, &mut events, &mut intersections, Build { tool: Tool::Street, from: at(31, 2), to: at(30, 1) }, 0);
        take_step(&mut world, &mut events, &mut intersections, Build { tool: Tool::Street, from: at(30, 2), to: at(30, 1) }, 0);
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
        does(&mut world, &mut events, &mut intersections, Do::Place(BuildingKind::House, at), 0);
        let house = world.occupied[&(5, 1)];
        assert!(world.door_of(house).is_some() && world.road_node_at(at).is_none(), "a house with its door, and no road on its tile");
        does(&mut world, &mut events, &mut intersections, Do::Step(Tool::Demolish, at, at), 0);
        assert!(!world.occupied.contains_key(&(5, 1)), "the house is gone");
        assert!(world.road_node_at(GridCoord { x: 5, y: 0 }).is_some(), "and the street stands");
    }

    /// A drag of the demolisher cuts only the road between the tiles it
    /// crosses. A tap takes everything at the point: a building whole.
    #[test]
    fn a_drag_cuts_a_link_and_a_tap_takes_the_point() {
        let mut world = street();
        world.build = crate::tree::Build::all();
        world.treasury = 1e9;
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        let at = |x, y| GridCoord { x, y };
        let mut hand = |world: &mut World, d| does(world, &mut events, &mut intersections, d, 0);
        // A side street, two tiles long, off the main one.
        hand(&mut world, Do::Step(Tool::Street, at(5, 0), at(5, 1)));
        hand(&mut world, Do::Step(Tool::Street, at(5, 1), at(5, 2)));
        hand(&mut world, Do::Step(Tool::Demolish, at(5, 1), at(5, 2)));
        assert!(!world.are_connected(at(5, 1), at(5, 2)), "the link is cut");
        assert!(world.road_node_at(at(5, 2)).is_none(), "and the end left with no road goes");
        assert!(world.are_connected(at(5, 0), at(5, 1)), "the rest stands");
        // A tap on any tile of a building takes it whole.
        hand(&mut world, Do::Place(BuildingKind::Depot, at(9, 3)));
        let depot = world.occupied[&(9, 3)];
        assert_eq!(building_of(&world, depot).tiles.len(), 12);
        hand(&mut world, Do::Step(Tool::Demolish, at(10, 4), at(10, 4)));
        assert!(world.objects.get(depot).is_none(), "the depot stands");
        // A tap takes the point and every link at it.
        hand(&mut world, Do::Step(Tool::Demolish, at(5, 0), at(5, 0)));
        assert!(world.road_node_at(at(5, 0)).is_none());
        assert!(world.road_node_at(at(5, 1)).is_none(), "the side street left with no road goes too");
    }

    /// A road is laid at once, on stone: a tile's comes off the nearest
    /// depot's shelf, and what the depots lack the world sends express,
    /// paid at the harbour at twice the boat's price.
    #[test]
    fn a_road_is_laid_on_stone_from_the_depot() {
        let mut world = street();
        world.build = crate::tree::Build::all();
        let depot = build(&mut world, 30, BuildingKind::Depot, 1);
        let stone = |w: &World| building_of(w, depot).stocks[&Good::Stone].level;
        if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
            b.stocks.get_mut(&Good::Stone).unwrap().level = 2.0;
        }
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        let at = |x, y| GridCoord { x, y };
        let treasury = world.treasury;
        let mut hand = |world: &mut World, from, to| take_step(world, &mut events, &mut intersections, Build { tool: Tool::Street, from, to }, 0);
        hand(&mut world, at(10, 0), at(10, 1));
        hand(&mut world, at(10, 1), at(10, 2));
        assert_eq!(stone(&world), 0.0, "two tiles took {} stone", 2.0 - stone(&world));
        assert_eq!(world.treasury, treasury, "stone in stock was paid for");
        hand(&mut world, at(10, 2), at(10, 3));
        let express = crate::economy::EXPRESS * crate::economy::import(Good::Stone, crate::economy::ROAD_STONE);
        assert!((treasury - world.treasury - express).abs() < 1e-9, "the third tile cost {}", treasury - world.treasury);
        assert!(world.lumps.iter().any(|l| l.building == harbour_of(&world) && l.coins < 0.0 && l.good == Some(Good::Stone)), "no lump at the harbour");
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
            // Lunches over a whole day: the shops have no depot here, so
            // by the third day their shelves have run down some.
            assert!(sold(lunch, "Eat", "yesterday_h") > 1.5, "lunch shop sold {}h", sold(lunch, "Eat", "yesterday_h"));
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
        world.finish(home);
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
            take_step(&mut world, &mut events, &mut intersections, Build { tool: Tool::Street, from, to }, 0);
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
        season_with(street(), mix, days, |_, _| Vec::new(), |_, _, _| {})
    }

    /// The mayor's steps, as the hand takes them.
    type Steps = Vec<Do>;

    /// `live` on a street of the caller's, founded with the stake: the
    /// mayor's hand at every midnight, `hand`, and a look at the town at
    /// the end of every day, after the midnight wake, `each_day`.
    fn season_with(mut world: World, mix: &[BuildingKind], days: u64, mut hand: impl FnMut(&World, u64) -> Steps, mut each_day: impl FnMut(&World, u64, u64)) -> (World, u64) {
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
                b.lorries = 1;
                b.rules.get_mut(&Good::Crates).unwrap().sell = Some(100.0);
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
            let steps = hand(&world, day);
            if !steps.is_empty() {
                for d in steps {
                    does(&mut world, &mut events, &mut intersections, d, now);
                }
                settle_and_wake(&mut world, &mut events);
            }
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
            season_with(world, &town_mix(), 1, |_, _| Vec::new(), |_, _, _| {});
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
    /// each the median of a row of them: a house placed across the
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
        let mut timed = |world: &mut World, steps: Vec<Do>| {
            let started = Instant::now();
            for d in steps {
                does(world, &mut events, &mut intersections, d, 0);
            }
            settle_and_wake(world, &mut events);
            started.elapsed().as_secs_f64() * 1e6
        };
        let at = |x, y| GridCoord { x, y };
        let mut costs: Vec<(&'static str, Vec<f64>)> = ["a house", "its demolition", "a shop", "its demolition", "a road"].map(|n| (n, Vec::new())).into();
        for i in 0..20 {
            let x = 4 + 8 * i;
            for (k, kind) in [BuildingKind::House, BuildingKind::Shop].into_iter().enumerate() {
                // Placed across the street.
                let placed = timed(&mut world, vec![Do::Place(kind, at(x, -1))]);
                let id = *world.occupied.get(&(x, -1)).unwrap_or_else(|| panic!("the {kind:?} went down"));
                // Its timber in, it stands, and the settle that follows is
                // part of what it cost.
                world.finish(id);
                let stood = timed(&mut world, Vec::new());
                costs[2 * k].1.push(placed + stood);
                let bp = crate::blueprint::blueprint(kind);
                assert_eq!((world.household(id).len(), world.staff(id).len()), (bp.homes as usize, bp.jobs as usize), "the {kind:?} filled");
                // Taken down with a tap.
                costs[2 * k + 1].1.push(timed(&mut world, vec![Do::Step(Tool::Demolish, at(x, -1), at(x, -1))]));
                assert!(world.objects.get(id).is_none(), "the {kind:?} came down");
            }
            let steps = (0..4).map(|y| Do::Step(Tool::Street, at(x + 6, -y), at(x + 6, -y - 1))).collect();
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
    /// placed, demolished, the street before one taken up and laid again
    /// — and after every one, the town is settled.
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
        let mut act = |world: &mut World, d: Do| {
            does(world, &mut events, &mut intersections, d, 0);
            settle_and_wake(world, &mut events);
            assert_settled(world, &format!("{d:?}"));
        };
        // Placed across the street: two houses and an office.
        act(&mut world, Do::Place(BuildingKind::House, at(20, -1)));
        act(&mut world, Do::Place(BuildingKind::House, at(24, -1)));
        act(&mut world, Do::Place(BuildingKind::Office, at(41, -1)));
        // The office and a house taken down, and the street before a third
        // taken up and laid again.
        act(&mut world, Do::Step(Tool::Demolish, at(40, -1), at(40, -1)));
        assert!(!world.occupied.contains_key(&(41, -1)), "the office stands");
        act(&mut world, Do::Step(Tool::Demolish, at(0, 1), at(0, 1)));
        let street_of = |world: &World, x, y| {
            let (_, street) = world.door_of(*world.occupied.get(&(x, y)).unwrap()).expect("placed with a door");
            world.objects.get(street).unwrap().position.unwrap()
        };
        // Its street taken up, its door moves to the next street tile
        // along, on the diagonal; that one taken up too, it has none.
        let street = street_of(&world, 24, -1);
        act(&mut world, Do::Step(Tool::Demolish, street, street));
        let next = street_of(&world, 24, -1);
        assert_ne!(next, street, "the door stayed on the street that went");
        act(&mut world, Do::Step(Tool::Demolish, next, next));
        let other = street_of(&world, 24, -1);
        act(&mut world, Do::Step(Tool::Demolish, other, other));
        assert!(world.street_of(*world.occupied.get(&(24, -1)).unwrap()).is_none(), "the street went");
        act(&mut world, Do::Step(Tool::Street, at(street.x - 1, street.y), street));
        act(&mut world, Do::Step(Tool::Street, street, at(street.x + 1, street.y)));
        assert_eq!(street_of(&world, 24, -1), street, "the street came back");
    }

    /// Where the season's quarry and sawmill stand, past the town's forty
    /// plots, each with its ground behind it.
    const QUARRY_X: i32 = 150;
    const SAWMILL_X: i32 = 170;

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
    ///
    /// And it builds: a quarry at the mountain's foot and a sawmill in the
    /// woods, and every midnight the mayor puts down a block of flats, of
    /// timber and stone, and a side street of three tiles laid on stone.
    /// Every site stands within a day of the next midnight: the depot's
    /// lorry fetches from the quarry and the sawmill, its vans take the
    /// materials to the sites, and the roads draw on the depot's stone.
    #[test]
    #[ignore]
    fn season_the_shelves_stay_stocked_and_everyone_eats() {
        use crate::needs::Need;
        let days = season_days();
        // The mountain behind the quarry's plot, and the woods behind the
        // sawmill's, beyond the town's forty.
        let mut world = street();
        world.build = crate::tree::Build::all();
        for (x0, ground) in [(QUARRY_X, TerrainType::Mountain), (SAWMILL_X, TerrainType::Forest)] {
            for x in x0 - 5..x0 + 7 {
                for y in 5..14 {
                    world.terrain.insert((x, y), ground);
                }
            }
        }
        let quarry = build(&mut world, QUARRY_X, BuildingKind::Quarry, 1);
        let sawmill = build(&mut world, SAWMILL_X, BuildingKind::Sawmill, 1);
        let mut stood = 0;
        // Each midnight, a block of flats across the street, and a side
        // street beside it.
        let hand = |_: &World, day: u64| -> Steps {
            let x = 112 + 4 * (day as i32 - 1);
            let at = |x, y| GridCoord { x, y };
            vec![
                Do::Place(BuildingKind::Apartment, at(x + 1, -1)),
                Do::Step(Tool::Street, at(x + 2, 0), at(x + 2, -1)),
                Do::Step(Tool::Street, at(x + 2, -1), at(x + 2, -2)),
                Do::Step(Tool::Street, at(x + 2, -2), at(x + 2, -3)),
            ]
        };
        let mut empty_since: std::collections::BTreeMap<(EntityId, String), u64> = Default::default();
        let mut stood_empty = |what: (EntityId, String), empty: bool, day: u64| -> u64 {
            if empty {
                day - *empty_since.entry(what).or_insert(day)
            } else {
                empty_since.remove(&what);
                0
            }
        };
        // Yesterday's eating, hours had and asked: the town is fed over two
        // days, so a day's timing is not taken for a chain that fails.
        let mut yesterday = (0.0, 0.0);
        let (world, _) = season_with(world, &town_mix(), days, hand, |world, day, _| {
            let midnight = day * DAY_MS as u64;
            let page = world.town.before(midnight);
            // Every block of flats put down at a midnight stands by the next.
            let flats = |site: bool| world.objects.iter().filter(|e| matches!(e.object, GameObject::Building(ref b) if b.kind == BuildingKind::Apartment && b.tiles[0].y < 0 && b.site.is_some() == site)).count();
            stood = flats(false);
            let waiting: Vec<_> = world.calls.iter().filter(|c| matches!(world.objects.get(c.at).map(|e| &e.object), Some(GameObject::Building(b)) if b.site.is_some())).collect();
            assert_eq!(stood as u64, day - 1, "day {day}: {} sites still waiting; calls {waiting:?}", flats(true));
            let level = |id: EntityId, good: Good| match world.objects.get(id).map(|e| &e.object) {
                Some(GameObject::Building(b)) => b.stocks.get(&good).map_or(0.0, |s| s.level),
                _ => 0.0,
            };
            let depot = world.objects.iter().find(|e| matches!(e.object, GameObject::Building(ref b) if b.kind == BuildingKind::Depot)).map(|e| e.id).unwrap();
            println!(
                "  built: {stood} blocks of flats; yards: quarry {:.0} stone, sawmill {:.0} timber; depot {:.0} stone, {:.0} timber; bought {:.1?}",
                level(quarry, Good::Stone),
                level(sawmill, Good::Timber),
                level(depot, Good::Stone),
                level(depot, Good::Timber),
                page.bought,
            );
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
            // `SEA=1` prints the border each midnight: every box and
            // where it is, every lorry and what it hauls, and the yards.
            if std::env::var("SEA").is_ok() {
                let sea = crate::haul::inspect(world, midnight);
                for h in sea["harbours"].as_array().unwrap() {
                    let park: Vec<String> = h["park"].as_array().unwrap().iter().map(|t| if t.is_null() { "_".into() } else { format!("{}{}", t["good"].as_str().map_or("E", |g| &g[..1]), if t["outbound"].as_bool().unwrap() { "^" } else { "" }) }).collect();
                    println!("  park {} deck {} booked {}", park.join(""), h["ferry"]["deck"].as_array().unwrap().iter().filter(|t| !t.is_null()).count(), h["ferry"]["booked"].as_array().unwrap().len());
                }
                for l in sea["lorries"].as_array().unwrap() {
                    println!("  lorry {} to {} hitched {}", l["id"], l["to"], l["hitched"]);
                }
                for e in world.objects.iter() {
                    if let GameObject::Building(ref b) = e.object
                        && matches!(b.kind, BuildingKind::Depot | BuildingKind::Farm)
                    {
                        println!("  {:?} {} {:?}", b.kind, e.id, b.stocks.iter().map(|(g, s)| (*g, s.level as i32)).collect::<Vec<_>>());
                    }
                }
            }
            let (had, of) = std::mem::replace(&mut yesterday, (eaten, asked));
            if day > 2 {
                assert!(eaten + had >= 0.9 * (asked + of), "days {}–{day}: the town ate {:.1}h of the {:.1}h its people need", day - 1, eaten + had, asked + of);
            }
            if day > 1 {
                for need in [Need::Work, Need::Eat, Need::Fuel] {
                    assert!(out.get(&need).is_some_and(|&h| h > 0.0), "day {day}: nobody in town was served {need:?}");
                }
            }
        });
        let sold = world.town.season().map(|p| p.sold.get(&Good::Crates).copied().unwrap_or(0.0)).sum::<f64>();
        println!("the season: treasury {:.1}, crates sold to the world for {sold:.1}, {stood} sites stood", world.treasury);

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

    fn car_of(world: &World, id: EntityId) -> crate::protocol::Car {
        match world.objects.get(id).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.clone(),
            _ => panic!("no car {id}"),
        }
    }

    fn building_of(world: &World, id: EntityId) -> crate::protocol::Building {
        match world.objects.get(id).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.clone(),
            _ => panic!("no building {id}"),
        }
    }

    /// A harbour on a real coast, seed 7's, where the map's edge is two
    /// hours' sail out: the world's line takes two ferries, so the
    /// harbour is called at as often as the old ferry's 6.4 a day, the
    /// two passing at sea, never both at the ramp, the second waiting
    /// beyond the edge if it would be.
    #[test]
    fn a_real_coast_is_called_at_as_often_as_ever() {
        let mut world = World::new();
        world.terrain = crate::terrain::generate(7);
        world.place_road_path(&(-6..10).map(|x| GridCoord { x, y: 32 }).collect::<Vec<_>>());
        let harbour = world.place_on_street(GridCoord { x: 1, y: 33 }, BuildingKind::Harbour).expect("seed 7's north coast takes a harbour");
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        let ferries = world.ferries_of(harbour);
        assert_eq!(ferries.len(), 2, "the world's line, {} ms round, runs {} ferries", world.lines[&harbour].cycle(), ferries.len());
        let (mut now, mut calls, mut moored) = (0, 0, vec![false; 2]);
        let days = 2;
        while step(&mut world, &mut events, &mut intersections, &mut now, days * DAY_MS as u64) {
            let here: Vec<bool> = ferries.iter().map(|&f| car_of(&world, f).spot.is_some()).collect();
            assert!(here.iter().filter(|&&m| m).count() <= 1, "two ferries at the ramp at {now}");
            calls += here.iter().zip(&moored).filter(|&(&h, &m)| h && !m).count();
            moored = here;
        }
        let per_day = calls as f64 / days as f64;
        assert!(per_day >= 6.0, "{per_day} calls a day");
    }

    /// The opening, done: what the town's situation waits for.
    fn opening_done(world: &mut World) {
        world.missions.list.iter_mut().for_each(|m| m.finished = Some(0));
    }

    /// A shelf emptied, or filled.
    fn shelve(world: &mut World, at: EntityId, good: Good, level: f64) {
        if let Some(GameObject::Building(b)) = world.objects.get_mut(at).map(|e| &mut e.object) {
            b.stocks.get_mut(&good).unwrap().level = level;
        }
    }

    /// A situation opens its mission when it first matters, once: a site
    /// calls for stone that no depot in town has. Not during the opening,
    /// not while a depot has some and only its van is busy, and not
    /// again once open; and building the quarry it asks for finishes it
    /// and pays.
    #[test]
    fn a_site_short_of_stone_asks_for_a_quarry_once() {
        use crate::missions::Key;
        let mut world = street();
        world.build = crate::tree::Build::all();
        for x in QUARRY_X - 5..QUARRY_X + 7 {
            for y in 5..14 {
                world.terrain.insert((x, y), TerrainType::Mountain);
            }
        }
        let depot = build(&mut world, 30, BuildingKind::Depot, 1);
        for good in [Good::Stone, Good::Timber, Good::Crates, Good::Fuel] {
            shelve(&mut world, depot, good, if good == Good::Stone { 0.0 } else { 100.0 });
        }
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        let quarry = |world: &mut World| missions(world, 0).into_iter().filter(|m| m.0 == Key::Quarry).map(|m| m.2).collect::<Vec<_>>();
        // Flats, a site of timber and stone, call for both, and the depot
        // has no stone.
        let at = GridCoord { x: 100, y: 1 };
        let facing = world.site_for(at, BuildingKind::Apartment).unwrap();
        let flats = world.place_building(at, BuildingKind::Apartment, facing).unwrap();
        world.orient(flats);
        calls::turn(&mut world, &mut events, flats, 0);
        assert!(world.calls.iter().any(|c| c.at == flats && c.good == Good::Stone && c.answered_by.is_none()), "the flats never called for stone");
        assert_eq!(quarry(&mut world), [false; 0], "it opened during the opening");
        opening_done(&mut world);
        // A depot with stone sends its van, and the town is not short.
        shelve(&mut world, depot, Good::Stone, 10.0);
        calls::dispatch(&mut world, &mut events, 0);
        let van = world.calls.iter().find(|c| c.at == flats && c.good == Good::Stone).and_then(|c| c.answered_by).expect("the van never set out");
        assert!(car_of(&world, van).load.is_some_and(|(g, u)| g == Good::Stone && u > 0.0), "the van set out without its stone on it, to be seen");
        assert_eq!(quarry(&mut world), [false; 0], "it opened while the depot had stone");
        // Then the shelf is empty, and the flats call again.
        world.calls.clear();
        shelve(&mut world, depot, Good::Stone, 0.0);
        calls::turn(&mut world, &mut events, flats, 0);
        assert_eq!(quarry(&mut world), [false], "no depot has stone, and nothing asked for a quarry");
        calls::dispatch(&mut world, &mut events, 0);
        calls::turn(&mut world, &mut events, flats, 0);
        assert_eq!(quarry(&mut world), [false], "it opened twice");
        let before = world.treasury;
        build(&mut world, QUARRY_X, BuildingKind::Quarry, 1);
        settle_and_wake(&mut world, &mut events);
        assert_eq!(quarry(&mut world), [true], "the quarry stands and the mission is open");
        assert!((world.treasury - before - 50.0).abs() < 1e-9, "the quarry's mission paid {}", world.treasury - before);
        let _ = intersections;
    }

    /// A car low on fuel with nowhere in town to fill it asks for a gas
    /// station, once the opening is done; a full tank does not.
    #[test]
    fn a_car_running_dry_asks_for_a_gas_station() {
        use crate::missions::Key;
        use crate::needs::Need;
        let mut world = street();
        let house = build(&mut world, 10, BuildingKind::House, 1);
        let mut events = EventQueue::new();
        settle_and_wake(&mut world, &mut events);
        let id = world.household(house)[0];
        let car = match world.objects.get(id).map(|e| &e.object) {
            Some(GameObject::Resident(r)) => r.car,
            _ => unreachable!(),
        };
        if let Some(GameObject::Resident(r)) = world.objects.get_mut(id).map(|e| &mut e.object) {
            r.at = Some(house);
        }
        let tank = |world: &mut World, full: f64| {
            if let Some(GameObject::Car(c)) = world.objects.get_mut(car).map(|e| &mut e.object) {
                let s = c.stocks.get_mut(&Need::Fuel).unwrap();
                s.level = s.cap * full;
            }
        };
        let pump = |world: &World| world.missions.list.iter().filter(|m| m.key == Key::Pump).count();
        tank(&mut world, 0.1);
        handle_resident_wake(&mut world, &mut events, id, 0);
        assert_eq!(pump(&world), 0, "it opened during the opening");
        opening_done(&mut world);
        tank(&mut world, 0.9);
        handle_resident_wake(&mut world, &mut events, id, 1);
        assert_eq!(pump(&world), 0, "a full tank asked for a pump");
        tank(&mut world, 0.1);
        handle_resident_wake(&mut world, &mut events, id, 2);
        handle_resident_wake(&mut world, &mut events, id, 3);
        assert_eq!(pump(&world), 1, "a dry tank with nowhere to fill opened {} missions", pump(&world));
    }

    /// The open missions' steps, by mission, as the tick reads them.
    fn missions(world: &mut World, now: GameTime) -> Vec<(crate::missions::Key, Vec<bool>, bool)> {
        crate::missions::check(world, now);
        world.missions.list.iter().map(|m| (m.key, m.steps.iter().map(|s| s.done).collect(), m.finished.is_some())).collect()
    }

    /// The opening's steps done.
    fn opening(world: &mut World, now: GameTime) -> Vec<bool> {
        missions(world, now).into_iter().find(|m| m.0 == crate::missions::Key::Opening).expect("no opening").1
    }

    /// The opening, docs/game.md: a harbour, a depot, a street between
    /// them. The first ferry comes in on time with the starter pack and
    /// the tug lands it in the trailer park, for nothing; the mayor taps
    /// the depot's lorry, which fetches a box and unloads it onto the
    /// shelf; standing orders fetch the rest. A house is a site until a
    /// van brings its timber; then its settlers come on the next ferry and
    /// drive home. A box of crates sold goes out on the ferry, paid as it
    /// casts off; and the ferry keeps its timetable throughout. The
    /// opening mission ticks off each step as the town does it, on the
    /// server, and pays when the last is done; the trunk follows it.
    #[test]
    fn the_opening_from_the_harbour() {
        use crate::missions::Key;
        use crate::world::sea::{DWELL, FIRST_CALL};
        let mut world = street();
        let harbour = harbour_of(&world);
        assert_eq!(opening(&mut world, 0), [true, false, false, false, false], "the harbour stands, and nothing else");
        let x = HARBOUR_X - 12;
        let facing = world.site_for(GridCoord { x, y: 1 }, BuildingKind::Depot).unwrap();
        let depot = world.place_building(GridCoord { x, y: 1 }, BuildingKind::Depot, facing).unwrap();
        world.orient(depot);
        assert!(building_of(&world, depot).site.is_none(), "the first depot is a site");
        assert!(building_of(&world, depot).stocks.values().all(|s| s.level == 0.0), "the depot stood stocked");
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        assert_eq!(opening(&mut world, 0), [true, true, true, false, false], "a depot on the harbour's street");
        let ferry = world.ferry_of(harbour).expect("the harbour's ferry");
        let tug = world.tug_of(harbour).expect("the harbour's tug");
        let lorry = crate::haul::lorry_of(&world, depot).expect("the depot's lorry");
        assert_eq!(car_of(&world, ferry).booked.len(), 6, "the starter pack is booked");
        // A settle with nothing new touches nothing: what it touches goes
        // to every client, and is written down, each tick.
        world.objects.drain_dirty();
        settle_and_wake(&mut world, &mut events);
        assert_eq!(world.objects.drain_dirty(), (vec![], vec![]), "a quiet settle changed something");
        let day = DAY_MS as u64;
        let mut now = 0;

        // In from the map's edge, never over land, and moored with the
        // starter pack on deck, on time.
        let turn = world.turn(harbour).expect("the harbour's line");
        let mut sailed = false;
        while car_of(&world, ferry).spot.is_none() {
            assert!(step(&mut world, &mut events, &mut intersections, &mut now, day), "the ferry never berthed");
            if let Some(sail) = car_of(&world, ferry).sail {
                assert!(world.water.get().unwrap().afloat(&sail.path), "the ferry's way crosses land");
                sailed = true;
            }
        }
        let berthed = now;
        assert!(sailed, "it never sailed in");
        assert!(berthed <= FIRST_CALL + 100, "the first ferry berthed at {berthed}, due at {FIRST_CALL}");
        assert_eq!(car_of(&world, ferry).deck.iter().flatten().count(), 6, "the starter pack is not aboard");
        // The tug unloads while it is in, and it sails on time.
        let mut shunted = false;
        while car_of(&world, ferry).spot.is_some() {
            assert!(step(&mut world, &mut events, &mut intersections, &mut now, day), "the ferry never sailed");
            shunted |= car_of(&world, tug).shunt.is_some();
        }
        assert!(shunted, "the tug never moved");
        assert!(now - berthed <= DWELL + 100, "it sailed late: {} after berthing", now - berthed);
        let parked = |w: &World| building_of(w, harbour).park.iter().filter(|s| s.trailer.is_some()).count();
        assert!(parked(&world) >= 3, "only {} boxes landed in the park", parked(&world));
        assert_eq!(world.treasury, crate::economy::STAKE, "the starter pack was paid for");

        // The mayor taps the lorry: it fetches a box and unloads it.
        let stock = |w: &World| building_of(w, depot).stocks.values().map(|s| s.level).sum::<f64>();
        crate::haul::send(&mut world, &mut events, depot);
        let until = now + day / 12;
        while stock(&world) == 0.0 && step(&mut world, &mut events, &mut intersections, &mut now, until) {}
        assert!(stock(&world) > 0.0, "the tapped lorry brought nothing home in two hours");
        assert!(car_of(&world, lorry).hitched.is_none(), "the box was not gone into stock");
        assert!(world.lumps.iter().any(|l| l.building == depot && l.units > 0.0), "no lump for the unload");
        assert_eq!(opening(&mut world, now), [true, true, true, true, false], "the box fetched");

        // A second lorry, bought from the world, and standing orders for
        // both: they fetch the rest.
        let before = world.treasury;
        crate::haul::buy_lorry(&mut world, &mut events, depot, now);
        assert_eq!(crate::haul::lorries_of(&world, depot).len(), 2, "no second lorry");
        assert!((before - world.treasury - crate::haul::LORRY_PRICE).abs() < 1e-9, "the lorry was not paid for");
        crate::haul::set_standing(&mut world, &mut events, depot, true);
        let until = now + day / 4;
        while (parked(&world) > 0 || car_of(&world, ferry).deck.iter().flatten().any(|t| !t.outbound)) && step(&mut world, &mut events, &mut intersections, &mut now, until) {}
        let shelf = |w: &World, g: Good| building_of(w, depot).stocks[&g].level;
        assert!(shelf(&world, Good::Timber) >= 40.0, "the timber did not come in: {}", shelf(&world, Good::Timber));

        // A house, placed: a site until a van brings its timber.
        let player = 7;
        let house_at = GridCoord { x: 20, y: 1 };
        let refused = handle_player_action(&mut world, &mut events, &mut intersections, player, ClientMessage::Place { kind: BuildingKind::House, at: house_at, facing: None }, now);
        assert!(refused.is_none(), "the house was refused: {refused:?}");
        settle_and_wake(&mut world, &mut events);
        let house = world.occupied[&(20, 1)];
        assert!(building_of(&world, house).site.is_some(), "the house stood without its timber");
        assert!(world.household(house).is_empty(), "people moved into a site");
        let until = now + day / 4;
        while building_of(&world, house).site.is_some() && step(&mut world, &mut events, &mut intersections, &mut now, until) {}
        assert!(building_of(&world, house).site.is_none(), "the van never brought the timber");
        settle_and_wake(&mut world, &mut events);
        let settlers = world.household(house);
        assert_eq!(settlers.len(), 2, "nobody moved in");
        // They come on the next ferry, and drive home: off the deck from
        // where each stood aboard, over the ramp and up the lane.
        let until = now + turn + DWELL + day / 6;
        let berth = world.berth(harbour).unwrap();
        let mut rolled = 0;
        while settlers.iter().any(|&id| at_of(&world, id) != Some(house)) && step(&mut world, &mut events, &mut intersections, &mut now, until) {
            for &id in &settlers {
                let Some(GameObject::Resident(r)) = world.objects.get(id).map(|e| &e.object) else { continue };
                if let Some(t) = car_of(&world, r.car).trip.filter(|t| t.progress == 0.0 && t.route_positions.len() > 3) {
                    let start = t.leaves.expect("a settler leaves from its seat");
                    assert_eq!(start.at, t.route_positions[0]);
                    let up = |p: [f64; 2]| (p[0] - berth.ramp()[0]) * berth.landward().cos() + (p[1] - berth.ramp()[1]) * berth.landward().sin();
                    assert!(up(start.at) < -0.3, "a settler set off from {:?}, not the deck", start.at);
                    rolled += 1;
                }
            }
        }
        assert!(rolled > 0, "no settler was seen rolling off the deck");
        assert!(settlers.iter().all(|&id| at_of(&world, id) == Some(house)), "the settlers never got home");
        // The opening done, and paid; standing orders were given above, so
        // the trunk's first is done as it opens, and the next waits on a
        // rule for stone.
        let before = world.treasury;
        assert_eq!(opening(&mut world, now), [true; 5], "the settlers came");
        assert!((world.treasury - before - 125.0).abs() < 1e-9, "the opening and standing orders paid {}", world.treasury - before);
        let trunk = |world: &mut World, now| missions(world, now).into_iter().map(|(k, _, done)| (k, done)).collect::<Vec<_>>();
        assert_eq!(trunk(&mut world, now), [(Key::Opening, true), (Key::Standing, true), (Key::Stone, false)]);
        let rule = crate::protocol::Rule { keep: 20.0, fill: 40.0, sell: None };
        handle_player_action(&mut world, &mut events, &mut intersections, player, ClientMessage::SetRule { depot, good: Good::Stone, rule: Some(rule) }, now);
        assert_eq!(trunk(&mut world, now)[2..], [(Key::Stone, true), (Key::Sell, false)]);

        // A box of crates sold: out on the ferry, paid as it casts off.
        let before = world.treasury;
        crate::haul::sell(&mut world, &mut events, depot, Good::Crates);
        let until = now + 2 * turn;
        while world.town.on(now).sold.get(&Good::Crates).is_none() && step(&mut world, &mut events, &mut intersections, &mut now, until) {}
        let sold = world.town.on(now).sold.get(&Good::Crates).copied().unwrap_or(0.0);
        assert!((sold - crate::economy::export(Good::Crates, 100.0)).abs() < 1e-6, "the box went out for {sold}");
        assert!(world.lumps.iter().any(|l| l.building == harbour && l.coins > 0.0), "no coins landed at the harbour");
        assert_eq!(trunk(&mut world, now)[3], (Key::Sell, true), "the box sold");
        let _ = before;
    }
}
