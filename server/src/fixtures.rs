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
//! .  grass     ~  water     T  forest    _  beach     ^  mountain
//! :  paved (a yard or a car park; grass to the server, drawn by the sandbox)
//! =  street    #  road (a through route)
//! H house  A apartment  S shop  O office  W workshop  F factory
//! R restaurant  B bar  G gas station  M supermarket  D warehouse  P port
//! ```
//!
//! A building's letters are its tiles, painted in one stroke as the mayor
//! would: a kind that grows is one building as far as its letter runs, a
//! house a house a tile. Lines starting with `#` are the fixture's
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
    Some(match c {
        'H' => House,
        'A' => Apartment,
        'S' => Shop,
        'O' => Office,
        'W' => Workshop,
        'F' => Factory,
        'R' => Restaurant,
        'B' => Bar,
        'G' => GasStation,
        'M' => Supermarket,
        'D' => Warehouse,
        'P' => Port,
        _ => return None,
    })
}

fn letter(kind: BuildingKind) -> char {
    "HASOWFRBGMDP".chars().find(|&c| building(c) == Some(kind)).unwrap_or('?')
}

fn ground(c: char) -> TerrainType {
    match c {
        '~' => TerrainType::Water,
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
        let (notes, rows): (Vec<&str>, Vec<&str>) = text.lines().partition(|l| l.starts_with('#'));
        let rows: Vec<Vec<char>> = rows.iter().map(|r| r.chars().filter(|c| !c.is_whitespace()).collect()).filter(|r: &Vec<char>| !r.is_empty()).collect();
        let w = rows.iter().map(Vec::len).max().unwrap_or(0) as i32;
        let h = rows.len() as i32;
        // The map is drawn with +x to the left of the screen and +y up, so
        // a fixture is laid right to left to be seen as it is written.
        let at = |col: i32, row: i32| GridCoord { x: x0 + w - 1 - col, y: -row };
        let char_at = |col: i32, row: i32| rows.get(row as usize).and_then(|r| r.get(col as usize)).copied().unwrap_or('.');

        for row in -GAP..h + GAP {
            for col in -GAP..w + GAP {
                let p = at(col, row);
                world.terrain.insert((p.x, p.y), ground(char_at(col, row)));
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

        // Painted as the mayor would: each run of a letter in one stroke,
        // from tile to tile beside or diagonal, so a kind that grows is one
        // building as far as its letter runs, and a house is a house a tile.
        let mut painted = std::collections::HashSet::new();
        for row in 0..h {
            for col in 0..w {
                let Some(kind) = building(char_at(col, row)) else { continue };
                if !painted.insert((col, row)) {
                    continue;
                }
                let mut stroke = vec![((col, row), (col, row))];
                let mut i = 0;
                while i < stroke.len() {
                    let ((c, r), from) = stroke[i];
                    if world.paint(kind, at(from.0, from.1), at(c, r)).is_none() {
                        println!("fixtures: {}: no room for {kind:?} at column {c}, row {r}", path.display());
                    }
                    for (dc, dr) in [(1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1)] {
                        let n = (c + dc, r + dr);
                        if building(char_at(n.0, n.1)) == Some(kind) && painted.insert(n) {
                            stroke.push((n, (c, r)));
                        }
                    }
                    i += 1;
                }
            }
        }

        for row in [0, h] {
            for col in [0, w] {
                world.reveal_around(at(col, row));
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
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        let title = notes.first().map(|n| n.trim_start_matches('#').trim().to_string()).unwrap_or_else(|| name.clone());
        placed.push(Placed { name, title, x: x0, y: 0, w, h });
        x0 += w + GAP;
    }
    println!("fixtures: built {} from {}", placed.len(), dir.display());
    let _ = PLACED.set(placed);
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
                // A building is its letter on every tile, its driveway
                // included, which is road on its own tile; its yard is
                // worked out from its shape, as the town grid does.
                (_, Some(GameObject::Building(b))) => letter(b.kind),
                (Some(GameObject::RoadNode(n)), _) => if n.road { '#' } else { '=' },
                _ => match world.terrain.get(&(tx, ty)) {
                    Some(TerrainType::Sea | TerrainType::Water) => '~',
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
    /// building it names, and `/map` gives the letters back where they
    /// were, so what the sandbox paints is what the server stands up.
    #[test]
    fn every_fixture_builds_letter_for_letter() {
        let mut world = World::new();
        build(&mut world, Path::new("fixtures"));
        let mut wrong = Vec::new();
        for (p, path) in PLACED.get().unwrap().iter().zip(std::fs::read_dir("fixtures").unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "txt")).collect::<std::collections::BTreeSet<_>>()) {
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
                }
            }
        }
        assert!(wrong.is_empty(), "{} tiles not as written:\n{}", wrong.len(), wrong.join("\n"));
    }
}
