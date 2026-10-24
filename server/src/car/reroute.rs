//! Road taken up under the cars driving it: each rerouted from where it
//! is, or sent home where no way is left.

use crate::car::simulation::park_at_home;
use crate::engine::event_queue::EventQueue;
use crate::engine::GameTime;
use crate::protocol::{EntityId, GameObject, Trip};
use crate::world::World;

/// Take a road out of the world, rerouting or despawning whatever was on it.
///
/// By id rather than by tile: while a new road crosses one being demolished the
/// tile holds a node for each world, and only one of them is going.
pub(crate) fn handle_road_demolish(
    world: &mut World,
    events: &mut EventQueue,
    node_id: EntityId,
    now: GameTime,
) {

    // Collect neighbor IDs before removing anything (to check for orphans later)
    let neighbor_ids: Vec<EntityId> = match world.objects.get(node_id) {
        Some(entry) => if let GameObject::RoadNode(ref node) = entry.object {
            node.outgoing.iter().chain(node.incoming.iter()).copied().collect()
        } else { vec![] },
        None => vec![],
    };

    // Snapshot affected cars before removing anything
    let affected_car_ids: Vec<EntityId> = world.node_cars.get(&node_id).cloned().unwrap_or_default().into_iter().collect();
    let car_entries: Vec<(EntityId, Vec<EntityId>, usize, EntityId)> = affected_car_ids
        .iter()
        .filter_map(|&car_id| {
            let entry = world.objects.get(car_id)?;
            if let GameObject::Car(ref car) = entry.object {
                let trip = car.trip.as_ref()?;
                Some((car_id, trip.route.clone(), trip.route_index, trip.destination))
            } else {
                None
            }
        })
        .collect();

    // Fully remove the node and update the graph BEFORE rerouting
    world.demolish_node(node_id);

    // Now reroute — pathfinder sees the correct graph
    for (car_id, route, ri, dest) in car_entries {
        let from_node = if route[ri] == node_id {
            route[ri - 1]
        } else {
            route[ri]
        };

        if reroute(world, events, car_id, from_node, dest, now) {
            continue;
        }

        // Destination unreachable: the trip dies here, and the car goes home
        // with its driver to think again.
        park_at_home(world, events, car_id);
    }

    drop_orphans(world, events, &neighbor_ids);
}

/// Cut the road between two nodes, both ways, rerouting whatever was to
/// drive it; a node left with no road goes.
pub(crate) fn handle_link_demolish(
    world: &mut World,
    events: &mut EventQueue,
    a: EntityId,
    b: EntityId,
    now: GameTime,
) {
    let cut = |x: EntityId, y: EntityId| (x == a && y == b) || (x == b && y == a);
    let cars: Vec<(EntityId, EntityId, EntityId)> = world
        .node_cars
        .get(&a)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|car_id| {
            let GameObject::Car(ref car) = world.objects.get(car_id)?.object else { return None };
            let trip = car.trip.as_ref()?;
            let (route, ri) = (&trip.route, trip.route_index);
            if !route[ri.saturating_sub(1)..].windows(2).any(|w| cut(w[0], w[1])) {
                return None;
            }
            // On the link itself, it turns back from where it came onto it.
            let from = if ri > 0 && cut(route[ri - 1], route[ri]) { route[ri - 1] } else { route[ri] };
            Some((car_id, from, trip.destination))
        })
        .collect();
    world.unlink_roads(a, b);
    for (car_id, from, dest) in cars {
        if !reroute(world, events, car_id, from, dest, now) {
            park_at_home(world, events, car_id);
        }
    }
    drop_orphans(world, events, &[a, b]);
}

/// Road nodes among these left with no road: gone, and anything routed
/// over one sent home.
fn drop_orphans(world: &mut World, events: &mut EventQueue, nodes: &[EntityId]) {
    for &nid in nodes {
        let is_orphan = match world.objects.get(nid) {
            Some(entry) => if let GameObject::RoadNode(ref node) = entry.object {
                node.outgoing.is_empty() && node.incoming.is_empty()
            } else { false },
            None => false,
        };
        if is_orphan {
            // Any car routed over this orphan has nowhere left to drive
            let orphan_cars: Vec<EntityId> = world.node_cars.get(&nid).cloned().unwrap_or_default().into_iter().collect();
            for car_id in orphan_cars {
                park_at_home(world, events, car_id);
            }
            world.demolish_node(nid);
        }
    }
}

/// A car on its way sent another way to where it was going, from
/// `from_node`: out of every queue of its old route and into those of its
/// new, standing where it was. False where no way is left.
fn reroute(
    world: &mut World,
    events: &mut EventQueue,
    car_id: EntityId,
    from_node: EntityId,
    dest: EntityId,
    now: GameTime,
) -> bool {
    let Some(ways) = world.ways_to(dest, from_node) else { return false };
    // The spot it was heading for is still its own.
    let Some((new_route, to_lot)) = world.way_in(dest, car_id, &ways, now, GameTime::MAX) else { return false };
    let Some(GameObject::Car(c)) = world.objects.get(car_id).map(|e| &e.object) else { return false };
    let Some(old) = c.trip.clone() else { return false };

    // Out of every queue on the old route: a car stands in the queues of the
    // whole run ahead of it, not just the tile it is on.
    world.unregister_car_route(car_id, &old.route);
    world.remove_car_from_edges(car_id);
    for (_node, woken_id) in world.streets.remove_car_from_all(car_id, now) {
        events.wake(0, woken_id);
    }

    // What it knew of the road behind it and of its lanes it keeps, and
    // when it was due.
    let backing = crate::car::spawn::backing(0, world.reverse_tail(car_id), new_route.len());
    let stretches = [old.stretches[0].clone(), world.kerb_stretch(car_id)];
    let fresh = crate::car::spawn::trip(world, car_id, dest, new_route, 0, to_lot, backing, stretches, None, now);
    let trip = Trip { eta: old.eta, joined: old.joined, standing: old.standing, why: old.why, shift: old.shift, signal: old.signal, ..fresh };
    crate::car::spawn::set_off(world, events, car_id, trip);
    true
}
