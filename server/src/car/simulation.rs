use crate::car::physics;
use crate::car::{
    ACCELERATION, CAR_NOSE, CAR_TAIL, GameEvent, INTERSECTION_STOP_MARGIN, MIN_GAP, Obstacle,
};
use crate::engine::GameTime;
use crate::engine::event_queue::EventQueue;
use crate::intersection::IntersectionRegistry;
use crate::protocol::{Car, EntityId, GameObject};
use crate::world::World;

/// Despawn a car and clean up intersection registrations and segment deques.
pub fn despawn_car_fully(
    world: &mut World,
    intersections: &mut IntersectionRegistry,
    events: &mut EventQueue<GameEvent>,
    car_id: EntityId,
) {
    if let Some(entry) = world.objects.get(car_id)
        && let GameObject::Car(ref car) = entry.object
        && let Some(behind) = world.car_behind_on_segment(car.current_segment, car_id)
    {
        events.schedule(0, GameEvent::CarWakeUp { car_id: behind }, Some(behind));
    }

    let woken = intersections.remove_car_from_all(car_id);
    for (_node_id, woken_id) in woken {
        events.schedule(0, GameEvent::CarWakeUp { car_id: woken_id }, Some(woken_id));
    }
    events.clear_dedup(car_id);
    world.despawn_car(car_id);
}

/// Compute gap to a lead car. Works both same-segment and cross-segment:
/// finds the lead's index for the shared segment via segment_route lookup.
fn lead_car_obstacle(
    world: &World,
    car: &Car,
    car_seg_idx: usize,
    cur_progress: f64,
    lead_id: EntityId,
    now: GameTime,
) -> Option<Obstacle> {
    let entry = world.objects.get(lead_id)?;
    let GameObject::Car(ref lead) = entry.object else {
        return None;
    };

    let expected_seg = car.segment_route[car_seg_idx];
    let lead_seg_idx = lead.segment_route.iter().position(|&s| s == expected_seg)?;

    let dt = (now - lead.updated_at) as f64 / 1000.0;
    let (lead_progress, lead_speed) =
        physics::catch_up(lead.progress, lead.speed, lead.acceleration, dt);

    let my_seg_pos = cur_progress - car.segment_dist_starts[car_seg_idx];
    let lead_seg_pos = lead_progress - lead.segment_dist_starts[lead_seg_idx];

    let gap = lead_seg_pos - my_seg_pos;
    if gap <= 0.0 {
        return None;
    }

    Some(Obstacle::LeadCar {
        distance: (gap - MIN_GAP - CAR_NOSE - CAR_TAIL).max(0.0),
        speed: lead_speed,
        accel: lead.acceleration,
    })
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
                    car_id,
                    node,
                    ri,
                    cur_speed,
                    expected,
                    dt * 1000.0
                );
            }
        }

        // Crossing a blocked intersection?
        if world.is_intersection(node) && !intersections.has_passage(node, car_id) {
            eprintln!(
                "WARN [car {}] crossed BLOCKED intersection {} (ri={}) at speed {:.2} (dt={:.0}ms)",
                car_id,
                node,
                ri,
                cur_speed,
                dt * 1000.0
            );
        }

        if ri + 1 >= car.route.len() {
            despawn_car_fully(world, intersections, events, car_id);
            return;
        }
        seg_start += seg_len;
        ri += 1;
    }

    // Detect segment transitions
    let old_segment_route_index = car.segment_route_index;
    let mut segment_route_index = car.segment_route_index;

    loop {
        let seg_id = car.segment_route[segment_route_index];
        let seg_nodes_len = match world.segments.get(&seg_id) {
            Some(s) => s.nodes.len(),
            None => break,
        };
        let seg_end_ri = car.segment_start_ris[segment_route_index] + seg_nodes_len - 1;
        if ri <= seg_end_ri {
            break;
        }
        if segment_route_index + 1 >= car.segment_route.len() {
            break;
        }
        segment_route_index += 1;
    }

    let current_segment = car.segment_route[segment_route_index];

    // Handle segment transitions: remove from old segments, wake cars behind
    if segment_route_index != old_segment_route_index {
        for idx in old_segment_route_index..segment_route_index {
            let old_seg_id = car.segment_route[idx];
            let car_behind = world.car_behind_on_segment(old_seg_id, car_id);
            if let Some(seg) = world.segments.get_mut(&old_seg_id) {
                seg.cars.retain(|&id| id != car_id);
            }
            if let Some(behind) = car_behind {
                events.schedule(0, GameEvent::CarWakeUp { car_id: behind }, Some(behind));
            }
        }
        // Add to new segment (may already be there from pre-registration)
        if let Some(seg) = world.segments.get_mut(&current_segment)
            && !seg.cars.contains(&car_id)
        {
            seg.cars.push_back(car_id);
        }
    }

    // Clear intersections the car drove through
    for k in old_ri..ri {
        let node = car.route[k];
        if world.is_intersection(node) {
            for woken_id in intersections.get_or_create(node).clear(car_id) {
                events.schedule(0, GameEvent::CarWakeUp { car_id: woken_id }, Some(woken_id));
            }
        }
    }

    // === SCAN ===
    let seg_progress = cur_progress - seg_start;
    let remaining = car.segment_lengths[ri] - seg_progress;
    let mut obstacles = Vec::<Obstacle>::new();

    // Register at upcoming intersections (all within lookahead, not just the first)
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
            // Stop looking past an intersection we're still waiting for
            if !intersections.has_passage(car.route[k], car_id) {
                break;
            }
        }
    }

    // Pre-register on next segment when passage is granted.
    // Stay in current segment too — removal happens at physical crossing (above).
    // This way the car behind still sees us as a lead car while we cross.
    if segment_route_index + 1 < car.segment_route.len()
        && let Some(current_seg) = world.segments.get(&current_segment)
    {
        let end_junction = current_seg.end_junction();
        if world.is_intersection(end_junction)
            && intersections.has_passage(end_junction, car_id)
        {
            let next_seg_id = car.segment_route[segment_route_index + 1];
            if let Some(next_seg) = world.segments.get_mut(&next_seg_id)
                && !next_seg.cars.contains(&car_id)
            {
                next_seg.cars.push_back(car_id);
            }
        }
    }

    // Lead car: check current segment deque, then next segment if pre-registered
    if let Some(seg) = world.segments.get(&current_segment)
        && let Some(my_pos) = seg.car_position(car_id)
        && my_pos > 0
    {
        let lead_id = seg.cars[my_pos - 1];
        if let Some(obs) =
            lead_car_obstacle(world, &car, segment_route_index, cur_progress, lead_id, now)
        {
            obstacles.push(obs);
        }
    }
    // Also check the next segment — we may be pre-registered there
    if segment_route_index + 1 < car.segment_route.len() {
        let next_seg_id = car.segment_route[segment_route_index + 1];
        if let Some(next_seg) = world.segments.get(&next_seg_id)
            && let Some(my_pos) = next_seg.car_position(car_id)
            && my_pos > 0
        {
            let lead_id = next_seg.cars[my_pos - 1];
            if let Some(obs) =
                lead_car_obstacle(world, &car, segment_route_index + 1, cur_progress, lead_id, now)
            {
                obstacles.push(obs);
            }
        }
    }

    // SpeedLimit at approaching node route[ri]
    // Target curve entry: curve starts 0.5 * segment_length before the node
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

    // Scan forward nodes: segment_lengths[k] = distance from route[k-1] to route[k]
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

    let wake_ms = obstacles
        .iter()
        .map(|o| o.wake_time(cur_speed, new_accel))
        .fold(5000, u64::min);

    events.schedule(wake_ms, GameEvent::CarWakeUp { car_id }, Some(car_id));

    let accel_changed = ((new_accel - car.acceleration) / ACCELERATION).abs() > 0.1;

    // Wake car behind on acceleration change (braking propagates fast, acceleration slow)
    if accel_changed {
        let delay = if new_accel < 0.0 { 50 } else { 400 };
        // Same-segment: car behind in deque
        if let Some(behind) = world.car_behind_on_segment(current_segment, car_id) {
            events.schedule(delay, GameEvent::CarWakeUp { car_id: behind }, Some(behind));
        }
        // Cross-segment: front car on previous segment (it sees us as cross-segment lead)
        if segment_route_index > 0 {
            let prev_seg_id = car.segment_route[segment_route_index - 1];
            if let Some(prev_seg) = world.segments.get(&prev_seg_id)
                && let Some(&front_id) = prev_seg.cars.front()
                && front_id != car_id
            {
                events.schedule(delay, GameEvent::CarWakeUp { car_id: front_id }, Some(front_id));
            }
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
        c.segment_route_index = segment_route_index;
        c.current_segment = current_segment;
        if accel_changed {
            c.acceleration = new_accel;
        }
    }
}
