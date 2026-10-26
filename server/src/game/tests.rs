/// Wakes one resident may take in a day; `a_town_thinks_within_budget`
/// prints what the towns take. With the overtake bug of 2026-09-04 put
/// back they took 146 and 231 in a day, and thousands once the storm has
/// grown. A change that legitimately moves the count moves this number
/// with it, on purpose.
pub(crate) const WAKE_BUDGET: u64 = 120;
use super::*;
use std::time::Instant;
use crate::protocol::{Build, BuildingKind, Good, GridCoord, Leg, TerrainType, Tool};

/// What a test's hand does: a step of road or the demolisher, or a
/// building placed whole round a tile, the first way it fits.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Do {
    Step(Tool, GridCoord, GridCoord),
    Place(BuildingKind, GridCoord),
    /// The building on a tile taken down whole.
    Raze(GridCoord),
    /// A package a letter wants, sent.
    Send(u64),
}
/// The hand's act done, as a player's command is; a building refused is
/// a test gone wrong.
pub(crate) fn does(game: &mut Game, d: Do) {
    let message = match d {
        Do::Step(tool, from, to) => ClientMessage::Build(Build { tool, from, to, up: None, sides: None, road: false }),
        Do::Place(kind, at) => ClientMessage::Place { kind, at, facing: None },
        Do::Raze(at) => ClientMessage::Raze { building: game.world.occupied[&(at.x, at.y)] },
        Do::Send(letter) => ClientMessage::Send { letter, packages: 1 },
    };
    game.command(PLAYER, message);
    if let Do::Place(kind, at) = d {
        assert!(game.world.occupied.contains_key(&(at.x, at.y)), "{kind:?} at {at:?} refused: {:?}", game.take_outbox());
    }
}

/// The one at the tests' game: client and owner both.
pub(crate) const PLAYER: ClientId = 0;

/// A world brought to life as the game brings one, its clock at nought,
/// and a player at it.
pub(crate) fn game(world: World) -> Game {
    let mut game = Game::new(world, 0, 1, Box::new(World::new));
    game.connect(PLAYER, PLAYER);
    game
}

pub(crate) fn at_of(world: &World, id: EntityId) -> Option<EntityId> {
    world.resident(id)?.at
}

pub(crate) fn doing(world: &World, id: EntityId) -> Option<crate::needs::Need> {
    world.resident(id)?.selected
}

/// Where the test street's harbour stands, at its east end.
pub(crate) const HARBOUR_X: i32 = 258;

/// One long street with room to build beside it, and at its east end
/// the coast and a harbour: the door everyone and everything comes in
/// by. Deep enough for a supermarket and its lot behind the street, and
/// a farm's track and fields beyond that; the sea is open to the south
/// of the harbour, and runs off the map.
pub(crate) fn street() -> World {
    let mut world = World::new();
    for y in -10..60 {
        for x in -4..300 {
            let sea = x >= HARBOUR_X - 2 && y >= 2;
            if sea || y < 14 {
                world.terrain.insert((x, y), if sea { TerrainType::Sea } else { TerrainType::Grass });
            }
        }
    }
    let street: Vec<GridCoord> = (-2..HARBOUR_X + 6).map(|x| GridCoord { x, y: 0 }).collect();
    world.place_road_path(&street);
    // A back street, and lanes between the two every forty tiles, so a
    // lorry turns round in a block, not at the end of the world.
    world.place_road_path(&(-2..HARBOUR_X + 6).map(|x| GridCoord { x, y: -9 }).collect::<Vec<_>>());
    for x in (-2..HARBOUR_X + 6).step_by(40) {
        world.place_road_path(&(-9..=0).map(|y| GridCoord { x, y }).collect::<Vec<_>>());
    }
    world.place_on_street(GridCoord { x: HARBOUR_X, y: 1 }, BuildingKind::Harbour).expect("the coast takes a harbour");
    world
}

pub(crate) fn harbour_of(world: &World) -> EntityId {
    *world.occupied.get(&(HARBOUR_X, 1)).expect("the street's harbour")
}

pub(crate) fn build(world: &mut World, x: i32, kind: BuildingKind) -> EntityId {
    world
        .place_on_street(GridCoord { x, y: 1 }, kind)
        .unwrap_or_else(|| panic!("the street should give a {kind:?} at x={x} its driveway"))
}

/// Where a car stands on the map, and how fast it goes along its route.
pub(crate) fn whereabouts(world: &World, car: EntityId, now: GameTime) -> Option<([f64; 2], f64, usize)> {
    let GameObject::Car(ref c) = world.objects.get(car)?.object else { return None };
    let t = c.trip.as_ref()?;
    let (p, v) = t.at(now);
    let mut s = 0.0;
    for k in 1..t.route.len() {
        let len = t.segment_lengths[k];
        if p <= s + len || k == t.route.len() - 1 {
            let f = ((p - s) / len).clamp(0.0, 1.0);
            let (a, b) = (t.route_positions[k - 1], t.route_positions[k]);
            return Some(([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], v, k));
        }
        s += len;
    }
    None
}
/// A car backing out of its drive waits for a gap in the street, backs
/// out at a walking pace, all but stops where it changes gear, and the
/// street waits for it once it has gone: whenever it sets out, with a
/// car coming either way, the two never meet.
#[test]
fn a_car_backs_out_into_a_gap_and_the_street_waits_for_it() {
    for (dest_x, from_x) in [(40, 2), (0, 30)] {
        for start in (0..14_000).step_by(400) {
            // Fifty tiles of street are all the two trips need.
            let mut world = World::meadow(-4..50, -4..12).street(-4..50);
            let home = build(&mut world, 10, BuildingKind::House);
            let from = build(&mut world, from_x, BuildingKind::House);
            let shop = build(&mut world, dest_x, BuildingKind::Shop);
            let mut game = game(world);
            let car = |world: &mut World, at: EntityId| {
                let c = world.insert_at(GameObject::Car(crate::protocol::Car::new(0, Default::default())), world.objects.get(at).unwrap().position);
                world.park_in_lot(at, c, 0);
                c
            };
            let (backer, through) = (car(&mut game.world, home), car(&mut game.world, from));
            let s = game.world.approach(from).unwrap();
            assert!(crate::car::spawn::start_trip(&mut game.world, &mut game.events, through, s, shop, 0, GameTime::MAX));
            let mut out = false;
            while game.now < 60_000 {
                if !out && game.now >= start {
                    let s = game.world.approach(home).unwrap();
                    out = crate::car::spawn::start_trip(&mut game.world, &mut game.events, backer, s, shop, game.now, GameTime::MAX);
                }
                game.step_to(game.now + 50);
                let (world, now) = (&game.world, game.now);
                let (a, b) = (whereabouts(world, backer, now), whereabouts(world, through, now));
                if let Some((_, v, k)) = a {
                    if k == 1 {
                        assert!(v <= crate::car::REVERSE_SPEED + 0.06, "backing at {v:.2} (start {start})");
                    }
                }
                if let (Some(a), Some(b)) = (a, b) {
                    let d = ((a.0[0] - b.0[0]).powi(2) + (a.0[1] - b.0[1]).powi(2)).sqrt();
                    assert!(a.2 > 2 || d > 0.45, "the backing car and the passing one met, {d:.2} apart at {now} (start {start}, from {from_x}): {a:?} {b:?}");
                }
            }
            assert!(whereabouts(&game.world, backer, game.now).is_none() && whereabouts(&game.world, through, game.now).is_none(), "both arrived (start {start}, from {from_x})");
        }
    }
}
/// The whole loop watched from above: people come over on the ferry,
/// drive to work in the morning, and are home again at night — and
/// nobody told them to; the shift did.
#[test]
fn residents_commute_and_come_home() {
    let mut world = street();
    let home = build(&mut world, 0, BuildingKind::House);
    let shop = build(&mut world, 20, BuildingKind::Shop);

    let mut game = game(world);
    let people = game.world.resident_ids();
    assert_eq!(people.len(), 2);

    let shift = crate::blueprint::blueprint(BuildingKind::Shop).taps
        .iter()
        .find(|t| t.need == crate::needs::Need::Work)
        .unwrap();
    let open = shift.curve.next_nonzero(0).unwrap();
    let close = shift.curve.next_zero(open);

    game.run_to(open + 60_000);
    for &id in &people {
        assert_eq!(at_of(&game.world, id), Some(shop), "at work once the shift is on");
    }

    game.run_to(close + 120_000);
    for &id in &people {
        assert_eq!(at_of(&game.world, id), Some(home), "home once the shift is over");
    }
}

/// Every wake, every arrival: the log the model in docs/residents.md is
/// held to. Two runs of the same town must write the same one — down to
/// the millisecond — or something is iterating a hash map.
pub(crate) type Move = (GameTime, EntityId, Option<EntityId>, Option<crate::needs::Need>);

pub(crate) fn arrival_log(days: u64) -> Vec<Move> {
    let mut world = street();
    build(&mut world, 0, BuildingKind::Apartment);
    build(&mut world, 6, BuildingKind::Apartment);
    build(&mut world, 30, BuildingKind::Shop);
    let office = build(&mut world, 60, BuildingKind::Factory);
    // Lunch: a shop beside the office, too far from home to staff.
    let lunch = build(&mut world, 64, BuildingKind::Shop);
    // Fuel, or every few days the town goes without.
    build(&mut world, 18, BuildingKind::GasStation);

    let mut game = game(world);
    // Fourteen households in the two blocks, and three desks over that
    // stay empty: nobody comes from beyond the town for a job.
    let people = game.world.resident_ids();
    assert_eq!(people.len(), 14);

    let mut log = Vec::new();
    let mut last: Vec<Option<EntityId>> = people.iter().map(|_| None).collect();
    let mut last_doing: Vec<(Option<EntityId>, Option<crate::needs::Need>)> = people.iter().map(|_| (None, None)).collect();
    while game.step_to(days * DAY_MS as u64) {
        let (world, now) = (&game.world, game.now);
        for (i, &id) in people.iter().enumerate() {
            let at = at_of(world, id);
            // `TRACE=1 cargo test the_same_town -- --nocapture` prints
            // the last day's log, one line a move or a change of mind,
            // to read by hand.
            if std::env::var("TRACE").is_ok() && now >= (days - 1) * DAY_MS as u64 && (at, doing(world, id)) != last_doing[i] {
                eprintln!("{i} {} {:?} {:?}", crate::card::hhmm(world.resident(id).unwrap().last_update), at.and_then(|a| world.building(a)).map(|b| b.kind), doing(world, id));
                last_doing[i] = (at, doing(world, id));
            }
            if at != last[i] {
                log.push((now, id, at, doing(world, id)));
                last[i] = at;
            }
        }
    }
    // Section 6, the demand side. Nobody here wants for anything, and
    // the office's books show what it received a day, over the settled
    // days, the second on: eleven people, nine hours, less the lunches —
    // and the lunch shop served them. A day's absences come in waves,
    // so one day alone swings by a third either way.
    let (world, now) = (&game.world, game.now);
    if days >= 3 {
        wants_nothing(world, now);
        let sold = |b: EntityId, need| world.books[&b].before(now).served.get(&need).copied().unwrap_or(0.0);
        let worked = |d: u64| world.books[&office].before(d * DAY_MS as u64).served.get(&crate::needs::Need::Work).copied().unwrap_or(0.0);
        let office = (2..=days).map(worked).sum::<f64>() / (days - 1) as f64;
        // Eleven at the office: fourteen people, two apartments of
        // seven, less the shop's two and the pump's one, nine hours
        // each, less the odd late morning, a lunch out, a dinner near
        // work, and the minute or two parking at the kerb.
        assert!((70.0..=99.0).contains(&office), "office received {office}h a day");
        // Lunches over a whole day: the shops have no depot here, so
        // by the third day their shelves have run down some.
        assert!(sold(lunch, crate::needs::Need::Eat) > 1.5, "lunch shop sold {}h", sold(lunch, crate::needs::Need::Eat));
    }
    log
}

/// Nobody wants for anything: everyone has a job, and whatever they
/// owe of a need of their own that runs down has somewhere to be met.
pub(crate) fn wants_nothing(world: &World, now: GameTime) {
    for e in world.objects.iter() {
        let GameObject::Resident(ref r) = e.object else { continue };
        let needs = crate::resident::needs(world, e.id, now);
        assert!(r.work.is_some(), "{needs:?}");
        let owed = |n: &&crate::card::NeedLine| r.buckets.iter().any(|b| b.need.drain() > 0.0 && b.need == n.need) && n.full < 1.0;
        assert!(needs.iter().filter(owed).all(|n| n.option.is_some()), "{needs:?}");
    }
}

#[test]
fn cars_stop_for_fuel_now_and_then() {
    let mut world = street();
    build(&mut world, 0, BuildingKind::Apartment);
    build(&mut world, 6, BuildingKind::Apartment);
    build(&mut world, 60, BuildingKind::Factory);
    build(&mut world, 40, BuildingKind::Shop);
    let station = build(&mut world, 30, BuildingKind::GasStation);

    let mut game = game(world);
    let people = game.world.resident_ids();

    let day = DAY_MS as u64;
    let mut stops = 0;
    let mut last: Vec<(Option<EntityId>, Option<crate::needs::Need>)> = people.iter().map(|_| (None, None)).collect();
    while game.step_to(6 * day) {
        let world = &game.world;
        for (i, &id) in people.iter().enumerate() {
            let state = (at_of(world, id), doing(world, id));
            if state != last[i] {
                if state == (Some(station), Some(crate::needs::Need::Fuel)) {
                    stops += 1;
                }
                last[i] = state;
            }
        }
    }
    // Fourteen commuters, a 500-tile tank: a stop each every few days —
    // and not one a day, which would be a nag. The pump's ten minutes
    // a stop is what keeps it from being one: a fill costs nothing.
    println!("{stops} fuel stops in six days");
    assert!((12..=48).contains(&stops), "{stops} fuel stops in six days");
    wants_nothing(&game.world, game.now);
}

/// Every kind the mayor could put down along the street: the harbour
/// aside, which stands with its back to the sea, and the street has
/// one.
pub(crate) fn placeable() -> Vec<BuildingKind> {
    BuildingKind::ALL.into_iter().filter(|&k| k != BuildingKind::Harbour).collect()
}

/// A town shaped like a town, for the seasons: mostly homes, offices
/// and factories with about as many desks as the homes have people,
/// shops, a pump, a supermarket, and a farm and a warehouse to feed
/// them. Forty plots. `placeable` cycles every kind equally, which is
/// a shop or a depot for every home — the mix for a wake budget, not
/// for a town.
pub(crate) fn town_mix() -> Vec<BuildingKind> {
    use BuildingKind::*;
    vec![
        House, Apartment, Factory, House, Apartment, Shop, House, Factory, Apartment, House,
        House, Apartment, House, Shop, Factory, House, Apartment, House, House, Factory,
        Apartment, House, GasStation, Apartment, Factory, House, Supermarket, Apartment, House, Factory,
        Farm, House, Apartment, Depot, House, Apartment, House, Apartment, House, Apartment,
    ]
}
/// A street drawn to a house that was standing dormant moves people in.
///
/// Drawing road once settled nothing, so the house stayed empty until
/// the mayor happened to place something else. A driveway laid on a
/// plot marks it unsettled, and the tick settles once after the batch.
#[test]
fn a_street_drawn_to_a_dormant_house_fills_it() {
    let mut world = street();
    // Three tiles off the street, so no driveway forms with it.
    let home = world
        .place_building(GridCoord { x: 10, y: 3 }, BuildingKind::House, 2)
        .expect("land is land");
    world.finish(home);
    let mut game = game(world);
    assert!(game.world.resident_ids().is_empty(), "nobody lives where no road goes");

    // The mayor draws a street to it, tile by tile, as the brush does.
    for (from, to) in [
        (GridCoord { x: 10, y: 0 }, GridCoord { x: 10, y: 1 }),
        (GridCoord { x: 10, y: 1 }, GridCoord { x: 10, y: 2 }),
        // Onto the plot: a road that ends on one is a driveway.
        (GridCoord { x: 10, y: 2 }, GridCoord { x: 10, y: 3 }),
    ] {
        does(&mut game, Do::Step(Tool::Street, from, to));
    }
    assert!(game.world.street_of(home).is_some(), "the driveway formed itself");

    // Which is what the step after it settles for, once, after the batch.
    game.step();
    assert_eq!(
        game.world.resident_ids().len(),
        crate::blueprint::blueprint(BuildingKind::House).homes as usize,
        "the street reached it and nobody moved in",
    );
}

/// A town along the street, settled and thinking, run for a while: a
/// mix of every kind, its people coming over on the ferry. Returns it
/// and how many times a resident thought.
pub(crate) fn live(mix: &[BuildingKind], days: u64) -> (World, u64) {
    season_with(street(), mix, days, |_, _| Vec::new(), |_, _, _| {})
}

/// The mayor's steps, as the hand takes them.
pub(crate) type Steps = Vec<Do>;

/// `live` on a street of the caller's, founded with the stake: the
/// mayor's hand at every midnight, `hand`, and a look at the town at
/// the end of every day, after the midnight wake, `each_day`.
pub(crate) fn season_with(mut world: World, mix: &[BuildingKind], days: u64, mut hand: impl FnMut(&World, u64) -> Steps, mut each_day: impl FnMut(&World, u64, u64)) -> (World, u64) {
    // Forty plots in a row, a tile apart: a lot claims the tile beside
    // it for its ring, and a house may not stand on it.
    let mut x = 0;
    for i in 0..40 {
        let kind = mix[i % mix.len()];
        build(&mut world, x, kind);
        x += crate::blueprint::plot(kind, 0).size.0 as i32 + 1;
    }
    // A second lorry for each depot.
    let depots: Vec<EntityId> = world.objects.iter().filter(|e| matches!(e.object, GameObject::Building(ref b) if b.kind == BuildingKind::Depot)).map(|e| e.id).collect();
    for d in depots {
        if let Some(b) = world.building_mut(d) {
            b.lorries = 1;
        }
    }
    let mut game = game(world);
    assert!(!game.world.harbours.is_empty(), "no harbour, or nobody can arrive at all");
    // The mayor at the market as each ferry casts off, looked for every
    // hour: a lorry's load of fuel bought, which nothing in town makes,
    // once the last is off the border; and a load of the farm's crates
    // sold, once the last is loaded.
    let mut berthed = false;
    let mut market = |game: &mut Game, exporting: bool| {
        let world = &mut game.world;
        let ferry = world.ferry_of(harbour_of(world)).expect("the harbour's ferry");
        let was = std::mem::replace(&mut berthed, car_of(world, ferry).spot.is_some());
        if !was || berthed {
            return;
        }
        let packages = crate::haul::packages(world);
        if !packages.iter().any(|(t, l, _)| !t.outbound && t.good == Good::Fuel && matches!(l, Leg::Booked | Leg::Aboard | Leg::Quay)) {
            crate::market::trade(world, Good::Fuel, false, crate::haul::LOAD);
        }
        let harbour = harbour_of(world);
        if exporting && !building_of(world, harbour).outgoing.iter().any(|t| t.good == Good::Crates) {
            crate::market::trade(world, Good::Crates, true, crate::haul::LOAD);
        }
        crate::haul::call_lorries(world, &mut game.events);
    };
    let mut exporting = false;
    let end = days * DAY_MS as u64;
    // A day at a time, so the look at the end of each is on the tick
    // that turns it, with the midnight wake taken.
    for day in 1..=days {
        let midnight = day * DAY_MS as u64;
        for hour in 1..=24 {
            market(&mut game, exporting);
            game.run_to((midnight - DAY_MS as u64 + hour * crate::market::HOUR).min(end));
        }
        let (world, now) = (&game.world, game.now);
        // A town that gridlocks is not a town being measured: nobody is
        // a day late for anything. Two driveways two tiles apart held
        // each other for good on the third day, once the offices' cars
        // were on the street, until claims lapsed (docs/parking.md §9).
        let stuck = world.objects.iter().filter(|e| matches!(e.object, GameObject::Car(ref c) if c.trip.as_ref().is_some_and(|t| now > t.eta + DAY_MS as u64))).count();
        assert_eq!(stuck, 0, "day {day}: {stuck} cars a day past their due time — the street has gridlocked");
        each_day(world, day, game.thoughts);
        if !exporting && world.objects.iter().any(|e| matches!(e.object, GameObject::Building(ref b) if b.kind == BuildingKind::Farm && b.stocks[&Good::Crates].level > 0.0)) {
            exporting = true;
        }
        for d in hand(world, day) {
            does(&mut game, d);
        }
    }
    (game.world, game.thoughts)
}

/// The budget: how much thinking a day of town life is allowed to take.
/// A resident wakes when something changes for them — a shift, a meal,
/// an arrival — which is a few dozen times a day. A storm is thousands.
/// Counted, not timed, so it is the same on every machine. It is not in
/// the everyday run: `cargo test town -- --ignored --nocapture` runs it
/// with the benchmarks below, for a look every now and then.
///
/// Two towns: one with everything, and one with nothing but homes and
/// jobs, where meals and evenings out go wanting. Wanting is where the
/// storm of 2026-09-04 lived — a bucket with nothing on offer was asked
/// again every step — so the bare town is the one that stands guard.
#[test]
#[ignore]
fn a_town_thinks_within_budget() {
    // Everything the mayor could build. The edge is not a town's to
    // have, so it is not in the mix.
    let every_kind = placeable();
    for (name, mix) in [("full", &every_kind[..]), ("bare", &[BuildingKind::House, BuildingKind::Factory][..])] {
        let (world, wakes) = live(mix, 1);
        let residents = world.resident_ids().len() as u64;
        let per_resident_day = wakes / residents.max(1);
        println!("{name}: {wakes} wakes for {residents} residents: {per_resident_day} per resident-day");
        assert!(per_resident_day <= WAKE_BUDGET, "{name}: {per_resident_day} wakes per resident-day, budget {WAKE_BUDGET}");
    }
}

/// A town thinks as fast in a wide world as in a narrow one. A big
/// world is mostly road nodes nobody drives: 29,000 of them beside 47
/// buildings on 2026-10-05, when the survey laid road ahead of the
/// frontier and every call and every choice still walked them all to
/// find a depot, a van or a resident, and the clock stalled for
/// seconds at a time. The same day of the same town, with that much
/// road laid out of reach, costs at most half as much again.
#[test]
#[ignore]
fn a_town_thinks_as_fast_in_a_wide_world() {
    let timed = |world: World| {
        let started = Instant::now();
        season_with(world, &town_mix(), 1, |_, _| Vec::new(), |_, _, _| {});
        started.elapsed().as_secs_f64()
    };
    let narrow = timed(street());
    let mut wide = street();
    for y in 1000..1100 {
        for x in 0..300 {
            wide.terrain.insert((x, y), TerrainType::Grass);
        }
        wide.place_road_path(&(0..300).map(|x| GridCoord { x, y }).collect::<Vec<_>>());
    }
    let wide = timed(wide);
    println!("a day of town: {narrow:.2} s, and {wide:.2} s among 30,000 road nodes");
    assert!(wide < 1.5 * narrow, "a day of town took {narrow:.2} s, and {wide:.2} s among 30,000 road nodes");
}

/// How fast the same town runs, in simulated days per wall second. Not
/// asserted: wall time is the laptop's, not the code's. Printed for the
/// same occasional look as the budget, to see whether it has drifted.
#[test]
#[ignore]
fn how_fast_a_town_runs() {
    let started = Instant::now();
    let (world, wakes) = live(&placeable(), 3);
    let secs = started.elapsed().as_secs_f64();
    println!(
        "{} residents, {wakes} wakes: {:.2} sim days per second",
        world.resident_ids().len(),
        3.0 / secs
    );
}

/// `copies` of the season's town, a hundred tiles apart, each on its
/// own street with a door out: a town twice the size, with the same
/// neighbourhoods in it.
pub(crate) fn towns(copies: i32) -> World {
    let mut world = World::new();
    let mix = town_mix();
    for k in 0..copies {
        let dy = 100 * k;
        for y in -6..14 {
            for x in -4..400 {
                world.terrain.insert((x, y + dy), TerrainType::Grass);
            }
        }
        world.place_road_path(&(-2..400).map(|x| GridCoord { x, y: dy }).collect::<Vec<_>>());
        world.open_exit(world.road_node_at(GridCoord { x: 0, y: dy }).unwrap());
        let mut x = 0;
        for kind in &mix {
            world.place_on_street(GridCoord { x, y: dy + 1 }, *kind).expect("the street gives it a driveway");
            x += crate::blueprint::plot(*kind, 0).size.0 as i32 + 1;
        }
    }
    world
}

/// What builds cost the loop in a town of `copies`, in microseconds,
/// each the best of a row of them, as the least a machine busy with
/// other things lets through: a house placed across the
/// street and demolished again, a shop the same, and a side street
/// drawn four tiles — each a batch of the brush's steps, with the
/// settle the tick runs after it.
pub(crate) fn build_cost(copies: i32) -> Vec<(&'static str, f64)> {
    let mut game = game(towns(copies));
    game.world.treasury = 1e9;
    // A command batch as the tick takes it: every step, then one settle,
    // the settle alone: what the residents it woke then think is theirs.
    let timed = |game: &mut Game, steps: Vec<Do>| {
        let started = Instant::now();
        for d in steps {
            does(game, d);
        }
        settle_and_wake(&mut game.world, &mut game.events);
        started.elapsed().as_secs_f64() * 1e6
    };
    let at = |x, y| GridCoord { x, y };
    let mut costs: Vec<(&'static str, Vec<f64>)> = ["a house", "its demolition", "a shop", "its demolition", "a road"].map(|n| (n, Vec::new())).into();
    for i in 0..20 {
        let x = 4 + 8 * i;
        for (k, kind) in [BuildingKind::House, BuildingKind::Shop].into_iter().enumerate() {
            // Placed across the street.
            let placed = timed(&mut game, vec![Do::Place(kind, at(x, -1))]);
            let id = *game.world.occupied.get(&(x, -1)).unwrap_or_else(|| panic!("the {kind:?} went down"));
            // Its timber in, it stands, and the settle that follows is
            // part of what it cost.
            game.world.finish(id);
            let stood = timed(&mut game, Vec::new());
            costs[2 * k].1.push(placed + stood);
            let bp = crate::blueprint::blueprint(kind);
            assert_eq!((game.world.household(id).len(), game.world.staff(id).len()), (bp.homes as usize, bp.jobs as usize), "the {kind:?} filled");
            // Taken down.
            costs[2 * k + 1].1.push(timed(&mut game, vec![Do::Raze(at(x, -1))]));
            assert!(game.world.objects.get(id).is_none(), "the {kind:?} came down");
        }
        let steps = (0..4).map(|y| Do::Step(Tool::Street, at(x + 6, -y), at(x + 6, -y - 1))).collect();
        costs[4].1.push(timed(&mut game, steps));
    }
    let costs: Vec<(&'static str, f64)> = costs
        .into_iter()
        .map(|(what, v)| (what, v.into_iter().fold(f64::INFINITY, f64::min)))
        .collect();
    println!("{copies} town(s), {} residents: {}", game.world.resident_ids().len(), costs.iter().map(|(what, c)| format!("{what} {c:.0} µs")).collect::<Vec<_>>().join(", "));
    costs
}

/// A build costs the loop what it changes, not what the town holds:
/// the same tap in a town twice the size costs at most a third as much
/// again, and a few microseconds of a busy machine. Every player building
/// at once shares the one loop, so a build that grew with the world would
/// stall all of them. Settling the whole town after every build cost 2 ms
/// a house here, and 6 ms in two towns; finding the harbours and depots by
/// walking the town, 24 µs a house here and 62 µs in two.
/// Timed, so `#[ignore]`d with the other town benchmarks.
#[test]
#[ignore]
fn a_build_costs_the_same_in_a_town_twice_the_size() {
    for ((what, one), (_, two)) in build_cost(1).into_iter().zip(build_cost(2)) {
        assert!(two < 1.3 * one + 20.0, "{what} cost {one:.0} µs in one town and {two:.0} µs in two");
    }
}

/// The server's own loop over every fixture, a town of thousands of
/// buildings: `Game::step` for six hours of play, settle and all,
/// which the town tests above skip. Printed, not asserted: what a
/// settle step costs against the steps between, in microseconds.
#[test]
#[ignore]
fn a_town_of_every_fixture_settles() {
    let mut world = World::new();
    crate::fixtures::build(&mut world, &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures"));
    let mut game = Game::new(world, crate::fixtures::NOON, 1, Box::new(World::new));
    let (mut settles, mut others) = (Vec::new(), Vec::new());
    for _ in 0..DAY_MS as GameTime / 4 / STEP_MS {
        let settling = game.now % SETTLE_MS == 0 || !game.world.unsettled.is_empty();
        let started = Instant::now();
        game.step();
        (if settling { &mut settles } else { &mut others }).push(started.elapsed().as_secs_f64() * 1e6);
    }
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    println!(
        "{} objects: {} settles {:.0} µs each (worst {:.0}), {} other steps {:.1} µs each",
        game.world.objects.len(),
        settles.len(),
        mean(&settles),
        settles.iter().fold(0.0, |a: f64, &b| a.max(b)),
        others.len(),
        mean(&others)
    );
}

/// What settling must leave true, whatever was built: every home a
/// road reaches full, every line staffed while anyone is out of work,
/// nobody living or working where no road goes, the index of who is where agreeing with the
/// residents, and everyone with a car.
pub(crate) fn assert_settled(world: &World, after: &str) {
    let jobless = world.objects.iter().filter(|e| matches!(e.object, GameObject::Resident(ref r) if r.work.is_none())).count();
    for e in world.objects.iter() {
        let GameObject::Building(ref b) = e.object else { continue };
        if b.site.is_some() {
            continue;
        }
        let bp = crate::blueprint::blueprint(b.kind);
        let reached = world.street_of(e.id).is_some();
        let want = |n: u32| if reached { n as usize } else { 0 };
        assert_eq!(world.household(e.id).len(), want(bp.homes), "after {after}: {:?} {} (reached {reached}) houses the wrong number", b.kind, e.id);
        // A desk stays empty only while nobody in town is out of work.
        assert!(world.staff(e.id).len() <= want(bp.jobs), "after {after}: {:?} {} (reached {reached}) staffs too many", b.kind, e.id);
        assert!(world.staff(e.id).len() == want(bp.jobs) || jobless == 0, "after {after}: {:?} {} has a desk free and {jobless} out of work", b.kind, e.id);
    }
    for id in world.resident_ids() {
        let Some(r) = world.resident(id) else { continue };
        for b in std::iter::once(r.home).chain(r.work) {
            assert!(world.street_of(b).is_some(), "after {after}: resident {id} is tied to {b}, which no road reaches");
            assert!(world.people.get(&b).is_some_and(|p| p.contains(&id)), "after {after}: the index lost resident {id} at {b}");
        }
        assert!(matches!(world.objects.get(r.car).map(|e| &e.object), Some(GameObject::Car(_))), "after {after}: resident {id} has no car");
    }
    for (&b, people) in &world.people {
        for &id in people {
            assert!(matches!(world.objects.get(id).map(|e| &e.object), Some(GameObject::Resident(r)) if r.home == b || r.work == Some(b)), "after {after}: the index ties {id} to {b}");
        }
    }
}

/// Settling reads only the buildings marked unsettled, so a change
/// that forgets to mark one leaves a house empty or a cut-off shop
/// staffed, and nothing else would say so until midnight put it
/// right. A town is built and changed by the mayor's own commands —
/// placed, demolished, the street before one taken up and laid again
/// — and after every one, the town is settled.
#[test]
fn every_build_leaves_the_town_settled() {
    let mut world = street();
    for (x, kind) in [(0, BuildingKind::House), (3, BuildingKind::House), (6, BuildingKind::Apartment), (12, BuildingKind::Shop), (30, BuildingKind::Factory)] {
        build(&mut world, x, kind);
    }
    let mut game = game(world);
    assert_settled(&game.world, "the start");
    game.world.treasury = 1e9;
    let at = |x, y| GridCoord { x, y };
    let act = |game: &mut Game, d: Do| {
        does(game, d);
        game.step();
        assert_settled(&game.world, &format!("{d:?}"));
    };
    // Placed across the street: two houses and an office.
    act(&mut game, Do::Place(BuildingKind::House, at(20, -1)));
    act(&mut game, Do::Place(BuildingKind::House, at(24, -1)));
    act(&mut game, Do::Place(BuildingKind::Factory, at(41, -1)));
    // The office and a house taken down, and the street before a third
    // taken up and laid again.
    act(&mut game, Do::Raze(at(40, -1)));
    assert!(!game.world.occupied.contains_key(&(41, -1)), "the office stands");
    act(&mut game, Do::Raze(at(0, 1)));
    let street_of = |world: &World, x, y| {
        let (_, street) = world.door_of(*world.occupied.get(&(x, y)).unwrap()).expect("placed with a door");
        world.objects.get(street).unwrap().position.unwrap()
    };
    // Its street taken up, its door moves to the next street tile
    // along, on the diagonal; that one taken up too, it has none.
    let street = street_of(&game.world, 24, -1);
    act(&mut game, Do::Step(Tool::Demolish, street, street));
    let next = street_of(&game.world, 24, -1);
    assert_ne!(next, street, "the door stayed on the street that went");
    act(&mut game, Do::Step(Tool::Demolish, next, next));
    let other = street_of(&game.world, 24, -1);
    act(&mut game, Do::Step(Tool::Demolish, other, other));
    assert!(game.world.street_of(game.world.occupied[&(24, -1)]).is_none(), "the street went");
    act(&mut game, Do::Step(Tool::Street, at(street.x - 1, street.y), street));
    act(&mut game, Do::Step(Tool::Street, street, at(street.x + 1, street.y)));
    assert_eq!(street_of(&game.world, 24, -1), street, "the street came back");
}

/// Where the season's quarry and sawmill stand, past the town's forty
/// plots, each with its ground behind it.
pub(crate) const QUARRY_X: i32 = 150;
pub(crate) const SAWMILL_X: i32 = 170;

/// The season: a month of the same town as
/// `a_town_thinks_within_budget`, `#[ignore]`d for the same reason:
/// `cargo test season -- --ignored --nocapture`. Thirty days is a
/// season; `DAYS=8` runs a shorter one, to see a town drift in a few
/// minutes rather than ten.
pub(crate) fn season_days() -> u64 {
    std::env::var("DAYS").ok().and_then(|d| d.parse().ok()).unwrap_or(30)
}

/// What a town is for, held over a season: its shelves stay stocked
/// and its residents fed. Every day the town eats what its people need
/// — at home or out — and eats out, fills up and works; no shelf in
/// town and no car's tank stands empty two midnights running: a shelf
/// that empties calls, and something comes. And the farm's harvests
/// leave for the world, so the town ends the season with coins. Each
/// day's page is printed: hours served, coins in and out at the
/// border, the treasury, empty shelves.
///
/// And it builds: a quarry at the mountain's foot and a sawmill in the
/// woods, and every midnight the mayor puts down a block of flats, of
/// timber and stone, and a side street of three tiles laid on stone.
/// Every site stands within a day of the next midnight: the depot's
/// lorry fetches from the quarry and the sawmill, its vans take the
/// materials to the sites, and the roads draw on the depot's stone.
#[test]
#[ignore]
fn season_the_shelves_stay_stocked_and_everyone_eats() {
    use crate::needs::Need;
    let days = season_days();
    // The mountain behind the quarry's plot, and the woods behind the
    // sawmill's, beyond the town's forty.
    let mut world = street();
    for (x0, ground) in [(QUARRY_X, TerrainType::Mountain), (SAWMILL_X, TerrainType::Forest)] {
        for x in x0 - 5..x0 + 7 {
            for y in 5..14 {
                world.terrain.insert((x, y), ground);
            }
        }
    }
    let quarry = build(&mut world, QUARRY_X, BuildingKind::Quarry);
    let sawmill = build(&mut world, SAWMILL_X, BuildingKind::Sawmill);
    let mut stood = 0;
    // Each midnight, a block of flats across the street, and a side
    // street beside it; and the letters read, and a slot booked going
    // out for each package an order still wants, of what the town has in
    // its depot and its makers' yards, while it keeps a lorry's load back
    // for the sites.
    let hand = |world: &World, day: u64| -> Steps {
        let x = 112 + 4 * (day as i32 - 1);
        let at = |x, y| GridCoord { x, y };
        let mut steps = vec![
            Do::Place(BuildingKind::Apartment, at(x + 1, -1)),
            Do::Step(Tool::Street, at(x + 2, 0), at(x + 2, -1)),
            Do::Step(Tool::Street, at(x + 2, -1), at(x + 2, -2)),
            Do::Step(Tool::Street, at(x + 2, -2), at(x + 2, -3)),
        ];
        let depot = world.objects.iter().find(|e| matches!(e.object, GameObject::Building(ref b) if b.kind == BuildingKind::Depot)).map(|e| e.id).unwrap();
        let harbour = harbour_of(world);
        // Waiting at the harbour, and booked tonight for a letter before this one.
        let queued = |g: Good, steps: &Steps| (building_of(world, harbour).outgoing.iter().filter(|t| t.good == g).count() + steps.iter().filter(|d| matches!(d, Do::Send(l) if crate::orders::letters(world).iter().any(|o| o.letter == *l && o.good == g))).count()) as f64;
        for o in crate::orders::letters(world) {
            let yards: f64 = [quarry, sawmill].iter().map(|&m| building_of(world, m).stocks.get(&o.good).map_or(0.0, |s| s.level)).sum();
            let spare = ((building_of(world, depot).stocks[&o.good].level + yards) / o.good.per_package()).floor() - crate::haul::LOAD as f64 - queued(o.good, &steps);
            steps.extend((0..(o.packages as f64).min(spare).max(0.0) as usize).map(|_| Do::Send(o.letter)));
        }
        steps
    };
    let mut empty_since: std::collections::BTreeMap<(EntityId, String), u64> = Default::default();
    let mut stood_empty = |what: (EntityId, String), empty: bool, day: u64| -> u64 {
        if empty {
            day - *empty_since.entry(what).or_insert(day)
        } else {
            empty_since.remove(&what);
            0
        }
    };
    // Yesterday's eating, hours had and asked: the town is fed over two
    // days, so a day's timing is not taken for a chain that fails.
    let mut yesterday = (0.0, 0.0);
    let (world, _) = season_with(world, &town_mix(), days, hand, |world, day, _| {
        let midnight = day * DAY_MS as u64;
        let page = world.town.before(midnight);
        // Every block of flats put down at a midnight stands by the next.
        let flats = |site: bool| world.objects.iter().filter(|e| matches!(e.object, GameObject::Building(ref b) if b.kind == BuildingKind::Apartment && b.tiles[0].y < 0 && b.site.is_some() == site)).count();
        stood = flats(false);
        let waiting: Vec<_> = world.calls.iter().filter(|c| matches!(world.objects.get(c.at).map(|e| &e.object), Some(GameObject::Building(b)) if b.site.is_some())).collect();
        assert_eq!(stood as u64, day - 1, "day {day}: {} sites still waiting; calls {waiting:?}", flats(true));
        let level = |id: EntityId, good: Good| match world.objects.get(id).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.stocks.get(&good).map_or(0.0, |s| s.level),
            _ => 0.0,
        };
        let depot = world.objects.iter().find(|e| matches!(e.object, GameObject::Building(ref b) if b.kind == BuildingKind::Depot)).map(|e| e.id).unwrap();
        println!(
            "  built: {stood} blocks of flats; yards: quarry {:.0} stone, sawmill {:.0} timber; depot {:.0} stone, {:.0} timber; bought {:.1?}",
            level(quarry, Good::Stone),
            level(sawmill, Good::Timber),
            level(depot, Good::Stone),
            level(depot, Good::Timber),
            page.bought,
        );
        let mut empty = Vec::new();
        for e in world.objects.iter() {
            let GameObject::Building(ref b) = e.object else { continue };
            for (&good, stock) in &b.stocks {
                // A farm's yard is meant to empty: a lorry takes it.
                if crate::economy::makes(b.kind, good) {
                    continue;
                }
                if stock.level <= 0.0 {
                    empty.push(format!("{:?} {} {good:?}", b.kind, e.id));
                }
                let days = stood_empty((e.id, format!("{good:?}")), stock.level <= 0.0, day);
                assert!(days < 1, "day {day}: {:?} {}'s {good:?} has stood empty two midnights running; calls {:?}", b.kind, e.id, world.calls);
            }
        }
        for e in world.objects.iter() {
            let GameObject::Car(ref c) = e.object else { continue };
            if c.role == crate::protocol::CarRole::Private {
                let dry = c.stocks.get(&Need::Fuel).is_some_and(|s| s.level <= 0.0);
                assert!(stood_empty((e.id, "tank".into()), dry, day) < 1, "day {day}: car {} has stood dry two midnights running", e.id);
            }
        }
        // Fed: the hours of eating everyone in town did yesterday, at
        // home or out, against what a day asks of each of them.
        let eaten: f64 = world.books.values().map(|k| k.before(midnight).served.get(&Need::Eat).copied().unwrap_or(0.0)).sum();
        let asked = world.resident_ids().len() as f64 * Need::Eat.daily_ms() / (DAY_MS as f64 / 24.0);
        // Hours served out of the house, per need: work, eating out,
        // filling up.
        let mut out: std::collections::BTreeMap<Need, f64> = Default::default();
        for (id, k) in &world.books {
            if matches!(world.objects.get(*id).map(|e| &e.object), Some(GameObject::Building(b)) if crate::blueprint::blueprint(b.kind).homes == 0) {
                for (&need, &h) in &k.before(midnight).served {
                    *out.entry(need).or_default() += h;
                }
            }
        }
        println!(
            "day {day}: ate {eaten:.0}h of {asked:.0}h; {:.0}h work, {:.1}h eating out, {:.1}h filling up; GDP {:.1} {:.1?}, in {:.1} out {:.1}, treasury {:.1}; {} empty {:?}",
            out.get(&Need::Work).copied().unwrap_or(0.0),
            out.get(&Need::Eat).copied().unwrap_or(0.0),
            out.get(&Need::Fuel).copied().unwrap_or(0.0),
            page.gdp.values().sum::<f64>(),
            page.gdp,
            page.revenue(),
            page.purchases(),
            world.treasury,
            empty.len(),
            empty,
        );
        // `SEA=1` prints the border each midnight: every box and
        // where it is, every lorry and what it hauls, and the yards.
        if std::env::var("SEA").is_ok() {
            let sea = crate::haul::inspect(world, midnight);
            for h in sea["harbours"].as_array().unwrap() {
                let park: Vec<String> = h["park"].as_array().unwrap().iter().map(|t| if t.is_null() { "_".into() } else { format!("{}{}", t["good"].as_str().map_or("E", |g| &g[..1]), if t["outbound"].as_bool().unwrap() { "^" } else { "" }) }).collect();
                println!("  park {} deck {} booked {}", park.join(""), h["ferry"]["deck"].as_array().unwrap().iter().filter(|t| !t.is_null()).count(), h["ferry"]["booked"].as_array().unwrap().len());
            }
            for l in sea["lorries"].as_array().unwrap() {
                println!("  lorry {} to {} hitched {}", l["id"], l["to"], l["hitched"]);
            }
            for e in world.objects.iter() {
                if let GameObject::Building(ref b) = e.object
                    && matches!(b.kind, BuildingKind::Depot | BuildingKind::Farm)
                {
                    println!("  {:?} {} {:?}", b.kind, e.id, b.stocks.iter().map(|(g, s)| (*g, s.level as i32)).collect::<Vec<_>>());
                }
            }
        }
        let (had, of) = std::mem::replace(&mut yesterday, (eaten, asked));
        if day > 2 {
            assert!(eaten + had >= 0.85 * (asked + of), "days {}–{day}: the town ate {:.1}h of the {:.1}h its people need", day - 1, eaten + had, asked + of);
        }
        if day > 1 {
            for need in [Need::Work, Need::Eat, Need::Fuel] {
                assert!(out.get(&need).is_some_and(|&h| h > 0.0), "day {day}: nobody in town was served {need:?}");
            }
        }
    });
    let sold = world.town.season().map(|p| p.sold.get(&Good::Crates).copied().unwrap_or(0.0)).sum::<f64>();
    println!("the season: treasury {:.1}, crates sold to the world for {sold:.1}, {stood} sites stood", world.treasury);
    // The order board: what the towns beyond the edge asked, what was
    // sent, and what they paid.
    let orders: Vec<_> = world.missions.list.iter().filter(|m| matches!(m.key, crate::missions::Key::Order(_))).collect();
    let paid: f64 = orders
        .iter()
        .map(|m| match (m.steps[0].goal, m.reward) {
            (crate::missions::Goal::Delivered { units, sailed, .. }, crate::missions::Reward::Order { coins, .. }) => coins * sailed.min(units) / units,
            _ => 0.0,
        })
        .sum();
    let filled = orders.iter().filter(|m| m.steps[0].done).count();
    let lapsed = orders.iter().filter(|m| m.finished.is_some() && !m.steps[0].done).count();
    println!(
        "orders: {} letters, {filled} filled, {lapsed} lapsed; {paid:.0} coins paid: {:.0}% of the treasury",
        orders.len(),
        100.0 * paid / world.treasury
    );
    for n in crate::orders::neighbours(&world) {
        let theirs: Vec<_> = orders.iter().filter(|m| m.from == Some(n.mayor)).map(|m| { let sent = match m.steps[0].goal { crate::missions::Goal::Delivered { sailed, .. } => sailed, _ => 0.0 }; format!("{}{}", m.steps[0].title, if m.steps[0].done { String::new() } else if m.finished.is_some() { format!(" (lapsed, {sent:.0} sent)") } else { " (open)".into() }) }).collect();
        println!("  {} of {}: standing {:.1}; {}", n.name, n.town, n.standing, theirs.join(", "));
    }
    assert!(filled > 0, "the town filled no orders");

    assert!(sold > 0.0, "the farm never sold a harvest to the world");
    assert!(world.treasury > 0.0, "the town ran out of coins");
}

#[test]
fn the_same_town_lives_the_same_days() {
    let three = arrival_log(3);
    let one = arrival_log(1);
    // Fourteen people, each at least driving in, to work, and home.
    assert!(one.len() >= 14 * 3, "only {} moves logged", one.len());
    assert_eq!(three[..one.len()], one[..], "the first day differs between runs");
    assert!(three.len() > one.len(), "nobody moved on the second day");

    // The third day is a settled one. Every trip is two changes of
    // `at` — into the car, out at the door — and a day is at most seven
    // trips: to the pump and back, if the tank ran dry overnight; to
    // work; out for lunch and back; out for the evening near work; and
    // home. The shop workers eat where they stand; the office has a
    // shop next door, so its workers drive to it.
    let day = DAY_MS as u64;
    let two = &three[..];
    let settled = 2 * day;
    let mut moves = std::collections::BTreeMap::new();
    for &(_, id, ..) in two.iter().filter(|&&(t, ..)| t >= settled) {
        *moves.entry(id).or_insert(0) += 1;
    }
    assert_eq!(moves.len(), 14, "everyone went out on day three");
    assert!(moves.values().all(|&n| n % 2 == 0 && (4..=14).contains(&n)), "someone thrashed: {moves:?}");
    assert!(moves.values().any(|&n| n >= 8), "nobody went out for lunch: {moves:?}");
    let last: std::collections::BTreeMap<_, _> = two.iter().map(|&(_, id, at, _)| (id, at)).collect();
    assert!(last.values().all(|at| at.is_some()), "someone ended the day in a car");
}
/// Land and the tractor, docs/buildings.md (making things): a farm on a street
/// claims its land; with a hand on shift its tractor ploughs it in a
/// run, seeds it in the next, and a day on harvests it, each tile's
/// crop landing in the yard as it is cut, while the hands' shifts
/// grow nothing in the yard themselves. A depot whose shelf runs low
/// fetches from the farm's yard with its own lorry, and no coin moves.
#[test]
fn a_tractor_works_the_land_and_a_lorry_fetches_from_the_yard() {
    use crate::protocol::Stage;
    let mut world = street();
    build(&mut world, 0, BuildingKind::House);
    build(&mut world, 3, BuildingKind::House);
    let farm = build(&mut world, 10, BuildingKind::Farm);
    let depot = build(&mut world, 30, BuildingKind::Depot);
    let mut game = game(world);
    game.world.treasury = 1000.0;
    let yard = |world: &World| world.building(farm).unwrap().stocks[&Good::Crates].level;
    let stages = |world: &World| -> Vec<Stage> { world.building(farm).unwrap().land.iter().map(|t| t.stage).collect() };
    let world = &game.world;
    let wanted = crate::world::fields::capacity(BuildingKind::Farm) as usize;
    assert!(stages(world).len() <= wanted && stages(world).len() > wanted * 9 / 10, "the farm claimed {} tiles of {wanted}", stages(world).len());
    assert_eq!(yard(world), 0.0, "the yard is founded with a make");
    let hands = world.resident_ids().into_iter().filter(|&id| world.resident(id).is_some_and(|r| r.work == Some(farm))).count();
    assert!(hands > 0, "the farm hired nobody");
    let tractor = world.objects.fleet(farm).next().expect("the farm keeps a tractor");
    assert!(world.car(tractor).is_some_and(|c| c.role == crate::protocol::CarRole::Tractor));
    // The first day: the hands come at six and the tractor ploughs
    // the land, a shift's worth; by evening it is a field, the tractor
    // is home, and the yard is empty.
    let day = DAY_MS as u64;
    let land = stages(world).len();
    let crop = crate::economy::crop(BuildingKind::Farm, land);
    game.run_to(20 * day / 24);
    let world = &game.world;
    assert!(stages(world).iter().all(|&s| s == Stage::Ploughed), "by evening the land is {:?}", stages(world));
    assert!(stages(world).len() >= land * 9 / 10, "the plough reached {} of {land} tiles", stages(world).len());
    assert_eq!(yard(world), 0.0, "something landed in the yard before a harvest");
    assert!(world.car(tractor).is_some_and(|c| c.run.is_none() && c.trip.is_none()), "the tractor is not home");
    // The second day: seeded. The third, growing; the fourth: ripe by
    // morning, harvested by evening, a harvest in the yard, and a lorry
    // from beyond the edge called for it.
    game.run_to(day + 20 * day / 24);
    assert!(stages(&game.world).iter().all(|&s| s == Stage::Sown), "by the second evening the land is {:?}", stages(&game.world));
    assert_eq!(yard(&game.world), 0.0);
    game.run_to(3 * day + 5 * day / 24);
    assert_eq!(yard(&game.world), 0.0, "a harvest before the crop was ripe");
    // Ripe by the fourth morning, and cut that day: the whole harvest
    // in the yard by evening, or already on its way to the world.
    let mut harvest = 0.0f64;
    while game.step_to(4 * day + 20 * day / 24) {
        harvest = harvest.max(yard(&game.world));
    }
    assert!((harvest - stages(&game.world).len() as f64 * crop).abs() < 1e-6, "the harvest came to {harvest}, not a yard's worth");

    // Then the depot's shelf runs low: its lorry fetches from the farm,
    // and no coin moves. The quay cleared first: the starter pack waits
    // there for the depot's room, and would be fetched first.
    let now = game.now;
    let harbour = harbour_of(&game.world);
    game.world.building_mut(harbour).unwrap().pad.clear();
    game.world.building_mut(farm).unwrap().stocks.get_mut(&Good::Crates).unwrap().level = 300.0;
    let before = yard(&game.world);
    let bought = |world: &World| world.town.on(now).bought.get(&Good::Crates).copied().unwrap_or(0.0);
    let bought_before = bought(&game.world);
    game.world.building_mut(depot).unwrap().stocks.get_mut(&Good::Crates).unwrap().level = 0.0;
    crate::haul::call_lorries(&mut game.world, &mut game.events);
    game.run_to(now + 3 * day / 24);
    let world = &game.world;
    assert!(building_of(world, depot).stocks[&Good::Crates].level > 0.0, "the fetch did not land; lorries {:?}", world.objects.iter().filter(|e| matches!(e.object, GameObject::Car(ref c) if c.role == crate::protocol::CarRole::Truck)).map(|e| (e.id, e.position, matches!(e.object, GameObject::Car(ref c) if c.trip.is_some()))).collect::<Vec<_>>());
    let fetched = before - yard(world);
    assert!(fetched > 0.0, "the lorry took nothing from the yard");
    assert_eq!(bought(world), bought_before, "crates fetched in town were paid for");
}

/// A depot's lorries, by id.
fn lorries_of(world: &World, depot: EntityId) -> Vec<EntityId> {
    world.objects.fleet(depot).filter(|&c| world.car(c).is_some_and(|c| c.role == CarRole::Truck)).collect()
}

pub(crate) fn car_of(world: &World, id: EntityId) -> crate::protocol::Car {
    world.car(id).cloned().unwrap_or_else(|| panic!("no car {id}"))
}

pub(crate) fn building_of(world: &World, id: EntityId) -> crate::protocol::Building {
    world.building(id).cloned().unwrap_or_else(|| panic!("no building {id}"))
}

/// A harbour on a real coast, seed 7's, where the map's edge is two
/// hours' sail out: the world's line takes two ferries, so the
/// harbour is called at as often as the old ferry's 6.4 a day, the
/// two passing at sea, never both at the ramp, the second waiting
/// beyond the edge if it would be.
#[test]
fn a_real_coast_is_called_at_as_often_as_ever() {
    let mut world = World::new();
    world.terrain = crate::terrain::generate(7);
    world.place_road_path(&(-6..10).map(|x| GridCoord { x, y: 32 }).collect::<Vec<_>>());
    let harbour = world.place_on_street(GridCoord { x: -2, y: 33 }, BuildingKind::Harbour).expect("seed 7's north coast takes a harbour");
    let mut game = game(world);
    let ferries = game.world.ferries_of(harbour);
    assert_eq!(ferries.len(), 2, "the world's line, {} ms round, runs {} ferries", game.world.lines[&harbour].cycle(), ferries.len());
    let (mut calls, mut moored) = (0, vec![false; 2]);
    let days = 2;
    while game.step_to(days * DAY_MS as u64) {
        let here: Vec<bool> = ferries.iter().map(|&f| car_of(&game.world, f).spot.is_some()).collect();
        assert!(here.iter().filter(|&&m| m).count() <= 1, "two ferries at the ramp at {}", game.now);
        calls += here.iter().zip(&moored).filter(|&(&h, &m)| h && !m).count();
        moored = here;
    }
    let per_day = calls as f64 / days as f64;
    assert!(per_day >= 6.0, "{per_day} calls a day");
}

/// The opening and the trunk after it, done: what the town's situation
/// waits for, and nothing left to pay for a sale or a purchase.
pub(crate) fn opening_done(world: &mut World) {
    while world.missions.list.iter().any(|m| m.finished.is_none()) {
        world.missions.list.iter_mut().for_each(|m| m.finished = Some(0));
        world.missions.stir();
        crate::missions::check(world, 0);
    }
}
/// The open missions' steps, by mission, as the step after now reads them.
pub(crate) fn missions(game: &mut Game) -> Vec<(crate::missions::Key, Vec<bool>, bool)> {
    game.step();
    game.world.missions.list.iter().map(|m| (m.key, m.steps.iter().map(|s| s.done).collect(), m.finished.is_some())).collect()
}

/// The opening's steps done.
pub(crate) fn opening(game: &mut Game) -> Vec<bool> {
    missions(game).into_iter().find(|m| m.0 == crate::missions::Key::Opening).expect("no opening").1
}
/// A sawmill placed by the hand on the test street at `x`, the woods
/// planted behind it as the season's are.
pub(crate) fn sawmill(world: &mut World, x: i32) -> EntityId {
    for (tx, ty) in (x - 5..x + 7).flat_map(|tx| (5..14).map(move |ty| (tx, ty))) {
        world.terrain.insert((tx, ty), TerrainType::Forest);
    }
    let at = GridCoord { x, y: 1 };
    let facing = world.site_for(at, BuildingKind::Sawmill).expect("no room for the sawmill");
    let mill = world.place_building(at, BuildingKind::Sawmill, facing).expect("the sawmill was refused");
    world.orient(mill);
    mill
}

/// The mayor's lorry sent on an errand, and the game run until it is done:
/// how long it took.
pub(crate) fn haul(game: &mut Game, from: EntityId, good: Good, packages: u32, to: EntityId) -> GameTime {
    let lorry = crate::haul::mayors(&game.world).expect("no lorry of the mayor's");
    let start = game.now;
    game.command(PLAYER, ClientMessage::Haul { from, good, packages, to });
    assert!(car_of(&game.world, lorry).errand.is_some(), "the lorry was not sent: {packages} of {good:?} from {from} to {to}");
    let until = game.now + DAY_MS as u64 / 4;
    while car_of(&game.world, lorry).errand.is_some() && game.step_to(until) {}
    assert!(car_of(&game.world, lorry).errand.is_none(), "the errand to {to} was never done");
    game.now - start
}

/// The opening (docs/plan-opening.md): the mayor is the town's first
/// lorry and its first builder. The first ferry comes in on time with
/// the starter pack and the forklifts lift it onto the quay, for
/// nothing. The mayor's lorry, the harbour's, takes its timber to a
/// sawmill's site and stands while it is built, and it stands with a
/// load in its yard; takes a bundle of that to each of two houses beside
/// it, built the same way, whose settlers come on the next ferry and
/// drive home; and a bundle to the quay, sold, paid as the ferry casts
/// off. Then a depot, whose lorry fetches what is left on the quay by
/// itself. The ferry keeps its timetable throughout. The opening ticks
/// off each step as the town does it, on the server, and pays when the
/// last is done; the trunk follows it.
#[test]
fn the_opening_from_the_harbour() {
    use crate::missions::Key;
    use crate::shipping::DWELL;
    use crate::world::sea::FIRST_CALL;
    let mut game = game(street());
    let harbour = harbour_of(&game.world);
    assert_eq!(opening(&mut game), [false, false, false, false], "the harbour stands, and nothing else is done");
    assert!(crate::haul::mayors(&game.world).is_none(), "the mayor's lorry came before the ferry");
    let world = &game.world;
    let ferry = world.ferry_of(harbour).expect("the harbour's ferry");
    let starter: u32 = crate::world::sea::STARTER.iter().map(|&(_, n)| n).sum();
    assert_eq!(car_of(world, ferry).booked.len(), starter as usize, "the starter pack is booked");
    // A settle with nothing new touches nothing: what it touches goes
    // to every client, and is written down, each tick.
    game.world.objects.drain_dirty();
    settle_and_wake(&mut game.world, &mut game.events);
    assert_eq!(game.world.objects.drain_dirty(), (vec![], vec![]), "a quiet settle changed something");
    let day = DAY_MS as u64;

    // In from the map's edge, never over land, and moored with the
    // starter pack on deck, on time.
    let turn = game.world.turn(harbour).expect("the harbour's line");
    let mut sailed = false;
    while car_of(&game.world, ferry).spot.is_none() {
        assert!(game.step_to(day), "the ferry never berthed");
        if let Some(sail) = car_of(&game.world, ferry).sail {
            assert!(game.world.water.get().unwrap().afloat(&sail.path), "the ferry's way crosses land");
            sailed = true;
        }
    }
    let berthed = game.now;
    assert!(sailed, "it never sailed in");
    assert!(berthed <= FIRST_CALL + 100, "the first ferry berthed at {berthed}, due at {FIRST_CALL}");
    // Aboard, or already being lifted off onto the quay.
    let landed = car_of(&game.world, ferry).deck.iter().flatten().count() + building_of(&game.world, harbour).pad.len();
    assert_eq!(landed, starter as usize, "the starter pack is not aboard");
    // The mayor's lorry rides it in, first aboard, and is the first thing
    // off the ramp, onto the quay.
    let lorry = crate::haul::mayors(&game.world).expect("the mayor's lorry did not come with the first ferry");
    assert_eq!(car_of(&game.world, lorry).owner, harbour);
    while car_of(&game.world, ferry).passengers.contains(&lorry) {
        assert!(game.step_to(day), "the lorry never rolled off");
    }
    assert!(car_of(&game.world, lorry).spot.is_some(), "the lorry did not come off onto the quay");
    // The forklifts unload it onto the quay while it is in, and it
    // sails on time.
    let mut lifted = false;
    while car_of(&game.world, ferry).spot.is_some() {
        assert!(game.step_to(day), "the ferry never sailed");
        lifted |= building_of(&game.world, harbour).lifts.iter().any(|l| l.car == ferry);
    }
    assert!(lifted, "no forklift ever worked the deck");
    assert!(game.now - berthed <= DWELL + 100, "it sailed late: {} after berthing", game.now - berthed);
    assert!(!car_of(&game.world, ferry).deck.iter().flatten().any(|t| !t.outbound), "it sailed with the starter pack aboard");
    let quay = |w: &World| building_of(w, harbour).pad.len();
    assert_eq!(quay(&game.world) as u32, starter, "the starter pack is not on the quay");
    assert_eq!(game.world.treasury, crate::economy::STAKE, "the starter pack was paid for");

    // The sawmill, a site; the mayor's lorry brings the gift's timber
    // and stands while it is built.
    let mill = sawmill(&mut game.world, SAWMILL_X);
    assert!(building_of(&game.world, mill).site.is_some(), "the first sawmill stood for nothing");
    let lorry_at = |w: &World| w.claims.get(&lorry).copied();
    game.command(PLAYER, ClientMessage::Haul { from: harbour, good: Good::Timber, packages: 2, to: mill });
    let until = game.now + day / 4;
    let mut building = false;
    while car_of(&game.world, lorry).errand.is_some() && game.step_to(until) {
        if car_of(&game.world, lorry).errand.is_some_and(|e| e.doing == crate::protocol::Doing::Build) {
            assert_eq!(lorry_at(&game.world), Some(mill), "the lorry builds from afar");
            assert!(building_of(&game.world, mill).site.is_some(), "the sawmill stood before it was built");
            building = true;
        }
    }
    assert!(building, "the lorry never stood to build the sawmill");
    assert!(building_of(&game.world, mill).site.is_none(), "the sawmill never stood");
    assert!(car_of(&game.world, lorry).cargo.is_empty(), "timber left on the lorry");
    let yard = |w: &World| building_of(w, mill).stocks[&Good::Timber].level;
    assert_eq!(yard(&game.world), crate::haul::LOAD as f64 * Good::Timber.per_package(), "the first sawmill's yard is not a load");
    assert_eq!(opening(&mut game), [true, false, false, false], "the sawmill stands");

    // Two houses beside it, of its own timber, a bundle each.
    let houses: Vec<EntityId> = [SAWMILL_X - 6, SAWMILL_X - 9]
        .into_iter()
        .map(|x| {
            does(&mut game, Do::Place(BuildingKind::House, GridCoord { x, y: 1 }));
            game.world.occupied[&(x, 1)]
        })
        .collect();
    for &house in &houses {
        assert!(building_of(&game.world, house).site.is_some(), "the house stood without its timber");
        haul(&mut game, mill, Good::Timber, 1, house);
        assert!(building_of(&game.world, house).site.is_none(), "the house was never built");
    }
    game.step();
    let settlers: Vec<EntityId> = houses.iter().flat_map(|&h| game.world.household(h)).collect();
    assert_eq!(settlers.len(), 4, "nobody moved in");

    // A bundle to the quay, sold while the settlers are on their way.
    let before = game.world.market.price(Good::Timber);
    haul(&mut game, mill, Good::Timber, 1, harbour);
    assert!(game.world.market.price(Good::Timber) < before, "selling timber did not push its price down");
    let out = |w: &World| crate::haul::packages(w).iter().any(|(t, l, _)| t.outbound && t.good == Good::Timber && matches!(l, crate::protocol::Leg::Quay | crate::protocol::Leg::Aboard));
    assert!(out(&game.world), "the timber is not on the quay or the deck for the ferry");

    // They come on the next ferry, and drive home: off the deck from
    // where each stood aboard, over the ramp and up the lane; and the
    // timber sails, paid as it does.
    let until = game.now + turn + DWELL + day / 6;
    let berth = game.world.berth(harbour).unwrap();
    let mut rolled = 0;
    let home = |w: &World, id: EntityId| at_of(w, id).is_some_and(|b| houses.contains(&b));
    let mut arrived: Vec<EntityId> = vec![];
    while arrived.len() < settlers.len() && game.step_to(until) {
        let now_home: Vec<EntityId> = settlers.iter().copied().filter(|&id| home(&game.world, id) && !arrived.contains(&id)).collect();
        arrived.extend(now_home);
        for &id in &settlers {
            let Some(r) = game.world.resident(id).filter(|_| !arrived.contains(&id)) else { continue };
            if let Some(t) = car_of(&game.world, r.car).trip.filter(|t| t.progress == 0.0 && t.route_positions.len() > 3) {
                let start = t.leaves.expect("a settler leaves from its seat");
                assert_eq!(start.at, t.route_positions[0]);
                let up = |p: [f64; 2]| (p[0] - berth.ramp()[0]) * berth.landward().cos() + (p[1] - berth.ramp()[1]) * berth.landward().sin();
                assert!(up(start.at) < -0.3, "a settler set off from {:?}, not the deck", start.at);
                rolled += 1;
            }
        }
    }
    assert!(rolled > 0, "no settler was seen rolling off the deck");
    assert_eq!(arrived.len(), settlers.len(), "the settlers never got home");
    let sold = game.world.town.on(game.now).sold.get(&Good::Timber).copied().unwrap_or(0.0);
    assert!(sold > 0.0 && sold <= Good::Timber.per_package() * crate::market::Market::ceiling(Good::Timber) + 1e-6, "the timber went out for {sold}");
    assert!(game.world.lumps.iter().any(|l| l.building == harbour && l.coins > 0.0), "no coins landed at the harbour");
    assert_eq!(opening(&mut game), [true, true, true, false], "the settlers came and the timber sold");

    // A depot, the town's first, stands at once; its lorry fetches what
    // is left on the quay by itself.
    let x = HARBOUR_X - 12;
    let world = &mut game.world;
    let facing = world.site_for(GridCoord { x, y: 1 }, BuildingKind::Depot).unwrap();
    let depot = world.place_building(GridCoord { x, y: 1 }, BuildingKind::Depot, facing).unwrap();
    world.orient(depot);
    assert!(building_of(world, depot).site.is_none(), "the first depot is a site");
    assert!(building_of(world, depot).stocks.values().all(|s| s.level == 0.0), "the depot stood stocked");
    let stock = |w: &World| building_of(w, depot).stocks.values().map(|s| s.level).sum::<f64>();
    let until = game.now + day / 12;
    while stock(&game.world) == 0.0 && game.step_to(until) {}
    assert!(stock(&game.world) > 0.0, "the depot's lorry brought nothing home in two hours");
    assert!(lorries_of(&game.world, depot).iter().all(|&l| car_of(&game.world, l).cargo.is_empty()), "the load was not gone into stock");
    assert!(game.world.lumps.iter().any(|l| l.building == depot && l.units > 0.0), "no lump for the unload");

    // The opening done, and paid; the trunk opens on the market.
    assert_eq!(opening(&mut game), [true; 4], "a depot stands");
    let paid = game.world.lumps.iter().filter(|l| l.building == harbour && l.good.is_none()).map(|l| l.coins).sum::<f64>();
    assert!((paid - 100.0).abs() < 1e-9, "the opening paid {paid}");
    // The trunk alone: the market's orders come and go beside it.
    let trunk = |game: &mut Game| missions(game).into_iter().filter(|(k, ..)| !matches!(k, Key::Order(_))).map(|(k, _, done)| (k, done)).collect::<Vec<_>>();
    assert_eq!(trunk(&mut game), [(Key::Opening, true), (Key::Book, false)]);

    // A second lorry, bought from the world.
    let before = game.world.treasury;
    game.command(PLAYER, ClientMessage::BuyLorry { depot });
    assert_eq!(lorries_of(&game.world, depot).len(), 2, "no second lorry");
    assert!((before - game.world.treasury - crate::haul::LORRY_PRICE).abs() < 1e-9, "the lorry was not paid for");

    // Then the market: a pallet of fuel bought pushes its price.
    let price = game.world.market.price(Good::Fuel);
    game.command(PLAYER, ClientMessage::Trade { good: Good::Fuel, packages: 1, out: false });
    assert_eq!(trunk(&mut game)[1], (Key::Book, true), "the fuel was not booked");
    assert!(game.world.market.price(Good::Fuel) > price, "buying fuel did not push its price");
}

/// The ferry at the ramp waits for the mayor's lorry on its way with a
/// load to sell, and casts off once it is aboard, not before and not
/// much after: the hand's sale makes the boat.
#[test]
fn the_ferry_waits_for_the_mayors_load() {
    let mut world = street();
    let mill = build(&mut world, HARBOUR_X - 20, BuildingKind::Sawmill);
    let mut game = game(world);
    let harbour = harbour_of(&game.world);
    let ferry = game.world.ferry_of(harbour).unwrap();
    let day = 2 * DAY_MS as u64;
    // The lorry comes on the first ferry; sent at once to the sawmill up
    // the street, it is loaded and back with the dwell gone.
    let berthed = |w: &World| car_of(w, ferry).spot.is_some();
    while !berthed(&game.world) && game.step_to(day) {}
    let lorry = crate::haul::mayors(&game.world).expect("the lorry did not come with the ferry");
    game.command(PLAYER, ClientMessage::Haul { from: mill, good: Good::Timber, packages: 2, to: harbour });
    assert!(car_of(&game.world, lorry).errand.is_some(), "the lorry was not sent");
    let due = car_of(&game.world, ferry).due;
    let carrying = |w: &World| car_of(w, lorry).errand.is_some_and(|e| e.doing == crate::protocol::Doing::Carry);
    while !carrying(&game.world) && game.step_to(day) {}
    assert!(car_of(&game.world, ferry).spot.is_some(), "the ferry left before the lorry was loaded");
    let aboard = |w: &World| car_of(w, ferry).deck.iter().flatten().filter(|t| t.outbound && t.good == Good::Timber).count();
    let mut most = 0;
    while car_of(&game.world, ferry).spot.is_some() && game.step_to(day) {
        most = most.max(aboard(&game.world));
    }
    assert_eq!(most, 2, "it sailed with {most} of the mayor's two bundles");
    assert!(game.now > due, "it never waited");
    assert!(game.now <= due + 2 * crate::shipping::DWELL, "it waited past its two dwells");
    assert!(game.world.held.is_empty(), "it is still held at sea");
}

/// One lorry, its depot a short street from the harbour, fetches the
/// starter pack: each load is lifted off in the yard and the lorry is
/// off again once the forklift is done, and the whole pack is home
/// within eight hours of the first ferry sailing. A round trip is two
/// drives, each ending in a backing into a dock; it once also stood
/// ten minutes at the depot, a van's unloading, and the pack took more
/// than eight hours.
#[test]
fn one_lorry_fetches_the_starter_pack_in_eight_hours() {
    let mut world = street();
    let harbour = harbour_of(&world);
    let x = HARBOUR_X - 12;
    let facing = world.site_for(GridCoord { x, y: 1 }, BuildingKind::Depot).unwrap();
    let depot = world.place_building(GridCoord { x, y: 1 }, BuildingKind::Depot, facing).unwrap();
    world.orient(depot);
    let mut game = game(world);
    let ferry = game.world.ferry_of(harbour).unwrap();
    let lorry = lorries_of(&game.world, depot)[0];
    let day = DAY_MS as u64;
    while car_of(&game.world, ferry).spot.is_none() && game.step_to(day) {}
    while car_of(&game.world, ferry).spot.is_some() && game.step_to(day) {}
    let (sailed, hour) = (game.now, day / 24);
    let left = |w: &World| crate::haul::packages(w).iter().filter(|(t, ..)| !t.outbound).count();
    let mut parked_home = None;
    while left(&game.world) > 0 && game.step_to(sailed + 8 * hour) {
        let (c, now) = (car_of(&game.world, lorry), game.now);
        match (c.trip.is_none() && game.world.claims.get(&lorry) == Some(&depot), parked_home) {
            (true, None) => parked_home = Some(now),
            (false, Some(at)) => {
                assert!(now - at <= (crate::haul::LOAD as u64 + 1) * crate::world::HANDLE_MS, "the lorry stood {} ms at home", now - at);
                parked_home = None;
            }
            _ => {}
        }
    }
    assert_eq!(left(&game.world), 0, "{} packages still out after eight hours", left(&game.world));
    eprintln!("the starter pack home in {:.2} hours", (game.now - sailed) as f64 / hour as f64);
}

/// A lorry on its way to the quay is scrapped, as one is when the road
/// under it is taken up and no way home is left: the load it was after
/// is the next lorry's. Its claim once outlived it, and the depot's
/// other lorries, finding the quay's first load taken, stood at home
/// for good.
#[test]
fn a_lorry_scrapped_on_its_way_leaves_its_load() {
    let mut world = street();
    let harbour = harbour_of(&world);
    let x = HARBOUR_X - 12;
    let facing = world.site_for(GridCoord { x, y: 1 }, BuildingKind::Depot).unwrap();
    let depot = world.place_building(GridCoord { x, y: 1 }, BuildingKind::Depot, facing).unwrap();
    world.orient(depot);
    let mut game = game(world);
    crate::haul::buy_lorry(&mut game.world, &mut game.events, depot, 0);
    let ferry = game.world.ferry_of(harbour).unwrap();
    let day = DAY_MS as u64;
    while car_of(&game.world, ferry).spot.is_none() && game.step_to(day) {}
    while car_of(&game.world, ferry).spot.is_some() && game.step_to(day) {}
    let going = |w: &World| lorries_of(w, depot).into_iter().find(|&l| car_of(w, l).trip.as_ref().is_some_and(|t| t.destination == harbour));
    while going(&game.world).is_none() && game.step_to(day) {}
    let scrapped = going(&game.world).expect("a lorry went for the starter pack");
    game.world.despawn_car(scrapped);
    let until = game.now + DAY_MS as u64 / 24;
    while going(&game.world).is_none() && game.step_to(until) {}
    assert!(going(&game.world).is_some(), "no lorry went for the starter pack after one was scrapped");
}

/// The first half hour of play, as the beats `docs/plan-opening.md`
/// asks of it, timed in real minutes (a day is twenty), for a player who
/// joins at midnight, at nine and at six in the evening: a shared server's
/// clock is not the newcomer's to choose. The hand plays the opening as a
/// quick player would, ten seconds' thought before each move, and does
/// what each mission asks the moment it opens if the trunk asks it; what
/// the town's situation asks it only notes. Prints when each beat came
/// against when it should; asserts nothing yet, the numbers are what it
/// is for.
#[test]
#[ignore]
fn first_half_hour() {
    let hour = DAY_MS as GameTime / 24;
    for join in [0, 9, 18] {
        let beats = half_hour_from(join * hour);
        let clock = |t: GameTime| format!("{:>2}:{:02}", t / 60_000, (t / 1_000) % 60);
        eprintln!("\njoined at {join}:00, the first half hour in real minutes (a day is twenty)\n");
        for (t, what) in &beats {
            eprintln!("  {}  {what}", clock(*t));
        }
    }
    eprintln!("\nplan-opening.md asks: a road by 0:30, goods on a pad by 1:00, coins by 3:00,");
    eprintln!("a problem the player did not ask for by 5:00, a new kind every 3 to 5 minutes.");
}

/// The beats of a first half hour from `join`, each at how long after it.
fn half_hour_from(join: GameTime) -> Vec<(GameTime, String)> {
    use crate::missions::Key;
    let think = 10_000;
    let half_hour = 30 * 60_000;
    let mut world = street();
    // The fixture's harbour was built at midnight; its first ferry is due
    // as if it was built at the join.
    let harbour = harbour_of(&world);
    for f in world.ferries_of(harbour) {
        if let Some(c) = world.car_mut(f) {
            c.due += join;
        }
    }
    let mut game = Game::new(world, join, 1, Box::new(World::new));
    game.connect(PLAYER, PLAYER);
    let mut beats: Vec<(GameTime, String)> = vec![];
    let beat = |beats: &mut Vec<(GameTime, String)>, at: GameTime, what: &str| {
        if !beats.iter().any(|(_, w)| w == what) {
            beats.push((at.saturating_sub(join), what.to_string()));
        }
    };
    let (mut depot, mut mill, mut sold) = (None, None, false);
    let mut houses: Vec<EntityId> = vec![];
    let mut last = join;
    let mut acted: Vec<Key> = vec![];
    let mut seen: Vec<Key> = vec![];
    let steps = |w: &World| w.missions.list.iter().find(|m| m.key == Key::Opening).map(|m| m.steps.iter().map(|s| s.done).collect::<Vec<_>>()).unwrap_or_default();
    let site = |w: &World, b: EntityId| building_of(w, b).site.is_some();
    while game.now < join + half_hour {
        let now = game.now;
        // The hand moves once it has thought, and the lorry only when it
        // is free.
        let ready = now >= last + think;
        // The lorry comes on the first ferry.
        let lorry = crate::haul::mayors(&game.world);
        if lorry.is_some() {
            beat(&mut beats, now, "your lorry on the quay");
        }
        let idle = lorry.is_some_and(|l| car_of(&game.world, l).errand.is_none() && car_of(&game.world, l).trip.is_none());
        let timber_on_quay = building_of(&game.world, harbour).pad.iter().filter(|t| t.good == Good::Timber && !t.outbound).count();
        if ready && mill.is_none() {
            mill = Some(sawmill(&mut game.world, SAWMILL_X));
            last = now;
            beat(&mut beats, now, "sawmill placed, a site");
        } else if let (true, true, Some(m)) = (ready, idle, mill) {
            if site(&game.world, m) && timber_on_quay >= 2 {
                game.command(PLAYER, ClientMessage::Haul { from: harbour, good: Good::Timber, packages: 2, to: m });
                last = now;
                beat(&mut beats, now, "the gift's timber sent to the sawmill");
            } else if !site(&game.world, m) && houses.is_empty() {
                for x in [SAWMILL_X - 6, SAWMILL_X - 9] {
                    let at = GridCoord { x, y: 1 };
                    let facing = game.world.site_for(at, BuildingKind::House).unwrap();
                    let h = game.world.place_building(at, BuildingKind::House, facing).unwrap();
                    game.world.orient(h);
                    houses.push(h);
                }
                last = now;
                beat(&mut beats, now, "2 houses placed");
            } else if let Some(&h) = houses.iter().find(|&&h| site(&game.world, h)) {
                game.command(PLAYER, ClientMessage::Haul { from: m, good: Good::Timber, packages: 1, to: h });
                last = now;
                beat(&mut beats, now, "a bundle sent to a house");
            } else if !houses.is_empty() && !sold {
                game.command(PLAYER, ClientMessage::Haul { from: m, good: Good::Timber, packages: 1, to: harbour });
                sold = true;
                last = now;
                beat(&mut beats, now, "a bundle sent to the quay to sell");
            } else if sold && depot.is_none() {
                let x = HARBOUR_X - 12;
                let world = &mut game.world;
                let facing = world.site_for(GridCoord { x, y: 1 }, BuildingKind::Depot).unwrap();
                let d = world.place_building(GridCoord { x, y: 1 }, BuildingKind::Depot, facing).unwrap();
                world.orient(d);
                depot = Some(d);
                last = now;
                beat(&mut beats, now, "depot placed");
            }
        }
        if timber_on_quay > 0 {
            beat(&mut beats, now, "the gift on the quay");
        }
        if let Some(m) = mill.filter(|&m| !site(&game.world, m)) {
            beat(&mut beats, now, "the sawmill stands");
            if game.world.staff(m).iter().any(|&r| at_of(&game.world, r) == Some(m)) {
                beat(&mut beats, now, "the sawmill at work");
            }
        }
        if houses.len() == 2 && houses.iter().all(|&h| !site(&game.world, h)) {
            beat(&mut beats, now, "both houses stand");
        }
        if let Some(d) = depot {
            if building_of(&game.world, d).stocks.values().any(|s| s.level > 0.0) {
                beat(&mut beats, now, "goods in the depot, by its own lorry");
            }
        }
        if game.world.lumps.iter().any(|l| l.coins > 0.0) {
            beat(&mut beats, now, "first coins in");
        }
        for m in game.world.missions.list.clone() {
            if !seen.contains(&m.key) {
                seen.push(m.key);
                let what = match m.key {
                    Key::Opening | Key::Book => format!("mission: {}", m.title),
                    Key::Order(_) => "first letter".to_string(),
                    _ => format!("problem: {}", m.title),
                };
                if !matches!(m.key, Key::Order(_)) || !beats.iter().any(|(_, w)| w == "first letter") {
                    beat(&mut beats, m.opened, &what);
                }
            }
            if let Some(f) = m.finished {
                if !matches!(m.key, Key::Order(_)) {
                    beat(&mut beats, f, &format!("done: {}", m.title));
                }
            }
            // The trunk's asks, done after a moment's thought.
            if m.finished.is_none() && now >= m.opened + think && !acted.contains(&m.key) {
                match m.key {
                    Key::Book => game.command(PLAYER, ClientMessage::Trade { good: Good::Fuel, packages: 1, out: false }),
                    _ => continue,
                }
                acted.push(m.key);
            }
        }
        if steps(&game.world).get(2) == Some(&true) {
            beat(&mut beats, now, "first settlers home");
        }
        if steps(&game.world).get(3) == Some(&true) {
            beat(&mut beats, now, "the first sale paid");
        }
        game.step_to(now + 1_000);
    }
    beats.sort_by_key(|(t, _)| *t);
    beats
}
