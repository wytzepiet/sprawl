/// Wakes one resident may take in a day; `a_town_thinks_within_budget`
/// prints what the towns take. With the overtake bug of 2026-09-04 put
/// back they took 146 and 231 in a day, and thousands once the storm has
/// grown. A change that legitimately moves the count moves this number
/// with it, on purpose.
pub(crate) const WAKE_BUDGET: u64 = 120;
use super::*;
use std::time::Instant;
use model::{Build, BuildingKind, Good, GridCoord, Tool};
use land::TerrainType;

/// What a test's hand does: a step of road or the demolisher, or a
/// building placed whole round a tile, the first way it fits.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Do {
    Step(Tool, GridCoord, GridCoord),
    Place(BuildingKind, GridCoord),
    /// The building on a tile taken down whole.
    Raze(GridCoord),
}
/// The hand's act done, as a player's command is; a building refused is
/// a test gone wrong.
pub(crate) fn does(game: &mut Game, d: Do) {
    let message = match d {
        Do::Step(tool, from, to) => ClientMessage::Build(Build { tool, from, to, up: None, sides: None, road: false }),
        Do::Place(kind, at) => ClientMessage::Place { kind, at, facing: None },
        Do::Raze(at) => ClientMessage::Raze { building: game.world.map.occupied[&(at.x, at.y)] },
    };
    game.command(PLAYER, message);
    if let Do::Place(kind, at) = d {
        assert!(game.world.map.occupied.contains_key(&(at.x, at.y)), "{kind:?} at {at:?} refused: {:?}", game.take_outbox());
    }
}

/// The one at the tests' game: client and owner both.
pub(crate) const PLAYER: ClientId = 0;

/// A world brought to life as the game brings one, its clock at nought,
/// and a player at it: a town that may build anything.
pub(crate) fn game(mut world: World) -> Game {
    world.research = crate::research::Research::all();
    let mut game = Game::new(world, 0, 1, Box::new(World::new));
    game.connect(PLAYER, PLAYER);
    game
}

pub(crate) fn at_of(world: &World, id: EntityId) -> Option<EntityId> {
    world.map.resident(id)?.at
}

pub(crate) fn doing(world: &World, id: EntityId) -> Option<model::needs::Need> {
    world.map.resident(id)?.selected
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
                world.map.terrain.insert((x, y), if sea { TerrainType::Sea } else { TerrainType::Grass });
            }
        }
    }
    let street: Vec<GridCoord> = (-2..HARBOUR_X + 6).map(|x| GridCoord { x, y: 0 }).collect();
    world.map.place_road_path(&street);
    // A back street, and lanes between the two every forty tiles, so a
    // lorry turns round in a block, not at the end of the world.
    world.map.place_road_path(&(-2..HARBOUR_X + 6).map(|x| GridCoord { x, y: -9 }).collect::<Vec<_>>());
    for x in (-2..HARBOUR_X + 6).step_by(40) {
        world.map.place_road_path(&(-9..=0).map(|y| GridCoord { x, y }).collect::<Vec<_>>());
    }
    world.map.place_on_street(GridCoord { x: HARBOUR_X, y: 1 }, BuildingKind::Harbour).expect("the coast takes a harbour");
    world
}

pub(crate) fn harbour_of(world: &World) -> EntityId {
    *world.map.occupied.get(&(HARBOUR_X, 1)).expect("the street's harbour")
}

pub(crate) fn build(world: &mut World, x: i32, kind: BuildingKind) -> EntityId {
    world.map
        .place_on_street(GridCoord { x, y: 1 }, kind)
        .unwrap_or_else(|| panic!("the street should give a {kind:?} at x={x} its driveway"))
}

/// Where a car stands on the map, and how fast it goes along its route.
pub(crate) fn whereabouts(world: &World, car: EntityId, now: GameTime) -> Option<([f64; 2], f64, usize)> {
    let GameObject::Car(ref c) = world.map.objects.get(car)?.object else { return None };
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
            let mut world = World::from(map::Map::meadow(-4..50, -4..12).street(-4..50));
            let home = build(&mut world, 10, BuildingKind::House);
            let from = build(&mut world, from_x, BuildingKind::House);
            let shop = build(&mut world, dest_x, BuildingKind::Shop);
            let mut game = game(world);
            let car = |world: &mut World, at: EntityId| {
                let c = world.map.insert_at(GameObject::Car(model::Car::new(0, Default::default())), world.map.objects.get(at).unwrap().position);
                world.map.park_in_lot(at, c, 0);
                c
            };
            let (backer, through) = (car(&mut game.world, home), car(&mut game.world, from));
            let s = game.world.map.approach(from).unwrap();
            assert!(game.world.drive(&mut game.events, |t, e| traffic::car::spawn::start_trip(t, e, through, s, shop, 0, GameTime::MAX)));
            let mut out = false;
            while game.now < 60_000 {
                if !out && game.now >= start {
                    let s = game.world.map.approach(home).unwrap();
                    out = game.world.drive(&mut game.events, |t, e| traffic::car::spawn::start_trip(t, e, backer, s, shop, game.now, GameTime::MAX));
                }
                game.step_to(game.now + 50);
                let (world, now) = (&game.world, game.now);
                let (a, b) = (whereabouts(world, backer, now), whereabouts(world, through, now));
                if let Some((_, v, k)) = a {
                    if k == 1 {
                        assert!(v <= traffic::car::REVERSE_SPEED + 0.06, "backing at {v:.2} (start {start})");
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
    let people = game.world.map.resident_ids();
    assert_eq!(people.len(), 2);

    let shift = model::blueprint::blueprint(BuildingKind::Shop).taps
        .iter()
        .find(|t| t.need == model::needs::Need::Work)
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
pub(crate) type Move = (GameTime, EntityId, Option<EntityId>, Option<model::needs::Need>);

pub(crate) fn arrival_log(days: u64) -> Vec<Move> {
    let mut world = street();
    build(&mut world, 0, BuildingKind::Apartment);
    build(&mut world, 6, BuildingKind::Apartment);
    build(&mut world, 30, BuildingKind::Shop);
    // Twelve desks in three labs.
    let labs = [54, 57, 60].map(|x| build(&mut world, x, BuildingKind::Lab));
    // Lunch: a shop beside the labs, too far from home to staff.
    let lunch = build(&mut world, 64, BuildingKind::Shop);
    // Fuel, or every few days the town goes without.
    build(&mut world, 18, BuildingKind::GasStation);

    let mut game = game(world);
    // Fourteen households in the two blocks, and three desks over that
    // stay empty: nobody comes from beyond the town for a job.
    let people = game.world.map.resident_ids();
    assert_eq!(people.len(), 14);

    let mut log = Vec::new();
    let mut last: Vec<Option<EntityId>> = people.iter().map(|_| None).collect();
    let mut last_doing: Vec<(Option<EntityId>, Option<model::needs::Need>)> = people.iter().map(|_| (None, None)).collect();
    while game.step_to(days * DAY_MS as u64) {
        let (world, now) = (&game.world, game.now);
        for (i, &id) in people.iter().enumerate() {
            let at = at_of(world, id);
            // `TRACE=1 cargo test the_same_town -- --nocapture` prints
            // the last day's log, one line a move or a change of mind,
            // to read by hand.
            if std::env::var("TRACE").is_ok() && now >= (days - 1) * DAY_MS as u64 && (at, doing(world, id)) != last_doing[i] {
                eprintln!("{i} {} {:?} {:?}", crate::card::hhmm(world.map.resident(id).unwrap().last_update), at.and_then(|a| world.map.building(a)).map(|b| b.kind), doing(world, id));
                last_doing[i] = (at, doing(world, id));
            }
            if at != last[i] {
                log.push((now, id, at, doing(world, id)));
                last[i] = at;
            }
        }
    }
    // Section 6, the demand side. Nobody here wants for anything, and
    // the labs' books show what they received on the last whole day:
    // eleven people, nine hours, less the lunches — and the lunch shop
    // served them. The last day, not the second: a settled one.
    let (world, now) = (&game.world, game.now);
    if days >= 3 {
        wants_nothing(world, now);
        let sold = |b: EntityId, need| world.books[&b].before(now).served.get(&need).copied().unwrap_or(0.0);
        let desks: f64 = labs.iter().map(|&l| sold(l, model::needs::Need::Work)).sum();
        // Eleven at the labs: fourteen people, two apartments of
        // seven, less the shop's two and the pump's one, nine hours
        // each, less the odd late morning, a lunch out, a dinner near
        // work, and the minute or two parking at the kerb.
        assert!((70.0..=99.0).contains(&desks), "the labs received {desks}h");
        // Lunches over a whole day: the shops have no depot here, so
        // by the third day their shelves have run down some.
        assert!(sold(lunch, model::needs::Need::Eat) > 1.5, "lunch shop sold {}h", sold(lunch, model::needs::Need::Eat));
    }
    log
}

/// Nobody wants for anything: everyone has a job, and whatever they
/// owe of a need of their own that runs down has somewhere to be met.
pub(crate) fn wants_nothing(world: &World, now: GameTime) {
    for e in world.map.objects.iter() {
        let GameObject::Resident(ref r) = e.object else { continue };
        let needs = crate::resident::needs(world, e.id, now);
        assert!(r.work.is_some(), "{needs:?}");
        let owed = |n: &&model::card::NeedLine| r.buckets.iter().any(|b| b.need.drain() > 0.0 && b.need == n.need) && n.full < 1.0;
        assert!(needs.iter().filter(owed).all(|n| n.option.is_some()), "{needs:?}");
    }
}

#[test]
fn cars_stop_for_fuel_now_and_then() {
    let mut world = street();
    build(&mut world, 0, BuildingKind::Apartment);
    build(&mut world, 6, BuildingKind::Apartment);
    for x in [54, 57, 60] {
        build(&mut world, x, BuildingKind::Lab);
    }
    build(&mut world, 40, BuildingKind::Shop);
    let station = build(&mut world, 30, BuildingKind::GasStation);

    let mut game = game(world);
    let people = game.world.map.resident_ids();

    let day = DAY_MS as u64;
    let mut stops = 0;
    let mut last: Vec<(Option<EntityId>, Option<model::needs::Need>)> = people.iter().map(|_| (None, None)).collect();
    while game.step_to(6 * day) {
        let world = &game.world;
        for (i, &id) in people.iter().enumerate() {
            let state = (at_of(world, id), doing(world, id));
            if state != last[i] {
                if state == (Some(station), Some(model::needs::Need::Fuel)) {
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
    use model::blueprint::{blueprint, ground};
    // A mine or a well stands only over what it digs, never on a street.
    BuildingKind::ALL.into_iter().filter(|&k| !blueprint(k).quay && !blueprint(k).makes.and_then(ground).is_some_and(|(_, d)| d.is_some())).collect()
}

/// A town shaped like a town, for the seasons: mostly homes, labs for
/// desks,
/// shops, a pump, a supermarket, and a farm and a warehouse to feed
/// them. Forty plots. `placeable` cycles every kind equally, which is
/// a shop or a depot for every home — the mix for a wake budget, not
/// for a town.
pub(crate) fn town_mix() -> Vec<BuildingKind> {
    use BuildingKind::*;
    vec![
        House, Apartment, Lab, House, Apartment, Shop, House, Lab, Apartment, House,
        House, Apartment, House, Shop, Lab, House, Apartment, House, House, Bakery,
        Apartment, House, GasStation, Apartment, Lab, House, Supermarket, Apartment, House, Lab,
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
    let home = world.map
        .place_building(GridCoord { x: 10, y: 3 }, BuildingKind::House, 2)
        .expect("land is land");
    world.map.finish(home);
    let mut game = game(world);
    assert!(game.world.map.resident_ids().is_empty(), "nobody lives where no road goes");

    // The mayor draws a street to it, tile by tile, as the brush does.
    for (from, to) in [
        (GridCoord { x: 10, y: 0 }, GridCoord { x: 10, y: 1 }),
        (GridCoord { x: 10, y: 1 }, GridCoord { x: 10, y: 2 }),
        // Onto the plot: a road that ends on one is a driveway.
        (GridCoord { x: 10, y: 2 }, GridCoord { x: 10, y: 3 }),
    ] {
        does(&mut game, Do::Step(Tool::Street, from, to));
    }
    assert!(game.world.map.street_of(home).is_some(), "the driveway formed itself");

    // Which is what the step after it settles for, once, after the batch.
    game.step();
    assert_eq!(
        game.world.map.resident_ids().len(),
        model::blueprint::blueprint(BuildingKind::House).homes as usize,
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
        x += model::blueprint::plot(kind, 0).size.0 as i32 + 1;
    }
    // A second lorry for each depot.
    let depots: Vec<EntityId> = world.map.objects.iter().filter(|e| matches!(e.object, GameObject::Building(ref b) if b.kind == BuildingKind::Depot)).map(|e| e.id).collect();
    for d in depots {
        if let Some(b) = world.map.building_mut(d) {
            b.lorries = 1;
        }
    }
    let mut game = game(world);
    assert!(!game.world.map.harbours.is_empty(), "no harbour, or nobody can arrive at all");
    // A day at a time, so the look at the end of each is on the tick
    // that turns it, with the midnight wake taken.
    for day in 1..=days {
        game.run_to(day * DAY_MS as u64);
        let (world, now) = (&game.world, game.now);
        // A town that gridlocks is not a town being measured: nobody is
        // a day late for anything. Two driveways two tiles apart held
        // each other for good on the third day, once the desks' cars
        // were on the street, until claims lapsed (docs/parking.md §9).
        let stuck = world.map.objects.iter().filter(|e| matches!(e.object, GameObject::Car(ref c) if c.trip.as_ref().is_some_and(|t| now > t.eta + DAY_MS as u64))).count();
        assert_eq!(stuck, 0, "day {day}: {stuck} cars a day past their due time — the street has gridlocked");
        each_day(world, day, game.thoughts);
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
    for (name, mix) in [("full", &every_kind[..]), ("bare", &[BuildingKind::House, BuildingKind::Lab][..])] {
        let (world, wakes) = live(mix, 1);
        let residents = world.map.resident_ids().len() as u64;
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
            wide.map.terrain.insert((x, y), TerrainType::Grass);
        }
        wide.map.place_road_path(&(0..300).map(|x| GridCoord { x, y }).collect::<Vec<_>>());
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
        world.map.resident_ids().len(),
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
                world.map.terrain.insert((x, y + dy), TerrainType::Grass);
            }
        }
        world.map.place_road_path(&(-2..400).map(|x| GridCoord { x, y: dy }).collect::<Vec<_>>());
        world.map.open_exit(world.map.road_node_at(GridCoord { x: 0, y: dy }).unwrap());
        let mut x = 0;
        for kind in &mix {
            world.map.place_on_street(GridCoord { x, y: dy + 1 }, *kind).expect("the street gives it a driveway");
            x += model::blueprint::plot(*kind, 0).size.0 as i32 + 1;
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
            let id = *game.world.map.occupied.get(&(x, -1)).unwrap_or_else(|| panic!("the {kind:?} went down"));
            // Its timber in, it stands, and the settle that follows is
            // part of what it cost.
            game.world.map.finish(id);
            let stood = timed(&mut game, Vec::new());
            costs[2 * k].1.push(placed + stood);
            let bp = model::blueprint::blueprint(kind);
            assert_eq!((game.world.map.household(id).len(), game.world.map.staff(id).len()), (bp.homes as usize, bp.jobs as usize), "the {kind:?} filled");
            // Taken down.
            costs[2 * k + 1].1.push(timed(&mut game, vec![Do::Raze(at(x, -1))]));
            assert!(game.world.map.objects.get(id).is_none(), "the {kind:?} came down");
        }
        let steps = (0..4).map(|y| Do::Step(Tool::Street, at(x + 6, -y), at(x + 6, -y - 1))).collect();
        costs[4].1.push(timed(&mut game, steps));
    }
    let costs: Vec<(&'static str, f64)> = costs
        .into_iter()
        .map(|(what, v)| (what, v.into_iter().fold(f64::INFINITY, f64::min)))
        .collect();
    println!("{copies} town(s), {} residents: {}", game.world.map.resident_ids().len(), costs.iter().map(|(what, c)| format!("{what} {c:.0} µs")).collect::<Vec<_>>().join(", "));
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
    map::fixtures::build(&mut world.map, &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures"));
    let mut game = Game::new(world, map::fixtures::NOON, 1, Box::new(World::new));
    let (mut settles, mut others) = (Vec::new(), Vec::new());
    for _ in 0..DAY_MS as GameTime / 4 / STEP_MS {
        let settling = game.now % SETTLE_MS == 0 || !game.world.map.unsettled.is_empty();
        let started = Instant::now();
        game.step();
        (if settling { &mut settles } else { &mut others }).push(started.elapsed().as_secs_f64() * 1e6);
    }
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    println!(
        "{} objects: {} settles {:.0} µs each (worst {:.0}), {} other steps {:.1} µs each",
        game.world.map.objects.len(),
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
    let jobless = world.map.objects.iter().filter(|e| matches!(e.object, GameObject::Resident(ref r) if r.work.is_none())).count();
    for e in world.map.objects.iter() {
        let GameObject::Building(ref b) = e.object else { continue };
        if b.site.is_some() {
            continue;
        }
        let bp = model::blueprint::blueprint(b.kind);
        let reached = world.map.street_of(e.id).is_some();
        let want = |n: u32| if reached { n as usize } else { 0 };
        assert_eq!(world.map.household(e.id).len(), want(bp.homes), "after {after}: {:?} {} (reached {reached}) houses the wrong number", b.kind, e.id);
        // A desk stays empty only while nobody in town is out of work.
        assert!(world.map.staff(e.id).len() <= want(bp.jobs), "after {after}: {:?} {} (reached {reached}) staffs too many", b.kind, e.id);
        assert!(world.map.staff(e.id).len() == want(bp.jobs) || jobless == 0, "after {after}: {:?} {} has a desk free and {jobless} out of work", b.kind, e.id);
    }
    for id in world.map.resident_ids() {
        let Some(r) = world.map.resident(id) else { continue };
        for b in std::iter::once(r.home).chain(r.work) {
            assert!(world.map.street_of(b).is_some(), "after {after}: resident {id} is tied to {b}, which no road reaches");
            assert!(world.map.people.get(&b).is_some_and(|p| p.contains(&id)), "after {after}: the index lost resident {id} at {b}");
        }
        assert!(matches!(world.map.objects.get(r.car).map(|e| &e.object), Some(GameObject::Car(_))), "after {after}: resident {id} has no car");
    }
    for (&b, people) in &world.map.people {
        for &id in people {
            assert!(matches!(world.map.objects.get(id).map(|e| &e.object), Some(GameObject::Resident(r)) if r.home == b || r.work == Some(b)), "after {after}: the index ties {id} to {b}");
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
    for (x, kind) in [(0, BuildingKind::House), (3, BuildingKind::House), (6, BuildingKind::Apartment), (12, BuildingKind::Shop), (30, BuildingKind::Lab)] {
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
    // Placed across the street: two houses and a lab.
    act(&mut game, Do::Place(BuildingKind::House, at(20, -1)));
    act(&mut game, Do::Place(BuildingKind::House, at(24, -1)));
    act(&mut game, Do::Place(BuildingKind::Lab, at(41, -1)));
    // The lab and a house taken down, and the street before a third
    // taken up and laid again.
    act(&mut game, Do::Raze(at(40, -1)));
    assert!(!game.world.map.occupied.contains_key(&(41, -1)), "the lab stands");
    act(&mut game, Do::Raze(at(0, 1)));
    let street_of = |world: &World, x, y| {
        let (_, street) = world.map.door_of(*world.map.occupied.get(&(x, y)).unwrap()).expect("placed with a door");
        world.map.objects.get(street).unwrap().position.unwrap()
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
    assert!(game.world.map.street_of(game.world.map.occupied[&(24, -1)]).is_none(), "the street went");
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
    use model::needs::Need;
    let days = season_days();
    // The mountain behind the quarry's plot, and the woods behind the
    // sawmill's, beyond the town's forty.
    let mut world = street();
    for (x0, ground) in [(QUARRY_X, TerrainType::Mountain), (SAWMILL_X, TerrainType::Forest)] {
        for x in x0 - 5..x0 + 7 {
            for y in 5..14 {
                world.map.terrain.insert((x, y), ground);
            }
        }
    }
    let quarry = build(&mut world, QUARRY_X, BuildingKind::Quarry);
    build(&mut world, QUARRY_X + 4, BuildingKind::Quarry);
    let sawmill = build(&mut world, SAWMILL_X, BuildingKind::Sawmill);
    // The flats stand on cement, burnt from the quarries' stone.
    build(&mut world, SAWMILL_X + 10, BuildingKind::CementWorks);
    let mut stood = 0;
    // Each midnight, a block of flats across the street, and a side
    // street beside it.
    let hand = |_: &World, day: u64| -> Steps {
        let x = 112 + 4 * (day as i32 - 1);
        let at = |x, y| GridCoord { x, y };
        vec![
            Do::Place(BuildingKind::Apartment, at(x + 1, -1)),
            Do::Step(Tool::Street, at(x + 2, 0), at(x + 2, -1)),
            Do::Step(Tool::Street, at(x + 2, -1), at(x + 2, -2)),
            Do::Step(Tool::Street, at(x + 2, -2), at(x + 2, -3)),
        ]
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
        let flats = |site: bool| world.map.objects.iter().filter(|e| matches!(e.object, GameObject::Building(ref b) if b.kind == BuildingKind::Apartment && b.tiles[0].y < 0 && b.site.is_some() == site)).count();
        stood = flats(false);
        let waiting: Vec<_> = world.calls.iter().filter(|c| matches!(world.map.objects.get(c.at).map(|e| &e.object), Some(GameObject::Building(b)) if b.site.is_some())).collect();
        assert_eq!(stood as u64, day - 1, "day {day}: {} sites still waiting; calls {waiting:?}", flats(true));
        let level = |id: EntityId, good: Good| match world.map.objects.get(id).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.stocks.get(&good).map_or(0.0, |s| s.level),
            _ => 0.0,
        };
        let depot = world.map.objects.iter().find(|e| matches!(e.object, GameObject::Building(ref b) if b.kind == BuildingKind::Depot)).map(|e| e.id).unwrap();
        println!(
            "  built: {stood} blocks of flats; yards: quarry {:.0} stone, sawmill {:.0} timber; depot {:.0} stone, {:.0} timber; bought {:.1?}",
            level(quarry, Good::Stone),
            level(sawmill, Good::Timber),
            level(depot, Good::Stone),
            level(depot, Good::Timber),
            page.bought,
        );
        let mut empty = Vec::new();
        // What the town has a use for: what its counters serve and its
        // works open, and the materials its sites are built of. A
        // depot keeps a shelf of every good, but only these are called for.
        let used: std::collections::BTreeSet<Good> = world
            .map
            .objects
            .iter()
            .filter_map(|e| match e.object {
                GameObject::Building(ref b) if !model::blueprint::depot(b.kind) => Some(b.kind),
                _ => None,
            })
            .flat_map(|k| model::blueprint::shelves(k).into_iter().filter(move |&g| crate::economy::buys(k, g)))
            .chain([Good::Timber, Good::Stone])
            .collect();
        for e in world.map.objects.iter() {
            let GameObject::Building(ref b) = e.object else { continue };
            for (&good, stock) in &b.stocks {
                // A farm's yard is meant to empty: a lorry takes it.
                if model::blueprint::makes(b.kind, good) || !used.contains(&good) {
                    continue;
                }
                if stock.level <= 0.0 {
                    empty.push(format!("{:?} {} {good:?}", b.kind, e.id));
                }
                let days = stood_empty((e.id, format!("{good:?}")), stock.level <= 0.0, day);
                assert!(days < 1, "day {day}: {:?} {}'s {good:?} has stood empty two midnights running; calls {:?}", b.kind, e.id, world.calls);
            }
        }
        for e in world.map.objects.iter() {
            let GameObject::Car(ref c) = e.object else { continue };
            if c.role == model::CarRole::Private {
                let dry = c.stocks.get(&Need::Fuel).is_some_and(|s| s.level <= 0.0);
                assert!(stood_empty((e.id, "tank".into()), dry, day) < 1, "day {day}: car {} has stood dry two midnights running", e.id);
            }
        }
        // Fed: the hours of eating everyone in town did yesterday, at
        // home or out, against what a day asks of each of them.
        let eaten: f64 = world.books.values().map(|k| k.before(midnight).served.get(&Need::Eat).copied().unwrap_or(0.0)).sum();
        let asked = world.map.resident_ids().len() as f64 * Need::Eat.daily_ms() / (DAY_MS as f64 / 24.0);
        // Hours served out of the house, per need: work, eating out,
        // filling up.
        let mut out: std::collections::BTreeMap<Need, f64> = Default::default();
        for (id, k) in &world.books {
            if matches!(world.map.objects.get(*id).map(|e| &e.object), Some(GameObject::Building(b)) if model::blueprint::blueprint(b.kind).homes == 0) {
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
            for h in sea["harbours"].as_array().unwrap().iter().filter(|h| h["park"].is_array()) {
                let park: Vec<String> = h["park"].as_array().unwrap().iter().map(|t| if t.is_null() { "_".into() } else { format!("{}{}", t["good"].as_str().map_or("E", |g| &g[..1]), if t["outbound"].as_bool().unwrap() { "^" } else { "" }) }).collect();
                println!("  park {} deck {} booked {}", park.join(""), h["ferry"]["deck"].as_array().unwrap().iter().filter(|t| !t.is_null()).count(), h["ferry"]["booked"].as_array().unwrap().len());
            }
            for l in sea["lorries"].as_array().unwrap() {
                println!("  lorry {} to {} hitched {}", l["id"], l["to"], l["hitched"]);
            }
            for e in world.map.objects.iter() {
                if let GameObject::Building(ref b) = e.object
                    && matches!(b.kind, BuildingKind::Depot | BuildingKind::Farm | BuildingKind::Bakery | BuildingKind::CementWorks)
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
    let sold = world.town.season().map(|p| p.sold.get(&Good::Grain).copied().unwrap_or(0.0)).sum::<f64>();
    println!("the season: treasury {:.1}, grain sold to the world for {sold:.1}, {stood} sites stood", world.treasury);

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
    // home. The shop workers eat where they stand; the labs have a
    // shop next door, so their workers drive to it.
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
    use model::Stage;
    let mut world = street();
    build(&mut world, 0, BuildingKind::House);
    build(&mut world, 3, BuildingKind::House);
    let farm = build(&mut world, 10, BuildingKind::Farm);
    let depot = build(&mut world, 30, BuildingKind::Depot);
    let mut game = game(world);
    game.world.treasury = 1000.0;
    let yard = |world: &World| world.map.building(farm).unwrap().stocks[&Good::Grain].level;
    let stages = |world: &World| -> Vec<Stage> { world.map.building(farm).unwrap().land.iter().map(|t| t.stage).collect() };
    let world = &game.world;
    let wanted = map::fields::capacity(BuildingKind::Farm) as usize;
    assert!(stages(world).len() <= wanted && stages(world).len() > wanted * 9 / 10, "the farm claimed {} tiles of {wanted}", stages(world).len());
    assert_eq!(yard(world), 0.0, "the yard is founded with a make");
    let hands = world.map.resident_ids().into_iter().filter(|&id| world.map.resident(id).is_some_and(|r| r.work == Some(farm))).count();
    assert!(hands > 0, "the farm hired nobody");
    let tractor = world.map.objects.fleet(farm).next().expect("the farm keeps a tractor");
    assert!(world.map.car(tractor).is_some_and(|c| c.role == model::CarRole::Tractor));
    // The first day: the hands come at six and the tractor ploughs
    // the land, a shift's worth; by evening it is a field, the tractor
    // is home, and the yard is empty.
    let day = DAY_MS as u64;
    let land = stages(world).len();
    let crop = model::blueprint::crop(BuildingKind::Farm, land);
    game.run_to(20 * day / 24);
    let world = &game.world;
    assert!(stages(world).iter().all(|&s| s == Stage::Ploughed), "by evening the land is {:?}", stages(world));
    assert!(stages(world).len() >= land * 9 / 10, "the plough reached {} of {land} tiles", stages(world).len());
    assert_eq!(yard(world), 0.0, "something landed in the yard before a harvest");
    assert!(world.map.car(tractor).is_some_and(|c| c.run.is_none() && c.trip.is_none()), "the tractor is not home");
    // The second day: seeded. The third, growing; the fourth: ripe by
    // morning, harvested by evening, a harvest in the yard, and a lorry
    // from beyond the edge called for it.
    game.run_to(day + 20 * day / 24);
    assert!(stages(&game.world).iter().all(|&s| s == Stage::Sown), "by the second evening the land is {:?}", stages(&game.world));
    assert_eq!(yard(&game.world), 0.0);
    game.run_to(3 * day + 5 * day / 24);
    assert_eq!(yard(&game.world), 0.0, "a harvest before the crop was ripe");
    // Ripe by the fourth morning, and cut that day: the whole harvest
    // made by evening, in the yard or already on its way to the world.
    game.run_to(3 * day + 20 * day / 24);
    let harvest = game.world.market.prices().flows.iter().find(|f| f.good == Good::Grain).map_or(0.0, |f| f.made);
    game.run_to(4 * day + 20 * day / 24);
    assert!((harvest - stages(&game.world).len() as f64 * crop).abs() < 1e-6, "the harvest came to {harvest}, not a yard's worth");

    // Then the depot's shelf runs low: its lorry fetches from the farm,
    // and no coin moves. The quay cleared first: the starter pack waits
    // there for the depot's room, and would be fetched first; and what
    // the town sold of the harvest, which there is no longer.
    let now = game.now;
    let harbour = harbour_of(&game.world);
    let quay = game.world.map.building_mut(harbour).unwrap();
    quay.pad.clear();
    quay.outgoing.clear();
    game.world.map.building_mut(farm).unwrap().stocks.get_mut(&Good::Grain).unwrap().level = 300.0;
    let before = yard(&game.world);
    let bought = |world: &World| world.town.on(now).bought.get(&Good::Grain).copied().unwrap_or(0.0);
    let bought_before = bought(&game.world);
    game.world.map.building_mut(depot).unwrap().stocks.get_mut(&Good::Grain).unwrap().level = 0.0;
    crate::haul::call_lorries(&mut game.world, &mut game.events);
    // Half a day: the lorry may be on its way to the quay with the
    // world's grain, the length of the street off and back.
    game.run_to(now + day / 2);
    let world = &game.world;
    assert!(building_of(world, depot).stocks[&Good::Grain].level > 0.0, "the fetch did not land; lorries {:?}", world.map.objects.iter().filter(|e| matches!(e.object, GameObject::Car(ref c) if c.role == model::CarRole::Truck)).map(|e| (e.id, e.position, matches!(e.object, GameObject::Car(ref c) if c.trip.is_some()))).collect::<Vec<_>>());
    let fetched = before - yard(world);
    assert!(fetched > 0.0, "the lorry took nothing from the yard");
    assert_eq!(bought(world), bought_before, "crates fetched in town were paid for");
}

/// A depot's lorries, by id.
fn lorries_of(world: &World, depot: EntityId) -> Vec<EntityId> {
    world.map.objects.fleet(depot).filter(|&c| world.map.car(c).is_some_and(|c| c.role == CarRole::Truck)).collect()
}

pub(crate) fn car_of(world: &World, id: EntityId) -> model::Car {
    world.map.car(id).cloned().unwrap_or_else(|| panic!("no car {id}"))
}

pub(crate) fn building_of(world: &World, id: EntityId) -> model::Building {
    world.map.building(id).cloned().unwrap_or_else(|| panic!("no building {id}"))
}

/// A harbour on a real coast, seed 7's, where the map's edge is two
/// hours' sail out: the world's line takes two ferries, so the
/// harbour is called at as often as the old ferry's 6.4 a day, the
/// two passing at sea, never both at the ramp, the second waiting
/// beyond the edge if it would be.
#[test]
fn a_real_coast_is_called_at_as_often_as_ever() {
    let mut world = World::new();
    world.map.terrain = land::terrain::generate(7);
    world.map.place_road_path(&(-6..10).map(|x| GridCoord { x, y: 32 }).collect::<Vec<_>>());
    let harbour = world.map.place_on_street(GridCoord { x: -2, y: 33 }, BuildingKind::Harbour).expect("seed 7's north coast takes a harbour");
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

/// The opening, docs/core.md: a harbour, a depot, a street between
/// them. The first ferry comes in on time with the starter pack and
/// the forklifts lift it onto the quay, for nothing; the depot's
/// lorry fetches a load and its forklift unloads it into the yard, and a second
/// lorry helps fetch the rest. A house is a site until a
/// van brings its timber; then its settlers come on the next ferry and
/// drive home. A block of flats wants cement the town has none of: the
/// town buys it by itself and pays as it lands; and the ferry keeps its
/// timetable throughout.
#[test]
fn the_opening_from_the_harbour() {
    use traffic::sea::DWELL;
    use crate::ferry::FIRST_CALL;
    let mut game = game(street());
    let harbour = harbour_of(&game.world);
    let x = HARBOUR_X - 12;
    let world = &mut game.world;
    let facing = world.map.site_for(GridCoord { x, y: 1 }, BuildingKind::Depot).unwrap();
    let depot = world.map.place_building(GridCoord { x, y: 1 }, BuildingKind::Depot, facing).unwrap();
    world.map.orient(depot);
    assert!(building_of(world, depot).site.is_none(), "the first depot is a site");
    assert!(building_of(world, depot).stocks.values().all(|s| s.level == 0.0), "the depot stood stocked");
    game.step();
    let world = &game.world;
    let ferry = world.ferry_of(harbour).expect("the harbour's ferry");
    let lorry = lorries_of(world, depot)[0];
    let starter: u32 = crate::ferry::STARTER.iter().map(|&(_, n)| n).sum();
    assert_eq!(car_of(world, ferry).booked.len(), starter as usize, "the starter pack is booked");
    // A settle with nothing new touches nothing: what it touches goes
    // to every client, and is written down, each tick.
    game.world.map.objects.drain_dirty();
    settle_and_wake(&mut game.world, &mut game.events);
    assert_eq!(game.world.map.objects.drain_dirty(), (vec![], vec![]), "a quiet settle changed something");
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
    assert!(quay(&game.world) >= 10, "only {} packages landed on the quay", quay(&game.world));
    assert_eq!(game.world.treasury, crate::economy::STAKE, "the starter pack was paid for");

    // The lorry fetches a load as it lands, and unloads it.
    let stock = |w: &World| building_of(w, depot).stocks.values().map(|s| s.level).sum::<f64>();
    let until = game.now + day / 12;
    while stock(&game.world) == 0.0 && game.step_to(until) {}
    assert!(stock(&game.world) > 0.0, "the lorry brought nothing home in two hours");
    assert!(car_of(&game.world, lorry).cargo.is_empty(), "the load was not gone into stock");
    assert!(game.world.lumps.iter().any(|l| l.building == depot && l.units > 0.0), "no lump for the unload");

    // A second lorry, bought from the world: the two fetch the rest.
    let before = game.world.treasury;
    game.command(PLAYER, ClientMessage::BuyLorry { depot });
    assert_eq!(lorries_of(&game.world, depot).len(), 2, "no second lorry");
    assert!((before - game.world.treasury - crate::haul::LORRY_PRICE).abs() < 1e-9, "the lorry was not paid for");
    let until = game.now + day / 4;
    while (quay(&game.world) > 0 || car_of(&game.world, ferry).deck.iter().flatten().any(|t| !t.outbound)) && game.step_to(until) {}
    let shelf = |w: &World, g: Good| building_of(w, depot).stocks[&g].level;
    assert!(shelf(&game.world, Good::Timber) >= 40.0, "the timber did not come in: {}", shelf(&game.world, Good::Timber));

    // A house, placed: a site until a van brings its timber.
    does(&mut game, Do::Place(BuildingKind::House, GridCoord { x: 20, y: 1 }));
    game.step();
    let house = game.world.map.occupied[&(20, 1)];
    assert!(building_of(&game.world, house).site.is_some(), "the house stood without its timber");
    assert!(game.world.map.household(house).is_empty(), "people moved into a site");
    let until = game.now + day / 4;
    while building_of(&game.world, house).site.is_some() && game.step_to(until) {}
    assert!(building_of(&game.world, house).site.is_none(), "the van never brought the timber");
    game.step();
    let settlers = game.world.map.household(house);
    assert_eq!(settlers.len(), 2, "nobody moved in");
    // They come on the next ferry, and drive home: off the deck from
    // where each stood aboard, over the ramp and up the lane.
    let until = game.now + turn + DWELL + day / 6;
    let berth = game.world.map.berth(harbour).unwrap();
    let mut rolled = 0;
    while settlers.iter().any(|&id| at_of(&game.world, id) != Some(house)) && game.step_to(until) {
        for &id in &settlers {
            let Some(r) = game.world.map.resident(id) else { continue };
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
    assert!(settlers.iter().all(|&id| at_of(&game.world, id) == Some(house)), "the settlers never got home");
    // A block of flats, of cement the town has none of: the town buys
    // it of a mayor by itself, on a ferry in, and pays as it lands, the
    // market's price and the freight.
    let x = HARBOUR_X - 24;
    does(&mut game, Do::Place(BuildingKind::Apartment, GridCoord { x, y: 1 }));
    let flats = game.world.map.occupied[&(x, 1)];
    let cement = |w: &World| w.market.prices().deals.into_iter().find(|d| d.good == Good::Cement && !d.out);
    let until = game.now + 2 * turn + DAY_MS as u64 / 24;
    while cement(&game.world).is_none() && game.step_to(until) {}
    let deal = cement(&game.world).expect("no cement was bought");
    assert!(deal.price >= crate::market::Market::floor(Good::Cement) * (1.0 + crate::economy::FREIGHT), "cement came for {}", deal.price);
    assert!(game.world.town.on(game.now).bought.get(&Good::Cement).is_some_and(|&c| c > 0.0), "the cement was not paid for");
    assert!(game.world.lumps.iter().any(|l| l.building == harbour && l.coins < 0.0), "no coins left at the harbour");
    let until = game.now + day / 4;
    while building_of(&game.world, flats).site.is_some() && game.step_to(until) {}
    assert!(building_of(&game.world, flats).site.is_none(), "the flats never stood");
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
    let facing = world.map.site_for(GridCoord { x, y: 1 }, BuildingKind::Depot).unwrap();
    let depot = world.map.place_building(GridCoord { x, y: 1 }, BuildingKind::Depot, facing).unwrap();
    world.map.orient(depot);
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
        match (c.trip.is_none() && game.world.map.claims.get(&lorry) == Some(&depot), parked_home) {
            (true, None) => parked_home = Some(now),
            (false, Some(at)) => {
                assert!(now - at <= (crate::haul::LOAD as u64 + 1) * map::HANDLE_MS, "the lorry stood {} ms at home", now - at);
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
    let facing = world.map.site_for(GridCoord { x, y: 1 }, BuildingKind::Depot).unwrap();
    let depot = world.map.place_building(GridCoord { x, y: 1 }, BuildingKind::Depot, facing).unwrap();
    world.map.orient(depot);
    let mut game = game(world);
    crate::haul::buy_lorry(&mut game.world, &mut game.events, depot, 0);
    let ferry = game.world.ferry_of(harbour).unwrap();
    let day = DAY_MS as u64;
    while car_of(&game.world, ferry).spot.is_none() && game.step_to(day) {}
    while car_of(&game.world, ferry).spot.is_some() && game.step_to(day) {}
    let going = |w: &World| lorries_of(w, depot).into_iter().find(|&l| car_of(w, l).trip.as_ref().is_some_and(|t| t.destination == harbour));
    while going(&game.world).is_none() && game.step_to(day) {}
    let scrapped = going(&game.world).expect("a lorry went for the starter pack");
    game.world.map.despawn_car(scrapped);
    let until = game.now + DAY_MS as u64 / 24;
    while going(&game.world).is_none() && game.step_to(until) {}
    assert!(going(&game.world).is_some(), "no lorry went for the starter pack after one was scrapped");
}

#[test]
fn a_run_to_an_hour_stops_there_at_speed_one() {
    let mut game = Game::new(World::new(), 0, 1, Box::new(World::new));
    let noon = DAY_MS as GameTime / 2;
    game.command(0, ClientMessage::RunTo(noon));
    while game.speed > 1 {
        game.tick();
    }
    assert!((noon..noon + MAX_SPEED as GameTime * STEP_MS).contains(&game.now), "stopped at {}", game.now);
    game.tick();
    assert_eq!(game.speed, 1);
}

/// A container port on the coast beside the harbour has ships of its own
/// on its own line, and the market is deeper to a town with one: a
/// package moves the price a third as far.
#[test]
fn a_port_has_its_own_ships_and_deepens_the_market() {
    let step = |w: &World| w.market.prices().goods.iter().find(|q| q.good == Good::Steel).unwrap().step;
    let mut game = game(street());
    game.step_to(1000);
    let before = step(&game.world);
    let port = game.world.map.place_on_street(GridCoord { x: HARBOUR_X + 4, y: 1 }, BuildingKind::Port).expect("the coast takes a port beside the harbour");
    game.step_to(2000);
    assert!(!game.world.ferries_of(port).is_empty(), "the port has no ship");
    assert!((step(&game.world) - before / 3.0).abs() < 1e-12, "the market is no deeper: {} against {before}", step(&game.world));
}

/// The heavy chains, end to end, in a town of the usual mix: a mine and
/// a coal mine in a mountain with ore at one end and coal at the other,
/// a steelworks smelting them, a machine works making machines of its
/// steel, and an oil well on oily grass beside a refinery. The depot's
/// lorry fetches each maker's yard and its vans take the inputs to the
/// works: by the end, each has made something.
#[test]
#[ignore]
fn heavy_chains_make_steel_machines_and_fuel() {
    use land::Deposit;
    let mut world = street();
    for x in 196..232 {
        for y in 5..14 {
            world.map.terrain.insert((x, y), TerrainType::Mountain);
            world.map.deposits.insert((x, y), if x < 214 { Deposit::Ore } else { Deposit::Coal });
        }
    }
    for x in 240..252 {
        for y in 4..12 {
            world.map.deposits.insert((x, y), Deposit::Oil);
        }
    }
    build(&mut world, 244, BuildingKind::OilWell);
    build(&mut world, 234, BuildingKind::Refinery);
    // Homes beside the oil: the town's own are all at work nearer.
    for x in [239, 248, 251] {
        build(&mut world, x, BuildingKind::Apartment);
    }
    build(&mut world, 200, BuildingKind::Mine);
    build(&mut world, 218, BuildingKind::Colliery);
    build(&mut world, 160, BuildingKind::Steelworks);
    build(&mut world, 168, BuildingKind::Factory);
    let days = std::env::var("DAYS").ok().and_then(|d| d.parse().ok()).unwrap_or(6);
    let mut made: std::collections::BTreeMap<Good, f64> = Default::default();
    season_with(world, &town_mix(), days, |_, _| Vec::new(), |world, day, _| {
        let flows = world.market.prices().flows;
        println!("day {day}: {}", flows.iter().map(|f| format!("{:?} +{:.0} -{:.0}", f.good, f.made, f.used)).collect::<Vec<_>>().join(", "));
        for f in flows {
            *made.entry(f.good).or_default() += f.made;
        }
    });
    for good in [Good::Ore, Good::Coal, Good::Steel, Good::Machinery, Good::Crude, Good::Fuel] {
        assert!(made.get(&good).copied().unwrap_or(0.0) > 0.0, "no {good:?} made in {days} days: {made:?}");
    }
}

/// The first half hour of play from an open start, in real minutes (a
/// game day is twenty): a quick player, ten seconds' thought between
/// moves, builds a depot by the harbour, two houses, a sawmill in the
/// woods and a lab, sets the labs to the farm, and builds the farm once
/// it is learned. Prints when each beat
/// came; asserts only that the town got going: the houses stand, someone
/// moved in, timber was made and the farm learned within the half hour.
#[test]
#[ignore]
fn first_half_hour() {
    let think = 10_000;
    let mut world = street();
    for x in SAWMILL_X - 5..SAWMILL_X + 7 {
        for y in 5..14 {
            world.map.terrain.insert((x, y), TerrainType::Forest);
        }
    }
    let mut game = game(world);
    game.world.research = crate::research::Research::default();
    let mut beats: Vec<(GameTime, String)> = vec![];
    let mut beat = |t: GameTime, what: &str| {
        if !beats.iter().any(|(_, w)| w == what) {
            beats.push((t, what.to_string()));
        }
    };
    let plan = [(BuildingKind::Depot, HARBOUR_X - 12), (BuildingKind::House, SAWMILL_X - 8), (BuildingKind::House, SAWMILL_X - 11), (BuildingKind::Sawmill, SAWMILL_X), (BuildingKind::Lab, SAWMILL_X - 16), (BuildingKind::House, SAWMILL_X - 20), (BuildingKind::House, SAWMILL_X - 23)];
    let mut next = 0;
    let mut last = 0;
    let half_hour = 30 * 60_000;
    let of = |w: &World, k: BuildingKind| w.map.objects.iter().filter_map(|e| match e.object { GameObject::Building(ref b) if b.kind == k => Some((e.id, b.site.is_none())), _ => None }).collect::<Vec<_>>();
    while game.now < half_hour {
        game.step_to(game.now + 1_000);
        let now = game.now;
        let w = &game.world;
        if now >= last + think {
            last = now;
            if next < plan.len() {
                let (kind, x) = plan[next];
                // Round the tile the plot's middle is on, as the hand drops it.
                for y in 1..4 {
                    if !game.world.map.occupied.contains_key(&(x, 1)) {
                        game.command(PLAYER, ClientMessage::Place { kind, at: GridCoord { x, y }, facing: None });
                    }
                }
                if game.world.map.occupied.contains_key(&(x, 1)) {
                    beat(now, &format!("{kind:?} placed"));
                    next += 1;
                }
            } else if of(w, BuildingKind::Lab).iter().any(|l| l.1) && w.research.at.is_none() && !w.research.open.contains(&BuildingKind::Farm) {
                game.command(PLAYER, ClientMessage::Research { kind: BuildingKind::Farm });
                beat(now, "the labs set to the farm");
            } else if w.research.open.contains(&BuildingKind::Farm) && of(w, BuildingKind::Farm).is_empty() {
                game.command(PLAYER, ClientMessage::Place { kind: BuildingKind::Farm, at: GridCoord { x: 100, y: 2 }, facing: None });
                beat(now, "Farm placed");
            }
        }
        let w = &game.world;
        if let Some((d, _)) = of(w, BuildingKind::Depot).first().copied() {
            if building_of(w, d).stocks.values().any(|s| s.level > 0.0) {
                beat(now, "the starter pack in the depot");
            }
        }
        if of(w, BuildingKind::House).iter().any(|h| h.1) {
            beat(now, "a house stands");
        }
        if !w.map.resident_ids().is_empty() {
            beat(now, "the first settlers");
        }
        if of(w, BuildingKind::Sawmill).iter().any(|s| building_of(w, s.0).stocks.get(&Good::Timber).is_some_and(|t| t.level > 0.0)) {
            beat(now, "the sawmill's first timber");
        }
        if of(w, BuildingKind::Lab).iter().any(|l| l.1) {
            beat(now, "the lab stands");
        }
        if w.research.done > 0.0 {
            beat(now, "the first researcher-hour");
        }
        if w.research.open.contains(&BuildingKind::Farm) {
            beat(now, "the farm learned");
        }
        if of(w, BuildingKind::Farm).iter().any(|f| f.1) {
            beat(now, "the farm stands");
        }
        if w.treasury > crate::economy::STAKE {
            beat(now, "coins over the stake");
        }
    }
    eprintln!("\nthe first half hour, in real minutes (a day is twenty), treasury {:.0}:\n", game.world.treasury);
    for (t, what) in &beats {
        eprintln!("  {:>2}:{:02}  {what}", t / 60_000, (t / 1_000) % 60);
    }
    for what in ["a house stands", "the first settlers", "the sawmill's first timber", "the farm learned"] {
        assert!(beats.iter().any(|(_, w)| w == what), "no \"{what}\" in the first half hour");
    }
}
