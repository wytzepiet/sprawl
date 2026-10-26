//! The mayor's hand: what a player asks of the town, done, and the rule of
//! where it may go (`may_step`), which the hand's dots are drawn by too.

use crate::engine::event_queue::EventQueue;
use model::GameTime;
use model::{Build, BuildingKind, ClientMessage, EntityId, GameObject, GridCoord, News, OwnerId, Tool};
use crate::world::decks::MIDDLE;
use crate::world::World;

/// What a player asked of the town, done. What it has to say back to
/// them alone: an undo, or a building that may not go there.
pub(crate) fn handle_player_action(
    world: &mut World,
    events: &mut EventQueue,
    owner: OwnerId,
    message: ClientMessage,
    now: GameTime,
) -> Option<News> {
    // Anything the mayor does may do a mission's step.
    world.missions.stir();
    match message {
        ClientMessage::Build(step) => return build(world, events, owner, step, now),
        ClientMessage::Draw(stroke) => return crate::draw::draw(world, events, owner, stroke, now),
        ClientMessage::Place { kind, at, facing } => return place(world, events, kind, at, facing, now),
        ClientMessage::Raze { building } => return crate::undo::raze(world, events, building, now),
        ClientMessage::Undo => return Some(crate::undo::undo(world, events, owner, now)),
        ClientMessage::DespawnAllCars => {
            let car_ids: Vec<EntityId> = world.objects.iter()
                .filter(|e| matches!(e.object, GameObject::Car(ref c) if c.trip.is_some()))
                .map(|e| e.id)
                .collect();
            for car_id in car_ids {
                crate::car::simulation::park_at_home(world, events, car_id);
            }
        }
        ClientMessage::Trade { good, packages, out } => {
            crate::market::trade(world, good, out, packages);
            crate::haul::call_lorries(world, events);
        }
        ClientMessage::Send { letter, packages } => {
            crate::orders::send(world, letter, packages);
            crate::haul::call_lorries(world, events);
        }
        ClientMessage::Order { good, out, packages, price } => crate::market::order(world, good, out, packages, price),
        ClientMessage::Cancel { order } => crate::market::cancel(world, order),
        ClientMessage::BuyLorry { depot } => crate::haul::buy_lorry(world, events, depot, now),
        ClientMessage::SetSpeed(_) | ClientMessage::RunTo(_) | ClientMessage::ResetWorld | ClientMessage::SetChunks(_) | ClientMessage::Ask(_) | ClientMessage::Card(_) => {
            unreachable!("handled by Game::command")
        }
    }
    None
}

/// A step of a road or the demolisher, built as it is sent, and kept to
/// undo: a drag is one action.
fn build(world: &mut World, events: &mut EventQueue, owner: OwnerId, step: Build, now: GameTime) -> Option<News> {
    let purse = crate::undo::Purse::of(world);
    let after = world.objects.next_id();
    let taken = (step.tool == Tool::Demolish).then(|| crate::undo::doomed(world, step)).flatten();
    // Along a road already there, a step changes its priority or its
    // lanes, and lays nothing for an undo to take up.
    let [hf, ht] = step.up.unwrap_or_default();
    let [sf, st] = step.sides.unwrap_or_default();
    let repaint = matches!(step.tool, Tool::Street | Tool::OneWay | Tool::Wide) && world.link_between_at(step.from, hf, sf, step.to, ht, st).is_some();
    if !take_step(world, events, step, now) || repaint {
        return None;
    }
    let paid = purse.paid(world);
    // Road laid lately and taken up again gives back what it paid; only
    // the rest is kept to undo.
    let (taken, back) = match taken {
        Some(crate::undo::Act::Cut(links)) => {
            let (kept, back) = crate::undo::recoup(world, links, now);
            ((!kept.is_empty()).then_some(crate::undo::Act::Cut(kept)), back)
        }
        other => (other, String::new()),
    };
    let news = crate::undo::stepped(world, owner, step, taken, paid, after, now);
    if back.is_empty() { news } else { Some(News { text: "Road taken back".into(), sub: back, at: 0 }) }
}

/// A building placed whole round `at`, its front facing this way or the
/// first way it fits: a site that calls for its materials at once. A
/// harbour lays its street first. Kept to undo; refused, the reason, for
/// the hand that asked.
fn place(world: &mut World, events: &mut EventQueue, kind: BuildingKind, at: GridCoord, facing: Option<u8>, now: GameTime) -> Option<News> {
    let refuse = |why: &str| Some(News { text: format!("No room for the {}", format!("{kind:?}").to_lowercase()), sub: why.to_string(), at: 0 });
    let facing = facing.or_else(|| world.facing_for(kind, at)).unwrap_or(2);
    let tiles = match world.fit(kind, at, facing) {
        Ok(tiles) => tiles,
        Err(why) => return refuse(why),
    };
    let purse = crate::undo::Purse::of(world);
    let after = world.objects.next_id();
    let mut laid = Vec::new();
    for (from, to) in world.stub(kind, &tiles, facing) {
        if take_step(world, events, Build { tool: Tool::Street, from, to, up: None, sides: None, road: false }, now) {
            laid.push(crate::undo::Link { from, to, one_way: false, road: false, up: [0, 0], sides: [MIDDLE; 2], wide: false });
        }
    }
    let id = world.raise(kind, tiles, facing);
    crate::calls::turn(world, events, id, now);
    let paid = purse.paid(world);
    crate::undo::placed(world, id, laid, paid, after, now);
    None
}

/// A step of the hand, built. Whether the step was taken.
pub fn take_step(world: &mut World, events: &mut EventQueue, step: Build, now: GameTime) -> bool {
    let Build { tool, from, to, road, .. } = step;
    let [hf, ht] = step.up.unwrap_or_default();
    let [sf, st] = step.sides.unwrap_or_default();
    // Said out loud: a click that does nothing is the kind of bug
    // that otherwise takes an afternoon to find.
    if !may_step(world, step) {
        println!("refused: {tool:?} from {from:?} to {to:?} at {:?}", step.up);
        return false;
    }
    match tool {
        Tool::Street | Tool::OneWay | Tool::Wide => {
            let one_way = matches!(tool, Tool::OneWay | Tool::Wide);
            let laid = lay(world, crate::undo::Link { from, to, one_way, road, up: [hf, ht], sides: [sf, st], wide: tool == Tool::Wide });
            crate::economy::paved(world, to, laid, now);
        }
        Tool::Light => {
            if let Some(id) = world.node_in(to, ht, st)
                && let Some(GameObject::RoadNode(n)) = world.objects.get_mut(id).map(|e| &mut e.object)
            {
                n.light = if n.light.is_some() { None } else { Some(0) };
                events.wake(0, id);
            }
        }
        Tool::Demolish => {
            // A tap takes the road at the tile and height, all its links,
            // the cars on it rerouted. A drag cuts only the road between
            // the two tiles.
            if from == to {
                if let Some(id) = world.node_in(to, ht, st) {
                    crate::car::reroute::handle_road_demolish(world, events, id, now);
                }
            } else if let Some((a, b)) = world.link_between_at(from, hf, sf, to, ht, st) {
                crate::car::reroute::handle_link_demolish(world, events, a, b, now);
            }
        }
    }
    true
}

/// A road laid between two tiles, at their heights and sides, its edges
/// with it: how many tiles of it are new.
pub(crate) fn lay(world: &mut World, crate::undo::Link { from, to, one_way, road, up: [hf, ht], sides: [sf, st], wide }: crate::undo::Link) -> u32 {
    let laid = world.laid;
    // Along a road already there, the hand sets its priority.
    if let Some((a, b)) = world.link_between_at(from, hf, sf, to, ht, st) {
        world.set_priority(a, b, road);
    }
    world.place_road_at(from, hf, sf, to, ht, st, one_way, road);
    if let (Some(a), Some(b)) = (world.node_in(from, hf, sf), world.node_in(to, ht, st)) {
        world.set_wide(a, b, wide);
    }
    world.laid.saturating_sub(laid)
}

/// May the mayor's hand take this step, at the heights and sides it
/// gives: the world's own rule for the step. The one rule a step is
/// refused by, and the hand's dots are drawn by (`hint.rs`).
pub fn may_step(world: &World, step: Build) -> bool {
    may_step_on(world, step, None, None)
}

/// `may_step`, a drag going on from `to` that way, if it does
/// (`World::leads_nowhere`), and on to the road's next end, if it is known
/// (`World::may_lay_at_on`).
pub fn may_step_on(world: &World, Build { tool, from, to, up, sides, road, .. }: Build, on: Option<(i32, i32)>, then: Option<crate::world::clear::End>) -> bool {
    let [hf, ht] = up.unwrap_or_default();
    let [sf, st] = sides.unwrap_or_default();
    let (a, b) = (world.node_in(from, hf, sf), world.node_in(to, ht, st));
    // A level's: on its map, and its own roads stay; a road of the
    // player's may be cut from one.
    if let Some((lo, hi)) = world.frame {
        let inside = |t: GridCoord| (lo.x..=hi.x).contains(&t.x) && (lo.y..=hi.y).contains(&t.y);
        let fixed = |t: GridCoord, h: u8| h == 0 && world.road_node_at(t).is_some_and(|id| matches!(world.objects.get(id).map(|e| &e.object), Some(GameObject::RoadNode(n)) if !n.laid));
        let ok = match tool {
            Tool::Demolish if from == to => !fixed(to, ht),
            Tool::Demolish => !(fixed(from, hf) && fixed(to, ht)),
            _ => inside(from) && inside(to),
        };
        if !ok {
            return false;
        }
    }
    match tool {
        Tool::Street | Tool::OneWay | Tool::Wide => {
            let one_way = matches!(tool, Tool::OneWay | Tool::Wide);
            // Along a one-way the way it runs, the other one-way tool: it
            // gains its second lane, or loses it; but a road on a side
            // has one.
            let lanes = a.zip(b).is_some_and(|(a, b)| {
                world.edges.contains_key(&(a, b)) && !world.edges.contains_key(&(b, a)) && world.is_wide(a, b) != (tool == Tool::Wide)
            });
            if one_way && lanes {
                return tool != Tool::Wide || (sf == MIDDLE && st == MIDDLE);
            }
            // Along a road, priority it has not, or has and the hand not.
            if world.link_between_at(from, hf, sf, to, ht, st).is_some_and(|(a, b)| world.is_road_between(a, b) != road) {
                return true;
            }
            // Into a building is its door: nothing is laid on its tile, and
            // a through road is no door, nothing fronting onto one.
            let door = ht == 0 && world.occupied.contains_key(&(to.x, to.y));
            !(door && road)
                && !(tool == Tool::Wide && (sf != MIDDLE || st != MIDDLE))
                && world.may_lay_at_on(from, hf, sf, to, ht, st, tool, on, then)
        }
        Tool::Light => from == to && b.is_some_and(|id| world.is_intersection(id)),
        Tool::Demolish if from == to => b.is_some(),
        Tool::Demolish => world.link_between_at(from, hf, sf, to, ht, st).is_some(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::tests::*;
    use crate::game::tests::build;
    use crate::game::settle_and_wake;
    use model::Good;
    use land::TerrainType;

    /// May the mayor's hand take this step with this tool.
    fn may(world: &World, tool: Tool, from: GridCoord, to: GridCoord) -> bool {
        may_step(world, Build { tool, from, to, up: None, sides: None, road: false })
    }

    /// The rule says what the hand will do: a house may be placed
    /// beside the street and not on it; a street may be drawn off the
    /// street and not along it again, nor onto water; demolishing finds
    /// what stands. The hand's dots (`hint.rs`) answer the same.
    #[test]
    fn the_rule_of_where_the_hand_may_go_is_what_it_does() {
        let mut world = street();
        world.treasury = 1e9;
        let at = |x, y| GridCoord { x, y };
        assert!(world.fit(BuildingKind::House, at(5, 1), 2).is_ok(), "beside the street");
        assert!(world.fit(BuildingKind::House, at(5, 0), 2).is_err(), "not on it");
        assert!(world.fit(BuildingKind::House, at(5, 3), 2).is_err(), "nor where no street reaches");
        world.terrain.insert((5, 1), TerrainType::Water);
        assert!(!may(&world, Tool::Street, at(5, 0), at(5, 1)), "nor a street onto water");
        world.terrain.insert((5, 1), TerrainType::Grass);
        assert!(may(&world, Tool::Street, at(5, 0), at(5, 1)), "off the street toward +y");
        assert!(!may(&world, Tool::Street, at(5, 0), at(6, 0)), "not along it again");
        assert!(!may(&world, Tool::Demolish, at(5, 3), at(5, 3)), "nothing to take");
        assert!(may(&world, Tool::Demolish, at(5, 0), at(5, 0)), "a road to take");
        // And a step the rule refuses, the hand is refused.
        for dy in -1..=1 {
            for dx in -1..=1 {
                let (from, to) = (at(5, 0), at(5 + dx, dy));
                let allowed = may(&world, Tool::Street, from, to);
                let mut events = EventQueue::new();
                let mut probe = street();
                let edges = probe.edges.len();
                take_step(&mut probe, &mut events, Build { tool: Tool::Street, from, to, up: None , sides: None, road: false }, 0);
                assert_eq!(probe.edges.len() != edges, allowed, "step {dx},{dy}");
            }
        }
    }

    /// A drag of road is one action, and undo takes it back whole: the
    /// street gone, the stone back on the depot's shelf it came off, the
    /// coins paid express for what the shelf lacked back in the purse.
    #[test]
    fn undo_takes_back_a_drag_of_road_and_what_it_paid() {
        let mut world = street();
        let depot = build(&mut world, 30, BuildingKind::Depot);
        if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
            b.stocks.get_mut(&Good::Stone).unwrap().level = 2.0;
        }
        let mut events = EventQueue::new();
        let at = |x, y| GridCoord { x, y };
        let (roads, treasury) = (world.roads.len(), world.treasury);
        let mut hand = |world: &mut World, message| handle_player_action(world, &mut events, 1, message, 0);
        let mut said = Vec::new();
        // A drag as the hand sends it: the whole of it so far, a tile on each time.
        for n in 1..=5 {
            let tiles = (0..n).map(|y| model::Spot { at: at(10, y), want: 0 }).collect();
            said.extend(hand(&mut world, ClientMessage::Draw(model::Stroke { id: 1, tool: Tool::Street, road: false, tiles, start: None })));
        }
        assert_eq!(world.roads.len(), roads + 4, "the side street was not laid");
        assert!(world.treasury < treasury, "the third and fourth tiles were not bought express");
        assert_eq!(said.len(), 1, "the express is said once a drag: {said:?}");
        let undone = hand(&mut world, ClientMessage::Undo).unwrap();
        assert!(undone.text.starts_with("Undone"), "{undone:?}");
        assert_eq!(world.roads.len(), roads, "the drag was not taken back whole");
        assert!((world.treasury - treasury).abs() < 1e-9, "the express was not given back: {}", treasury - world.treasury);
        assert_eq!(building_of(&world, depot).stocks[&Good::Stone].level, 2.0, "the stone is not back on the shelf");
        assert_eq!(hand(&mut world, ClientMessage::Undo).unwrap().text, "Nothing to undo");
    }

    /// What the mayor takes down of their own lately built is undone: a
    /// house placed and razed gives its delivered timber back, a street
    /// laid and taken up its stone. Past the window, nothing comes back.
    #[test]
    fn taking_down_what_was_just_built_gives_it_back() {
        let mut world = street();
        world.treasury = 1e9;
        let depot = build(&mut world, 30, BuildingKind::Depot);
        let mut events = EventQueue::new();
        let at = |x, y| GridCoord { x, y };
        let shelf = |w: &World, g: Good| building_of(w, depot).stocks[&g].level;
        if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
            b.stocks.get_mut(&Good::Timber).unwrap().level = 10.0;
            b.stocks.get_mut(&Good::Stone).unwrap().level = 10.0;
        }
        let mut hand = |world: &mut World, message, now| handle_player_action(world, &mut events, 1, message, now);
        hand(&mut world, ClientMessage::Place { kind: BuildingKind::House, at: at(5, 1), facing: None }, 0);
        let house = world.occupied[&(5, 1)];
        if let Some(GameObject::Building(b)) = world.objects.get_mut(house).map(|e| &mut e.object) {
            b.site.as_mut().unwrap().get_mut(&Good::Timber).unwrap().level = 2.0;
        }
        let back = hand(&mut world, ClientMessage::Raze { building: house }, 0).expect("nothing said");
        assert!(back.text.contains("taken back"), "{back:?}");
        assert_eq!(shelf(&world, Good::Timber), 12.0, "its delivered timber is not back at the depot");
        // A street a tile long, and taken up again.
        hand(&mut world, ClientMessage::Build(Build { tool: Tool::Street, from: at(7, 0), to: at(7, 1), up: None, sides: None, road: false }), 0);
        assert_eq!(shelf(&world, Good::Stone), 9.0, "the street took no stone");
        let back = hand(&mut world, ClientMessage::Build(Build { tool: Tool::Demolish, from: at(7, 1), to: at(7, 1), up: None, sides: None, road: false }), 0).expect("nothing said");
        assert!(back.sub.contains("stone"), "{back:?}");
        assert_eq!(shelf(&world, Good::Stone), 10.0, "its stone is not back");
        assert_eq!(hand(&mut world, ClientMessage::Undo, 0).unwrap().text, "Nothing to undo", "what was taken back is still to undo");
        // Old, a house razed gives nothing back.
        hand(&mut world, ClientMessage::Place { kind: BuildingKind::House, at: at(5, 1), facing: None }, 0);
        let (house, timber) = (world.occupied[&(5, 1)], shelf(&world, Good::Timber));
        assert!(hand(&mut world, ClientMessage::Raze { building: house }, crate::undo::WINDOW + 1).is_none());
        assert!(world.objects.get(house).is_none(), "the old house stands");
        assert_eq!(shelf(&world, Good::Timber), timber, "the old house gave something back");
    }

    /// Someone else's building on a street since laid holds it: undo says
    /// so and takes nothing back. Past its window, nothing is undone.
    #[test]
    fn undo_refuses_what_another_has_built_on_and_what_is_old() {
        let mut world = street();
        world.treasury = 1e9;
        let mut events = EventQueue::new();
        let at = |x, y| GridCoord { x, y };
        let mut hand = |world: &mut World, owner, message, now| handle_player_action(world, &mut events, owner, message, now);
        for y in 0..3 {
            hand(&mut world, 1, ClientMessage::Build(Build { tool: Tool::Street, from: at(10, y), to: at(10, y + 1), up: None, sides: None, road: false }), 0);
        }
        assert!(hand(&mut world, 2, ClientMessage::Place { kind: BuildingKind::House, at: at(11, 3), facing: None }, 0).is_none());
        let roads = world.roads.len();
        let no = hand(&mut world, 1, ClientMessage::Undo, 0).unwrap();
        assert_eq!((no.text.as_str(), world.roads.len()), ("Can't undo", roads), "{no:?}");
        // The house's player takes theirs down; then the street goes.
        let house = world.occupied[&(11, 3)];
        hand(&mut world, 2, ClientMessage::Raze { building: house }, 0);
        hand(&mut world, 1, ClientMessage::Undo, 0);
        assert!(world.road_node_at(at(10, 3)).is_none());
        hand(&mut world, 1, ClientMessage::Build(Build { tool: Tool::Street, from: at(20, 0), to: at(20, 1), up: None, sides: None, road: false }), 0);
        assert_eq!(hand(&mut world, 1, ClientMessage::Undo, crate::undo::WINDOW + 1).unwrap().text, "Nothing to undo");
    }

    /// A coast with no road on it: grass to y = 3, the sea from y = 4 out
    /// past the map's edge.
    fn bare_coast() -> World {
        let mut world = World::new();
        for y in -30..41 {
            for x in -60..100 {
                world.terrain.insert((x, y), if y >= 2 { TerrainType::Sea } else { TerrainType::Grass });
            }
        }
        world
    }

    /// A harbour is placed whole, its back to the sea, with a street of
    /// its own laid to its park. Inland it is refused, and why is said;
    /// taken down, it goes whole.
    #[test]
    fn a_harbour_is_placed_whole_with_its_street() {
        let mut world = bare_coast();
        let mut events = EventQueue::new();
        let at = |x, y| GridCoord { x, y };
        let mut hand = |world: &mut World, message| handle_player_action(world, &mut events, 1, message, 0);
        let no = hand(&mut world, ClientMessage::Place { kind: BuildingKind::Harbour, at: at(10, -10), facing: None }).expect("a harbour inland was placed");
        assert!(world.occupied.is_empty() && no.sub.contains("sea"), "{no:?}");
        assert!(hand(&mut world, ClientMessage::Place { kind: BuildingKind::Harbour, at: at(9, 2), facing: None }).is_none(), "the coast refused it");
        let id = world.occupied[&(9, 2)];
        assert!((8..11).all(|x| (1..3).all(|y| world.occupied.get(&(x, y)) == Some(&id))), "the harbour is not its whole plot");
        assert!(world.door_of(id).is_some(), "its street does not reach it");
        assert!(world.berth(id).is_some(), "it does not berth");
        let mut events = EventQueue::new();
        settle_and_wake(&mut world, &mut events);
        assert!(world.lines.contains_key(&id), "no ferry line");
        // Razed, the harbour is gone whole.
        crate::undo::raze(&mut world, &mut events, id, 0);
        assert!((8..11).all(|x| (1..3).all(|y| !world.occupied.contains_key(&(x, y)))), "part of the harbour stands");
        settle_and_wake(&mut world, &mut events);
    }

    /// A depot short of its plot, as a fixture may draw one, has no yard,
    /// and a road drawn into it asks of none: it once subtracted the
    /// yard's depth from a plot one tile deep, and the server crashed.
    #[test]
    fn a_road_into_a_depot_short_of_its_plot_is_asked_of_no_yard() {
        let mut world = street();
        let mut events = EventQueue::new();
        let at = |x, y| GridCoord { x, y };
        world.raise(BuildingKind::Depot, vec![at(30, 1)], 2);
        take_step(&mut world, &mut events, Build { tool: Tool::Street, from: at(31, 2), to: at(30, 1), up: None, sides: None, road: false }, 0);
        take_step(&mut world, &mut events, Build { tool: Tool::Street, from: at(30, 2), to: at(30, 1), up: None, sides: None, road: false }, 0);
    }

    /// A house razed takes its drive with it: the drive is the house's,
    /// not a road on its tile.
    #[test]
    fn a_house_razed_takes_its_drive_with_it() {
        let mut game = game(street());
        game.world.treasury = 1e9;
        let at = GridCoord { x: 5, y: 1 };
        does(&mut game, Do::Place(BuildingKind::House, at));
        let house = game.world.occupied[&(5, 1)];
        assert!(game.world.door_of(house).is_some() && game.world.road_node_at(at).is_none(), "a house with its door, and no road on its tile");
        does(&mut game, Do::Raze(at));
        let world = &game.world;
        assert!(!world.occupied.contains_key(&(5, 1)), "the house is gone");
        assert!(world.road_node_at(GridCoord { x: 5, y: 0 }).is_some(), "and the street stands");
    }

    /// A drag of the demolisher cuts only the road between the tiles it
    /// crosses. A tap takes the road at the point; a building is not the
    /// demolisher's to take.
    #[test]
    fn a_drag_cuts_a_link_and_a_tap_takes_the_point() {
        let mut game = game(street());
        game.world.treasury = 1e9;
        let at = |x, y| GridCoord { x, y };
        // A side street, two tiles long, off the main one.
        does(&mut game, Do::Step(Tool::Street, at(5, 0), at(5, 1)));
        does(&mut game, Do::Step(Tool::Street, at(5, 1), at(5, 2)));
        does(&mut game, Do::Step(Tool::Demolish, at(5, 1), at(5, 2)));
        let world = &game.world;
        assert!(!world.are_connected(at(5, 1), at(5, 2)), "the link is cut");
        assert!(world.road_node_at(at(5, 2)).is_none(), "and the end left with no road goes");
        assert!(world.are_connected(at(5, 0), at(5, 1)), "the rest stands");
        does(&mut game, Do::Place(BuildingKind::Depot, at(9, 3)));
        let depot = game.world.occupied[&(9, 3)];
        does(&mut game, Do::Step(Tool::Demolish, at(10, 4), at(10, 4)));
        assert!(game.world.objects.get(depot).is_some(), "the demolisher took the depot");
        // A tap takes the point and every link at it.
        does(&mut game, Do::Step(Tool::Demolish, at(5, 0), at(5, 0)));
        assert!(game.world.road_node_at(at(5, 0)).is_none());
        assert!(game.world.road_node_at(at(5, 1)).is_none(), "the side street left with no road goes too");
    }

    /// A road is laid at once, on stone: a tile's comes off the nearest
    /// depot's shelf, and what the depots lack the world sends express,
    /// paid at the harbour at twice the boat's price.
    #[test]
    fn a_road_is_laid_on_stone_from_the_depot() {
        let mut world = street();
        let depot = build(&mut world, 30, BuildingKind::Depot);
        let stone = |w: &World| building_of(w, depot).stocks[&Good::Stone].level;
        if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
            b.stocks.get_mut(&Good::Stone).unwrap().level = 2.0;
        }
        let mut events = EventQueue::new();
        let at = |x, y| GridCoord { x, y };
        let treasury = world.treasury;
        let mut hand = |world: &mut World, from, to| take_step(world, &mut events, Build { tool: Tool::Street, from, to, up: None , sides: None, road: false }, 0);
        hand(&mut world, at(10, 0), at(10, 1));
        hand(&mut world, at(10, 1), at(10, 2));
        assert_eq!(stone(&world), 0.0, "two tiles took {} stone", 2.0 - stone(&world));
        assert_eq!(world.treasury, treasury, "stone in stock was paid for");
        hand(&mut world, at(10, 2), at(10, 3));
        let express = crate::economy::EXPRESS * crate::economy::import(Good::Stone, crate::economy::ROAD_STONE);
        assert!((treasury - world.treasury - express).abs() < 1e-9, "the third tile cost {}", treasury - world.treasury);
        assert!(world.lumps.iter().any(|l| l.building == harbour_of(&world) && l.coins < 0.0 && l.good == Some(Good::Stone)), "no lump at the harbour");
    }
}
