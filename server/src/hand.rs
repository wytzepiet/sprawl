//! The mayor's hand: what a player asks of the town, done, and the rule of
//! where it may go (`may_step`), which the hand's dots are drawn by too.

use traffic::event_queue::EventQueue;
use model::GameTime;
use model::{Build, BuildingKind, ClientMessage, GameObject, GridCoord, News, OwnerId, Tool};
use map::decks::MIDDLE;
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
    match message {
        ClientMessage::Build(step) if world.town.may(step.tool, step.road, step.up) => build(world, events, owner, step, now),
        ClientMessage::Draw(stroke) if world.town.may(stroke.tool, stroke.road, None) => crate::draw::draw(world, events, owner, stroke, now),
        ClientMessage::Build(_) | ClientMessage::Draw(_) => None,
        ClientMessage::Place { kind, at, facing } => place(world, events, kind, at, facing),
        ClientMessage::Raze { building } => {
            crate::town::raze(world, events, building, now);
            None
        }
        ClientMessage::Undo => Some(crate::undo::undo(world, events, owner, now)),
        ClientMessage::Pick(n) => {
            crate::town::pick(world, n);
            None
        }
        ClientMessage::SetSpeed(_) | ClientMessage::RunTo(_) | ClientMessage::ResetWorld | ClientMessage::SetChunks(_) | ClientMessage::Ask(_) => {
            unreachable!("handled by Game::command")
        }
    }
}

/// A step of a road or the demolisher, built as it is sent, and kept to
/// undo: a drag is one action.
fn build(world: &mut World, events: &mut EventQueue, owner: OwnerId, step: Build, now: GameTime) -> Option<News> {
    let after = world.map.objects.next_id();
    let taken = (step.tool == Tool::Demolish).then(|| crate::undo::doomed(world, step)).flatten();
    // Along a road already there, a step changes its priority or its
    // lanes, and lays nothing for an undo to take up.
    let [hf, ht] = step.up.unwrap_or_default();
    let [sf, st] = step.sides.unwrap_or_default();
    let repaint = matches!(step.tool, Tool::Street | Tool::OneWay | Tool::Wide) && world.map.link_between_at(step.from, hf, sf, step.to, ht, st).is_some();
    if !take_step(world, events, step, now) || repaint {
        return None;
    }
    crate::undo::stepped(world, owner, step, taken, after, now);
    None
}

/// A building from the hand placed whole round `at`, its front facing this
/// way or the first way it fits. Refused, the reason, for the hand that
/// asked.
fn place(world: &mut World, events: &mut EventQueue, kind: BuildingKind, at: GridCoord, facing: Option<u8>) -> Option<News> {
    let refuse = |why: &str| Some(News { text: format!("No room for the {}", format!("{kind:?}").to_lowercase()), sub: why.to_string(), at: 0 });
    if !world.town.has(kind) {
        return Some(News { text: format!("No {} in hand", format!("{kind:?}").to_lowercase()), sub: "the town asks for what it needs".into(), at: 0 });
    }
    let facing = facing.or_else(|| world.map.facing_for(kind, at)).unwrap_or(2);
    let tiles = match world.map.fit(kind, at, facing) {
        Ok(tiles) => tiles,
        Err(why) => return refuse(why),
    };
    let id = world.map.raise(kind, tiles, facing);
    crate::town::placed(world, events, id);
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
            lay(world, crate::undo::Link { from, to, one_way, road, up: [hf, ht], sides: [sf, st], wide: tool == Tool::Wide });
        }
        Tool::Light => {
            if let Some(id) = world.map.node_in(to, ht, st)
                && let Some(GameObject::RoadNode(n)) = world.map.objects.get_mut(id).map(|e| &mut e.object)
            {
                n.light = if n.light.is_some() { None } else { Some(0) };
                events.wake(0, id);
            }
        }
        Tool::Demolish => {
            // A tap takes the road at the tile and height, all its links,
            // the cars on it rerouted, or else the building standing there,
            // back into the hand. A drag cuts only the road between the
            // two tiles.
            if from == to {
                if let Some(id) = world.map.node_in(to, ht, st) {
                    world.drive(events, |t, e| traffic::car::reroute::handle_road_demolish(t, e, id, now));
                } else if let Some(id) = razable(world, to, ht) {
                    crate::town::raze(world, events, id, now);
                }
            } else if let Some((a, b)) = world.map.link_between_at(from, hf, sf, to, ht, st) {
                world.drive(events, |t, e| traffic::car::reroute::handle_link_demolish(t, e, a, b, now));
            }
        }
    }
    true
}

/// The building a tap of the demolisher takes at the ground of a tile: a
/// town's, never a level's.
fn razable(world: &World, at: GridCoord, h: u8) -> Option<model::EntityId> {
    (h == 0 && world.town.start.is_some()).then(|| world.map.occupied.get(&(at.x, at.y)).copied()).flatten()
}

/// A road laid between two tiles, at their heights and sides, its edges
/// with it: how many tiles of it are new.
pub(crate) fn lay(world: &mut World, crate::undo::Link { from, to, one_way, road, up: [hf, ht], sides: [sf, st], wide }: crate::undo::Link) -> u32 {
    let laid = world.map.laid;
    // Along a road already there, the hand sets its priority.
    if let Some((a, b)) = world.map.link_between_at(from, hf, sf, to, ht, st) {
        world.map.set_priority(a, b, road);
    }
    world.map.place_road_at(from, hf, sf, to, ht, st, one_way, road);
    if let (Some(a), Some(b)) = (world.map.node_in(from, hf, sf), world.map.node_in(to, ht, st)) {
        world.map.set_wide(a, b, wide);
    }
    world.map.laid.saturating_sub(laid)
}

/// May the mayor's hand take this step, at the heights and sides it
/// gives: the world's own rule for the step. The one rule a step is
/// refused by, and the hand's dots are drawn by (`hint.rs`).
pub fn may_step(world: &World, step: Build) -> bool {
    may_step_on(world, step, None, None)
}

/// `may_step`, a drag going on from `to` that way, if it does
/// (`Map::leads_nowhere`), and on to the road's next end, if it is known
/// (`Map::may_lay_at_on`).
pub fn may_step_on(world: &World, Build { tool, from, to, up, sides, road, .. }: Build, on: Option<(i32, i32)>, then: Option<map::clear::End>) -> bool {
    let [hf, ht] = up.unwrap_or_default();
    let [sf, st] = sides.unwrap_or_default();
    let (a, b) = (world.map.node_in(from, hf, sf), world.map.node_in(to, ht, st));
    // A level's: on its map, and its own roads stay; a road of the
    // player's may be cut from one.
    if let Some((lo, hi)) = world.map.frame {
        let inside = |t: GridCoord| (lo.x..=hi.x).contains(&t.x) && (lo.y..=hi.y).contains(&t.y);
        let fixed = |t: GridCoord, h: u8| h == 0 && world.map.road_node_at(t).is_some_and(|id| matches!(world.map.objects.get(id).map(|e| &e.object), Some(GameObject::RoadNode(n)) if !n.laid));
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
                world.map.edges.contains_key(&(a, b)) && !world.map.edges.contains_key(&(b, a)) && world.map.is_wide(a, b) != (tool == Tool::Wide)
            });
            if one_way && lanes {
                return tool != Tool::Wide || (sf == MIDDLE && st == MIDDLE);
            }
            // Along a road, priority it has not, or has and the hand not.
            if world.map.link_between_at(from, hf, sf, to, ht, st).is_some_and(|(a, b)| world.map.is_road_between(a, b) != road) {
                return true;
            }
            // Into a building is its door: nothing is laid on its tile, and
            // a through road is no door, nothing fronting onto one.
            let door = ht == 0 && world.map.occupied.contains_key(&(to.x, to.y));
            // A tile of road new to the town comes off what it has left.
            let fresh = |t: GridCoord, h: u8, s| world.map.node_in(t, h, s).is_none() && !(h == 0 && world.map.occupied.contains_key(&(t.x, t.y)));
            let cost = fresh(from, hf, sf) as u32 + fresh(to, ht, st) as u32;
            if cost > world.town.roads(&world.map) {
                return false;
            }
            !(door && road)
                && !(tool == Tool::Wide && (sf != MIDDLE || st != MIDDLE))
                && world.map.may_lay_at_on(from, hf, sf, to, ht, st, tool, on, then)
        }
        Tool::Light => from == to && b.is_some_and(|id| world.map.is_intersection(id)),
        Tool::Demolish if from == to => b.is_some() || razable(world, to, ht).is_some(),
        Tool::Demolish => world.map.link_between_at(from, hf, sf, to, ht, st).is_some(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::tests::{build, street};
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
        let at = |x, y| GridCoord { x, y };
        assert!(world.map.fit(BuildingKind::House, at(5, 1), 2).is_ok(), "beside the street");
        assert!(world.map.fit(BuildingKind::House, at(5, 0), 2).is_err(), "not on it");
        assert!(world.map.fit(BuildingKind::House, at(5, 3), 2).is_err(), "nor where no street reaches");
        world.map.terrain.insert((5, 1), TerrainType::Water);
        assert!(!may(&world, Tool::Street, at(5, 0), at(5, 1)), "nor a street onto water");
        world.map.terrain.insert((5, 1), TerrainType::Grass);
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
                let edges = probe.map.edges.len();
                take_step(&mut probe, &mut events, Build { tool: Tool::Street, from, to, up: None , sides: None, road: false }, 0);
                assert_eq!(probe.map.edges.len() != edges, allowed, "step {dx},{dy}");
            }
        }
    }

    /// A drag of the demolisher cuts only the road between the tiles it
    /// crosses. A tap takes the road at the point, or the building there,
    /// back into the hand.
    #[test]
    fn a_drag_cuts_a_link_and_a_tap_takes_the_point() {
        let mut world = street();
        let mut events = EventQueue::new();
        let at = |x, y| GridCoord { x, y };
        let mut step = |world: &mut World, tool, from, to| handle_player_action(world, &mut events, 1, ClientMessage::Build(Build { tool, from, to, up: None, sides: None, road: false }), 0);
        // A side street, two tiles long, off the main one.
        step(&mut world, Tool::Street, at(5, 0), at(5, 1));
        step(&mut world, Tool::Street, at(5, 1), at(5, 2));
        step(&mut world, Tool::Demolish, at(5, 1), at(5, 2));
        assert!(!world.map.are_connected(at(5, 1), at(5, 2)), "the link is cut");
        assert!(world.map.road_node_at(at(5, 2)).is_none(), "and the end left with no road goes");
        assert!(world.map.are_connected(at(5, 0), at(5, 1)), "the rest stands");
        let sawmill = build(&mut world, 12, BuildingKind::Sawmill);
        let tile = world.map.building(sawmill).unwrap().tiles[0];
        let held = world.town.hand.get(&BuildingKind::Sawmill).copied().unwrap_or(0);
        step(&mut world, Tool::Demolish, tile, tile);
        assert!(world.map.objects.get(sawmill).is_none(), "the tap took the sawmill");
        assert_eq!(world.town.hand.get(&BuildingKind::Sawmill), Some(&(held + 1)), "back into the hand");
        // A tap takes the point and every link at it.
        step(&mut world, Tool::Demolish, at(5, 0), at(5, 0));
        assert!(world.map.road_node_at(at(5, 0)).is_none());
        assert!(world.map.road_node_at(at(5, 1)).is_none(), "the side street left with no road goes too");
    }

    /// Road comes off the town's tiles: a street laid past what is left
    /// is refused, and taking one up gives its tiles back.
    #[test]
    fn road_comes_off_the_town_tiles() {
        let mut world = street();
        world.town.allowance = world.map.laid + 2;
        let mut events = EventQueue::new();
        let at = |x, y| GridCoord { x, y };
        let mut step = |world: &mut World, tool, from, to| take_step(world, &mut events, Build { tool, from, to, up: None, sides: None, road: false }, 0);
        assert!(step(&mut world, Tool::Street, at(5, 0), at(5, 1)));
        assert!(step(&mut world, Tool::Street, at(5, 1), at(5, 2)));
        assert_eq!(world.town.roads(&world.map), 0);
        assert!(!step(&mut world, Tool::Street, at(5, 2), at(5, 3)), "laid with none left");
        assert!(step(&mut world, Tool::Demolish, at(5, 2), at(5, 2)));
        assert_eq!(world.town.roads(&world.map), 1, "the tile is not back");
    }
}
