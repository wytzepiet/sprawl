use crate::protocol::EntityId;
use crate::world::World;
use crate::world::bezier;

impl World {
    /// Compute the cosine of the turn angle at route[node_index].
    /// Returns 1.0 (straight) for route endpoints (first/last node).
    pub fn turn_cos_angle(&self, route: &[EntityId], node_index: usize) -> f64 {
        if node_index == 0 || node_index >= route.len() - 1 {
            return 1.0;
        }
        let prev_pos = self.objects.get(route[node_index - 1]).and_then(|e| e.position);
        let curr_pos = self.objects.get(route[node_index]).and_then(|e| e.position);
        let next_pos = self.objects.get(route[node_index + 1]).and_then(|e| e.position);

        match (prev_pos, curr_pos, next_pos) {
            (Some(p), Some(c), Some(n)) => {
                let dx1 = (c.x - p.x) as f64;
                let dy1 = (c.y - p.y) as f64;
                let dx2 = (n.x - c.x) as f64;
                let dy2 = (n.y - c.y) as f64;
                let len1 = (dx1 * dx1 + dy1 * dy1).sqrt();
                let len2 = (dx2 * dx2 + dy2 * dy2).sqrt();
                if len1 < 1e-9 || len2 < 1e-9 {
                    return 1.0;
                }
                (dx1 * dx2 + dy1 * dy2) / (len1 * len2)
            }
            _ => 1.0,
        }
    }

    /// Get the Euclidean distance between two road nodes (used for A* pathfinding).
    pub fn segment_length(&self, from: EntityId, to: EntityId) -> f64 {
        let a = self.objects.get(from).and_then(|e| e.position);
        let b = self.objects.get(to).and_then(|e| e.position);
        match (a, b) {
            (Some(a), Some(b)) => {
                let dx = (b.x - a.x) as f64;
                let dy = (b.y - a.y) as f64;
                (dx * dx + dy * dy).sqrt()
            }
            _ => 1.0,
        }
    }

    /// Collect world positions (tile center) for each node in a route.
    pub fn route_positions(&self, route: &[EntityId]) -> Vec<[f64; 2]> {
        route
            .iter()
            .filter_map(|&id| {
                self.objects.get(id).and_then(|e| {
                    e.position.map(|p| [p.x as f64 + 0.5, p.y as f64 + 0.5])
                })
            })
            .collect()
    }

    /// Precompute all segment lengths for a route. Returns a Vec where
    /// result[i] = arc length of segment from route[i-1] to route[i].
    /// result[0] = 0.0 (no segment before first node).
    pub fn compute_segment_lengths(&self, route: &[EntityId]) -> Vec<f64> {
        let centers = self.route_positions(route);
        let positions = bezier::offset_positions(&centers, bezier::LANE_OFFSET);
        let mut lengths = vec![0.0]; // index 0 unused
        for i in 1..route.len() {
            if i < positions.len() {
                lengths.push(bezier::segment_length(&positions, i - 1));
            } else {
                lengths.push(1.0);
            }
        }
        lengths
    }
}
