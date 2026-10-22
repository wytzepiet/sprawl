use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;
use tokio::time::{Instant, interval, Duration};

use sprawl::engine::GameTime;
use sprawl::engine::tracked::Tracked;
use sprawl::game::{Game, STEP_MS};
use sprawl::protocol::{DAY_MS, ServerMessage};
use sprawl::world::World;

use crate::network::{ClientId, Command, Debug};
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
    let mut db = persistence::Db::open(&db_path);
    let fixtures = std::env::var("SPRAWL_FIXTURES").ok();
    // Fixtures are built fresh on every start, at noon, standing still: the
    // same pictures every time, lit the same way.
    let (mut world, sim_time) = if fixtures.is_some() { (World::new(), sprawl::fixtures::NOON) } else { load_world(&db) };
    if let Some(dir) = &fixtures {
        sprawl::fixtures::build(&mut world, Path::new(dir));
    } else {
        if world.objects.is_empty() {
            world.terrain_seed = new_seed();
        }
        island(&mut world);
        if !world.objects.is_empty() {
            world.restore();
            println!("loaded {} objects from db", world.objects.len());
        }
    }
    let speed = if fixtures.is_some() { 0 } else { 1 };
    let fresh_db = db_path.clone();
    let fresh = Box::new(move || {
        persistence::Db::open(&fresh_db).clear();
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
            persist(&mut game.world, &mut db, game.now);
            last_persist = Instant::now();
        }
    }
}

fn inspect(game: &mut Game, query: Debug) -> String {
    let (world, now) = (&mut game.world, game.now);
    let v = match query {
        Debug::Lot(id) => world.inspect_lot(id, now),
        Debug::Town => sprawl::economy::town(world, now),
        Debug::Sea => sprawl::haul::inspect(world, now),
        Debug::Map { x, y, r } => sprawl::fixtures::draw(world, x, y, r).into(),
    };
    serde_json::to_string_pretty(&v).unwrap_or_default()
}

fn load_world(db: &persistence::Db) -> (World, GameTime) {
    let (entries, meta) = db.load();
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
        if !meta.missions.is_empty() {
            world.missions.list = meta.missions;
        }
        world.market = meta.market;
        world
    };
    // SPRAWL_ALL: a bottomless treasury, to test any building.
    if std::env::var("SPRAWL_ALL").is_ok() {
        world.treasury = 1_000_000.0;
    }
    (world, sim_time)
}

/// The objects changed since the last save, and the rest of the world as
/// it stands, saved even when no object changed: a paused town's coins
/// and clock are worth keeping too.
fn persist(world: &mut World, db: &mut persistence::Db, sim_time: GameTime) {
    let (changed, removed) = world.objects.drain_persist_dirty();
    let changed: Vec<_> = changed.iter().filter_map(|&id| world.objects.get(id)).filter(|e| persistence::kept(e)).collect();
    let meta = persistence::Meta {
        next_id: world.objects.next_id(),
        terrain_seed: world.terrain_seed,
        sim_time,
        gdp: world.gdp,
        treasury: world.treasury,
        missions: world.missions.list.clone(),
        market: world.market.clone(),
    };
    db.save(&changed, &removed, &meta);
    if !changed.is_empty() || !removed.is_empty() {
        println!("persisted {} changed, {} removed", changed.len(), removed.len());
    }
}
