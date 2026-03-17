use rand::Rng;

use crate::car::{physics, GameEvent, ACCELERATION, CAR_NOSE, CAR_TAIL, MIN_GAP};
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::protocol::{Car, EntityId, GameObject};
use crate::world::pathfinding;
use crate::world::World;

const SPAWN_INTERVAL_MIN: u64 = 4_000;
const SPAWN_INTERVAL_MAX: u64 = 8_000;

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

    let route = match pathfinding::find_path(world, from_node, to_node) {
        Some(r) if r.len() >= 2 => r,
        _ => {
            println!("spawn: pathfinding failed from {:?} to {:?}", from_node, to_node);
            return;
        }
    };

    let segment_lengths = world.compute_segment_lengths(&route);
    let total_len: f64 = segment_lengths.iter().sum();

    println!(
        "spawn: car route len={}, total_len={:.2}",
        route.len(),
        total_len,
    );

    let first_edge = (route[0], route[1]);
    let route_nodes = route.clone();

    // Don't spawn if a car is blocking the start of the road
    if let Some(seg) = world.edges.get(&first_edge)
        && let Some(&last_id) = seg.cars.back()
        && let Some(entry) = world.objects.get(last_id)
        && let GameObject::Car(ref blocker) = entry.object
        && let Some(edge_start) = blocker_edge_start(blocker, first_edge) {
            let dt = (now - blocker.updated_at) as f64 / 1000.0;
            let (bp, _) = physics::catch_up(blocker.progress, blocker.speed, blocker.acceleration, dt);
            if bp - edge_start < MIN_GAP + CAR_NOSE + CAR_TAIL {
                return;
            }
        }

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
        }),
        None,
    );

    world.register_car_route(car_id, &route_nodes);

    if let Some(seg) = world.edges.get_mut(&first_edge) {
        seg.cars.push_back(car_id);
    }
    events.schedule(0, GameEvent::CarWakeUp { car_id }, Some(car_id));
}

/// Find the cumulative distance to the start of an edge in a car's route.
fn blocker_edge_start(car: &Car, edge: (EntityId, EntityId)) -> Option<f64> {
    let (from, to) = edge;
    for i in 1..car.route.len() {
        if car.route[i - 1] == from && car.route[i] == to {
            return Some(car.segment_lengths[1..i].iter().sum());
        }
    }
    None
}
