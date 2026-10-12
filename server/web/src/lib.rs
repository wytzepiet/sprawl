//! The game for a Web Worker: one `Game`, driven by the worker's own timer,
//! taking and giving msgpack, the bytes the server's socket carries, so the
//! client cannot tell one from the other.

use sprawl::game::Game;
use sprawl::protocol::{ClientMessage, OwnerId};
use sprawl::world::World;
use wasm_bindgen::prelude::*;

/// The one client a worker serves.
const ME: u64 = 1;

#[wasm_bindgen]
pub struct Web {
    game: Game,
}

#[wasm_bindgen]
impl Web {
    /// A world from a fixture's text, at noon, running.
    #[wasm_bindgen(constructor)]
    pub fn new(fixture: String) -> Web {
        let make = move || {
            let mut world = World::new();
            sprawl::fixtures::build_text(&mut world, &fixture);
            world
        };
        let world = make();
        let mut game = Game::new(world, sprawl::protocol::DAY_MS as u64 / 2, 1, Box::new(make));
        game.connect(ME, OwnerId::default());
        Web { game }
    }

    /// A message from the client, as the socket would carry it.
    pub fn send(&mut self, bytes: &[u8]) {
        if let Ok(msg) = rmp_serde::from_slice::<ClientMessage>(bytes) {
            self.game.command(ME, msg);
        }
    }

    /// One tick, as the server's loop takes one every step. How many wakes.
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
