use std::collections::HashMap;
use tokio::sync::mpsc;
use tokio::time::{Instant, interval, Duration};
use rand::Rng;

use crate::car_physics::{self, CRUISE_SPEED, ACCELERATION, DECELERATION, SAFE_FOLLOWING_GAP};
use crate::event_queue::{EventQueue, GameTime};
use crate::pathfinding;
use crate::protocol::{BuildingType, Car, ClientMessage, EntityId, GameObject, Operation, ServerMessage, StateUpdate};
use crate::world::World;

pub type ClientId = u64;

const SPAWN_INTERVAL_MIN: u64 = 2_000; // ms
const SPAWN_INTERVAL_MAX: u64 = 5_000; // ms

/// Safety-net wake cap when following a leader (ms).
const LEADER_WAKE_CAP_MS: u64 = 50;

pub enum Command {
    PlayerAction { client_id: ClientId, message: ClientMessage },
    ClientConnect { id: ClientId, sender: mpsc::UnboundedSender<ServerMessage> },
    ClientDisconnect { id: ClientId },
}

pub enum GameEvent {
    CarSpawn { building_id: EntityId },
    CarWakeUp { car_id: EntityId, plan_gen: u32 },
    IntersectionClear { node_id: EntityId },
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
                    handle_player_action(&mut world, &mut events, message, now);
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

        events.set_now(now);
        while let Some(scheduled) = events.pop_due() {
            handle_game_event(&mut world, &mut events, scheduled.event, now);
        }

        flush_dirty(&mut world, &clients, now);
    }
}

fn schedule_car_spawn(events: &mut EventQueue<GameEvent>, building_id: EntityId) {
    let delay = rand::rng().random_range(SPAWN_INTERVAL_MIN..=SPAWN_INTERVAL_MAX);
    events.schedule(delay, GameEvent::CarSpawn { building_id });
}

// --- Segment tracker helpers ---

/// Find the car directly ahead of `car_id` on the given segment by actual progress.
/// Returns the car with the smallest progress that is still greater than ours.
fn find_car_ahead(world: &World, from: EntityId, to: EntityId, car_id: EntityId) -> Option<EntityId> {
    let cars = world.segment_tracker.cars_on(from, to);
    // Get our progress
    let my_progress = match world.objects.get(car_id) {
        Some(entry) => {
            if let GameObject::Car(ref car) = entry.object {
                car.progress - car.seg_start_dist
            } else {
                return None;
            }
        }
        None => return None,
    };

    let mut best: Option<(EntityId, f64)> = None;
    for &other_id in cars {
        if other_id == car_id {
            continue;
        }
        if let Some(entry) = world.objects.get(other_id) {
            if let GameObject::Car(ref other_car) = entry.object {
                let other_progress = other_car.progress - other_car.seg_start_dist;
                if other_progress > my_progress {
                    if best.is_none() || other_progress < best.unwrap().1 {
                        best = Some((other_id, other_progress));
                    }
                }
            }
        }
    }
    best.map(|(id, _)| id)
}

/// Find the car directly behind `car_id` on the given segment by actual progress.
fn find_car_behind(world: &World, from: EntityId, to: EntityId, car_id: EntityId) -> Option<EntityId> {
    let cars = world.segment_tracker.cars_on(from, to);
    let my_progress = match world.objects.get(car_id) {
        Some(entry) => {
            if let GameObject::Car(ref car) = entry.object {
                car.progress - car.seg_start_dist
            } else {
                return None;
            }
        }
        None => return None,
    };

    let mut best: Option<(EntityId, f64)> = None;
    for &other_id in cars {
        if other_id == car_id {
            continue;
        }
        if let Some(entry) = world.objects.get(other_id) {
            if let GameObject::Car(ref other_car) = entry.object {
                let other_progress = other_car.progress - other_car.seg_start_dist;
                if other_progress < my_progress {
                    if best.is_none() || other_progress > best.unwrap().1 {
                        best = Some((other_id, other_progress));
                    }
                }
            }
        }
    }
    best.map(|(id, _)| id)
}

// --- Subscribe / unsubscribe helpers ---

fn subscribe(world: &mut World, car_id: EntityId, leader_id: EntityId) {
    if let Some(entry) = world.objects.get_mut_silent(car_id) {
        if let GameObject::Car(ref mut car) = entry.object {
            car.leader = Some(leader_id);
        }
    }
    if let Some(entry) = world.objects.get_mut_silent(leader_id) {
        if let GameObject::Car(ref mut car) = entry.object {
            car.follower = Some(car_id);
        }
    }
}

fn unsubscribe(world: &mut World, car_id: EntityId) {
    let leader_id = match world.objects.get(car_id) {
        Some(entry) => {
            if let GameObject::Car(ref car) = entry.object {
                car.leader
            } else {
                None
            }
        }
        None => None,
    };
    if let Some(lid) = leader_id {
        if let Some(entry) = world.objects.get_mut_silent(lid) {
            if let GameObject::Car(ref mut car) = entry.object {
                if car.follower == Some(car_id) {
                    car.follower = None;
                }
            }
        }
    }
    if let Some(entry) = world.objects.get_mut_silent(car_id) {
        if let GameObject::Car(ref mut car) = entry.object {
            car.leader = None;
        }
    }
}

/// Bump plan_gen and schedule a wake-up with 1ms delay.
fn wake_car(world: &mut World, events: &mut EventQueue<GameEvent>, car_id: EntityId, now: GameTime) {
    let new_plan_gen = match world.objects.get(car_id) {
        Some(entry) => {
            if let GameObject::Car(ref car) = entry.object {
                let dt = (now - car.updated_at) as f64 / 1000.0;
                let (p, s) = car_physics::update_kinematics(car.progress, car.speed, car.acceleration, dt);
                Some((p, s, car.plan_gen + 1))
            } else {
                None
            }
        }
        None => None,
    };
    if let Some((progress, speed, pg)) = new_plan_gen {
        if let Some(entry) = world.objects.get_mut(car_id) {
            if let GameObject::Car(ref mut car) = entry.object {
                car.progress = progress;
                car.speed = speed;
                car.plan_gen = pg;
                car.updated_at = now;
            }
        }
        events.schedule(1, GameEvent::CarWakeUp { car_id, plan_gen: pg });
    }
}

fn handle_player_action(
    world: &mut World,
    events: &mut EventQueue<GameEvent>,
    message: ClientMessage,
    now: GameTime,
) {
    match message {
        ClientMessage::PlaceRoad(place) => {
            world.handle_place_road(place.from, place.to, place.one_way);
        }
        ClientMessage::PlaceBuilding(place) => {
            if let Some(building_id) = world.handle_place_building(place.pos, place.building_type) {
                if place.building_type == BuildingType::CarSpawner {
                    schedule_car_spawn(events, building_id);
                }
            }
        }
        ClientMessage::DemolishRoad(demolish) => {
            if let Some(node_id) = world.road_node_at(demolish.pos) {
                let car_ids = world.cars_on_node(node_id);
                for car_id in car_ids {
                    let follower = world.despawn_car(car_id);
                    if let Some(fid) = follower {
                        // Follower lost its leader — resubscribe to new leader on its segment
                        resubscribe_after_leader_left(world, events, fid, now);
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

/// After a car's leader leaves the segment, find a new leader for it and wake it.
fn resubscribe_after_leader_left(world: &mut World, events: &mut EventQueue<GameEvent>, car_id: EntityId, now: GameTime) {
    let seg = match world.objects.get(car_id) {
        Some(entry) => {
            if let GameObject::Car(ref car) = entry.object {
                let ri = car.route_index;
                Some((car.route[ri - 1], car.route[ri]))
            } else {
                None
            }
        }
        None => None,
    };
    if let Some((from, to)) = seg {
        if let Some(lid) = find_car_ahead(world, from, to, car_id) {
            subscribe(world, car_id, lid);
        }
    }
    wake_car(world, events, car_id, now);
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
        GameEvent::IntersectionClear { node_id } => {
            handle_intersection_clear(world, events, node_id, now);
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

/// Max approach speed at intersection nodes. Low enough to brake to 0 within one segment's
/// straight portion (~0.4 tiles min). sqrt(2 * DECELERATION * 0.4) ≈ 0.89
const INTERSECTION_SPEED: f64 = 0.8;

/// How far before corner_start the car stops at a blocked intersection (tiles).
const INTERSECTION_STOP_MARGIN: f64 = 0.2;

/// Extra margin beyond braking distance at which to register at an upcoming intersection.
/// Gives the queue time to incorporate late arrivals from other directions.
const INTERSECTION_REGISTER_MARGIN: f64 = 1.0;

/// Precompute target speeds for every node in the route using a backward pass.
/// Intersection nodes are capped at INTERSECTION_SPEED so cars naturally slow down.
fn compute_target_speeds(
    world: &World,
    route: &[EntityId],
    intersection_stops: &[usize],
) -> Vec<f64> {
    let n = route.len();
    let mut targets = vec![0.0; n];

    for i in (0..n - 1).rev() {
        let turn_speed = if i == 0 {
            CRUISE_SPEED
        } else {
            let cos_angle = world.turn_cos_angle(route, i);
            let base = car_physics::max_speed_at_node(cos_angle);
            if intersection_stops.contains(&i) {
                base.min(INTERSECTION_SPEED)
            } else {
                base
            }
        };

        let geo = world.segment_geometry(route, i + 1);
        let straight = geo.straight;
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

    schedule_car_spawn(events, building_id);

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
    let target_speeds = compute_target_speeds(world, &route, &intersection_stops);
    let geo = world.segment_geometry(&route, 1);
    let target = target_speeds[1];
    let plan_gen = 0u32;

    let car_id = world.objects.insert(
        GameObject::Car(Car {
            route: route.clone(),
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
            intersection_stops,
            leader: None,
            follower: None,
        }),
        None,
    );

    // Register in segment tracker and subscribe to leader
    world.segment_tracker.insert(route[0], route[1], car_id);
    let leader = find_car_ahead(world, route[0], route[1], car_id);
    eprintln!("[SPAWN] car {} on seg [{},{}], route len={}, leader={:?}",
        car_id, route[0], route[1], route.len(), leader);
    if let Some(leader_id) = leader {
        subscribe(world, car_id, leader_id);
    }

    let wake_ms = next_wake_time(0.0, ACCELERATION, 0.0, geo.straight, target);
    events.schedule(wake_ms, GameEvent::CarWakeUp { car_id, plan_gen });
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
         seg_start_dist, seg_length, seg_corner_start, intersection_stops, _leader_id) =
        match world.objects.get(car_id) {
            Some(entry) => {
                if let GameObject::Car(ref car) = entry.object {
                    (car.route.clone(), car.target_speeds.clone(),
                     car.progress, car.speed, car.acceleration,
                     car.updated_at, car.route_index, car.seg_start_dist,
                     car.seg_length, car.seg_corner_start,
                     car.intersection_stops.clone(), car.leader)
                } else {
                    return;
                }
            }
            None => return,
        };

    // Advance kinematics to now
    let dt = (now - updated_at) as f64 / 1000.0;
    let (mut cur_progress, mut cur_speed) = car_physics::update_kinematics(progress, speed, accel, dt);

    // Segment transitions
    let mut ri = route_index;
    let mut seg_start = seg_start_dist;
    let mut seg_len = seg_length;
    let mut corner_start = seg_corner_start;
    let mut passed_intersections: Vec<EntityId> = Vec::new();
    let mut seg_changed = false;

    loop {
        let seg_progress = cur_progress - seg_start;
        if seg_progress < seg_len {
            break;
        }
        let next_ri = ri + 1;
        if next_ri >= route.len() {
            // Car reached end of route — despawn
            for &int_node in &passed_intersections {
                world.intersections.clear_car(car_id, int_node);
                events.schedule(500, GameEvent::IntersectionClear { node_id: int_node });
            }
            unsubscribe(world, car_id);
            let follower = world.despawn_car(car_id);
            if let Some(fid) = follower {
                resubscribe_after_leader_left(world, events, fid, now);
            }
            return;
        }
        if intersection_stops.contains(&ri) {
            passed_intersections.push(route[ri]);
        }

        // Segment transition: update tracker and subscriptions
        if !seg_changed {
            seg_changed = true;
            let old_from = route[ri - 1];
            let old_to = route[ri];
            unsubscribe(world, car_id);
            // Find car behind us on old segment before we leave
            let behind = find_car_behind(world, old_from, old_to, car_id);
            world.segment_tracker.remove(old_from, old_to, car_id);
            // Car behind us lost its leader — wake it to resubscribe
            if let Some(behind_id) = behind {
                resubscribe_after_leader_left(world, events, behind_id, now);
            }
        }

        seg_start += seg_len;
        ri = next_ri;
        let geo = world.segment_geometry(&route, ri);
        seg_len = geo.total();
        corner_start = geo.straight;
    }

    // If we transitioned segments, enter the new one and subscribe
    if seg_changed {
        let new_from = route[ri - 1];
        let new_to = route[ri];
        world.segment_tracker.insert(new_from, new_to, car_id);
        if let Some(new_leader) = find_car_ahead(world, new_from, new_to, car_id) {
            subscribe(world, car_id, new_leader);
        }
    }

    // Clear any intersections the car passed through
    for &int_node in &passed_intersections {
        eprintln!("[INT] car {} CLEARED intersection node {} (passed through)", car_id, int_node);
        world.intersections.clear_car(car_id, int_node);
        events.schedule(500, GameEvent::IntersectionClear { node_id: int_node });
    }

    // Register at upcoming intersection when within braking distance + margin
    let mut seg_progress = cur_progress - seg_start;
    if let Some(&next_int_idx) = intersection_stops.iter().find(|&&i| i >= ri) {
        let dist = distance_to_intersection(world, &route, ri, seg_progress, seg_len, corner_start, next_int_idx);
        let brake_dist = car_physics::braking_distance(cur_speed, 0.0);
        if dist <= brake_dist + INTERSECTION_REGISTER_MARGIN {
            let int_node = route[next_int_idx];
            let from_node = route[next_int_idx - 1];
            let to_node = route[next_int_idx + 1];
            let approach_dir = compute_approach_dir(world, from_node, int_node);
            let was_new = !world.intersections.managers.get(&int_node)
                .map_or(true, |m| m.contains(car_id));
            world.intersections.register_car(int_node, car_id, from_node, to_node, approach_dir, now);
            if was_new {
                eprintln!("[INT] car {} registered at intersection node {} (dist={:.2}, brake_dist={:.2}, ri={}, int_idx={})",
                    car_id, int_node, dist, brake_dist, ri, next_int_idx);
            }
        }
    }

    // Check intersection status for this segment
    let is_at_intersection = intersection_stops.contains(&ri);
    let must_stop = is_at_intersection
        && world.intersections.should_stop(route[ri], car_id, now, |id| world.objects.get(id).is_some());

    if is_at_intersection {
        let int_node = route[ri];
        if let Some(mgr) = world.intersections.managers.get(&int_node) {
            let active_ids: Vec<_> = mgr.active.iter().map(|c| c.car_id).collect();
            let queue_ids: Vec<_> = mgr.queue.iter().map(|c| c.car_id).collect();
            eprintln!("[INT] car {} at intersection node {}: must_stop={}, active={:?}, queue={:?}, speed={:.3}",
                car_id, int_node, must_stop, active_ids, queue_ids, cur_speed);
        } else {
            eprintln!("[INT] car {} at intersection node {} but NO MANAGER exists! must_stop={}",
                car_id, int_node, must_stop);
        }
    }

    let (mut effective_target, mut effective_corner) = if must_stop {
        (0.0, (corner_start - INTERSECTION_STOP_MARGIN).max(0.0))
    } else {
        // Car can go — move it to the active list so it blocks newcomers
        if is_at_intersection {
            eprintln!("[INT] car {} ACTIVATED at intersection node {}", car_id, route[ri]);
            world.intersections.activate_car(route[ri], car_id);
        }
        (target_speeds[ri], corner_start)
    };

    // --- Leader constraint ---
    // Re-read leader_id since it may have changed during segment transitions
    let current_leader_id = match world.objects.get(car_id) {
        Some(entry) => {
            if let GameObject::Car(ref car) = entry.object {
                car.leader
            } else {
                None
            }
        }
        None => return,
    };

    let has_leader = current_leader_id.is_some();
    let mut stopped_behind_leader = false;

    if let Some(lid) = current_leader_id {
        if let Some(leader_entry) = world.objects.get(lid) {
            if let GameObject::Car(ref leader_car) = leader_entry.object {
                // Only apply constraint if leader is on the same directed segment.
                // Compare actual node IDs, not route_index (which is per-route).
                let leader_ri = leader_car.route_index;
                let same_segment = leader_car.route[leader_ri - 1] == route[ri - 1]
                    && leader_car.route[leader_ri] == route[ri];

                if same_segment {
                    let leader_dt = (now - leader_car.updated_at) as f64 / 1000.0;
                    let (leader_progress, leader_speed) = car_physics::update_kinematics(
                        leader_car.progress, leader_car.speed, leader_car.acceleration, leader_dt,
                    );
                    let leader_seg_progress = leader_progress - leader_car.seg_start_dist;

                    // Hard clamp: never pass the leader
                    let max_allowed_progress = leader_progress - SAFE_FOLLOWING_GAP;
                    if cur_progress > max_allowed_progress {
                        cur_progress = max_allowed_progress.max(seg_start); // don't go before segment start
                        cur_speed = cur_speed.min(leader_speed);
                        seg_progress = cur_progress - seg_start;
                    }

                    let gap = leader_seg_progress - seg_progress - SAFE_FOLLOWING_GAP;

                    eprintln!("[FOLLOW] car {} following leader {} on seg [{},{}]: gap={:.3}, my_prog={:.3}, leader_prog={:.3}, my_spd={:.3}, leader_spd={:.3}",
                        car_id, lid, route[ri-1], route[ri], gap, seg_progress, leader_seg_progress, cur_speed, leader_speed);

                    // Leader acts as a virtual wall
                    let leader_wall_dist = seg_progress + gap.max(0.0);
                    if leader_wall_dist < effective_corner {
                        effective_corner = leader_wall_dist;
                        effective_target = leader_speed;
                    }

                    // Stopped behind stopped leader
                    if cur_speed < 0.01 && leader_speed < 0.01 && gap <= 0.0 {
                        stopped_behind_leader = true;
                    }
                } else {
                    eprintln!("[FOLLOW] car {} has leader {} but DIFFERENT segment (me: [{},{}] leader: [{},{}])",
                        car_id, lid, route[ri-1], route[ri],
                        leader_car.route[leader_ri-1], leader_car.route[leader_ri]);
                }
                // If leader is on a different segment, corner speed logic handles it.
            }
        }
    }

    // Car stopped at intersection — wait for IntersectionClear to wake us
    if cur_speed < 0.01 && must_stop {
        eprintln!("[INT] car {} STOPPED at intersection node {} — waiting for clear", car_id, route[ri]);
        let int_node_id = route[ri];
        let from_node = route[ri - 1];
        let to_node = route[ri + 1];
        let approach_dir = compute_approach_dir(world, from_node, int_node_id);
        world.intersections.register_car(int_node_id, car_id, from_node, to_node, approach_dir, now);

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
            }
        }
        // Don't schedule another wake — IntersectionClear will wake us
        return;
    }

    // Stopped behind stopped leader — schedule a safety-net wake.
    // The leader should wake us on accel change, but that single wake may
    // arrive too early (leader barely moving), so we poll as a fallback.
    if stopped_behind_leader {
        eprintln!("[FOLLOW] car {} STOPPED behind leader — safety-net wake in {}ms", car_id, LEADER_WAKE_CAP_MS);
        if let Some(entry) = world.objects.get_mut_silent(car_id) {
            if let GameObject::Car(ref mut car) = entry.object {
                car.progress = cur_progress;
                car.speed = 0.0;
                car.acceleration = 0.0;
                car.updated_at = now;
                car.route_index = ri;
                car.seg_start_dist = seg_start;
                car.seg_length = seg_len;
                car.seg_corner_start = corner_start;
            }
        }
        events.schedule(LEADER_WAKE_CAP_MS, GameEvent::CarWakeUp { car_id, plan_gen });
        return;
    }

    // Compute acceleration
    let in_corner = seg_progress >= effective_corner;

    let new_accel = if in_corner {
        if cur_speed < effective_target - 0.01 {
            ACCELERATION
        } else if cur_speed > effective_target + 0.01 {
            -DECELERATION
        } else {
            0.0
        }
    } else {
        let remaining = effective_corner - seg_progress;
        decide_accel(cur_speed, remaining, effective_target)
    };

    let accel_changed = (new_accel - accel).abs() > 1e-6;

    // Wake follower on acceleration change
    if accel_changed {
        let follower_id = match world.objects.get(car_id) {
            Some(entry) => {
                if let GameObject::Car(ref car) = entry.object {
                    car.follower
                } else {
                    None
                }
            }
            None => None,
        };
        if let Some(fid) = follower_id {
            wake_car(world, events, fid, now);
        }
    }

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
        if new_accel > 0.0 {
            let time_to_target = (effective_target - cur_speed).max(0.0) / new_accel;
            ((time_to_target * 1000.0) as u64).max(1)
        } else if new_accel < 0.0 {
            let time_to_target = (cur_speed - effective_target).max(0.0) / (-new_accel);
            ((time_to_target * 1000.0) as u64).max(1)
        } else {
            let remaining = seg_len - seg_progress;
            ((remaining / cur_speed.max(0.1)) * 1000.0) as u64
        }
    } else {
        next_wake_time(cur_speed, new_accel, seg_progress, effective_corner, effective_target)
    };

    // Cap wake time when following a leader
    let wake_ms = if has_leader {
        wake_ms.min(LEADER_WAKE_CAP_MS)
    } else {
        wake_ms
    };

    events.schedule(wake_ms.max(1), GameEvent::CarWakeUp { car_id, plan_gen });
}

/// Distance from current position to the stop point at an upcoming intersection.
fn distance_to_intersection(
    world: &World,
    route: &[EntityId],
    cur_ri: usize,
    cur_seg_progress: f64,
    cur_seg_len: f64,
    cur_corner_start: f64,
    int_idx: usize,
) -> f64 {
    if int_idx == cur_ri {
        // Already on the approach segment
        (cur_corner_start - INTERSECTION_STOP_MARGIN - cur_seg_progress).max(0.0)
    } else {
        // Remaining distance in current segment
        let mut dist = cur_seg_len - cur_seg_progress;
        // Full intermediate segments
        for seg_i in (cur_ri + 1)..int_idx {
            dist += world.spline_segment_length(route, seg_i);
        }
        // Distance into the approach segment to the stop point
        let approach_geo = world.segment_geometry(route, int_idx);
        dist += (approach_geo.straight - INTERSECTION_STOP_MARGIN).max(0.0);
        dist
    }
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

/// When a car clears an intersection, wake up any waiting cars that can now go.
fn handle_intersection_clear(
    world: &mut World,
    events: &mut EventQueue<GameEvent>,
    node_id: EntityId,
    now: GameTime,
) {
    let (to_wake, active_ids, queue_ids) = match world.intersections.managers.get(&node_id) {
        Some(mgr) => {
            let wake = mgr.cars_that_can_go(now, |id| world.objects.get(id).is_some());
            let active: Vec<_> = mgr.active.iter().map(|c| c.car_id).collect();
            let queue: Vec<_> = mgr.queue.iter().map(|c| c.car_id).collect();
            (wake, active, queue)
        }
        None => return,
    };

    if !to_wake.is_empty() || !active_ids.is_empty() || !queue_ids.is_empty() {
        eprintln!("[INT] IntersectionClear node {}: active={:?}, queue={:?}, waking={:?}",
            node_id, active_ids, queue_ids, to_wake);
    }

    for car_id in to_wake {
        wake_car(world, events, car_id, now);
    }
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
