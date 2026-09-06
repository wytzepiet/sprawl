//! Buildings arrive on their own, and the mayor deals with them.
//! docs/spawner.md.

use rand::rngs::SmallRng;
use rand::seq::IndexedRandom;
use rand::{Rng, SeedableRng};
use serde_json::{json, Value};

use crate::blueprint::{blueprint, Class};
use crate::engine::GameTime;
use crate::needs::Need;
use crate::protocol::{BuildingKind, EntityId, GameObject, GridCoord, Growth, DAY_MS};
use crate::world::World;

/// Output that buys the city's first offer, in hours of need served.
///
/// The meter used to be a clock: an offer every two hours whatever the city
/// did. Now it is earned, so a thriving city grows and a gridlocked one stops —
/// and the bar climbs through the working day, when there is nothing else to
/// watch, because that is when the work is being done.
/// One hour of need served — the unit the meter counts in. Obligation is kept
/// in milliseconds, so saying so here is what keeps these numbers legible.
const SERVED_HOUR: f64 = DAY_MS as f64 / 24.0;

/// A four-house town puts out around thirty hours of work a day, so this is
/// roughly a dozen offers a day to begin with — about the cadence the old
/// two-hourly timer had, but earned rather than waited for.
const EARN_BASE: f64 = 2.7 * SERVED_HOUR;

/// How much dearer each offer gets as the city fills out. Without this a bigger
/// city earns faster *and* spends the same, and growth runs away with itself.
const EARN_PER_BUILDING: f64 = 0.12 * SERVED_HOUR;

/// Output for the first level. Each one after costs a level more than the last.
const LEVEL_BASE: f64 = 30.0 * SERVED_HOUR;
/// Buildings this close are one cluster — the scale growth lands at.
const CLUSTER: i32 = 8;

/// What the city is saving for, and what it costs at the size the city was
/// when it started saving.
#[derive(Debug, Clone, Copy)]
pub struct Goal {
    pub kind: BuildingKind,
    pub cost: f64,
}

/// One point of experience: a minute of need served. Obligation is kept in
/// milliseconds, which makes for numbers nobody can read on a bar.
fn points(served: f64) -> f64 {
    served * 60.0 / SERVED_HOUR
}

/// Everything the two bars need to draw themselves, so the numbers behind them
/// stay in here with the constants that set them.
pub fn growth(world: &World, now: GameTime) -> Growth {
    let earned = world.xp.at(now);
    let (level, reached) = level(earned);
    Growth {
        level,
        xp: points(earned - reached),
        xp_needed: points(LEVEL_BASE * (level as f64 + 1.0)),
        offer_xp: points(earned - world.offered_at),
        offer_needed: points(world.goal.map_or(0.0, |g| g.cost)),
        rate: points(world.xp.rate(now)),
        next: world.goal.map(|g| g.kind),
        taken: world.build.taken(),
        road_tiles_left: world.build.road_tiles().saturating_sub(world.laid),
    }
}

/// The city's level, and what it took to reach it.
///
/// Level `n` is reached at `LEVEL_BASE * n * (n + 1) / 2`, so each one asks for
/// a little more than the last.
pub fn level(earned: f64) -> (u32, f64) {
    let n = (((1.0 + 8.0 * earned / LEVEL_BASE).sqrt() - 1.0) / 2.0).floor().max(0.0);
    (n as u32, LEVEL_BASE * n * (n + 1.0) / 2.0)
}

fn seeded(world: &World, now: GameTime) -> SmallRng {
    SmallRng::seed_from_u64(
        (world.terrain_seed as u64) ^ (now / 1000).wrapping_mul(0x9E37_79B9_7F4A_7C15),
    )
}

/// What the city is saving up for. Settled once, when the meter resets, so the
/// icon the player is watching does not change under them — and the only
/// time the spawner reads the world, which it is asked about every tick.
fn goal(world: &mut World, now: GameTime) -> Goal {
    if let Some(goal) = world.goal {
        return goal;
    }
    let mut rng = seeded(world, now);
    let goal = Goal {
        kind: draw_kind(world, &mut rng, &crate::resident::pressure(world, now)),
        cost: EARN_BASE + EARN_PER_BUILDING * buildings(world).len() as f64,
    };
    world.goal = Some(goal);
    goal
}

/// Put one more building down, once the city has earned it and there is
/// somewhere for it: a plot fronting a street that is joined to the world.
/// It arrives with its driveway laid, lived in at once.
///
/// Sites are looked for once a sim second. The draw is seeded by the
/// second, so looking every tick would draw the same sites a hundred times
/// over — and did, at the whole tick's cost, whenever the meter was full
/// and no street had room.
pub fn spawn(world: &mut World, now: GameTime) -> Option<EntityId> {
    let Goal { kind, cost } = goal(world, now);
    if world.xp.at(now) - world.offered_at < cost || now % 1000 != 0 {
        return None;
    }
    let mut rng = seeded(world, now);
    let size = blueprint(kind).size;
    let pos = draw_site(world, &mut rng, kind, size, &buildings(world), now)?;
    // Spent. The next goal is drawn on the next tick.
    world.offered_at = world.xp.at(now);
    world.goal = None;
    world.spawn_building(pos, kind, size)
}

/// What the world is offering: where each kind belongs, and what stands
/// near it.
pub fn inspect(world: &World, now: GameTime) -> Value {
    let standing = buildings(world);
    let (mut clusters, _) = clusters(&standing);
    clusters.sort_unstable_by(|a, b| b.cmp(a));
    json!({
        // The ledger runs ahead of the lumps `delivered` lands as shifts end;
        // over the two days `delivered` remembers, the two should agree to
        // within a shift.
        "earned_h": world.xp.at(now) / SERVED_HOUR,
        "delivered_2d_h": world.delivered.values().map(|d| d.today + d.yesterday).sum::<f64>() / SERVED_HOUR,
        "goal": world.goal.map(|g| json!({ "kind": g.kind, "cost_h": g.cost / SERVED_HOUR })),
        "pressure": crate::resident::pressure(world, now).into_iter()
            .map(|(n, p)| (format!("{n:?}"), p)).collect::<std::collections::BTreeMap<_, _>>(),
        "clusters": clusters,
    })
}

/// Section 4: base weight per kind, tilted by what the city cannot get and
/// by the build, among the kinds the build lets arrive.
fn draw_kind(world: &World, rng: &mut SmallRng, pressure: &std::collections::HashMap<Need, f64>) -> BuildingKind {
    let p = |n: &Need| pressure.get(n).copied().unwrap_or(0.0);
    let weight = |k: BuildingKind| {
        let b = blueprint(k);
        if !world.build.may_arrive(k) {
            return 0.0;
        }
        b.weight * world.build.weight(b.class) * (1.0 + b.tilt.iter().map(p).sum::<f64>())
    };
    *BuildingKind::ALL.choose_weighted(rng, |&k| weight(k)).unwrap()
}

/// Section 5: grow a cluster, or seed one; then snap to land that fits.
/// Several sites are drawn and the one whose neighbours suit the kind best
/// is kept — which is what keeps the factory off the residential street.
fn draw_site(
    world: &World,
    rng: &mut SmallRng,
    kind: BuildingKind,
    size: (u8, u8),
    standing: &[(EntityId, GridCoord, BuildingKind)],
    now: GameTime,
) -> Option<GridCoord> {
    let (sizes, member) = clusters(standing);
    let largest = sizes.iter().copied().max().unwrap_or(0) as f64;
    // Now and then, once there is a town to be apart from.
    let seed_new = rng.random::<f64>() < 0.05 * (largest / 20.0).min(1.0);
    // Anchors by how the kind likes them, and by their cluster: every
    // cluster draws equally, so a fresh seed of one is a whole town's worth
    // of anchor, or it would never grow beside the town that already stands.
    let liked: Vec<f64> = standing
        .iter()
        .zip(&member)
        .map(|(&(_, _, k), &c)| (affinity(kind, k).max(0.0) + 0.05) / sizes[c] as f64)
        .collect();
    // One anchor per draw, then the best of several sites around it. Drawn
    // per site, the candidate beside the big cluster won on company every
    // time, and a fresh seed never grew. A new cluster seeds on a street
    // rather than beside a building, so a street in the countryside fills
    // on its own.
    let (anchor, reach) = if seed_new || standing.is_empty() {
        (world.streets(now).choose(rng).copied()?, 3..10)
    } else {
        let i = (0..standing.len()).collect::<Vec<_>>().choose_weighted(rng, |&i| liked[i]).ok().copied()?;
        (standing[i].1, 3..10)
    };
    let mut best: Option<(f64, GridCoord)> = None;
    for _ in 0..8 {
        let angle = rng.random::<f64>() * std::f64::consts::TAU;
        let r = rng.random_range(reach.clone()) as f64;
        let at = GridCoord {
            x: anchor.x + (angle.cos() * r).round() as i32,
            y: anchor.y + (angle.sin() * r).round() as i32,
        };
        // A new cluster is a new cluster only if it is clear of the old ones.
        if seed_new && standing.iter().any(|&(_, p, _)| dist(p, at) < 15) {
            continue;
        }
        let Some(pos) = snap(world, at, size, now) else { continue };
        let company: f64 = standing
            .iter()
            .map(|&(_, p, k)| (affinity(kind, k), dist(p, pos)))
            .filter(|&(_, d)| d <= 10)
            .map(|(a, d)| a / (1.0 + d as f64))
            .sum();
        if best.is_none_or(|(s, _)| company > s) {
            best = Some((company, pos));
        }
    }
    best.map(|(_, pos)| pos)
}

/// How a kind feels about standing near another, from -1 to 1. Homes flock;
/// shops go where the homes are; industry keeps to itself and homes keep
/// away from it.
fn affinity(kind: BuildingKind, near: BuildingKind) -> f64 {
    use Class::*;
    match (blueprint(kind).class, blueprint(near).class) {
        (Living, Living) => 1.0,
        (Living, Commerce) => 0.3,
        (Living, Industry) => -1.0,
        (Commerce, Living) => 1.0,
        (Commerce, Commerce) => 0.5,
        (Commerce, Industry) => -0.3,
        (Industry, Living) => -1.0,
        (Industry, Commerce) => -0.2,
        (Industry, Industry) => 1.0,
    }
}

/// The nearest place to `at` where a footprint fits: buildable, revealed,
/// and fronting a settled street that is joined to the world.
fn snap(world: &World, at: GridCoord, size: (u8, u8), now: GameTime) -> Option<GridCoord> {
    let fits = |pos: GridCoord| {
        let (w, h) = (size.0 as i32, size.1 as i32);
        (0..w).all(|dx| {
            (0..h).all(|dy| {
                let t = GridCoord { x: pos.x + dx, y: pos.y + dy };
                world.is_buildable(t) && world.revealed.contains(&crate::world::chunk_of(t))
            })
        }) && world.road_for_plot(pos, size).is_some_and(|(street, _)| world.network.joined(street) && world.is_settled(street, now))
    };
    (0..=6).flat_map(|ring| ring_around(at, ring)).find(|&p| fits(p))
}

fn ring_around(c: GridCoord, r: i32) -> impl Iterator<Item = GridCoord> {
    (-r..=r).flat_map(move |dy| {
        (-r..=r).filter_map(move |dx| {
            (dx.abs() == r || dy.abs() == r).then_some(GridCoord { x: c.x + dx, y: c.y + dy })
        })
    })
}

/// Clusters, by flood fill over buildings within reach of each other: the
/// size of each, and which one each building is in. Derived on request;
/// nothing remembers a cluster.
fn clusters(standing: &[(EntityId, GridCoord, BuildingKind)]) -> (Vec<usize>, Vec<usize>) {
    let mut member = vec![usize::MAX; standing.len()];
    let mut sizes = Vec::new();
    for i in 0..standing.len() {
        if member[i] != usize::MAX {
            continue;
        }
        let c = sizes.len();
        let mut stack = vec![i];
        member[i] = c;
        let mut n = 0;
        while let Some(j) = stack.pop() {
            n += 1;
            for k in 0..standing.len() {
                if member[k] == usize::MAX && dist(standing[j].1, standing[k].1) <= CLUSTER {
                    member[k] = c;
                    stack.push(k);
                }
            }
        }
        sizes.push(n);
    }
    (sizes, member)
}

fn dist(a: GridCoord, b: GridCoord) -> i32 {
    (a.x - b.x).abs().max((a.y - b.y).abs())
}

/// Every real building, by id.
fn buildings(world: &World) -> Vec<(EntityId, GridCoord, BuildingKind)> {
    world
        .objects
        .all_entries()
        .iter()
        .filter_map(|e| match e.object {
            GameObject::Building(ref b) => Some((e.id, e.position?, b.kind)),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{BuildingKind, TerrainType};

    /// Open country with one street through it and a few buildings on it.
    fn country() -> World {
        let mut world = World::new();
        for y in -60..60 {
            for x in -60..120 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        // Everything in view: the spawner only offers what can be seen.
        for cy in -2..2 {
            for cx in -2..4 {
                world.revealed.insert(crate::protocol::ChunkCoord { cx, cy });
            }
        }
        // The street runs out past the survey, the way road generation
        // always leaves one: that is what joins the town to the world. Far
        // past it, since every arrival surveys further and there is no road
        // generation here to keep ahead of it.
        let street: Vec<GridCoord> = (-2..400).map(|x| GridCoord { x, y: 0 }).collect();
        world.place_road_path(&street);
        // Side streets, so the town has somewhere to be two-dimensional.
        for x in (12..120).step_by(24) {
            let side: Vec<GridCoord> = (-30..31).map(|y| GridCoord { x, y }).collect();
            world.place_road_path(&side);
        }
        for (x, kind) in [(0, BuildingKind::House), (4, BuildingKind::Shop), (8, BuildingKind::Workshop)] {
            world.spawn_building(GridCoord { x, y: 1 }, kind, (1, 1)).unwrap();
        }
        world
    }

    /// A step of the clock, big enough that a fresh site is drawn each time.
    const STEP: GameTime = DAY_MS as u64 / 12;

    /// Put enough by for one offer. Earning it is the simulation's business;
    /// what the spawner does with it is this module's.
    fn afford(world: &mut World, now: GameTime) {
        let cost = goal(world, now).cost;
        world.xp = crate::xp::Ledger::load(world.offered_at + cost, now);
    }

    /// Let the town arrive for a while, with every kind allowed, and look at
    /// what that made.
    fn grow(n: usize) -> (World, Vec<(GridCoord, BuildingKind)>) {
        let mut world = country();
        world.build = crate::tree::Build::everything();
        let mut placed = Vec::new();
        let mut now = 0;
        while placed.len() < n {
            now += STEP;
            afford(&mut world, now);
            if let Some(id) = spawn(&mut world, now) {
                let e = world.objects.get(id).unwrap();
                let GameObject::Building(ref b) = e.object else { unreachable!() };
                let pos = e.position.unwrap();
                placed.push((pos, b.kind));
            }
            assert!(now < 40 * DAY_MS as u64, "the spawner ran dry after {} with goal {:?}", placed.len(), world.goal);
        }
        (world, placed)
    }

    #[test]
    fn the_same_country_grows_the_same_town() {
        assert_eq!(grow(30).1, grow(30).1);
    }

    #[test]
    fn a_town_has_more_than_one_cluster_and_no_grid() {
        let (world, placed) = grow(60);
        let standing = buildings(&world);
        assert_eq!(standing.len(), 63);
        // Nothing on top of anything: the footprint index would have refused.
        let (mut sizes, _) = clusters(&standing);
        sizes.sort_unstable();
        assert!(sizes.len() >= 2, "one blob: {sizes:?}");
        assert!(*sizes.last().unwrap() >= 10, "never clustered: {sizes:?}");
        assert!(sizes.iter().filter(|&&n| n >= 4).count() >= 2, "only one real cluster: {sizes:?}");
        // Not a grid: neighbours are not all at the same spacing.
        let mut spacings: Vec<i32> = placed
            .iter()
            .map(|&(p, _)| placed.iter().filter(|&&(q, _)| q != p).map(|&(q, _)| dist(p, q)).min().unwrap())
            .collect();
        spacings.sort_unstable();
        spacings.dedup();
        assert!(spacings.len() >= 3, "gridded: {spacings:?}");
        // Industry kept its distance from homes, on the whole.
        let homes: Vec<GridCoord> = standing.iter().filter(|&&(_, _, k)| blueprint(k).class == Class::Living).map(|&(_, p, _)| p).collect();
        let near_home = |p: GridCoord| homes.iter().any(|&h| dist(h, p) <= 3);
        let industry: Vec<GridCoord> = standing.iter().filter(|&&(_, _, k)| blueprint(k).class == Class::Industry).map(|&(_, p, _)| p).collect();
        let shops: Vec<GridCoord> = standing.iter().filter(|&&(_, _, k)| blueprint(k).class == Class::Commerce).map(|&(_, p, _)| p).collect();
        let frac = |v: &[GridCoord]| v.iter().filter(|&&p| near_home(p)).count() as f64 / v.len().max(1) as f64;
        assert!(frac(&industry) < frac(&shops), "industry {:.2} vs shops {:.2} beside homes", frac(&industry), frac(&shops));
    }

    #[test]
    fn a_building_arrives_once_it_is_earned() {
        let mut world = country();
        assert!(spawn(&mut world, STEP).is_none(), "nothing is earned yet");
        afford(&mut world, STEP);
        let before = buildings(&world).len();
        assert!(spawn(&mut world, STEP).is_some());
        assert_eq!(buildings(&world).len(), before + 1);
        assert!(spawn(&mut world, 2 * STEP).is_none(), "the meter was spent");
    }

    /// Nothing arrives unconnected: what arrives fronts a joined street and
    /// has its driveway from the start.
    #[test]
    fn a_building_arrives_on_a_street_with_its_driveway() {
        let mut world = country();
        afford(&mut world, STEP);
        let id = spawn(&mut world, STEP).expect("the first arrival");
        assert!(world.is_reached(id));
    }

    /// A street the mayor has just drawn is left alone until it has stood
    /// an hour; then it is a site like any other.
    #[test]
    fn a_fresh_street_is_left_alone_for_an_hour() {
        use crate::world::roads::STREET_SETTLES;
        let mut world = country();
        // Drown the country, then draw one street back onto the road.
        let drowned: Vec<(i32, i32)> = world.terrain.keys().copied()
            .filter(|&(x, y)| world.is_buildable(GridCoord { x, y })).collect();
        for t in drowned {
            world.terrain.insert(t, TerrainType::Water);
        }
        // Beside the starting town, where the spawner looks.
        let drawn = 5 * STEP;
        // Land only from the second tile up, so a plot can front the fresh
        // street and nothing else.
        for y in 0..6 {
            for dx in -1..=1 {
                world.terrain.insert((6 + dx, -2 - y), TerrainType::Grass);
            }
            world.handle_place_road(GridCoord { x: 6, y: -y }, GridCoord { x: 6, y: -y - 1 }, false, false, drawn);
            world.insert_edge(world.road_node_at(GridCoord { x: 6, y: -y }).unwrap(), world.road_node_at(GridCoord { x: 6, y: -y - 1 }).unwrap());
        }
        let soon = drawn + STREET_SETTLES / 2;
        afford(&mut world, soon);
        assert!(spawn(&mut world, soon).is_none(), "arrived while the street was fresh");
        let later = drawn + STREET_SETTLES + STEP;
        afford(&mut world, later);
        assert!(spawn(&mut world, later).is_some(), "nothing arrived once it had settled");
    }

    /// A street off on its own fills too, slowly: a new cluster seeds on a
    /// street, not beside a building.
    #[test]
    fn a_street_in_the_country_fills_on_its_own() {
        let (world, _) = grow(60);
        let far = buildings(&world).iter().filter(|&&(_, p, _)| p.x > 60).count();
        assert!(far > 0, "nothing ever went up the street");
    }

    /// Only what the build allows arrives: with nothing taken, the plain kinds.
    #[test]
    fn the_build_says_what_may_arrive() {
        let mut world = country();
        let mut now = 0;
        let mut kinds = Vec::new();
        while kinds.len() < 30 {
            now += STEP;
            afford(&mut world, now);
            if let Some(id) = spawn(&mut world, now) {
                let GameObject::Building(ref b) = world.objects.get(id).unwrap().object else { unreachable!() };
                kinds.push(b.kind);
            }
        }
        assert!(kinds.iter().all(|&k| world.build.may_arrive(k)), "{kinds:?}");
        assert!(kinds.iter().all(|&k| matches!(k, BuildingKind::House | BuildingKind::Shop | BuildingKind::Office)), "{kinds:?}");
    }

    /// A full meter with nowhere to build is the spawner's worst case, and
    /// it is asked every tick: it has to cost nothing most of the time.
    /// Once it cost the whole tick, and the fan said so before the log did.
    #[test]
    fn a_full_meter_with_no_room_is_cheap() {
        let mut world = country();
        // Drown every free tile, so no site can ever fit.
        let drowned: Vec<(i32, i32)> = world.terrain.keys().copied()
            .filter(|&(x, y)| world.is_buildable(GridCoord { x, y })).collect();
        for t in drowned {
            world.terrain.insert(t, TerrainType::Water);
        }
        afford(&mut world, 0);
        let started = std::time::Instant::now();
        for tick in 0..2000u64 {
            assert!(spawn(&mut world, tick * 10).is_none());
        }
        let took = started.elapsed();
        eprintln!("2000 ticks of a full meter with no room: {took:?}");
        assert!(took < std::time::Duration::from_millis(200), "2000 ticks took {took:?}");
    }

    /// Not an assertion: a picture, for whoever runs this with --nocapture.
    #[test]
    fn draw_the_town() {
        let (world, _) = grow(60);
        let standing = buildings(&world);
        let (x0, x1) = (-60, 120);
        let (y0, y1) = (-40, 40);
        for y in (y0..y1).step_by(2) {
            let row: String = (x0..x1).step_by(2).map(|x| {
                let here = |k: &dyn Fn(BuildingKind) -> bool| standing.iter().any(|&(_, p, kk)| p.x / 2 == x / 2 && p.y / 2 == y / 2 && k(kk));
                if here(&|k| blueprint(k).class == Class::Living) { 'h' }
                else if here(&|k| blueprint(k).class == Class::Commerce) { 's' }
                else if here(&|_| true) { 'F' }
                else if world.road_node_at(GridCoord { x, y }).is_some() { '.' }
                else { ' ' }
            }).collect();
            eprintln!("{row}");
        }
    }
}
