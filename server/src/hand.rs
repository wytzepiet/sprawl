//! The mayor's hand: what a player asks of the town, done, and the rule of
//! where it may go (`may_step`), which the hand's dots are drawn by too.

use traffic::event_queue::EventQueue;
use model::GameTime;
use map::decks::MIDDLE;
use model::{Build, BuildingKind, ClientMessage, EntityId, GameObject, GridCoord, News, OwnerId, Tool};
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
        ClientMessage::Build(step) => build(world, events, owner, step, now),
        ClientMessage::Draw(stroke) => crate::draw::draw(world, events, owner, stroke, now),
        ClientMessage::Place { kind, at, facing } => return place(world, events, kind, at, facing, now),
        ClientMessage::Raze { building } => crate::town::raze(world, events, building, now),
        ClientMessage::Undo => return Some(crate::undo::undo(world, events, owner, now)),
        ClientMessage::Pick(n) => crate::town::pick(world, n),
        ClientMessage::DespawnAllCars => {
            let car_ids: Vec<EntityId> = world.map.objects.iter()
                .filter(|e| matches!(e.object, GameObject::Car(ref c) if c.trip.is_some()))
                .map(|e| e.id)
                .collect();
            for car_id in car_ids {
                world.drive(events, |t, e| traffic::car::simulation::park_at_home(t, e, car_id));
            }
        }
        ClientMessage::SetSpeed(_) | ClientMessage::RunTo(_) | ClientMessage::ResetWorld | ClientMessage::SetChunks(_) | ClientMessage::Ask(_) => {
            unreachable!("handled by Game::command")
        }
    }
    None
}

/// A step of a road or the demolisher, built as it is sent, and kept to
/// undo: a drag is one action.
fn build(world: &mut World, events: &mut EventQueue, owner: OwnerId, step: Build, now: GameTime) {
    let after = world.map.objects.next_id();
    let taken = (step.tool == Tool::Demolish).then(|| crate::undo::doomed(world, step)).flatten();
    // Along a road already there, a step changes its priority or its
    // lanes, and lays nothing for an undo to take up.
    let [hf, ht] = step.up.unwrap_or_default();
    let [sf, st] = step.sides.unwrap_or_default();
    let repaint = matches!(step.tool, Tool::Street | Tool::OneWay | Tool::Wide) && world.map.link_between_at(step.from, hf, sf, step.to, ht, st).is_some();
    if !take_step(world, events, step, now) || repaint {
        return;
    }
    crate::undo::stepped(world, owner, step, taken, after, now);
}

/// A building from the mayor's hand placed whole round `at`, its front
/// facing this way or the first way it fits; refused, the reason, for the
/// hand that asked.
fn place(world: &mut World, events: &mut EventQueue, kind: BuildingKind, at: GridCoord, facing: Option<u8>, now: GameTime) -> Option<News> {
    let refuse = |why: &str| Some(News { text: format!("No room for the {}", format!("{kind:?}").to_lowercase()), sub: why.to_string(), at: 0 });
    if !world.town.has(kind) {
        return refuse("None in hand");
    }
    let facing = facing.or_else(|| world.map.facing_for(kind, at)).unwrap_or(2);
    let tiles = match world.map.fit(kind, at, facing) {
        Ok(tiles) => tiles,
        Err(why) => return refuse(why),
    };
    let id = world.map.raise(kind, tiles, facing);
    crate::town::placed(world, events, id, now);
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
            let link = crate::undo::Link { from, to, one_way, road, up: [hf, ht], sides: [sf, st], wide: tool == Tool::Wide };
            if world.map.link_between_at(from, hf, sf, to, ht, st).is_none() && !world.affords(link) {
                return false;
            }
            lay(world, link);
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
            // the cars on it rerouted. A drag cuts only the road between
            // the two tiles.
            if from == to {
                if let Some(id) = world.map.node_in(to, ht, st) {
                    world.drive(events, |t, e| traffic::car::reroute::handle_road_demolish(t, e, id, now));
                }
            } else if let Some((a, b)) = world.map.link_between_at(from, hf, sf, to, ht, st) {
                world.drive(events, |t, e| traffic::car::reroute::handle_link_demolish(t, e, a, b, now));
            }
        }
    }
    true
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
            !(door && road)
                && !(tool == Tool::Wide && (sf != MIDDLE || st != MIDDLE))
                && world.map.may_lay_at_on(from, hf, sf, to, ht, st, tool, on, then)
        }
        Tool::Light => from == to && b.is_some_and(|id| world.map.is_intersection(id)),
        Tool::Demolish if from == to => b.is_some(),
        Tool::Demolish => world.map.link_between_at(from, hf, sf, to, ht, st).is_some(),
    }
}
