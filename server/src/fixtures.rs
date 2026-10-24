//! Test towns for the look: small maps drawn as text in `fixtures/`, built
//! side by side on open grass through the same calls the mayor's hand makes,
//! so what the client draws of them is what it would draw of a real town.
//!
//! `SPRAWL_FIXTURES=fixtures` starts the server on them instead of a seed.
//! The script beside the client (`bun run shots`) points the camera at each
//! one in turn and lays the pictures out on one sheet. `draw` is the other
//! way: any part of the running game as a fixture's text (`/map`).
//!
//! A fixture is a grid, one character a tile, top row north:
//!
//! ```text
//! .  grass     ~  water     ≈  sea       T  forest    _  beach     ^  mountain
//! :  paved (a yard or a car park; grass to the server, drawn by `bun run plan`)
//! =  street    #  road (a through route)
//! H house  A apartment  S shop  O office  F factory  G gas station
//! M supermarket  D depot  P harbour  W sawmill  Q quarry  B farm
//! d  (any letter small) that building's yard, as `/map` writes the game's
//! ```
//!
//! A building's letters are its tiles, on grass, but a harbour's beside
//! the sea, which stand on it: a kind bigger than a tile is one
//! building as far as its letter runs, of whatever shape, which the hand
//! cannot place but the look must draw; a house is a house a tile. Lines starting with `#` are the fixture's
//! description; the first is its title.

use std::path::Path;
use std::sync::OnceLock;

use serde::Serialize;

use crate::protocol::{BuildingKind, GameObject, GridCoord, TerrainType};
use crate::world::World;

/// Grass left between one fixture and the next, and round them all.
const GAP: i32 = 8;

/// Where a fixture was built, for the camera.
#[derive(Serialize, Clone)]
pub struct Placed {
    pub name: String,
    pub title: String,
    /// Its north-west corner and its size, in tiles.
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// The fixtures this server built, if it built any.
pub static PLACED: OnceLock<Vec<Placed>> = OnceLock::new();

fn building(c: char) -> Option<BuildingKind> {
    use BuildingKind::*;
    Some(match c.to_ascii_uppercase() {
        'H' => House,
        'A' => Apartment,
        'S' => Shop,
        'O' => Office,
        'F' => Factory,
        'G' => GasStation,
        'M' => Supermarket,
        'D' => Depot,
        'P' => Harbour,
        'W' => Sawmill,
        'Q' => Quarry,
        'B' => Farm,
        _ => return None,
    })
}

fn letter(kind: BuildingKind) -> char {
    "HASOFGMDPWQB".chars().find(|&c| building(c) == Some(kind)).unwrap_or('?')
}

fn ground(c: char) -> TerrainType {
    match c {
        '~' => TerrainType::Water,
        '≈' => TerrainType::Sea,
        'T' => TerrainType::Forest,
        '_' => TerrainType::Beach,
        '^' => TerrainType::Mountain,
        _ => TerrainType::Grass,
    }
}

/// Build every fixture in `dir` into an empty world, west to east in name
/// order, and remember where each went.
pub fn build(world: &mut World, dir: &Path) {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("fixtures: cannot read {}: {e}", dir.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "txt"))
        .collect();
    files.sort();

    let mut placed = Vec::new();
    let mut x0 = 0;
    for path in files {
        let text = std::fs::read_to_string(&path).unwrap();
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        let (w, h, title) = lay(world, &text, x0, &name);
        placed.push(Placed { name, title, x: x0, y: 0, w, h });
        x0 += w + GAP;
    }
    finish_sites(world);
    till_farms(world);
    println!("fixtures: built {} from {}", placed.len(), dir.display());
    let _ = PLACED.set(placed);
}

/// One fixture's text built into the world with its north-west corner at
/// `x0`: its size, and its title.
pub fn lay(world: &mut World, text: &str, x0: i32, name: &str) -> (i32, i32, String) {
    let (notes, rows): (Vec<&str>, Vec<&str>) = text.lines().partition(|l| l.starts_with('#'));
    let rows: Vec<Vec<char>> = rows.iter().map(|r| r.chars().filter(|c| !c.is_whitespace()).collect()).filter(|r: &Vec<char>| !r.is_empty()).collect();
    let w = rows.iter().map(Vec::len).max().unwrap_or(0) as i32;
    let h = rows.len() as i32;
    // The map is drawn with +x to the left of the screen and +y up, so
    // a fixture is laid right to left to be seen as it is written.
    let at = |col: i32, row: i32| GridCoord { x: x0 + w - 1 - col, y: -row };
    let char_at = |col: i32, row: i32| rows.get(row as usize).and_then(|r| r.get(col as usize)).copied().unwrap_or('.');

    // A harbour stands half on the water: its tiles beside the sea are
    // built out over it.
    let sea = |col: i32, row: i32| [(1, 0), (-1, 0), (0, 1), (0, -1)].iter().any(|&(dc, dr)| char_at(col + dc, row + dr) == '≈');
    for row in -GAP..h + GAP {
        for col in -GAP..w + GAP {
            let p = at(col, row);
            let c = char_at(col, row);
            let g = if building(c) == Some(BuildingKind::Harbour) && sea(col, row) { TerrainType::Sea } else { ground(c) };
            world.terrain.insert((p.x, p.y), g);
        }
    }

    // Every road tile joins the road tiles beside it, and those on its
    // diagonals where no tile beside both already joins them, so a
    // street may run at an angle. Through roads first: a node is a
    // through road if it was first laid as one, so a joint is `#` only
    // where both its tiles are.
    let road = |col: i32, row: i32| matches!(char_at(col, row), '=' | '#');
    let through = |col: i32, row: i32| char_at(col, row) == '#';
    for pass in [true, false] {
        for row in 0..h {
            for col in 0..w {
                if !road(col, row) {
                    continue;
                }
                for (dc, dr) in [(1, 0), (0, 1), (1, 1), (-1, 1)] {
                    let (c, r) = (col + dc, row + dr);
                    let beside = dc != 0 && dr != 0 && (road(col + dc, row) || road(col, row + dr));
                    if road(c, r) && !beside && (through(col, row) && through(c, r)) == pass {
                        world.place_road_path_of(&[at(col, row), at(c, r)], pass);
                    }
                }
            }
        }
    }

    // Each run of a letter, beside or diagonal, is one building, a
    // kind one tile big a building a tile: a row of houses is houses.
    // Its front faces the first street it has, its back the sea.
    let mut built = crate::fixed::HashSet::default();
    for row in 0..h {
        for col in 0..w {
            let Some(kind) = building(char_at(col, row)) else { continue };
            if !built.insert((col, row)) {
                continue;
            }
            let mut run = vec![(col, row)];
            let mut i = 0;
            while i < run.len() && crate::blueprint::plot(kind, 0).size != (1, 1) {
                let (c, r) = run[i];
                for (dc, dr) in [(1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1)] {
                    let n = (c + dc, r + dr);
                    if building(char_at(n.0, n.1)) == Some(kind) && built.insert(n) {
                        run.push(n);
                    }
                }
                i += 1;
            }
            let tiles: Vec<GridCoord> = run.iter().map(|&(c, r)| at(c, r)).collect();
            let quay = crate::blueprint::blueprint(kind).quay;
            // Its yard where its small letters are, as `/map` writes
            // a game's; else toward the first street it has.
            let mut marked: Vec<GridCoord> = run.iter().filter(|&&(c, r)| char_at(c, r).is_ascii_lowercase()).map(|&(c, r)| at(c, r)).collect();
            marked.sort_by_key(|t| (t.x, t.y));
            let yard = |f: u8| World::yard_of(&tiles, kind, f).map(|mut y| { y.sort_by_key(|t| (t.x, t.y)); y });
            let facing = (0..4)
                .find(|&f| !marked.is_empty() && yard(f).as_ref() == Some(&marked))
                .or_else(|| (0..4).find(|&f| world.driveway_for(&tiles, kind, f).is_some() && (!quay || world.berth_at(&tiles, kind, f).is_some())))
                .unwrap_or(2);
            if !world.may_stand_on(&tiles, kind, facing) {
                println!("fixtures: {name}: no room for {kind:?} at column {col}, row {row}");
                continue;
            }
            world.raise(kind, tiles, facing);
        }
    }

    // Every network leads off the map: the first road of each, reading
    // west to east down the columns, is an exit, and everything it
    // reaches is joined. A real place cut out of a map is many.
    for (col, row) in (0..w).flat_map(|col| (0..h).map(move |row| (col, row))) {
        let Some(node) = world.road_node_at(at(col, row)) else { continue };
        let joined = matches!(world.objects.get(node).map(|e| &e.object), Some(GameObject::RoadNode(n)) if n.joined);
        if !joined {
            world.open_exit(node);
        }
    }
    let title = notes.first().map(|n| n.trim_start_matches('#').trim().to_string()).unwrap_or_else(|| name.to_string());
    (w, h, title)
}

/// One fixture from its text alone, standing as written: a world for
/// whatever has no files to read.
#[cfg(test)]
pub fn build_text(world: &mut World, text: &str) {
    lay(world, text, 0, "fixture");
    finish_sites(world);
}

/// When fixtures stand still: noon, on the third day, so a field sown
/// two days before can stand ripe.
pub const NOON: crate::engine::GameTime = crate::protocol::DAY_MS as crate::engine::GameTime * 5 / 2;

/// The farms, east to west as a fixture reads, each worked to the next
/// stage of the cycle, so one row of them shows every look a field has:
/// ploughed; sown just now, a quarter grown, green, ripe; cut; and the
/// tractor half way through a harvest, and through ploughing the stubble.
fn till_farms(world: &mut World) {
    use crate::protocol::Job::*;
    use crate::world::fields::RIPEN;
    let now = NOON;
    let sown = |k: f64| now - (RIPEN as f64 * k) as crate::engine::GameTime;
    let mut farms: Vec<(i32, crate::protocol::EntityId)> = world.objects.iter().filter_map(|e| match e.object {
        GameObject::Building(ref b) if b.kind == BuildingKind::Farm => Some((-e.position?.x, e.id)),
        _ => None,
    }).collect();
    farms.sort();
    for (i, (_, farm)) in farms.into_iter().enumerate() {
        let (jobs, going): (Vec<_>, _) = match i % 8 {
            0 => (vec![(Plough, now)], None),
            1 => (vec![(Plough, 0), (Seed, sown(0.02))], None),
            2 => (vec![(Plough, 0), (Seed, sown(0.3))], None),
            3 => (vec![(Plough, 0), (Seed, sown(0.6))], None),
            4 => (vec![(Plough, 0), (Seed, 0)], None),
            5 => (vec![(Plough, 0), (Seed, 0), (Harvest, now)], None),
            6 => (vec![(Plough, 0), (Seed, 0)], Some((Harvest, 0.5))),
            _ => (vec![(Plough, 0), (Seed, 0), (Harvest, 0)], Some((Plough, 0.5))),
        };
        world.play(farm, &jobs, going, now);
    }
}

/// A town written by hand stands as written: no site waits for its
/// materials.
fn finish_sites(world: &mut World) {
    let sites: Vec<_> = world.objects.iter().filter(|e| matches!(e.object, GameObject::Building(ref b) if b.site.is_some())).map(|e| e.id).collect();
    for id in sites {
        world.finish(id);
    }
}

/// The tiles within `r` of a point as a fixture's text, laid out as the map
/// is seen (+x to the left, +y up), so it reads, and draws, as the game
/// does. A building is its letter, its lot or yard paved. The first line names the
/// game's tile at column 0, row 0: a column on is a tile less of x, a row
/// on a tile less of y.
pub fn draw(world: &World, x: i32, y: i32, r: i32) -> String {
    let mut out = format!("# The game round {x},{y}\n# origin {},{}\n", x + r, y + r);
    for ty in (y - r..=y + r).rev() {
        for tx in (x - r..=x + r).rev() {
            let road = world.road_node_at(GridCoord { x: tx, y: ty }).and_then(|id| world.objects.get(id));
            let built = world.occupied.get(&(tx, ty)).and_then(|&id| world.objects.get(id));
            out.push(match (road.map(|e| &e.object), built.map(|e| &e.object)) {
                // A building is its letter on every tile, its yard's in
                // small letters, where the game lays its lot.
                (_, Some(GameObject::Building(b))) => match World::yard_of(&b.tiles, b.kind, b.facing) {
                    Some(yard) if yard.contains(&GridCoord { x: tx, y: ty }) => letter(b.kind).to_ascii_lowercase(),
                    _ => letter(b.kind),
                },
                (Some(GameObject::RoadNode(n)), _) => if n.road.is_empty() { '=' } else { '#' },
                _ => match world.terrain.get(&(tx, ty)) {
                    Some(TerrainType::Water) => '~',
                    Some(TerrainType::Sea) => '≈',
                    Some(TerrainType::Forest) => 'T',
                    Some(TerrainType::Beach) => '_',
                    Some(TerrainType::Mountain) => '^',
                    _ => '.',
                },
            });
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every fixture builds as it is written: each letter a tile of the
    /// building it names, and `/map` gives the letters and the ground back
    /// where they were, so what `bun run plan` draws is what the server
    /// stands up, and a fixture made from the game builds as it stood.
    #[test]
    fn every_fixture_builds_letter_for_letter() {
        let dir = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures"));
        let mut world = World::new();
        build(&mut world, dir);
        let mut wrong = Vec::new();
        for (p, path) in PLACED.get().unwrap().iter().zip(std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "txt")).collect::<std::collections::BTreeSet<_>>()) {
            let text = std::fs::read_to_string(&path).unwrap();
            let rows: Vec<Vec<char>> = text.lines().filter(|l| !l.starts_with('#')).map(|r| r.chars().filter(|c| !c.is_whitespace()).collect()).filter(|r: &Vec<char>| !r.is_empty()).collect();
            for (row, line) in rows.iter().enumerate() {
                for (col, &c) in line.iter().enumerate() {
                    let at = GridCoord { x: p.x + p.w - 1 - col as i32, y: -(row as i32) };
                    let built = world.occupied.get(&(at.x, at.y)).and_then(|&id| match world.objects.get(id).map(|e| &e.object) {
                        Some(GameObject::Building(b)) => Some(letter(b.kind)),
                        _ => None,
                    });
                    if building(c).map(|_| c) != built {
                        wrong.push(format!("{} col {col} row {row}: {c} built {built:?}", p.name));
                    }
                    let drawn = draw(&world, at.x, at.y, 0).lines().last().and_then(|l| l.chars().next());
                    if "~≈T_^".contains(c) && drawn != Some(c) {
                        wrong.push(format!("{} col {col} row {row}: {c} drawn {drawn:?}", p.name));
                    }
                }
            }
        }
        assert!(wrong.is_empty(), "{} tiles not as written:\n{}", wrong.len(), wrong.join("\n"));
    }
}
