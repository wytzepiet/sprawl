use super::*;
use std::f64::consts::FRAC_PI_2;

/// The plan driven, every pose on the lot; and drawn, with `DRAW=1`, in
/// `.dev/park/<name>.svg`.
fn check(name: &str, rig: &Rig, lot: &Lot, from: Pose, moves: &[Move]) -> Vec<(f64, Pose)> {
    let path = drive(rig, from, moves);
    let field = Field::new(lot);
    for &(s, p) in &path {
        assert!(field.fits(rig, p), "{name}: off the lot or into a wall {s:.2} along: {p:?}\n{moves:?}");
    }
    if std::env::var("DRAW").is_ok() {
        draw(name, rig, lot, &path);
    }
    path
}

fn draw(name: &str, rig: &Rig, lot: &Lot, path: &[(f64, Pose)]) {
    let px = 160.0;
    let (x0, y0, x1, y1) = lot.ground.iter().flat_map(|g| g.corners()).fold((f64::MAX, f64::MAX, f64::MIN, f64::MIN), |(a, b, c, d), (x, y)| (a.min(x), b.min(y), c.max(x), d.max(y)));
    let poly = |r: &Rect, fill: &str, extra: &str| {
        let pts: Vec<String> = r.corners().iter().map(|(x, y)| format!("{:.1},{:.1}", (x - x0) * px, (y1 - y) * px)).collect();
        format!("<polygon points='{}' fill='{fill}' {extra}/>", pts.join(" "))
    };
    let mut svg = format!("<svg xmlns='http://www.w3.org/2000/svg' width='{:.0}' height='{:.0}'><rect width='100%' height='100%' fill='#5a7'/>", (x1 - x0) * px, (y1 - y0) * px);
    svg += &lot.ground.iter().map(|g| poly(g, "#bbb", "")).collect::<String>();
    svg += &lot.walls.iter().map(|w| poly(w, "#544", "")).collect::<String>();
    let total = path.last().map_or(1.0, |p| p.0).max(1e-9);
    let mut next = 0.0;
    for &(s, p) in path {
        if s + 1e-9 < next && s < total {
            continue;
        }
        next = s + 0.12;
        let t = s / total;
        let colour = format!("rgb({:.0},60,{:.0})", 255.0 * t, 255.0 * (1.0 - t));
        for b in bodies(rig, p) {
            svg += &poly(&b, "none", &format!("stroke='{colour}' stroke-width='1.2'"));
        }
    }
    let mut d = String::new();
    for (i, &(_, p)) in path.iter().enumerate() {
        d += &format!("{}{:.1},{:.1} ", if i == 0 { "M" } else { "L" }, (p.x - x0) * px, (y1 - p.y) * px);
    }
    svg += &format!("<path d='{d}' fill='none' stroke='#000' stroke-width='1'/></svg>");
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.dev/park");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{name}.svg")), svg).unwrap();
}

/// A car among parked cars, standing: a rectangle on its spot.
fn parked(x: f64, y: f64, heading: f64) -> Rect {
    let b = bodies(&CAR, Pose::new(x, y, heading)).next().unwrap();
    Rect { half_l: b.half_l + 0.01, half_w: b.half_w + 0.01, ..b }
}

/// Where the car stands in a bay, nose to the wall: its axle.
fn in_bay(x: f64, wall: f64) -> Pose {
    Pose::new(x, wall - 0.02 - CAR.cab.ahead, FRAC_PI_2)
}

/// A shop's car park: an aisle a tile wide, and a row of bays along it
/// with cars in every other. A car comes along the aisle, turns in and
/// parks nose first; leaving, it backs out and drives off.
#[test]
fn a_car_parks_in_a_bay_between_two_cars() {
    let lot = Lot {
        ground: vec![Rect::span(0.0, 0.0, 3.0, 1.0), Rect::span(0.0, 1.0, 3.0, 1.5)],
        walls: [1.0, 1.5, 2.0].iter().map(|&x| parked(x, in_bay(x, 1.5).y, FRAC_PI_2)).collect(),
    };
    let bay = in_bay(1.25, 1.5);
    let lane = Goal { pose: Pose::new(0.4, 0.5, 0.0), reach: 0.15, along: 0.15, turn: 0.2 };
    let out = plan(&CAR, &Field::new(&lot), bay, &lane).expect("a way out");
    let path = check("car-out-of-bay", &CAR, &lot, bay, &out);
    assert!(out[0].back, "backed out: {out:?}");
    // Coming in is the way out driven backwards: in nose first.
    assert!(!out[0].back || out.len() > 1, "{out:?}");
    assert_eq!(path[0].1, bay);
}

/// A gap at the kerb half as long again as a car, between two parked cars:
/// out with a shunt, so in by backing, as a driver does it.
#[test]
fn a_car_parks_at_the_kerb_between_two_cars() {
    let lot = Lot {
        ground: vec![Rect::span(-1.0, 0.0, 3.0, 0.5), Rect::span(-1.0, 0.5, 3.0, 0.7)],
        walls: vec![parked(0.3, 0.6, 0.0), parked(1.02, 0.6, 0.0), Rect::span(-1.0, 0.7, 3.0, 0.8)],
    };
    // A gap half as long again as the car: its middle at 0.76.
    let gap = Pose::new(0.757 - 0.29 / 3.0, 0.6, 0.0);
    let lane = Goal { pose: Pose::new(1.6, 0.36, 0.0), reach: 0.25, along: 0.25, turn: 0.15 };
    let out = plan(&CAR, &Field::new(&lot), gap, &lane).expect("a way out");
    check("kerb-out", &CAR, &lot, gap, &out);
    assert!(out.iter().any(|m| m.back), "the gap is too short to drive out of nose first: {out:?}");
}

/// A depot's yard, three tiles wide and two deep, its gate onto the street
/// at the top: a lorry backs its trailer square against the back wall,
/// and pulls out again.
#[test]
fn a_lorry_backs_square_to_a_dock() {
    let lot = Lot { ground: vec![Rect::span(0.0, 0.0, 3.0, 2.0), Rect::span(-1.0, 2.0, 4.0, 3.0)], walls: vec![Rect::span(-1.0, 1.9, 1.0, 2.0), Rect::span(2.0, 1.9, 4.0, 2.0)] };
    let t = LORRY.trailer.unwrap();
    for x in [0.3, 0.8, 1.5, 2.2, 2.7] {
        let dock = Pose::new(x, 0.02 + t.body.behind + t.length, FRAC_PI_2);
        let street = Goal { pose: Pose::new(2.5, 2.6, 0.0), reach: 0.3, along: 0.3, turn: 0.25 };
        let out = plan(&LORRY, &Field::new(&lot), dock, &street).unwrap_or_else(|| panic!("no way out of the dock at {x}"));
        // Backing in is the way out played backwards: a trailer backed by
        // the numbers would wander off, as a real one does.
        let path = check(&format!("dock-{x}"), &LORRY, &lot, dock, &out);
        let fold = path.iter().map(|(_, p)| wrap(p.heading - p.trailer).abs()).fold(0.0, f64::max);
        assert!(fold < t.fold, "folds {fold:.2} at {x}");
        assert!(!out[0].back, "tail first into the dock, so out of it nose first, at {x}: {out:?}");
    }
}

/// A dead end too narrow to turn round in at a stroke: turned in three.
#[test]
fn a_car_turns_round_in_a_dead_end() {
    let lot = Lot { ground: vec![Rect::span(0.0, 0.0, 3.0, 0.45)], walls: vec![] };
    let from = Pose::new(2.3, 0.225, 0.0);
    let goal = Goal { pose: Pose::new(1.0, 0.225, PI), reach: 0.2, along: 0.2, turn: 0.15 };
    let moves = plan(&CAR, &Field::new(&lot), from, &goal).expect("turned round");
    check("dead-end", &CAR, &lot, from, &moves);
    assert!(moves.windows(2).filter(|w| w[0].back != w[1].back).count() >= 2, "three goes at least: {moves:?}");
}

/// The same lot, the same plan: nothing in it depends on the machine.
#[test]
fn the_same_lot_plans_the_same() {
    let lot = Lot { ground: vec![Rect::span(0.0, 0.0, 3.0, 1.0), Rect::span(0.0, 1.0, 3.0, 1.5)], walls: vec![] };
    let (from, goal) = (in_bay(1.25, 1.5), Goal { pose: Pose::new(0.4, 0.5, 0.0), reach: 0.15, along: 0.15, turn: 0.2 });
    assert_eq!(plan(&CAR, &Field::new(&lot), from, &goal), plan(&CAR, &Field::new(&lot), from, &goal));
}

/// The wheel eased at a hand's pace: the path barely moves, and stays on
/// the lot.
#[test]
fn a_smoothed_plan_still_fits() {
    let lot = Lot { ground: vec![Rect::span(0.0, 0.0, 3.0, 1.0), Rect::span(0.0, 1.0, 3.0, 1.5)], walls: vec![] };
    let bay = in_bay(1.25, 1.5);
    let out = plan(&CAR, &Field::new(&lot), bay, &Goal { pose: Pose::new(0.4, 0.5, 0.0), reach: 0.15, along: 0.15, turn: 0.2 }).unwrap();
    let eased = smooth(&CAR, &Field::new(&lot), bay, &out);
    check("smoothed", &CAR, &lot, bay, &eased);
    for w in eased.windows(2).filter(|w| w[0].back == w[1].back) {
        assert!((w[0].to - w[1].from).abs() < 1e-9, "the wheel jumps: {w:?}");
    }
}


/// A depot's yard behind its fence, the gate onto the street: out of each
/// dock onto the street's lane, either way, forward. A lorry coming in
/// pulls past the gate and backs in: the same way, played backwards.
#[test]
fn a_lorry_drives_out_of_each_dock_onto_the_street() {
    let docks: Vec<Pose> = [0.55, 0.85, 1.15, 1.45].iter().flat_map(|&s| [1.0, -1.0].map(|side: f64| Pose::new(1.5 + side * 0.9, 2.0 - s, if side > 0.0 { PI } else { 0.0 }))).collect();
    let docked = |p: &Pose| bodies(&LORRY, *p).map(|b| Rect { half_l: b.half_l + 0.005, half_w: b.half_w + 0.005, ..b }).collect::<Vec<_>>();
    let start = std::time::Instant::now();
    for (i, dock) in docks.iter().enumerate() {
        let lot = Lot {
            ground: vec![Rect::span(0.0, 0.0, 3.0, 2.0), Rect::span(1.0, -0.05, 2.0, 0.0), Rect::span(-2.0, -1.0, 5.0, -0.05)],
            walls: docks.iter().enumerate().filter(|&(j, _)| j != i).flat_map(|(_, p)| docked(p)).collect(),
        };
        let field = Field::new(&lot);
        for (d, lane) in [(1.0, -0.6), (-1.0, -0.4)] {
            let goal = Goal { pose: Pose::new(1.5 + d * 1.1, lane, if d > 0.0 { 0.0 } else { PI }), reach: 0.04, along: 0.4, turn: 0.06 };
            let t0 = std::time::Instant::now();
            let out = plan(&LORRY, &field, *dock, &goal);
            let out = out.unwrap_or_else(|| panic!("no way out of dock {i} going {d}"));
            eprintln!("dock {i} going {d}: {:?}", t0.elapsed());
            check(&format!("street-{i}-{d}"), &LORRY, &lot, *dock, &out);
            assert!(!out[0].back, "out of the dock nose first: {out:?}");
        }
    }
    eprintln!("all {:?}", start.elapsed());
}
