use crate::car::{nose, tail, ACCELERATION, LOT_SPEED, MIN_GAP};
use model::CRUISE_SPEED;
use crate::event_queue::EventQueue;
use model::GameTime;
use model::{EntityId, GameObject, Trip};
use crate::Traffic;

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
    world: &mut Traffic,
    events: &mut EventQueue,
    car_id: EntityId,
    from_node: EntityId,
    dest_building: EntityId,
    now: GameTime,
    until: GameTime,
) -> bool {
    let leaves = match world.map.objects.get(car_id).map(|e| &e.object) {
        Some(GameObject::Car(c)) => c.spot,
        _ => None,
    };
    let out = world.map.way_out(car_id).unwrap_or_default();
    depart(world, events, car_id, out, leaves, from_node, dest_building, now, until)
}

/// A trip out by a given way: lot nodes, the street node last, from where
/// the car stands (`leaves`).
#[allow(clippy::too_many_arguments)]
pub fn depart(
    world: &mut Traffic,
    events: &mut EventQueue,
    car_id: EntityId,
    out: Vec<EntityId>,
    leaves: Option<model::Pose>,
    from_node: EntityId,
    dest_building: EntityId,
    now: GameTime,
    until: GameTime,
) -> bool {
    let role = match world.map.objects.get(car_id).map(|e| &e.object) {
        Some(GameObject::Car(c)) if c.trip.is_none() => c.role,
        _ => return false,
    };
    let backs_out = world.map.backs_out(car_id);
    let leaving = world.map.stretch(car_id);
    let from_node = out.last().copied().unwrap_or(from_node);
    let Some(ways) = world.map.ways_to(dest_building, from_node) else { return false };
    let from_lot = out.len().saturating_sub(1);

    // Don't pull out under a car blocking the start of the road.
    let first_edge = match out.len() {
        0 | 1 => (ways.street[0], ways.street[1]),
        _ => (out[0], out[1]),
    };
    if !room_at_start(world, first_edge, 0, role, now) {
        return false;
    }

    // Nothing else can refuse the trip now, so the place at the far end is
    // claimed, and the one here let go of: booked from the earliest the car
    // could be there, on empty roads, to when the driver plans to leave.
    let free_ms = ((ways.street.len() - 1) as f64 / CRUISE_SPEED * 1000.0) as GameTime;
    let Some((path, to_lot)) = world.map.way_in(dest_building, car_id, &ways, now + free_ms, until.saturating_add(map::lots::SLACK)) else { return false };
    let backs_in = world.map.reverse_tail(car_id);
    let route: Vec<EntityId> = out[..from_lot].iter().copied().chain(path).collect();
    let backing = backing(backs_out, backs_in, route.len());
    let stretches = [leaving, world.map.stretch(car_id)];
    let trip = trip(world, car_id, dest_building, route, from_lot, to_lot, backing, stretches, leaves, now);
    set_off(world, events, car_id, trip);
    true
}

/// A trip along a route, laid out: where each node of it stands, how high,
/// in which lane, how far along, where it changes gear, and when it would
/// end on empty roads. A car setting out takes it whole; one rerouted on
/// its way keeps what its old trip knew of the road behind it
/// (`car::reroute`).
#[allow(clippy::too_many_arguments)]
pub(crate) fn trip(
    world: &Traffic,
    car_id: EntityId,
    destination: EntityId,
    route: Vec<EntityId>,
    from_lot: usize,
    to_lot: usize,
    backing: Vec<[usize; 2]>,
    stretches: [Vec<EntityId>; 2],
    leaves: Option<model::Pose>,
    now: GameTime,
) -> Trip {
    let segment_lengths = world.map.compute_segment_lengths(&route, from_lot, to_lot, &backing);
    let along = along(&segment_lengths);
    let total_len: f64 = segment_lengths.iter().sum();
    // The lot's edges are the ones into and out of it: as many at each end
    // as there are lot nodes there, since the street node closes each run.
    let lot_len: f64 = along[from_lot]
        + segment_lengths[segment_lengths.len() - to_lot..].iter().sum::<f64>();
    let street_len = total_len - lot_len;
    let promised = ((street_len / CRUISE_SPEED + lot_len / LOT_SPEED) * 1000.0) as u64;
    Trip {
        destination,
        eta: now + promised,
        route_positions: world.map.route_positions(&route),
        route_heights: route.iter().map(|&n| world.map.height_of(n)).collect(),
        lanes: world.map.lanes_for(&route),
        from_lot,
        to_lot,
        cusps: cusps(&backing, &along),
        leaves,
        stands: world.map.pose_held(car_id),
        backing,
        progress: 0.0,
        speed: 0.0,
        acceleration: ACCELERATION,
        total_route_length: total_len,
        updated_at: now,
        route_index: 1,
        segment_lengths,
        along,
        // The run it is setting off along starts here, so the first
        // junction it reaches has something to measure against.
        joined: Some((route[0], route[1], now)),
        route,
        standing: None,
        why: None,
        stretches,
        shift: None,
        signal: None,
    }
}

/// A car set off on its trip: at the trip's first node, in the queues of
/// its route and of its first edge, and awake.
pub(crate) fn set_off(world: &mut Traffic, events: &mut EventQueue, car_id: EntityId, trip: Trip) {
    let first_edge = (trip.route[0], trip.route[1]);
    let first_lane = trip.lanes.get(1).copied().unwrap_or(0) as usize;
    let route = trip.route.clone();
    if let Some(start_pos) = world.map.objects.get(route[0]).and_then(|e| e.position) {
        world.map.update_position(car_id, start_pos);
    }
    let Some(GameObject::Car(c)) = world.map.objects.get_mut(car_id).map(|e| &mut e.object) else { return };
    c.trip = Some(trip);
    let owner = c.owner;

    // The driver's `at` points at the car for the whole ride; arrival points
    // it at the destination.
    if let Some(entry) = world.map.objects.get_mut(owner)
        && let GameObject::Resident(ref mut r) = entry.object
    {
        r.at = Some(car_id);
    }

    world.map.register_car_route(car_id, &route);
    if let Some(seg) = world.map.edges.get_mut(&first_edge)
        && !seg.contains(car_id)
    {
        seg.push_back(car_id, first_lane);
    }
    events.wake(0, car_id);
}

/// Is the start of this edge clear of the last car to set off along it, by
/// a car's length and a gap?
fn room_at_start(world: &Traffic, first_edge: (EntityId, EntityId), lane: usize, role: model::CarRole, now: GameTime) -> bool {
    if let Some(seg) = world.map.edges.get(&first_edge)
        && let Some(last_id) = seg.back(lane)
        && let Some(entry) = world.map.objects.get(last_id)
        && let GameObject::Car(ref blocker) = entry.object
        && let Some(ref blocker_trip) = blocker.trip
        && let Some(edge_start) = blocker_trip.start_of(first_edge)
    {
        let (bp, _) = blocker_trip.at(now);
        if bp - edge_start < MIN_GAP + nose(role) + tail(blocker.role) {
            return false;
        }
    }
    true
}

/// A car with nowhere to park, set off along a route of road nodes from
/// its first to its last: it is gone when it gets there. A level's traffic,
/// in at one gate and out at another. False when the start of the road is
/// taken.
pub fn drive_through(world: &mut Traffic, events: &mut EventQueue, car_id: EntityId, route: Vec<EntityId>, now: GameTime) -> bool {
    let role = match world.map.objects.get(car_id).map(|e| &e.object) {
        Some(GameObject::Car(c)) if c.trip.is_none() && route.len() >= 2 => c.role,
        _ => return false,
    };
    let lane = world.map.lanes_for(&route).get(1).copied().unwrap_or(0) as usize;
    if !room_at_start(world, (route[0], route[1]), lane, role, now) {
        return false;
    }
    // It comes from off the map, so it comes at speed: the road's, or the
    // car ahead's if that is slower.
    let ahead = world.map.edges.get(&(route[0], route[1])).and_then(|seg| seg.back(lane));
    let speed = ahead
        .and_then(|id| match world.map.objects.get(id).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.trip.as_ref().map(|t| t.at(now).1),
            _ => None,
        })
        .map_or(CRUISE_SPEED, |v| v.min(CRUISE_SPEED));
    let end = route[route.len() - 1];
    let trip = Trip { speed, ..trip(world, car_id, end, route, 0, 0, Vec::new(), [Vec::new(), Vec::new()], None, now) };
    set_off(world, events, car_id, trip);
    true
}

/// The stretches of a route of `len` nodes driven backwards: its first
/// `out` edges, backing out of where it stood, and its last `into`, backing
/// into where it is going.
pub fn backing(out: usize, into: usize, len: usize) -> Vec<[usize; 2]> {
    let mut v = Vec::new();
    if out > 0 {
        v.push([0, out]);
    }
    if into > 0 {
        v.push([len - 1 - into, len - 1]);
    }
    v
}

/// A manoeuvre within a lot, by a way given, all of it lot nodes, its last
/// `backs` edges backed: a lorry from one dock of a yard to another.
pub fn manoeuvre(world: &mut Traffic, events: &mut EventQueue, car_id: EntityId, building: EntityId, route: Vec<EntityId>, backs: usize, leaves: Option<model::Pose>, now: GameTime) -> bool {
    let n = route.len();
    if !matches!(world.map.objects.get(car_id).map(|e| &e.object), Some(GameObject::Car(c)) if c.trip.is_none() && n >= 4 && backs < n) {
        return false;
    }
    // Lot nodes all: the first two its way out, the rest its way in.
    let trip = trip(world, car_id, building, route, 2, n - 2, vec![[n - 1 - backs, n - 1]], [Vec::new(), Vec::new()], leaves, now);
    set_off(world, events, car_id, trip);
    true
}

/// How far along the route each change of gear is, as its physics measures
/// it: where a vehicle stops and pulls away the other way.
pub fn cusps(backing: &[[usize; 2]], along: &[f64]) -> Vec<f64> {
    map::geometry::parts(backing, along.len()).iter().skip(1).map(|&(i, _)| along[i]).collect()
}

/// How far along a route each node of it is, from its segments' lengths:
/// `segment_lengths[1..=k]` summed, in the same order.
pub fn along(segment_lengths: &[f64]) -> Vec<f64> {
    std::iter::once(0.0).chain(segment_lengths.iter().skip(1).scan(0.0, |d, &l| {
        *d += l;
        Some(*d)
    })).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use map::Map;
    use model::{BuildingKind, GameObject, GridCoord};

    /// A house's car drives onto its driveway nose first, stands facing the
    /// house, and backs out onto the street when it leaves: the first edge
    /// of the trip out is driven backwards, and then it drives on.
    #[test]
    fn a_car_backs_out_of_its_driveway() {
        let mut map = Map::meadow(-4..40, -4..8).street(-4..40);
        let mut streets = crate::intersection::IntersectionRegistry::new();
        let mut world = Traffic { map: &mut map, streets: &mut streets, arrived: Vec::new() };
        let house = world.map.place_on_street(GridCoord { x: 6, y: 1 }, BuildingKind::House).unwrap();
        let depot = world.map.place_on_street(GridCoord { x: 20, y: 1 }, BuildingKind::Depot).unwrap();
        let car = world.map.insert_at(GameObject::Car(model::Car::new(0, Default::default())), None);
        let ways = world.map.ways_to(house, world.map.road_node_at(GridCoord { x: 30, y: 0 }).unwrap()).unwrap();
        let (way, _) = world.map.way_in(house, car, &ways, 0, GameTime::MAX).unwrap();
        let door = world.map.door_of(house).unwrap().0;
        let driveway = [door.x as f64 + 0.5, door.y as f64 + 0.5];
        let spot = world.map.node_pos(way[way.len() - 1]).unwrap();
        world.map.park_in_lot(house, car, 0);
        let pose = match world.map.objects.get(car).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.spot.unwrap(),
            _ => unreachable!(),
        };
        let (dx, dy) = (driveway[0] - spot[0], driveway[1] - spot[1]);
        assert!(pose.heading.cos() * dx + pose.heading.sin() * dy > 0.0, "parked facing the house, the way it drove in");
        assert_eq!(world.map.backs_out(car), 1, "backed off the driveway");
        let mut events = crate::event_queue::EventQueue::new();
        let street = world.map.approach(house).unwrap();
        assert!(crate::car::spawn::start_trip(&mut world, &mut events, car, street, depot, 0, GameTime::MAX));
        let trip = match world.map.objects.get(car).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.trip.clone().unwrap(),
            _ => unreachable!(),
        };
        assert_eq!(trip.backing, vec![[0, 1]], "the first edge backwards, the rest forward");
    }
}
