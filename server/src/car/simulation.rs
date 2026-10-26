use crate::car::physics;
use crate::car::{nose, tail, ACCELERATION, CUSP_MS, INTERSECTION_STOP_MARGIN, LOT_SPEED, MIN_GAP, Obstacle, REVERSE_SPEED};
use model::CRUISE_SPEED;
use model::Cause;
use model::GameTime;
use crate::engine::event_queue::EventQueue;
use map::intersection::{IntersectionRegistry, TRACK_POINTS};
use model::{Shift, CarRole, EdgeKey, EntityId, GameObject, Trip};
use crate::world::World;
use map::chunk_of;
use map::bezier::LANE_OFFSET;

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
    events: &mut EventQueue,
    car_id: EntityId,
    at_building: EntityId,
) {
    let mut owner = None;
    let trip_info = world.map.objects.get(car_id).and_then(|entry| {
        if let GameObject::Car(ref car) = entry.object {
            owner = Some(car.owner);
            car.trip.as_ref().map(|t| (t.route.clone(), t.route_index, t.total_route_length))
        } else {
            None
        }
    });
    if let Some((route, route_index, driven)) = trip_info {
        crate::resident::drove(world, car_id, driven);
        world.map.unregister_car_route(car_id, &route);
        if route_index >= 1 {
            let edge = (route[route_index - 1], route[route_index]);
            for behind in world.map.car_behind_on_edge(edge, car_id) {
                events.wake(0, behind);
            }
        }
    }
    let woken = world.map.streets.remove_car_from_all(car_id, events.now());
    for (_node_id, woken_id) in woken {
        events.wake(0, woken_id);
    }
    events.clear_dedup(car_id);
    let_go(world, events, car_id);
    world.map.remove_car_from_edges(car_id);

    // Its building gone, it goes home: its owner's, or a fleet's own yard.
    // Nobody's any more, it is scrap.
    let owner = owner.filter(|&o| world.map.owns(o, car_id));
    let at_building = match (world.map.objects.get(at_building), owner.and_then(|o| world.map.objects.get(o)).map(|e| &e.object)) {
        (Some(_), _) => at_building,
        (None, Some(GameObject::Resident(r))) => r.home,
        (None, _) => owner.unwrap_or(at_building),
    };
    match world.map.objects.get(at_building).and_then(|e| e.position).filter(|_| owner.is_some()) {
        Some(tile) => {
            world.map.update_position(car_id, tile);
            if let Some(entry) = world.map.objects.get_mut(car_id)
                && let GameObject::Car(ref mut c) = entry.object
            {
                c.trip = None;
            }
            world.map.park_in_lot(at_building, car_id, events.now());
        }
        None => world.map.despawn_car(car_id),
    }

    // The driver steps out wherever the car stopped.
    if let Some(owner) = owner {
        let aboard = world.map.objects.get(owner).is_some_and(|e| match e.object {
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
    events: &mut EventQueue,
    car_id: EntityId,
) {
    let home = world.map.objects.get(car_id).and_then(|e| match e.object {
        GameObject::Car(ref c) => Some(c.owner),
        _ => None,
    });
    let home = home.and_then(|owner| {
        world.map.objects.get(owner).and_then(|e| match e.object {
            GameObject::Resident(ref r) => Some(r.home),
            _ => None,
        })
    });
    match home {
        Some(home) => park_car(world, events, car_id, home),
        // No owner to speak of: scrap it.
        None => {
            events.clear_dedup(car_id);
            let _ = world.map.streets.remove_car_from_all(car_id, events.now());
            world.map.despawn_car(car_id);
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
        let car_behind = world.map.car_behind_on_edge(old_edge, car_id);
        if let Some(seg) = world.map.edges.get_mut(&old_edge) {
            seg.remove(car_id);
        }
        for behind in car_behind {
            events.wake(0, behind);
        }
        if let Some(set) = world.map.node_cars.get_mut(&trip.route[k - 1]) {
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
        if world.map.edges.get(&edge).is_some_and(|seg| !seg.contains(car_id)) {
            // Only a car out of a lot joins partway along; from a junction,
            // everyone on the run is ahead. It joins at the street node,
            // wherever along its way out it is: the way from a door is a
            // tile long, and measured along it the car would queue behind
            // one standing at the node, waiting for it. Others still on
            // their way out are measured so too, or two would stand in one
            // order on a stretch and the other on the next.
            let mine = queued_at(trip, at) - trip.along[k - 1];
            let behind = |o: EntityId| position_on(world, o, edge, now).is_some_and(|p| p < mine);
            // Ahead of whoever is behind it: a car asleep on its way joins
            // the run late, and is not behind everyone on it.
            let lane = trip.lanes.get(k).copied().unwrap_or(0) as usize;
            let behind: Vec<EntityId> = world.map.edges[&edge].all().filter(|&o| behind(o)).collect();
            world.map.edges.get_mut(&edge).unwrap().insert_before(car_id, lane, |o| behind.contains(&o));
        }
        if world.map.network.ends_run(trip.route[k]) || world.map.is_intersection(trip.route[k]) {
            break;
        }
    }
}

/// A car in its lanes' queues ahead, each where it stands on the road: off
/// the queue and back in it behind whoever is ahead of it.
fn requeue(world: &mut World, car_id: EntityId, trip: &Trip, ri: usize, p: f64, now: GameTime) {
    for k in ri..trip.route.len() {
        let e = (trip.route[k - 1], trip.route[k]);
        if !world.map.edges.get(&e).is_some_and(|s| s.contains(car_id)) {
            break;
        }
        let mine = p - trip.along[k - 1];
        for lane in 0..2 {
            if !world.map.edges[&e].in_lane(car_id, lane) {
                continue;
            }
            world.map.edges.get_mut(&e).unwrap().leave_lane(car_id, lane);
            let behind: Vec<EntityId> = world.map.edges[&e].lane(lane).filter(|&o| position_on(world, o, e, now).is_some_and(|q| q < mine)).collect();
            world.map.edges.get_mut(&e).unwrap().insert_before(car_id, lane, |o| behind.contains(&o));
        }
    }
}

/// Is this car coming to a junction by another arm than `mine`, not yet
/// through it: a car merging from the side.
fn from_another_arm(world: &World, car_id: EntityId, junction: EntityId, mine: EntityId) -> bool {
    let Some(GameObject::Car(c)) = world.map.objects.get(car_id).map(|e| &e.object) else { return false };
    let Some(t) = c.trip.as_ref() else { return false };
    let Some(i) = t.route.iter().position(|&n| n == junction) else { return false };
    i > 0 && i >= t.route_index && t.route[i - 1] != mine
}

/// Where a car is on its route, measured from the start of one of its
/// edges: short of it is negative.
fn position_on(world: &World, car_id: EntityId, edge: EdgeKey, now: GameTime) -> Option<f64> {
    let GameObject::Car(ref c) = world.map.objects.get(car_id)?.object else { return None };
    let t = c.trip.as_ref()?;
    let (p, _) = t.at(now);
    Some(queued_at(t, p) - t.start_of(edge)?)
}

/// The cars on the street at a node: everyone queued on an edge into or
/// out of it. A car queues for the whole run it is on, so that is everyone
/// on the run who could reach the node before a junction; anyone else
/// wakes at that junction and looks ahead from there.
fn on_street(world: &World, node: EntityId) -> Vec<EntityId> {
    let mut cars: Vec<EntityId> = world.map
        .arms_of(node, false)
        .into_iter()
        .flat_map(|n| [(n, node), (node, n)])
        .filter_map(|e| world.map.edges.get(&e))
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
    matches!(world.map.objects.get(car_id).map(|e| &e.object), Some(GameObject::Car(c))
        if c.trip.as_ref().is_some_and(|t| {
            let backed_out = t.backing.first().is_some_and(|b| b[0] == 0);
            (t.from_lot > 0 && t.route_index <= t.from_lot + backed_out as usize) || (t.to_lot > 0 && t.route_index > t.route.len() - 1 - t.to_lot)
        }))
}

/// Is someone other than this car turning off or onto the street here?
fn held(world: &World, car_id: EntityId, node: EntityId) -> Option<EntityId> {
    world.map.manoeuvres.get(&node).map(|&(o, _)| o).filter(|&o| o != car_id && manoeuvring(world, o))
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
        world.map.manoeuvres.insert(n, (car_id, now));
    }
    wake_round(world, events, nodes, car_id);
}

/// Let go of everything the car holds, and wake whoever waited for it.
fn let_go(world: &mut World, events: &mut EventQueue, car_id: EntityId) {
    let mut nodes: Vec<EntityId> = world.map.manoeuvres.iter().filter(|(_, (c, _))| *c == car_id).map(|(&n, _)| n).collect();
    nodes.sort_unstable();
    for n in &nodes {
        world.map.manoeuvres.remove(n);
    }
    wake_round(world, events, &nodes, car_id);
}

/// Is the street clear for a car to pull out of its lot onto it? Everyone
/// on the street either past the node or far enough off to see the car and
/// stop short of it; one still at its line in a lot of its own is not on
/// the street yet, but one that has pulled out is.
fn gap_at(world: &World, car_id: EntityId, trip: &Trip, now: GameTime) -> bool {
    // Nobody else turning here, nor just ahead on its way: two cars
    // pulling out of doors side by side, each across the other's way,
    // would each stop for the other.
    let nodes = turn_nodes(trip, 0);
    let ahead = &trip.route[trip.from_lot..trip.route.len().min(trip.from_lot + 3)];
    if nodes.iter().chain(ahead).any(|&n| held(world, car_id, n).is_some()) {
        return false;
    }
    nodes.iter().all(|&street| {
        on_street(world, street).into_iter().all(|o| {
            let Some(GameObject::Car(c)) = world.map.objects.get(o).map(|e| &e.object) else { return true };
            let Some(t) = c.trip.as_ref().filter(|_| o != car_id) else { return true };
            if t.from_lot > 0 && t.route_index == 1 && t.progress < START {
                return true;
            }
            let Some(k) = (t.route_index - 1..t.route.len()).find(|&k| t.route[k] == street) else { return true };
            let (p, v) = t.at(now);
            let d = t.along[k] - p;
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
    if nodes.iter().any(|&n| held(world, car_id, n).is_some()) {
        return false;
    }
    let at = trip.route.len() - 1 - trip.to_lot;
    let (node, from) = (trip.route[at], trip.route[at - 1]);
    on_street(world, node).into_iter().all(|o| {
        let Some(GameObject::Car(c)) = world.map.objects.get(o).map(|e| &e.object) else { return true };
        let Some(t) = c.trip.as_ref().filter(|_| o != car_id) else { return true };
        let Some(k) = (t.route_index.max(1)..t.route.len()).find(|&k| t.route[k] == node) else { return true };
        if t.route[k - 1] == from {
            return true;
        }
        let (p, v) = t.at(now);
        let d = t.along[k] - p;
        v < 0.05 || d - nose(c.role) > headway(v, 0.0) + 1.0
    })
}

/// The speed the bend at route[k] allows, if that is less than cruising. A
/// straight node limits nothing, and so is nothing to slow for or wake at.
/// Into a junction off a road without priority, where a car coming in by
/// another way may go on more than one way, so across this one's, and no
/// lights say who goes, no faster than a driver who looks (`LOOK`): only a
/// priority road, lights or a bridge are taken at speed. Not where ways
/// only join, roads into one or lanes into a road of two, nor where they
/// only part: no way crosses there.
fn bend(world: &World, route: &[EntityId], k: usize) -> Option<f64> {
    let mut limit = physics::turn_speed(world.map.turn_cos_angle(route, k));
    if k > 0
        && k + 1 < route.len()
        && let Some(GameObject::RoadNode(n)) = world.map.objects.get(route[k]).map(|e| &e.object)
        && n.outgoing.len() + n.incoming.len() >= 3
        && n.light.is_none()
        && !n.road.contains(&route[k - 1])
        && n.outgoing.iter().chain(&n.incoming).any(|&m| m != route[k - 1] && world.map.edges.contains_key(&(m, route[k])) && n.outgoing.iter().filter(|&&o| o != m).count() >= 2)
    {
        limit = limit.min(LOOK);
    }
    (limit < CRUISE_SPEED - 1e-9).then_some(limit)
}

/// How fast a driver comes into a junction they have no priority at,
/// looking whether anyone comes: under a third of cruising.
const LOOK: f64 = 0.7;

/// How far ahead a car says when it will be at a junction: six seconds at
/// cruising, well over what one pulling out from standing takes to be
/// clear of it, so none pulls out in front of one due there sooner.
const ANNOUNCE: f64 = 6.0 * CRUISE_SPEED;

/// How long a car takes to cover `d` from `v`, speeding up as it may to
/// `top`: its time to a junction, if nothing stops it.
fn eta(d: f64, v: f64, top: f64) -> f64 {
    let (a, top) = (ACCELERATION, top.max(v));
    let spurt = (top * top - v * v) / (2.0 * a);
    if d <= spurt { ((v * v + 2.0 * a * d).sqrt() - v) / a } else { (top - v) / a + (d - spurt) / top }
}

/// When a car going `v` comes to a line `line` ahead, and when it is
/// `clear` ahead, through a bend it takes at no more than `limit`: in
/// seconds from now.
fn through(line: f64, clear: f64, v: f64, limit: f64) -> (f64, f64) {
    let line = line.max(0.0);
    let at_line = (v * v + 2.0 * ACCELERATION * line).sqrt().min(CRUISE_SPEED).min(limit);
    let due = eta(line, v, CRUISE_SPEED);
    (due, due + eta((clear - line).max(0.0), at_line, limit))
}

/// How many nodes ahead a car looks for what it has to slow for — and so how
/// far it may drive before it looks again.
const LOOKAHEAD: usize = 30;

/// How far along the route a car on segment `ri` can drive without thinking:
/// to the first node ahead where the road asks something of it. A junction,
/// where queues change and claims are settled; a bend, whose limit lifts only
/// once the car is past it; a chunk line, so whoever is watching the next
/// chunk sees it arrive. A straight run between those it sleeps through, as
/// far as it looked; where a junction comes near enough to say when it will
/// be there, `book` wakes it.
fn stretch_end(world: &World, car_id: EntityId, trip: &Trip, ri: usize, seg_start: f64) -> f64 {
    let here = world.map.objects.get(car_id).and_then(|e| e.position).map(chunk_of);
    let mut end = seg_start;
    for k in ri..trip.route.len().min(ri + LOOKAHEAD) {
        end += trip.segment_lengths[k];
        let node = trip.route[k];
        let chunk = world.map.objects.get(node).and_then(|e| e.position).map(chunk_of);
        if world.map.network.ends_run(node)
            || world.map.is_intersection(node)
            || bend(world, &trip.route, k).is_some()
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
    let j = world.map.node_pos(junction)?;
    let t = world.map.node_pos(toward)?;
    let (dx, dy) = (t[0] - j[0], t[1] - j[1]);
    let m = dx.abs().max(dy.abs());
    (m > 1e-9).then(|| ((dx / m).round() as i32, (dy / m).round() as i32))
}

/// What a car takes turns at to come to node `k` of its route and go on
/// past it: the junction there; and the crossing on its way to it, half
/// the link before it (`Map::crossing_of`), where the stop line before a
/// junction would be. Each with the way it comes in by and goes out by,
/// its track through, and how far past the node it is through: before it,
/// for a crossing.
#[derive(Clone, Copy)]
struct Gate {
    id: EntityId,
    from: (i32, i32),
    to: (i32, i32),
    track: map::intersection::Track,
    /// How far before the node its track begins.
    start: f64,
    past: f64,
}

impl Gate {
    fn crossing(&self) -> bool {
        self.id >= map::decks::CROSSINGS
    }
}

fn gates(world: &World, trip: &Trip, k: usize) -> [Option<Gate>; 2] {
    let (route, lanes) = (&trip.route, &trip.lanes);
    let mut out = [None; 2];
    if k == 0 || k >= route.len() {
        return out;
    }
    let (prev, at) = (route[k - 1], route[k]);
    if let Some(id) = world.map.crossing_of(prev, at)
        && let (Some(a), Some(b)) = (world.map.node_pos(prev), world.map.node_pos(at))
    {
        // Across the corner, straight, in its lane; seen from the corner.
        let (dx, dy) = ((b[0] - a[0]).signum() as i32, (b[1] - a[1]).signum() as i32);
        let corner = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0].map(f64::round);
        let track = map::intersection::straight([a[0] - corner[0], a[1] - corner[1]], [b[0] - corner[0], b[1] - corner[1]], lane_offset(world, prev, at, lanes[k]));
        let seg = world.map.segment_length(prev, at);
        out[0] = Some(Gate { id, from: (-dx, -dy), to: (dx, dy), track, start: seg, past: -seg / 2.0 });
    }
    if k + 1 < route.len()
        && world.map.is_intersection(at)
        && let (Some(p), Some(j), Some(n)) = (world.map.node_pos(prev), world.map.node_pos(at), world.map.node_pos(route[k + 1]))
        && let (Some(from), Some(to)) = (arm(world, at, prev), arm(world, at, route[k + 1]))
    {
        let track = map::intersection::track(p, j, n, lane_offset(world, prev, at, lanes[k]), lane_offset(world, at, route[k + 1], lanes[k + 1]));
        out[1] = Some(Gate { id: at, from, to, track, start: world.map.segment_length(prev, at) / 2.0, past: 0.0 });
    }
    out
}

/// A wake's gates, each found once: the booking, the cars it follows and
/// the road ahead each look along the same nodes, and the road does not
/// change under a car while it thinks. Not kept past the wake: a junction
/// may be built on its way before it next looks.
struct Gates(std::cell::RefCell<Vec<Option<[Option<Gate>; 2]>>>);

impl Gates {
    fn new(trip: &Trip) -> Self {
        Gates(std::cell::RefCell::new(vec![None; trip.route.len()]))
    }

    fn at(&self, world: &World, trip: &Trip, k: usize) -> impl Iterator<Item = Gate> + use<> {
        let mut memo = self.0.borrow_mut();
        let found = match memo.get_mut(k) {
            Some(m) => *m.get_or_insert_with(|| gates(world, trip, k)),
            None => [None; 2],
        };
        found.into_iter().flatten()
    }
}

/// Where a car's lane on the link from `a` to `b` runs, from the road's
/// middle to the right of the way it is driven, as the client draws it
/// (`motion.ts`'s `lanesOf`): a road both ways, its right; a road of two
/// one way, the right lane or the left; a one-way, its middle.
fn lane_offset(world: &World, a: EntityId, b: EntityId, lane: u8) -> f64 {
    match world.map.edges.get(&(a, b)) {
        Some(s) if s.lanes > 1 => if lane == 0 { LANE_OFFSET } else { -LANE_OFFSET },
        _ if world.map.edges.contains_key(&(b, a)) => LANE_OFFSET,
        _ => 0.0,
    }
}

/// A junction's arms, if it has lights: the way to each neighbour.
fn light_arms(world: &World, junction: EntityId) -> Option<Vec<(i32, i32)>> {
    let Some(GameObject::RoadNode(n)) = world.map.objects.get(junction).map(|e| &e.object) else { return None };
    n.light?;
    let mut arms: Vec<(i32, i32)> = world.map.arms_of(junction, false).into_iter().filter_map(|a| arm(world, junction, a)).collect();
    arms.sort_unstable();
    arms.dedup();
    Some(arms)
}

/// A junction's lights look again (`IntersectionManager::tick`): set up
/// as its arms now are, or taken away; whoever the green lets through
/// woken; the phase shown; and the next look, while anyone is there.
pub fn lights(world: &mut World, events: &mut EventQueue, junction: EntityId, now: GameTime) {
    let arms = light_arms(world, junction);
    let manager = world.map.streets.get_or_create(junction);
    manager.set_signal(arms.as_deref(), now);
    let (woken, next) = manager.tick(now);
    let shown = manager.signal().map(|s| if s.clearing() { model::ALL_RED } else { s.phase as u8 });
    for car in woken {
        events.wake(0, car);
    }
    if let Some(GameObject::RoadNode(n)) = world.map.objects.get(junction).map(|e| &e.object)
        && n.light.is_some()
        && n.light != shown
        && let Some(GameObject::RoadNode(n)) = world.map.objects.get_mut(junction).map(|e| &mut e.object)
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
    car_id: EntityId,
    trip: &Trip,
    role: CarRole,
    edge: EdgeKey,
    cur_progress: f64,
    lead_id: EntityId,
    now: GameTime,
) -> Option<Obstacle> {
    let entry = world.map.objects.get(lead_id)?;
    let GameObject::Car(ref lead) = entry.object else {
        return None;
    };
    let lead_role = lead.role;
    let lead = lead.trip.as_ref()?;

    // Both cars must be on this edge — find where it starts along each route.
    let my_seg_start = trip.start_of(edge)?;
    let lead_seg_start = lead.start_of(edge)?;

    let (lead_progress, lead_speed) = lead.at(now);

    let my_pos = cur_progress - my_seg_start;
    let lead_pos = lead_progress - lead_seg_start;

    let gap = lead_pos - my_pos;
    if gap <= 0.0 {
        return None;
    }

    // Too near one ahead of it on the road it is on, in its own lane, it
    // drops back: a merge can leave two so, and they kept it. One not yet
    // there with it (on another road, beside it in the other lane, or
    // changing lanes), bound for one lane with it, falls in behind by
    // where they meet, as the merge has it, not at once.
    let room = gap - MIN_GAP - nose(role) - tail(lead_role);
    let on = (lead.route[lead.route_index - 1], lead.route[lead.route_index]);
    let here = (1..trip.route.len()).find(|&i| (trip.route[i - 1], trip.route[i]) == on).is_some_and(|i| {
        let start = trip.along[i - 1];
        start <= cur_progress && cur_progress < start + trip.segment_lengths[i]
    });
    let changing = |t: &Trip| t.shift.is_some_and(|s| s.from != s.to);
    let in_line = here
        && !changing(trip)
        && !changing(lead)
        && world.map.edges.get(&on).is_some_and(|s| (0..2).any(|l| s.in_lane(car_id, l) && s.in_lane(lead_id, l)));
    Some(if in_line { following(room, lead_speed, lead.acceleration) } else { Obstacle::LeadCar { distance: room.max(0.0), speed: lead_speed, accel: lead.acceleration } })
}

/// Following a car, `room` short of the gap kept behind it: inside that
/// gap, which a merge can leave it, it drops back, the more the nearer. It
/// only kept the speed ahead, and two came out of a merge into one another
/// and stayed there.
fn following(room: f64, speed: f64, accel: f64) -> Obstacle {
    if room >= 0.0 {
        Obstacle::LeadCar { distance: room, speed, accel }
    } else {
        Obstacle::LeadCar { distance: 0.0, speed: (speed + 0.25 * room).max(0.0), accel: accel.min(0.0) }
    }
}

/// A car queued ahead of this one on a road of two further on, that is
/// on a road of two on this one's way, in neither lane this one drives in
/// there: on its own stretch the lanes it drives in now (`mine`; one
/// changing lanes stands in both), past a junction the lane it comes out
/// in: queued there
/// first, it has yet to get into this car's lane, which is for the
/// changing of lanes to settle (`change_lanes`, and whoever lets it in),
/// not a car to follow. Followed, beside or just ahead, it stopped this
/// car where it stood, and with it the room it waited for.
fn getting_in(world: &World, trip: &Trip, ri: usize, edge: EdgeKey, mine: &[usize], lead: EntityId) -> bool {
    let Some(GameObject::Car(c)) = world.map.objects.get(lead).map(|e| &e.object) else { return false };
    let Some(t) = c.trip.as_ref() else { return false };
    let on = (t.route[t.route_index - 1], t.route[t.route_index]);
    let Some(k) = (ri..trip.route.len()).find(|&k| (trip.route[k - 1], trip.route[k]) == on) else { return false };
    // This car's lane there: where it drives now, on its stretch; past a
    // junction, the one it comes out of it in.
    let there = if one_stretch(world, &trip.route, ri, k) { mine.to_vec() } else { vec![trip.lanes[k] as usize] };
    // Onto a road of one, only one signalling to change lanes for it: the
    // rest are two lanes becoming one, which the first through takes.
    (world.map.edges.get(&edge).is_some_and(|s| s.lanes > 1) || t.signal.is_some()) && world.map.edges.get(&on).is_some_and(|seg| seg.lanes > 1 && !there.iter().any(|&l| seg.in_lane(lead, l)))
}

/// Whether two edges of a route, by index, are on one stretch of it: no
/// junction between them, out of which a car may come in another lane than
/// it went in.
fn one_stretch(world: &World, route: &[EntityId], a: usize, b: usize) -> bool {
    (a.min(b)..a.max(b)).all(|j| !world.map.network.ends_run(route[j]))
}

/// The lane a car means to be in on an edge of its way.
fn lane_on(world: &World, car: EntityId, edge: EdgeKey) -> Option<usize> {
    let Some(GameObject::Car(c)) = world.map.objects.get(car).map(|e| &e.object) else { return None };
    let t = c.trip.as_ref()?;
    (1..t.route.len()).find(|&j| (t.route[j - 1], t.route[j]) == edge).map(|j| t.lanes[j] as usize)
}

/// The lane a car signals for (`Trip::signal`), if it does.
fn signalling(world: &World, car: EntityId) -> Option<u8> {
    match world.map.objects.get(car).map(|e| &e.object) {
        Some(GameObject::Car(c)) => c.trip.as_ref()?.signal,
        _ => None,
    }
}

/// Where a car `p` along its trip stands in the street's queues: on its
/// way out of a lot, at the street node.
fn queued_at(t: &Trip, p: f64) -> f64 {
    if t.from_lot > 0 && t.route_index <= t.from_lot + 1 { p.max(t.along[t.from_lot]) } else { p }
}

/// Where a car is as it wakes, caught up to now: the node it drives to
/// (`ri`), where along its route the edge to it starts, how far it has
/// come and how fast it goes. Each part of its look ahead reads this.
#[derive(Clone, Copy)]
struct Here {
    car_id: EntityId,
    role: CarRole,
    now: GameTime,
    ri: usize,
    seg_start: f64,
    progress: f64,
    speed: f64,
}

/// A car wakes: it drives on to now, takes its place in the queues, and
/// looks ahead, then sets its pedal by whatever asks the most of it and
/// sleeps until something might change that.
pub fn handle_car_wake_up(
    world: &mut World,
    events: &mut EventQueue,
    car_id: EntityId,
    now: GameTime,
) {
    let (role, mut trip) = match world.map.objects.get(car_id) {
        Some(entry) => match &entry.object {
            // A parked car has nothing to think about — unless it is a
            // vehicle on a call, which has finished unloading.
            GameObject::Car(c) => match c.trip.clone() {
                Some(t) => (c.role, t),
                None => {
                    crate::calls::car_idle(world, events, car_id, now);
                    return;
                }
            },
            _ => return,
        },
        None => return,
    };
    let Some(h) = advance(world, events, role, &mut trip, car_id, now) else { return };
    let (waiting, turning_in) = lots(world, events, &h, &trip);
    let (mut held, tail_clears) = clear_behind(world, events, &h, &trip);
    // Its nose at the crossing on the link it is on, if there is one, or
    // past it: through it, nothing there stops it any more.
    let reached = h.progress + nose(role) >= h.seg_start + 0.5 * trip.segment_lengths[h.ri];
    let (slotting, lanes_changed) = lanes(world, events, &h, &mut trip, waiting);
    let gates = Gates::new(&trip);
    // Waiting at its line out of a lot, it is going nowhere yet: a claim
    // on the way ahead would hold up the street it waits for a gap in.
    let look = if waiting { None } else { book(world, events, &h, &trip, &gates, &mut held) };
    // Whatever else it held, it no longer asks for.
    for woken_id in world.map.streets.keep(car_id, &held, now) {
        events.wake(0, woken_id);
    }

    // Queue for the run beyond the gates once passage through them is
    // granted; and out of it again, passage given back, or whoever comes
    // through behind it would queue behind a car that is not there.
    if h.ri + 1 < trip.route.len() {
        if gates.at(world, &trip, h.ri).filter(|g| !g.crossing() || !reached).all(|g| world.map.streets.has_passage(g.id, car_id)) {
            join_run(world, car_id, &trip, h.ri + 1, h.progress, now, !waiting);
        } else {
            for k in h.ri + 1..trip.route.len() {
                match world.map.edges.get_mut(&(trip.route[k - 1], trip.route[k])) {
                    Some(s) if s.contains(car_id) => s.remove(car_id),
                    _ => break,
                }
            }
        }
    }

    let mut obstacles = leads(world, &h, &trip, &gates);
    let (road, standing) = road_ahead(world, &h, &trip, &gates, reached, waiting, turning_in);
    obstacles.extend(road);
    obstacles.extend(slotting.iter().copied());
    // Waiting for a gap: look again soon. Waiting for someone else to turn
    // needs no looking: they wake whoever is coming once they are clear.
    let soon = waiting || turning_in || !slotting.is_empty();
    settle(world, events, &h, &trip, &obstacles, soon, standing, [tail_clears, look], lanes_changed);
}

/// Drive on to now: over each node the car has passed since it last
/// looked, clearing the junctions behind it, timing the runs it finished,
/// and parking it where its trip ends. Where it is now, unless parked.
fn advance(world: &mut World, events: &mut EventQueue, role: CarRole, trip: &mut Trip, car_id: EntityId, now: GameTime) -> Option<Here> {
    // === ADVANCE ===
    let (cur_progress, cur_speed) = trip.at(now);

    let mut ri = trip.route_index;
    let mut seg_start = trip.along[ri - 1];
    let old_ri = ri;
    let (mut standing, mut joined) = (trip.standing, trip.joined);

    let stops_at = |k: usize| stops_at(world, trip, k);
    let gear = |k: usize| gear(trip, k);
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
            standing = Some(now + CUSP_MS);
        }

        let node = trip.route[ri];

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
        if world.map.network.ends_run(node) {
            let crossed_at = physics::time_to_reach(
                trip.progress,
                trip.speed,
                trip.acceleration,
                seg_start + seg_len,
            )
            .map_or(now, |t| trip.updated_at + (t * 1000.0) as u64);

            if let Some((entered, first, at)) = joined
                && entered != node
                && crossed_at > at
            {
                world.map.network.observe_passage(entered, first, (crossed_at - at) as f64);
            }
            if let Some(&onward) = trip.route.get(ri + 1) {
                joined = Some((node, onward, crossed_at));
            }
        }

        if ri + 1 >= trip.route.len() {
            // Journey's end: the driver steps out, the car stays. A vehicle
            // on a call unloads, and thinks again when it is done. The
            // stretches crossed on the way here are left like any others,
            // or the car would stay on their queues as a ghost.
            leave_crossed(world, events, car_id, &trip, old_ri, ri);
            park_car(world, events, car_id, trip.destination);
            // A lorry or a van stands for the forklift, as long as what it
            // lifts takes (`Map::lift`).
            if matches!(role, CarRole::Truck | CarRole::Van) {
                events.wake(0, car_id);
            } else if role != CarRole::Private {
                events.wake(crate::calls::SERVICE_MS, car_id);
            }
            return None;
        }
        seg_start += seg_len;
        ri += 1;
    }
    (trip.standing, trip.joined) = (standing, joined);

    leave_crossed(world, events, car_id, trip, old_ri, ri);
    // Through a junction: in the lane's queue beyond it where it is on the
    // road, not where it was when it queued.
    if (old_ri..ri).any(|k| world.map.is_intersection(trip.route[k])) {
        requeue(world, car_id, trip, ri, cur_progress, now);
    }
    Some(Here { car_id, role, now, ri, seg_start, progress: cur_progress, speed: cur_speed })
}

/// Where the gear changes on a trip: the vehicle stops on that node.
fn gear(trip: &Trip, k: usize) -> bool {
    k + 1 < trip.route.len() && trip.backing.iter().any(|&[a, b]| (a == k && k > 0) || b == k)
}

/// Where a vehicle stops on a node of its trip: where the gear changes,
/// and at its end, unless it drives off the map there.
fn stops_at(world: &World, trip: &Trip, k: usize) -> bool {
    // A trip to a road rather than a building ends off the map: it drives
    // off the end of its road and is gone, rather than pulling up there.
    let drives_off = matches!(world.map.objects.get(trip.destination).map(|e| &e.object), Some(GameObject::RoadNode(_)));
    gear(trip, k) || (k + 1 == trip.route.len() && !drives_off)
}

/// In and out of lots: where it waits at its give-way line to pull out,
/// and where it waits to turn in across the street. Whether it waits to
/// pull out, and whether to turn in.
fn lots(world: &mut World, events: &mut EventQueue, h: &Here, trip: &Trip) -> (bool, bool) {
    let Here { car_id, now, ri, progress: cur_progress, speed: cur_speed, .. } = *h;
    // Out of a lot: a give-way line where it stands. There it waits for a
    // gap; with one it pulls out, and the street waits for it until it is
    // in its lane.
    let street = trip.route[trip.from_lot];
    // A hold kept standing still is let go after a while, as a claim on a
    // junction is: whatever it waits for may be waiting for it. One kept
    // past where the car turns is let go at once.
    let held_since = world.map.manoeuvres.values().filter(|&&(c, _)| c == car_id).map(|&(_, t)| t).min();
    let mut lapsed = false;
    if let Some(since) = held_since {
        if !manoeuvring(world, car_id) {
            let_go(world, events, car_id);
        } else if cur_speed > 0.01 {
            for (c, t) in world.map.manoeuvres.values_mut() {
                if *c == car_id {
                    *t = now;
                }
            }
        } else if now >= since + map::intersection::PATIENCE {
            let_go(world, events, car_id);
            lapsed = true;
        }
    }
    // Only before it has moved: one already on its way out, its hold
    // lapsed, carries on rather than stand in the road.
    let mut waiting = trip.from_lot > 0 && ri == 1 && cur_progress < START && world.map.manoeuvres.get(&street).is_none_or(|&(o, _)| o != car_id);
    // Only the car at the head of the queue out of its lot takes the
    // street: one behind another, holding it, would stop the one ahead,
    // which waits for it (settlers off a ferry, one up the lane after
    // another).
    let first_out = (1..=trip.from_lot).all(|k| world.map.edges.get(&(trip.route[k - 1], trip.route[k])).and_then(|q| q.car_position(car_id)).is_none_or(|i| i == 0));
    if waiting && first_out && gap_at(world, car_id, trip, now) {
        hold(world, events, car_id, &turn_nodes(trip, 0), now);
        waiting = false;
    }
    join_run(world, car_id, trip, ri, cur_progress, now, !waiting);

    // Into a lot: it turns off the street when nobody is coming the other
    // way, and from there holds where it does until it is parked, so
    // whoever comes along waits while it is still in the road.
    let turn_in = trip.route.len() - 1 - trip.to_lot;
    let holding_in = trip.to_lot > 0 && world.map.manoeuvres.get(&trip.route[turn_in]).is_some_and(|&(o, _)| o == car_id);
    let mut turning_in = false;
    // Not again on the wake it let go: whoever it woke goes first.
    if trip.to_lot > 0 && !holding_in && !lapsed {
        let nodes = turn_nodes(trip, 1);
        // Only the car at the head of the queue all the way into its lot:
        // one behind another holding the street would stop the one ahead,
        // which it waits for.
        let first = || (ri..=turn_in + 1).all(|k| world.map.edges.get(&(trip.route[k - 1], trip.route[k])).and_then(|q| q.car_position(car_id)).is_none_or(|i| i == 0));
        if ri == turn_in && first() && !clear_to_turn_in(world, car_id, trip, now) {
            turning_in = true;
        } else if ri > turn_in && !nodes.iter().any(|&n| held(world, car_id, n).is_some()) {
            hold(world, events, car_id, &nodes, now);
        }
    }
    (waiting, turning_in)
}

/// Let go of the junctions its tail is through. Those it is still in, and
/// where along its route the next of them clears, if any.
fn clear_behind(world: &mut World, events: &mut EventQueue, h: &Here, trip: &Trip) -> (Vec<EntityId>, Option<f64>) {
    let Here { car_id, role, now, ri, seg_start, progress: cur_progress, speed: cur_speed } = *h;
    // A car holds a junction until its tail is through it, not until its
    // nose is: the car behind is let into the node only once this one has
    // actually left it. The last few nodes passed are the ones that can
    // still be under the tail; the next to clear sets a wake.
    let (mut tail_clears, mut still_in): (Option<f64>, Vec<EntityId>) = (None, Vec::new());
    // From the node ahead, whose crossing, if it has one, the car may be
    // past already; its junction it is not.
    let mut node_dist = seg_start + trip.segment_lengths[ri];
    for k in (1..=ri).rev().take(5) {
        for g in gates(world, trip, k).into_iter().flatten().filter(|g| k < ri || g.crossing()) {
            if cur_progress - node_dist >= g.past + tail(role) {
                for woken_id in world.map.streets.clear_car(g.id, car_id, now) {
                    events.wake(0, woken_id);
                }
            } else {
                let clears = node_dist + g.past + tail(role);
                tail_clears = Some(tail_clears.map_or(clears, |t: f64| t.min(clears)));
                still_in.push(g.id);
                // Standing with its tail in the box: after a few seconds it
                // waves the others through, as it would at the line.
                if cur_speed < 0.01 {
                    for woken_id in world.map.streets.lapse(g.id, car_id, now) {
                        events.wake(0, woken_id);
                    }
                }
            }
        }
        node_dist -= trip.segment_lengths[k];
    }
    (still_in, tail_clears)
}

/// Change lanes where it wants to (`change_lanes`). The holds that asks
/// for, and whether its lanes changed.
fn lanes(world: &mut World, events: &mut EventQueue, h: &Here, trip: &mut Trip, waiting: bool) -> (Vec<(Obstacle, Cause)>, bool) {
    let Here { car_id, role, now, ri, progress: cur_progress, speed: cur_speed, .. } = *h;
    let lanes_were = (trip.lanes.clone(), trip.shift, trip.signal);
    let mut slotting = Vec::new();
    trip.signal = None;
    if !waiting && !manoeuvring(world, car_id) {
        slotting = change_lanes(world, events, car_id, role, trip, ri, cur_progress, cur_speed, now);
    }
    let lanes_changed = (trip.lanes.clone(), trip.shift, trip.signal) != lanes_were;
    (slotting, lanes_changed)
}

/// Say when it will be at each gate within `ANNOUNCE` of its line, and
/// when it would be clear of it; whoever goes first there is the
/// junction's to say (`IntersectionManager`). Not by nodes, so a car on a
/// priority road coming fast is known from far enough that none pulls out
/// in front of it. Beyond a gate it has no passage at, it holds nothing.
/// Where along its route the next gate comes within that, to look again
/// there.
fn book(world: &mut World, events: &mut EventQueue, h: &Here, trip: &Trip, gates: &Gates, held: &mut Vec<EntityId>) -> Option<f64> {
    let Here { car_id, role, now, ri, seg_start, progress: cur_progress, speed: cur_speed } = *h;
    let ms = |s: f64| now + (s * 1000.0) as GameTime;
    // Not yet in the lane its way out ahead asks for, it does not know its
    // way through there yet: a claim from the lane it is leaving would hold
    // up the lane it waits to get into.
    let getting_in = not_in_lane(world, car_id, role, trip, ri, cur_progress, cur_speed, now).map(|(_, d)| d);
    // Whoever is just ahead of it in its lane, on its way to a gate, goes
    // through it before it: queued with it on a stretch, the one ahead
    // there; else the last into its lane on the next.
    let after = |k: usize| {
        (ri..=k).find_map(|j| {
            let edge = (trip.route[j - 1], trip.route[j]);
            let s = world.map.edges.get(&edge)?;
            let a = if s.contains(car_id) { s.ahead(car_id).first().copied() } else { s.back(trip.lanes[j] as usize) }?;
            // Ahead of it on the road, not only in a queue that has them
            // the other way about on another stretch; each measured alike,
            // one still in its lot at the lot's mouth.
            let mine = queued_at(trip, cur_progress) - trip.start_of(edge)?;
            position_on(world, a, edge, now).is_some_and(|p| p > mine).then_some(a)
        })
    };
    // Each junction it would claim, and how far on it is clear of it.
    let mut wants = Vec::new();
    let mut to_k = seg_start - cur_progress;
    let next = 'scan: {
        for k in ri..trip.route.len() {
            to_k += trip.segment_lengths[k];
            let line_at = |k: usize, to_k: f64| to_k - trip.segment_lengths[k] / 2.0 - nose(role) - INTERSECTION_STOP_MARGIN;
            let line = line_at(k, to_k);
            if getting_in.is_some_and(|d| to_k >= d - 1e-6) {
                break 'scan None;
            }
            if k > ri && line > ANNOUNCE {
                // The next junction on, to look again where it comes near.
                let mut to_j = to_k;
                for j in k..trip.route.len().min(k + LOOKAHEAD) {
                    to_j += if j > k { trip.segment_lengths[j] } else { 0.0 };
                    if gates.at(world, trip, j).any(|g| !g.crossing()) {
                        break 'scan Some(cur_progress + line_at(j, to_j) - ANNOUNCE);
                    }
                }
                break 'scan None;
            }
            // A crossing only from the link before it on: everyone crosses
            // everyone there, and one claimed from further off is held all
            // that way. None its tail is through already (`clear_behind`).
            for g in gates.at(world, trip, k).filter(|g| (k <= ri + 1 || !g.crossing()) && to_k + g.past + tail(role) > 0.0) {
                let limit = bend(world, &trip.route, k).unwrap_or(CRUISE_SPEED);
                let due = through(line, line, cur_speed, limit).0;
                // When its nose comes to each point of its track, and its
                // tail is past it: along the track from where it begins, as
                // fast as it may go there.
                let time = |d: f64| ms(if d <= line { eta(d.max(0.0), cur_speed, CRUISE_SPEED) } else { through(line, d, cur_speed, limit).1 });
                let t = g.track;
                let mut along = [0.0; TRACK_POINTS];
                for i in 1..TRACK_POINTS {
                    along[i] = along[i - 1] + ((t[i][0] - t[i - 1][0]) as f64).hypot((t[i][1] - t[i - 1][1]) as f64);
                }
                let begins = to_k - g.start;
                let claim = map::intersection::Claim {
                    from: g.from,
                    to: g.to,
                    track: Some(g.track),
                    major: world.map.is_road_between(trip.route[k - 1], trip.route[k]),
                    due: ms(due),
                    nose: along.map(|s| time(begins + s - nose(role))),
                    tail: along.map(|s| time(begins + s + tail(role))),
                    // Standing, it can stop anywhere short of the junction
                    // itself: crept over its line behind the car ahead, it
                    // still gives way (replays/four-roundabouts-waiting.json).
                    committed: if cur_speed < 0.01 { line + INTERSECTION_STOP_MARGIN <= 0.0 } else { physics::braking_distance(cur_speed, 0.0) >= line },
                    after: after(k),
                };
                wants.push((k, line, to_k + g.past + tail(role), g, claim));
            }
        }
        None
    };
    // In order. It is let through no junction while it waits at another:
    // past one it is not let through, or in one it would stop in, at the
    // line of the next, it is out of a junction only when the one it waits
    // at lets it go, which is not yet known. Those it waits behind see it
    // coming, but it holds none: holding them, it held each against
    // everyone it waited on in turn, round a ring for good. Junctions it
    // would stop between, each in the line of the next, are one: it waits
    // for none of them but the furthest, and is let into the nearer as
    // that one lets it go.
    let waits = |i: usize, streets: &IntersectionRegistry| {
        let (k, _, out, _, claim) = &wants[i];
        let joined = (0..i).rev().take_while(|&m| wants[m].2 > wants[m + 1].1).count();
        !claim.committed
            && (wants[..i - joined].iter().any(|w| !streets.has_passage(w.3.id, car_id))
                || wants[i + 1..].iter().any(|(j, line, _, h, _)| j > k && line < out && !streets.has_passage(h.id, car_id)))
    };
    let mut waiting = Vec::new();
    for made in 0..wants.len() {
        let (k, _, _, ref g, mut claim) = wants[made];
        // Still behind a give-way line short of it, it is not on the
        // priority road yet, and comes to the next junction as anyone does.
        claim.major &= !wants[..made].iter().any(|w| !w.4.major && !world.map.streets.has_passage(w.3.id, car_id));
        if waits(made, &world.map.streets) {
            waiting.push(made);
            claim.tail = [GameTime::MAX; TRACK_POINTS];
        }
        let lit = light_arms(world, g.id);
        let new = !world.map.streets.knows(g.id, car_id);
        if lit.is_some() {
            world.map.streets.get_or_create(g.id).set_signal(lit.as_deref(), now);
            events.wake(map::intersection::SIGNAL_TICK, g.id);
        }
        held.push(g.id);
        for woken_id in world.map.streets.claim(g.id, car_id, claim, now) {
            if woken_id != car_id {
                events.wake(0, woken_id);
            }
        }
        // In from the side onto a road of two, a merge, which those
        // coming along it may make room for.
        if new && !g.crossing() && g.from != (-g.to.0, -g.to.1) && world.map.edges.get(&(trip.route[k], trip.route[k + 1])).is_some_and(|s| s.lanes > 1) {
            wake_round(world, events, &[g.id], car_id);
        }
        // Holding the junction and going nowhere: after a few seconds
        // of that, wave the others through and queue again. Standing
        // is a crawl under a hundredth of a tile a second, since a
        // car held at a gap never quite reads zero.
        if cur_speed < 0.01 {
            for woken_id in world.map.streets.lapse(g.id, car_id, now) {
                events.wake(0, woken_id);
            }
        }
    }
    // Let through where it waited after all, it says when it will be out
    // of each it no longer waits for, as far as that lets it.
    while let Some(i) = waiting.iter().position(|&i| !waits(i, &world.map.streets)) {
        let i = waiting.remove(i);
        for woken_id in world.map.streets.claim(wants[i].3.id, car_id, wants[i].4, now) {
            if woken_id != car_id {
                events.wake(0, woken_id);
            }
        }
    }
    next
}

/// The cars it follows: ahead of it in its lanes, along its way as far as
/// it is queued, and those it lets in from the other lane.
fn leads(world: &World, h: &Here, trip: &Trip, gates: &Gates) -> Vec<(Obstacle, Cause)> {
    let Here { car_id, role, now, ri, progress: cur_progress, speed: cur_speed, .. } = *h;
    let current_edge: EdgeKey = (trip.route[ri - 1], trip.route[ri]);
    let mut obstacles = Vec::<(Obstacle, Cause)>::new();
    // The car ahead, in each lane it stands in: two while it changes.
    for lead_id in world.map.edges.get(&current_edge).map_or_else(Vec::new, |s| s.ahead(car_id)) {
        obstacles.extend(lead_car_obstacle(world, car_id, trip, role, current_edge, cur_progress, lead_id, now).map(|o| (o, Cause::Ahead(lead_id))));
    }
    // A car ahead in the other lane, signalling for this car's: let in,
    // where this car can drop back for it without braking hard; looked for
    // as far as a car stops from cruising.
    for k in ri..trip.route.len() {
        if trip.along[k - 1] - cur_progress > COURTESY {
            break;
        }
        // Along its way, queued there yet or not: one that looked only as
        // far as it had passage saw a car waiting past a junction too late
        // to drop back for it.
        let edge: EdgeKey = (trip.route[k - 1], trip.route[k]);
        let Some(seg) = world.map.edges.get(&edge).filter(|s| s.lanes > 1) else { break };
        let mine = trip.lanes[k];
        for o in seg.lane(1 - mine as usize).filter(|&o| o != car_id && signalling(world, o) == Some(mine)) {
            let Some(GameObject::Car(c)) = world.map.objects.get(o).map(|e| &e.object) else { continue };
            let (Some(t), Some(mine_at)) = (c.trip.as_ref(), trip.start_of(edge)) else { continue };
            let Some(its_at) = t.start_of(edge) else { continue };
            let (q, vo) = t.at(now);
            // Dropping back to the gap it needs to cut in (`headway`, as
            // `room` asks), and a little more; not for one it is inside
            // that already, or could only leave braking hard.
            let room = (q - its_at) - (cur_progress - mine_at) - nose(role) - tail(c.role) - MIN_GAP - cur_speed * REACTION - 0.1;
            if room >= -0.05 && physics::braking_distance(cur_speed, vo) <= room + 0.05 {
                obstacles.push((Obstacle::LeadCar { distance: room.max(0.0), speed: vo, accel: t.acceleration }, Cause::LettingIn(o)));
            }
        }
    }
    // Also the next edge: it may be queued there already, behind one that
    // came from another lane or road, whose distance to the road out
    // against its own is the gap to keep.
    // The lanes it drives in now: where it is queued further on is where
    // it means to be, which a car still to change lanes is not yet.
    let mine: Vec<usize> = (0..2).filter(|&l| world.map.edges.get(&current_edge).is_some_and(|s| s.in_lane(car_id, l))).collect();
    // And further, wherever ahead it is queued already, the nearest car
    // ahead there: on a long straight with nobody on the next tile, a car
    // that looked no further would sleep its way into a queue standing a
    // few tiles on, or into one that merged in front of it.
    for k in ri + 2..trip.route.len() {
        let edge: EdgeKey = (trip.route[k - 1], trip.route[k]);
        let Some(seg) = world.map.edges.get(&edge).filter(|s| s.contains(car_id)) else { break };
        let leads = seg.ahead_but(car_id, |_, l| getting_in(world, trip, ri, edge, &mine, l));
        for &lead_id in &leads {
            obstacles.extend(lead_car_obstacle(world, car_id, trip, role, edge, cur_progress, lead_id, now).map(|o| (o, Cause::Ahead(lead_id))));
        }
        if !leads.is_empty() {
            break;
        }
    }
    if ri + 1 < trip.route.len() {
        let next_edge: EdgeKey = (trip.route[ri], trip.route[ri + 1]);
        for lead_id in world.map.edges.get(&next_edge).map_or_else(Vec::new, |s| s.ahead_but(car_id, |_, l| getting_in(world, trip, ri, next_edge, &mine, l))) {
            obstacles.extend(lead_car_obstacle(world, car_id, trip, role, next_edge, cur_progress, lead_id, now).map(|o| (o, Cause::Ahead(lead_id))));
        }
    }
    // And at each junction it is let through, whoever else is let into its
    // lane there from another way (`IntersectionManager::merging`): it
    // follows one ahead of it in as if both were on the road out already.
    'gates: for k in ri..trip.route.len().saturating_sub(1).min(ri + LOOKAHEAD) {
        for g in gates.at(world, trip, k).filter(|g| !g.crossing()) {
            if !world.map.streets.has_passage(g.id, car_id) {
                break 'gates;
            }
            let out = (trip.route[k], trip.route[k + 1]);
            let Some(mine) = trip.start_of(out).map(|s| cur_progress - s) else { continue };
            for l in world.map.streets.merging(g.id, car_id) {
                if position_on(world, l, out, now).is_some_and(|p| p > mine) {
                    // The gap is wanted at the merge, not yet: short of it, it
                    // drops back over the way there, braking as it would for
                    // a stop, not at once.
                    let ease = |o: Obstacle| match o {
                        Obstacle::LeadCar { distance, speed, accel } => {
                            let enough = physics::braking_distance(cur_speed, speed).min(distance + (-mine).max(0.0));
                            Obstacle::LeadCar { distance: distance.max(enough), speed, accel }
                        }
                        o => o,
                    };
                    obstacles.extend(lead_car_obstacle(world, car_id, trip, role, out, cur_progress, l, now).map(|o| (ease(o), Cause::Merging(l))));
                }
            }
        }
    }
    obstacles
}

/// What the road ahead asks of it: bends, stops, lots, the junctions it
/// has no passage at, and its own lines. Those, and how long it stands
/// still at a change of gear, if it does.
fn road_ahead(world: &World, h: &Here, trip: &Trip, gates: &Gates, reached: bool, waiting: bool, turning_in: bool) -> (Vec<(Obstacle, Cause)>, Option<GameTime>) {
    let Here { car_id, role, now, ri, seg_start, progress: cur_progress, .. } = *h;
    let remaining = trip.segment_lengths[ri] - (cur_progress - seg_start);
    let mut obstacles = Vec::<(Obstacle, Cause)>::new();
    let backs = trip.backing.clone();
    // SpeedLimit at approaching node route[ri]
    //
    // The bend is rounded, so it begins half an edge back from the node — and
    // it does not end there either. Dropping the limit once the car reaches
    // the start of the bend let it brake correctly to the turn speed and then
    // accelerate straight through the corner, arriving at the node at twice
    // what the corner allows. Held to zero instead, so it carries the speed it
    // slowed to through the turn rather than only up to it.
    let entry_ri = remaining - 0.5 * trip.segment_lengths[ri] - nose(role);
    let line_ri = (entry_ri - INTERSECTION_STOP_MARGIN).max(0.0);
    // Backing, a walking pace; in a lot, a crawl, on any edge that ends at a
    // lot node, from its start. Where the gear changes, and at the end, a
    // stop on the node; at a change of gear, a moment standing.
    let backing = |k: usize| backs.iter().any(|&[a, b]| a < k && k <= b);
    let standing = trip.standing.filter(|&until| now < until).map(|until| until - now);
    if standing.is_some() {
        obstacles.push((Obstacle::MustStop { distance: 0.0 }, Cause::Stop));
    }
    if backing(ri) {
        obstacles.push((Obstacle::SpeedLimit { distance: 0.0, speed: REVERSE_SPEED }, Cause::Slow));
    } else if world.map.lot_nodes.contains_key(&trip.route[ri]) {
        obstacles.push((Obstacle::SpeedLimit { distance: 0.0, speed: LOT_SPEED }, Cause::Slow));
    }
    if stops_at(world, trip, ri) {
        obstacles.push((Obstacle::Halt { distance: remaining }, Cause::Stop));
    }
    // At its own give-way line, with no gap yet; or about to turn in
    // across the oncoming lane, with somebody coming.
    if waiting {
        obstacles.push((Obstacle::MustStop { distance: 0.0 }, Cause::Line));
    }
    if turning_in {
        obstacles.push((Obstacle::MustStop { distance: line_ri }, Cause::TurningIn));
    }
    // A car turning off or onto the street ahead: stop short of it.
    let mut turn_ahead = false;
    if let Some(limit) = bend(world, &trip.route, ri) {
        obstacles.push((Obstacle::SpeedLimit { distance: entry_ri.max(0.0), speed: limit }, Cause::Bend));
    }
    // Held to the stop line the same way, and for the same reason: dropping it
    // once the car reached the line meant a car in the last half edge before a
    // junction it has no claim on had nothing left telling it to wait.
    if let Some(g) = gates.at(world, trip, ri).filter(|g| !g.crossing() || !reached).find(|g| !world.map.streets.has_passage(g.id, car_id)) {
        obstacles.push((Obstacle::MustStop { distance: line_ri }, Cause::Junction(g.id)));
    }
    if let Some(holder) = held(world, car_id, trip.route[ri]) {
        obstacles.push((Obstacle::MustStop { distance: line_ri }, Cause::Turn(holder)));
        turn_ahead = true;
    }

    // Scan forward nodes
    let mut node_dist = remaining;
    for k in (ri + 1)..trip.route.len().min(ri + LOOKAHEAD) {
        node_dist += trip.segment_lengths[k];
        let entry_k = node_dist - 0.5 * trip.segment_lengths[k] - nose(role);
        let line_k = (entry_k - INTERSECTION_STOP_MARGIN).max(0.0);

        let node = trip.route[k];

        // A trip that ends on a junction stops there; it never registered
        // for passage, so waiting for it would be waiting for ever.
        if let Some(g) = gates.at(world, trip, k).find(|g| !world.map.streets.has_passage(g.id, car_id)) {
            obstacles.push((Obstacle::MustStop { distance: line_k }, Cause::Junction(g.id)));
            break;
        }

        if let Some(holder) = held(world, car_id, node).filter(|_| !turn_ahead) {
            obstacles.push((Obstacle::MustStop { distance: line_k }, Cause::Turn(holder)));
            turn_ahead = true;
        }
        if world.map.lot_nodes.contains_key(&node) {
            obstacles.push((Obstacle::SpeedLimit { distance: (node_dist - trip.segment_lengths[k] - nose(role)).max(0.0), speed: LOT_SPEED }, Cause::Slow));
        }
        if stops_at(world, trip, k) {
            obstacles.push((Obstacle::Halt { distance: node_dist }, Cause::Stop));
        }
        if let Some(limit) = bend(world, &trip.route, k) {
            obstacles.push((Obstacle::SpeedLimit { distance: entry_k, speed: limit }, Cause::Bend));
        }
    }
    (obstacles, standing)
}

/// Set the pedal by whatever asks the most of it, say why, sleep until
/// something might change that, wake whoever follows it if it changed,
/// and write the car back.
#[allow(clippy::too_many_arguments)]
fn settle(world: &mut World, events: &mut EventQueue, h: &Here, trip: &Trip, obstacles: &[(Obstacle, Cause)], soon: bool, standing: Option<GameTime>, marks: [Option<f64>; 2], lanes_changed: bool) {
    let Here { car_id, now, ri, seg_start, progress: cur_progress, speed: cur_speed, .. } = *h;
    let old_ri = trip.route_index;
    let current_edge: EdgeKey = (trip.route[ri - 1], trip.route[ri]);
    // === DECIDE ===
    let (new_accel, cause) = obstacles
        .iter()
        .map(|(o, c)| (o.required_accel(cur_speed), Some(*c)))
        .fold((ACCELERATION, None), |a, b| if b.0 < a.0 { b } else { a });

    let mut wake_ms = obstacles
        .iter()
        .map(|(o, _)| o.wake_time(cur_speed, new_accel))
        .fold(5000u64, u64::min);

    // Waiting for a gap: look again soon. Waiting for someone else to turn
    // needs no looking: they wake whoever is coming once they are clear.
    // Holding short of a merge: nobody wakes it when the other is through.
    if soon {
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
    let end = stretch_end(world, car_id, trip, ri, seg_start);
    if let Some(t) = physics::time_to_reach(cur_progress, cur_speed, new_accel, end) {
        wake_ms = wake_ms.min(((t * 1000.0) as u64).max(1));
    }
    // And where its tail clears a junction, and where the next comes near
    // enough to say when it will be there.
    for at in marks.into_iter().flatten() {
        if let Some(t) = physics::time_to_reach(cur_progress, cur_speed, new_accel, at) {
            wake_ms = wake_ms.min(((t * 1000.0) as u64).max(1));
        }
    }

    events.wake(wake_ms, car_id);

    let accel_changed = ((new_accel - trip.acceleration) / ACCELERATION).abs() > 0.02;

    // Wake car behind on acceleration change: a driver's reaction time,
    // quicker for brake lights than for a gap opening. Pulling away, a
    // second after the one ahead: so a queue starts from its head back,
    // car by car, and a jam clears from its front, as one does.
    if accel_changed {
        let delay = if new_accel < 0.0 { 50 } else { 1_000 };
        for behind in world.map.car_behind_on_edge(current_edge, car_id) {
            events.wake(delay, behind);
        }
        // And whoever follows it onto the road out of the junction ahead:
        // at a merge, a car from the other arm.
        if ri + 1 < trip.route.len() {
            for behind in world.map.car_behind_on_edge((trip.route[ri], trip.route[ri + 1]), car_id) {
                if from_another_arm(world, behind, trip.route[ri], trip.route[ri - 1]) {
                    events.wake(delay, behind);
                }
            }
        }
        // Cross-edge: front car on previous edge
        if ri >= 2 {
            let prev_edge: EdgeKey = (trip.route[ri - 2], trip.route[ri - 1]);
            if let Some(prev_seg) = world.map.edges.get(&prev_edge) {
                for front_id in prev_seg.fronts().filter(|&f| f != car_id).collect::<Vec<_>>() {
                    events.wake(delay, front_id);
                }
            }
        }
    }

    // Update spatial position when car crosses a node
    if ri != old_ri {
        if let Some(node_pos) = world.map.objects.get(trip.route[ri - 1]).and_then(|e| e.position) {
            world.map.update_position(car_id, node_pos);
        }
    }

    let entry = if accel_changed || lanes_changed {
        world.map.objects.get_mut(car_id)
    } else {
        world.map.objects.get_mut_silent(car_id)
    };
    if let Some(entry) = entry
        && let GameObject::Car(ref mut c) = entry.object
        && let Some(ref mut t) = c.trip
    {
        t.progress = cur_progress;
        t.speed = cur_speed;
        t.updated_at = now;
        t.route_index = ri;
        t.standing = trip.standing;
        t.joined = trip.joined;
        // What it slows or stops for, kept for a replay to read.
        t.why = cause.map(|c| (c, new_accel));
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

/// How long a change of lanes takes, and how long after one a car thinks
/// of another.
const SHIFT_MS: GameTime = 1500;
const SETTLE_MS: GameTime = 2500;
/// How far before the junction ending its stretch a car gets into the lane
/// its turn there asks for; and how near it a car makes room for one
/// waiting there to merge into its lane.
const GET_IN: f64 = 12.0;
/// How near the end of a road of two a car may still change lanes.
const LAST_CHANGE: f64 = 0.8;
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
fn change_lanes(world: &mut World, events: &mut EventQueue, car_id: EntityId, role: CarRole, trip: &mut Trip, ri: usize, p: f64, v: f64, now: GameTime) -> Vec<(Obstacle, Cause)> {
    let len = trip.route.len();
    // Not yet in the lane the way out ahead asks for, it means to stop
    // short of it if it must, wherever it cannot try to get in just now
    // too (by a junction, or changing lanes): one that forgot meanwhile
    // came to the way out too fast to take a gap, braking hard.
    // One that goes on from the lane it is in after all (`not_in_lane`)
    // no longer wants another.
    let getting = not_in_lane(world, car_id, role, trip, ri, p, v, now);
    let exit = exit_lane(world, trip, ri, p).filter(|&(w, _)| w == trip.lanes[ri] || trip.shift.is_some_and(|s| s.to == w) || getting.is_some());
    let short: Vec<(Obstacle, Cause)> = getting
        .map(|(_, d)| (Obstacle::MustStop { distance: (d - 1.0).max(0.0) }, Cause::GettingIn(None)))
        .into_iter()
        .collect();
    let edge = |k: usize| (trip.route[k - 1], trip.route[k]);
    if let Some(s) = trip.shift.filter(|s| s.from != s.to && now >= s.until) {
        for k in ri..len {
            let e = edge(k);
            if !world.map.edges.get(&e).is_some_and(|seg| seg.contains(car_id)) {
                break;
            }
            for b in world.map.car_behind_on_edge(e, car_id) {
                events.wake(0, b);
            }
            let keep = trip.lanes[k] as usize;
            world.map.edges.get_mut(&e).unwrap().leave_lane(car_id, 1 - keep);
        }
        trip.shift = Some(Shift { from: s.to, ..s });
    }
    if trip.shift.is_some_and(|s| s.from != s.to || now < s.until + SETTLE_MS) {
        return short;
    }
    let wide = |k: usize| world.map.edges.get(&(trip.route[k - 1], trip.route[k])).is_some_and(|s| s.lanes > 1);
    let end = (ri..len).find(|&k| k + 1 == len || world.map.network.ends_run(trip.route[k])).unwrap_or(ri);
    if !(ri..=end).all(wide) {
        return short;
    }
    let to_end = trip.along[end] - p;
    let lane = trip.lanes[ri];
    let other = 1 - lane;
    let (want, to_want) = exit.map_or((None, to_end), |(w, d)| (Some(w), d));
    // How far a change carries: along the road of two, through whatever
    // junctions it goes on through in it.
    let mut carry = ri;
    while carry < len && wide(carry) {
        carry += 1;
    }
    let near = [0, 1].map(|l| neighbours(world, car_id, trip, ri, carry - 1, p, l, now));
    // Someone at the junction ahead about to come into the lane this car
    // goes out by.
    // A change it need not make it makes only where its way through the
    // gates it would go on through in the other lane meets nobody coming
    // there: moving over into another's way, it gave up its turn at the
    // junction for a wait behind them.
    let moved = Trip { lanes: trip.lanes.iter().enumerate().map(|(k, &l)| if (ri..=carry).contains(&k) { 1 - l } else { l }).collect(), ..trip.clone() };
    let ways = |t: &Trip, k: usize| gates(world, t, k).into_iter().flatten().map(|g| (g.id, g.crossing(), g.track));
    let clear_there = (ri..carry).all(|k| ways(&moved, k).all(|(j, _, t)| !world.map.streets.meets(j, car_id, &t, false)));
    let joining = ways(trip, end).any(|(j, crossing, t)| !crossing && world.map.streets.meets(j, car_id, &t, true));
    let merging = |l: u8| to_end < MAKE_ROOM && end + 1 < len && trip.lanes[end + 1] == l && joining;
    let ahead = |l: u8| near[l as usize][0];
    let slow = ahead(lane).filter(|&(d, vo, ..)| d < OVERTAKE && vo < v - 0.1);
    let to = if to_end < LAST_CHANGE {
        None
    } else if let Some(w) = want.filter(|&w| w != lane && to_want < GET_IN) {
        Some(w)
    } else if merging(lane) && want != Some(lane) {
        Some(other)
    } else if v < 0.5 {
        None
    } else if let Some((d, vo, ..)) = slow.filter(|_| want.is_none_or(|w| w == other || to_want > GET_IN)) {
        ahead(other).is_none_or(|(e, wo, ..)| e > d + 1.0 || wo > vo + 0.2).then_some(other)
    } else if lane == 1 && want != Some(1) && !merging(0) {
        ahead(0).is_none_or(|(d, vo, ..)| d > KEEP_RIGHT || vo >= v).then_some(0)
    } else {
        None
    };
    let Some(to) = to.filter(|&t| want == Some(t) || clear_there) else { return short };
    // Nor into a lane someone is still to come out into at the junction it
    // has just come through, in by another arm: not behind it on this car's
    // way, it is not seen there, and came on it braking hard, or into it.
    if gates(world, &moved, ri - 1).into_iter().flatten().any(|g| !g.crossing() && world.map.streets.joins(g.id, car_id, &g.track, g.from)) {
        return short;
    }
    if let Some(blocker) = in_the_way(role, v, near[to as usize]) {
        // No room in the lane its turn needs: it falls in behind the car
        // ahead there, and short of the junction it waits for a gap.
        if want != Some(to) {
            return short;
        }
        // Two side by side, each waiting for the other's lane, would wait
        // for good: the one further back (or the later, level) lets it go
        // and drives on in its own lane, leaving the other room.
        let swaps = |n: &Option<Near>| n.is_some_and(|(d, .., o)| signalling(world, o) == Some(lane) && (d > 0.0 || (d > -0.3 && o < car_id)));
        if near[to as usize].iter().any(swaps) {
            return short;
        }
        // And signals: whoever is coming along behind in that lane may
        // drop back for it.
        trip.signal = Some(to);
        for b in coming(world, car_id, trip, ri, p, to as usize, now) {
            events.wake(0, b);
        }
        let mut hold = vec![(Obstacle::MustStop { distance: (to_want - 1.0).max(0.0) }, Cause::GettingIn(Some(blocker)))];
        // Behind the car ahead there, where it can fall in without braking
        // hard; one beside it it lets go by.
        if let Some((d, vo, ro, _)) = ahead(to)
            && let gap = d - nose(role) - tail(ro) - MIN_GAP
            && gap >= 0.0
            && physics::braking_distance(v, vo) <= gap + 0.05
        {
            hold.push((Obstacle::LeadCar { distance: gap, speed: vo, accel: 0.0 }, Cause::GettingIn(Some(blocker))));
        }
        return hold;
    }
    for k in ri..carry {
        trip.lanes[k] = to;
    }
    for j in ri..carry {
        let e = edge(j);
        if !world.map.edges.get(&e).is_some_and(|seg| seg.contains(car_id)) {
            break;
        }
        let mine = p - trip.along[j - 1];
        let behind: Vec<EntityId> = world.map.edges[&e].lane(to as usize).filter(|&o| position_on(world, o, e, now).is_some_and(|q| q < mine)).collect();
        world.map.edges.get_mut(&e).unwrap().insert_before(car_id, to as usize, |o| behind.contains(&o));
        for b in world.map.car_behind_on_edge(e, car_id) {
            events.wake(0, b);
        }
    }
    // Across over the way it covers meanwhile, and no shorter than a turn
    // of the wheel allows.
    let over = (v * SHIFT_MS as f64 / 1000.0).max(0.5);
    trip.shift = Some(Shift { from: lane, to, at: now, until: now + SHIFT_MS, along: p, over });
    Vec::new()
}

/// The lane the way out ahead asks for and how far off it is, if the car
/// is not in it, nor moving over into it. Not if it is too near to change
/// lanes any more (`LAST_CHANGE`), nor if the car in its way in that lane
/// wants this one's: each waited for a change it could never make. The one
/// with the lower id of the two goes on from the lane it is in, across the
/// junction, and the other moves over behind it.
#[allow(clippy::too_many_arguments)]
fn not_in_lane(world: &World, car_id: EntityId, role: CarRole, trip: &Trip, ri: usize, p: f64, v: f64, now: GameTime) -> Option<(u8, f64)> {
    let (want, d) = exit_lane(world, trip, ri, p).filter(|&(w, _)| w != trip.lanes[ri] && !trip.shift.is_some_and(|s| s.from != s.to && s.to == w))?;
    let mine = trip.lanes[ri];
    let swaps = |o: EntityId| match world.map.objects.get(o).map(|e| &e.object) {
        Some(GameObject::Car(c)) => c.trip.as_ref().is_some_and(|t| {
            let (q, _) = t.at(now);
            t.lanes.get(t.route_index) == Some(&want) && exit_lane(world, t, t.route_index, q).is_some_and(|(w, _)| w == mine)
        }),
        _ => false,
    };
    let carry = (ri..trip.route.len()).take_while(|&k| world.map.edges.get(&(trip.route[k - 1], trip.route[k])).is_some_and(|s| s.lanes > 1)).last().unwrap_or(ri);
    let swap = in_the_way(role, v, neighbours(world, car_id, trip, ri, carry, p, want as usize, now)).is_some_and(|o| car_id < o && swaps(o));
    (!swap && d >= LAST_CHANGE).then_some((want, d))
}

/// The lane the next way out that asks for one does (`Map::turn_lane`),
/// and how far ahead it is, within `GET_IN`, looking through the junctions
/// a car goes on through on the road of two it is on: a way out a junction
/// past a short stretch is got into the lane for on the long one before it.
fn exit_lane(world: &World, trip: &Trip, ri: usize, p: f64) -> Option<(u8, f64)> {
    let len = trip.route.len();
    let wide = |k: usize| world.map.edges.get(&(trip.route[k - 1], trip.route[k])).is_some_and(|s| s.lanes > 1);
    if !wide(ri) {
        return None;
    }
    let stretch_end = |from: usize| (from..len).find(|&i| i + 1 == len || world.map.network.ends_run(trip.route[i]));
    let mut k = stretch_end(ri)?;
    if !(ri..=k).all(wide) {
        return None;
    }
    loop {
        let d = trip.along[k] - p;
        if d > GET_IN {
            return None;
        }
        if let Some(l) = world.map.turn_lane(&trip.route, k) {
            return Some((l, d));
        }
        match stretch_end(k + 1) {
            Some(next) if (k + 1..=next).all(wide) => k = next,
            _ => return None,
        }
    }
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
        let Some(seg) = world.map.edges.get(&e) else { continue };
        let mine = p - trip.along[k - 1];
        // Behind a junction, a car's lane there is not its lane here: it
        // may come out of the junction in another. Its lane here is the
        // one it means to be in on this car's edge.
        let here = (trip.route[ri - 1], trip.route[ri]);
        let crossing = k < ri && !one_stretch(world, &trip.route, k, ri);
        let cars: Vec<EntityId> = if crossing { seg.all().filter(|&o| lane_on(world, o, here) == Some(lane)).collect() } else { seg.lane(lane).collect() };
        for o in cars.into_iter().filter(|&o| o != car_id) {
            let Some(GameObject::Car(c)) = world.map.objects.get(o).map(|e| &e.object) else { continue };
            let Some(t) = c.trip.as_ref() else { continue };
            let Some(start) = t.start_of(e) else { continue };
            let (q, vo) = t.at(now);
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
        if p - trip.along[k - 1] > COURTESY + trip.segment_lengths[k] {
            break;
        }
        let e = (trip.route[k - 1], trip.route[k]);
        let Some(seg) = world.map.edges.get(&e) else { continue };
        let mine = p - trip.along[k - 1];
        out.extend(seg.lane(lane).filter(|&o| o != car_id && position_on(world, o, e, now).is_some_and(|q| q < mine)));
    }
    out
}

/// Which of these two in a lane leaves no room there for a car going `v`,
/// if one does: the one ahead too near not to be run into, or the one
/// behind too near to slow to it.
fn in_the_way(role: CarRole, v: f64, [ahead, behind]: [Option<Near>; 2]) -> Option<EntityId> {
    ahead
        .filter(|&(d, vo, ro, _)| d - nose(role) - tail(ro) < MIN_GAP + (v - vo).max(0.0) * 1.5)
        .or(behind.filter(|&(d, vo, ro, _)| -d - nose(ro) - tail(role) < headway(vo, v)))
        .map(|n| n.3)
}
