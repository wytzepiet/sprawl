use model::EntityId;
use crate::world::World;
use crate::world::bezier;

/// The lane a route is measured on: not `bezier::LANE_OFFSET`, the lane
/// it is driven and drawn on, but the old lanes' 0.15. On the true one the
/// junctions time their gaps otherwise, and the season's street gridlocks
/// on its ninth day and `04-merge` falls to 0.487.
const MEASURED_LANE: f64 = 0.15;

impl World {
    /// Compute the cosine of the turn angle at route[node_index].
    /// Returns 1.0 (straight) for route endpoints (first/last node).
    pub fn turn_cos_angle(&self, route: &[EntityId], node_index: usize) -> f64 {
        if node_index == 0 || node_index >= route.len() - 1 {
            return 1.0;
        }
        let prev_pos = self.node_pos(route[node_index - 1]);
        let curr_pos = self.node_pos(route[node_index]);
        let next_pos = self.node_pos(route[node_index + 1]);

        match (prev_pos, curr_pos, next_pos) {
            (Some(p), Some(c), Some(n)) => {
                let dx1 = c[0] - p[0];
                let dy1 = c[1] - p[1];
                let dx2 = n[0] - c[0];
                let dy2 = n[1] - c[1];
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
        match (self.node_pos(from), self.node_pos(to)) {
            (Some(a), Some(b)) => ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt(),
            _ => 1.0,
        }
    }

    /// Collect world positions (tile center) for each node in a route.
    pub fn route_positions(&self, route: &[EntityId]) -> Vec<[f64; 2]> {
        route.iter().filter_map(|&id| self.node_pos(id)).collect()
    }

    /// Precompute all segment lengths for a route. Returns a Vec where
    /// result[i] = arc length of segment from route[i-1] to route[i].
    /// result[0] = 0.0 (no segment before first node). The street part of
    /// the route is driven on its lane; the lot nodes at either end are
    /// where they are. Each stretch between changes of gear (`backing`) is
    /// measured on its own, as the client draws it: a change of gear is a
    /// point the vehicle stops at, not a corner it rounds, and is where it
    /// is, not on a lane.
    pub fn compute_segment_lengths(&self, route: &[EntityId], from_lot: usize, to_lot: usize, backing: &[[usize; 2]]) -> Vec<f64> {
        let centers = self.route_positions(route);
        let n = centers.len();
        let mut lengths = vec![0.0]; // index 0 unused
        if n == route.len() {
            for (i, j) in parts(backing, n) {
                let mut positions = bezier::offset_positions(&centers[i..=j], MEASURED_LANE);
                for k in i..=j {
                    if k < from_lot || k >= n - to_lot || (k == i && i > 0) || (k == j && j + 1 < n) {
                        positions[k - i] = centers[k];
                    }
                }
                lengths.extend((i..j).map(|k| bezier::segment_length(&positions, k - i)));
            }
        }
        lengths.resize(route.len().max(1), 1.0);
        lengths
    }
}

/// The stretches of a route of `n` nodes between its changes of gear, as
/// `(i, j)`: from node i to node j, each driven one way.
pub fn parts(backing: &[[usize; 2]], n: usize) -> Vec<(usize, usize)> {
    let mut cuts: Vec<usize> = backing.iter().flatten().copied().filter(|&k| k > 0 && k + 1 < n).collect();
    cuts.extend([0, n.saturating_sub(1)]);
    cuts.sort_unstable();
    cuts.dedup();
    cuts.windows(2).map(|w| (w[0], w[1])).collect()
}
