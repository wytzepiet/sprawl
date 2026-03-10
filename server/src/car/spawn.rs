use rand::Rng;

use crate::car::{GameEvent, ACCELERATION};
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::protocol::{Car, EntityId, GameObject};
use crate::world::pathfinding;
use crate::world::World;

const SPAWN_INTERVAL_MIN: u64 = 2_000;
const SPAWN_INTERVAL_MAX: u64 = 5_000;

pub fn schedule_car_spawn(events: &mut EventQueue<GameEvent>, building_id: EntityId) {
    let delay = rand::rng().random_range(SPAWN_INTERVAL_MIN..=SPAWN_INTERVAL_MAX);
    events.schedule(delay, GameEvent::CarSpawn { building_id }, None);
}

pub fn handle_car_spawn(
    world: &mut World,
    events: &mut EventQueue<GameEvent>,
    building_id: EntityId,
    now: GameTime,
) {
    if world.objects.get(building_id).is_none() {
        return;
    }

    schedule_car_spawn(events, building_id);

    let from_node = match world.road_node_for_building(building_id) {
        Some(id) => id,
        None => return,
    };

    let spawners = world.all_car_spawners();
    let destinations: Vec<&(EntityId, _)> = spawners
        .iter()
        .filter(|(id, _)| *id != building_id)
        .collect();

    if destinations.is_empty() {
        return;
    }

    let dest = destinations[rand::rng().random_range(0..destinations.len())];
    let dest_building_id = dest.0;

    let to_node = match world.road_node_for_building(dest_building_id) {
        Some(id) => id,
        None => return,
    };

    let segment_route = match pathfinding::find_path(world, from_node, to_node) {
        Some(r) if !r.is_empty() => r,
        _ => {
            println!("spawn: pathfinding failed from {:?} to {:?}", from_node, to_node);
            return;
        }
    };

    let route = pathfinding::expand_segment_route(world, &segment_route);
    if route.len() < 2 {
        println!("spawn: expanded route too short: {:?}", route);
        return;
    }

    println!(
        "spawn: car route len={}, segments={}, total_len={:.2}",
        route.len(),
        segment_route.len(),
        {
            let sl = world.compute_segment_lengths(&route);
            sl.iter().sum::<f64>()
        }
    );

    let segment_lengths = world.compute_segment_lengths(&route);
    let total_len: f64 = segment_lengths.iter().sum();

    // Precompute per-segment route indices and cumulative distances
    let mut segment_start_ris = Vec::with_capacity(segment_route.len());
    let mut segment_dist_starts = Vec::with_capacity(segment_route.len());
    let mut ri_offset = 0usize;
    let mut dist_offset = 0.0f64;
    for &seg_id in &segment_route {
        segment_start_ris.push(ri_offset);
        segment_dist_starts.push(dist_offset);
        let num_hops = world.segments[&seg_id].nodes.len() - 1;
        for j in 1..=num_hops {
            dist_offset += segment_lengths[ri_offset + j];
        }
        ri_offset += num_hops;
    }

    let first_seg = segment_route[0];

    let car_id = world.objects.insert(
        GameObject::Car(Car {
            route,
            progress: 0.0,
            speed: 0.0,
            acceleration: ACCELERATION,
            total_route_length: total_len,
            updated_at: now,
            route_index: 1,
            seg_fraction: 0.0,
            seg_length: segment_lengths[1],
            seg_start_dist: 0.0,
            segment_lengths,
            current_segment: first_seg,
            segment_route,
            segment_route_index: 0,
            segment_start_ris,
            segment_dist_starts,
        }),
        None,
    );

    world.segments.get_mut(&first_seg).unwrap().cars.push_back(car_id);
    events.schedule(0, GameEvent::CarWakeUp { car_id }, Some(car_id));
}
