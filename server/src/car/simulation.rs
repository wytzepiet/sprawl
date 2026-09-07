use crate::car::physics;
use crate::car::{
    ACCELERATION, CAR_NOSE, CAR_TAIL, INTERSECTION_STOP_MARGIN, LOT_SPEED, MIN_GAP, Obstacle,
};
use crate::engine::GameTime;
use crate::engine::event_queue::EventQueue;
use crate::intersection::IntersectionRegistry;
use crate::protocol::{EdgeKey, EntityId, GameObject, Trip};
use crate::world::World;

/// End a car's trip and leave it parked at a building: road bookkeeping
/// cleaned up, trip gone, position at the building it now sits by.
///
/// If the driver is still aboard they step out here and think again — which
/// on arrival is the plan, and on an interrupted trip is the recovery.
///
/// A car with nowhere to park (the building is gone) is scrapped; settle
/// re-issues cars, so nothing is lost but the paint.
pub fn park_car(
    world: &mut World,
    intersections: &mut IntersectionRegistry,
    events: &mut EventQueue,
    car_id: EntityId,
    at_building: EntityId,
) {
    world.car_segment.remove(&car_id);
    let mut owner = None;
    let trip_info = world.objects.get(car_id).and_then(|entry| {
        if let GameObject::Car(ref car) = entry.object {
            owner = Some(car.owner);
            car.trip.as_ref().map(|t| (t.route.clone(), t.route_index, t.total_route_length))
        } else {
            None
        }
    });
    if let Some((route, route_index, driven)) = trip_info {
        if let Some(owner) = owner {
            crate::resident::drove(world, owner, driven);
        }
        world.unregister_car_route(car_id, &route);
        if route_index >= 1 {
            let edge = (route[route_index - 1], route[route_index]);
            if let Some(behind) = world.car_behind_on_edge(edge, car_id) {
                events.wake(0, behind);
            }
        }
    }
    let woken = intersections.remove_car_from_all(car_id);
    for (_node_id, woken_id) in woken {
        events.wake(0, woken_id);
    }
    events.clear_dedup(car_id);
    world.remove_car_from_edges(car_id);

    match world.objects.get(at_building).and_then(|e| e.position) {
        Some(tile) => {
            world.update_position(car_id, tile);
            if let Some(entry) = world.objects.get_mut(car_id)
                && let GameObject::Car(ref mut c) = entry.object
            {
                c.trip = None;
            }
            world.park_in_lot(at_building, car_id);
        }
        None => world.despawn_car(car_id),
    }

    // The driver steps out wherever the car stopped.
    if let Some(owner) = owner {
        let aboard = world.objects.get(owner).is_some_and(|e| match e.object {
            GameObject::Resident(ref r) => r.at == Some(car_id),
            _ => false,
        });
        if aboard {
            crate::resident::set_at(world, owner, at_building, events.now());
            events.wake(0, owner);
        }
    }
}

/// Park a car at its owner's home — where a trip that cannot continue ends.
pub fn park_at_home(
    world: &mut World,
    intersections: &mut IntersectionRegistry,
    events: &mut EventQueue,
    car_id: EntityId,
) {
    let home = world.objects.get(car_id).and_then(|e| match e.object {
        GameObject::Car(ref c) => Some(c.owner),
        _ => None,
    });
    let home = home.and_then(|owner| {
        world.objects.get(owner).and_then(|e| match e.object {
            GameObject::Resident(ref r) => Some(r.home),
            _ => None,
        })
    });
    match home {
        Some(home) => park_car(world, intersections, events, car_id, home),
        // No owner to speak of: scrap it.
        None => {
            events.clear_dedup(car_id);
            let _ = intersections.remove_car_from_all(car_id);
            world.despawn_car(car_id);
        }
    }
}

/// Leave the stretches crossed since the last wake, segments `old_ri` up to
/// `ri`: off their queues, waking whoever was behind; out of the node index
/// for the nodes passed; and out of the junctions passed.
fn leave_crossed(
    world: &mut World,
    events: &mut EventQueue,
    intersections: &mut IntersectionRegistry,
    car_id: EntityId,
    trip: &Trip,
    old_ri: usize,
    ri: usize,
) {
    for k in old_ri..ri {
        let old_edge: EdgeKey = (trip.route[k - 1], trip.route[k]);
        let car_behind = world.car_behind_on_edge(old_edge, car_id);
        if let Some(seg) = world.edges.get_mut(&old_edge) {
            seg.cars.retain(|&id| id != car_id);
        }
        if let Some(behind) = car_behind {
            events.wake(0, behind);
        }
        if let Some(set) = world.node_cars.get_mut(&trip.route[k - 1]) {
            set.remove(&car_id);
        }
        for woken_id in intersections.clear_car(trip.route[k], car_id) {
            events.wake(0, woken_id);
        }
    }
}

/// The arm from a junction toward a neighbour on the route, as a grid step:
/// exact for a road node, the nearest for a lot node beside the junction.
fn arm(world: &World, junction: EntityId, toward: EntityId) -> Option<(i32, i32)> {
    let j = world.node_pos(junction)?;
    let t = world.node_pos(toward)?;
    let (dx, dy) = (t[0] - j[0], t[1] - j[1]);
    let m = dx.abs().max(dy.abs());
    (m > 1e-9).then(|| ((dx / m).round() as i32, (dy / m).round() as i32))
}

/// Compute gap to a lead car on a shared edge.
fn lead_car_obstacle(
    world: &World,
    trip: &Trip,
    edge: EdgeKey,
    cur_progress: f64,
    lead_id: EntityId,
    now: GameTime,
) -> Option<Obstacle> {
    let entry = world.objects.get(lead_id)?;
    let GameObject::Car(ref lead) = entry.object else {
        return None;
    };
    let lead = lead.trip.as_ref()?;

    // Both cars must be on this edge — find their seg_start_dist for the edge.
    let my_seg_start = edge_start_dist(trip, edge)?;
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

/// Find the cumulative distance to the start of an edge for a trip.
/// The edge (from, to) starts at the route index where `from` is route[k] and `to` is route[k+1].
fn edge_start_dist(trip: &Trip, edge: EdgeKey) -> Option<f64> {
    let (from, to) = edge;
    for i in 1..trip.route.len() {
        if trip.route[i - 1] == from && trip.route[i] == to {
            // seg_start_dist for route_index i = sum of segment_lengths[1..i]
            let dist: f64 = trip.segment_lengths[1..i].iter().sum();
            return Some(dist);
        }
    }
    None
}

/// Main car wake-up handler: ADVANCE → SCAN → DECIDE.
pub fn handle_car_wake_up(
    world: &mut World,
    events: &mut EventQueue,
    intersections: &mut IntersectionRegistry,
    car_id: EntityId,
    now: GameTime,
) {
    let (owner, trip) = match world.objects.get(car_id) {
        Some(entry) => match &entry.object {
            // A parked car has nothing to think about — unless it is a
            // vehicle on a call, which has finished unloading.
            GameObject::Car(c) => match c.trip.clone() {
                Some(t) => (c.owner, t),
                None => {
                    crate::calls::car_idle(world, events, car_id, now);
                    return;
                }
            },
            _ => return,
        },
        None => return,
    };

    // === ADVANCE ===
    let dt = (now - trip.updated_at) as f64 / 1000.0;
    let (cur_progress, cur_speed) =
        physics::catch_up(trip.progress, trip.speed, trip.acceleration, dt);

    let mut ri = trip.route_index;
    let mut seg_start = trip.seg_start_dist;
    let old_ri = ri;

    loop {
        let seg_len = trip.segment_lengths[ri];
        if cur_progress - seg_start < seg_len {
            break;
        }

        // --- WARN: crossing node route[ri] ---
        let node = trip.route[ri];

        // Crossing a turn too fast?
        if ri > 0 && ri < trip.route.len() - 1 {
            let expected = physics::turn_speed(world.turn_cos_angle(&trip.route, ri));
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

        // A run of road ends here, so whatever it took to drive is now known.
        //
        // Timed from when the car actually reached the line rather than from
        // when it next woke. A wake lands near a boundary, not on it — the
        // estimate that schedules it assumes a steady speed, and a car pulling
        // away from rest gets no such wake at all — so using `now` would make
        // a driveway look several times slower or faster than it is. Over a
        // long run that error is noise; over a single tile it is the whole
        // measurement.
        //
        // The other case is a car that joined partway along: someone arriving
        // from off the map starts wherever the road out past the frontier
        // reaches, which is rarely a junction. A part-driven run says nothing
        // about the whole one, and `observe_passage` refuses it, being the one
        // that knows what joins what. Either way the car starts afresh here.
        if world.network.is_junction(node) {
            let crossed_at = physics::time_to_reach(
                trip.progress,
                trip.speed,
                trip.acceleration,
                seg_start + seg_len,
            )
            .map_or(now, |t| trip.updated_at + (t * 1000.0) as u64);

            if let Some(&(entered, first, at)) = world.car_segment.get(&car_id)
                && entered != node
                && crossed_at > at
            {
                world.network.observe_passage(entered, first, (crossed_at - at) as f64);
            }
            if let Some(&onward) = trip.route.get(ri + 1) {
                world.car_segment.insert(car_id, (node, onward, crossed_at));
            }
        }

        if ri + 1 >= trip.route.len() {
            // Journey's end: the driver steps out, the car stays. A vehicle
            // on a call unloads, and thinks again when it is done. The
            // stretches crossed on the way here are left like any others,
            // or the car would stay on their queues as a ghost.
            leave_crossed(world, events, intersections, car_id, &trip, old_ri, ri);
            crate::resident::arrival_readout(world, owner, trip.destination, trip.eta, trip.street_length, now);
            park_car(world, intersections, events, car_id, trip.destination);
            let truck = matches!(world.objects.get(car_id).map(|e| &e.object), Some(GameObject::Car(c)) if c.role != crate::protocol::CarRole::Private);
            if truck {
                events.wake(crate::calls::SERVICE_MS, car_id);
            } else {
                crate::calls::visit(world, events, trip.destination, now);
            }
            return;
        }
        seg_start += seg_len;
        ri += 1;
    }

    leave_crossed(world, events, intersections, car_id, &trip, old_ri, ri);
    // Add to current edge if we transitioned
    if ri != old_ri {
        let current_edge: EdgeKey = (trip.route[ri - 1], trip.route[ri]);
        if let Some(seg) = world.edges.get_mut(&current_edge)
            && !seg.cars.contains(&car_id)
        {
            seg.cars.push_back(car_id);
        }
    }

    // === SCAN ===
    let current_edge: EdgeKey = (trip.route[ri - 1], trip.route[ri]);
    let seg_progress = cur_progress - seg_start;
    let remaining = trip.segment_lengths[ri] - seg_progress;
    let mut obstacles = Vec::<Obstacle>::new();

    // Register at upcoming intersections
    let lookahead = (ri + 3).min(trip.route.len());
    for k in ri..lookahead {
        if world.is_intersection(trip.route[k]) && k > 0 && k + 1 < trip.route.len() {
            if let Some(from_dir) = arm(world, trip.route[k], trip.route[k - 1])
                && let Some(to_dir) = arm(world, trip.route[k], trip.route[k + 1])
            {
                intersections
                    .get_or_create(trip.route[k])
                    .register(car_id, from_dir, to_dir);
            }
            if !intersections.has_passage(trip.route[k], car_id) {
                break;
            }
        }
    }

    // Pre-register on next edge when passage is granted at the junction
    if ri + 1 < trip.route.len() {
        let end_node = trip.route[ri];
        if !world.is_intersection(end_node) || intersections.has_passage(end_node, car_id) {
            let next_edge: EdgeKey = (trip.route[ri], trip.route[ri + 1]);
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
            lead_car_obstacle(world, &trip, current_edge, cur_progress, lead_id, now)
        {
            obstacles.push(obs);
        }
    }
    // Also check the next edge — we may be pre-registered there
    if ri + 1 < trip.route.len() {
        let next_edge: EdgeKey = (trip.route[ri], trip.route[ri + 1]);
        if let Some(next_seg) = world.edges.get(&next_edge)
            && let Some(my_pos) = next_seg.car_position(car_id)
            && my_pos > 0
        {
            let lead_id = next_seg.cars[my_pos - 1];
            if let Some(obs) =
                lead_car_obstacle(world, &trip, next_edge, cur_progress, lead_id, now)
            {
                obstacles.push(obs);
            }
        }
    }

    // SpeedLimit at approaching node route[ri]
    //
    // The bend is rounded, so it begins half an edge back from the node — and
    // it does not end there either. Dropping the limit once the car reaches
    // the start of the bend let it brake correctly to the turn speed and then
    // accelerate straight through the corner, arriving at the node at twice
    // what the corner allows. Held to zero instead, so it carries the speed it
    // slowed to through the turn rather than only up to it.
    let entry_ri = remaining - 0.5 * trip.segment_lengths[ri] - CAR_NOSE;
    // In a lot, a crawl: on any edge that ends at a lot node, from its start.
    if world.lot_nodes.contains_key(&trip.route[ri]) {
        obstacles.push(Obstacle::SpeedLimit { distance: 0.0, speed: LOT_SPEED });
    }
    if ri > 0 && ri < trip.route.len() - 1 {
        let ts = physics::turn_speed(world.turn_cos_angle(&trip.route, ri));
        obstacles.push(Obstacle::SpeedLimit {
            distance: entry_ri.max(0.0),
            speed: ts,
        });
    }
    // Held to the stop line the same way, and for the same reason: dropping it
    // once the car reached the line meant a car in the last half edge before a
    // junction it has no claim on had nothing left telling it to wait.
    if world.is_intersection(trip.route[ri]) && !intersections.has_passage(trip.route[ri], car_id) {
        obstacles.push(Obstacle::MustStop {
            distance: (entry_ri - INTERSECTION_STOP_MARGIN).max(0.0),
        });
    }

    // Scan forward nodes
    let mut node_dist = remaining;
    let limit = trip.route.len().min(ri + 30);

    for k in (ri + 1)..limit {
        node_dist += trip.segment_lengths[k];
        let entry_k = node_dist - 0.5 * trip.segment_lengths[k] - CAR_NOSE;

        let node = trip.route[k];

        // A trip that ends on a junction stops there; it never registered
        // for passage, so waiting for it would be waiting for ever.
        if k + 1 < trip.route.len() && world.is_intersection(node) && !intersections.has_passage(node, car_id) {
            obstacles.push(Obstacle::MustStop {
                distance: (entry_k - INTERSECTION_STOP_MARGIN).max(0.0),
            });
            break;
        }

        if world.lot_nodes.contains_key(&node) {
            obstacles.push(Obstacle::SpeedLimit {
                distance: (node_dist - trip.segment_lengths[k] - CAR_NOSE).max(0.0),
                speed: LOT_SPEED,
            });
        }
        if k < trip.route.len() - 1 {
            obstacles.push(Obstacle::SpeedLimit {
                distance: entry_k,
                speed: physics::turn_speed(world.turn_cos_angle(&trip.route, k)),
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

    // Be awake when this stretch ends, because crossing is when the car has to
    // change edge deques and clear the junction behind it — and it cannot do
    // either while it is asleep.
    //
    // Solved with the acceleration it is about to drive with, not at whatever
    // speed it happens to hold now. Dividing the distance by the current speed
    // said "never" for a car pulling away from rest, which let it sleep through
    // a junction and take the turn at twice the speed the turn allows.
    if let Some(t) = physics::time_to_reach(0.0, cur_speed, new_accel, remaining) {
        wake_ms = wake_ms.min(((t * 1000.0) as u64).max(1));
    }

    events.wake(wake_ms, car_id);

    let accel_changed = ((new_accel - trip.acceleration) / ACCELERATION).abs() > 0.02;

    // Wake car behind on acceleration change
    if accel_changed {
        let delay = if new_accel < 0.0 { 50 } else { 400 };
        if let Some(behind) = world.car_behind_on_edge(current_edge, car_id) {
            events.wake(delay, behind);
        }
        // Cross-edge: front car on previous edge
        if ri >= 2 {
            let prev_edge: EdgeKey = (trip.route[ri - 2], trip.route[ri - 1]);
            if let Some(prev_seg) = world.edges.get(&prev_edge)
                && let Some(&front_id) = prev_seg.cars.front()
                && front_id != car_id
            {
                events.wake(delay, front_id);
            }
        }
    }

    // Update spatial position when car crosses a node
    if ri != old_ri {
        if let Some(node_pos) = world.objects.get(trip.route[ri - 1]).and_then(|e| e.position) {
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
        && let Some(ref mut t) = c.trip
    {
        t.progress = cur_progress;
        t.speed = cur_speed;
        t.updated_at = now;
        t.route_index = ri;
        let seg_len = trip.segment_lengths[ri];
        t.seg_fraction = if seg_len > 1e-9 {
            (cur_progress - seg_start) / seg_len
        } else {
            0.0
        };
        t.seg_length = seg_len;
        t.seg_start_dist = seg_start;
        if accel_changed {
            t.acceleration = new_accel;
        }
    }
}
