use std::collections::HashMap;
use tokio::sync::mpsc;
use tokio::time::{Instant, interval, Duration};
use rand::Rng;

use crate::car_physics::{self, CRUISE_SPEED, ACCELERATION, DECELERATION};
use crate::event_queue::{EventQueue, GameTime};
use crate::pathfinding;
use crate::protocol::{BuildingType, Car, ClientMessage, EntityId, GameObject, Operation, ServerMessage, StateUpdate};
use crate::world::World;

pub type ClientId = u64;

const SPAWN_INTERVAL_MIN: u64 = 5_000; // ms
const SPAWN_INTERVAL_MAX: u64 = 15_000; // ms

pub enum Command {
    PlayerAction { client_id: ClientId, message: ClientMessage },
    ClientConnect { id: ClientId, sender: mpsc::UnboundedSender<ServerMessage> },
    ClientDisconnect { id: ClientId },
}

pub enum GameEvent {
    CarSpawn { building_id: EntityId },
    CarWakeUp { car_id: EntityId, plan_gen: u32 },
    IntersectionEvaluate { intersection_node: EntityId },
}

pub async fn run(mut commands: mpsc::UnboundedReceiver<Command>) {
    let mut world = World::new();
    let mut events: EventQueue<GameEvent> = EventQueue::new();
    let mut clients: HashMap<ClientId, mpsc::UnboundedSender<ServerMessage>> = HashMap::new();

    let mut tick_interval = interval(Duration::from_millis(10));
    let start = Instant::now();

    loop {
        tick_interval.tick().await;
        let now: GameTime = start.elapsed().as_millis() as u64;

        while let Ok(cmd) = commands.try_recv() {
            match cmd {
                Command::PlayerAction { client_id, message } => {
                    if let ClientMessage::Ping = &message {
                        if let Some(sender) = clients.get(&client_id) {
                            let _ = sender.send(ServerMessage::Pong(now));
                        }
                    }
                    handle_player_action(&mut world, &mut events, now, message);
                }
                Command::ClientConnect { id, sender } => {
                    let ops: Vec<Operation> = world.objects.all_entries()
                        .into_iter()
                        .map(Operation::Upsert)
                        .collect();
                    if !ops.is_empty() {
                        let _ = sender.send(ServerMessage::Update(StateUpdate { ops, server_time: now }));
                    }
                    clients.insert(id, sender);
                }
                Command::ClientDisconnect { id } => {
                    clients.remove(&id);
                }
            }
        }

        while let Some(scheduled) = events.pop_due(now) {
            handle_game_event(&mut world, &mut events, scheduled.event, scheduled.time);
        }

        flush_dirty(&mut world, &clients, now);
    }
}

fn schedule_car_spawn(events: &mut EventQueue<GameEvent>, building_id: EntityId, now: GameTime) {
    let delay = rand::rng().random_range(SPAWN_INTERVAL_MIN..=SPAWN_INTERVAL_MAX);
    events.schedule(now + delay, GameEvent::CarSpawn { building_id });
}

fn handle_player_action(
    world: &mut World,
    events: &mut EventQueue<GameEvent>,
    now: GameTime,
    message: ClientMessage,
) {
    match message {
        ClientMessage::PlaceRoad(place) => {
            world.handle_place_road(place.from, place.to, place.one_way);
        }
        ClientMessage::PlaceBuilding(place) => {
            if let Some(building_id) = world.handle_place_building(place.pos, place.building_type) {
                if place.building_type == BuildingType::CarSpawner {
                    schedule_car_spawn(events, building_id, now);
                }
            }
        }
        ClientMessage::DemolishRoad(demolish) => {
            if let Some(node_id) = world.road_node_at(demolish.pos) {
                let car_ids = world.cars_on_node(node_id);
                for car_id in car_ids {
                    if let Some(int_node) = world.despawn_car(car_id) {
                        events.schedule(now, GameEvent::IntersectionEvaluate { intersection_node: int_node });
                    }
                }
            }
            world.handle_demolish_road(demolish.pos);
        }
        ClientMessage::ResetWorld => {
            world.reset();
            events.clear();
        }
        ClientMessage::Ping => {}
    }
}

fn handle_game_event(
    world: &mut World,
    events: &mut EventQueue<GameEvent>,
    event: GameEvent,
    now: GameTime,
) {
    match event {
        GameEvent::CarSpawn { building_id } => {
            handle_car_spawn(world, events, building_id, now);
        }
        GameEvent::CarWakeUp { car_id, plan_gen } => {
            handle_car_wake_up(world, events, car_id, plan_gen, now);
        }
        GameEvent::IntersectionEvaluate { intersection_node } => {
            handle_intersection_evaluate(world, events, intersection_node, now);
        }
    }
}

fn check_plan_gen(world: &World, car_id: EntityId, plan_gen: u32) -> Option<()> {
    let entry = world.objects.get(car_id)?;
    if let GameObject::Car(ref car) = entry.object {
        if car.plan_gen == plan_gen {
            return Some(());
        }
    }
    None
}

/// Precompute target speeds for every node in the route using a backward pass.
/// Each node's target is capped by what's achievable given the next node's target
/// and the straight distance available for braking.
/// Interior intersection nodes get target speed = 0 (car must stop) unless `granted_intersection`
/// matches that node (the car has been granted passage).
fn compute_target_speeds(
    world: &World,
    route: &[EntityId],
    intersection_stops: &[usize],
    granted_intersection: Option<EntityId>,
) -> Vec<f64> {
    let n = route.len();
    let mut targets = vec![0.0; n];

    // Last node: stop
    // Second-to-last and earlier: backward pass
    for i in (0..n - 1).rev() {
        // Check if this node is an intersection stop that hasn't been granted
        let is_blocked_intersection = intersection_stops.contains(&i)
            && granted_intersection != Some(route[i]);

        let turn_speed = if is_blocked_intersection {
            0.0
        } else if i == 0 {
            CRUISE_SPEED // no turn at start
        } else {
            let cos_angle = world.turn_cos_angle(route, i);
            car_physics::max_speed_at_node(cos_angle)
        };

        // Straight distance in the next segment (from node i to node i+1)
        let geo = world.segment_geometry(route, i + 1);
        let straight = geo.straight;

        // Max speed at node i such that we can brake to targets[i+1] within straight
        let max_reachable = (targets[i + 1] * targets[i + 1] + 2.0 * DECELERATION * straight).sqrt();

        targets[i] = turn_speed.min(max_reachable);
    }

    targets
}

/// Precompute which route indices (interior only, excluding first/last) are intersections.
fn compute_intersection_stops(world: &World, route: &[EntityId]) -> Vec<usize> {
    let mut stops = Vec::new();
    for i in 1..route.len().saturating_sub(1) {
        if world.is_intersection(route[i]) {
            stops.push(i);
        }
    }
    stops
}

/// Compute total route length (sum of all segment arc lengths).
fn total_route_length(world: &World, route: &[EntityId]) -> f64 {
    let mut total = 0.0;
    for i in 1..route.len() {
        total += world.spline_segment_length(route, i);
    }
    total
}

fn handle_car_spawn(
    world: &mut World,
    events: &mut EventQueue<GameEvent>,
    building_id: EntityId,
    now: GameTime,
) {
    if world.objects.get(building_id).is_none() {
        return;
    }

    schedule_car_spawn(events, building_id, now);

    let from_node = match world.road_node_for_building(building_id) {
        Some(id) => id,
        None => return,
    };

    let spawners = world.all_car_spawners();
    let destinations: Vec<&(EntityId, _)> = spawners.iter()
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
        _ => return,
    };

    let total_len = total_route_length(world, &route);
    let intersection_stops = compute_intersection_stops(world, &route);
    let target_speeds = compute_target_speeds(world, &route, &intersection_stops, None);
    let geo = world.segment_geometry(&route, 1);
    let target = target_speeds[1];
    let plan_gen = 0u32;

    let car_id = world.objects.insert(
        GameObject::Car(Car {
            route,
            progress: 0.0,
            speed: 0.0,
            acceleration: ACCELERATION,
            total_route_length: total_len,
            updated_at: now,
            plan_gen,
            route_index: 1,
            seg_start_dist: 0.0,
            seg_length: geo.total(),
            seg_corner_start: geo.straight,
            target_speeds,
            waiting_at_intersection: None,
            intersection_stops,
        }),
        None,
    );

    let wake_ms = next_wake_time(0.0, ACCELERATION, 0.0, geo.straight, target);
    events.schedule(now + wake_ms, GameEvent::CarWakeUp { car_id, plan_gen });
}

fn handle_car_wake_up(
    world: &mut World,
    events: &mut EventQueue<GameEvent>,
    car_id: EntityId,
    plan_gen: u32,
    now: GameTime,
) {
    if check_plan_gen(world, car_id, plan_gen).is_none() {
        return;
    }

    let (route, target_speeds, progress, speed, accel, updated_at, route_index,
         seg_start_dist, seg_length, seg_corner_start, intersection_stops, waiting_at) =
        match world.objects.get(car_id) {
            Some(entry) => {
                if let GameObject::Car(ref car) = entry.object {
                    (car.route.clone(), car.target_speeds.clone(),
                     car.progress, car.speed, car.acceleration,
                     car.updated_at, car.route_index, car.seg_start_dist,
                     car.seg_length, car.seg_corner_start,
                     car.intersection_stops.clone(), car.waiting_at_intersection)
                } else {
                    return;
                }
            }
            None => return,
        };

    // If already waiting at an intersection, don't schedule further wake-ups.
    // The intersection evaluate event will restart this car.
    if waiting_at.is_some() {
        return;
    }

    // Advance kinematics to now
    let dt = (now - updated_at) as f64 / 1000.0;
    let (cur_progress, cur_speed) = car_physics::update_kinematics(progress, speed, accel, dt);

    // Check for segment transitions
    let mut ri = route_index;
    let mut seg_start = seg_start_dist;
    let mut seg_len = seg_length;
    let mut corner_start = seg_corner_start;
    let mut passed_intersection: Option<EntityId> = None;

    loop {
        let seg_progress = cur_progress - seg_start;
        if seg_progress < seg_len {
            break;
        }
        let next_ri = ri + 1;
        if next_ri >= route.len() {
            // Car reached end of route — check if we passed through an intersection
            if let Some(int_node) = passed_intersection {
                world.intersections.clear_active(int_node);
                events.schedule(now, GameEvent::IntersectionEvaluate { intersection_node: int_node });
            }
            world.despawn_car(car_id);
            return;
        }
        // If the node we just passed (route[ri]) is an intersection, record it for clearing
        if intersection_stops.contains(&ri) {
            passed_intersection = Some(route[ri]);
        }
        seg_start += seg_len;
        ri = next_ri;
        let geo = world.segment_geometry(&route, ri);
        seg_len = geo.total();
        corner_start = geo.straight;
    }

    // If we passed through an intersection node during segment transition, clear active
    if let Some(int_node) = passed_intersection {
        world.intersections.clear_active(int_node);
        events.schedule(now, GameEvent::IntersectionEvaluate { intersection_node: int_node });
    }

    // Check if car has stopped at an intersection
    let at_intersection_stop = cur_speed < 0.01
        && intersection_stops.contains(&ri)
        && !world.intersections.managers.get(&route[ri])
            .map_or(false, |m| m.active_car == Some(car_id));

    if at_intersection_stop {
        let int_node_id = route[ri];
        // Compute approach direction from previous node
        let from_node = route[ri - 1];
        let approach_dir = compute_approach_dir(world, from_node, int_node_id);

        world.intersections.register_car(int_node_id, car_id, from_node, approach_dir, now);

        // Mark car as waiting
        if let Some(entry) = world.objects.get_mut(car_id) {
            if let GameObject::Car(ref mut car) = entry.object {
                car.progress = cur_progress;
                car.speed = 0.0;
                car.acceleration = 0.0;
                car.updated_at = now;
                car.route_index = ri;
                car.seg_start_dist = seg_start;
                car.seg_length = seg_len;
                car.seg_corner_start = corner_start;
                car.waiting_at_intersection = Some(int_node_id);
            }
        }

        events.schedule(now, GameEvent::IntersectionEvaluate { intersection_node: int_node_id });
        // Do NOT schedule another CarWakeUp — the intersection evaluate will restart this car
        return;
    }

    let seg_progress = cur_progress - seg_start;
    let target = target_speeds[ri];
    let in_corner = seg_progress >= corner_start;

    let new_accel = if in_corner {
        // In the bezier corner — coast at turn speed
        0.0
    } else {
        // In the straight part — brake/accel relative to corner start
        let remaining_to_corner = corner_start - seg_progress;
        decide_accel(cur_speed, remaining_to_corner, target)
    };

    let accel_changed = (new_accel - accel).abs() > 1e-6;
    let seg_changed = ri != route_index;

    if accel_changed || seg_changed {
        if let Some(entry) = world.objects.get_mut(car_id) {
            if let GameObject::Car(ref mut car) = entry.object {
                car.progress = cur_progress;
                car.speed = cur_speed;
                car.acceleration = new_accel;
                car.updated_at = now;
                car.route_index = ri;
                car.seg_start_dist = seg_start;
                car.seg_length = seg_len;
                car.seg_corner_start = corner_start;
            }
        }
    } else {
        if let Some(entry) = world.objects.get_mut_silent(car_id) {
            if let GameObject::Car(ref mut car) = entry.object {
                car.progress = cur_progress;
                car.speed = cur_speed;
                car.updated_at = now;
                car.route_index = ri;
                car.seg_start_dist = seg_start;
                car.seg_length = seg_len;
                car.seg_corner_start = corner_start;
            }
        }
    }

    let wake_ms = if in_corner {
        // Wake up when exiting the corner (= segment end)
        let remaining = seg_len - seg_progress;
        ((remaining / cur_speed.max(0.1)) * 1000.0) as u64
    } else {
        next_wake_time(cur_speed, new_accel, seg_progress, corner_start, target)
    };
    events.schedule(now + wake_ms.max(1), GameEvent::CarWakeUp { car_id, plan_gen });
}

/// Compute normalized approach direction from `from_node` into `to_node`.
fn compute_approach_dir(world: &World, from_node: EntityId, to_node: EntityId) -> (f64, f64) {
    let from_pos = world.objects.get(from_node).and_then(|e| e.position);
    let to_pos = world.objects.get(to_node).and_then(|e| e.position);
    match (from_pos, to_pos) {
        (Some(f), Some(t)) => {
            let dx = (t.x - f.x) as f64;
            let dy = (t.y - f.y) as f64;
            let len = (dx * dx + dy * dy).sqrt();
            if len < 1e-9 {
                (0.0, 0.0)
            } else {
                (dx / len, dy / len)
            }
        }
        _ => (0.0, 0.0),
    }
}

/// Evaluate an intersection and grant passage to the winning car.
fn handle_intersection_evaluate(
    world: &mut World,
    events: &mut EventQueue<GameEvent>,
    intersection_node: EntityId,
    now: GameTime,
) {
    let winner = match world.intersections.managers.get(&intersection_node) {
        Some(mgr) => mgr.evaluate(),
        None => return, // manager removed (road demolished), no-op
    };

    let car_id = match winner {
        Some(id) => id,
        None => return, // no waiting cars or already active
    };

    // Set as active, remove from approaching
    if let Some(mgr) = world.intersections.managers.get_mut(&intersection_node) {
        mgr.active_car = Some(car_id);
        mgr.approaching.remove(&car_id);
    }

    // Restore the car: recompute target speeds with this intersection granted,
    // set acceleration, clear waiting state, bump plan_gen, schedule wake-up
    let new_plan_gen = if let Some(entry) = world.objects.get(car_id) {
        if let GameObject::Car(ref car) = entry.object {
            car.plan_gen + 1
        } else {
            return;
        }
    } else {
        return;
    };

    // Read car state for recomputing targets
    let (route, intersection_stops, _ri) = match world.objects.get(car_id) {
        Some(entry) => {
            if let GameObject::Car(ref car) = entry.object {
                (car.route.clone(), car.intersection_stops.clone(), car.route_index)
            } else {
                return;
            }
        }
        None => return,
    };

    let new_targets = compute_target_speeds(world, &route, &intersection_stops, Some(intersection_node));

    if let Some(entry) = world.objects.get_mut(car_id) {
        if let GameObject::Car(ref mut car) = entry.object {
            car.target_speeds = new_targets;
            car.acceleration = ACCELERATION;
            car.waiting_at_intersection = None;
            car.plan_gen = new_plan_gen;
            car.updated_at = now;
        }
    }

    // Schedule wake-up with the new plan_gen
    events.schedule(now + 1, GameEvent::CarWakeUp { car_id, plan_gen: new_plan_gen });
}

/// Decide acceleration in the straight part of a segment.
/// `remaining` is the distance to the corner start (not segment end).
fn decide_accel(speed: f64, remaining: f64, target_speed: f64) -> f64 {
    let brake_dist = car_physics::braking_distance(speed, target_speed);

    if remaining <= brake_dist + 1e-6 {
        -DECELERATION
    } else {
        // Don't accelerate past the speed from which we can brake to target in remaining distance.
        // v_max = sqrt(target² + 2 * decel * remaining)
        let max_speed = (target_speed * target_speed + 2.0 * DECELERATION * remaining).sqrt();
        let desired_cruise = CRUISE_SPEED.min(max_speed);
        if speed < desired_cruise - 1e-6 {
            ACCELERATION
        } else {
            0.0
        }
    }
}

/// How long until the next wake-up in the straight part.
/// `straight_len` is the distance from segment start to corner start.
fn next_wake_time(speed: f64, accel: f64, seg_progress: f64, straight_len: f64, target_speed: f64) -> u64 {
    let remaining = straight_len - seg_progress;

    let t = if accel > 0.0 {
        let max_speed = (target_speed * target_speed + 2.0 * DECELERATION * remaining).sqrt();
        let desired_cruise = CRUISE_SPEED.min(max_speed);
        let time_to_cruise = (desired_cruise - speed).max(0.0) / accel;
        let time_to_brake = time_to_brake_while_accelerating(speed, remaining, target_speed);
        time_to_cruise.min(time_to_brake)
    } else if accel < 0.0 {
        // Braking — wake up when reaching corner start
        if speed > target_speed && -accel > 1e-9 {
            (speed - target_speed) / (-accel)
        } else {
            remaining / speed.max(0.1)
        }
    } else {
        // Coasting — wake up when braking is needed
        let brake_dist = car_physics::braking_distance(speed, target_speed);
        let coast_dist = (remaining - brake_dist).max(0.0);
        if speed > 1e-9 { coast_dist / speed } else { 1.0 }
    };

    ((t * 1000.0) as u64).max(1)
}

fn time_to_brake_while_accelerating(speed: f64, remaining: f64, target_speed: f64) -> f64 {
    let a = ACCELERATION;
    let d = DECELERATION;
    let qa = a * (a + d);
    let qb = 2.0 * speed * (a + d);
    let qc = speed * speed - target_speed * target_speed - 2.0 * d * remaining;
    let discriminant = qb * qb - 4.0 * qa * qc;
    if discriminant < 0.0 {
        return 0.0;
    }
    let t = (-qb + discriminant.sqrt()) / (2.0 * qa);
    t.max(0.0)
}

fn flush_dirty(
    world: &mut World,
    clients: &HashMap<ClientId, mpsc::UnboundedSender<ServerMessage>>,
    now: GameTime,
) {
    let (changed, removed) = world.objects.drain_dirty();

    let mut ops = Vec::new();
    for id in &changed {
        if let Some(entry) = world.objects.get(*id) {
            ops.push(Operation::Upsert(entry.clone()));
        }
    }
    for id in removed {
        ops.push(Operation::Delete(id));
    }

    if !ops.is_empty() {
        let msg = ServerMessage::Update(StateUpdate { ops, server_time: now });
        broadcast(clients, &msg);
    }
}

fn broadcast(
    clients: &HashMap<ClientId, mpsc::UnboundedSender<ServerMessage>>,
    msg: &ServerMessage,
) {
    for sender in clients.values() {
        let _ = sender.send(msg.clone());
    }
}
