//! A replay played to a moment, and what every car there is doing, and why
//! (`sprawl::replay`).
//!
//! cargo run --bin replay -- <replay.json> [--to m:ss | --flag n] [--at x,y[,r]] [--car id]
//!
//! It says whether the replay still plays as it was played, and where it
//! first went another way; what went wrong as it played (`Watch`); then at
//! the moment (the end, a time, or the replay's nth flag) the cars round a
//! tile, or all of them: where, how fast, and what each slows or stops
//! for. `--car` follows one car up to then: each time what it slowed for
//! changed.

use sprawl::car::Cause;
use sprawl::engine::GameTime;
use sprawl::game::Game;
use sprawl::protocol::{DAY_MS, EntityId, GameObject};
use sprawl::replay::{Playback, Replay, Session, Watch, clock};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(path) = args.first() else {
        eprintln!("cargo run --bin replay -- <replay.json> [--to m:ss | --flag n] [--at x,y[,r]] [--car id]");
        std::process::exit(2);
    };
    let opt = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let replay: Replay = serde_json::from_str(&std::fs::read_to_string(path).expect("a replay")).expect("a replay");

    println!("{} played on {}; this is {}", replay.level, or(&replay.commit), or(&head()));
    println!("{} inputs, to {}", replay.inputs.len(), clock(Session::end(&replay)));
    for (i, f) in replay.flags.iter().enumerate() {
        println!("flag {}: {} at {} {}", i + 1, clock(f.at), f.tile.map_or("-".into(), |[x, y]| format!("{x},{y}")), f.note);
    }
    let until = if let Some(n) = opt("--flag") {
        replay.flags.get(n.parse::<usize>().expect("a flag's number") - 1).expect("no such flag").at
    } else if let Some(t) = opt("--to") {
        let (m, s) = t.split_once(':').unwrap_or(("0", &t));
        DAY_MS as GameTime / 2 + (m.parse::<f64>().unwrap() * 60_000.0 + s.parse::<f64>().unwrap() * 1000.0) as GameTime
    } else {
        Session::end(&replay)
    };
    let at = opt("--at").map(|a| a.split(',').map(|n| n.parse::<i32>().unwrap()).collect::<Vec<_>>());
    let car: Option<EntityId> = opt("--car").map(|c| c.parse().unwrap());

    let mut play = Playback::new(&replay);
    let mut watch = Watch::default();
    let mut diverged = false;
    let mut was = None;
    while play.session.game.now < until {
        if let Err(d) = play.step()
            && !diverged
        {
            diverged = true;
            println!("went another way than it was played at {}: from here it is today's game", clock(d.at));
        }
        for w in watch.look(&play.session.game) {
            println!("wrong: {w}");
        }
        if let Some(c) = car {
            let now = why(&play.session.game, c);
            if now != was {
                println!("{} car {c}: {}", clock(play.session.game.now), now.clone().unwrap_or_else(|| "free".into()));
                was = now;
            }
        }
    }
    if !diverged {
        println!("played as it was played, to {}", clock(play.session.game.now));
    }
    let s = &play.session;
    let state = s.level.state(&s.game);
    println!("\n{} at {}: {:?} {}", s.level.name, clock(s.game.now), state.phase, state.message);
    let near = |p: Option<sprawl::protocol::GridCoord>| match (&at, p) {
        (None, _) => true,
        (Some(a), Some(p)) => (p.x - a[0]).abs().max((p.y - a[1]).abs()) <= *a.get(2).unwrap_or(&3),
        _ => false,
    };
    let mut cars: Vec<(EntityId, String)> = s
        .game
        .world
        .objects
        .iter()
        .filter_map(|e| match &e.object {
            GameObject::Car(c) => c.trip.as_ref().map(|t| (e.id, t)),
            _ => None,
        })
        .filter(|(_, t)| near(s.game.world.objects.get(t.route[t.route_index]).and_then(|e| e.position)))
        .map(|(id, t)| {
            let (_, v) = sprawl::car::physics::catch_up(t.progress, t.speed, t.acceleration, (s.game.now - t.updated_at) as f64 / 1000.0);
            let at = |n: EntityId| s.game.world.objects.get(n).and_then(|e| e.position).map_or("?".into(), |p| format!("{},{}", p.x, p.y));
            let tile = format!("{} {} → {}", t.route[t.route_index], at(t.route[t.route_index - 1]), at(t.route[t.route_index]));
            let lane = t.lanes.get(t.route_index).copied().unwrap_or(0);
            (id, format!("car {id} {tile} lane {lane} v {v:.2} a {:.2}: {}", t.acceleration, why(&s.game, id).unwrap_or_else(|| "free".into())))
        })
        .collect();
    cars.sort();
    for (_, line) in cars {
        println!("{line}");
    }
    // Where the followed car goes from here.
    if let Some(GameObject::Car(c)) = car.and_then(|c| s.game.world.objects.get(c)).map(|e| &e.object)
        && let Some(t) = c.trip.as_ref()
    {
        let at = |n: EntityId| s.game.world.objects.get(n).and_then(|e| e.position).map_or("?".into(), |p| format!("{},{}", p.x, p.y));
        let ahead: Vec<String> = (t.route_index..t.route.len()).take(8).map(|k| format!("{} (lane {})", at(t.route[k]), t.lanes[k])).collect();
        println!("car {} goes on to {}", car.unwrap(), ahead.join(", "));
    }
}

/// What a car slows or stops for, said.
fn why(game: &Game, car: EntityId) -> Option<String> {
    let &(cause, accel) = game.world.why.get(&car)?;
    let pos = |id: EntityId| game.world.objects.get(id).and_then(|e| e.position).map_or("?".into(), |p| format!("{},{}", p.x, p.y));
    let what = match cause {
        Cause::Ahead(o) => format!("behind car {o}"),
        Cause::Merging(o) => format!("car {o} merging in ahead"),
        Cause::LettingIn(o) => format!("letting car {o} in"),
        Cause::Junction(j) => {
            let (through, waiting) = game.intersections.who(j);
            format!("no passage at {} (through {through:?}, waiting {waiting:?})", pos(j))
        }
        Cause::Turn(o) => format!("car {o} turning across"),
        Cause::GettingIn(o) => format!("getting into the other lane, car {o} in the way"),
        c => format!("{c:?}"),
    };
    Some(format!("{what}, {accel:+.2}"))
}

fn head() -> String {
    std::process::Command::new("git").args(["rev-parse", "--short=12", "HEAD"]).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

fn or(s: &str) -> &str {
    if s.is_empty() { "?" } else { s }
}
