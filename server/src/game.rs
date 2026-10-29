use fixed::{HashMap, HashSet};

use crate::resident::handle_resident_wake;
use traffic::event_queue::EventQueue;
use model::GameTime;
use model::{CarRole, ClientMessage, Clock, DAY_MS, EntityId, GameObject, Operation, OwnerId, ServerMessage};
use land::ChunkCoord;
use crate::view::{flush_dirty, handle_set_chunks, ClientState, Shared};
use crate::world::World;

pub type ClientId = u64;

/// Simulated milliseconds per step. Fixed: speed adds steps rather than making
/// them longer, so running fast cannot change what the simulation does.
pub const STEP_MS: GameTime = 10;
/// How often the game settles with nothing built: ferries look at the
/// time.
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
    pub now: GameTime,
    pub speed: u32,
    /// Where a `RunTo` stops and speed goes back to 1.
    until: Option<GameTime>,
    /// How many times a resident has thought, all told: what a day of
    /// town costs (`a_town_thinks_within_budget`).
    pub thoughts: u64,
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
            now,
            speed,
            until: None,
            thoughts: 0,
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
        for id in self.world.map.resident_ids() {
            wake_resident(&self.world, &mut self.events, id);
        }
        let standing: Vec<EntityId> = self
            .world.map
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
        Clock { now: self.now, speed: self.speed, day_ms: DAY_MS }
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
            ClientMessage::SetSpeed(s) => self.set_speed(s, None),
            ClientMessage::RunTo(t) => self.set_speed(MAX_SPEED, Some(t)),
            ClientMessage::SetChunks(bounds) => {
                let mut shared = Shared::new(&self.world, self.clock());
                handle_set_chunks(&mut shared, &mut self.clients, &mut self.outbox, client_id, bounds);
            }
            ClientMessage::ResetWorld => {
                let world = (self.fresh)();
                self.replace(world);
            }
            ClientMessage::Card(id) => {
                let card = crate::card::card(&self.world, id, self.now);
                self.send(client_id, ServerMessage::Card(card));
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
                if let Some(reply) = crate::hand::handle_player_action(&mut self.world, &mut self.events, owner, message, self.now) {
                    let to: Vec<ClientId> = self.clients.iter().filter(|(_, cs)| cs.owner == owner).map(|(&id, _)| id).collect();
                    for id in to {
                        self.send(id, ServerMessage::News(vec![reply.clone()]));
                    }
                }
            }
        }
    }

    fn set_speed(&mut self, speed: u32, until: Option<GameTime>) {
        self.speed = speed.min(MAX_SPEED);
        self.until = until;
        // Paused, nothing goes dirty and no update would ever be sent — so
        // clients would keep extrapolating cars against a stopped world.
        // Push the new clock instead of waiting.
        let update = Shared::new(&self.world, self.clock()).update(vec![], vec![]);
        let ids: Vec<ClientId> = self.clients.keys().copied().collect();
        for id in ids {
            self.send(id, update.clone());
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
            if self.until.is_some_and(|t| self.now >= t) {
                self.set_speed(1, None);
                break;
            }
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
        if std::mem::take(&mut self.stirred) || !self.world.map.unsettled.is_empty() || self.now % SETTLE_MS == 0 {
            settle_and_wake(&mut self.world, &mut self.events);
        }
        self.now += STEP_MS;
        self.events.set_now(self.now);
        let mut wakes = 0;
        while let Some(id) = self.events.pop_due() {
            if self.world.map.resident(id).is_some() {
                self.thoughts += 1;
            }
            handle_wake(&mut self.world, &mut self.events, id, self.now);
            wakes += 1;
        }
        crate::market::hour(&mut self.world, self.now);
        crate::logistics::plan(&mut self.world, &mut self.events, self.now);
        wakes
    }

    /// On to the next step anything happens at, before `to`, and that step
    /// taken; or, nothing before it, on to `to`. False once there. The
    /// steps between, where nothing settles, nothing is due and the
    /// market's hour has not come, are skipped rather than stepped: they
    /// would change nothing, so what the world does is what `step` does,
    /// in a fraction of the time, and a test that looks at it after each
    /// sees all there is to see.
    pub fn step_to(&mut self, to: GameTime) -> bool {
        if self.now >= to {
            return false;
        }
        if !self.stirred && self.world.map.unsettled.is_empty() && !self.world.plan_due {
            let due = self.events.next_due().into_iter().chain([(self.world.market.hour + 1) * crate::market::HOUR]).min().unwrap_or(GameTime::MAX);
            let next = due.saturating_sub(STEP_MS).min(self.now.next_multiple_of(SETTLE_MS)).max(self.now).next_multiple_of(STEP_MS);
            if next >= to {
                self.now = to.next_multiple_of(STEP_MS);
                self.events.set_now(self.now);
                return true;
            }
            self.now = next;
        }
        self.step();
        true
    }

    /// `step_to` until `to`.
    pub fn run_to(&mut self, to: GameTime) {
        while self.step_to(to) {}
    }
}

/// One wake-up, dispatched on what the entity is. A car's decision is
/// physics; a resident's is where to be.
fn handle_wake(
    world: &mut World,
    events: &mut EventQueue,
    id: EntityId,
    now: GameTime,
) {
    match world.map.objects.get(id).map(|e| &e.object) {
        // A parked one's is the game's: what it does next.
        Some(GameObject::Car(c)) if c.trip.is_none() => crate::logistics::car_idle(world, events, id, now),
        Some(GameObject::Car(_)) => world.drive(events, |t, e| traffic::car::simulation::handle_car_wake_up(t, e, id, now)),
        Some(GameObject::Resident(_)) => handle_resident_wake(world, events, id, now),
        // A building's wake is its turn: a farm whose crop has ripened,
        // or a wait late long enough to give up on.
        Some(GameObject::Building(_)) => {
            world.give_up(id, now);
            crate::logistics::turn(world, events, id, now);
        }
        // A junction's is its lights looking again.
        Some(GameObject::RoadNode(_)) => world.drive(events, |t, e| traffic::car::simulation::lights(t, e, id, now)),
        // Midnight: every building takes its turn, and every line reads
        // the labour market again.
        None if id == MIDNIGHT => {
            crate::logistics::turns(world, events, now);
            settle_and_wake(world, events);
        }
        _ => {}
    }
}

/// The wake that is nobody's: the day turning. No entity has this id.
const MIDNIGHT: EntityId = EntityId::MAX;

/// Population follows what changed, and whoever's situation changed gets to
/// think about it. And the day is always due to turn.
pub(crate) fn settle_and_wake(world: &mut World, events: &mut EventQueue) {
    let changed = !world.map.unsettled.is_empty();
    for id in world.settle() {
        wake_resident(world, events, id);
    }
    // The quays change with every ferry and lorry, and are few.
    world.waiting.extend(world.map.harbours.keys().copied());
    crate::waits::look(world, events, events.now());
    // A harbour reached, or cut off: the town's way out, and its ferry.
    world.map.mark_harbours();
    let standing: Vec<EntityId> = world.map.harbours.keys().copied().collect();
    let port = standing.iter().any(|&h| world.map.building(h).is_some_and(|b| b.kind == model::BuildingKind::Port));
    if port != world.market.port {
        world.market.port = port;
        world.market.changed = true;
    }
    for h in standing {
        world.commission(h, events.now());
    }
    // Something built, reached or cut off: what it wants, or can give,
    // may have changed.
    world.plan_due |= changed;
    // A harbour built, or its line changed: its ferries look
    // again. Not at every settle: a moored ferry woken rolls its next
    // settler off at once, not ROLL_MS after the last.
    let harbours: Vec<EntityId> = if changed { world.map.harbours.keys().copied().collect() } else { Vec::new() };
    for h in harbours {
        for id in world.ferries_of(h) {
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
        world.map.objects.get(id).map(|e| &e.object),
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

#[cfg(test)]
pub(crate) mod tests;
