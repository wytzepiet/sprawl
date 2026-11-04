use fixed::{HashMap, HashSet};

use traffic::event_queue::EventQueue;
use model::GameTime;
use model::{ClientMessage, Clock, DAY_MS, EntityId, GameObject, Operation, OwnerId, ServerMessage};
use land::ChunkCoord;
use crate::view::{flush_dirty, handle_set_chunks, ClientState, Shared};
use crate::world::World;

pub type ClientId = u64;

/// Simulated milliseconds per step. Fixed: speed adds steps rather than making
/// them longer, so running fast cannot change what the simulation does.
pub const STEP_MS: GameTime = 10;
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
            clients: HashMap::default(),
            outbox: Vec::new(),
            stirred: false,
            fresh,
        };
        game.events.set_now(now);
        game.wake_all();
        game
    }

    /// Trips do not survive a save, so a loaded world is every car parked
    /// at home: everything wakes to look again, and the next family is due.
    fn wake_all(&mut self) {
        if self.world.town.start.is_none() && self.world.map.frame.is_none() && !self.world.map.terrain.is_empty() {
            crate::town::found(&mut self.world, self.now);
        }
        self.world.map.changed();
        let ids: Vec<EntityId> = self.world.map.objects.iter().filter(|e| matches!(e.object, GameObject::Building(_) | GameObject::Car(_))).map(|e| e.id).collect();
        for id in ids {
            self.events.wake(0, id);
        }
        if self.world.map.frame.is_none() {
            let next = self.world.town.next_spawn.saturating_sub(self.now).max(1);
            self.events.wake(next, crate::town::SPAWN);
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
        let update = Shared::new(&self.world, self.clock()).update(vec![]);
        self.send(id, update);
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
        let update = Shared::new(&self.world, self.clock()).update(vec![]);
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
                self.outbox.push((*id, shared.update(ops)));
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
        wakes
    }

    /// One step of simulated time, and everything due in it. How many wakes.
    ///
    /// Whatever the commands built, reached, cut off or took away settles
    /// at the step after them, once for the batch (the road brush sends a
    /// command a tile): each building's door is found again, and it and
    /// its vehicles look again. By the steps, not by the ticks: a tick is
    /// as many steps as the clock's speed, and what the game does must not
    /// depend on how fast it is watched (`replay.rs`).
    pub fn step(&mut self) -> u32 {
        if std::mem::take(&mut self.stirred) || !self.world.map.unsettled.is_empty() {
            settle(&mut self.world, &mut self.events);
        }
        self.now += STEP_MS;
        self.events.set_now(self.now);
        let mut wakes = 0;
        while let Some(id) = self.events.pop_due() {
            handle_wake(&mut self.world, &mut self.events, id, self.now);
            wakes += 1;
        }
        wakes
    }

    /// On to the next step anything happens at, before `to`, and that step
    /// taken; or, nothing before it, on to `to`. False once there. The
    /// steps between, where nothing settles and nothing is due, are
    /// skipped rather than stepped: they would change nothing.
    pub fn step_to(&mut self, to: GameTime) -> bool {
        if self.now >= to {
            return false;
        }
        if !self.stirred && self.world.map.unsettled.is_empty() {
            let due = self.events.next_due().unwrap_or(GameTime::MAX);
            let next = due.saturating_sub(STEP_MS).max(self.now).next_multiple_of(STEP_MS);
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

/// One wake-up, dispatched on what the entity is.
fn handle_wake(world: &mut World, events: &mut EventQueue, id: EntityId, now: GameTime) {
    match world.map.objects.get(id).map(|e| &e.object) {
        // A parked one's is the game's: what it does next.
        Some(GameObject::Car(c)) if c.trip.is_none() => crate::town::car_idle(world, events, id, now),
        Some(GameObject::Car(_)) => world.drive(events, |t, e| traffic::car::simulation::handle_car_wake_up(t, e, id, now)),
        Some(GameObject::Building(_)) => crate::town::building_wake(world, events, id, now),
        // A junction's is its lights looking again.
        Some(GameObject::RoadNode(_)) => world.drive(events, |t, e| traffic::car::simulation::lights(t, e, id, now)),
        None if id == crate::town::SPAWN => crate::town::spawn(world, events, now),
        _ => {}
    }
}

/// What the commands built settles: every building placed, reached, cut
/// off or taken away finds its door, and it and its vehicles look again.
pub(crate) fn settle(world: &mut World, events: &mut EventQueue) {
    for id in world.map.changed() {
        events.wake(0, id);
        for car in world.map.objects.fleet(id).collect::<Vec<_>>() {
            events.wake(0, car);
        }
    }
}
