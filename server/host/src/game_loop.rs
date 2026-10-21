use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;
use tokio::time::{Instant, interval, Duration};

use sprawl::engine::GameTime;
use sprawl::engine::tracked::Tracked;
use sprawl::game::{Game, STEP_MS, restore};
use sprawl::protocol::{DAY_MS, GameObject, ServerMessage};
use sprawl::world::World;

use crate::network::{ClientId, Command};
use crate::persistence;

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

/// The bare island a seed makes: no road is born with the map. Terrain is
/// derived from the seed, so it is made again on every start rather than
/// saved.
fn island(world: &mut World) {
    world.terrain = sprawl::terrain::generate(world.terrain_seed);
    println!("terrain: {} tiles from seed {}", world.terrain.len(), world.terrain_seed);
    let started = std::time::Instant::now();
    world.raise_mountains();
    println!("mountains: worn in {:.1}s", started.elapsed().as_secs_f32());
}

const PERSIST_INTERVAL: Duration = Duration::from_secs(1);
/// How far one tick may overrun before the loop says so: a quarter of a
/// second is twenty-five ticks of lag, well past anything a debug build
/// takes for one, and short enough to be seen the moment it starts.
const BEHIND: Duration = Duration::from_millis(250);

pub async fn run(mut commands: mpsc::UnboundedReceiver<Command>) {
    let db_path = db_path();
    let fixtures = std::env::var("SPRAWL_FIXTURES").ok();
    // Fixtures are built fresh on every start, at noon, standing still: the
    // same pictures every time, lit the same way.
    let (mut world, sim_time) = if fixtures.is_some() { (World::new(), DAY_MS as GameTime / 2) } else { load_world(&db_path) };
    if let Some(dir) = &fixtures {
        sprawl::fixtures::build(&mut world, Path::new(dir));
    } else {
        if world.objects.is_empty() {
            world.terrain_seed = new_seed();
        }
        island(&mut world);
        if !world.objects.is_empty() {
            restore(&mut world);
            println!("loaded {} objects from db", world.objects.len());
        }
    }
    let speed = if fixtures.is_some() { 0 } else { 1 };
    let fresh_db = db_path.clone();
    let fresh = Box::new(move || {
        let _ = std::fs::remove_file(&fresh_db);
        let mut world = World::new();
        world.terrain_seed = new_seed();
        island(&mut world);
        println!("reset: world cleared, terrain regenerated");
        world
    });
    let mut game = Game::new(world, sim_time, speed, fresh);
    let mut senders: HashMap<ClientId, mpsc::UnboundedSender<ServerMessage>> = HashMap::new();

    let mut tick_interval = interval(Duration::from_millis(STEP_MS));
    let mut last_persist = Instant::now();

    loop {
        tick_interval.tick().await;

        while let Ok(cmd) = commands.try_recv() {
            match cmd {
                Command::PlayerAction { client_id, message } => game.command(client_id, message),
                Command::ClientConnect { id, owner, sender } => {
                    senders.insert(id, sender);
                    game.connect(id, owner);
                }
                Command::Inspect { query, reply } => {
                    let _ = reply.send(inspect(&mut game, query));
                }
                Command::ClientDisconnect { id } => {
                    senders.remove(&id);
                    game.disconnect(id);
                }
            }
        }

        let started = Instant::now();
        let wakes = game.tick();
        // A tick that overruns is the clock falling behind the wall, and every
        // command queued behind it. Said out loud the moment it happens, so a
        // wake storm or a dear arrival shows in the log rather than in the fan.
        let took = started.elapsed();
        if took >= BEHIND {
            eprintln!("behind: {wakes} wakes took {} ms at speed {}", took.as_millis(), game.speed);
        }
        // Published for /health, which is how anything outside this loop can
        // tell the difference between a live world and a socket that outlived
        // it.
        crate::health::SIM_TIME.store(game.now, std::sync::atomic::Ordering::Relaxed);
        for (to, msg) in game.take_outbox() {
            if let Some(sender) = senders.get(&to) {
                let _ = sender.send(msg);
            }
        }

        if last_persist.elapsed() >= PERSIST_INTERVAL {
            persist(&mut game.world, &db_path, game.now);
            last_persist = Instant::now();
        }
    }
}

fn inspect(game: &mut Game, query: crate::network::Ask) -> String {
    use crate::network::Ask;
    let (world, now) = (&mut game.world, game.now);
    let v = match query {
        Ask::Resident(id) => sprawl::resident::inspect(world, id, now),
        Ask::Residents => sprawl::resident::inspect_all(world, now),
        Ask::Demand => sprawl::resident::demand(world, now),
        Ask::Lot(id) => world.inspect_lot(id, now),
        Ask::Card(id) => sprawl::card::card(world, id, now),
        Ask::Town => sprawl::economy::town(world, now),
        Ask::Sea => sprawl::haul::inspect(world, now),
        Ask::Map { x, y, r } => sprawl::fixtures::draw(world, x, y, r).into(),
        Ask::Call(id) => {
            // Its shelf, emptied: a depot fetches, a maker is full again by
            // tomorrow, anything else calls for stock.
            if let Some(GameObject::Building(b)) = world.objects.get_mut(id).map(|e| &mut e.object) {
                for need in sprawl::economy::shelves(b.kind) {
                    if let Some(stock) = b.stocks.get_mut(&need) {
                        stock.level = 0.0;
                    }
                }
            }
            sprawl::calls::turn(world, &mut game.events, id, now);
            serde_json::json!({ "calls": world.calls.iter().map(|c| serde_json::json!({ "kind": format!("{:?}", c.kind), "good": c.good, "at": c.at, "answered_by": c.answered_by })).collect::<Vec<_>>() })
        }
    };
    serde_json::to_string_pretty(&v).unwrap_or_default()
}

fn load_world(db_path: &Path) -> (World, GameTime) {
    let (entries, meta) = persistence::load(db_path);
    // A new town opens at nine in the morning, so the opening, and its
    // first ferry, are played by daylight rather than in the dark.
    let sim_time = if entries.is_empty() { meta.sim_time.max(DAY_MS as GameTime * 9 / 24) } else { meta.sim_time };
    let mut world = if entries.is_empty() {
        World::new()
    } else {
        // What the city has served, and what the mayor has, outlive a
        // restart; a fresh world keeps its stake.
        let mut world = World::from_loaded(Tracked::load(entries, meta.next_id), meta.terrain_seed);
        world.gdp = meta.gdp;
        world.treasury = meta.treasury;
        world.build = sprawl::tree::Build::load(meta.taken);
        if !meta.missions.is_empty() {
            world.missions.list = meta.missions;
        }
        world.market = meta.market;
        world
    };
    // SPRAWL_ALL: the whole tree and a bottomless treasury, to test any building.
    if std::env::var("SPRAWL_ALL").is_ok() {
        world.build = sprawl::tree::Build::all();
        world.treasury = 1_000_000.0;
    }
    (world, sim_time)
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
            missions: world.missions.list.clone(),
            market: world.market.clone(),
        },
    );
    println!("persisted {} changed, {} removed", changed.len(), removed_ids.len());
}
