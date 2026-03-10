use std::collections::{BinaryHeap, HashMap};
use std::cmp::Ordering;

use crate::protocol::{EntityId, SegmentId};
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

/// A* pathfinding on the segment graph (junction to junction).
/// Returns a list of segment IDs from `start` to `end`, or None if no path exists.
pub fn find_path(world: &World, start: EntityId, end: EntityId) -> Option<Vec<SegmentId>> {
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
    let mut came_from: HashMap<EntityId, (EntityId, SegmentId)> = HashMap::new();

    g_scores.insert(start, 0.0);
    open.push(Node { id: start, g: 0.0, f: heuristic(start) });

    while let Some(current) = open.pop() {
        if current.id == end {
            let mut segments = Vec::new();
            let mut node = end;
            while let Some(&(prev, seg_id)) = came_from.get(&node) {
                segments.push(seg_id);
                node = prev;
            }
            segments.reverse();
            return Some(segments);
        }

        if current.g > *g_scores.get(&current.id).unwrap_or(&f64::INFINITY) {
            continue;
        }

        if let Some(seg_ids) = world.junction_outgoing.get(&current.id) {
            for &seg_id in seg_ids {
                let segment = &world.segments[&seg_id];
                let end_junction = segment.end_junction();
                let tentative_g = current.g + segment.length;

                if tentative_g < *g_scores.get(&end_junction).unwrap_or(&f64::INFINITY) {
                    g_scores.insert(end_junction, tentative_g);
                    came_from.insert(end_junction, (current.id, seg_id));
                    open.push(Node {
                        id: end_junction,
                        g: tentative_g,
                        f: tentative_g + heuristic(end_junction),
                    });
                }
            }
        }
    }

    None
}

/// Expand a segment route into the full node-level route.
pub fn expand_segment_route(world: &World, segments: &[SegmentId]) -> Vec<EntityId> {
    if segments.is_empty() {
        return vec![];
    }
    let mut route = world.segments[&segments[0]].nodes.clone();
    for &seg_id in &segments[1..] {
        let nodes = &world.segments[&seg_id].nodes;
        // Skip first node (shared junction with previous segment)
        route.extend_from_slice(&nodes[1..]);
    }
    route
}
