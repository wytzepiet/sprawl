use crate::car::{physics, ACCELERATION, CAR_NOSE, CAR_TAIL, CRUISE_SPEED, LOT_SPEED, MIN_GAP};
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::protocol::{EntityId, GameObject, Trip};
use crate::world::pathfinding;
use crate::world::World;

/// Send a parked car out to a spot at a building, owner aboard. It leaves
/// from the spot it holds, if it holds one, else from the node given: the
/// driveway it stands on, or for someone driving in from off-map a road out
/// past the frontier.
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
    let Some(to_node) = world.approach(dest_building) else {
        return false;
    };
    let out = world.way_out(car_id).unwrap_or_default();
    let from_node = out.last().copied().unwrap_or(from_node);

    let path = match pathfinding::find_path(world, from_node, to_node) {
        Some(r) if r.len() >= 2 => r,
        _ => return false,
    };
    let from_lot = out.len().saturating_sub(1);
    let head: Vec<EntityId> = out[..from_lot].iter().copied().chain(path).collect();

    // Don't pull out under a car blocking the start of the road.
    let first_edge = (head[0], head[1]);
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

    // Nothing else can refuse the trip now, so the place at the far end is
    // claimed, and the one here let go of.
    let Some(way_in) = world.way_in(dest_building, car_id) else { return false };
    let to_lot = way_in.len() - 1;
    let route: Vec<EntityId> = head.into_iter().chain(way_in[1..].iter().copied()).collect();

    let segment_lengths = world.compute_segment_lengths(&route, from_lot, to_lot);
    let total_len: f64 = segment_lengths.iter().sum();
    // The lot's edges are the ones into and out of it: as many at each end
    // as there are lot nodes there, since the street node closes each run.
    let lot_len: f64 = segment_lengths[1..=from_lot].iter().sum::<f64>()
        + segment_lengths[segment_lengths.len() - to_lot..].iter().sum::<f64>();
    let street_len = total_len - lot_len;
    let route_positions = world.route_positions(&route);
    let route_nodes = route.clone();

    if let Some(start_pos) = world.objects.get(route_nodes[0]).and_then(|e| e.position) {
        world.update_position(car_id, start_pos);
    }
    if let Some(entry) = world.objects.get_mut(car_id)
        && let GameObject::Car(ref mut c) = entry.object
    {
        c.trip = Some(Trip {
            destination: dest_building,
            eta: now + ((street_len / CRUISE_SPEED + lot_len / LOT_SPEED) * 1000.0) as u64,
            route,
            route_positions,
            from_lot,
            to_lot,
            progress: 0.0,
            speed: 0.0,
            acceleration: ACCELERATION,
            total_route_length: total_len,
            street_length: street_len,
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
