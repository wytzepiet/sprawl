use crate::car::{physics, ACCELERATION, CAR_NOSE, CAR_TAIL, CRUISE_SPEED, MIN_GAP};
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::protocol::{EntityId, GameObject, Trip};
use crate::world::pathfinding;
use crate::world::World;

/// Send a parked car out from a road node to a building's driveway, owner
/// aboard. The node is usually a driveway too; for someone driving in from
/// off-map it is a road out past the frontier.
///
/// Returns false when the trip cannot start — the car is already out, the
/// destination has no driveway, no route exists, or something is sitting
/// where this car would pull in. The caller decides when to try again;
/// nothing is queued here.
pub fn start_trip(
    world: &mut World,
    events: &mut EventQueue,
    car_id: EntityId,
    from_node: EntityId,
    dest_building: EntityId,
    now: GameTime,
) -> bool {
    let owner = match world.objects.get(car_id).map(|e| &e.object) {
        Some(GameObject::Car(c)) if c.trip.is_none() => c.owner,
        _ => return false,
    };
    let Some(to_node) = world.road_node_for_building(dest_building) else {
        return false;
    };

    let route = match pathfinding::find_path(world, from_node, to_node) {
        Some(r) if r.len() >= 2 => r,
        _ => return false,
    };

    let segment_lengths = world.compute_segment_lengths(&route);
    let total_len: f64 = segment_lengths.iter().sum();
    let route_positions = world.route_positions(&route);
    let first_edge = (route[0], route[1]);
    let route_nodes = route.clone();

    // Don't pull out under a car blocking the start of the road.
    if let Some(seg) = world.edges.get(&first_edge)
        && let Some(&last_id) = seg.cars.back()
        && let Some(entry) = world.objects.get(last_id)
        && let GameObject::Car(ref blocker) = entry.object
        && let Some(ref blocker_trip) = blocker.trip
        && let Some(edge_start) = blocker_edge_start(blocker_trip, first_edge)
    {
        let dt = (now - blocker_trip.updated_at) as f64 / 1000.0;
        let (bp, _) = physics::catch_up(
            blocker_trip.progress,
            blocker_trip.speed,
            blocker_trip.acceleration,
            dt,
        );
        if bp - edge_start < MIN_GAP + CAR_NOSE + CAR_TAIL {
            return false;
        }
    }

    if let Some(start_pos) = world.objects.get(route_nodes[0]).and_then(|e| e.position) {
        world.update_position(car_id, start_pos);
    }
    if let Some(entry) = world.objects.get_mut(car_id)
        && let GameObject::Car(ref mut c) = entry.object
    {
        c.trip = Some(Trip {
            destination: dest_building,
            eta: now + (total_len / CRUISE_SPEED * 1000.0) as u64,
            route,
            route_positions,
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
        });
    }

    // The driver's `at` points at the car for the whole ride; arrival points
    // it at the destination.
    if let Some(entry) = world.objects.get_mut(owner)
        && let GameObject::Resident(ref mut r) = entry.object
    {
        r.at = Some(car_id);
    }

    // The run it is setting off along starts here, so the first junction it
    // reaches has something to measure against.
    world.car_segment.insert(car_id, (route_nodes[0], route_nodes[1], now));
    world.register_car_route(car_id, &route_nodes);
    if let Some(seg) = world.edges.get_mut(&first_edge) {
        seg.cars.push_back(car_id);
    }
    events.wake(0, car_id);
    true
}

/// Find the cumulative distance to the start of an edge in a trip's route.
fn blocker_edge_start(trip: &Trip, edge: (EntityId, EntityId)) -> Option<f64> {
    let (from, to) = edge;
    for i in 1..trip.route.len() {
        if trip.route[i - 1] == from && trip.route[i] == to {
            return Some(trip.segment_lengths[1..i].iter().sum());
        }
    }
    None
}
