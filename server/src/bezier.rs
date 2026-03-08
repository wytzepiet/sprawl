/// Radius of the rounded corner at each node (in tiles).
const CORNER_RADIUS: f64 = 0.3;
const BEZIER_SAMPLES: usize = 8;

fn quad_bezier(a: [f64; 2], b: [f64; 2], c: [f64; 2], t: f64) -> [f64; 2] {
    let mt = 1.0 - t;
    [
        mt * mt * a[0] + 2.0 * mt * t * b[0] + t * t * c[0],
        mt * mt * a[1] + 2.0 * mt * t * b[1] + t * t * c[1],
    ]
}

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    (dx * dx + dy * dy).sqrt()
}

/// Geometry of one route segment: straight part + optional bezier corner at the end.
pub struct SegmentGeometry {
    /// Length of the straight part (before the corner)
    pub straight: f64,
    /// Length of the bezier corner arc at the end (0 if last segment)
    pub corner_arc: f64,
}

impl SegmentGeometry {
    pub fn total(&self) -> f64 {
        self.straight + self.corner_arc
    }
}

/// Compute geometry for segment `seg_idx` (0-based) of a route.
///
/// Each segment covers: [corner_end at seg_idx] → straight → [corner at seg_idx+1]
pub fn segment_geometry(positions: &[[f64; 2]], seg_idx: usize) -> SegmentGeometry {
    let n = positions.len();
    if n < 2 || seg_idx + 1 >= n {
        return SegmentGeometry { straight: 1.0, corner_arc: 0.0 };
    }

    let a = positions[seg_idx];
    let b = positions[seg_idx + 1];
    let seg_len = dist(a, b);
    if seg_len < 1e-9 {
        return SegmentGeometry { straight: 0.0, corner_arc: 0.0 };
    }

    let dx = (b[0] - a[0]) / seg_len;
    let dy = (b[1] - a[1]) / seg_len;

    let start = if seg_idx > 0 {
        let r = CORNER_RADIUS.min(seg_len * 0.5);
        [a[0] + dx * r, a[1] + dy * r]
    } else {
        a
    };

    if seg_idx + 2 < n {
        let c = positions[seg_idx + 2];
        let next_len = dist(b, c);
        let r1 = CORNER_RADIUS.min(seg_len * 0.5);
        let r2 = CORNER_RADIUS.min(next_len * 0.5);

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

        SegmentGeometry { straight, corner_arc: arc }
    } else {
        SegmentGeometry { straight: dist(start, b), corner_arc: 0.0 }
    }
}
