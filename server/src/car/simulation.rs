use crate::car::physics;
use crate::car::{
    nose, tail, ACCELERATION, CRUISE_SPEED, CUSP_MS, INTERSECTION_STOP_MARGIN, LOT_SPEED, MIN_GAP, Obstacle,
    REVERSE_SPEED,
};
use crate::engine::GameTime;
use crate::engine::event_queue::EventQueue;
use crate::intersection::IntersectionRegistry;
use crate::protocol::{Shift, CarRole, EdgeKey, EntityId, GameObject, Trip};
use crate::world::{World, chunk_of};

/// End a car's trip and leave it parked at a building: road bookkeeping
/// cleaned up, trip gone, position at the building it now sits by.
///
/// If the driver is still aboard they step out here and think again — which
/// on arrival is the plan, and on an interrupted trip is the recovery.
///
/// A car whose building is gone parks at home instead, where its driver
/// would think themselves anyway; one whose owner is gone — a household
/// moved out, a facility demolished — is scrap.
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
        crate::resident::drove(world, car_id, driven);
        world.unregister_car_route(car_id, &route);
        if route_index >= 1 {
            let edge = (route[route_index - 1], route[route_index]);
            for behind in world.car_behind_on_edge(edge, car_id) {
                events.wake(0, behind);
            }
        }
    }
    let woken = intersections.remove_car_from_all(car_id, events.now());
    for (_node_id, woken_id) in woken {
        events.wake(0, woken_id);
    }
    events.clear_dedup(car_id);
    let_go(world, events, car_id);
    world.remove_car_from_edges(car_id);

    // Its building gone, it goes home: its owner's, or a fleet's own yard.
    // Nobody's any more, it is scrap.
    let owner = owner.filter(|&o| world.owns(o, car_id));
    let at_building = match (world.objects.get(at_building), owner.and_then(|o| world.objects.get(o)).map(|e| &e.object)) {
        (Some(_), _) => at_building,
        (None, Some(GameObject::Resident(r))) => r.home,
        (None, _) => owner.unwrap_or(at_building),
    };
    match world.objects.get(at_building).and_then(|e| e.position).filter(|_| owner.is_some()) {
        Some(tile) => {
            world.update_position(car_id, tile);
            if let Some(entry) = world.objects.get_mut(car_id)
                && let GameObject::Car(ref mut c) = entry.object
            {
                c.trip = None;
            }
            world.park_in_lot(at_building, car_id, events.now());
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
            crate::resident::set_at(world, events, owner, at_building, events.now());
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
            let _ = intersections.remove_car_from_all(car_id, events.now());
            world.despawn_car(car_id);
        }
    }
}

/// Leave the stretches crossed since the last wake, segments `old_ri` up to
/// `ri`: off their queues, waking whoever was behind, and out of the node
/// index for the nodes passed. Junctions are not left here: a claim on one
/// lasts until the tail has cleared it, which is a length on, not a node.
fn leave_crossed(
    world: &mut World,
    events: &mut EventQueue,
    car_id: EntityId,
    trip: &Trip,
    old_ri: usize,
    ri: usize,
) {
    for k in old_ri..ri {
        let old_edge: EdgeKey = (trip.route[k - 1], trip.route[k]);
        let car_behind = world.car_behind_on_edge(old_edge, car_id);
        if let Some(seg) = world.edges.get_mut(&old_edge) {
            seg.remove(car_id);
        }
        for behind in car_behind {
            events.wake(0, behind);
        }
        if let Some(set) = world.node_cars.get_mut(&trip.route[k - 1]) {
            set.remove(&car_id);
        }
    }
}

/// Stand in the queue of every edge from route[from - 1] to the end of the
/// run. Standing in all of its queues at once is what lets the car behind
/// see this one wherever on the run it has got to. Queued for the one tile it
/// was on, it was out of sight for the rest of the run.
///
/// A queue is in the order the cars stand in: whoever joins a run from a
/// junction is behind everyone on it, but a car pulling out of a lot halfway
/// along is ahead of whoever is still coming. Out of a lot, the street is
/// joined only once the car has its gap (`gap_at`): until then it is not
/// on it.
fn join_run(world: &mut World, car_id: EntityId, trip: &Trip, from: usize, at: f64, now: GameTime, street: bool) {
    for k in from..trip.route.len() {
        if !street && trip.from_lot > 0 && k - 1 == trip.from_lot {
            break;
        }
        let edge = (trip.route[k - 1], trip.route[k]);
        if world.edges.get(&edge).is_some_and(|seg| !seg.contains(car_id)) {
            // Only a car out of a lot joins partway along; from a junction,
            // everyone on the run is ahead. It joins at the street node,
            // wherever along its way out it is: the way from a door is a
            // tile long, and measured along it the car would queue behind
            // one standing at the node, waiting for it.
            let out_of_lot = trip.from_lot > 0 && trip.route_index <= trip.from_lot + 1;
            let at = if out_of_lot { at.max(trip.segment_lengths[1..=trip.from_lot].iter().sum()) } else { at };
            let mine = at - trip.segment_lengths[1..k].iter().sum::<f64>();
            let behind = |o: EntityId| position_on(world, o, edge, now).is_some_and(|p| p < mine);
            // Ahead of whoever is behind it: at a merge, two cars granted
            // the junction together join the road out in the order they
            // stand, and the one behind follows the one ahead.
            let lane = trip.lanes.get(k).copied().unwrap_or(0) as usize;
            let behind: Vec<EntityId> = world.edges[&edge].all().filter(|&o| behind(o)).collect();
            world.edges.get_mut(&edge).unwrap().insert_before(car_id, lane, |o| behind.contains(&o));
        }
        if world.network.is_junction(trip.route[k]) {
            break;
        }
    }
}

/// A car in its lanes' queues ahead, each where it stands on the road: off
/// the queue and back in it behind whoever is ahead of it.
fn requeue(world: &mut World, car_id: EntityId, trip: &Trip, ri: usize, p: f64, now: GameTime) {
    for k in ri..trip.route.len() {
        let e = (trip.route[k - 1], trip.route[k]);
        if !world.edges.get(&e).is_some_and(|s| s.contains(car_id)) {
            break;
        }
        let mine = p - trip.segment_lengths[1..k].iter().sum::<f64>();
        for lane in 0..2 {
            if !world.edges[&e].in_lane(car_id, lane) {
                continue;
            }
            world.edges.get_mut(&e).unwrap().leave_lane(car_id, lane);
            let behind: Vec<EntityId> = world.edges[&e].lane(lane).filter(|&o| position_on(world, o, e, now).is_some_and(|q| q < mine)).collect();
            world.edges.get_mut(&e).unwrap().insert_before(car_id, lane, |o| behind.contains(&o));
        }
    }
}

/// Is this car coming to a junction by another arm than `mine`, not yet
/// through it: a car merging from the side.
fn from_another_arm(world: &World, car_id: EntityId, junction: EntityId, mine: EntityId) -> bool {
    let Some(GameObject::Car(c)) = world.objects.get(car_id).map(|e| &e.object) else { return false };
    let Some(t) = c.trip.as_ref() else { return false };
    let Some(i) = t.route.iter().position(|&n| n == junction) else { return false };
    i > 0 && i >= t.route_index && t.route[i - 1] != mine
}

/// Where a car is on its route, measured from the start of one of its
/// edges: short of it is negative.
fn position_on(world: &World, car_id: EntityId, edge: EdgeKey, now: GameTime) -> Option<f64> {
    let GameObject::Car(ref c) = world.objects.get(car_id)?.object else { return None };
    let t = c.trip.as_ref()?;
    let (p, _) = physics::catch_up(t.progress, t.speed, t.acceleration, (now - t.updated_at) as f64 / 1000.0);
    Some(p - edge_start_dist(t, edge)?)
}

/// The cars on the street at a node: everyone queued on an edge into or
/// out of it. A car queues for the whole run it is on, so that is everyone
/// on the run who could reach the node before a junction; anyone else
/// wakes at that junction and looks ahead from there.
fn on_street(world: &World, node: EntityId) -> Vec<EntityId> {
    let mut cars: Vec<EntityId> = world
        .arms_of(node, false)
        .into_iter()
        .flat_map(|n| [(n, node), (node, n)])
        .filter_map(|e| world.edges.get(&e))
        .flat_map(|seg| seg.all().collect::<Vec<_>>())
        .collect();
    cars.sort_unstable();
    cars.dedup();
    cars
}

/// Wake the cars on the street at these nodes, but this one, each once.
fn wake_round(world: &World, events: &mut EventQueue, nodes: &[EntityId], car_id: EntityId) {
    let mut cars: Vec<EntityId> = nodes.iter().flat_map(|&n| on_street(world, n)).filter(|&o| o != car_id).collect();
    cars.sort_unstable();
    cars.dedup();
    for o in cars {
        events.wake(0, o);
    }
}

/// How far a car setting out has crept before it first looks: it leaves
/// pulling away, and wakes a moment later. Further than this, it is on its
/// way.
const START: f64 = 0.02;

/// How long a driver allows for seeing a car pull out and braking for it.
const REACTION: f64 = 0.5;

/// The gap a car going `vb` keeps behind one going `vf` to be safe: a
/// margin, what it covers while it reacts, and what it takes to slow to
/// it. A car cutting in or merging needs this much behind it.
fn headway(vb: f64, vf: f64) -> f64 {
    MIN_GAP + vb * REACTION + physics::braking_distance(vb, vf)
}

/// Is this car still turning between the street and a lot: pulling out
/// of one and not yet back in its lane (backed out, not until it has
/// pulled away from where it stopped on the street, to the next node), or
/// off the street into one and not yet parked?
fn manoeuvring(world: &World, car_id: EntityId) -> bool {
    matches!(world.objects.get(car_id).map(|e| &e.object), Some(GameObject::Car(c))
        if c.trip.as_ref().is_some_and(|t| {
            let backed_out = t.backing.first().is_some_and(|b| b[0] == 0);
            (t.from_lot > 0 && t.route_index <= t.from_lot + backed_out as usize) || (t.to_lot > 0 && t.route_index > t.route.len() - 1 - t.to_lot)
        }))
}

/// Is someone other than this car turning off or onto the street here?
fn held(world: &World, car_id: EntityId, node: EntityId) -> bool {
    world.manoeuvres.get(&node).is_some_and(|&(o, _)| o != car_id && manoeuvring(world, o))
}

/// The street nodes a car turning between the street and a lot holds, at
/// the start of its trip or the end: where it joins or leaves the street,
/// and for a kerb bay both ends of the stretch it turns across.
fn turn_nodes(trip: &Trip, end: usize) -> Vec<EntityId> {
    let at = if end == 0 { trip.route[trip.from_lot] } else { trip.route[trip.route.len() - 1 - trip.to_lot] };
    let mut nodes = vec![at];
    nodes.extend(trip.stretches[end].iter().filter(|&&n| n != at));
    nodes
}

/// Hold these street nodes while the car turns, and let whoever is coming
/// see it now, not at their next look ahead.
fn hold(world: &mut World, events: &mut EventQueue, car_id: EntityId, nodes: &[EntityId], now: GameTime) {
    for &n in nodes {
        world.manoeuvres.insert(n, (car_id, now));
    }
    wake_round(world, events, nodes, car_id);
}

/// Let go of everything the car holds, and wake whoever waited for it.
fn let_go(world: &mut World, events: &mut EventQueue, car_id: EntityId) {
    let mut nodes: Vec<EntityId> = world.manoeuvres.iter().filter(|(_, (c, _))| *c == car_id).map(|(&n, _)| n).collect();
    nodes.sort_unstable();
    for n in &nodes {
        world.manoeuvres.remove(n);
    }
    wake_round(world, events, &nodes, car_id);
}

/// Is the street clear for a car to pull out of its lot onto it? Everyone
/// on the street either past the node or far enough off to see the car and
/// stop short of it; one waiting to pull out of a lot of its own is not on
/// the street yet.
fn gap_at(world: &World, car_id: EntityId, trip: &Trip, now: GameTime) -> bool {
    // Nobody else turning here, nor just ahead on its way: two cars
    // pulling out of doors side by side, each across the other's way,
    // would each stop for the other.
    let nodes = turn_nodes(trip, 0);
    let ahead = &trip.route[trip.from_lot..trip.route.len().min(trip.from_lot + 3)];
    if nodes.iter().chain(ahead).any(|&n| held(world, car_id, n)) {
        return false;
    }
    nodes.iter().all(|&street| {
        on_street(world, street).into_iter().all(|o| {
            let Some(GameObject::Car(c)) = world.objects.get(o).map(|e| &e.object) else { return true };
            let Some(t) = c.trip.as_ref().filter(|_| o != car_id) else { return true };
            if t.from_lot > 0 && t.route_index <= t.from_lot {
                return true;
            }
            let Some(k) = (t.route_index - 1..t.route.len()).find(|&k| t.route[k] == street) else { return true };
            let (p, v) = physics::catch_up(t.progress, t.speed, t.acceleration, (now - t.updated_at) as f64 / 1000.0);
            let d = t.segment_lengths[1..=k].iter().sum::<f64>() - p;
            // Standing on the node shuts it; coming, and too near to stop,
            // shuts it; one standing in a queue short of it lets the car
            // out ahead of it, as drivers in a queue do.
            let past = d < -(tail(c.role) + MIN_GAP);
            let on = d - nose(c.role) < MIN_GAP;
            let coming = v >= 0.05 && d - nose(c.role) < headway(v, 0.0);
            past || !(on || coming)
        })
    })
}

/// May a car turn off the street into its lot here? Nobody else turning
/// here, and nobody moving toward it from the other way near enough that
/// it would have to stop: a car turns in across the oncoming lane. One
/// standing still is no reason to wait: it may be waiting for this one.
fn clear_to_turn_in(world: &World, car_id: EntityId, trip: &Trip, now: GameTime) -> bool {
    let nodes = turn_nodes(trip, 1);
    if nodes.iter().any(|&n| held(world, car_id, n)) {
        return false;
    }
    let at = trip.route.len() - 1 - trip.to_lot;
    let (node, from) = (trip.route[at], trip.route[at - 1]);
    on_street(world, node).into_iter().all(|o| {
        let Some(GameObject::Car(c)) = world.objects.get(o).map(|e| &e.object) else { return true };
        let Some(t) = c.trip.as_ref().filter(|_| o != car_id) else { return true };
        let Some(k) = (t.route_index.max(1)..t.route.len()).find(|&k| t.route[k] == node) else { return true };
        if t.route[k - 1] == from {
            return true;
        }
        let (p, v) = physics::catch_up(t.progress, t.speed, t.acceleration, (now - t.updated_at) as f64 / 1000.0);
        let d = t.segment_lengths[1..=k].iter().sum::<f64>() - p;
        v < 0.05 || d - nose(c.role) > headway(v, 0.0) + 1.0
    })
}

/// The speed the bend at route[k] allows, if that is less than cruising. A
/// straight node limits nothing, and so is nothing to slow for or wake at.
fn bend(world: &World, route: &[EntityId], k: usize) -> Option<f64> {
    let limit = physics::turn_speed(world.turn_cos_angle(route, k));
    (limit < CRUISE_SPEED - 1e-9).then_some(limit)
}

/// How many nodes short of an intersection a car queues for passage through
/// it. Close enough that the queue is the cars actually at the junction, in
/// the order they arrived; a car that queued from the far end of the street
/// would hold up the cross traffic while it was still a minute away.
const QUEUE_AHEAD: usize = 3;

/// How many nodes ahead a car looks for what it has to slow for — and so how
/// far it may drive before it looks again.
const LOOKAHEAD: usize = 30;

/// Does crossing route[k] bring an intersection within queueing range? Not
/// one the route ends on: the car never queues there.
fn brings_in_range(world: &World, route: &[EntityId], k: usize) -> bool {
    let j = k + QUEUE_AHEAD;
    j + 1 < route.len() && world.is_intersection(route[j])
}

/// How far along the route a car on segment `ri` can drive without thinking:
/// to the first node ahead where the road asks something of it. A junction,
/// where queues change and claims are settled; a bend, whose limit lifts only
/// once the car is past it; the point where an intersection comes within
/// queueing range, since a car asleep there queues behind the one following
/// it; a chunk line, so whoever is watching the next chunk sees it arrive.
/// A straight run between those it sleeps through, as far as it looked.
fn stretch_end(world: &World, car_id: EntityId, trip: &Trip, ri: usize, seg_start: f64) -> f64 {
    let here = world.objects.get(car_id).and_then(|e| e.position).map(chunk_of);
    let mut end = seg_start;
    for k in ri..trip.route.len().min(ri + LOOKAHEAD) {
        end += trip.segment_lengths[k];
        let node = trip.route[k];
        let chunk = world.objects.get(node).and_then(|e| e.position).map(chunk_of);
        if world.network.is_junction(node)
            || bend(world, &trip.route, k).is_some()
            || brings_in_range(world, &trip.route, k)
            || chunk != here
        {
            break;
        }
    }
    end
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

/// What a car takes turns at to come to node `k` of its route and go on
/// past it: the junction there; and the crossing on its way to it, half
/// the link before it (`World::crossing_of`), where the stop line before a
/// junction would be. Each with the way it comes in by and goes out by,
/// its track through, and how far past the node it is through: before it,
/// for a crossing.
struct Gate {
    id: EntityId,
    from: (i32, i32),
    to: (i32, i32),
    track: Option<crate::intersection::Track>,
    past: f64,
}

impl Gate {
    fn crossing(&self) -> bool {
        self.id >= crate::world::decks::CROSSINGS
    }
}

fn gates(world: &World, route: &[EntityId], k: usize) -> Vec<Gate> {
    let mut out = Vec::new();
    if k == 0 || k >= route.len() {
        return out;
    }
    let (prev, at) = (route[k - 1], route[k]);
    if let Some(id) = world.crossing_of(prev, at)
        && let (Some(a), Some(b)) = (world.node_pos(prev), world.node_pos(at))
    {
        // Across the corner, straight, in its lane; seen from the corner.
        let (dx, dy) = ((b[0] - a[0]).signum() as i32, (b[1] - a[1]).signum() as i32);
        let corner = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0].map(f64::round);
        let lane = if world.edges.contains_key(&(prev, at)) && world.edges.contains_key(&(at, prev)) { LANE } else { 0.0 };
        let track = crate::intersection::straight([a[0] - corner[0], a[1] - corner[1]], [b[0] - corner[0], b[1] - corner[1]], lane);
        out.push(Gate { id, from: (-dx, -dy), to: (dx, dy), track: Some(track), past: -world.segment_length(prev, at) / 2.0 });
    }
    if k + 1 < route.len()
        && world.is_intersection(at)
        && let (Some(from), Some(to)) = (arm(world, at, prev), arm(world, at, route[k + 1]))
    {
        out.push(Gate { id: at, from, to, track: track_through(world, prev, at, route[k + 1]), past: 0.0 });
    }
    out
}

/// A car's way through a junction, from one node to another, as it
/// drives it (`intersection::track`): in its lane, the right one of a road
/// both ways, the middle of a one-way.
fn track_through(world: &World, from: EntityId, at: EntityId, to: EntityId) -> Option<crate::intersection::Track> {
    let lane = |a: EntityId, b: EntityId| if world.edges.contains_key(&(a, b)) && world.edges.contains_key(&(b, a)) { LANE } else { 0.0 };
    Some(crate::intersection::track(world.node_pos(from)?, world.node_pos(at)?, world.node_pos(to)?, lane(from, at), lane(at, to)))
}

/// How far a road both ways keeps its lanes from its middle, in tiles: as
/// the client draws them.
const LANE: f64 = 0.11;

/// A junction's arms, if it has lights: the way to each neighbour.
fn light_arms(world: &World, junction: EntityId) -> Option<Vec<(i32, i32)>> {
    let Some(GameObject::RoadNode(n)) = world.objects.get(junction).map(|e| &e.object) else { return None };
    n.light?;
    let mut arms: Vec<(i32, i32)> = world.arms_of(junction, false).into_iter().filter_map(|a| arm(world, junction, a)).collect();
    arms.sort_unstable();
    arms.dedup();
    Some(arms)
}

/// A junction's lights look again (`IntersectionManager::tick`): set up
/// as its arms now are, or taken away; whoever the green lets through
/// woken; the phase shown; and the next look, while anyone is there.
pub fn lights(world: &mut World, events: &mut EventQueue, intersections: &mut IntersectionRegistry, junction: EntityId, now: GameTime) {
    let arms = light_arms(world, junction);
    let manager = intersections.get_or_create(junction);
    manager.set_signal(arms.as_deref(), now);
    let (woken, next) = manager.tick(now);
    let shown = manager.signal().map(|s| if s.clearing() { crate::protocol::ALL_RED } else { s.phase as u8 });
    for car in woken {
        events.wake(0, car);
    }
    if let Some(GameObject::RoadNode(n)) = world.objects.get(junction).map(|e| &e.object)
        && n.light.is_some()
        && n.light != shown
        && let Some(GameObject::RoadNode(n)) = world.objects.get_mut(junction).map(|e| &mut e.object)
    {
        n.light = shown;
    }
    if let Some(ms) = next {
        events.wake(ms, junction);
    }
}

/// Compute gap to a lead car on a shared edge.
fn lead_car_obstacle(
    world: &World,
    trip: &Trip,
    role: CarRole,
    edge: EdgeKey,
    cur_progress: f64,
    lead_id: EntityId,
    now: GameTime,
) -> Option<Obstacle> {
    let entry = world.objects.get(lead_id)?;
    let GameObject::Car(ref lead) = entry.object else {
        return None;
    };
    let lead_role = lead.role;
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
        distance: (gap - MIN_GAP - nose(role) - tail(lead_role)).max(0.0),
        speed: lead_speed,
        accel: lead.acceleration,
    })
}

/// The lane a car signals for (`Trip::signal`), if it does.
fn signalling(world: &World, car: EntityId) -> Option<u8> {
    match world.objects.get(car).map(|e| &e.object) {
        Some(GameObject::Car(c)) => c.trip.as_ref()?.signal,
        _ => None,
    }
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
    let (owner, role, mut trip) = match world.objects.get(car_id) {
        Some(entry) => match &entry.object {
            // A parked car has nothing to think about — unless it is a
            // vehicle on a call, which has finished unloading.
            GameObject::Car(c) => match c.trip.clone() {
                Some(t) => (c.owner, c.role, t),
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

    // Where the gear changes, and at the end of the route, the vehicle
    // stops on the node: stopped on it, it has reached it, though a stop
    // computed to the node may leave it a hair short.
    let (stops, backs) = (trip.route.len(), trip.backing.clone());
    let gear = |k: usize| k + 1 < stops && backs.iter().any(|&[a, b]| (a == k && k > 0) || b == k);
    // A trip to a road rather than a building ends off the map: it drives
    // off the end of its road and is gone, rather than pulling up there.
    let drives_off = matches!(world.objects.get(trip.destination).map(|e| &e.object), Some(GameObject::RoadNode(_)));
    let stops_at = |k: usize| gear(k) || (k + 1 == stops && !drives_off);
    let mut cur_progress = cur_progress;
    if stops_at(ri) && cur_speed < 1e-3 && seg_start + trip.segment_lengths[ri] - cur_progress < 0.01 {
        cur_progress = cur_progress.max(seg_start + trip.segment_lengths[ri] + 1e-9);
    }
    loop {
        let seg_len = trip.segment_lengths[ri];
        if cur_progress - seg_start < seg_len {
            break;
        }
        // A change of gear: it stands a moment before it pulls away.
        if gear(ri) {
            world.cusps.insert(car_id, now + CUSP_MS);
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
        if gates(world, &trip.route, ri).iter().filter(|g| !g.crossing()).any(|g| !intersections.has_passage(g.id, car_id)) {
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
            leave_crossed(world, events, car_id, &trip, old_ri, ri);
            crate::resident::arrival_readout(world, owner, trip.destination, trip.eta, now);
            park_car(world, intersections, events, car_id, trip.destination);
            // A lorry at a harbour only couples or drops a box: a moment.
            if role == CarRole::Truck && world.harbours.contains_key(&trip.destination) {
                events.wake(crate::haul::COUPLE_MS, car_id);
            } else if role != CarRole::Private {
                events.wake(crate::calls::SERVICE_MS, car_id);
            }
            return;
        }
        seg_start += seg_len;
        ri += 1;
    }

    leave_crossed(world, events, car_id, &trip, old_ri, ri);
    // Through a junction: in the lane's queue beyond it where it is on the
    // road, not where it was when it queued; at a merge, the order the
    // cars came through in.
    if (old_ri..ri).any(|k| world.is_intersection(trip.route[k])) {
        requeue(world, car_id, &trip, ri, cur_progress, now);
    }

    // Out of a lot: a give-way line where it stands. There it waits for a
    // gap; with one it pulls out, and the street waits for it until it is
    // in its lane.
    let street = trip.route[trip.from_lot];
    // A hold kept standing still is let go after a while, as a claim on a
    // junction is: whatever it waits for may be waiting for it. One kept
    // past where the car turns is let go at once.
    let held_since = world.manoeuvres.values().filter(|&&(c, _)| c == car_id).map(|&(_, t)| t).min();
    let mut lapsed = false;
    if let Some(since) = held_since {
        if !manoeuvring(world, car_id) {
            let_go(world, events, car_id);
        } else if cur_speed > 0.01 {
            for (c, t) in world.manoeuvres.values_mut() {
                if *c == car_id {
                    *t = now;
                }
            }
        } else if now >= since + crate::intersection::PATIENCE {
            intersections.lapses += 1;
            let_go(world, events, car_id);
            lapsed = true;
        }
    }
    // Only before it has moved: one already on its way out, its hold
    // lapsed, carries on rather than stand in the road.
    let mut waiting = trip.from_lot > 0 && ri == 1 && cur_progress < START && world.manoeuvres.get(&street).is_none_or(|&(o, _)| o != car_id);
    // Only the car at the head of the queue out of its lot takes the
    // street: one behind another, holding it, would stop the one ahead,
    // which waits for it (settlers off a ferry, one up the lane after
    // another).
    let first_out = (1..=trip.from_lot).all(|k| world.edges.get(&(trip.route[k - 1], trip.route[k])).and_then(|q| q.car_position(car_id)).is_none_or(|i| i == 0));
    if waiting && first_out && gap_at(world, car_id, &trip, now) {
        hold(world, events, car_id, &turn_nodes(&trip, 0), now);
        waiting = false;
    }
    join_run(world, car_id, &trip, ri, cur_progress, now, !waiting);

    // Into a lot: it turns off the street when nobody is coming the other
    // way, and from there holds where it does until it is parked, so
    // whoever comes along waits while it is still in the road.
    let turn_in = trip.route.len() - 1 - trip.to_lot;
    let holding_in = trip.to_lot > 0 && world.manoeuvres.get(&trip.route[turn_in]).is_some_and(|&(o, _)| o == car_id);
    let mut turning_in = false;
    // Not again on the wake it let go: whoever it woke goes first.
    if trip.to_lot > 0 && !holding_in && !lapsed {
        let nodes = turn_nodes(&trip, 1);
        // Only the car at the head of the queue all the way into its lot:
        // one behind another holding the street would stop the one ahead,
        // which it waits for.
        let first = || (ri..=turn_in + 1).all(|k| world.edges.get(&(trip.route[k - 1], trip.route[k])).and_then(|q| q.car_position(car_id)).is_none_or(|i| i == 0));
        if ri == turn_in && first() && !clear_to_turn_in(world, car_id, &trip, now) {
            turning_in = true;
        } else if ri > turn_in && !nodes.iter().any(|&n| held(world, car_id, n)) {
            hold(world, events, car_id, &nodes, now);
        }
    }

    // A car holds a junction until its tail is through it, not until its
    // nose is: the car behind is let into the node only once this one has
    // actually left it. The last few nodes passed are the ones that can
    // still be under the tail; the next to clear sets a wake.
    let mut tail_clears: Option<f64> = None;
    // From the node ahead, whose crossing, if it has one, the car may be
    // past already; its junction it is not.
    let mut node_dist = seg_start + trip.segment_lengths[ri];
    for k in (1..=ri).rev().take(5) {
        for g in gates(world, &trip.route, k).into_iter().filter(|g| k < ri || g.crossing()) {
            if cur_progress - node_dist >= g.past + tail(role) {
                for woken_id in intersections.clear_car(g.id, car_id, now) {
                    events.wake(0, woken_id);
                }
            } else {
                let clears = node_dist + g.past + tail(role);
                tail_clears = Some(tail_clears.map_or(clears, |t: f64| t.min(clears)));
                // Standing with its tail in the box: after a few seconds it
                // waves the others through, as it would at the line.
                if cur_speed < 0.01 {
                    for woken_id in intersections.lapse(g.id, car_id, now) {
                        events.wake(0, woken_id);
                    }
                }
            }
        }
        node_dist -= trip.segment_lengths[k];
    }

    // Its nose at the crossing on the link it is on, if there is one, or
    // past it: through it, nothing there stops it any more.
    let reached = cur_progress + nose(role) >= seg_start + 0.5 * trip.segment_lengths[ri];

    // === LANES ===
    let lanes_were = (trip.lanes.clone(), trip.shift, trip.signal);
    let mut slotting = Vec::new();
    trip.signal = None;
    if !waiting && !manoeuvring(world, car_id) {
        slotting = change_lanes(world, events, car_id, role, &mut trip, ri, cur_progress, cur_speed, now);
    }
    let lanes_changed = (trip.lanes.clone(), trip.shift, trip.signal) != lanes_were;

    // === SCAN ===
    let current_edge: EdgeKey = (trip.route[ri - 1], trip.route[ri]);
    let seg_progress = cur_progress - seg_start;
    let remaining = trip.segment_lengths[ri] - seg_progress;
    let mut obstacles = Vec::<Obstacle>::new();

    // Register at the gates ahead: junctions, and crossings.
    'ahead: for k in ri..(ri + QUEUE_AHEAD).min(trip.route.len()) {
        // A crossing only from the link before it on: everyone crosses
        // everyone there, and one claimed from further off is held all
        // that way.
        for g in gates(world, &trip.route, k).into_iter().filter(|g| k <= ri + 1 || !g.crossing()) {
            // Off a priority road onto it, or across it, a car gives
            // way to whoever is on it.
            let major = world.is_road(trip.route[k]) && world.is_road(trip.route[k - 1]);
            let lit = light_arms(world, g.id);
            let junction = intersections.get_or_create(g.id);
            if lit.is_some() {
                junction.set_signal(lit.as_deref(), now);
                events.wake(crate::intersection::SIGNAL_TICK, g.id);
            }
            // The lane it goes out by; in from the side onto a road of two,
            // a merge, which those coming along it may make room for.
            let lane = trip.lanes.get(k + 1).copied().unwrap_or(0);
            let merge = !g.crossing() && g.from != (-g.to.0, -g.to.1) && world.edges.get(&(trip.route[k], trip.route[k + 1])).is_some_and(|s| s.lanes > 1);
            if junction.register_ranked(car_id, g.from, g.to, lane, g.track, major, now) && merge {
                wake_round(world, events, &[g.id], car_id);
            }
            // Holding the junction and going nowhere: after a few seconds
            // of that, wave the others through and queue again. Standing
            // is a crawl under a hundredth of a tile a second, since a
            // car held at a gap never quite reads zero.
            if cur_speed < 0.01 {
                for woken_id in intersections.lapse(g.id, car_id, now) {
                    events.wake(0, woken_id);
                }
            }
            if !intersections.has_passage(g.id, car_id) {
                // Nothing held beyond a gate it has no passage at: a claim
                // made from behind it while it had one, and kept after that
                // lapsed, would be a junction held by a car that cannot
                // reach it.
                for j in (k + 1..trip.route.len()).take(QUEUE_AHEAD) {
                    for beyond in gates(world, &trip.route, j) {
                        for woken_id in intersections.remove_car(beyond.id, car_id, now) {
                            events.wake(0, woken_id);
                        }
                    }
                }
                break 'ahead;
            }
        }
    }

    // Queue for the run beyond the gates once passage through them is granted
    if ri + 1 < trip.route.len() {
        if gates(world, &trip.route, ri).iter().filter(|g| !g.crossing() || !reached).all(|g| intersections.has_passage(g.id, car_id)) {
            join_run(world, car_id, &trip, ri + 1, cur_progress, now, !waiting);
        }
    }

    // The car ahead, in each lane it stands in: two while it changes.
    for lead_id in world.edges.get(&current_edge).map_or_else(Vec::new, |s| s.ahead(car_id)) {
        obstacles.extend(lead_car_obstacle(world, &trip, role, current_edge, cur_progress, lead_id, now));
    }
    // A car ahead in the other lane, signalling for this car's: let in,
    // where this car can drop back for it without braking hard; looked for
    // as far as a car stops from cruising.
    for k in ri..trip.route.len() {
        if trip.segment_lengths[1..k].iter().sum::<f64>() - cur_progress > COURTESY {
            break;
        }
        let edge: EdgeKey = (trip.route[k - 1], trip.route[k]);
        let Some(seg) = world.edges.get(&edge).filter(|s| s.lanes > 1 && s.contains(car_id)) else { break };
        let mine = trip.lanes[k];
        for o in seg.lane(1 - mine as usize).filter(|&o| o != car_id && signalling(world, o) == Some(mine)) {
            let Some(GameObject::Car(c)) = world.objects.get(o).map(|e| &e.object) else { continue };
            let (Some(t), Some(mine_at)) = (c.trip.as_ref(), edge_start_dist(&trip, edge)) else { continue };
            let Some(its_at) = edge_start_dist(t, edge) else { continue };
            let (q, vo) = physics::catch_up(t.progress, t.speed, t.acceleration, (now - t.updated_at) as f64 / 1000.0);
            // Dropping back to the gap it needs to cut in (`headway`, as
            // `room` asks), and a little more; not for one it is inside
            // that already, or could only leave braking hard.
            let room = (q - its_at) - (cur_progress - mine_at) - nose(role) - tail(c.role) - MIN_GAP - cur_speed * REACTION - 0.1;
            if room >= -0.05 && physics::braking_distance(cur_speed, vo) <= room + 0.05 {
                obstacles.push(Obstacle::LeadCar { distance: room.max(0.0), speed: vo, accel: t.acceleration });
            }
        }
    }
    // Also check the next edge — we may be pre-registered there. At a
    // merge the car ahead there came from another arm; its distance to the
    // road out against ours is the gap to keep, and one ahead in the queue
    // but behind on the road is let go first, at the line.
    let mut give_way = false;
    // And further, wherever ahead it is queued already, the nearest car
    // ahead there: on a long straight with nobody on the next tile, a car
    // that looked no further would sleep its way into a queue standing a
    // few tiles on, or into one that merged in front of it.
    for k in ri + 2..trip.route.len() {
        let edge: EdgeKey = (trip.route[k - 1], trip.route[k]);
        let Some(seg) = world.edges.get(&edge).filter(|s| s.contains(car_id)) else { break };
        let leads = seg.ahead(car_id);
        for &lead_id in &leads {
            obstacles.extend(lead_car_obstacle(world, &trip, role, edge, cur_progress, lead_id, now));
        }
        if !leads.is_empty() {
            break;
        }
    }
    if ri + 1 < trip.route.len() {
        let next_edge: EdgeKey = (trip.route[ri], trip.route[ri + 1]);
        for lead_id in world.edges.get(&next_edge).map_or_else(Vec::new, |s| s.ahead(car_id)) {
            match lead_car_obstacle(world, &trip, role, next_edge, cur_progress, lead_id, now) {
                Some(obs) => obstacles.push(obs),
                None => {
                    // A merge at a junction, from another arm; or where two
                    // lanes become one, from the other lane, side by side.
                    let lane_drop = world.edges.get(&current_edge).is_some_and(|s| s.lanes > 1 && s.contains(lead_id) && s.lane_of(lead_id) != s.lane_of(car_id))
                        && world.edges.get(&next_edge).is_some_and(|s| s.lanes == 1);
                    give_way = lane_drop;
                }
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
    let entry_ri = remaining - 0.5 * trip.segment_lengths[ri] - nose(role);
    // Backing, a walking pace; in a lot, a crawl, on any edge that ends at a
    // lot node, from its start. Where the gear changes, and at the end, a
    // stop on the node; at a change of gear, a moment standing.
    let backing = |k: usize| backs.iter().any(|&[a, b]| a < k && k <= b);
    let mut standing = None;
    if let Some(&until) = world.cusps.get(&car_id) {
        if now < until {
            obstacles.push(Obstacle::MustStop { distance: 0.0 });
            standing = Some(until - now);
        } else {
            world.cusps.remove(&car_id);
        }
    }
    if backing(ri) {
        obstacles.push(Obstacle::SpeedLimit { distance: 0.0, speed: REVERSE_SPEED });
    } else if world.lot_nodes.contains_key(&trip.route[ri]) {
        obstacles.push(Obstacle::SpeedLimit { distance: 0.0, speed: LOT_SPEED });
    }
    if stops_at(ri) {
        obstacles.push(Obstacle::Halt { distance: remaining });
    }
    // At its own give-way line, with no gap yet; or about to turn in
    // across the oncoming lane, with somebody coming.
    if waiting {
        obstacles.push(Obstacle::MustStop { distance: 0.0 });
    }
    if turning_in {
        obstacles.push(Obstacle::MustStop { distance: (entry_ri - INTERSECTION_STOP_MARGIN).max(0.0) });
    }
    // A car turning off or onto the street ahead: stop short of it.
    let mut turn_ahead = false;
    if let Some(limit) = bend(world, &trip.route, ri) {
        obstacles.push(Obstacle::SpeedLimit { distance: entry_ri.max(0.0), speed: limit });
    }
    // Held to the stop line the same way, and for the same reason: dropping it
    // once the car reached the line meant a car in the last half edge before a
    // junction it has no claim on had nothing left telling it to wait.
    if gates(world, &trip.route, ri).iter().filter(|g| !g.crossing() || !reached).any(|g| !intersections.has_passage(g.id, car_id)) {
        obstacles.push(Obstacle::MustStop {
            distance: (entry_ri - INTERSECTION_STOP_MARGIN).max(0.0),
        });
    }
    if held(world, car_id, trip.route[ri]) {
        obstacles.push(Obstacle::MustStop { distance: (entry_ri - INTERSECTION_STOP_MARGIN).max(0.0) });
        turn_ahead = true;
    }
    if give_way {
        obstacles.push(Obstacle::MustStop { distance: (entry_ri - INTERSECTION_STOP_MARGIN).max(0.0) });
    }
    obstacles.extend(merging_ahead(world, intersections, car_id, &trip, role, ri, remaining, cur_speed, now));
    obstacles.extend(slotting.iter().copied());

    // Scan forward nodes
    let mut node_dist = remaining;
    for k in (ri + 1)..trip.route.len().min(ri + LOOKAHEAD) {
        node_dist += trip.segment_lengths[k];
        let entry_k = node_dist - 0.5 * trip.segment_lengths[k] - nose(role);

        let node = trip.route[k];

        // A trip that ends on a junction stops there; it never registered
        // for passage, so waiting for it would be waiting for ever.
        if gates(world, &trip.route, k).iter().any(|g| !intersections.has_passage(g.id, car_id)) {
            obstacles.push(Obstacle::MustStop {
                distance: (entry_k - INTERSECTION_STOP_MARGIN).max(0.0),
            });
            break;
        }

        if !turn_ahead && held(world, car_id, node) {
            obstacles.push(Obstacle::MustStop { distance: (entry_k - INTERSECTION_STOP_MARGIN).max(0.0) });
            turn_ahead = true;
        }
        if world.lot_nodes.contains_key(&node) {
            obstacles.push(Obstacle::SpeedLimit {
                distance: (node_dist - trip.segment_lengths[k] - nose(role)).max(0.0),
                speed: LOT_SPEED,
            });
        }
        if stops_at(k) {
            obstacles.push(Obstacle::Halt { distance: node_dist });
        }
        if let Some(limit) = bend(world, &trip.route, k) {
            obstacles.push(Obstacle::SpeedLimit { distance: entry_k, speed: limit });
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

    // Waiting for a gap: look again soon. Waiting for someone else to turn
    // needs no looking: they wake whoever is coming once they are clear.
    if waiting || turning_in || !slotting.is_empty() {
        wake_ms = wake_ms.min(500);
    }
    if let Some(ms) = standing {
        wake_ms = wake_ms.min(ms);
    }
    // Awake when a change of lanes is done, to leave the lane it left.
    if let Some(s) = trip.shift.filter(|s| s.from != s.to) {
        wake_ms = wake_ms.min(s.until.saturating_sub(now).max(1));
    }

    // Be awake when this stretch ends, because crossing is when the car has to
    // change queues, clear the junction behind it and shed the limit of the
    // bend it is through — and it cannot do any of that while it is asleep.
    //
    // Solved with the acceleration it is about to drive with, not at whatever
    // speed it happens to hold now. Dividing the distance by the current speed
    // said "never" for a car pulling away from rest, which let it sleep through
    // a junction and take the turn at twice the speed the turn allows.
    let end = stretch_end(world, car_id, &trip, ri, seg_start);
    if let Some(t) = physics::time_to_reach(cur_progress, cur_speed, new_accel, end) {
        wake_ms = wake_ms.min(((t * 1000.0) as u64).max(1));
    }
    if let Some(at) = tail_clears
        && let Some(t) = physics::time_to_reach(cur_progress, cur_speed, new_accel, at)
    {
        wake_ms = wake_ms.min(((t * 1000.0) as u64).max(1));
    }

    events.wake(wake_ms, car_id);

    let accel_changed = ((new_accel - trip.acceleration) / ACCELERATION).abs() > 0.02;

    // Wake car behind on acceleration change: a driver's reaction time,
    // quicker for brake lights than for a gap opening. Not much slower than
    // this for the gap, though: a queue that noticed its head pulling away
    // only after four hundred milliseconds drained slowly enough to back up
    // through the junction behind it, and two driveways then held each
    // other for good.
    if accel_changed {
        let delay = if new_accel < 0.0 { 50 } else { 150 };
        for behind in world.car_behind_on_edge(current_edge, car_id) {
            events.wake(delay, behind);
        }
        // And whoever follows it onto the road out of the junction ahead:
        // at a merge, a car from the other arm.
        if ri + 1 < trip.route.len() {
            for behind in world.car_behind_on_edge((trip.route[ri], trip.route[ri + 1]), car_id) {
                if from_another_arm(world, behind, trip.route[ri], trip.route[ri - 1]) {
                    events.wake(delay, behind);
                }
            }
            // And whoever comes to merge into its lane there, queued yet or not.
            for (o, ..) in merging_with(world, car_id, &trip, ri, now) {
                events.wake(delay, o);
            }
        }
        // Cross-edge: front car on previous edge
        if ri >= 2 {
            let prev_edge: EdgeKey = (trip.route[ri - 2], trip.route[ri - 1]);
            if let Some(prev_seg) = world.edges.get(&prev_edge) {
                for front_id in prev_seg.fronts().filter(|&f| f != car_id).collect::<Vec<_>>() {
                    events.wake(delay, front_id);
                }
            }
        }
    }

    // Update spatial position when car crosses a node
    if ri != old_ri {
        if let Some(node_pos) = world.objects.get(trip.route[ri - 1]).and_then(|e| e.position) {
            world.update_position(car_id, node_pos);
        }
    }

    let entry = if accel_changed || lanes_changed {
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
        if lanes_changed {
            t.lanes = trip.lanes.clone();
            t.shift = trip.shift;
            t.signal = trip.signal;
        }
    }
}

/// Who a car coming to a junction, `d` short of it, follows into the lane
/// it goes out by, besides whoever is ahead of it there already: each car
/// coming into that lane by another arm, not yet through, that it may not
/// go ahead of, as a lead it keeps its distance behind as if both were on
/// the road out already. It may go ahead of one that can brake to follow
/// it, as a driver takes a gap; where neither could follow the other, the
/// nearer goes first. Both see the same order, and as they slow one of
/// them can always follow the other. Read from the cars' own trips, not
/// the lane's queue: one asleep on its way has not queued past the
/// junction yet.
#[allow(clippy::too_many_arguments)]
fn merging_ahead(world: &World, intersections: &IntersectionRegistry, car_id: EntityId, trip: &Trip, role: CarRole, ri: usize, remaining: f64, v: f64, now: GameTime) -> Vec<Obstacle> {
    let Some(j) = merge_ahead(world, trip, ri) else { return Vec::new() };
    let d = remaining + trip.segment_lengths[ri + 1..=j].iter().sum::<f64>();
    // Can a car `back` short of the junction going `vb` follow one `front`
    // short of it going `vf`.
    let follows = |back: f64, vb: f64, rb: CarRole, front: f64, vf: f64, rf: CarRole| back - front >= nose(rb) + tail(rf) + headway(vb, vf);
    merging_with(world, car_id, trip, ri, now)
        .into_iter()
        // One the junction holds at its line is going nowhere yet.
        .filter(|&(o, ..)| !intersections.held(trip.route[j], o))
        .filter(|&(o, dist, vo, _, ro)| !follows(dist, vo, ro, d, v, role) && (follows(d, v, role, dist, vo, ro) || (dist, o) < (d, car_id)))
        .map(|(_, dist, vo, ao, ro)| Obstacle::LeadCar { distance: (d - dist - nose(role) - tail(ro) - MIN_GAP).max(0.0), speed: vo, accel: ao })
        .collect()
}

/// The node of a car's route where it comes to the next junction it goes
/// through, as near as it queues for one.
fn merge_ahead(world: &World, trip: &Trip, ri: usize) -> Option<usize> {
    (ri..trip.route.len().saturating_sub(1)).take(QUEUE_AHEAD).find(|&k| world.is_intersection(trip.route[k]))
}

/// The cars coming into the lane a car goes out of the junction ahead by,
/// by another arm of the same rank, not yet through it: each with how far
/// it is short of it, its speed, acceleration and kind. Off a priority road
/// onto it the junction says who goes (`register_ranked`), not this.
fn merging_with(world: &World, car_id: EntityId, trip: &Trip, ri: usize, now: GameTime) -> Vec<(EntityId, f64, f64, f64, CarRole)> {
    let Some(j) = merge_ahead(world, trip, ri) else { return Vec::new() };
    let (at, from, next) = (trip.route[j], trip.route[j - 1], trip.route[j + 1]);
    let lane = trip.lanes.get(j + 1).copied().unwrap_or(0);
    let major = |n: EntityId| world.is_road(at) && world.is_road(n);
    on_street(world, at)
        .into_iter()
        .filter(|&o| o != car_id)
        .filter_map(|o| {
            let Some(GameObject::Car(c)) = world.objects.get(o).map(|e| &e.object) else { return None };
            let t = c.trip.as_ref()?;
            let j = (t.route_index.max(1)..t.route.len().saturating_sub(1)).find(|&j| t.route[j] == at)?;
            if t.route[j + 1] != next || t.route[j - 1] == from || major(t.route[j - 1]) != major(from) || t.lanes.get(j + 1).copied().unwrap_or(0) != lane {
                return None;
            }
            let (q, vo) = physics::catch_up(t.progress, t.speed, t.acceleration, (now - t.updated_at) as f64 / 1000.0);
            Some((o, t.segment_lengths[1..=j].iter().sum::<f64>() - q, vo, t.acceleration, c.role))
        })
        .collect()
}

/// How long a change of lanes takes, and how long after one a car thinks
/// of another.
const SHIFT_MS: GameTime = 1500;
const SETTLE_MS: GameTime = 2500;
/// How far before the junction ending its stretch a car gets into the lane
/// its turn there asks for; and how near it a car makes room for one
/// waiting there to merge into its lane.
const GET_IN: f64 = 12.0;
const MAKE_ROOM: f64 = 4.0;
/// How near the car ahead must be for a car to go round it, if it is
/// slower; and how clear the right lane must be ahead to go back to it.
const OVERTAKE: f64 = 3.0;
const KEEP_RIGHT: f64 = 4.0;

/// A car on a road of two lanes minds its lane, at whatever wakes it
/// (docs/plan-interchange.md, Built: two lanes). A change it has had the time for is
/// done: it leaves the lane it left, and whoever was behind it there is
/// woken. Else, a while after the last, it may begin another, into the
/// other lane, where there is room there:
///
/// - into the lane its turn at the end of the stretch asks for, nearing it;
/// - out of the lane a car waits at the junction ahead to merge into;
/// - round a slower car close ahead, where the other lane is clearer;
/// - back into the right lane, where it is clear ahead.
///
/// Changing, it stands in both lanes' queues on the rest of its stretch,
/// so whoever follows in either keeps clear of it; the lane is carried on
/// past junctions it goes straight through. Room is the car ahead in the
/// lane far enough not to be run into, and the one behind far enough to
/// slow for it. With no room in the lane its turn asks for, it falls in
/// behind the car ahead there and waits short of the junction for a gap:
/// what holds it is handed back.
#[allow(clippy::too_many_arguments)]
fn change_lanes(world: &mut World, events: &mut EventQueue, car_id: EntityId, role: CarRole, trip: &mut Trip, ri: usize, p: f64, v: f64, now: GameTime) -> Vec<Obstacle> {
    let len = trip.route.len();
    let edge = |k: usize| (trip.route[k - 1], trip.route[k]);
    if let Some(s) = trip.shift.filter(|s| s.from != s.to && now >= s.until) {
        for k in ri..len {
            let e = edge(k);
            if !world.edges.get(&e).is_some_and(|seg| seg.contains(car_id)) {
                break;
            }
            for b in world.car_behind_on_edge(e, car_id) {
                events.wake(0, b);
            }
            let keep = trip.lanes[k] as usize;
            world.edges.get_mut(&e).unwrap().leave_lane(car_id, 1 - keep);
        }
        trip.shift = Some(Shift { from: s.to, ..s });
    }
    if trip.shift.is_some_and(|s| s.from != s.to || now < s.until + SETTLE_MS) {
        return Vec::new();
    }
    let wide = |k: usize| world.edges.get(&(trip.route[k - 1], trip.route[k])).is_some_and(|s| s.lanes > 1);
    let end = (ri..len).find(|&k| k + 1 == len || world.network.is_junction(trip.route[k])).unwrap_or(ri);
    if !(ri..=end).all(wide) {
        return Vec::new();
    }
    let to_end = trip.segment_lengths[1..=end].iter().sum::<f64>() - p;
    let lane = trip.lanes[ri];
    let other = 1 - lane;
    let want = world.turn_lane(&trip.route, end);
    // How far a change carries: on past junctions it goes straight through.
    let mut carry = ri;
    while carry < len && wide(carry) && (carry == ri || !world.network.is_junction(trip.route[carry - 1]) || world.turn_lane(&trip.route, carry - 1).is_none()) {
        carry += 1;
    }
    let near = [0, 1].map(|l| neighbours(world, car_id, trip, ri, carry - 1, p, l, now));
    // Someone at the junction ahead about to come into the lane this car
    // goes out by.
    let joining = merging_with(world, car_id, trip, ri, now).iter().any(|&(_, dist, ..)| dist < MAKE_ROOM / 2.0);
    let merging = |l: u8| to_end < MAKE_ROOM && end + 1 < len && trip.lanes[end + 1] == l && joining;
    let ahead = |l: u8| near[l as usize][0];
    let slow = ahead(lane).filter(|&(d, vo, ..)| d < OVERTAKE && vo < v - 0.1);
    let to = if to_end < 0.8 {
        None
    } else if let Some(w) = want.filter(|&w| w != lane && to_end < GET_IN) {
        Some(w)
    } else if merging(lane) && want != Some(lane) {
        Some(other)
    } else if v < 0.5 {
        None
    } else if let Some((d, vo, ..)) = slow.filter(|_| want.is_none_or(|w| w == other || to_end > GET_IN)) {
        ahead(other).is_none_or(|(e, wo, ..)| e > d + 1.0 || wo > vo + 0.2).then_some(other)
    } else if lane == 1 && want != Some(1) && !merging(0) {
        ahead(0).is_none_or(|(d, vo, ..)| d > KEEP_RIGHT || vo >= v).then_some(0)
    } else {
        None
    };
    let Some(to) = to else { return Vec::new() };
    if !room(role, v, near[to as usize]) {
        // No room in the lane its turn needs: it falls in behind the car
        // ahead there, and short of the junction it waits for a gap.
        if want != Some(to) {
            return Vec::new();
        }
        // And signals: whoever is coming along behind in that lane may
        // drop back for it.
        trip.signal = Some(to);
        for b in coming(world, car_id, trip, ri, p, to as usize, now) {
            events.wake(0, b);
        }
        let mut hold = vec![Obstacle::MustStop { distance: (to_end - 1.0).max(0.0) }];
        // Behind the car ahead there, where it can fall in without braking
        // hard; one beside it it lets go by.
        if let Some((d, vo, ro, _)) = ahead(to)
            && let gap = d - nose(role) - tail(ro) - MIN_GAP
            && gap >= 0.0
            && physics::braking_distance(v, vo) <= gap + 0.05
        {
            hold.push(Obstacle::LeadCar { distance: gap, speed: vo, accel: 0.0 });
        }
        return hold;
    }
    for k in ri..carry {
        trip.lanes[k] = to;
    }
    for j in ri..carry {
        let e = edge(j);
        if !world.edges.get(&e).is_some_and(|seg| seg.contains(car_id)) {
            break;
        }
        let mine = p - trip.segment_lengths[1..j].iter().sum::<f64>();
        let behind: Vec<EntityId> = world.edges[&e].lane(to as usize).filter(|&o| position_on(world, o, e, now).is_some_and(|q| q < mine)).collect();
        world.edges.get_mut(&e).unwrap().insert_before(car_id, to as usize, |o| behind.contains(&o));
        for b in world.car_behind_on_edge(e, car_id) {
            events.wake(0, b);
        }
    }
    trip.shift = Some(Shift { from: lane, to, at: now, until: now + SHIFT_MS });
    Vec::new()
}

/// A car near another in a lane: how far along the road from it (ahead
/// more than nothing, behind less), its speed, its kind, which.
type Near = (f64, f64, CarRole, EntityId);

/// The nearest car ahead in one lane of a car's way to node `end`, and
/// the nearest behind (`Near`). Behind, on the edges it
/// has come along too: one there may not yet have queued where this car
/// is, a junction back, until it wakes there.
#[allow(clippy::too_many_arguments)]
fn neighbours(world: &World, car_id: EntityId, trip: &Trip, ri: usize, end: usize, p: f64, lane: usize, now: GameTime) -> [Option<Near>; 2] {
    /// How many edges back it looks.
    const BACK: usize = 4;
    let mut out: [Option<Near>; 2] = [None, None];
    for k in ri.saturating_sub(BACK).max(1)..=end {
        let e = (trip.route[k - 1], trip.route[k]);
        let Some(seg) = world.edges.get(&e) else { continue };
        let mine = p - trip.segment_lengths[1..k].iter().sum::<f64>();
        for o in seg.lane(lane).filter(|&o| o != car_id) {
            let Some(GameObject::Car(c)) = world.objects.get(o).map(|e| &e.object) else { continue };
            let Some(t) = c.trip.as_ref() else { continue };
            let Some(start) = edge_start_dist(t, e) else { continue };
            let (q, vo) = physics::catch_up(t.progress, t.speed, t.acceleration, (now - t.updated_at) as f64 / 1000.0);
            let d = q - start - mine;
            let slot = usize::from(d <= 0.0);
            if out[slot].is_none_or(|(n, ..)| d.abs() < n.abs()) {
                out[slot] = Some((d, vo, c.role, o));
            }
        }
    }
    out
}

/// How far a car signalling looks back for someone to let it in, and how
/// far ahead one looks for a car signalling: as far as it takes to stop
/// from cruising, and the gap.
const COURTESY: f64 = 6.0;

/// The cars coming up behind one in a lane of its way, as far back as
/// `COURTESY`.
fn coming(world: &World, car_id: EntityId, trip: &Trip, ri: usize, p: f64, lane: usize, now: GameTime) -> Vec<EntityId> {
    let mut out = Vec::new();
    for k in (1..=ri).rev() {
        if p - trip.segment_lengths[1..k].iter().sum::<f64>() > COURTESY + trip.segment_lengths[k] {
            break;
        }
        let e = (trip.route[k - 1], trip.route[k]);
        let Some(seg) = world.edges.get(&e) else { continue };
        let mine = p - trip.segment_lengths[1..k].iter().sum::<f64>();
        out.extend(seg.lane(lane).filter(|&o| o != car_id && position_on(world, o, e, now).is_some_and(|q| q < mine)));
    }
    out
}

/// Is there room for a car going `v` between these two in a lane: the one
/// ahead far enough not to be run into, the one behind far enough to slow
/// to it.
fn room(role: CarRole, v: f64, [ahead, behind]: [Option<Near>; 2]) -> bool {
    ahead.is_none_or(|(d, vo, ro, _)| d - nose(role) - tail(ro) >= MIN_GAP + (v - vo).max(0.0) * 1.5)
        && behind.is_none_or(|(d, vo, ro, _)| -d - nose(ro) - tail(role) >= headway(vo, v))
}
