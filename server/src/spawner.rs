//! Buildings arrive on their own, as proposals, and the mayor disposes.
//! sprawl-spawner.md.

use rand::rngs::SmallRng;
use rand::seq::IndexedRandom;
use rand::{Rng, SeedableRng};
use serde_json::{json, Value};

use crate::engine::GameTime;
use crate::needs::Need;
use crate::protocol::{BuildingKind, EntityId, GameObject, GridCoord, Proposal, Rotation, DAY_MS};
use crate::world::World;

/// How often the city offers something, while there is room in the queue.
pub const INTERVAL: GameTime = DAY_MS as u64 / 12;
/// How many offers may wait for an answer. The spawner holds when full.
pub const QUEUE: usize = 5;
/// How long a rejection keeps that kind away from the spot.
const GRUDGE: GameTime = DAY_MS as u64;
/// Buildings this close are one cluster.
const CLUSTER: i32 = 4;

/// Offer one more building, if there is room and somewhere to put it.
pub fn propose(world: &mut World, now: GameTime) -> Option<EntityId> {
    if proposals(world).len() >= QUEUE {
        return None;
    }
    let standing = buildings(world);
    if standing.is_empty() {
        return None;
    }
    // Seeded by the seed and the hour: the same city offers the same next
    // building, a reload does not reshuffle it, and a draw that found no
    // room is followed by a different one rather than the same one again.
    let mut rng = SmallRng::seed_from_u64(
        (world.terrain_seed as u64) ^ (now / INTERVAL).wrapping_mul(0x9E37_79B9_7F4A_7C15),
    );
    let kind = draw_kind(&mut rng, &crate::resident::pressure(world, now));
    let size = footprint(kind);
    let pos = draw_site(world, &mut rng, kind, size, &standing)?;
    if world.rejections.iter().any(|&(k, at, until)| k == kind && until > now && dist(at, pos) < 20) {
        return None;
    }
    let rotation = [Rotation::North, Rotation::East, Rotation::South, Rotation::West][rng.random_range(0..4)];
    Some(world.insert_at(GameObject::Proposal(Proposal { kind, size, rotation }), Some(pos)))
}

/// The mayor's answer. Yes puts the building down, dormant until a road
/// reaches it; no removes the offer and keeps that kind away for a while.
pub fn answer(world: &mut World, id: EntityId, accept: bool, now: GameTime) {
    let Some((pos, p)) = proposal(world, id) else { return };
    world.drop_entity(id);
    if accept {
        world.place_building(pos, p.kind, p.size, p.rotation);
    } else {
        world.rejections.push((p.kind, pos, now + GRUDGE));
        world.rejections.retain(|&(_, _, until)| until > now);
    }
}

/// Drag the pin. The proposal lands on the nearest footprint that fits.
pub fn relocate(world: &mut World, id: EntityId, to: GridCoord) {
    let Some((_, p)) = proposal(world, id) else { return };
    if let Some(pos) = snap(world, to, p.size, id) {
        world.update_position(id, pos);
    }
}

/// What the world is offering: where each kind belongs, and what stands
/// near it.
pub fn inspect(world: &World, now: GameTime) -> Value {
    let standing = buildings(world);
    let (mut clusters, _) = clusters(&standing);
    clusters.sort_unstable_by(|a, b| b.cmp(a));
    json!({
        "queue": proposals(world).iter().map(|&(id, pos, ref p)| json!({
            "id": id, "kind": p.kind, "pos": [pos.x, pos.y], "size": p.size,
        })).collect::<Vec<_>>(),
        "pressure": crate::resident::pressure(world, now).into_iter()
            .map(|(n, p)| (format!("{n:?}"), p)).collect::<std::collections::BTreeMap<_, _>>(),
        "clusters": clusters,
        "rejections": world.rejections.iter().filter(|&&(_, _, until)| until > now)
            .map(|&(k, at, _)| json!({ "kind": k, "pos": [at.x, at.y] })).collect::<Vec<_>>(),
    })
}

/// Section 4: base weight per kind, tilted by what the city cannot get.
fn draw_kind(rng: &mut SmallRng, pressure: &std::collections::HashMap<Need, f64>) -> BuildingKind {
    use BuildingKind::*;
    let p = |n: Need| pressure.get(&n).copied().unwrap_or(0.0);
    let jobs = p(Need::Work);
    let custom = p(Need::Eat) + p(Need::Leisure);
    let weighted = [
        (House, 4.0),
        (Apartment, 1.0),
        (Shop, 1.5 * (1.0 + custom)),
        (Office, 0.7 * (1.0 + jobs)),
        (Workshop, 0.7 * (1.0 + jobs)),
        (Factory, 0.3 * (1.0 + jobs)),
    ];
    weighted.choose_weighted(rng, |&(_, w)| w).map(|&(k, _)| k).unwrap()
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
) -> Option<GridCoord> {
    let (sizes, member) = clusters(standing);
    let largest = sizes.iter().copied().max().unwrap_or(0) as f64;
    // Now and then, once there is a town to be apart from.
    let seed_new = rng.random::<f64>() < 0.1 * (largest / 20.0).min(1.0);
    // Anchors by how the kind likes them, and by how small their cluster
    // is: a fresh seed of one is a whole town's worth of anchor, or it
    // would never grow beside the town that already stands.
    let liked: Vec<f64> = standing
        .iter()
        .zip(&member)
        .map(|(&(_, _, k), &c)| (affinity(kind, k).max(0.0) + 0.05) / (sizes[c] as f64).sqrt())
        .collect();
    let mut best: Option<(f64, GridCoord)> = None;
    for _ in 0..8 {
        let (anchor, reach) = if seed_new {
            (standing.choose(rng)?.1, 40..80)
        } else {
            let i = (0..standing.len()).collect::<Vec<_>>().choose_weighted(rng, |&i| liked[i]).ok().copied()?;
            (standing[i].1, 3..15)
        };
        let angle = rng.random::<f64>() * std::f64::consts::TAU;
        let r = rng.random_range(reach) as f64;
        let at = GridCoord {
            x: anchor.x + (angle.cos() * r).round() as i32,
            y: anchor.y + (angle.sin() * r).round() as i32,
        };
        // A new cluster is a new cluster only if it is clear of the old ones.
        if seed_new && standing.iter().any(|&(_, p, _)| dist(p, at) < 30) {
            continue;
        }
        let Some(pos) = snap(world, at, size, 0) else { continue };
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
    use BuildingKind::*;
    let home = matches!(near, House | Apartment);
    let shop = matches!(near, Shop | Office);
    match kind {
        House | Apartment => if home { 1.0 } else if shop { 0.3 } else { -1.0 },
        Shop | Office => if home { 1.0 } else if shop { 0.5 } else { -0.3 },
        Workshop | Factory => if home { -1.0 } else if shop { -0.2 } else { 1.0 },
    }
}

/// The nearest place to `at` where a footprint fits: buildable, revealed,
/// a tile clear of anything standing, and clear of every other proposal.
fn snap(world: &World, at: GridCoord, size: (u8, u8), except: EntityId) -> Option<GridCoord> {
    let others: Vec<(GridCoord, (u8, u8))> =
        proposals(world).into_iter().filter(|&(id, ..)| id != except).map(|(_, p, q)| (p, q.size)).collect();
    let fits = |pos: GridCoord| {
        let (w, h) = (size.0 as i32, size.1 as i32);
        (-1..=w).all(|dx| {
            (-1..=h).all(|dy| {
                let t = GridCoord { x: pos.x + dx, y: pos.y + dy };
                let inside = (0..w).contains(&dx) && (0..h).contains(&dy);
                let clear = !world.occupied.contains_key(&(t.x, t.y));
                (if inside { world.is_buildable(t) && world.revealed.contains(&crate::world::chunk_of(t)) } else { clear })
                    && !others.iter().any(|&(p, s)| {
                        t.x >= p.x - 1 && t.x <= p.x + s.0 as i32 && t.y >= p.y - 1 && t.y <= p.y + s.1 as i32
                    })
            })
        })
    };
    (0..=3).flat_map(|ring| ring_around(at, ring)).find(|&p| fits(p))
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

fn footprint(kind: BuildingKind) -> (u8, u8) {
    use BuildingKind::*;
    match kind {
        House | Shop | Workshop => (1, 1),
        Apartment | Office | Factory => (2, 1),
    }
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
        .filter(|e| e.draft.is_none())
        .filter_map(|e| match e.object {
            GameObject::Building(ref b) => Some((e.id, e.position?, b.kind)),
            _ => None,
        })
        .collect()
}

/// Every offer waiting, by id.
pub fn proposals(world: &World) -> Vec<(EntityId, GridCoord, Proposal)> {
    world
        .objects
        .all_entries()
        .iter()
        .filter_map(|e| match e.object {
            GameObject::Proposal(ref p) => Some((e.id, e.position?, p.clone())),
            _ => None,
        })
        .collect()
}

fn proposal(world: &World, id: EntityId) -> Option<(GridCoord, Proposal)> {
    let e = world.objects.get(id)?;
    match e.object {
        GameObject::Proposal(ref p) => Some((e.position?, p.clone())),
        _ => None,
    }
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
        let street: Vec<GridCoord> = (-2..40).map(|x| GridCoord { x, y: 0 }).collect();
        world.place_road_path(&street);
        for (x, kind) in [(0, BuildingKind::House), (4, BuildingKind::Shop), (8, BuildingKind::Workshop)] {
            world.spawn_building(GridCoord { x, y: 1 }, kind, (1, 1), Rotation::South).unwrap();
        }
        world
    }

    /// Say yes to everything for a while, and look at the town that made.
    fn grow(n: usize) -> (World, Vec<(GridCoord, BuildingKind)>) {
        let mut world = country();
        let mut placed = Vec::new();
        let mut now = 0;
        while placed.len() < n {
            now += INTERVAL;
            if let Some(id) = propose(&mut world, now) {
                let (pos, p) = proposal(&world, id).unwrap();
                answer(&mut world, id, true, now);
                placed.push((pos, p.kind));
            }
            assert!(now < 400 * DAY_MS as u64, "the spawner ran dry after {}", placed.len());
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
        let homes: Vec<GridCoord> = standing.iter().filter(|&&(_, _, k)| matches!(k, BuildingKind::House | BuildingKind::Apartment)).map(|&(_, p, _)| p).collect();
        let near_home = |p: GridCoord| homes.iter().any(|&h| dist(h, p) <= 3);
        let industry: Vec<GridCoord> = standing.iter().filter(|&&(_, _, k)| matches!(k, BuildingKind::Workshop | BuildingKind::Factory)).map(|&(_, p, _)| p).collect();
        let shops: Vec<GridCoord> = standing.iter().filter(|&&(_, _, k)| matches!(k, BuildingKind::Shop)).map(|&(_, p, _)| p).collect();
        let frac = |v: &[GridCoord]| v.iter().filter(|&&p| near_home(p)).count() as f64 / v.len().max(1) as f64;
        assert!(frac(&industry) < frac(&shops), "industry {:.2} vs shops {:.2} beside homes", frac(&industry), frac(&shops));
    }

    #[test]
    fn a_rejection_keeps_the_kind_away_for_a_day() {
        let mut world = country();
        let id = propose(&mut world, INTERVAL).unwrap();
        let (pos, p) = proposal(&world, id).unwrap();
        answer(&mut world, id, false, INTERVAL);
        assert!(proposals(&world).is_empty());
        assert_eq!(world.rejections.len(), 1);
        // The same offer, a moment later, is not made.
        let again = propose(&mut world, 2 * INTERVAL);
        assert!(again.is_none_or(|id| { let (q, r) = proposal(&world, id).unwrap(); !(r.kind == p.kind && dist(q, pos) < 20) }));
    }

    #[test]
    fn the_queue_holds_five() {
        let mut world = country();
        let mut now = 0;
        for _ in 0..40 {
            now += INTERVAL;
            propose(&mut world, now);
        }
        assert_eq!(proposals(&world).len(), QUEUE);
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
                if here(&|k| matches!(k, BuildingKind::House | BuildingKind::Apartment)) { 'h' }
                else if here(&|k| matches!(k, BuildingKind::Shop | BuildingKind::Office)) { 's' }
                else if here(&|_| true) { 'F' }
                else if world.road_node_at(GridCoord { x, y }).is_some() { '.' }
                else { ' ' }
            }).collect();
            eprintln!("{row}");
        }
    }
}
