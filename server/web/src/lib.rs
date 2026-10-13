//! A level for a Web Worker: one `Game` and the `Level` that drives it,
//! ticked by the worker's own timer, taking and giving msgpack, the bytes
//! the server's socket carries, so the client draws it as it draws the town.

use sprawl::game::Game;
use sprawl::level::{Level, Phase};
use sprawl::protocol::{ClientMessage, DAY_MS, OwnerId};
use wasm_bindgen::prelude::*;

/// The one client a worker serves.
const ME: u64 = 1;
/// How fast a test plays: steps a tick.
const TEST_SPEED: u32 = 12;

#[wasm_bindgen]
pub struct Web {
    game: Game,
    level: Level,
}

#[wasm_bindgen]
impl Web {
    /// A level from its name and text, at noon, its traffic running.
    #[wasm_bindgen(constructor)]
    pub fn new(name: String, text: String) -> Web {
        let (level, world) = Level::build(&name, &text);
        let again = move || Level::build(&name, &text).1;
        let mut game = Game::new(world, DAY_MS as u64 / 2, 1, Box::new(again));
        game.connect(ME, OwnerId::default());
        Web { game, level }
    }

    /// A message from the client, as the socket would carry it.
    pub fn send(&mut self, bytes: &[u8]) {
        let Ok(msg) = rmp_serde::from_slice::<ClientMessage>(bytes) else { return };
        // Speed is the level's to set while it tests.
        if matches!(msg, ClientMessage::SetSpeed(_)) && self.level.phase() == Phase::Test {
            return;
        }
        self.game.command(ME, msg);
    }

    /// One tick: as many steps as the speed says, the level setting off
    /// whoever is due before each. How many wakes.
    pub fn tick(&mut self) -> u32 {
        let level = &mut self.level;
        let wakes = self.game.tick_with(|game| level.step(game));
        if self.level.phase() != Phase::Test && self.game.speed == TEST_SPEED {
            self.game.command(ME, ClientMessage::SetSpeed(1));
        }
        wakes
    }

    /// Start a test: the roads cleared, the clock run fast.
    pub fn test(&mut self) {
        self.level.test(&mut self.game);
        if self.level.phase() == Phase::Test {
            self.game.command(ME, ClientMessage::SetSpeed(TEST_SPEED));
        }
    }

    /// The rest of the test at once, nothing drawn until it is over.
    pub fn finish(&mut self) {
        while self.level.phase() == Phase::Test {
            for _ in 0..100 {
                self.level.step(&mut self.game);
                self.game.step();
            }
        }
        self.game.command(ME, ClientMessage::SetSpeed(1));
        self.game.tick();
    }

    /// Our own solve, laid by the hand: for development, and for a player
    /// who asks to see it.
    pub fn solve(&mut self) {
        for step in self.level.solve_steps(&self.game.world) {
            self.game.command(ME, ClientMessage::Build(step));
        }
    }

    /// The player's roads, as steps to lay them again (`Level::layout`),
    /// as JSON.
    pub fn layout(&self) -> String {
        serde_json::to_string(&Level::layout(&self.game.world)).unwrap_or_default()
    }

    /// Roads written down by `layout`, laid again.
    pub fn load(&mut self, json: &str) {
        let steps: Vec<sprawl::protocol::Build> = serde_json::from_str(json).unwrap_or_default();
        for step in steps {
            self.game.command(ME, ClientMessage::Build(step));
        }
    }

    /// Back to building.
    pub fn build(&mut self) {
        self.level.build_again();
        self.game.command(ME, ClientMessage::SetSpeed(1));
    }

    /// The level as the client shows it, as JSON.
    pub fn state(&self) -> String {
        serde_json::to_string(&self.level.state(&self.game)).unwrap_or_default()
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
