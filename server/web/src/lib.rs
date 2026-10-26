//! A level for a Web Worker: a `Session` (`sprawl::replay`), ticked by the
//! worker's own timer, taking and giving msgpack, the bytes the server's
//! socket carries, so the client draws it as it draws the town.

use sprawl::level::Phase;
use sprawl::protocol::ClientMessage;
use sprawl::replay::{Input, Session};
use wasm_bindgen::prelude::*;

/// How fast a test plays: steps a tick.
const TEST_SPEED: u32 = 12;

#[wasm_bindgen]
pub struct Web {
    session: Session,
}

#[wasm_bindgen]
impl Web {
    /// A level from its name and text, at noon, its traffic running.
    #[wasm_bindgen(constructor)]
    pub fn new(name: String, text: String) -> Web {
        Web { session: Session::new(&name, &text, env!("SPRAWL_COMMIT")) }
    }

    /// A message from the client, as the socket would carry it.
    pub fn send(&mut self, bytes: &[u8]) {
        let Ok(msg) = rmp_serde::from_slice::<ClientMessage>(bytes) else { return };
        // Speed is the level's to set while it tests.
        if matches!(msg, ClientMessage::SetSpeed(_)) && self.session.level.phase() == Phase::Test {
            return;
        }
        self.session.command(msg);
    }

    /// One tick: as many steps as the speed says, the level setting off
    /// whoever is due before each. How many wakes.
    pub fn tick(&mut self) -> u32 {
        let wakes = self.session.tick();
        if self.session.level.phase() != Phase::Test && self.session.game.speed == TEST_SPEED {
            self.speed(1);
        }
        wakes
    }

    fn speed(&mut self, speed: u32) {
        self.session.command(ClientMessage::SetSpeed(speed));
    }

    /// Start a test: the roads cleared, the clock run fast.
    pub fn test(&mut self) {
        self.session.input(Input::Test);
        if self.session.level.phase() == Phase::Test {
            self.speed(TEST_SPEED);
        }
    }

    /// The rest of the test at once, nothing drawn until it is over.
    pub fn finish(&mut self) {
        while self.session.level.phase() == Phase::Test {
            for _ in 0..100 {
                self.session.step();
            }
        }
        self.speed(1);
        self.session.tick();
    }

    /// Our own solve, laid by the hand: for development, and for a player
    /// who asks to see it.
    pub fn solve(&mut self) {
        for step in self.session.level.solve_steps(&self.session.game.world) {
            self.session.command(ClientMessage::Build(step));
        }
    }

    /// The player's roads, as steps to lay them again (`Level::layout`),
    /// as JSON.
    pub fn layout(&self) -> String {
        serde_json::to_string(&sprawl::level::Level::layout(&self.session.game.world)).unwrap_or_default()
    }

    /// Roads written down by `layout`, laid again.
    pub fn load(&mut self, json: &str) {
        let steps: Vec<sprawl::protocol::Build> = serde_json::from_str(json).unwrap_or_default();
        for step in steps {
            self.session.command(ClientMessage::Build(step));
        }
    }

    /// Back to building.
    pub fn build(&mut self) {
        self.session.input(Input::Build);
        self.speed(1);
    }

    /// Every two roads that run into each other (`World::clashing`): none,
    /// ever; the drag tests check.
    pub fn clashing(&self) -> String {
        serde_json::to_string(&self.session.game.world.clashing()).unwrap_or_default()
    }

    /// The level as the client shows it, as JSON.
    pub fn state(&self) -> String {
        serde_json::to_string(&self.session.level.state(&self.session.game)).unwrap_or_default()
    }

    /// What the game said since last asked, a message each.
    pub fn drain(&mut self) -> js_sys::Array {
        self.session
            .game
            .take_outbox()
            .into_iter()
            .filter_map(|(_, msg)| rmp_serde::to_vec_named(&msg).ok())
            .map(|bytes| JsValue::from(js_sys::Uint8Array::from(bytes.as_slice())))
            .collect()
    }

    /// Mark this moment, and a tile if one is pointed at, with a note: what
    /// looks wrong here (`sprawl::replay::Flag`).
    pub fn flag(&mut self, x: Option<i32>, y: Option<i32>, note: String) {
        let tile = x.zip(y).map(|(x, y)| [x, y]);
        self.session.flag(tile, note);
    }

    /// What the last flag is about, said after it was dropped.
    pub fn note(&mut self, note: String) {
        if let Some(f) = self.session.record.flags.last_mut() {
            f.note = note;
        }
    }

    /// Everything played so far, to play again, as JSON.
    pub fn replay(&self) -> String {
        self.session.json()
    }
}

/// A new town for the browser's opening (`/opening`): a seed's island, its
/// harbour seated, at nine in the morning, the first ferry on its way. The
/// same game the server runs, for one mayor, fresh on every load.
#[wasm_bindgen]
pub struct Town {
    game: sprawl::game::Game,
}

#[wasm_bindgen]
impl Town {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32) -> Town {
        let nine = sprawl::protocol::DAY_MS as u64 * 9 / 24;
        let world = sprawl::hand::town(seed, nine);
        world.raise_mountains();
        let mut game = sprawl::game::Game::new(world, nine, 1, Box::new(move || sprawl::hand::town(seed, 0)));
        game.connect(ME, 0);
        Town { game }
    }

    /// A message from the client, as the socket would carry it.
    pub fn send(&mut self, bytes: &[u8]) {
        if let Ok(msg) = rmp_serde::from_slice::<ClientMessage>(bytes) {
            self.game.command(ME, msg);
        }
    }

    /// One tick, as the server's loop ticks it. How many wakes.
    pub fn tick(&mut self) -> u32 {
        self.game.tick()
    }

    /// What the game said since last asked, a message each.
    pub fn drain(&mut self) -> js_sys::Array {
        self.game
            .take_outbox()
            .into_iter()
            .filter_map(|(_, msg)| rmp_serde::to_vec_named(&msg).ok())
            .map(|bytes| JsValue::from(js_sys::Uint8Array::from(bytes.as_slice())))
            .collect()
    }
}

/// The one client a browser's town has.
const ME: sprawl::game::ClientId = 1;
