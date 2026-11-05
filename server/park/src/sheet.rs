//! Every shape on a street of its own, checked and drawn: it ends exactly
//! where it stands, never turns tighter than lock, and never touches the
//! cars parked beside it. `cargo test -p park sheet` checks them all;
//! with `DRAW=1` it draws them on one page, `.dev/park/sheet.svg`, a
//! strobe of each body from blue to red as it goes, so a shape a real
//! driver would not drive can be seen.

use crate::ways::{dock as dock_ways, *};
use crate::*;
use std::f64::consts::{FRAC_PI_2, PI};

/// The street: its middle line along x, half its width, the lanes either
/// side; a square bay's middle.
const HALF_ROAD: f64 = 0.22;
const LANE: f64 = 0.1;
const SQUARE: f64 = 0.37;
const SQUARE_PITCH: f64 = 0.27;

/// A scene: what it is called, the rig, its ways, the cars parked round
/// it, its bays drawn, and the places it must end at.
struct Scene {
    name: String,
    rig: Rig,
    legs: Vec<Leg>,
    parked: Vec<(Rig, Pose)>,
    bays: Vec<Rect>,
    ends: Pose,
    /// The ground it may drive on, where that is not just the street.
    extent: Option<Vec<Rect>>,
}

/// A car standing with its middle at (x, y), facing h: its axle's pose.
fn car(x: f64, y: f64, h: f64) -> Pose {
    Pose::new(x, y, h).ahead(-CAR.cab.axle())
}

fn bay(x: f64, y: f64, h: f64, l: f64, w: f64) -> Rect {
    Rect { x, y, half_l: l / 2.0, half_w: w / 2.0, heading: h }
}


fn scenes() -> Vec<Scene> {
    let road = Road { half: HALF_ROAD, lane: LANE };
    let mut out = Vec::new();
    // A square bay, its neighbours either side.
    let beside = [(-SQUARE_PITCH, -SQUARE), (SQUARE_PITCH, -SQUARE)];
    let bays: Vec<Rect> = (-1..=1).map(|i| bay(i as f64 * SQUARE_PITCH, -SQUARE, FRAC_PI_2, 0.29, SQUARE_PITCH)).collect();
    // A drive, the other car beside on it.
    let drive = [(-0.11, -0.53)];
    let drive_bays = vec![bay(0.0, -0.53, FRAC_PI_2, 0.3, 0.44)];
    for (what, x, depth, beside, bays) in [("square", 0.0, SQUARE, &beside[..], &bays), ("drive", 0.11, 0.53, &drive[..], &drive_bays)] {
        let parked: Vec<(Rig, Pose)> = beside.iter().map(|&(bx, by)| (CAR, car(bx, by, FRAC_PI_2))).collect();
        for (side, place) in square(x, depth, beside, road).into_iter().enumerate() {
            let from = ["from its own lane", "from across the road"][side];
            let Some(p) = place else {
                out.push(Scene { name: format!("{what}, {from}: none"), rig: CAR, legs: Vec::new(), parked: parked.clone(), bays: bays.clone(), ends: Pose::new(0.0, 0.0, 0.0), extent: None });
                continue;
            };
            out.push(Scene { name: format!("{what}, in {from}"), rig: CAR, legs: p.into.clone(), parked: parked.clone(), bays: bays.clone(), ends: p.stands, extent: None });
            for (k, legs) in p.outs.iter().enumerate() {
                let way = ["on", "back"][k];
                if legs.is_empty() {
                    continue;
                }
                out.push(Scene { name: format!("{what}, in {from}, out {way}"), rig: CAR, legs: legs.clone(), parked: parked.clone(), bays: bays.clone(), ends: p.stands, extent: None });
            }
        }
    }
    // A yard one row deep behind the kerb: two docks square to the street
    // at its gate, the lorry's tail to the wall; car bays either side,
    // clear of them; the other dock taken.
    let docks = [Pose::new(-0.15, -0.858, FRAC_PI_2), Pose::new(0.15, -0.858, FRAC_PI_2)];
    let cars: Vec<Pose> = [-1.22, -0.95, 0.95, 1.22].iter().map(|&x| car(x, -SQUARE, -FRAC_PI_2)).collect();
    let ground = [Rect::span(-3.0, -0.5, 3.0, HALF_ROAD + 0.08), Rect::span(-1.48, -1.48, 1.48, -0.45)];
    let yard_bays: Vec<Rect> = docks.iter().map(|d| bay(d.x, d.y - 0.2, FRAC_PI_2, 0.66, 0.28)).collect();
    for which in [0, 1] {
        let dock = docks[which];
        let other = docks[1 - which];
        let mut others: Vec<(Rig, Pose)> = vec![(LORRY, Pose::new(other.x, other.y, other.heading).ahead(-LORRY.cab.axle()))];
        others.extend(cars.iter().map(|&p| (CAR, p)));
        let parked: Vec<Rect> = others.iter().flat_map(|(r, p)| bodies(r, *p).collect::<Vec<_>>()).collect();
        let clear = |legs: &[Leg]| legs.iter().all(|l| l.poses(&LORRY).iter().all(|(_, p)| bodies(&LORRY, *p).all(|b| parked.iter().all(|c| !b.meets(c)) && b.corners().iter().all(|&c| ground.iter().any(|g| g.holds(c))))));
        let (near, far) = (road.near(), road.far());
        for (side, place) in [dock_ways(&LORRY, dock, near, &[near, far], &clear), dock_ways(&LORRY, dock, far, &[far, near], &clear)].into_iter().enumerate() {
            let from = ["from its own lane", "from across the road"][side];
            let name = format!("dock {}, ", ["left", "right"][which]);
            let Some(p) = place else {
                out.push(Scene { name: format!("{name}{from}: none"), rig: LORRY, legs: Vec::new(), parked: others.clone(), bays: yard_bays.clone(), ends: Pose::new(0.0, 0.0, 0.0), extent: Some(ground.to_vec()) });
                continue;
            };
            out.push(Scene { name: format!("{name}in {from}"), rig: LORRY, legs: p.into.clone(), parked: others.clone(), bays: yard_bays.clone(), ends: p.stands, extent: Some(ground.to_vec()) });
            for (k, legs) in p.outs.iter().enumerate() {
                if !legs.is_empty() {
                    out.push(Scene { name: format!("{name}in {from}, out {}", ["on", "back"][k]), rig: LORRY, legs: legs.clone(), parked: others.clone(), bays: yard_bays.clone(), ends: p.stands, extent: Some(ground.to_vec()) });
                }
            }
        }
    }
    out
}

/// Every pose of a scene's ways, in order.
fn poses(s: &Scene) -> Vec<Pose> {
    s.legs.iter().flat_map(|l| l.poses(&s.rig).into_iter().map(|(_, p)| p)).collect()
}

fn close(a: Pose, b: Pose) -> bool {
    (a.x - b.x).hypot(a.y - b.y) < 2e-3 && wrap(a.heading - b.heading).abs() < 2e-3
}

#[test]
fn sheet() {
    let all = scenes();
    let mut wrong = Vec::new();
    for s in &all {
        if s.legs.is_empty() {
            wrong.push(format!("{}: no way", s.name));
            continue;
        }
        let ps = poses(s);
        let (first, last) = (s.legs[0].from, s.legs.last().unwrap().end(&s.rig));
        if !close(first, s.ends) && !close(last, s.ends) {
            wrong.push(format!("{}: ends at {last:?}, starts at {first:?}, not {:?}", s.name, s.ends));
        }
        // Each leg starts where the one before ended.
        for w in s.legs.windows(2) {
            if !close(w[0].end(&s.rig), w[1].from) {
                wrong.push(format!("{}: a leg starts where the last did not end", s.name));
            }
        }
        if let Some(p) = ps.iter().find(|p| bodies(&s.rig, **p).any(|b| s.parked.iter().any(|(r, q)| bodies(r, *q).any(|c| b.meets(&c))))) {
            wrong.push(format!("{}: touches a parked car at {p:?}", s.name));
        }
        if let Some(ground) = &s.extent
            && let Some(p) = ps.iter().find(|p| bodies(&s.rig, **p).any(|b| b.corners().iter().any(|&c| !ground.iter().any(|g| g.holds(c)))))
        {
            wrong.push(format!("{}: off the ground at {p:?}", s.name));
        }
        for l in &s.legs {
            if l.moves.iter().any(|m| m.from.abs().max(m.to.abs()) > s.rig.lock + 1e-9) {
                wrong.push(format!("{}: tighter than lock", s.name));
            }
        }
    }
    if std::env::var("DRAW").is_ok() {
        draw(&all);
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

fn draw(all: &[Scene]) {
    let px = 110.0;
    let width = 10.2;
    // Each scene's panel, packed into rows: a yard's is bigger.
    let size = |s: &Scene| if s.extent.is_some() { (5.1, 3.5) } else { (3.4, 2.0) };
    let mut placed = Vec::new();
    let (mut x, mut y, mut row) = (0.0, 0.0, 0.0f64);
    for s in all {
        let (w, h) = size(s);
        if x + w > width + 1e-9 {
            (x, y, row) = (0.0, y + row, 0.0);
        }
        placed.push((x, y));
        x += w;
        row = row.max(h);
    }
    let mut svg = format!(
        "<svg xmlns='http://www.w3.org/2000/svg' width='{:.0}' height='{:.0}' font-family='sans-serif' font-size='13'><rect width='100%' height='100%' fill='#8a6'/>",
        width * px,
        (y + row) * px
    );
    for (s, &(ox, oy)) in all.iter().zip(&placed) {
        let (pw, ph) = size(s);
        // The scene's x about the panel's middle, its y down from 0.8; y up.
        let at = |x: f64, y: f64| ((ox + x + pw / 2.0) * px, (oy + 0.8 - y) * px);
        let poly = |r: &Rect, style: &str| {
            let pts: Vec<String> = r.corners().iter().map(|&(x, y)| { let (a, b) = at(x, y); format!("{a:.1},{b:.1}") }).collect();
            format!("<polygon points='{}' {style}/>", pts.join(" "))
        };
        match &s.extent {
            Some(ground) => {
                for g in ground {
                    svg += &poly(g, "fill='#ccc'");
                }
            }
            None => {
                let (pvx, pvy) = at(-pw / 2.0, -HALF_ROAD);
                svg += &format!("<rect x='{pvx:.1}' y='{pvy:.1}' width='{:.1}' height='{:.1}' fill='#ccc'/>", pw * px, 0.75 * px);
            }
        }
        let (rx, ry) = at(-pw / 2.0, HALF_ROAD);
        svg += &format!("<rect x='{rx:.1}' y='{ry:.1}' width='{:.1}' height='{:.1}' fill='#777'/>", pw * px, 2.0 * HALF_ROAD * px);
        let (a, b) = (at(-pw / 2.0, 0.0), at(pw / 2.0, 0.0));
        svg += &format!("<line x1='{:.1}' y1='{:.1}' x2='{:.1}' y2='{:.1}' stroke='#fff' stroke-dasharray='8 8'/>", a.0, a.1, b.0, b.1);
        for b in &s.bays {
            svg += &poly(b, "fill='none' stroke='#fff' stroke-width='1.5'");
        }
        for (r, q) in &s.parked {
            for b in bodies(r, *q) {
                svg += &poly(&b, "fill='#456' stroke='#123'");
            }
        }
        let ps: Vec<(f64, Pose, bool)> = s.legs.iter().flat_map(|l| l.poses(&s.rig).into_iter().map(move |(_, p)| (0.0, p, l.back))).collect();
        let n = ps.len().max(2);
        for (k, (_, p, back)) in ps.iter().enumerate() {
            if k % 5 != 0 && k + 1 != ps.len() {
                continue;
            }
            let t = k as f64 / (n - 1) as f64;
            let colour = format!("rgb({:.0},70,{:.0})", 255.0 * t, 255.0 * (1.0 - t));
            for b in bodies(&s.rig, *p) {
                svg += &poly(&b, &format!("fill='none' stroke='{colour}' stroke-width='1' {}", if *back { "stroke-dasharray='3 2'" } else { "" }));
            }
        }
        let mut d = String::new();
        for (k, (_, p, _)) in ps.iter().enumerate() {
            let (x, y) = at(p.x, p.y);
            d += &format!("{}{x:.1},{y:.1} ", if k == 0 { "M" } else { "L" });
        }
        svg += &format!("<path d='{d}' fill='none' stroke='#000' stroke-width='1.5'/>");
        for l in s.legs.iter().skip(1) {
            let (x, y) = at(l.from.x, l.from.y);
            svg += &format!("<circle cx='{x:.1}' cy='{y:.1}' r='4' fill='#ff0' stroke='#000'/>");
        }
        let (tx, ty) = at(-pw / 2.0 + 0.05, 0.8 - 0.12);
        svg += &format!("<text x='{tx:.1}' y='{ty:.1}'>{}</text>", s.name);
        let (bx, by) = at(-pw / 2.0, 0.8);
        svg += &format!("<rect x='{bx:.1}' y='{by:.1}' width='{:.1}' height='{:.1}' fill='none' stroke='#000'/>", pw * px, ph * px);
    }
    svg += "</svg>";
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.dev/park");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("sheet.svg"), svg).unwrap();
}

