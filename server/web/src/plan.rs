//! The game's own road planner in the browser: what a drag may lay, asked
//! here and not of the server a round trip away. A copy of the map as the
//! client has it (the roads and buildings sent it, the ground in view),
//! made a world again for each drag, and the drag laid on that world by
//! `draw::draw`, as the server lays it on its own. What the server says
//! meanwhile, the drag's own roads among it, waits for the next drag: the
//! copy goes on as the server's world does, from the same start.

use fixed::HashMap;
use land::{TerrainType, CHUNK_SIZE, CHUNK_SKIRT, CHUNK_STRIDE};
use map::tracked::Tracked;
use map::Map;
use model::{EntityId, GameObject, GameObjectEntry, Hint, Operation, ServerMessage, Stroke};
use sprawl::world::World;
use std::collections::BTreeMap;
use traffic::event_queue::EventQueue;
use wasm_bindgen::prelude::*;

/// The hand's own owner in the copy: its undo is the drag drawn.
const HAND: model::OwnerId = 1;

#[wasm_bindgen]
#[derive(Default)]
pub struct Planner {
    /// Every road node and building the client was sent, as it was sent.
    built: BTreeMap<EntityId, GameObjectEntry>,
    ground: HashMap<(i32, i32), TerrainType>,
    /// The copy made a world, ahead of the next drag (`prepare`), until
    /// more is heard.
    ready: Option<World>,
    /// The copy made a world for a drag, and the drag laid on it.
    world: Option<(World, u32)>,
}

#[wasm_bindgen]
impl Planner {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Planner {
        Planner::default()
    }

    /// A message the server sent, as its socket carried it.
    pub fn hear(&mut self, bytes: &[u8]) {
        if let Ok(msg) = rmp_serde::from_slice::<ServerMessage>(bytes) {
            self.heard(msg);
        }
    }

    /// The copy made a world ahead of the next drag, as making it costs
    /// a town of thousands some milliseconds: for a moment when the hand
    /// is idle.
    pub fn prepare(&mut self) {
        if self.ready.is_none() {
            self.ready = Some(self.made());
        }
    }

    /// For a drag (a `Stroke`, as the socket would carry it), where it may
    /// go on: the server's `Hint::Reach`, as its socket would carry it.
    pub fn reach(&mut self, stroke: &[u8]) -> Vec<u8> {
        let Ok(stroke) = rmp_serde::from_slice::<Stroke>(stroke) else { return Vec::new() };
        rmp_serde::to_vec_named(&ServerMessage::Hint(self.reached(stroke))).unwrap_or_default()
    }
}

impl Planner {
    pub fn heard(&mut self, msg: ServerMessage) {
        match msg {
            ServerMessage::Update(u) => {
                for op in u.ops {
                    match op {
                        Operation::Upsert(e) if matches!(e.object, GameObject::RoadNode(_) | GameObject::Building(_)) => {
                            self.built.insert(e.id, *e);
                            self.ready = None;
                        }
                        Operation::Delete(id) => {
                            if self.built.remove(&id).is_some() {
                                self.ready = None;
                            }
                        }
                        _ => {}
                    }
                }
            }
            ServerMessage::TerrainChunk(c) => {
                let (x0, y0) = (c.coord.cx * CHUNK_SIZE - CHUNK_SKIRT, c.coord.cy * CHUNK_SIZE - CHUNK_SKIRT);
                for (i, &b) in c.tiles.iter().enumerate() {
                    if let Some(t) = TerrainType::from_byte(b) {
                        self.ground.insert((x0 + i as i32 % CHUNK_STRIDE, y0 + i as i32 / CHUNK_STRIDE), t);
                    }
                }
                self.ready = None;
            }
            ServerMessage::Welcome(_) => *self = Planner::default(),
            _ => {}
        }
    }

    pub fn reached(&mut self, stroke: Stroke) -> Hint {
        // A new drag: the world made again, of all heard so far.
        if !matches!(self.world, Some((_, id)) if id == stroke.id) {
            let world = self.ready.take().unwrap_or_else(|| self.made());
            self.world = Some((world, stroke.id));
        }
        let (world, _) = self.world.as_mut().unwrap();
        sprawl::draw::draw(world, &mut EventQueue::new(), HAND, stroke.clone(), 0);
        let ways = sprawl::draw::reach(world, HAND, &stroke);
        Hint::Reach { id: stroke.id, len: stroke.tiles.len() as u32, ways }
    }

    /// The copy as a world, as a save is opened.
    fn made(&self) -> World {
        let next = self.built.keys().next_back().map_or(1, |id| id + 1);
        let mut map = Map::from_loaded(Tracked::load(self.built.values().cloned().collect(), next), 0);
        map.terrain = self.ground.clone();
        map.restore();
        let mut world = World::from(map);
        world.town.boundless();
        world
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use land::ChunkCoord;
    use model::{Clock, GridCoord, Spot, StateUpdate, Tool};

    /// A fixture's world as the server holds it.
    fn server(text: &str) -> World {
        let mut map = Map::new();
        map::fixtures::build_text(&mut map, text);
        let mut world = World::from(map);
        world.town.boundless();
        world
    }

    /// What the server sends a client of that world: every road and
    /// building, and the ground.
    pub(super) fn told(world: &World) -> Planner {
        let mut p = Planner::new();
        let ops = world.map.objects.iter().chain(world.map.objects.roads()).filter(|e| matches!(e.object, GameObject::RoadNode(_) | GameObject::Building(_))).map(|e| Operation::Upsert(Box::new(e.clone()))).collect();
        p.heard(ServerMessage::Update(StateUpdate { ops, clock: Clock { now: 0, speed: 1, day_ms: 1 }, town: None, island: None }));
        let chunk = |v: i32| v.div_euclid(CHUNK_SIZE);
        let chunks: std::collections::BTreeSet<(i32, i32)> = world.map.terrain.keys().map(|&(x, y)| (chunk(x), chunk(y))).collect();
        for (cx, cy) in chunks {
            p.heard(ServerMessage::TerrainChunk(world.map.terrain_chunk(ChunkCoord { cx, cy })));
        }
        p
    }

    /// Every drag straight out of a road tile, eight ways, up to eight
    /// tiles, at each length: the planner tells what the server tells.
    #[test]
    fn the_planner_reaches_as_the_server_does() {
        let mut asked = 0;
        for name in ["07-junctions", "12-diagonal", "21-mountains", "26-diagonals"] {
            let text = std::fs::read_to_string(format!("{}/../fixtures/{name}.txt", env!("CARGO_MANIFEST_DIR"))).unwrap();
            let base = server(&text);
            let mut planner = told(&base);
            let starts: Vec<GridCoord> = base.map.objects.roads().filter_map(|e| e.position).step_by(7).collect();
            let mut id = 0;
            for &at in &starts {
                for (dx, dy) in [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)] {
                    for want in [0, 2] {
                        id += 1;
                        let mut world = server(&text);
                        let tiles: Vec<Spot> = (0..8).map(|k| Spot { at: GridCoord { x: at.x + dx * k, y: at.y + dy * k }, want }).collect();
                        for n in 1..=tiles.len() {
                            let stroke = Stroke { id, tool: Tool::Street, road: false, tiles: tiles[..n].to_vec(), start: None };
                            sprawl::draw::draw(&mut world, &mut EventQueue::new(), HAND, stroke.clone(), 0);
                            let theirs = sprawl::draw::reach(&world, HAND, &stroke);
                            // Now and then, what the server laid of it heard
                            // before the next step, as a client would.
                            if n % 3 == 0 {
                                let now = told(&world).built;
                                let gone = planner.built.keys().filter(|id| !now.contains_key(id)).map(|&id| Operation::Delete(id));
                                let ops = gone.chain(now.values().map(|e| Operation::Upsert(Box::new(e.clone())))).collect();
                                planner.heard(ServerMessage::Update(StateUpdate { ops, clock: Clock { now: 0, speed: 1, day_ms: 1 }, town: None, island: None }));
                            }
                            let Hint::Reach { ways: ours, .. } = planner.reached(stroke) else { unreachable!() };
                            assert_eq!(ours, theirs, "{name}: from {at:?} by ({dx},{dy}) at {want}, {n} tiles");
                            asked += 1;
                        }
                    }
                }
            }
        }
        assert!(asked > 100, "{asked}");
    }
}

#[cfg(test)]
mod timing {
    /// What the planner costs in the biggest test town: a drag begun (the
    /// world made again) and each tile on. `--ignored --nocapture`.
    #[test]
    #[ignore]
    fn what_planning_costs() {
        use super::*;
        use model::{GridCoord, Spot, Tool};
        let text = std::fs::read_to_string(format!("{}/../fixtures/30-metro.txt", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let mut map = Map::new();
        map::fixtures::build_text(&mut map, &text);
        let world = World::from(map);
        let mut p = tests::told(&world);
        let at = world.map.objects.roads().filter_map(|e| e.position).nth(500).unwrap();
        for id in 1..=5u32 {
            let t = std::time::Instant::now();
            let mut first = None;
            for n in 1..=10 {
                let tiles = (0..n).map(|k| Spot { at: GridCoord { x: at.x + k, y: at.y + id as i32 }, want: 0 }).collect();
                p.reached(Stroke { id, tool: Tool::Street, road: false, tiles, start: None });
                first.get_or_insert(t.elapsed());
            }
            println!("{} entries: begun {:?}, ten tiles {:?}", p.built.len(), first.unwrap(), t.elapsed());
        }
    }
}
