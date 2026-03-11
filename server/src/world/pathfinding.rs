use std::collections::{BinaryHeap, HashMap};
use std::cmp::Ordering;

use crate::protocol::EntityId;
use crate::world::World;

struct Node {
    id: EntityId,
    g: f64,
    f: f64,
}

impl PartialEq for Node {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}
impl Eq for Node {}

impl Ord for Node {
    fn cmp(&self, other: &Self) -> Ordering {
        other.f.partial_cmp(&self.f).unwrap_or(Ordering::Equal)
    }
}

impl PartialOrd for Node {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// A* pathfinding on the node graph directly.
/// Returns a list of node IDs from `start` to `end`, or None if no path exists.
pub fn find_path(world: &World, start: EntityId, end: EntityId) -> Option<Vec<EntityId>> {
    if start == end {
        return None;
    }

    let heuristic = |id: EntityId| -> f64 {
        let a = world.objects.get(id).and_then(|e| e.position);
        let b = world.objects.get(end).and_then(|e| e.position);
        match (a, b) {
            (Some(a), Some(b)) => {
                let dx = (b.x - a.x) as f64;
                let dy = (b.y - a.y) as f64;
                (dx * dx + dy * dy).sqrt()
            }
            _ => 0.0,
        }
    };

    let mut open = BinaryHeap::new();
    let mut g_scores: HashMap<EntityId, f64> = HashMap::new();
    let mut came_from: HashMap<EntityId, EntityId> = HashMap::new();

    g_scores.insert(start, 0.0);
    open.push(Node { id: start, g: 0.0, f: heuristic(start) });

    while let Some(current) = open.pop() {
        if current.id == end {
            let mut route = vec![end];
            let mut node = end;
            while let Some(&prev) = came_from.get(&node) {
                route.push(prev);
                node = prev;
            }
            route.reverse();
            return Some(route);
        }

        if current.g > *g_scores.get(&current.id).unwrap_or(&f64::INFINITY) {
            continue;
        }

        let outgoing = match world.objects.get(current.id) {
            Some(e) => match &e.object {
                crate::protocol::GameObject::RoadNode(node) => node.outgoing.clone(),
                _ => continue,
            },
            None => continue,
        };

        for neighbor in outgoing {
            let edge_len = world.edges.get(&(current.id, neighbor))
                .map(|e| e.length)
                .unwrap_or_else(|| world.segment_length(current.id, neighbor));
            let tentative_g = current.g + edge_len;

            if tentative_g < *g_scores.get(&neighbor).unwrap_or(&f64::INFINITY) {
                g_scores.insert(neighbor, tentative_g);
                came_from.insert(neighbor, current.id);
                open.push(Node {
                    id: neighbor,
                    g: tentative_g,
                    f: tentative_g + heuristic(neighbor),
                });
            }
        }
    }

    None
}
