//! Where the hand may go, as the game sees it: what the brush shows before
//! it acts (`Ask`), answered by the same rules that refuse it
//! (`hand::may_step`, `draw::plan`, `Map::fit`), so the dots and the
//! world never part. The client asks as the view moves, as a drag goes on,
//! and as a building is held; it waits for the answer.

use crate::draw::{self, STEPS};
use model::{Area, Ask, Build, GridCoord, Hint, Holding, OwnerId, Stand, Stroke, Tool};
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
                Tool::Light => vec![Vec::new(); 8],
            };
            Hint::Reach { id: stroke.id, len: stroke.tiles.len() as u32, ways }
        }
        Ask::Placing { kind, at, facing } => Hint::Placing(world.map.placing(kind, at, facing)),
    }
}

/// The tiles in an area a drag may start from, or a building stand round.
fn starts(world: &World, hand: Holding, area: Area) -> Vec<GridCoord> {
    let tiles = (area.y0..=area.y1).flat_map(|y| (area.x0..=area.x1).map(move |x| GridCoord { x, y }));
    tiles.filter(|&at| starts_at(world, hand, at)).collect()
}

fn starts_at(world: &World, hand: Holding, at: GridCoord) -> bool {
    match hand {
        Holding::Building { kind, facing: Some(f) } => world.map.fit(kind, at, f).is_ok(),
        Holding::Building { kind, facing: None } => world.map.facing_for(kind, at).is_some(),
        Holding::Tool { tool: Tool::Light, .. } => world.map.nodes_on(at).into_iter().any(|(_, id)| world.map.is_intersection(id)),
        // What a tap takes, or a drag cuts.
        Holding::Tool { tool: Tool::Demolish, .. } => {
            let tap = |h: u8, side| crate::hand::may_step(world, Build { tool: Tool::Demolish, from: at, to: at, up: Some([h, h]), sides: Some([side, side]), road: false });
            tap(0, map::decks::MIDDLE)
                || world.map.nodes_on(at).into_iter().any(|(h, id)| {
                    let stand = Stand { h, side: world.map.side_of(id) };
                    tap(h, stand.side) || erase_from(world, at, stand).iter().any(Option::is_some)
                })
        }
        Holding::Tool { tool, road, want } => draw::may_start(world, tool, road, want, at),
    }
}

/// Where the eraser, standing on the last tile of `stroke` where its
/// `start` says, may go on: along the road linked to it each way, the
/// nearest its height, as far as `draw::RUN` tiles straight on.
fn erase(world: &World, stroke: &Stroke) -> Vec<Vec<Stand>> {
    match (stroke.tiles.last(), stroke.start) {
        (Some(last), Some(stand)) => STEPS
            .iter()
            .map(|&(dx, dy)| {
                let (mut at, mut stand, mut run) = (last.at, stand, Vec::new());
                while run.len() < draw::RUN {
                    let Some(next) = erase_to(world, at, stand, (dx, dy)) else { break };
                    at = GridCoord { x: at.x + dx, y: at.y + dy };
                    stand = next;
                    run.push(next);
                }
                run
            })
            .collect(),
        _ => vec![Vec::new(); 8],
    }
}

fn erase_from(world: &World, at: GridCoord, stand: Stand) -> Vec<Option<Stand>> {
    STEPS.iter().map(|&step| erase_to(world, at, stand, step)).collect()
}

/// The road the eraser, standing here, may cut a step this way to.
fn erase_to(world: &World, at: GridCoord, stand: Stand, (dx, dy): (i32, i32)) -> Option<Stand> {
    let here = world.map.node_in(at, stand.h, stand.side)?;
    let to = GridCoord { x: at.x + dx, y: at.y + dy };
    world.map
        .nodes_on(to)
        .into_iter()
        .filter(|&(_, id)| world.map.edges.contains_key(&(here, id)) || world.map.edges.contains_key(&(id, here)))
        .map(|(h, id)| Stand { h, side: world.map.side_of(id) })
        .filter(|s| crate::hand::may_step(world, Build { tool: Tool::Demolish, from: at, to, up: Some([stand.h, s.h]), sides: Some([stand.side, s.side]), road: false }))
        .min_by_key(|s| s.h.abs_diff(stand.h))
}

#[cfg(test)]
mod tests {
    use super::*;
    use model::BuildingKind;
    use land::TerrainType;

    const fn at(x: i32, y: i32) -> GridCoord {
        GridCoord { x, y }
    }

    /// Grass, and a street along y = 0.
    fn street() -> World {
        let mut world = World::from(map::Map::meadow(-6..20, -6..6).street(-6..20));
        world.town.allowance = 1_000;
        world
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
        world.map.place_road_path(&[at(5, 0), at(5, 1), at(5, 2)]);
        assert_eq!(starts_of(&world, tool(Tool::Light), area(-6, -6, 19, 5)), vec![at(5, 0)]);
    }

    /// Where a drag goes on: a street off the street, not into the water;
    /// the eraser along what it may cut, standing on it.
    #[test]
    fn a_drag_is_told_where_it_may_go_on() {
        let mut world = street();
        world.map.terrain.insert((6, 1), TerrainType::Water);
        let stroke = |tool, start| Stroke { id: 9, tool, road: false, tiles: vec![model::Spot { at: at(5, 0), want: 0 }], start };
        let Hint::Reach { id, len, ways } = answer(&world, 1, Ask::Reach(stroke(Tool::Street, None))) else { unreachable!() };
        assert_eq!((id, len), (9, 1));
        assert!(!ways[2].is_empty(), "off the street");
        assert!(ways[1].is_empty(), "into the water");
        let ground = Stand { h: 0, side: map::decks::MIDDLE };
        let Hint::Reach { ways, .. } = answer(&world, 1, Ask::Reach(stroke(Tool::Demolish, Some(ground)))) else { unreachable!() };
        assert_eq!(ways.iter().map(|w| !w.is_empty()).collect::<Vec<_>>(), [true, false, false, false, true, false, false, false]);
    }

    /// A building's dots and its place: beside the street, and said why
    /// not where it may not go.
    #[test]
    fn a_building_says_where_it_fits_and_why_not() {
        let world = street();
        let house = |x, y, f| world.map.fit(BuildingKind::House, at(x, y), f).err();
        assert_eq!(house(0, 1, 2), None);
        assert_eq!(house(0, 4, 2), Some("No street beside it"));
        assert_eq!(house(0, 0, 2), Some("A street runs through it"));
        // Held over the street, it is placed beside it.
        let p = world.map.placing(BuildingKind::House, at(0, 0), Some(2));
        assert_eq!((p.at, p.why), (at(0, 1), None));
        let fits = starts_of(&world, Holding::Building { kind: BuildingKind::House, facing: None }, area(0, -3, 0, 3));
        assert_eq!(fits, vec![at(0, -1), at(0, 1)]);
    }

    /// A fishery with its back on the water, its front to the street;
    /// inland, refused, and said why.
    #[test]
    fn a_fishery_finds_the_shore() {
        let mut world = World::from(map::Map::meadow(-5..25, -10..1));
        world.map.place_road_path(&(-5..25).map(|x| at(x, -2)).collect::<Vec<_>>());
        for y in 0..20 {
            for x in -5..25 {
                world.map.terrain.insert((x, y), TerrainType::Sea);
            }
        }
        let p = world.map.placing(BuildingKind::Fishery, at(9, -1), Some(0));
        assert_eq!(p.why, None, "{p:?}");
        let inland = world.map.placing(BuildingKind::Fishery, at(9, -7), Some(2));
        assert_eq!(inland.why.as_deref(), Some("Its back to the water: its boat goes out from the shore"));
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
        let mut world = World::from(map::Map::meadow(-60..60, -40..40));
        for k in -5..5 {
            world.map.place_road_path(&(-60..60).map(|x| GridCoord { x, y: k * 8 }).collect::<Vec<_>>());
            world.map.place_road_path(&(-40..40).map(|y| GridCoord { x: k * 12, y }).collect::<Vec<_>>());
        }
        let view = Area { x0: -50, y0: -30, x1: 50, y1: 30 };
        let hands = [Tool::Street, Tool::OneWay, Tool::Demolish].map(|tool| Holding::Tool { tool, road: false, want: 0 });
        for hand in hands.into_iter().chain([Holding::Building { kind: model::BuildingKind::House, facing: None }]) {
            let t = std::time::Instant::now();
            let n = starts(&world, hand, view).len();
            eprintln!("{hand:?}: {n} tiles in {:?}", t.elapsed());
            assert!(t.elapsed().as_millis() < 250, "{hand:?}: {:?}", t.elapsed());
        }
    }
}
