//! A mayor who plays the town by rule, to see how it keeps: every house
//! joined to the street nearest it, every building in hand placed where
//! it fits nearest the town, a road run out to its ground where none
//! does, the first card of every pick. What the town asks for, what it
//! makes, who waits and who leaves, printed as it goes.
//!
//! `cargo test -p sprawl bot -- --ignored --nocapture` (`SEED=7`,
//! `DAYS=6`).

use std::collections::{BTreeMap, HashMap, VecDeque};

use super::*;
use crate::game::Game;
use model::{Build, ClientMessage, Offer, Tool};

const ME: crate::game::ClientId = 1;
const N4: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

fn island(seed: u32) -> World {
    let mut world = World::new();
    world.map.terrain_seed = seed;
    world.map.terrain = land::terrain::generate(seed);
    world.map.deposits = land::terrain::deposits(seed, &world.map.terrain);
    world
}

fn at(x: i32, y: i32) -> GridCoord {
    GridCoord { x, y }
}

fn step(game: &mut Game, from: GridCoord, to: GridCoord) {
    game.command(ME, ClientMessage::Build(Build { tool: Tool::Street, from, to, up: None, sides: None, road: false }));
}

/// The shortest way over open land from the town's streets to a tile
/// the goal takes, at most so long: the road tile it leaves from first.
fn way(map: &Map, starts: &[GridCoord], goal: impl Fn(GridCoord) -> bool, open: impl Fn(GridCoord) -> bool, most: usize) -> Option<Vec<GridCoord>> {
    let mut back: HashMap<(i32, i32), (i32, i32)> = HashMap::new();
    let mut q: VecDeque<(GridCoord, usize)> = starts.iter().map(|&s| (s, 0)).collect();
    for s in starts {
        back.insert((s.x, s.y), (s.x, s.y));
    }
    while let Some((p, n)) = q.pop_front() {
        if n > 0 && goal(p) {
            let mut path = vec![p];
            let mut c = (p.x, p.y);
            while back[&c] != c {
                c = back[&c];
                path.push(at(c.0, c.1));
            }
            path.reverse();
            return Some(path);
        }
        if n >= most {
            continue;
        }
        for (dx, dy) in N4 {
            let t = at(p.x + dx, p.y + dy);
            if back.contains_key(&(t.x, t.y)) || !(open(t) || goal(t)) {
                continue;
            }
            back.insert((t.x, t.y), (p.x, p.y));
            q.push_back((t, n + 1));
        }
    }
    let _ = map;
    None
}

fn road_tiles(map: &Map) -> Vec<GridCoord> {
    map.roads.keys().map(|&(x, y)| at(x, y)).collect()
}

/// The town's streets, grown a tile at a time as a grid of blocks round
/// where it began, nearest first, while road is left over for drives.
fn grow_grid(game: &mut Game) {
    let Some(c) = game.world.town.start else { return };
    for _ in 0..2 {
        let map = &game.world.map;
        if game.world.town.roads(map) < 12 {
            return;
        }
        let on_grid = |t: GridCoord| (t.x - c.x).rem_euclid(BLOCK) == 0 || (t.y - c.y).rem_euclid(BLOCK) == 0;
        let mut best: Option<(i32, GridCoord, GridCoord)> = None;
        for (&(x, y), _) in map.roads.iter() {
            let r = at(x, y);
            if !on_grid(r) {
                continue;
            }
            for (dx, dy) in N4 {
                let t = at(x + dx, y + dy);
                // Along a grid line, never off it sideways.
                let along = if dx != 0 { (t.y - c.y).rem_euclid(BLOCK) == 0 } else { (t.x - c.x).rem_euclid(BLOCK) == 0 };
                if !along || !map.is_buildable(t) {
                    continue;
                }
                let d = (t.x - c.x).abs() + (t.y - c.y).abs();
                if best.is_none_or(|b| (d, t.x, t.y) < (b.0, b.1.x, b.1.y)) {
                    best = Some((d, t, r));
                }
            }
        }
        let Some((_, t, r)) = best else { return };
        step(game, r, t);
        if game.world.map.road_node_at(t).is_none() {
            return;
        }
    }
}

const BLOCK: i32 = 5;

/// Every house with no street, joined to the nearest: a short drive.
fn join_houses(game: &mut Game) {
    let houses: Vec<(EntityId, GridCoord)> = of_kind(&game.world.map, BuildingKind::House).into_iter().filter(|&(id, _)| game.world.map.street_of(id).is_none()).collect();
    for (_, h) in houses {
        let map = &game.world.map;
        let roads = road_tiles(map);
        // A drive runs alone, never alongside a street: no strips of road.
        let open = |t: GridCoord| map.is_buildable(t) && N4.iter().filter(|(dx, dy)| map.roads.contains_key(&(t.x + dx, t.y + dy))).count() <= 1;
        let Some(path) = way(map, &roads, |t| t == h, open, 6) else { continue };
        for w in path.windows(2) {
            step(game, w[0], w[1]);
        }
    }
}

/// Where a kind's ground is: a tile it would stand by.
fn ground_near(map: &Map, kind: BuildingKind, t: GridCoord) -> bool {
    use model::blueprint::Ground;
    let near = |r: i32, f: &dyn Fn(GridCoord) -> bool| (-r..=r).any(|dx| (-r..=r).any(|dy| f(at(t.x + dx, t.y + dy))));
    let terrain = |p: GridCoord| map.terrain.get(&(p.x, p.y)).copied();
    match model::blueprint::blueprint(kind).ground {
        Ground::Forest => (-4..=4).flat_map(|dx| (-4..=4).map(move |dy| (dx, dy))).filter(|&(dx, dy)| terrain(at(t.x + dx, t.y + dy)) == Some(land::TerrainType::Forest)).count() >= 18,
        Ground::Shore => near(2, &|p| matches!(terrain(p), Some(land::TerrainType::Sea | land::TerrainType::Water))),
        Ground::Clay => near(1, &|p| map.deposits.get(&(p.x, p.y)) == Some(&land::Deposit::Clay)),
        Ground::Beach => near(1, &|p| terrain(p) == Some(land::TerrainType::Beach)),
        _ => true,
    }
}

/// Each building in hand, placed where it fits nearest the town's middle,
/// a shop nearest its houses; where it fits nowhere, a street run out to
/// its ground.
fn place_hand(game: &mut Game, tried: &mut BTreeMap<BuildingKind, u32>) {
    let hand: Vec<BuildingKind> = game.world.town.hand.iter().filter(|(_, n)| **n > 0).map(|(k, _)| *k).collect();
    for kind in hand {
        let map = &game.world.map;
        let Some(start) = game.world.town.start else { return };
        let houses: Vec<GridCoord> = of_kind(map, BuildingKind::House).into_iter().map(|(_, p)| p).collect();
        // A shop by the house furthest from any shop: the first, by the
        // houses' middle.
        let shops: Vec<GridCoord> = of_kind(map, BuildingKind::Shop).into_iter().map(|(_, p)| p).collect();
        let far = |p: &GridCoord| shops.iter().map(|s| (s.x - p.x).abs() + (s.y - p.y).abs()).min().unwrap_or(0);
        let mid = if kind == BuildingKind::Shop && !houses.is_empty() {
            match houses.iter().max_by_key(|p| far(p)).filter(|_| !shops.is_empty()) {
                Some(&p) => p,
                None => at(houses.iter().map(|p| p.x).sum::<i32>() / houses.len() as i32, houses.iter().map(|p| p.y).sum::<i32>() / houses.len() as i32),
            }
        } else {
            start
        };
        let mut best: Option<(i32, GridCoord, u8)> = None;
        for r in 0i32..30 {
            for dx in -r..=r {
                for dy in -r..=r {
                    if dx.abs().max(dy.abs()) != r {
                        continue;
                    }
                    let t = at(mid.x + dx, mid.y + dy);
                    if let Some(f) = map.facing_for(kind, t) {
                        let d = dx.abs() + dy.abs();
                        if best.is_none_or(|b| d < b.0) {
                            best = Some((d, t, f));
                        }
                    }
                }
            }
            if best.is_some() {
                break;
            }
        }
        if let Some((_, t, f)) = best {
            game.command(ME, ClientMessage::Place { kind, at: t, facing: Some(f) });
            println!("  placed {kind:?} at {},{}", t.x, t.y);
            continue;
        }
        let n = tried.entry(kind).or_default();
        if *n >= 4 {
            continue;
        }
        *n += 1;
        let roads = road_tiles(map);
        let open = |t: GridCoord| map.is_buildable(t);
        if let Some(path) = way(map, &roads, |t| map.is_buildable(t) && ground_near(map, kind, t), open, 30) {
            println!("  a street out for the {kind:?}: {} tiles to {},{}", path.len() - 1, path.last().unwrap().x, path.last().unwrap().y);
            // Two tiles on past the goal, the way it ran, for a front to face it.
            let mut path = path;
            let (a, b) = (path[path.len() - 2], path[path.len() - 1]);
            for k in 1..=2 {
                let t = at(b.x + (b.x - a.x) * k, b.y + (b.y - a.y) * k);
                if !map.is_buildable(t) {
                    break;
                }
                path.push(t);
            }
            for w in path.windows(2) {
                step(game, w[0], w[1]);
            }
        } else {
            println!("  nowhere for the {kind:?}");
        }
    }
}

fn pick(game: &mut Game) {
    let offer = game.world.town.offer.clone();
    if offer.is_empty() {
        return;
    }
    // Road, when the grid is running out of it; else a building the town
    // is short of; else whatever is first.
    let road = offer.iter().position(|o| matches!(o, Offer::Roads(_))).filter(|_| game.world.town.roads(&game.world.map) < 25);
    let n = road.or_else(|| offer.iter().position(|o| matches!(o, Offer::Building(..)))).or_else(|| offer.iter().position(|o| matches!(o, Offer::Roads(_)))).unwrap_or(0);
    let mut c = picks::candidates(&game.world, game.now);
    c.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut why: BTreeMap<String, u32> = BTreeMap::new();
    for (id, _) in of_kind(&game.world.map, BuildingKind::House) {
        for w in game.world.map.building(id).and_then(|b| b.home.as_ref()).map_or(vec![], |h| h.wants.clone()) {
            *why.entry(format!("{:?}->{:?}", w.good, picks::short_of(&game.world, id, w.good))).or_default() += 1;
        }
    }
    println!("  pick {:?} of {:?}; top {:?}; waits {:?}", offer[n], offer, &c[..3.min(c.len())], why);
    game.command(ME, ClientMessage::Pick(n as u8));
}

/// How long families' shopping takes, door to door, and how much of it at
/// the counter.
#[derive(Default)]
struct Trips {
    out: HashMap<EntityId, GameTime>,
    took: Vec<GameTime>,
    counter: HashMap<EntityId, GameTime>,
    waited: Vec<GameTime>,
}

impl Trips {
    fn census(world: &World) -> String {
        let mut n: BTreeMap<&str, u32> = BTreeMap::new();
        for e in world.map.objects.iter() {
            let GameObject::Car(ref c) = e.object else { continue };
            if c.role != model::CarRole::Private {
                continue;
            }
            let driving = c.trip.is_some();
            let k = match (world.town.errands.get(&e.id), driving) {
                (None, false) => "home",
                (None, true) => "?driving",
                (Some(errands::Errand::Work { at: Some(_), .. }), _) => "working",
                (Some(errands::Errand::Work { .. }), true) => "to work",
                (Some(errands::Errand::Work { .. }), false) => "work?",
                (Some(errands::Errand::Fetch { .. }), true) => "to shop",
                (Some(errands::Errand::Fetch { .. }), false) => "at shop",
                (Some(errands::Errand::Home { .. }), true) => "homeward",
                (Some(errands::Errand::Home { .. }), false) => "home?",
            };
            *n.entry(k).or_default() += 1;
        }
        n.iter().map(|(k, v)| format!("{k} {v}")).collect::<Vec<_>>().join(", ")
    }

    /// Every vehicle standing still on its way, by why and where.
    fn stuck(world: &World, now: GameTime) -> String {
        let mut n: BTreeMap<String, u32> = BTreeMap::new();
        let mut late = Vec::new();
        for e in world.map.objects.iter() {
            let GameObject::Car(ref c) = e.object else { continue };
            let Some(t) = &c.trip else { continue };
            late.push(now.saturating_sub(t.eta) / 1000);
            let (p, v) = t.at(now);
            if v > 0.05 {
                continue;
            }
            let i = t.along.iter().position(|&a| a >= p).unwrap_or(t.along.len()).min(t.route_positions.len().saturating_sub(1));
            let q = t.route_positions.get(i).map_or((0, 0), |q| (q[0].floor() as i32, q[1].floor() as i32));
            let why = match t.why {
                Some((model::Cause::Junction(j), _)) if j >> 63 == 1 => {
                    let n = t.route.len();
                    let k = if t.route_index <= t.from_lot + 1 { "Out" } else if t.route_index + 1 >= n - t.to_lot { "In" } else { "By" };
                    let (through, waiting) = world.streets.who(j);
                    format!("Driveway{k}{}{}", if through.is_empty() { "-nobody-through" } else { "" }, if waiting.len() <= 1 { "-alone" } else { "" })
                }
                Some((ref w, _)) => format!("{w:?}").split('(').next().unwrap_or("").to_string(),
                None => "-".into(),
            };
            *n.entry(format!("{:?} {why} @{},{}", c.role, q.0, q.1)).or_default() += 1;
            if std::env::var("WHO").is_ok() {
                let st = t.stood.map(|s| now.saturating_sub(s) / 1000);
                println!("      #{} {:?} {:?} @{},{} for {:?}s to #{} {:?}", e.id, c.role, t.why.as_ref().map(|w| &w.0), q.0, q.1, st, t.destination, world.town.errands.get(&e.id).map(|e| match e { errands::Errand::Fetch { .. } => "fetch", errands::Errand::Home { .. } => "home", errands::Errand::Work { .. } => "work" }));
            }
        }
        late.sort();
        let mut v: Vec<(String, u32)> = n.into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1));
        format!("late median {}s most {}s; stopped: {}", late.get(late.len() / 2).unwrap_or(&0), late.last().unwrap_or(&0), v.iter().take(8).map(|(k, n)| format!("{n}x {k}")).collect::<Vec<_>>().join("; "))
    }

    fn watch(&mut self, world: &World, now: GameTime) {
        for e in world.map.objects.iter() {
            let GameObject::Car(ref c) = e.object else { continue };
            if c.role != model::CarRole::Private {
                continue;
            }
            match world.town.errands.get(&e.id) {
                Some(errands::Errand::Fetch { at, .. }) => {
                    self.out.entry(e.id).or_insert(now);
                    if let Some(a) = at {
                        self.counter.insert(e.id, now - a);
                    }
                }
                Some(errands::Errand::Home { .. }) => {}
                _ => {
                    if let Some(t) = self.out.remove(&e.id) {
                        self.took.push(now - t);
                    }
                    if let Some(w) = self.counter.remove(&e.id) {
                        self.waited.push(w);
                    }
                }
            }
        }
    }

    fn say(&mut self) -> String {
        let mean = |v: &[GameTime]| if v.is_empty() { 0 } else { v.iter().sum::<GameTime>() / v.len() as GameTime / 1000 };
        let max = |v: &[GameTime]| v.iter().max().copied().unwrap_or(0) / 1000;
        let s = format!("shopping {} trips, {}s mean {}s most, at the counter {}s mean {}s most", self.took.len(), mean(&self.took), max(&self.took), mean(&self.waited), max(&self.waited));
        self.took.clear();
        self.waited.clear();
        s
    }
}

fn report(game: &Game) {
    let world = &game.world;
    let map = &world.map;
    let now = game.now;
    let mut levels = [0u32; 5];
    let mut waiting = 0;
    let mut oldest: GameTime = 0;
    for (id, _) in of_kind(map, BuildingKind::House) {
        let Some(h) = map.building(id).and_then(|b| b.home.as_ref()) else { continue };
        levels[h.level as usize] += 1;
        waiting += h.wants.len();
        oldest = oldest.max(h.wants.iter().map(|w| now.saturating_sub(w.since)).max().unwrap_or(0));
    }
    let day = now as f64 / DAY_MS as f64;
    let cut: Vec<String> = of_kind(map, BuildingKind::House).into_iter().filter(|&(id, _)| map.street_of(id).is_none()).map(|(_, p)| format!("{},{}", p.x, p.y)).collect();
    if !cut.is_empty() {
        println!("    houses with no street: {}", cut.join(" "));
    }
    println!(
        "day {day:.2} people {} houses {:?} left {} | wants {waiting} oldest {}s | road {} | hand {:?}",
        people(map), &levels[1..], world.town.left, oldest / 1000, world.town.roads(map),
        world.town.hand.iter().filter(|(_, n)| **n > 0).collect::<Vec<_>>()
    );
    for e in map.objects.iter() {
        let GameObject::Building(ref b) = e.object else { continue };
        if b.kind == BuildingKind::House {
            continue;
        }
        let stocks: Vec<String> = b.stocks.iter().map(|(g, s)| format!("{:?} {:.0}/{:.0}", g, s.level, s.cap)).collect();
        let row = model::blueprint::blueprint(b.kind);
        let lorries = map.objects.fleet(e.id).filter(|&c| world.town.errands.contains_key(&c)).count();
        let reached = of_kind(map, BuildingKind::Shop).into_iter().filter(|&(s, _)| reaches(map, s, e.id)).count();
        let lorries_at = world.town.errands.iter().filter(|(_, er)| matches!(er, errands::Errand::Fetch { to, .. } if *to == e.id)).count();
        if b.kind != BuildingKind::Shop {
            print!("    [{} shops reach it, {} lorries for it]", reached, lorries_at);
        }
        println!("    {:?}#{} crew {}/{} here {} out {} {}{}", b.kind, e.id, b.crew.len(), row.seats, b.present, lorries, stocks.join(", "), if map.street_of(e.id).is_none() { " NO STREET" } else { "" });
    }
}

/// What each family wanted, and who was out for it, the turn before it
/// left: said with what every shop had of it.
fn wants_of(world: &World) -> BTreeMap<EntityId, (Vec<model::Want>, String)> {
    of_kind(&world.map, BuildingKind::House).into_iter().filter_map(|(id, _)| {
        let cars: Vec<String> = world.map.objects.fleet(id).map(|c| {
            let car = world.map.car(c);
            format!("car {c}: {:?} trip {} claim {:?} rest {:?} street {:?}", world.town.errands.get(&c).map(|e| match e { errands::Errand::Fetch { to, .. } => format!("fetch {to}"), errands::Errand::Home { .. } => "home".into(), errands::Errand::Work { job, at } => format!("work {job} {}", at.is_some()) }), car.is_some_and(|c| c.trip.is_some()), world.map.claims.get(&c), world.town.rest.get(&c), world.map.street_of(id))
        }).collect();
        Some((id, (world.map.building(id)?.home.as_ref()?.wants.clone(), cars.join("; "))))
    }).collect()
}

#[test]
#[ignore]
fn bot() {
    let seed = std::env::var("SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(7);
    let days: f64 = std::env::var("DAYS").ok().and_then(|s| s.parse().ok()).unwrap_or(6.0);
    let mut game = Game::new(island(seed), 0, 1, Box::new(World::new));
    game.connect(ME, 1);
    let mut tried = BTreeMap::new();
    let mut last_report = 0;
    let mut before = wants_of(&game.world);
    let mut trips = Trips::default();
    let mut follow: Option<EntityId> = None;
    let end = (days * DAY_MS as f64) as GameTime;
    while game.now < end {
        pick(&mut game);
        grow_grid(&mut game);
        join_houses(&mut game);
        place_hand(&mut game, &mut tried);
        game.take_outbox();
        let to = game.now + 3_000;
        if std::env::var("OVERLAP").is_ok() {
            while game.now < to {
                let (was, step) = (game.now, game.now + 200);
                game.run_to(step);
                if game.now == was {
                    break;
                }
                overlaps(&game.world, game.now);
            }
        }
        game.run_to(to);
        for n in std::mem::take(&mut game.world.news) {
            let t = game.now as f64 / DAY_MS as f64;
            println!("  {t:.2} {} ({})", n.text, n.sub);
            if n.text.contains("left") || n.text.contains("moved down") {
                if let Some((w, cars)) = before.get(&n.at) {
                    println!("      {cars}");
                    for w in w {
                        let shelves: Vec<String> = of_kind(&game.world.map, BuildingKind::Shop).into_iter().map(|(s, _)| format!("shop#{s} {:.0}", stock(&game.world.map, s, w.good))).collect();
                        println!("      wanted {:?} for {}s, by {:?}; {}", w.good, (game.now.saturating_sub(w.since)) / 1000, w.by.map(|c| (c, game.world.town.errands.get(&c).cloned())), shelves.join(" "));
                    }
                }
            }
        }
        before = wants_of(&game.world);
        trips.watch(&game.world, game.now);
        if follow.is_none() && std::env::var("FOLLOW").is_ok() && game.now as f64 > DAY_MS as f64 * std::env::var("FOLLOW").unwrap().parse::<f64>().unwrap_or(2.5) {
            follow = of_kind(&game.world.map, BuildingKind::House).into_iter().filter_map(|(h, _)| game.world.map.objects.fleet(h).next()).last();
            println!("following {follow:?}");
        }
        if let Some(follow) = follow {
            let w = &game.world;
            let er = w.town.errands.get(&follow).map(|e| match e { errands::Errand::Fetch { to, at, .. } => format!("fetch {to} at {:?}", at.map(|a| (game.now - a) / 1000)), errands::Errand::Home { .. } => "home".into(), errands::Errand::Work { job, at } => format!("work {job} {:?}", at.is_some()) });
            let tr = w.map.car(follow).and_then(|c| c.trip.as_ref()).map(|t| { let (p, v) = t.at(game.now); format!("to {} {:.1}/{:.1} v {v:.2} why {:?} late {}", t.destination, p, t.along.last().unwrap_or(&0.0), t.why.as_ref().map(|w| &w.0), game.now.saturating_sub(t.eta) / 1000) });
            let owner = w.map.car(follow).map(|c| c.owner);
            let wants = owner.and_then(|o| w.map.building(o)).and_then(|b| b.home.as_ref()).map(|h| h.wants.iter().map(|x| format!("{:?} {}s", x.good, game.now.saturating_sub(x.since) / 1000)).collect::<Vec<_>>());
            println!("      F {:.3} {:?} {:?} wants {:?}", game.now as f64 / DAY_MS as f64, er, tr, wants);
        }
        if game.now >= last_report + DAY_MS as GameTime / 4 {
            last_report = game.now;
            report(&game);
            println!("    {}", trips.say());
            println!("    cars: {}", Trips::census(&game.world));
            println!("    {}", Trips::stuck(&game.world, game.now));
            if std::env::var("DRAW").is_ok() {
                draw(&game.world.map, game.world.town.start.unwrap(), 16);
            }
        }
    }
}

#[test]
#[ignore]
fn bot_join() {
    let mut game = Game::new(island(7), 0, 1, Box::new(World::new));
    game.connect(ME, 1);
    let map = &game.world.map;
    let roads = road_tiles(map);
    println!("roads {:?}", roads.iter().map(|p| (p.x, p.y)).collect::<Vec<_>>());
    for (id, h) in of_kind(map, BuildingKind::House) {
        let b = map.building(id).unwrap();
        let path = way(map, &roads, |t| t == h, |t| map.is_buildable(t), 10);
        println!("house {id} at {:?} facing {} path {:?}", (h.x, h.y), b.facing, path.map(|p| p.iter().map(|p| (p.x, p.y)).collect::<Vec<_>>()));
    }
    let houses: Vec<(EntityId, GridCoord)> = of_kind(&game.world.map, BuildingKind::House).into_iter().collect();
    join_houses(&mut game);
    for (id, _) in houses {
        println!("house {id} street {:?}", game.world.map.street_of(id));
    }
}

/// The town round a tile, a character a tile: streets, buildings by
/// their kind's first letter, water.
pub(super) fn draw(map: &Map, c: GridCoord, r: i32) {
    for y in c.y - r..=c.y + r {
        let row: String = (c.x - r..=c.x + r).map(|x| {
            if let Some(&id) = map.occupied.get(&(x, y)) {
                let k = map.building(id).map_or('?', |b| format!("{:?}", b.kind).chars().next().unwrap());
                return if map.street_of(id).is_none() { k.to_ascii_lowercase() } else { k };
            }
            if map.roads.contains_key(&(x, y)) {
                return '#';
            }
            match map.terrain.get(&(x, y)) {
                Some(land::TerrainType::Sea | land::TerrainType::Water) => '~',
                Some(land::TerrainType::Forest) => 't',
                Some(land::TerrainType::Beach) => ',',
                _ => '.',
            }
        }).collect();
        println!("    {y:4} {row}");
    }
}

#[test]
#[ignore]
fn bot_look() {
    let game = Game::new(island(std::env::var("SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(7)), 0, 1, Box::new(World::new));
    let c = game.world.town.start.unwrap();
    println!("start {c:?}");
    draw(&game.world.map, c, 40);
}

/// Every two vehicles whose bodies overlap as drawn, said once a pair.
fn overlaps(world: &World, now: GameTime) {
    use traffic::car::{nose, tail};
    let mut bodies = Vec::new();
    for e in world.map.objects.iter() {
        let GameObject::Car(ref c) = e.object else { continue };
        let Some(t) = &c.trip else { continue };
        let (p, v) = t.at(now);
        let Some((m, h)) = drawn(t, p) else { continue };
        let ends = ([m[0] - h[0] * tail(c.role), m[1] - h[1] * tail(c.role)], [m[0] + h[0] * nose(c.role), m[1] + h[1] * nose(c.role)]);
        let n = t.route.len();
        let turning = if t.route_index <= t.from_lot { "out" } else if t.route_index >= n - t.to_lot { "in" } else { "by" };
        let edge = (t.route[t.route_index - 1], t.route[t.route_index]);
        // Half its width, as the client draws it (`roadGeometry.ts`).
        let half = if c.role == model::CarRole::Private { 0.075 } else { 0.085 };
        bodies.push((e.id, ends, turning, v, t.why.map(|w| w.0), edge, t.ghost.is_some(), t.route.get(t.route_index + 1).copied(), half));
    }
    // How deep two bodies are in each other, as boxes: the least overlap
    // of their outlines across any of their sides; none if apart.
    type Body = (EntityId, ([f64; 2], [f64; 2]), &'static str, f64, Option<model::Cause>, (EntityId, EntityId), bool, Option<EntityId>, f64);
    let corners = |b: &Body| {
        let ((p, q), w) = (b.1, b.8);
        let (dx, dy) = (q[0] - p[0], q[1] - p[1]);
        let l = dx.hypot(dy).max(1e-9);
        let (nx, ny) = (-dy / l * w, dx / l * w);
        [[p[0] + nx, p[1] + ny], [q[0] + nx, q[1] + ny], [q[0] - nx, q[1] - ny], [p[0] - nx, p[1] - ny]]
    };
    let into = |a: &Body, b: &Body| {
        let (ca, cb) = (corners(a), corners(b));
        let mut depth = f64::MAX;
        for c in [&ca, &cb] {
            for k in 0..2 {
                let (ex, ey) = (c[k + 1][0] - c[k][0], c[k + 1][1] - c[k][1]);
                let l = ex.hypot(ey).max(1e-9);
                let along = |p: &[f64; 2]| (p[0] * ex + p[1] * ey) / l;
                let (a0, a1) = ca.iter().map(along).fold((f64::MAX, f64::MIN), |(lo, hi), x| (lo.min(x), hi.max(x)));
                let (b0, b1) = cb.iter().map(along).fold((f64::MAX, f64::MIN), |(lo, hi), x| (lo.min(x), hi.max(x)));
                depth = depth.min(a1.min(b1) - a0.max(b0));
            }
        }
        depth
    };
    static SAID: std::sync::Mutex<Vec<(EntityId, EntityId)>> = std::sync::Mutex::new(Vec::new());
    for i in 0..bodies.len() {
        for j in i + 1..bodies.len() {
            let (a, b) = (&bodies[i], &bodies[j]);
            let near = into(a, b);
            // Coming to one node from each other's way on: a bend's two
            // lanes, cut short as bodies are drawn round it.
            if a.5.1 == b.5.1 && a.7 == Some(b.5.0) && b.7 == Some(a.5.0) {
                continue;
            }
            if near > 0.02 {
                let mut said = SAID.lock().unwrap();
                if !said.contains(&(a.0, b.0)) {
                    said.push((a.0, b.0));
                    println!("{} {:.3} {} {} v{:.2} {:?} {:?} / {} {} v{:.2} {:?} {:?} at {:.1},{:.1} near {near:.2} next {:?} {:?} junction {}", if a.6 || b.6 { "GHOSTLAP" } else { "OVERLAP" }, now as f64 / DAY_MS as f64, a.0, a.2, a.3, a.4, a.5, b.0, b.2, b.3, b.4, b.5, a.1.1[0], a.1.1[1], a.7, b.7, world.map.is_intersection(a.5.1) || world.map.is_intersection(b.5.1));
                }
            }
        }
    }
}

/// Where a car on its trip is drawn `p` along it, and which way it faces:
/// on its lane, or on a parking move's curve.
fn drawn(trip: &model::Trip, p: f64) -> Option<([f64; 2], [f64; 2])> {
    let n = trip.route.len();
    if trip.route_positions.len() != n || trip.along.len() != n || n < 2 {
        return None;
    }
    let lane = map::bezier::offset_positions(&trip.route_positions, map::bezier::LANE_OFFSET);
    let at: Vec<[f64; 2]> = (0..n).map(|k| if k < trip.from_lot || k >= n - trip.to_lot { trip.route_positions[k] } else { lane[k] }).collect();
    let point = |p: f64| {
        let k = (1..n).find(|&k| trip.along[k] > p).unwrap_or(n - 1);
        let seg = trip.along[k] - trip.along[k - 1];
        let f = if seg > 0.0 { ((p - trip.along[k - 1]) / seg).clamp(0.0, 1.0) } else { 1.0 };
        let pts = match trip.manoeuvres.iter().find(|m| m.edge == k - 1) {
            Some(m) => m.points(),
            None => vec![at[k - 1], at[k]],
        };
        let mut along = vec![0.0];
        for w in pts.windows(2) {
            along.push(along.last().unwrap() + (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]));
        }
        let s = f * along.last().unwrap();
        let j = along.partition_point(|&d| d < s).clamp(1, pts.len() - 1);
        let u = if along[j] > along[j - 1] { (s - along[j - 1]) / (along[j] - along[j - 1]) } else { 1.0 };
        let (a, b) = (pts[j - 1], pts[j]);
        [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]
    };
    let (c, a, b) = (point(p), point(p - 0.02), point(p + 0.02));
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let m = dx.hypot(dy).max(1e-9);
    Some((c, [dx / m, dy / m]))
}
