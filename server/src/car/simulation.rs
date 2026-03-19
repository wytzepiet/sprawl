use crate::car::physics;
use crate::car::{
    ACCELERATION, CAR_NOSE, CAR_TAIL, GameEvent, INTERSECTION_STOP_MARGIN, MIN_GAP, Obstacle,
};
use crate::engine::GameTime;
use crate::engine::event_queue::EventQueue;
use crate::intersection::IntersectionRegistry;
use crate::protocol::{Car, EdgeKey, EntityId, GameObject};
use crate::world::World;

/// Despawn a car and clean up intersection registrations and edge deques.
pub fn despawn_car_fully(
    world: &mut World,
    intersections: &mut IntersectionRegistry,
    events: &mut EventQueue<GameEvent>,
    car_id: EntityId,
) {
    let car_info = world.objects.get(car_id).and_then(|entry| {
        if let GameObject::Car(ref car) = entry.object {
            Some((car.route.clone(), car.route_index))
        } else {
            None
        }
    });
    if let Some((route, route_index)) = car_info {
        world.unregister_car_route(car_id, &route);
        if route_index >= 1 {
            let edge = (route[route_index - 1], route[route_index]);
            if let Some(behind) = world.car_behind_on_edge(edge, car_id) {
                events.schedule(0, GameEvent::CarWakeUp { car_id: behind }, Some(behind));
            }
        }
    }

    let woken = intersections.remove_car_from_all(car_id);
    for (_node_id, woken_id) in woken {
        events.schedule(0, GameEvent::CarWakeUp { car_id: woken_id }, Some(woken_id));
    }
    events.clear_dedup(car_id);
    world.despawn_car(car_id);
}

/// Compute gap to a lead car on a shared edge.
fn lead_car_obstacle(
    world: &World,
    car: &Car,
    edge: EdgeKey,
    cur_progress: f64,
    lead_id: EntityId,
    now: GameTime,
) -> Option<Obstacle> {
    let entry = world.objects.get(lead_id)?;
    let GameObject::Car(ref lead) = entry.object else {
        return None;
    };

    // Both cars must be on this edge — find their seg_start_dist for the edge.
    // For the current car, use its seg_start_dist if it's on this edge, otherwise compute.
    let my_seg_start = edge_start_dist(car, edge)?;
    let lead_seg_start = edge_start_dist(lead, edge)?;

    let dt = (now - lead.updated_at) as f64 / 1000.0;
    let (lead_progress, lead_speed) =
        physics::catch_up(lead.progress, lead.speed, lead.acceleration, dt);

    let my_pos = cur_progress - my_seg_start;
    let lead_pos = lead_progress - lead_seg_start;

    let gap = lead_pos - my_pos;
    if gap <= 0.0 {
        return None;
    }

    Some(Obstacle::LeadCar {
        distance: (gap - MIN_GAP - CAR_NOSE - CAR_TAIL).max(0.0),
        speed: lead_speed,
        accel: lead.acceleration,
    })
}

/// Find the cumulative distance to the start of an edge for a car.
/// The edge (from, to) starts at the route index where `from` is route[k] and `to` is route[k+1].
fn edge_start_dist(car: &Car, edge: EdgeKey) -> Option<f64> {
    let (from, to) = edge;
    for i in 1..car.route.len() {
        if car.route[i - 1] == from && car.route[i] == to {
            // seg_start_dist for route_index i = sum of segment_lengths[1..i]
            let dist: f64 = car.segment_lengths[1..i].iter().sum();
            return Some(dist);
        }
    }
    None
}

/// Main car wake-up handler: ADVANCE → SCAN → DECIDE.
pub fn handle_car_wake_up(
    world: &mut World,
    events: &mut EventQueue<GameEvent>,
    intersections: &mut IntersectionRegistry,
    car_id: EntityId,
    now: GameTime,
) {
    let car = match world.objects.get(car_id) {
        Some(entry) => match &entry.object {
            GameObject::Car(c) => c.clone(),
            _ => return,
        },
        None => return,
    };

    // === ADVANCE ===
    let dt = (now - car.updated_at) as f64 / 1000.0;
    let (cur_progress, cur_speed) =
        physics::catch_up(car.progress, car.speed, car.acceleration, dt);

    let mut ri = car.route_index;
    let mut seg_start = car.seg_start_dist;
    let old_ri = ri;

    loop {
        let seg_len = car.segment_lengths[ri];
        if cur_progress - seg_start < seg_len {
            break;
        }

        // --- WARN: crossing node route[ri] ---
        let node = car.route[ri];

        // Crossing a turn too fast?
        if ri > 0 && ri < car.route.len() - 1 {
            let expected = physics::turn_speed(world.turn_cos_angle(&car.route, ri));
            if cur_speed > expected + 0.3 {
                eprintln!(
                    "WARN [car {}] crossed node {} (ri={}) at speed {:.2}, turn_speed={:.2} (dt={:.0}ms)",
                    car_id, node, ri, cur_speed, expected, dt * 1000.0
                );
            }
        }

        // Crossing a blocked intersection?
        if world.is_intersection(node) && !intersections.has_passage(node, car_id) {
            eprintln!(
                "WARN [car {}] crossed BLOCKED intersection {} (ri={}) at speed {:.2} (dt={:.0}ms)",
                car_id, node, ri, cur_speed, dt * 1000.0
            );
        }

        if ri + 1 >= car.route.len() {
            despawn_car_fully(world, intersections, events, car_id);
            return;
        }
        seg_start += seg_len;
        ri += 1;
    }

    // Handle edge transitions: remove from old edges, wake cars behind, add to new edge
    for k in old_ri..ri {
        let old_edge: EdgeKey = (car.route[k - 1], car.route[k]);
        let car_behind = world.car_behind_on_edge(old_edge, car_id);
        if let Some(seg) = world.edges.get_mut(&old_edge) {
            seg.cars.retain(|&id| id != car_id);
        }
        if let Some(behind) = car_behind {
            events.schedule(0, GameEvent::CarWakeUp { car_id: behind }, Some(behind));
        }
        // Car has fully left route[k-1] — remove from node_cars index
        if let Some(set) = world.node_cars.get_mut(&car.route[k - 1]) {
            set.remove(&car_id);
        }
    }
    // Add to current edge if we transitioned
    if ri != old_ri {
        let current_edge: EdgeKey = (car.route[ri - 1], car.route[ri]);
        if let Some(seg) = world.edges.get_mut(&current_edge)
            && !seg.cars.contains(&car_id)
        {
            seg.cars.push_back(car_id);
        }
    }

    // Clear intersections the car drove through
    for k in old_ri..ri {
        let node = car.route[k];
        for woken_id in intersections.clear_car(node, car_id) {
            events.schedule(0, GameEvent::CarWakeUp { car_id: woken_id }, Some(woken_id));
        }
    }

    // === SCAN ===
    let current_edge: EdgeKey = (car.route[ri - 1], car.route[ri]);
    let seg_progress = cur_progress - seg_start;
    let remaining = car.segment_lengths[ri] - seg_progress;
    let mut obstacles = Vec::<Obstacle>::new();

    // Register at upcoming intersections
    let lookahead = (ri + 3).min(car.route.len());
    for k in ri..lookahead {
        if world.is_intersection(car.route[k]) && k > 0 && k + 1 < car.route.len() {
            if let Some(int_pos) = world.objects.get(car.route[k]).and_then(|e| e.position)
                && let Some(from_pos) = world.objects.get(car.route[k - 1]).and_then(|e| e.position)
                && let Some(to_pos) = world.objects.get(car.route[k + 1]).and_then(|e| e.position)
            {
                let from_dir = (from_pos.x - int_pos.x, from_pos.y - int_pos.y);
                let to_dir = (to_pos.x - int_pos.x, to_pos.y - int_pos.y);
                intersections
                    .get_or_create(car.route[k])
                    .register(car_id, from_dir, to_dir);
            }
            if !intersections.has_passage(car.route[k], car_id) {
                break;
            }
        }
    }

    // Pre-register on next edge when passage is granted at the junction
    if ri + 1 < car.route.len() {
        let end_node = car.route[ri];
        if !world.is_intersection(end_node) || intersections.has_passage(end_node, car_id) {
            let next_edge: EdgeKey = (car.route[ri], car.route[ri + 1]);
            if let Some(next_seg) = world.edges.get_mut(&next_edge)
                && !next_seg.cars.contains(&car_id)
            {
                next_seg.cars.push_back(car_id);
            }
        }
    }

    // Lead car: check current edge deque
    if let Some(seg) = world.edges.get(&current_edge)
        && let Some(my_pos) = seg.car_position(car_id)
        && my_pos > 0
    {
        let lead_id = seg.cars[my_pos - 1];
        if let Some(obs) =
            lead_car_obstacle(world, &car, current_edge, cur_progress, lead_id, now)
        {
            obstacles.push(obs);
        }
    }
    // Also check the next edge — we may be pre-registered there
    if ri + 1 < car.route.len() {
        let next_edge: EdgeKey = (car.route[ri], car.route[ri + 1]);
        if let Some(next_seg) = world.edges.get(&next_edge)
            && let Some(my_pos) = next_seg.car_position(car_id)
            && my_pos > 0
        {
            let lead_id = next_seg.cars[my_pos - 1];
            if let Some(obs) =
                lead_car_obstacle(world, &car, next_edge, cur_progress, lead_id, now)
            {
                obstacles.push(obs);
            }
        }
    }

    // SpeedLimit at approaching node route[ri]
    let entry_ri = remaining - 0.5 * car.segment_lengths[ri] - CAR_NOSE;
    if entry_ri > 0.0 {
        if ri > 0 && ri < car.route.len() - 1 {
            let ts = physics::turn_speed(world.turn_cos_angle(&car.route, ri));
            obstacles.push(Obstacle::SpeedLimit {
                distance: entry_ri,
                speed: ts,
            });
        }
        if world.is_intersection(car.route[ri]) && !intersections.has_passage(car.route[ri], car_id)
        {
            obstacles.push(Obstacle::MustStop {
                distance: (entry_ri - INTERSECTION_STOP_MARGIN).max(0.0),
            });
        }
    }

    // Scan forward nodes
    let mut node_dist = remaining;
    let limit = car.route.len().min(ri + 30);

    for k in (ri + 1)..limit {
        node_dist += car.segment_lengths[k];
        let entry_k = node_dist - 0.5 * car.segment_lengths[k] - CAR_NOSE;

        let node = car.route[k];

        if world.is_intersection(node) && !intersections.has_passage(node, car_id) {
            obstacles.push(Obstacle::MustStop {
                distance: (entry_k - INTERSECTION_STOP_MARGIN).max(0.0),
            });
            break;
        }

        if k < car.route.len() - 1 {
            obstacles.push(Obstacle::SpeedLimit {
                distance: entry_k,
                speed: physics::turn_speed(world.turn_cos_angle(&car.route, k)),
            });
        }
    }

    // === DECIDE ===
    let new_accel = obstacles
        .iter()
        .map(|o| o.required_accel(cur_speed))
        .fold(ACCELERATION, f64::min);

    let mut wake_ms = obstacles
        .iter()
        .map(|o| o.wake_time(cur_speed, new_accel))
        .fold(5000u64, u64::min);

    // Ensure wake before edge boundary for deque transition
    if cur_speed > 1e-3 {
        let time_to_edge_end = remaining / cur_speed;
        wake_ms = wake_ms.min(((time_to_edge_end * 1000.0) as u64).max(10));
    }

    events.schedule(wake_ms, GameEvent::CarWakeUp { car_id }, Some(car_id));

    let accel_changed = ((new_accel - car.acceleration) / ACCELERATION).abs() > 0.02;

    // Wake car behind on acceleration change
    if accel_changed {
        let delay = if new_accel < 0.0 { 50 } else { 400 };
        if let Some(behind) = world.car_behind_on_edge(current_edge, car_id) {
            events.schedule(delay, GameEvent::CarWakeUp { car_id: behind }, Some(behind));
        }
        // Cross-edge: front car on previous edge
        if ri >= 2 {
            let prev_edge: EdgeKey = (car.route[ri - 2], car.route[ri - 1]);
            if let Some(prev_seg) = world.edges.get(&prev_edge)
                && let Some(&front_id) = prev_seg.cars.front()
                && front_id != car_id
            {
                events.schedule(delay, GameEvent::CarWakeUp { car_id: front_id }, Some(front_id));
            }
        }
    }

    // Update spatial position when car crosses a node
    if ri != old_ri {
        if let Some(node_pos) = world.objects.get(car.route[ri - 1]).and_then(|e| e.position) {
            world.update_position(car_id, node_pos);
        }
    }

    let entry = if accel_changed {
        world.objects.get_mut(car_id)
    } else {
        world.objects.get_mut_silent(car_id)
    };
    if let Some(entry) = entry
        && let GameObject::Car(ref mut c) = entry.object
    {
        c.progress = cur_progress;
        c.speed = cur_speed;
        c.updated_at = now;
        c.route_index = ri;
        let seg_len = car.segment_lengths[ri];
        c.seg_fraction = if seg_len > 1e-9 {
            (cur_progress - seg_start) / seg_len
        } else {
            0.0
        };
        c.seg_length = seg_len;
        c.seg_start_dist = seg_start;
        if accel_changed {
            c.acceleration = new_accel;
        }
    }
}
