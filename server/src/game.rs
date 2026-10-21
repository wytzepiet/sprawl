use crate::fixed::{HashMap, HashSet};

use crate::car::simulation::{handle_car_wake_up, park_at_home};
use crate::car::ACCELERATION;
use crate::resident::handle_resident_wake;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::intersection::IntersectionRegistry;
use crate::protocol::{Build, BuildingKind, CarRole, ChunkBounds, ChunkCoord, ClientMessage, Clock, DAY_MS, EntityId, GameObject, GameObjectEntry, Operation, OwnerId, Lump, News, ServerMessage, StateUpdate, Tool, GridCoord};
use crate::world::chunk_of;
use crate::world::decks::MIDDLE;
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
/// How often the game settles with nothing built: sites call for timber,
/// ferries look at the time.
const SETTLE_MS: GameTime = 500;
/// Guards against a speed that would peg the loop and stall the socket.
const MAX_SPEED: u32 = 50;

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
    /// A command changed the world since the last step: it settles.
    stirred: bool,
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
            clients: HashMap::default(),
            outbox: Vec::new(),
            stirred: false,
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
        let update = Shared::new(&self.world, self.clock()).update(vec![], vec![]);
        self.send(id, update);
        self.send(id, ServerMessage::Market(self.world.market.prices()));
        self.clients.insert(id, ClientState { owner, subscribed: None, known_chunks: HashSet::default(), known: HashSet::default() });
    }

    pub fn disconnect(&mut self, id: ClientId) {
        self.clients.remove(&id);
    }

    /// A message from a client, done.
    pub fn command(&mut self, client_id: ClientId, message: ClientMessage) {
        match message {
            ClientMessage::SetSpeed(s) => {
                self.speed = s.min(MAX_SPEED);
                // Paused, nothing goes dirty and no update would ever be
                // sent — so clients would keep extrapolating cars against
                // a stopped world. Push the new clock instead of waiting.
                let update = Shared::new(&self.world, self.clock()).update(vec![], vec![]);
                let ids: Vec<ClientId> = self.clients.keys().copied().collect();
                for id in ids {
                    self.send(id, update.clone());
                }
            }
            ClientMessage::SetChunks(bounds) => {
                let mut shared = Shared::new(&self.world, self.clock());
                handle_set_chunks(&mut shared, &mut self.clients, &mut self.outbox, client_id, bounds);
            }
            ClientMessage::ResetWorld => {
                let world = (self.fresh)();
                self.replace(world);
            }
            ClientMessage::Ask(ask) => {
                let Some(owner) = self.clients.get(&client_id).map(|cs| cs.owner) else { return };
                let hint = crate::hint::answer(&self.world, owner, ask);
                self.send(client_id, ServerMessage::Hint(hint));
            }
            message => {
                let Some(owner) = self.clients.get(&client_id).map(|cs| cs.owner) else { return };
                self.stirred = true;
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
        let mut shared = Shared::new(&self.world, clk);
        for id in &ids {
            let cs = self.clients.get_mut(id).unwrap();
            let ops: Vec<Operation> = cs.known.drain().map(Operation::Delete).collect();
            let chunks: Vec<ChunkCoord> = cs.known_chunks.drain().collect();
            if !ops.is_empty() {
                self.outbox.push((*id, shared.update(ops, vec![])));
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
        let mut shared = Shared::new(&self.world, clk);
        for id in ids {
            if let Some(bounds) = self.clients.get(&id).and_then(|cs| cs.subscribed) {
                handle_set_chunks(&mut shared, &mut self.clients, &mut self.outbox, id, bounds);
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
        let mut wakes = 0;
        for _ in 0..self.speed {
            before(self);
            wakes += self.step();
        }
        let clk = self.clock();
        flush_dirty(&mut self.world, &mut self.clients, &mut self.outbox, clk);
        if std::mem::take(&mut self.world.market.changed) {
            let prices = self.world.market.prices();
            for &id in self.clients.keys() {
                self.outbox.push((id, ServerMessage::Market(prices.clone())));
            }
        }
        wakes
    }

    /// One step of simulated time, and everything due in it. How many wakes.
    ///
    /// Whatever the commands built, reached, cut off or took away settles
    /// at the step after them, once for the batch (the road brush sends a
    /// command a tile); else every `SETTLE_MS`. By the steps, not by the
    /// ticks: a tick is as many steps as the clock's speed, and what the
    /// game does must not depend on how fast it is watched (`replay.rs`).
    pub fn step(&mut self) -> u32 {
        if std::mem::take(&mut self.stirred) || !self.world.unsettled.is_empty() || self.now % SETTLE_MS == 0 {
            settle_and_wake(&mut self.world, &mut self.events);
        }
        self.now += STEP_MS;
        self.events.set_now(self.now);
        let mut wakes = 0;
        while let Some(id) = self.events.pop_due() {
            handle_wake(&mut self.world, &mut self.events, &mut self.intersections, id, self.now);
            wakes += 1;
        }
        crate::market::hour(&mut self.world, &mut self.events, self.now);
        // Before the flush, which takes the lumps a mission reads.
        crate::missions::check(&mut self.world, self.now);
        wakes
    }
}

pub fn clock(now: GameTime, speed: u32) -> Clock {
    Clock { now, speed, day_ms: DAY_MS }
}

/// Every update carries the ambient world state alongside its ops, so a client
/// never has to ask for the island's extent separately: this, its ops and
/// lumps empty.
pub fn state_update(world: &World, clk: Clock) -> StateUpdate {
    StateUpdate {
        ops: Vec::new(),
        lumps: Vec::new(),
        clock: clk,
        growth: crate::economy::growth(world, clk.now),
        sea: crate::haul::sea(world),
        missions: world.missions.shown(clk.now),
        neighbours: crate::orders::neighbours(world),
        island: ChunkBounds { min_cx: crate::terrain::CHUNKS_MIN, min_cy: crate::terrain::CHUNKS_MIN, max_cx: crate::terrain::CHUNKS_MAX, max_cy: crate::terrain::CHUNKS_MAX },
    }
}

/// The ambient state of one moment, the same for every client: built the
/// first time an update needs it, and each update after a copy of it.
struct Shared<'a> {
    world: &'a World,
    clk: Clock,
    built: Option<StateUpdate>,
}

impl<'a> Shared<'a> {
    fn new(world: &'a World, clk: Clock) -> Self {
        Shared { world, clk, built: None }
    }

    fn update(&mut self, ops: Vec<Operation>, lumps: Vec<Lump>) -> ServerMessage {
        let (world, clk) = (self.world, self.clk);
        ServerMessage::Update(StateUpdate { ops, lumps, ..self.built.get_or_insert_with(|| state_update(world, clk)).clone() })
    }
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
        ClientMessage::Draw(stroke) => return crate::draw::draw(world, events, intersections, owner, stroke, now),
        ClientMessage::Place { kind, at, facing } => return place(world, events, intersections, kind, at, facing, now),
        ClientMessage::Raze { building } => return crate::undo::raze(world, events, intersections, building, now),
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
        ClientMessage::Trade { good, boxes, out } => {
            crate::market::trade(world, good, out, boxes);
            crate::haul::call_lorries(world, events);
        }
        ClientMessage::Send { letter, boxes } => {
            crate::orders::send(world, letter, boxes);
            crate::haul::call_lorries(world, events);
        }
        ClientMessage::Order { good, out, boxes, price } => crate::market::order(world, good, out, boxes, price),
        ClientMessage::Cancel { order } => crate::market::cancel(world, order),
        ClientMessage::BuyLorry { depot } => crate::haul::buy_lorry(world, events, depot, now),
        ClientMessage::SetSpeed(_) | ClientMessage::ResetWorld | ClientMessage::SetChunks(_) | ClientMessage::Ask(_) => {
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
    // Along a road already there, a step changes its priority or its
    // lanes, and lays nothing for an undo to take up.
    let [hf, ht] = step.up.unwrap_or_default();
    let [sf, st] = step.sides.unwrap_or_default();
    let repaint = matches!(step.tool, Tool::Street | Tool::OneWay | Tool::Wide) && world.link_between_at(step.from, hf, sf, step.to, ht, st).is_some();
    if !take_step(world, events, intersections, step, now) || repaint {
        return None;
    }
    let paid = purse.paid(world);
    // Road laid lately and taken up again gives back what it paid; only
    // the rest is kept to undo.
    let (taken, back) = match taken {
        Some(crate::undo::Act::Cut(links)) => {
            let (kept, back) = crate::undo::recoup(world, links, now);
            ((!kept.is_empty()).then_some(crate::undo::Act::Cut(kept)), back)
        }
        other => (other, String::new()),
    };
    let news = crate::undo::stepped(world, owner, step, taken, paid, after, now);
    if back.is_empty() { news } else { Some(News { text: "Road taken back".into(), sub: back, at: 0 }) }
}

/// A building placed whole round `at`, its front facing this way or the
/// first way it fits: a site that calls for its materials at once. A
/// harbour lays its street first. Kept to undo; refused, the reason, for
/// the hand that asked.
#[allow(clippy::too_many_arguments)]
fn place(world: &mut World, events: &mut EventQueue, intersections: &mut IntersectionRegistry, kind: BuildingKind, at: GridCoord, facing: Option<u8>, now: GameTime) -> Option<News> {
    let refuse = |why: &str| Some(News { text: format!("No room for the {}", format!("{kind:?}").to_lowercase()), sub: why.to_string(), at: 0 });
    let facing = facing.or_else(|| world.facing_for(kind, at)).unwrap_or(2);
    let tiles = match world.fit(kind, at, facing) {
        Ok(tiles) => tiles,
        Err(why) => return refuse(why),
    };
    let purse = crate::undo::Purse::of(world);
    let after = world.objects.next_id();
    let mut laid = Vec::new();
    for (from, to) in world.stub(kind, &tiles, facing) {
        if take_step(world, events, intersections, Build { tool: Tool::Street, from, to, up: None, sides: None, road: false }, now) {
            laid.push(crate::undo::Link { from, to, one_way: false, road: false, up: [0, 0], sides: [MIDDLE; 2], wide: false });
        }
    }
    let id = world.raise(kind, tiles, facing);
    crate::calls::turn(world, events, id, now);
    let paid = purse.paid(world);
    crate::undo::placed(world, id, laid, paid, after, now);
    None
}

/// A step of the hand, built. Whether the step was taken.
pub fn take_step(world: &mut World, events: &mut EventQueue, intersections: &mut IntersectionRegistry, step: Build, now: GameTime) -> bool {
    let Build { tool, from, to, road, .. } = step;
    let [hf, ht] = step.up.unwrap_or_default();
    let [sf, st] = step.sides.unwrap_or_default();
    // Said out loud: a click that does nothing is the kind of bug
    // that otherwise takes an afternoon to find.
    if !may_step(world, step) {
        println!("refused: {tool:?} from {from:?} to {to:?} at {:?}", step.up);
        return false;
    }
    match tool {
        Tool::Street | Tool::OneWay | Tool::Wide => {
            let one_way = matches!(tool, Tool::OneWay | Tool::Wide);
            let laid = lay(world, crate::undo::Link { from, to, one_way, road, up: [hf, ht], sides: [sf, st], wide: tool == Tool::Wide });
            crate::economy::paved(world, to, laid, now);
        }
        Tool::Light => {
            if let Some(id) = world.node_in(to, ht, st)
                && let Some(GameObject::RoadNode(n)) = world.objects.get_mut(id).map(|e| &mut e.object)
            {
                n.light = if n.light.is_some() { None } else { Some(0) };
                events.wake(0, id);
            }
        }
        Tool::Demolish => {
            // A tap takes the road at the tile and height, all its links,
            // the cars on it rerouted. A drag cuts only the road between
            // the two tiles.
            if from == to {
                if let Some(id) = world.node_in(to, ht, st) {
                    handle_road_demolish(world, events, intersections, id, now);
                }
            } else if let Some((a, b)) = world.link_between_at(from, hf, sf, to, ht, st) {
                handle_link_demolish(world, events, intersections, a, b, now);
            }
        }
    }
    true
}

/// A road laid between two tiles, at their heights and sides, its edges
/// with it: how many tiles of it are new.
pub(crate) fn lay(world: &mut World, crate::undo::Link { from, to, one_way, road, up: [hf, ht], sides: [sf, st], wide }: crate::undo::Link) -> u32 {
    let laid = world.laid;
    // Along a road already there, the hand sets its priority.
    if let Some((a, b)) = world.link_between_at(from, hf, sf, to, ht, st) {
        world.set_priority(a, b, road);
    }
    world.place_road_at(from, hf, sf, to, ht, st, one_way, road);
    if let (Some(a), Some(b)) = (world.node_in(from, hf, sf), world.node_in(to, ht, st)) {
        world.set_wide(a, b, wide);
    }
    world.laid.saturating_sub(laid)
}

/// May the mayor's hand take this step with this tool.
#[cfg(test)]
pub fn may(world: &World, tool: Tool, from: GridCoord, to: GridCoord) -> bool {
    may_step(world, Build { tool, from, to, up: None, sides: None, road: false })
}

/// May the mayor's hand take this step, at the heights and sides it
/// gives: the world's own rule for the step. The one rule a step is
/// refused by, and the hand's dots are drawn by (`hint.rs`).
pub fn may_step(world: &World, step: Build) -> bool {
    may_step_on(world, step, None, None)
}

/// `may_step`, a drag going on from `to` that way, if it does
/// (`World::leads_nowhere`), and on to the road's next end, if it is known
/// (`World::may_lay_at_on`).
pub fn may_step_on(world: &World, Build { tool, from, to, up, sides, road, .. }: Build, on: Option<(i32, i32)>, then: Option<crate::world::clear::End>) -> bool {
    let [hf, ht] = up.unwrap_or_default();
    let [sf, st] = sides.unwrap_or_default();
    let (a, b) = (world.node_in(from, hf, sf), world.node_in(to, ht, st));
    // A level's: on its map, and its own roads stay; a road of the
    // player's may be cut from one.
    if let Some((lo, hi)) = world.frame {
        let inside = |t: GridCoord| (lo.x..=hi.x).contains(&t.x) && (lo.y..=hi.y).contains(&t.y);
        let fixed = |t: GridCoord, h: u8| h == 0 && world.road_node_at(t).is_some_and(|id| matches!(world.objects.get(id).map(|e| &e.object), Some(GameObject::RoadNode(n)) if !n.laid));
        let ok = match tool {
            Tool::Demolish if from == to => !fixed(to, ht),
            Tool::Demolish => !(fixed(from, hf) && fixed(to, ht)),
            _ => inside(from) && inside(to),
        };
        if !ok {
            return false;
        }
    }
    match tool {
        Tool::Street | Tool::OneWay | Tool::Wide => {
            let one_way = matches!(tool, Tool::OneWay | Tool::Wide);
            // Along a one-way the way it runs, the other one-way tool: it
            // gains its second lane, or loses it; but a road on a side
            // has one.
            let lanes = a.zip(b).is_some_and(|(a, b)| {
                world.edges.contains_key(&(a, b)) && !world.edges.contains_key(&(b, a)) && world.is_wide(a, b) != (tool == Tool::Wide)
            });
            if one_way && lanes {
                return tool != Tool::Wide || (sf == MIDDLE && st == MIDDLE);
            }
            // Along a road, priority it has not, or has and the hand not.
            if world.link_between_at(from, hf, sf, to, ht, st).is_some_and(|(a, b)| world.is_road_between(a, b) != road) {
                return true;
            }
            // Into a building is its door: nothing is laid on its tile, and
            // a through road is no door, nothing fronting onto one.
            let door = ht == 0 && world.occupied.contains_key(&(to.x, to.y));
            !(door && road)
                && !(tool == Tool::Wide && (sf != MIDDLE || st != MIDDLE))
                && world.may_lay_at_on(from, hf, sf, to, ht, st, tool, on, then)
        }
        Tool::Light => from == to && b.is_some_and(|id| world.is_intersection(id)),
        Tool::Demolish if from == to => b.is_some(),
        Tool::Demolish => world.link_between_at(from, hf, sf, to, ht, st).is_some(),
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
    let route_heights = new_route.iter().map(|&n| world.height_of(n)).collect();
    let lanes = world.lanes_for(&new_route);
    let first_lane = lanes.get(1).copied().unwrap_or(0) as usize;

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
        t.route_heights = route_heights;
        t.lanes = lanes;
        t.from_lot = 0;
        t.to_lot = to_lot;
        t.along = crate::car::spawn::along(&segment_lengths);
        t.cusps = crate::car::spawn::cusps(&backing, &t.along);
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
    }

    // Register on first edge and wake up
    let first_edge = world.objects.get(car_id).and_then(|e| {
        if let GameObject::Car(ref car) = e.object {
            car.trip.as_ref().map(|t| (t.route[0], t.route[1]))
        } else { None }
    });
    if let Some(edge) = first_edge
        && let Some(seg) = world.edges.get_mut(&edge)
            && !seg.contains(car_id) {
                seg.push_back(car_id, first_lane);
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
        // A junction's is its lights looking again.
        Some(GameObject::RoadNode(_)) => crate::car::simulation::lights(world, events, intersections, id, now),
        // Midnight: every building takes its turn, and every line reads
        // the labour market again.
        None if id == MIDNIGHT => {
            crate::calls::turns(world, events, now);
            settle_and_wake(world, events);
        }
        // A call nothing could answer, tried again.
        None if id == CALLS_AGAIN => crate::calls::dispatch(world, events, now),
        _ => {}
    }
}

/// The wakes that are nobody's: the day turning, and the calls nothing
/// could answer tried again (`calls::RETRY_MS`). No entity has these ids.
const MIDNIGHT: EntityId = EntityId::MAX;
pub(crate) const CALLS_AGAIN: EntityId = EntityId::MAX - 1;

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
    world.sites.retain(|&id| matches!(world.objects.get(id).map(|e| &e.object), Some(GameObject::Building(b)) if b.site.is_some()));
    let waiting: Vec<EntityId> = world.sites.iter().copied().filter(|&id| world.street_of(id).is_some() && !world.calls.iter().any(|c| c.at == id)).collect();
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
    shared: &mut Shared,
    clients: &mut HashMap<ClientId, ClientState>,
    outbox: &mut Vec<(ClientId, ServerMessage)>,
    client_id: ClientId,
    bounds: ChunkBounds,
) {
    let world = shared.world;
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
        outbox.push((client_id, shared.update(ops, vec![])));
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
    let world = &*world;
    let mut by_chunk: HashMap<ChunkCoord, Vec<&GameObjectEntry>> = HashMap::default();
    for id in &changed {
        if let Some(entry) = world.objects.get(*id)
            && let Some(pos) = entry.position
        {
            by_chunk.entry(chunk_of(pos)).or_default().push(entry);
        }
    }
    let mut shared = Shared::new(world, clk);

    for (&client_id, cs) in clients.iter_mut() {
        if cs.subscribed.is_none() {
            continue;
        }

        let mut ops = Vec::new();

        for coord in &cs.known_chunks {
            for &entry in by_chunk.get(coord).into_iter().flatten() {
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
            outbox.push((client_id, shared.update(ops, lumps)));
        }
    }
}


#[cfg(test)]
mod tests {
    /// Wakes one resident may take in a day; `a_town_thinks_within_budget`
    /// prints what the towns take. With the overtake bug of 2026-09-04 put
    /// back they took 146 and 231 in a day, and thousands once the storm has
    /// grown. A change that legitimately moves the count moves this number
    /// with it, on purpose.
    const WAKE_BUDGET: u64 = 120;
    use super::*;
    use std::time::Instant;
    use crate::calls;
    use crate::protocol::{BuildingKind, Good, GridCoord, Leg, TerrainType};

    /// What a test's hand does: a step of road or the demolisher, or a
    /// building placed whole round a tile, the first way it fits.
    #[derive(Clone, Copy, Debug)]
    enum Do {
        Step(Tool, GridCoord, GridCoord),
        Place(BuildingKind, GridCoord),
        /// The building on a tile taken down whole.
        Raze(GridCoord),
        /// A box a letter wants, sent.
        Send(u64),
    }

    /// The hand's act done, as the loop does it; a building refused is a
    /// test gone wrong.
    fn does(world: &mut World, events: &mut EventQueue, intersections: &mut IntersectionRegistry, d: Do, now: GameTime) {
        let message = match d {
            Do::Step(tool, from, to) => ClientMessage::Build(Build { tool, from, to, up: None, sides: None, road: false }),
            Do::Place(kind, at) => ClientMessage::Place { kind, at, facing: None },
            Do::Raze(at) => ClientMessage::Raze { building: world.occupied[&(at.x, at.y)] },
            Do::Send(letter) => ClientMessage::Send { letter, boxes: 1 },
        };
        let news = handle_player_action(world, events, intersections, 0, message, now);
        if let Do::Place(kind, at) = d {
            assert!(world.occupied.contains_key(&(at.x, at.y)), "{kind:?} at {at:?} refused: {news:?}");
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
    /// what stands. The hand's dots (`hint.rs`) answer the same.
    #[test]
    fn the_rule_of_where_the_hand_may_go_is_what_it_does() {
        let mut world = street();
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
                let edges = probe.edges.len();
                take_step(&mut probe, &mut events, &mut intersections, Build { tool: Tool::Street, from, to, up: None , sides: None, road: false }, 0);
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
        let depot = build(&mut world, 30, BuildingKind::Depot);
        if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
            b.stocks.get_mut(&Good::Stone).unwrap().level = 2.0;
        }
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        let at = |x, y| GridCoord { x, y };
        let (roads, treasury) = (world.roads.len(), world.treasury);
        let mut hand = |world: &mut World, message| handle_player_action(world, &mut events, &mut intersections, 1, message, 0);
        let mut said = Vec::new();
        // A drag as the hand sends it: the whole of it so far, a tile on each time.
        for n in 1..=5 {
            let tiles = (0..n).map(|y| crate::protocol::Spot { at: at(10, y), want: 0 }).collect();
            said.extend(hand(&mut world, ClientMessage::Draw(crate::protocol::Stroke { id: 1, tool: Tool::Street, road: false, tiles, start: None })));
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

    /// What the mayor takes down of their own lately built is undone: a
    /// house placed and razed gives its delivered timber back, a street
    /// laid and taken up its stone. Past the window, nothing comes back.
    #[test]
    fn taking_down_what_was_just_built_gives_it_back() {
        let mut world = street();
        world.treasury = 1e9;
        let depot = build(&mut world, 30, BuildingKind::Depot);
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        let at = |x, y| GridCoord { x, y };
        let shelf = |w: &World, g: Good| building_of(w, depot).stocks[&g].level;
        if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
            b.stocks.get_mut(&Good::Timber).unwrap().level = 10.0;
            b.stocks.get_mut(&Good::Stone).unwrap().level = 10.0;
        }
        let mut hand = |world: &mut World, message, now| handle_player_action(world, &mut events, &mut intersections, 1, message, now);
        hand(&mut world, ClientMessage::Place { kind: BuildingKind::House, at: at(5, 1), facing: None }, 0);
        let house = world.occupied[&(5, 1)];
        if let Some(GameObject::Building(b)) = world.objects.get_mut(house).map(|e| &mut e.object) {
            b.site.as_mut().unwrap().get_mut(&Good::Timber).unwrap().level = 2.0;
        }
        let back = hand(&mut world, ClientMessage::Raze { building: house }, 0).expect("nothing said");
        assert!(back.text.contains("taken back"), "{back:?}");
        assert_eq!(shelf(&world, Good::Timber), 12.0, "its delivered timber is not back at the depot");
        // A street a tile long, and taken up again.
        hand(&mut world, ClientMessage::Build(Build { tool: Tool::Street, from: at(7, 0), to: at(7, 1), up: None, sides: None, road: false }), 0);
        assert_eq!(shelf(&world, Good::Stone), 9.0, "the street took no stone");
        let back = hand(&mut world, ClientMessage::Build(Build { tool: Tool::Demolish, from: at(7, 1), to: at(7, 1), up: None, sides: None, road: false }), 0).expect("nothing said");
        assert!(back.sub.contains("stone"), "{back:?}");
        assert_eq!(shelf(&world, Good::Stone), 10.0, "its stone is not back");
        assert_eq!(hand(&mut world, ClientMessage::Undo, 0).unwrap().text, "Nothing to undo", "what was taken back is still to undo");
        // Old, a house razed gives nothing back.
        hand(&mut world, ClientMessage::Place { kind: BuildingKind::House, at: at(5, 1), facing: None }, 0);
        let (house, timber) = (world.occupied[&(5, 1)], shelf(&world, Good::Timber));
        assert!(hand(&mut world, ClientMessage::Raze { building: house }, crate::undo::WINDOW + 1).is_none());
        assert!(world.objects.get(house).is_none(), "the old house stands");
        assert_eq!(shelf(&world, Good::Timber), timber, "the old house gave something back");
    }

    /// Someone else's building on a street since laid holds it: undo says
    /// so and takes nothing back. Past its window, nothing is undone.
    #[test]
    fn undo_refuses_what_another_has_built_on_and_what_is_old() {
        let mut world = street();
        world.treasury = 1e9;
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        let at = |x, y| GridCoord { x, y };
        let mut hand = |world: &mut World, owner, message, now| handle_player_action(world, &mut events, &mut intersections, owner, message, now);
        for y in 0..3 {
            hand(&mut world, 1, ClientMessage::Build(Build { tool: Tool::Street, from: at(10, y), to: at(10, y + 1), up: None, sides: None, road: false }), 0);
        }
        assert!(hand(&mut world, 2, ClientMessage::Place { kind: BuildingKind::House, at: at(11, 3), facing: None }, 0).is_none());
        let roads = world.roads.len();
        let no = hand(&mut world, 1, ClientMessage::Undo, 0).unwrap();
        assert_eq!((no.text.as_str(), world.roads.len()), ("Can't undo", roads), "{no:?}");
        // The house's player takes theirs down; then the street goes.
        let house = world.occupied[&(11, 3)];
        hand(&mut world, 2, ClientMessage::Raze { building: house }, 0);
        hand(&mut world, 1, ClientMessage::Undo, 0);
        assert!(world.road_node_at(at(10, 3)).is_none());
        hand(&mut world, 1, ClientMessage::Build(Build { tool: Tool::Street, from: at(20, 0), to: at(20, 1), up: None, sides: None, road: false }), 0);
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
        // Razed, the harbour is gone whole.
        crate::undo::raze(&mut world, &mut events, &mut intersections, id, 0);
        assert!((8..11).all(|x| (1..3).all(|y| !world.occupied.contains_key(&(x, y)))), "part of the harbour stands");
        settle_and_wake(&mut world, &mut events);
    }

    /// A depot short of its plot, as a fixture may draw one, has no yard,
    /// and a road drawn into it asks of none: it once subtracted the
    /// yard's depth from a plot one tile deep, and the server crashed.
    #[test]
    fn a_road_into_a_depot_short_of_its_plot_is_asked_of_no_yard() {
        let mut world = street();
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        let at = |x, y| GridCoord { x, y };
        world.raise(BuildingKind::Depot, vec![at(30, 1)], 2);
        take_step(&mut world, &mut events, &mut intersections, Build { tool: Tool::Street, from: at(31, 2), to: at(30, 1), up: None, sides: None, road: false }, 0);
        take_step(&mut world, &mut events, &mut intersections, Build { tool: Tool::Street, from: at(30, 2), to: at(30, 1), up: None, sides: None, road: false }, 0);
    }

    /// A house razed takes its drive with it: the drive is the house's,
    /// not a road on its tile.
    #[test]
    fn a_house_razed_takes_its_drive_with_it() {
        let mut world = street();
        world.treasury = 1e9;
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        let at = GridCoord { x: 5, y: 1 };
        does(&mut world, &mut events, &mut intersections, Do::Place(BuildingKind::House, at), 0);
        let house = world.occupied[&(5, 1)];
        assert!(world.door_of(house).is_some() && world.road_node_at(at).is_none(), "a house with its door, and no road on its tile");
        does(&mut world, &mut events, &mut intersections, Do::Raze(at), 0);
        assert!(!world.occupied.contains_key(&(5, 1)), "the house is gone");
        assert!(world.road_node_at(GridCoord { x: 5, y: 0 }).is_some(), "and the street stands");
    }

    /// A drag of the demolisher cuts only the road between the tiles it
    /// crosses. A tap takes the road at the point; a building is not the
    /// demolisher's to take.
    #[test]
    fn a_drag_cuts_a_link_and_a_tap_takes_the_point() {
        let mut world = street();
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
        hand(&mut world, Do::Place(BuildingKind::Depot, at(9, 3)));
        let depot = world.occupied[&(9, 3)];
        hand(&mut world, Do::Step(Tool::Demolish, at(10, 4), at(10, 4)));
        assert!(world.objects.get(depot).is_some(), "the demolisher took the depot");
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
        let depot = build(&mut world, 30, BuildingKind::Depot);
        let stone = |w: &World| building_of(w, depot).stocks[&Good::Stone].level;
        if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
            b.stocks.get_mut(&Good::Stone).unwrap().level = 2.0;
        }
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        let at = |x, y| GridCoord { x, y };
        let treasury = world.treasury;
        let mut hand = |world: &mut World, from, to| take_step(world, &mut events, &mut intersections, Build { tool: Tool::Street, from, to, up: None , sides: None, road: false }, 0);
        hand(&mut world, at(10, 0), at(10, 1));
        hand(&mut world, at(10, 1), at(10, 2));
        assert_eq!(stone(&world), 0.0, "two tiles took {} stone", 2.0 - stone(&world));
        assert_eq!(world.treasury, treasury, "stone in stock was paid for");
        hand(&mut world, at(10, 2), at(10, 3));
        let express = crate::economy::EXPRESS * crate::economy::import(Good::Stone, crate::economy::ROAD_STONE);
        assert!((treasury - world.treasury - express).abs() < 1e-9, "the third tile cost {}", treasury - world.treasury);
        assert!(world.lumps.iter().any(|l| l.building == harbour_of(&world) && l.coins < 0.0 && l.good == Some(Good::Stone)), "no lump at the harbour");
    }

    fn build(world: &mut World, x: i32, kind: BuildingKind) -> EntityId {
        world
            .place_on_street(GridCoord { x, y: 1 }, kind)
            .unwrap_or_else(|| panic!("the street should give a {kind:?} at x={x} its driveway"))
    }

    /// A save from when a drive was a road the mayor laid opens with it
    /// as the house's door, and the tile back. The drive used to go
    /// before the mayor's tiles were counted, and took one from nought.
    #[test]
    fn a_saved_drive_opens_as_a_door() {
        let mut world = World::meadow(-8..8, -8..8);
        world.place_road_path(&[GridCoord { x: 0, y: 2 }, GridCoord { x: 4, y: 2 }]);
        let house = world.place_building(GridCoord { x: 2, y: 0 }, BuildingKind::House, 2).unwrap();
        world.place_road_path(&[GridCoord { x: 2, y: 2 }, GridCoord { x: 2, y: 1 }, GridCoord { x: 2, y: 0 }]);
        let drive = world.road_node_at(GridCoord { x: 2, y: 0 }).unwrap();
        if let Some(GameObject::RoadNode(n)) = world.objects.get_mut(drive).map(|e| &mut e.object) {
            n.laid = true;
        }
        world.laid = 0;

        world.restore();

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
        world.restore();
        world.resettle();
        assert!(world.objects.roads().next().is_none(), "a road was born with the map");
        assert!(world.all_buildings().is_empty() && world.resident_ids().is_empty(), "something stood on the island");
    }

    /// Where a car stands on the map, and how fast it goes along its route.
    fn whereabouts(world: &World, car: EntityId, now: GameTime) -> Option<([f64; 2], f64, usize)> {
        let GameObject::Car(ref c) = world.objects.get(car)?.object else { return None };
        let t = c.trip.as_ref()?;
        let (p, v) = t.at(now);
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
                // Fifty tiles of street are all the two trips need.
                let mut world = World::meadow(-4..50, -4..12).street(-4..50);
                let home = build(&mut world, 10, BuildingKind::House);
                let from = build(&mut world, from_x, BuildingKind::House);
                let shop = build(&mut world, dest_x, BuildingKind::Shop);
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
        let home = build(&mut world, 0, BuildingKind::House);
        let shop = build(&mut world, 20, BuildingKind::Shop);

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
        let shop = build(&mut world, 20, BuildingKind::Shop);
        let warehouse = build(&mut world, 60, BuildingKind::Depot);
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
        let shop = build(&mut world, 20, BuildingKind::Shop);
        let near = build(&mut world, 30, BuildingKind::Depot);
        let far = build(&mut world, 60, BuildingKind::Depot);
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
        let other = build(&mut world, 24, BuildingKind::Shop);
        empty(&mut world, near);
        sell(&mut world, &mut events, other, 35.0, 0);
        assert_eq!(answered_by(&world), Some(far), "an empty shelf answered");
        let third = build(&mut world, 10, BuildingKind::Shop);
        empty(&mut world, far);
        sell(&mut world, &mut events, third, 35.0, 0);
        assert_eq!(answered_by(&world), None, "with nothing in town somebody answered");
    }

    /// Every wake, every arrival: the log the model in docs/residents.md is
    /// held to. Two runs of the same town must write the same one — down to
    /// the millisecond — or something is iterating a hash map.
    type Move = (GameTime, EntityId, Option<EntityId>, Option<crate::needs::Need>);

    fn arrival_log(days: u64) -> Vec<Move> {
        let mut world = street();
        build(&mut world, 0, BuildingKind::Apartment);
        build(&mut world, 6, BuildingKind::Apartment);
        build(&mut world, 30, BuildingKind::Shop);
        let office = build(&mut world, 60, BuildingKind::Office);
        // Lunch: a shop beside the office, too far from home to staff.
        let lunch = build(&mut world, 64, BuildingKind::Shop);
        // Fuel, or every few days the town goes without.
        build(&mut world, 18, BuildingKind::GasStation);

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
            wants_nothing(&world, now);
            let sold = |b: EntityId, need| world.books[&b].before(now).served.get(&need).copied().unwrap_or(0.0);
            let office = sold(office, crate::needs::Need::Work);
            // Eleven at the office: fourteen people, two apartments of
            // seven, less the shop's two and the pump's one, nine hours
            // each, less the odd late morning, a lunch out, a dinner near
            // work, and the minute or two parking at the kerb.
            assert!((70.0..=99.0).contains(&office), "office received {office}h");
            // Lunches over a whole day: the shops have no depot here, so
            // by the third day their shelves have run down some.
            assert!(sold(lunch, crate::needs::Need::Eat) > 1.5, "lunch shop sold {}h", sold(lunch, crate::needs::Need::Eat));
        }
        log
    }

    /// Nobody wants for anything: everyone has a job, and whatever they
    /// owe of a need of their own that runs down has somewhere to be met.
    fn wants_nothing(world: &World, now: GameTime) {
        for e in world.objects.iter() {
            let GameObject::Resident(ref r) = e.object else { continue };
            let card = crate::resident::inspect(world, e.id, now);
            assert!(r.work.is_some(), "{card}");
            let owed = |v: &&serde_json::Value| r.buckets.iter().any(|b| b.need.drain() > 0.0 && v["need"] == serde_json::json!(b.need)) && v["full"].as_f64() < Some(1.0);
            assert!(card["buckets"].as_array().into_iter().flatten().filter(owed).all(|v| v["option"] != "nothing"), "{card}");
        }
    }

    #[test]
    fn cars_stop_for_fuel_now_and_then() {
        let mut world = street();
        build(&mut world, 0, BuildingKind::Apartment);
        build(&mut world, 6, BuildingKind::Apartment);
        build(&mut world, 60, BuildingKind::Office);
        build(&mut world, 40, BuildingKind::Shop);
        let station = build(&mut world, 30, BuildingKind::GasStation);

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
        wants_nothing(&world, now);
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
            take_step(&mut world, &mut events, &mut intersections, Build { tool: Tool::Street, from, to, up: None , sides: None, road: false }, 0);
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
            build(&mut world, x, kind);
            x += crate::blueprint::plot(kind, 0).size.0 as i32 + 1;
        }
        // A second lorry for each depot.
        let depots: Vec<EntityId> = world.objects.iter().filter(|e| matches!(e.object, GameObject::Building(ref b) if b.kind == BuildingKind::Depot)).map(|e| e.id).collect();
        for d in depots {
            if let Some(GameObject::Building(b)) = world.objects.get_mut(d).map(|e| &mut e.object) {
                b.lorries = 1;
            }
        }
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        // Started as the game starts one.
        world.resettle();
        settle_and_wake(&mut world, &mut events);
        assert!(!world.harbours.is_empty(), "no harbour, or nobody can arrive at all");
        // The mayor at the market as each ferry casts off, looked for every
        // hour: a box of fuel bought, which nothing in town makes, once the
        // last is off the border; and a box of the farm's crates sold, once
        // the last is loaded.
        let mut berthed = false;
        let mut market = |world: &mut World, events: &mut EventQueue, exporting: bool| {
            let ferry = world.ferry_of(harbour_of(world)).expect("the harbour's ferry");
            let was = std::mem::replace(&mut berthed, car_of(world, ferry).spot.is_some());
            if !was || berthed {
                return;
            }
            let boxes = crate::haul::boxes(world);
            if !boxes.iter().any(|(t, l, _)| !t.outbound && t.good == Good::Fuel && matches!(l, Leg::Booked | Leg::Aboard | Leg::Parked)) {
                crate::market::trade(world, Good::Fuel, false, 1);
            }
            let harbour = harbour_of(world);
            if exporting && !building_of(world, harbour).outgoing.iter().any(|t| t.good == Good::Crates) {
                crate::market::trade(world, Good::Crates, true, 1);
            }
            crate::haul::call_lorries(world, events);
        };
        let mut exporting = false;
        let mut wakes = 0;
        let mut now = 0;
        let end = days * DAY_MS as u64;
        // A day at a time, so the look at the end of each is on the tick
        // that turns it, with the midnight wake taken.
        for day in 1..=days {
            let midnight = day * DAY_MS as u64;
            for hour in 1..=24 {
                crate::market::hour(&mut world, &mut events, now);
                market(&mut world, &mut events, exporting);
                let to = (midnight - DAY_MS as u64 + hour * crate::market::HOUR).min(end);
                while step_counting(&mut world, &mut events, &mut intersections, &mut now, to, &mut wakes) {}
            }
            // A town that gridlocks is not a town being measured: nobody is
            // a day late for anything. Two driveways two tiles apart held
            // each other for good on the third day, once the offices' cars
            // were on the street, until claims lapsed (docs/parking.md §9).
            let stuck = world.objects.iter().filter(|e| matches!(e.object, GameObject::Car(ref c) if c.trip.as_ref().is_some_and(|t| now > t.eta + DAY_MS as u64))).count();
            assert_eq!(stuck, 0, "day {day}: {stuck} cars a day past their due time — the street has gridlocked");
            // The missions read, as the tick reads them: letters come only
            // once the opening is done.
            crate::missions::check(&mut world, now);
            each_day(&world, day, wakes);
            if !exporting && world.objects.iter().any(|e| matches!(e.object, GameObject::Building(ref b) if b.kind == BuildingKind::Farm && b.stocks[&Good::Crates].level > 0.0)) {
                exporting = true;
            }
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
    /// Counted, not timed, so it is the same on every machine. It is not in
    /// the everyday run: `cargo test town -- --ignored --nocapture` runs it
    /// with the benchmarks below, for a look every now and then.
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

    /// A town thinks as fast in a wide world as in a narrow one. A big
    /// world is mostly road nodes nobody drives: 29,000 of them beside 47
    /// buildings on 2026-10-05, when the survey laid road ahead of the
    /// frontier and every call and every choice still walked them all to
    /// find a depot, a van or a resident, and the clock stalled for
    /// seconds at a time. The same day of the same town, with that much
    /// road laid out of reach, costs at most half as much again.
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
    /// each the best of a row of them, as the least a machine busy with
    /// other things lets through: a house placed across the
    /// street and demolished again, a shop the same, and a side street
    /// drawn four tiles — each a batch of the brush's steps, with the
    /// settle the tick runs after it.
    fn build_cost(copies: i32) -> Vec<(&'static str, f64)> {
        let mut world = towns(copies);
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        world.resettle();
        settle_and_wake(&mut world, &mut events);
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
                // Taken down.
                costs[2 * k + 1].1.push(timed(&mut world, vec![Do::Raze(at(x, -1))]));
                assert!(world.objects.get(id).is_none(), "the {kind:?} came down");
            }
            let steps = (0..4).map(|y| Do::Step(Tool::Street, at(x + 6, -y), at(x + 6, -y - 1))).collect();
            costs[4].1.push(timed(&mut world, steps));
        }
        let costs: Vec<(&'static str, f64)> = costs
            .into_iter()
            .map(|(what, v)| (what, v.into_iter().fold(f64::INFINITY, f64::min)))
            .collect();
        println!("{copies} town(s), {} residents: {}", world.resident_ids().len(), costs.iter().map(|(what, c)| format!("{what} {c:.0} µs")).collect::<Vec<_>>().join(", "));
        costs
    }

    /// A build costs the loop what it changes, not what the town holds:
    /// the same tap in a town twice the size costs at most half as much
    /// again. Every player building at once shares the one loop, so a build
    /// that grew with the world would stall all of them. Settling the whole town
    /// after every build cost 2 ms a house here, and 6 ms in two towns.
    /// Timed, so `#[ignore]`d with the other town benchmarks.
    #[test]
    #[ignore]
    fn a_build_costs_the_same_in_a_town_twice_the_size() {
        for ((what, one), (_, two)) in build_cost(1).into_iter().zip(build_cost(2)) {
            assert!(two < 1.5 * one + 100.0, "{what} cost {one:.0} µs in one town and {two:.0} µs in two");
        }
    }

    /// The server's own loop over every fixture, a town of thousands of
    /// buildings: `Game::step` for six hours of play, settle and all,
    /// which the town tests above skip. Printed, not asserted: what a
    /// settle step costs against the steps between, in microseconds.
    #[test]
    #[ignore]
    fn a_town_of_every_fixture_settles() {
        let mut world = World::new();
        crate::fixtures::build(&mut world, &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures"));
        let mut game = Game::new(world, crate::fixtures::NOON, 1, Box::new(World::new));
        let (mut settles, mut others) = (Vec::new(), Vec::new());
        for _ in 0..DAY_MS as GameTime / 4 / STEP_MS {
            let settling = game.now % SETTLE_MS == 0 || !game.world.unsettled.is_empty();
            let started = Instant::now();
            game.step();
            (if settling { &mut settles } else { &mut others }).push(started.elapsed().as_secs_f64() * 1e6);
        }
        let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
        println!(
            "{} objects: {} settles {:.0} µs each (worst {:.0}), {} other steps {:.1} µs each",
            game.world.objects.len(),
            settles.len(),
            mean(&settles),
            settles.iter().fold(0.0, |a: f64, &b| a.max(b)),
            others.len(),
            mean(&others)
        );
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
            build(&mut world, x, kind);
        }
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        world.resettle();
        settle_and_wake(&mut world, &mut events);
        assert_settled(&world, "the start");
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
        act(&mut world, Do::Raze(at(40, -1)));
        assert!(!world.occupied.contains_key(&(41, -1)), "the office stands");
        act(&mut world, Do::Raze(at(0, 1)));
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
        for (x0, ground) in [(QUARRY_X, TerrainType::Mountain), (SAWMILL_X, TerrainType::Forest)] {
            for x in x0 - 5..x0 + 7 {
                for y in 5..14 {
                    world.terrain.insert((x, y), ground);
                }
            }
        }
        let quarry = build(&mut world, QUARRY_X, BuildingKind::Quarry);
        let sawmill = build(&mut world, SAWMILL_X, BuildingKind::Sawmill);
        let mut stood = 0;
        // Each midnight, a block of flats across the street, and a side
        // street beside it; and the letters read, and a slot booked going
        // out for each box an order still wants, while the depot keeps a
        // box back for the sites.
        let hand = |world: &World, day: u64| -> Steps {
            let x = 112 + 4 * (day as i32 - 1);
            let at = |x, y| GridCoord { x, y };
            let mut steps = vec![
                Do::Place(BuildingKind::Apartment, at(x + 1, -1)),
                Do::Step(Tool::Street, at(x + 2, 0), at(x + 2, -1)),
                Do::Step(Tool::Street, at(x + 2, -1), at(x + 2, -2)),
                Do::Step(Tool::Street, at(x + 2, -2), at(x + 2, -3)),
            ];
            let depot = world.objects.iter().find(|e| matches!(e.object, GameObject::Building(ref b) if b.kind == BuildingKind::Depot)).map(|e| e.id).unwrap();
            let harbour = harbour_of(world);
            // Waiting at the harbour, and booked tonight for a letter before this one.
            let queued = |g: Good, steps: &Steps| (building_of(world, harbour).outgoing.iter().filter(|t| t.good == g).count() + steps.iter().filter(|d| matches!(d, Do::Send(l) if crate::orders::letters(world).iter().any(|o| o.letter == *l && o.good == g))).count()) as f64;
            for o in crate::orders::letters(world) {
                let spare = (building_of(world, depot).stocks[&o.good].level / o.good.per_box()).floor() - 1.0 - queued(o.good, &steps);
                steps.extend((0..(o.boxes as f64).min(spare).max(0.0) as usize).map(|_| Do::Send(o.letter)));
            }
            steps
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
                assert!(eaten + had >= 0.85 * (asked + of), "days {}–{day}: the town ate {:.1}h of the {:.1}h its people need", day - 1, eaten + had, asked + of);
            }
            if day > 1 {
                for need in [Need::Work, Need::Eat, Need::Fuel] {
                    assert!(out.get(&need).is_some_and(|&h| h > 0.0), "day {day}: nobody in town was served {need:?}");
                }
            }
        });
        let sold = world.town.season().map(|p| p.sold.get(&Good::Crates).copied().unwrap_or(0.0)).sum::<f64>();
        println!("the season: treasury {:.1}, crates sold to the world for {sold:.1}, {stood} sites stood", world.treasury);
        // The order board: what the towns beyond the edge asked, what was
        // sent, and what they paid.
        let orders: Vec<_> = world.missions.list.iter().filter(|m| matches!(m.key, crate::missions::Key::Order(_))).collect();
        // Paid, and over what the world would have paid for the same boxes.
        let (paid, over): (f64, f64) = orders
            .iter()
            .map(|m| match (m.steps[0].goal, m.reward) {
                (crate::missions::Goal::Delivered { good, units, sailed }, crate::missions::Reward::Order { coins, .. }) => {
                    let paid = coins * sailed.min(units) / units;
                    (paid, paid - crate::economy::export(good, sailed.min(units)))
                }
                _ => (0.0, 0.0),
            })
            .fold((0.0, 0.0), |(a, b), (c, d)| (a + c, b + d));
        let filled = orders.iter().filter(|m| m.steps[0].done).count();
        let lapsed = orders.iter().filter(|m| m.finished.is_some() && !m.steps[0].done).count();
        println!(
            "orders: {} letters, {filled} filled, {lapsed} lapsed; {paid:.0} coins paid, {over:.0} over the world's price: {:.0}% of the treasury",
            orders.len(),
            100.0 * over / world.treasury
        );
        for n in crate::orders::neighbours(&world) {
            let theirs: Vec<_> = orders.iter().filter(|m| m.from == Some(n.mayor)).map(|m| { let sent = match m.steps[0].goal { crate::missions::Goal::Delivered { sailed, .. } => sailed, _ => 0.0 }; format!("{}{}", m.steps[0].title, if m.steps[0].done { String::new() } else if m.finished.is_some() { format!(" (lapsed, {sent:.0} sent)") } else { " (open)".into() }) }).collect();
            println!("  {} of {}: standing {:.1}; {}", n.name, n.town, n.standing, theirs.join(", "));
        }
        assert!(filled > 0, "the town filled no orders");

        assert!(sold > 0.0, "the farm never sold a harvest to the world");
        assert!(world.treasury > 0.0, "the town ran out of coins");
    }

    #[test]
    fn the_same_town_lives_the_same_days() {
        let three = arrival_log(3);
        let one = arrival_log(1);
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
        build(&mut world, 0, BuildingKind::House);
        build(&mut world, 3, BuildingKind::House);
        let farm = build(&mut world, 10, BuildingKind::Farm);
        let depot = build(&mut world, 30, BuildingKind::Depot);
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
        // The second day: seeded. The third, growing; the fourth: ripe by
        // morning, harvested by evening, a harvest in the yard, and a lorry
        // from beyond the edge called for it.
        pump(&mut world, &mut events, &mut intersections, 20 * day / 24, day + 20 * day / 24);
        assert!(stages(&world).iter().all(|&s| s == Stage::Sown), "by the second evening the land is {:?}", stages(&world));
        assert_eq!(yard(&world), 0.0);
        pump(&mut world, &mut events, &mut intersections, day + 20 * day / 24, 3 * day + 5 * day / 24);
        assert_eq!(yard(&world), 0.0, "a harvest before the crop was ripe");
        // Ripe by the fourth morning, and cut that day: the whole harvest
        // in the yard by evening, or already on its way to the world.
        let mut harvest = 0.0f64;
        let mut t = 3 * day + 5 * day / 24;
        while step(&mut world, &mut events, &mut intersections, &mut t, 4 * day + 20 * day / 24) {
            harvest = harvest.max(yard(&world));
        }
        assert!((harvest - stages(&world).len() as f64 * crop).abs() < 1e-6, "the harvest came to {harvest}, not a yard's worth");

        // Then the depot's shelf runs low: its lorry fetches from the farm,
        // and no coin moves. The clock goes on from where the world is: an
        // event queue is not pumped backwards.
        let now = 4 * day + 20 * day / 24;
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
        for x in QUARRY_X - 5..QUARRY_X + 7 {
            for y in 5..14 {
                world.terrain.insert((x, y), TerrainType::Mountain);
            }
        }
        let depot = build(&mut world, 30, BuildingKind::Depot);
        for good in [Good::Stone, Good::Timber, Good::Crates, Good::Fuel] {
            shelve(&mut world, depot, good, if good == Good::Stone { 0.0 } else { 100.0 });
        }
        let mut events = EventQueue::new();
        let intersections = IntersectionRegistry::new();
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
        build(&mut world, QUARRY_X, BuildingKind::Quarry);
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
        let house = build(&mut world, 10, BuildingKind::House);
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

    /// A letter written and opened, as a ferry brings it.
    fn letter(world: &mut World, now: GameTime) -> crate::missions::Mission {
        let m = crate::orders::write(world, now).expect("nobody wrote");
        world.missions.list.push(m.clone());
        m
    }

    /// The good an order asks for.
    fn asked(m: &crate::missions::Mission) -> Good {
        match m.steps[0].goal {
            crate::missions::Goal::Delivered { good, .. } => good,
            _ => panic!("{} is not an order", m.title),
        }
    }

    /// An order finished: filled, or lapsed.
    fn close(world: &mut World, key: crate::missions::Key, filled: bool, now: GameTime) {
        let m = world.missions.list.iter_mut().find(|m| m.key == key).unwrap();
        m.steps[0].done = filled;
        m.finished = Some(now);
    }

    /// A letter asks only for what the town can send: what a maker in
    /// town makes, or, one step further, what a building not yet built
    /// would make. Fuel has no maker, so nobody asks for it.
    #[test]
    fn orders_ask_only_for_what_the_town_can_send() {
        use crate::orders::{sourceable, GAP};
        let mut world = street();
        opening_done(&mut world);
        build(&mut world, HARBOUR_X - 12, BuildingKind::Depot);
        let asks = |world: &mut World, from: u64| -> Vec<Good> {
            (0..9)
                .map(|n| {
                    let (can, further) = sourceable(world);
                    let m = letter(world, (from + n) * GAP);
                    assert!(can.contains(&asked(&m)) || further.contains(&asked(&m)), "{} asked for {:?}: the town can send {can:?}, and {further:?} a step on", m.title, asked(&m));
                    close(world, m.key, true, (from + n) * GAP);
                    asked(&m)
                })
                .collect()
        };
        // A town that makes nothing: the first letters reach a step on.
        let first = asks(&mut world, 0);
        assert!(!first.contains(&Good::Fuel), "asked for fuel nobody can make: {first:?}");
        assert_eq!(first[0], Good::Crates, "Tam writes first, for the crates a farm would make");
        // A farm stands: crates are made in town.
        build(&mut world, 20, BuildingKind::Farm);
        assert_eq!(sourceable(&world).0, [Good::Crates]);
        let then = asks(&mut world, 9);
        assert!(!then.contains(&Good::Fuel), "asked for fuel nobody can make: {then:?}");
    }

    /// At most three orders stand open, a letter comes no oftener than a
    /// third of a day, and none before the opening is done. One not
    /// filled lapses as a ferry comes in after its day, and its mayor
    /// thinks a little less of the town; a box still booked for it counts
    /// to nothing.
    #[test]
    fn orders_come_three_at_most_and_lapse_without_harm() {
        use crate::orders::{post, standing, Mayor, GAP, LASTS, OPEN};
        let mut world = street();
        let harbour = harbour_of(&world);
        post(&mut world, harbour, 0);
        assert!(world.missions.list.iter().all(|m| !matches!(m.key, crate::missions::Key::Order(_))), "a letter came before the opening was done");
        opening_done(&mut world);
        let open = |w: &World| w.missions.list.iter().filter(|m| matches!(m.key, crate::missions::Key::Order(_)) && m.finished.is_none()).count();
        let mut most = 0;
        // A ferry every tenth of a day, for three days.
        for call in 0..30 {
            post(&mut world, harbour, call * DAY_MS as u64 / 10);
            most = most.max(open(&world));
            assert!(open(&world) <= OPEN, "{} open at call {call}", open(&world));
        }
        assert_eq!(most, OPEN, "the board never filled");
        let opened: Vec<GameTime> = world.missions.list.iter().filter(|m| matches!(m.key, crate::missions::Key::Order(_))).map(|m| m.opened).collect();
        assert!(opened.windows(2).all(|w| w[1] - w[0] >= GAP), "letters came closer than a third of a day: {opened:?}");
        // Tam's first lapsed after its two days, nothing filled: standing
        // fell from where it started, and the news said so.
        let tam = world.missions.list.iter().find(|m| m.from == Some(Mayor::Tam)).unwrap().clone();
        assert!(tam.finished.is_some_and(|f| f >= tam.opened + LASTS), "Tam's order never lapsed");
        assert!(standing(&world, Mayor::Tam) < 1.0, "a lapsed order cost no standing");
        assert!(world.news.iter().any(|n| n.text.contains("gave up")), "no news of it");
        // A box booked for it sails after all.
        let crate::missions::Key::Order(id) = tam.key else { unreachable!() };
        let t = crate::protocol::Trailer { id: 1, good: asked(&tam), units: 10.0, to: None, outbound: true, order: id, partner: Some(Mayor::Tam), price: 1.0 };
        crate::orders::sailed(&mut world, &t);
        let tam = world.missions.list.iter().find(|m| m.key == tam.key).unwrap();
        assert!(matches!(tam.steps[0].goal, crate::missions::Goal::Delivered { sailed, .. } if sailed == 0.0), "a lapsed order took a box");
    }

    /// Port Aldra writes only once the town stands well with someone
    /// else: until then, the letters are Tam's, Mira's and Bess's.
    #[test]
    fn port_aldra_is_silent_until_the_town_stands_well() {
        use crate::orders::{standing, Mayor, GAP, GOOD};
        let mut world = street();
        opening_done(&mut world);
        build(&mut world, 20, BuildingKind::Farm);
        build(&mut world, HARBOUR_X - 12, BuildingKind::Depot);
        let mut t = 0;
        // Every order but Tam's lapses: the town keeps to one friend.
        while standing(&world, Mayor::Tam) < GOOD {
            assert!(t < 30 * GAP, "Tam never wrote enough to stand at {GOOD}");
            let m = letter(&mut world, t);
            assert_ne!(m.from, Some(Mayor::Aldra), "Port Aldra wrote while Tam stood at {}", standing(&world, Mayor::Tam));
            close(&mut world, m.key, m.from == Some(Mayor::Tam), t);
            t += GAP;
        }
        let from: Vec<_> = (0..4)
            .map(|_| {
                let m = letter(&mut world, t);
                close(&mut world, m.key, true, t);
                t += GAP;
                m.from.unwrap()
            })
            .collect();
        assert!(from.contains(&Mayor::Aldra), "Port Aldra never wrote: {from:?}");
    }

    /// An order filled the way a player fills it: a slot going out booked
    /// for its mayor is loaded at the depot, rides the lorry to the
    /// park and the ferry to the edge, and the mayor's coins land at the
    /// harbour as it casts off, once; the mayor's standing rises, once.
    #[test]
    fn an_order_filled_pays_coins_and_standing_once() {
        use crate::missions::Reward;
        use crate::orders::{post, standing, Mayor};
        let mut world = street();
        let harbour = harbour_of(&world);
        build(&mut world, HARBOUR_X - 12, BuildingKind::Depot);
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        opening_done(&mut world);
        post(&mut world, harbour, 0);
        let order = world.missions.list.last().unwrap().clone();
        assert_eq!((order.from, asked(&order)), (Some(Mayor::Tam), Good::Crates), "Tam's letter, for crates");
        let (crate::missions::Key::Order(id), Reward::Order { coins, .. }) = (order.key, order.reward) else { panic!("not an order") };
        let before = (world.treasury, standing(&world, Mayor::Tam));
        assert_eq!(crate::orders::send(&mut world, id, 1), 1, "no slot for Tam");
        crate::haul::call_lorries(&mut world, &mut events);
        let mut now = 0;
        let mut marked = false;
        let finished = |w: &World| w.missions.list.iter().any(|m| m.key == order.key && m.finished.is_some());
        while !finished(&world) && step(&mut world, &mut events, &mut intersections, &mut now, DAY_MS as u64) {
            crate::missions::check(&mut world, now);
            marked |= crate::haul::boxes(&world).iter().any(|(t, ..)| t.order == id && t.outbound);
        }
        assert!(marked, "no box was marked for Saltmere");
        assert!(finished(&world), "the order was never filled");
        let paid = world.lumps.iter().filter(|l| l.building == harbour && l.coins > 0.0).map(|l| l.coins).sum::<f64>();
        assert!((paid - coins).abs() < 1e-6, "Tam paid {paid}, the letter said {coins}");
        assert!((world.treasury - before.0 - coins).abs() < 1e-6, "the purse moved by {}", world.treasury - before.0);
        assert_eq!(standing(&world, Mayor::Tam), before.1 + 1.0, "standing rose by other than a point");
        // A day on, nothing more for it.
        let treasury = world.treasury;
        let until = now + DAY_MS as u64;
        while step(&mut world, &mut events, &mut intersections, &mut now, until) {
            crate::missions::check(&mut world, now);
        }
        let crates_sold: f64 = world.town.season().map(|p| p.sold.get(&Good::Crates).copied().unwrap_or(0.0)).sum();
        assert!((crates_sold - coins).abs() < 1e-6, "crates sold for {crates_sold} in all");
        assert!(world.treasury <= treasury + 1e-6, "paid again: {} more", world.treasury - treasury);
        assert_eq!(standing(&world, Mayor::Tam), before.1 + 1.0, "standing rose again");
    }

    /// The board outlives a restart: the orders open and done, who wrote
    /// them, and so how each mayor stands. Through the JSON a save keeps
    /// them in (the host's `persistence`, which tests its own round trip).
    #[test]
    fn the_order_board_survives_a_restart() {
        let mut world = street();
        opening_done(&mut world);
        let filled = letter(&mut world, 0);
        close(&mut world, filled.key, true, 10);
        letter(&mut world, 20);
        let kept = serde_json::to_string(&world.missions.list).unwrap();
        let mut again = street();
        again.missions.list = serde_json::from_str(&kept).unwrap();
        assert_eq!(serde_json::to_string(&again.missions.list).unwrap(), serde_json::to_string(&world.missions.list).unwrap());
        assert_eq!(serde_json::to_string(&crate::orders::neighbours(&again)).unwrap(), serde_json::to_string(&crate::orders::neighbours(&world)).unwrap());
    }

    /// The opening's steps done.
    fn opening(world: &mut World, now: GameTime) -> Vec<bool> {
        missions(world, now).into_iter().find(|m| m.0 == crate::missions::Key::Opening).expect("no opening").1
    }

    /// The opening, docs/game.md: a harbour, a depot, a street between
    /// them. The first ferry comes in on time with the starter pack and
    /// the tug lands it in the trailer park, for nothing; the depot's
    /// lorry fetches a box and unloads it onto the shelf, and a second
    /// lorry helps fetch the rest. A house is a site until a
    /// van brings its timber; then its settlers come on the next ferry and
    /// drive home. A box of crates sold goes out on the ferry, paid as it
    /// casts off; and the ferry keeps its timetable throughout. The
    /// opening mission ticks off each step as the town does it, on the
    /// server, and pays when the last is done; the trunk follows it.
    #[test]
    fn the_opening_from_the_harbour() {
        use crate::missions::Key;
        use crate::shipping::DWELL;
        use crate::world::sea::FIRST_CALL;
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
        let lorry = crate::haul::lorries_of(&world, depot)[0];
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

        // The lorry fetches a box as it lands, and unloads it.
        let stock = |w: &World| building_of(w, depot).stocks.values().map(|s| s.level).sum::<f64>();
        let until = now + day / 12;
        while stock(&world) == 0.0 && step(&mut world, &mut events, &mut intersections, &mut now, until) {}
        assert!(stock(&world) > 0.0, "the lorry brought nothing home in two hours");
        assert!(car_of(&world, lorry).hitched.is_none(), "the box was not gone into stock");
        assert!(world.lumps.iter().any(|l| l.building == depot && l.units > 0.0), "no lump for the unload");
        assert_eq!(opening(&mut world, now), [true, true, true, true, false], "the box fetched");

        // A second lorry, bought from the world: the two fetch the rest.
        let before = world.treasury;
        crate::haul::buy_lorry(&mut world, &mut events, depot, now);
        assert_eq!(crate::haul::lorries_of(&world, depot).len(), 2, "no second lorry");
        assert!((before - world.treasury - crate::haul::LORRY_PRICE).abs() < 1e-9, "the lorry was not paid for");
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
        // The opening done, and paid; the trunk opens on the market: a box
        // bought.
        let before = world.treasury;
        assert_eq!(opening(&mut world, now), [true; 5], "the settlers came");
        assert!((world.treasury - before - 100.0).abs() < 1e-9, "the opening paid {}", world.treasury - before);
        let trunk = |world: &mut World, now| missions(world, now).into_iter().map(|(k, _, done)| (k, done)).collect::<Vec<_>>();
        assert_eq!(trunk(&mut world, now), [(Key::Opening, true), (Key::Book, false)]);
        let price = world.market.price(Good::Timber);
        handle_player_action(&mut world, &mut events, &mut intersections, player, ClientMessage::Trade { good: Good::Timber, boxes: 1, out: false }, now);
        assert_eq!(trunk(&mut world, now)[1..], [(Key::Book, true), (Key::Sell, false)]);
        assert!(world.market.price(Good::Timber) > price, "buying timber did not push its price");

        // A box of crates sold: out on the ferry, paid as it casts off.
        let before = world.treasury;
        handle_player_action(&mut world, &mut events, &mut intersections, player, ClientMessage::Trade { good: Good::Crates, boxes: 1, out: true }, now);
        let until = now + 2 * turn;
        while world.town.on(now).sold.get(&Good::Crates).is_none() && step(&mut world, &mut events, &mut intersections, &mut now, until) {}
        let sold = world.town.on(now).sold.get(&Good::Crates).copied().unwrap_or(0.0);
        // What the depot spares over its own shelf, at the market's price less freight.
        assert!(sold > 0.0 && sold <= 100.0 * crate::market::Market::ceiling(Good::Crates) + 1e-6, "the box went out for {sold}");
        assert!(world.lumps.iter().any(|l| l.building == harbour && l.coins > 0.0), "no coins landed at the harbour");
        assert_eq!(trunk(&mut world, now)[2], (Key::Sell, true), "the box sold");
        let _ = before;
    }

    /// One lorry, its depot a short street from the harbour, fetches the
    /// starter pack: each box is dropped under the
    /// canopy and the lorry is off again at once, and the six are home
    /// within eight hours of the first ferry sailing. A round trip is two
    /// drives, each ending in a backing into a dock; it once also stood
    /// ten minutes at the depot, a van's unloading, and the six took more
    /// than eight hours.
    #[test]
    fn one_lorry_fetches_the_starter_pack_in_eight_hours() {
        let mut world = street();
        let harbour = harbour_of(&world);
        let x = HARBOUR_X - 12;
        let facing = world.site_for(GridCoord { x, y: 1 }, BuildingKind::Depot).unwrap();
        let depot = world.place_building(GridCoord { x, y: 1 }, BuildingKind::Depot, facing).unwrap();
        world.orient(depot);
        let mut events = EventQueue::new();
        let mut intersections = IntersectionRegistry::new();
        settle_and_wake(&mut world, &mut events);
        let ferry = world.ferry_of(harbour).unwrap();
        let lorry = crate::haul::lorries_of(&world, depot)[0];
        let (day, mut now) = (DAY_MS as u64, 0);
        while car_of(&world, ferry).spot.is_none() && step(&mut world, &mut events, &mut intersections, &mut now, day) {}
        while car_of(&world, ferry).spot.is_some() && step(&mut world, &mut events, &mut intersections, &mut now, day) {}
        let (sailed, hour) = (now, day / 24);
        let home = |w: &World| w.lumps.iter().filter(|l| l.building == depot && l.units > 0.0).count();
        let mut parked_home = None;
        while home(&world) < 6 && step(&mut world, &mut events, &mut intersections, &mut now, sailed + 8 * hour) {
            let c = car_of(&world, lorry);
            match (c.trip.is_none() && world.claims.get(&lorry) == Some(&depot), parked_home) {
                (true, None) => parked_home = Some(now),
                (false, Some(at)) => {
                    assert!(now - at <= 2 * crate::haul::COUPLE_MS, "the lorry stood {} ms at home", now - at);
                    parked_home = None;
                }
                _ => {}
            }
        }
        assert_eq!(home(&world), 6, "{} boxes home in eight hours", home(&world));
        eprintln!("six boxes home in {:.2} hours", (now - sailed) as f64 / hour as f64);
    }
}
