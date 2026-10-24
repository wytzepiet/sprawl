//! Where the hand may go, as the game sees it: what the brush shows before
//! it acts (`Ask`), answered by the same rules that refuse it
//! (`hand::may_step`, `draw::plan`, `World::fit`), so the dots and the
//! world never part. The client asks as the view moves, as a drag goes on,
//! and as a building is held; it waits for the answer.

use crate::draw::{self, STEPS};
use crate::protocol::{Area, Ask, Build, GridCoord, Hint, Holding, OwnerId, Stand, Stroke, Tool};
use crate::world::World;

/// The most tiles an area asked about may hold: a view zoomed far out.
const MOST: i64 = 40_000;

pub fn answer(world: &World, owner: OwnerId, ask: Ask) -> Hint {
    match ask {
        Ask::Starts { hand, area } => {
            let tiles = if (area.x1 - area.x0 + 1) as i64 * (area.y1 - area.y0 + 1) as i64 > MOST { Vec::new() } else { starts(world, hand, area) };
            Hint::Starts { hand, area, tiles }
        }
        Ask::Reach(stroke) => {
            let ways = match stroke.tool {
                Tool::Street | Tool::OneWay | Tool::Wide => draw::reach(world, owner, &stroke),
                Tool::Demolish => erase(world, &stroke),
                Tool::Light => vec![None; 8],
            };
            Hint::Reach { id: stroke.id, len: stroke.tiles.len() as u32, ways }
        }
        Ask::Placing { kind, at, facing } => Hint::Placing(world.placing(kind, at, facing)),
    }
}

/// The tiles in an area a drag may start from, or a building stand round.
fn starts(world: &World, hand: Holding, area: Area) -> Vec<GridCoord> {
    let tiles = (area.y0..=area.y1).flat_map(|y| (area.x0..=area.x1).map(move |x| GridCoord { x, y }));
    tiles.filter(|&at| starts_at(world, hand, at)).collect()
}

fn starts_at(world: &World, hand: Holding, at: GridCoord) -> bool {
    match hand {
        Holding::Building { kind, facing: Some(f) } => world.fit(kind, at, f).is_ok(),
        Holding::Building { kind, facing: None } => world.facing_for(kind, at).is_some(),
        Holding::Tool { tool: Tool::Light, .. } => world.nodes_on(at).into_iter().any(|(_, id)| world.is_intersection(id)),
        // What a tap takes, or a drag cuts.
        Holding::Tool { tool: Tool::Demolish, .. } => {
            let tap = |h: u8, side| crate::hand::may_step(world, Build { tool: Tool::Demolish, from: at, to: at, up: Some([h, h]), sides: Some([side, side]), road: false });
            tap(0, crate::world::decks::MIDDLE)
                || world.nodes_on(at).into_iter().any(|(h, id)| {
                    let stand = Stand { h, side: world.side_of(id) };
                    tap(h, stand.side) || erase_from(world, at, stand).iter().any(Option::is_some)
                })
        }
        Holding::Tool { tool, road, want } => draw::may_start(world, tool, road, want, at),
    }
}

/// Where the eraser, standing on the last tile of `stroke` where its
/// `start` says, may go on: to the road linked to it on each tile round,
/// the nearest its height.
fn erase(world: &World, stroke: &Stroke) -> Vec<Option<Stand>> {
    match (stroke.tiles.last(), stroke.start) {
        (Some(last), Some(stand)) => erase_from(world, last.at, stand),
        _ => vec![None; 8],
    }
}

fn erase_from(world: &World, at: GridCoord, stand: Stand) -> Vec<Option<Stand>> {
    let Some(here) = world.node_in(at, stand.h, stand.side) else { return vec![None; 8] };
    STEPS
        .iter()
        .map(|&(dx, dy)| {
            let to = GridCoord { x: at.x + dx, y: at.y + dy };
            world
                .nodes_on(to)
                .into_iter()
                .filter(|&(_, id)| world.edges.contains_key(&(here, id)) || world.edges.contains_key(&(id, here)))
                .map(|(h, id)| Stand { h, side: world.side_of(id) })
                .filter(|s| crate::hand::may_step(world, Build { tool: Tool::Demolish, from: at, to, up: Some([stand.h, s.h]), sides: Some([stand.side, s.side]), road: false }))
                .min_by_key(|s| s.h.abs_diff(stand.h))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{BuildingKind, TerrainType};

    const fn at(x: i32, y: i32) -> GridCoord {
        GridCoord { x, y }
    }

    /// Grass, and a street along y = 0.
    fn street() -> World {
        World::meadow(-6..20, -6..6).street(-6..20)
    }

    fn area(x0: i32, y0: i32, x1: i32, y1: i32) -> Area {
        Area { x0, y0, x1, y1 }
    }

    fn starts_of(world: &World, hand: Holding, a: Area) -> Vec<GridCoord> {
        match answer(world, 1, Ask::Starts { hand, area: a }) {
            Hint::Starts { tiles, .. } => tiles,
            _ => unreachable!(),
        }
    }

    /// The tools' dots: a road anywhere it may step out; the eraser on what
    /// stands; lights on a junction alone.
    #[test]
    fn a_tool_starts_where_it_does_something() {
        let mut world = street();
        let tool = |tool| Holding::Tool { tool, road: false, want: 0 };
        assert!(starts_of(&world, tool(Tool::Street), area(3, -3, 3, 3)).len() == 7);
        assert_eq!(starts_of(&world, tool(Tool::Demolish), area(3, -3, 3, 3)), vec![at(3, 0)]);
        assert!(starts_of(&world, tool(Tool::Light), area(-6, -6, 19, 5)).is_empty());
        world.place_road_path(&[at(5, 0), at(5, 1), at(5, 2)]);
        assert_eq!(starts_of(&world, tool(Tool::Light), area(-6, -6, 19, 5)), vec![at(5, 0)]);
    }

    /// Where a drag goes on: a street off the street, not into the water;
    /// the eraser along what it may cut, standing on it.
    #[test]
    fn a_drag_is_told_where_it_may_go_on() {
        let mut world = street();
        world.terrain.insert((6, 1), TerrainType::Water);
        let stroke = |tool, start| Stroke { id: 9, tool, road: false, tiles: vec![crate::protocol::Spot { at: at(5, 0), want: 0 }], start };
        let Hint::Reach { id, len, ways } = answer(&world, 1, Ask::Reach(stroke(Tool::Street, None))) else { unreachable!() };
        assert_eq!((id, len), (9, 1));
        assert!(ways[2].is_some(), "off the street");
        assert!(ways[1].is_none(), "into the water");
        let ground = Stand { h: 0, side: crate::world::decks::MIDDLE };
        let Hint::Reach { ways, .. } = answer(&world, 1, Ask::Reach(stroke(Tool::Demolish, Some(ground)))) else { unreachable!() };
        assert_eq!(ways.iter().map(Option::is_some).collect::<Vec<_>>(), [true, false, false, false, true, false, false, false]);
    }

    /// A building's dots and its place: beside the street, and said why
    /// not where it may not go.
    #[test]
    fn a_building_says_where_it_fits_and_why_not() {
        let world = street();
        let house = |x, y, f| world.fit(BuildingKind::House, at(x, y), f).err();
        assert_eq!(house(0, 1, 2), None);
        assert_eq!(house(0, 4, 2), Some("No street beside it"));
        assert_eq!(house(0, 0, 2), Some("A street runs through it"));
        // Held over the street, it is placed beside it.
        let p = world.placing(BuildingKind::House, at(0, 0), Some(2));
        assert_eq!((p.at, p.why), (at(0, 1), None));
        let fits = starts_of(&world, Holding::Building { kind: BuildingKind::House, facing: None }, area(0, -3, 0, 3));
        assert_eq!(fits, vec![at(0, -1), at(0, 1)]);
    }

    /// A harbour with its back on the sea, placed round the tile beside
    /// that fits; on a lake, refused, and said why.
    #[test]
    fn a_harbour_finds_the_sea() {
        let coast = |water| {
            let mut world = World::new();
            for y in -10..20 {
                for x in -5..25 {
                    world.terrain.insert((x, y), if y >= 2 { water } else { TerrainType::Grass });
                }
            }
            world
        };
        let sea = coast(TerrainType::Sea);
        let p = sea.placing(BuildingKind::Harbour, at(9, 3), None);
        assert_eq!((p.at, p.facing, p.why), (at(9, 2), 0, None));
        assert_eq!(sea.placing(BuildingKind::Harbour, at(9, 1), Some(2)).why.as_deref(), Some("No quay: it stands half on the sea, its back on the water"));
        let lake = coast(TerrainType::Water);
        assert_eq!(lake.placing(BuildingKind::Harbour, at(9, 2), None).why.as_deref(), Some("A lake: the ferry comes only by sea"));
    }
}
#[cfg(test)]
mod bench {
    use super::*;

    /// The dots for a view a hundred tiles by sixty over a grid of streets,
    /// each tool's: what the town's server answers as the view moves.
    /// `cargo test starts_over_a_view -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn starts_over_a_view() {
        let mut world = World::meadow(-60..60, -40..40);
        for k in -5..5 {
            world.place_road_path(&(-60..60).map(|x| GridCoord { x, y: k * 8 }).collect::<Vec<_>>());
            world.place_road_path(&(-40..40).map(|y| GridCoord { x: k * 12, y }).collect::<Vec<_>>());
        }
        let view = Area { x0: -50, y0: -30, x1: 50, y1: 30 };
        let hands = [Tool::Street, Tool::OneWay, Tool::Demolish].map(|tool| Holding::Tool { tool, road: false, want: 0 });
        for hand in hands.into_iter().chain([Holding::Building { kind: crate::protocol::BuildingKind::House, facing: None }]) {
            let t = std::time::Instant::now();
            let n = starts(&world, hand, view).len();
            eprintln!("{hand:?}: {n} tiles in {:?}", t.elapsed());
            assert!(t.elapsed().as_millis() < 250, "{hand:?}: {:?}", t.elapsed());
        }
    }
}
