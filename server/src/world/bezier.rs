/// Perpendicular offset from center-line to lane (must match client LANE_OFFSET).
pub const LANE_OFFSET: f64 = 0.15;

const BEZIER_SAMPLES: usize = 8;

fn quad_bezier(a: [f64; 2], c: [f64; 2], b: [f64; 2], t: f64) -> [f64; 2] {
    let mt = 1.0 - t;
    [
        mt * mt * a[0] + 2.0 * mt * t * c[0] + t * t * b[0],
        mt * mt * a[1] + 2.0 * mt * t * c[1] + t * t * b[1],
    ]
}

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    (dx * dx + dy * dy).sqrt()
}

/// Offset each position to the right of the travel direction.
pub fn offset_positions(positions: &[[f64; 2]], offset: f64) -> Vec<[f64; 2]> {
    let n = positions.len();
    let mut result = Vec::with_capacity(n);
    for i in 0..n {
        let mut dx = 0.0;
        let mut dy = 0.0;
        if i > 0 {
            dx += positions[i][0] - positions[i - 1][0];
            dy += positions[i][1] - positions[i - 1][1];
        }
        if i + 1 < n {
            dx += positions[i + 1][0] - positions[i][0];
            dy += positions[i + 1][1] - positions[i][1];
        }
        let len = (dx * dx + dy * dy).sqrt();
        if len < 1e-9 {
            result.push(positions[i]);
            continue;
        }
        // Right perpendicular: (-dy, dx)
        result.push([
            positions[i][0] - dy / len * offset,
            positions[i][1] + dx / len * offset,
        ]);
    }
    result
}

/// Arc length of lane segment `seg_idx` (0-based).
/// Each segment: [corner_end at seg_idx] → straight → [bezier corner at seg_idx+1].
pub fn segment_length(positions: &[[f64; 2]], seg_idx: usize) -> f64 {
    let n = positions.len();
    if n < 2 || seg_idx + 1 >= n {
        return 1.0;
    }

    let a = positions[seg_idx];
    let b = positions[seg_idx + 1];
    let seg_len = dist(a, b);
    if seg_len < 1e-9 {
        return 0.0;
    }

    let dx = (b[0] - a[0]) / seg_len;
    let dy = (b[1] - a[1]) / seg_len;

    // Start of straight: after previous node's corner
    let start = if seg_idx > 0 {
        let r = seg_len * 0.5;
        [a[0] + dx * r, a[1] + dy * r]
    } else {
        a
    };

    // End: if there's a next segment, include the bezier corner at the end node
    if seg_idx + 2 < n {
        let c = positions[seg_idx + 2];
        let next_len = dist(b, c);
        let r1 = seg_len * 0.5;
        let r2 = next_len * 0.5;

        let before_b = [b[0] - dx * r1, b[1] - dy * r1];
        let next_dx = (c[0] - b[0]) / next_len.max(1e-9);
        let next_dy = (c[1] - b[1]) / next_len.max(1e-9);
        let after_b = [b[0] + next_dx * r2, b[1] + next_dy * r2];

        let straight = dist(start, before_b);

        let mut arc = 0.0;
        let mut prev = before_b;
        for i in 1..=BEZIER_SAMPLES {
            let t = i as f64 / BEZIER_SAMPLES as f64;
            let curr = quad_bezier(before_b, b, after_b, t);
            arc += dist(prev, curr);
            prev = curr;
        }

        straight + arc
    } else {
        dist(start, b)
    }
}
