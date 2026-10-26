//! The tractor's runs over awkward land, drawn and measured. Each field in
//! `fields/*.txt` is a fixture's text (the key is in `fixtures.rs`) with a
//! farm on a street; the farm claims its land as in the game, and the
//! sweep is driven over it, ploughing and harvesting. A row of numbers a
//! field, and `.dev/fields/<name>.svg` drawn: the land, what is in the
//! way, and the run in a colour that goes from blue to red as it goes.
//!
//! `cargo test sweeps -- --nocapture`; `FIELD=03` runs those whose name
//! has that in it.

use std::path::Path;

use super::*;
use model::{BuildingKind, GameObject};

/// What a run comes to: steps for each tile worked, tiles driven again,
/// turns, and steps on the diagonal.
struct Measure {
    tiles: usize,
    steps: usize,
    again: usize,
    turns: usize,
    diagonal: usize,
}

fn measure(batch: &[GridCoord], path: &[GridCoord]) -> Measure {
    let mut seen = HashSet::default();
    Measure {
        tiles: batch.len(),
        steps: path.len() - 1,
        again: path.iter().filter(|t| !seen.insert((t.x, t.y))).count(),
        turns: path.windows(3).filter(|w| (w[1].x - w[0].x, w[1].y - w[0].y) != (w[2].x - w[1].x, w[2].y - w[1].y)).count(),
        diagonal: path.windows(2).filter(|w| w[0].x != w[1].x && w[0].y != w[1].y).count(),
    }
}

/// The field as its text lays it (+x to the left, +y up), the land
/// shaded, the headland darker, and the run over it.
fn svg(text: &str, land: &[GridCoord], head: &HashSet<(i32, i32)>, path: &[GridCoord]) -> String {
    const S: f64 = 24.0;
    let rows: Vec<Vec<char>> = text.lines().filter(|l| !l.starts_with('#')).map(|l| l.chars().collect()).filter(|r: &Vec<char>| !r.is_empty()).collect();
    let w = rows.iter().map(Vec::len).max().unwrap_or(0) as i32;
    let h = rows.len() as i32;
    let at = |t: GridCoord| ((w - 1 - t.x) as f64, (-t.y) as f64);
    let mut out = format!("<svg xmlns='http://www.w3.org/2000/svg' width='{}' height='{}'>", w as f64 * S, h as f64 * S);
    for (row, line) in rows.iter().enumerate() {
        for (col, &c) in line.iter().enumerate() {
            let fill = match c {
                'T' => "#3f6b3a",
                '~' | '≈' => "#7fb0d0",
                '=' | '#' => "#8a8a8a",
                '.' | '_' | ':' => "#cfe0b0",
                _ => "#a07850",
            };
            out += &format!("<rect x='{}' y='{}' width='{S}' height='{S}' fill='{fill}'/>", col as f64 * S, row as f64 * S);
        }
    }
    for t in land {
        let (x, y) = at(*t);
        let fill = if head.contains(&(t.x, t.y)) { "#d9b45a" } else { "#efd27c" };
        out += &format!("<rect x='{}' y='{}' width='{S}' height='{S}' fill='{fill}' stroke='#c9a64a' stroke-width='0.5'/>", x * S, y * S);
    }
    // Each visit to a tile a little further down and right of its middle,
    // so a tile driven again shows twice, and an arrow on each step.
    let mut visits: fixed::HashMap<(i32, i32), usize> = Default::default();
    let points: Vec<(f64, f64)> = path.iter().map(|t| {
        let k = visits.entry((t.x, t.y)).or_insert(0);
        *k += 1;
        let (x, y) = at(*t);
        let o = 0.3 + 0.18 * (*k - 1).min(3) as f64;
        ((x + o) * S, (y + o) * S)
    }).collect();
    out += "<defs><marker id='a' viewBox='0 0 10 10' refX='5' refY='5' markerWidth='3' markerHeight='3' orient='auto'><path d='M0,0L10,5L0,10z' fill='context-stroke'/></marker></defs>";
    let n = path.len().max(2) - 1;
    for (i, pair) in points.windows(2).enumerate() {
        let ((x0, y0), (x1, y1)) = (pair[0], pair[1]);
        let hue = 240.0 * (1.0 - i as f64 / n as f64);
        out += &format!(
            "<line x1='{x0:.1}' y1='{y0:.1}' x2='{x1:.1}' y2='{y1:.1}' stroke='hsl({hue:.0},80%,45%)' stroke-width='2' stroke-linecap='round' marker-end='url(#a)'/>"
        );
    }
    if let Some(&start) = path.first() {
        let (x, y) = at(start);
        out += &format!("<circle cx='{}' cy='{}' r='5' fill='black'/>", (x + 0.5) * S, (y + 0.5) * S);
    }
    out + "</svg>"
}

#[test]
fn sweeps() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fields");
    let draw = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.dev/fields");
    std::fs::create_dir_all(&draw).unwrap();
    let only = std::env::var("FIELD").ok();
    let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "txt")).collect();
    files.sort();
    println!("{:<20} {:>7} {:>6} {:>6} {:>8} {:>6} {:>6}", "field", "job", "tiles", "steps", "a tile", "again", "turns");
    for file in files {
        let name = file.file_stem().unwrap().to_string_lossy().into_owned();
        if only.as_ref().is_some_and(|o| !name.contains(o.as_str())) {
            continue;
        }
        let text = std::fs::read_to_string(&file).unwrap();
        let mut world = Map::new();
        crate::fixtures::build_text(&mut world, &text);
        let farm = world.objects.iter().find(|e| matches!(e.object, GameObject::Building(ref b) if b.kind == BuildingKind::Farm)).map(|e| e.id).expect("a farm");
        // What was built on its land after it claimed it is land no more.
        world.tend(farm);
        let batch: Vec<GridCoord> = match world.objects.get(farm).map(|e| &e.object) {
            Some(GameObject::Building(b)) => b.land.iter().map(|t| t.at).collect(),
            _ => Vec::new(),
        };
        assert!(!batch.is_empty(), "{name}: the farm claimed no land");
        let set: HashSet<(i32, i32)> = batch.iter().map(|t| (t.x, t.y)).collect();
        let head: HashSet<(i32, i32)> = outlines(&set).into_iter().flatten().map(|t| (t.x, t.y)).collect();
        let ground = world.drivable(farm);
        let gate = world.yard_gate(farm, &batch).unwrap();
        for job in [Job::Plough, Job::Harvest] {
            let (path, left) = world.sweep(farm, gate, &batch, job).expect("a sweep");
            let m = measure(&batch, &path);
            println!("{name:<20} {:>7} {:>6} {:>6} {:>8.2} {:>6} {:>6}  {} diagonal, {} left", format!("{job:?}"), m.tiles, m.steps, m.steps as f64 / m.tiles as f64, m.again, m.turns, m.diagonal, left.len());
            std::fs::write(draw.join(format!("{name}-{job:?}.svg").to_lowercase()), svg(&text, &batch, &head, &path)).unwrap();
            assert!(left.is_empty(), "{name} {job:?}: tiles left: {left:?}");
            assert!(path.windows(2).all(|w| dist(w[0], w[1]) == 1), "{name} {job:?}: a step is not to a neighbour");
            assert!(path.iter().all(|t| ground.contains(&(t.x, t.y))), "{name} {job:?}: the tractor left the farm's ground");
            assert!(!path.windows(3).any(|w| (w[1].x - w[0].x) * (w[2].x - w[1].x) + (w[1].y - w[0].y) * (w[2].y - w[1].y) < 0), "{name} {job:?}: a turn sharper than a right angle");
            assert!(m.steps * 100 < m.tiles * 180, "{name} {job:?}: {} steps for {} tiles", m.steps, m.tiles);
            // Harvesting, the headland round on its own before any row:
            // but for a few tiles crossed between one outline and the
            // next, no standing crop is cut until the ring is done.
            if job == Job::Harvest {
                let inside = batch.iter().filter(|t| !head.contains(&(t.x, t.y))).count();
                let done = batch.iter().filter(|t| head.contains(&(t.x, t.y))).map(|t| path.iter().position(|p| p == t).unwrap()).max().unwrap();
                let crossed: HashSet<(i32, i32)> = path[..done].iter().map(|t| (t.x, t.y)).filter(|t| set.contains(t) && !head.contains(t)).collect();
                assert!(crossed.len() * 5 <= inside, "{name}: {} standing tiles cut before the headland was done", crossed.len());
            }
        }
    }
}
