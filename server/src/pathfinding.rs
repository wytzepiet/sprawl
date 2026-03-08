use std::collections::{BinaryHeap, HashMap};
use std::cmp::Ordering;

use crate::protocol::{EntityId, GameObject};
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

/// A* pathfinding on the road node graph.
/// Returns a list of node IDs from `start` to `end` (inclusive), or None if no path exists.
pub fn find_path(world: &World, start: EntityId, end: EntityId) -> Option<Vec<EntityId>> {
    if start == end {
        return Some(vec![start]);
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
            // Reconstruct path
            let mut path = vec![end];
            let mut node = end;
            while let Some(&prev) = came_from.get(&node) {
                path.push(prev);
                node = prev;
            }
            path.reverse();
            return Some(path);
        }

        if current.g > *g_scores.get(&current.id).unwrap_or(&f64::INFINITY) {
            continue; // stale entry
        }

        // Get neighbors
        let neighbors = match world.objects.get(current.id) {
            Some(entry) => {
                if let GameObject::RoadNode(ref node) = entry.object {
                    node.neighbors.clone()
                } else {
                    continue;
                }
            }
            None => continue,
        };

        for &neighbor_id in &neighbors {
            let edge_cost = world.segment_length(current.id, neighbor_id);
            let tentative_g = current.g + edge_cost;

            if tentative_g < *g_scores.get(&neighbor_id).unwrap_or(&f64::INFINITY) {
                g_scores.insert(neighbor_id, tentative_g);
                came_from.insert(neighbor_id, current.id);
                open.push(Node {
                    id: neighbor_id,
                    g: tentative_g,
                    f: tentative_g + heuristic(neighbor_id),
                });
            }
        }
    }

    None
}
