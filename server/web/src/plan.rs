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
use model::{Ask, EntityId, GameObject, GameObjectEntry, Hint, Operation, ServerMessage, Stroke};
use sprawl::world::World;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
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
    /// What the drag laid has changed of the copy, and taken from it.
    touched: BTreeSet<EntityId>,
}

/// What a drag has laid so far, to show before the server says (the
/// client's guess, `state/guess.ts`): the road nodes and buildings it
/// changed or made, and those it took away. Ids from `fresh` on are the
/// copy's own, new to the server.
#[derive(Serialize)]
pub struct Laid {
    pub id: u32,
    pub put: Vec<GameObjectEntry>,
    pub drop: Vec<EntityId>,
    pub fresh: EntityId,
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

    /// A drag (a `Stroke`, as the socket carries it) drawn, as the server
    /// draws it: what it has laid (`Laid`), msgpack.
    pub fn draw(&mut self, stroke: &[u8]) -> Vec<u8> {
        let Ok(stroke) = rmp_serde::from_slice::<Stroke>(stroke) else { return Vec::new() };
        rmp_serde::to_vec_named(&self.drawn(stroke)).unwrap_or_default()
    }

    /// What the hand asks (an `Ask`, as the socket carries it) answered as
    /// the server answers it (`hint::answer`): where a drag drawn may go
    /// on, on the drag's world; where one may start, or a building stand,
    /// on the copy as heard. The `Hint`, as its socket would carry it.
    pub fn ask(&mut self, ask: &[u8]) -> Vec<u8> {
        let Ok(ask) = rmp_serde::from_slice::<Ask>(ask) else { return Vec::new() };
        rmp_serde::to_vec_named(&ServerMessage::Hint(self.answered(ask))).unwrap_or_default()
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

    /// The world the drag `id` is laid on: for a new drag, made again of
    /// all heard so far.
    fn drag(&mut self, id: u32) -> &mut World {
        if !matches!(self.world, Some((_, was)) if was == id) {
            let mut world = self.ready.take().unwrap_or_else(|| self.made());
            world.map.objects.drain_persist_dirty();
            self.world = Some((world, id));
            self.touched.clear();
        }
        &mut self.world.as_mut().unwrap().0
    }

    pub fn drawn(&mut self, stroke: Stroke) -> Laid {
        let id = stroke.id;
        let world = self.drag(id);
        sprawl::draw::draw(world, &mut EventQueue::new(), HAND, stroke, 0);
        let (changed, removed) = world.map.objects.drain_persist_dirty();
        self.touched.extend(changed.into_iter().chain(removed));
        let world = &self.world.as_ref().unwrap().0;
        let built = |e: &&GameObjectEntry| matches!(e.object, GameObject::RoadNode(_) | GameObject::Building(_));
        let put = self.touched.iter().filter_map(|&t| world.map.objects.get(t)).filter(built).cloned().collect();
        let drop = self.touched.iter().copied().filter(|&t| world.map.objects.get(t).is_none() && self.built.contains_key(&t)).collect();
        Laid { id, put, drop, fresh: self.fresh() }
    }

    pub fn answered(&mut self, ask: Ask) -> Hint {
        let world = match &ask {
            Ask::Reach(stroke) => self.drag(stroke.id),
            _ => {
                self.prepare();
                self.ready.as_mut().unwrap()
            }
        };
        sprawl::hint::answer(world, HAND, ask)
    }

    /// The first id the copy has that the server never sent.
    fn fresh(&self) -> EntityId {
        self.built.keys().next_back().map_or(1, |id| id + 1)
    }

    /// The copy as a world, as a save is opened.
    fn made(&self) -> World {
        let mut map = Map::from_loaded(Tracked::load(self.built.values().cloned().collect(), self.fresh()), 0);
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

    /// Where a building would stand, held over each tile round the roads,
    /// and where a drag or a building may start in the view: as the server says.
    #[test]
    fn the_planner_places_as_the_server_does() {
        use model::{Area, BuildingKind, Holding};
        let mut fits = 0;
        for name in ["06-shops", "13-block", "26-diagonals"] {
            let text = std::fs::read_to_string(format!("{}/../fixtures/{name}.txt", env!("CARGO_MANIFEST_DIR"))).unwrap();
            let world = server(&text);
            let mut planner = told(&world);
            let json = |h: Hint| serde_json::to_string(&h).unwrap();
            let tiles: Vec<GridCoord> = world.map.objects.roads().filter_map(|e| e.position).step_by(5).map(|p| GridCoord { x: p.x + 1, y: p.y + 1 }).collect();
            for &at in &tiles {
                for kind in [BuildingKind::House, BuildingKind::Shop, BuildingKind::Farm] {
                    for facing in [None, Some(1)] {
                        let ask = Ask::Placing { kind, at, facing };
                        let ours = planner.answered(ask.clone());
                        fits += matches!(&ours, Hint::Placing(p) if p.why.is_none()) as u32;
                        assert_eq!(json(ours), json(sprawl::hint::answer(&world, HAND, ask)), "{name}: {kind:?} at {at:?} {facing:?}");
                    }
                }
            }
            let area = Area { x0: -40, y0: -40, x1: 40, y1: 40 };
            for hand in [Holding::Tool { tool: Tool::Street, road: false, want: 0 }, Holding::Building { kind: BuildingKind::House, facing: None }] {
                let ask = Ask::Starts { hand, area };
                assert_eq!(json(planner.answered(ask.clone())), json(sprawl::hint::answer(&world, HAND, ask)), "{name}: starts");
            }
        }
        assert!(fits > 10, "{fits}");
    }

    /// Every road node: where it stands, and how many ways on and in.
    fn roads(world: &World) -> Vec<(i32, i32, u8, [i8; 2], usize, usize)> {
        let mut out: Vec<_> = world.map.objects.roads().filter_map(|e| match &e.object {
            GameObject::RoadNode(n) => Some((e.position?.x, e.position?.y, n.height, n.side, n.outgoing.len(), n.incoming.len())),
            _ => None,
        }).collect();
        out.sort();
        out
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
                        // What the server laid of the last drag is taken back with it.
                        planner = told(&base);
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
                            if n > 1 {
                                planner.drawn(stroke.clone());
                            }
                            let Hint::Reach { ways: ours, .. } = planner.answered(Ask::Reach(stroke)) else { unreachable!() };
                            assert_eq!(roads(&planner.world.as_ref().unwrap().0), roads(&world), "{name}: laid from {at:?} by ({dx},{dy}) at {want}, {n} tiles");
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
                let stroke = Stroke { id, tool: Tool::Street, road: false, tiles, start: None };
                p.drawn(stroke.clone());
                p.answered(Ask::Reach(stroke));
                first.get_or_insert(t.elapsed());
            }
            println!("{} entries: begun {:?}, ten tiles {:?}", p.built.len(), first.unwrap(), t.elapsed());
        }
    }
}
