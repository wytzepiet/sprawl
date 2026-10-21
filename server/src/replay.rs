//! A level played, kept to play again: the inputs that drove it, each at
//! the moment of the game it came in, and nothing else. The game is the
//! same from the same inputs (`hash.rs`, `Game::step`), so everything else
//! follows from them, here as in the browser it was played in.
//!
//! A `Session` is a level and its game, driven one way whether a player
//! drives it (`web/`) or a replay does: every step sets off whoever the
//! level has due, then steps the game, and every few sim seconds it takes the
//! game's fingerprint. A replay carries those fingerprints, so playing it
//! says where it first went another way, if it does: a change to the game
//! since it was recorded, or something in it that is not yet the same from
//! run to run.
//!
//! A player who sees something wrong flags the moment (`Flag`) and copies
//! the replay; kept in `replays/`, it plays in the suite, and `cargo run
//! --bin replay` plays it to a moment and shows what every car there is
//! doing, and why.

use std::hash::Hasher;

use serde::{Deserialize, Serialize};

use crate::car::{nose, tail};
use crate::engine::GameTime;
use crate::fixed::{HashMap, HashSet};
use crate::game::Game;
use crate::level::Level;
use crate::protocol::{CarRole, ClientMessage, DAY_MS, EntityId, GameObject, OwnerId};

/// The one player a session has.
const ME: u64 = 1;
/// How often a session takes the game's fingerprint: often enough to say
/// near when a replay went another way, seldom enough to paste an hour.
const PRINT_MS: GameTime = 5000;

/// What a player did, at a moment of the game.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Input {
    /// A command to the game: a road drawn, an undo, a building.
    Do(ClientMessage),
    /// The level's test started.
    Test,
    /// Back to building.
    Build,
}

/// A moment a player marked: where, and what they saw.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Flag {
    pub at: GameTime,
    pub tile: Option<[i32; 2]>,
    pub note: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Replay {
    /// The code it was played on: another plays it another way.
    pub commit: String,
    pub level: String,
    /// The level's own text, as it was.
    pub text: String,
    pub inputs: Vec<(GameTime, Input)>,
    #[serde(default)]
    pub flags: Vec<Flag>,
    /// The game's fingerprint every `PRINT_MS` (`fingerprint`), in hex.
    pub prints: Vec<(GameTime, String)>,
}

/// Where a replay went another way than it was played.
#[derive(Debug)]
pub struct Diverged {
    pub at: GameTime,
}

pub struct Session {
    pub game: Game,
    pub level: Level,
    /// What has been played, as a replay of it.
    pub record: Replay,
}

impl Session {
    /// A level from its name and text, at noon, its traffic running.
    pub fn new(name: &str, text: &str, commit: &str) -> Session {
        let (level, world) = Level::build(name, text);
        let (n, t) = (name.to_string(), text.to_string());
        let again = move || Level::parse(&n, &t).1;
        let mut game = Game::new(world, DAY_MS as u64 / 2, 1, Box::new(again));
        game.connect(ME, OwnerId::default());
        let record = Replay { commit: commit.to_string(), level: name.to_string(), text: text.to_string(), ..Replay::default() };
        Session { game, level, record }
    }

    /// What a player did, done, and written down.
    pub fn input(&mut self, input: Input) {
        match &input {
            Input::Do(msg) => self.game.command(ME, msg.clone()),
            Input::Test => self.level.test(&mut self.game),
            Input::Build => self.level.build_again(),
        }
        self.record.inputs.push((self.game.now, input));
    }

    /// A command from the player that changes the game is an input; one
    /// that only asks or looks is not.
    pub fn command(&mut self, msg: ClientMessage) {
        match msg {
            ClientMessage::SetChunks(_) | ClientMessage::Ask(_) | ClientMessage::SetSpeed(_) => self.game.command(ME, msg),
            msg => self.input(Input::Do(msg)),
        }
    }

    pub fn flag(&mut self, tile: Option<[i32; 2]>, note: String) {
        self.record.flags.push(Flag { at: self.game.now, tile, note });
    }

    /// One step: its fingerprint, if it is time, then whoever is due set
    /// off, then the game.
    pub fn step(&mut self) {
        Self::before(&mut self.level, &mut self.record, &mut self.game);
        self.game.step();
    }

    /// As many steps as the clock's speed, and what they said sent.
    pub fn tick(&mut self) -> u32 {
        let (level, record) = (&mut self.level, &mut self.record);
        self.game.tick_with(|game| Self::before(level, record, game))
    }

    fn before(level: &mut Level, record: &mut Replay, game: &mut Game) {
        if game.now % PRINT_MS == 0 {
            record.prints.push((game.now, format!("{:016x}", fingerprint(game))));
        }
        level.step(game);
    }

    /// As far as a replay was played.
    pub fn end(replay: &Replay) -> GameTime {
        let last = |v: Option<GameTime>| v.unwrap_or(0);
        last(replay.prints.last().map(|p| p.0 + PRINT_MS)).max(last(replay.inputs.last().map(|i| i.0 + crate::game::STEP_MS)))
    }

    /// The replay to the moment it was last played to.
    pub fn json(&self) -> String {
        serde_json::to_string(&self.record).unwrap_or_default()
    }
}

/// A replay playing: its inputs come in at the moments they did, before
/// that moment's step, as they did when a tick ended there.
pub struct Playback<'a> {
    pub session: Session,
    replay: &'a Replay,
    next: usize,
}

impl<'a> Playback<'a> {
    pub fn new(replay: &'a Replay) -> Self {
        Playback { session: Session::new(&replay.level, &replay.text, &replay.commit), replay, next: 0 }
    }

    /// One step, and whether the game went another way than it was
    /// played in it: a change to the game since, or something not yet the
    /// same from run to run.
    pub fn step(&mut self) -> Result<(), Diverged> {
        let s = &mut self.session;
        while let Some((_, input)) = self.replay.inputs.get(self.next).filter(|i| i.0 <= s.game.now) {
            s.input(input.clone());
            self.next += 1;
        }
        let printed = s.record.prints.len();
        s.step();
        match s.record.prints.get(printed) {
            Some(mine) if self.replay.prints.iter().any(|p| p.0 == mine.0 && p.1 != mine.1) => Err(Diverged { at: mine.0 }),
            _ => Ok(()),
        }
    }

    /// Played up to a moment, or to where it went another way.
    #[cfg(test)]
    pub fn to(&mut self, until: GameTime) -> Result<(), Diverged> {
        while self.session.game.now < until {
            self.step()?;
        }
        Ok(())
    }
}

/// What looks wrong in a game as it plays, said once each: two cars in one
/// lane closer than their lengths, one driving through the other; a car
/// standing for longer than `STUCK_MS`, waiting for what never comes: at a
/// junction, or behind cars at one, that has let nobody through meanwhile
/// (one waiting for a gap in a road that keeps coming is a road full); a car
/// on a priority road made to wait, braking to a crawl, at a junction one
/// off a minor road holds. Slowing for one that pulled out, and going on,
/// is only driving.
#[derive(Default)]
pub struct Watch {
    standing: HashMap<EntityId, GameTime>,
    /// Who each junction a car stands for has let through, and since when.
    through: HashMap<EntityId, (Vec<EntityId>, GameTime)>,
    said: HashSet<(EntityId, EntityId)>,
}

/// How long a car may stand before it is called stuck: longer than any
/// light is red.
pub const STUCK_MS: GameTime = 30_000;

impl Watch {
    /// What has gone wrong since it last looked.
    pub fn look(&mut self, game: &Game) -> Vec<String> {
        let world = &game.world;
        let mut out = Vec::new();
        for (edge, seg) in &world.edges {
            for lane in 0..seg.lanes as usize {
                // On it, not yet coming to it by another road.
                let mut on: Vec<(f64, EntityId, CarRole)> = seg
                    .lane(lane)
                    .filter_map(|c| match world.objects.get(c).map(|e| &e.object) {
                        Some(GameObject::Car(car)) => {
                            let t = car.trip.as_ref()?;
                            let i = t.route_index;
                            ((t.route[i - 1], t.route[i]) == *edge).then(|| (t.at(game.now).0 - t.along[i - 1], c, car.role))
                        }
                        _ => None,
                    })
                    .collect();
                on.sort_by(|a, b| a.0.total_cmp(&b.0));
                for w in on.windows(2) {
                    let ((p, a, ra), (q, b, rb)) = (w[0], w[1]);
                    if q - p < nose(ra) + tail(rb) - 0.02 && self.said.insert((a.min(b), a.max(b))) {
                        out.push(format!("{}: cars {a} and {b} {:.2} apart in lane {lane}, at {}", clock(game.now), q - p, place(world, edge.1)));
                    }
                }
            }
        }
        for e in world.objects.iter() {
            let GameObject::Car(c) = &e.object else { continue };
            let Some(t) = c.trip.as_ref() else {
                self.standing.remove(&e.id);
                continue;
            };
            // Held at a junction, or for one let in there before it that is
            // standing at its line, not coming in ahead of it.
            let speed = |o: EntityId| match world.objects.get(o).map(|e| &e.object) {
                Some(GameObject::Car(c)) => c.trip.as_ref().map_or(0.0, |t| t.at(game.now).1),
                _ => 0.0,
            };
            // Standing, and not behind one on its way.
            let standing = |o: EntityId| {
                speed(o) < 0.01
                    && !matches!(world.why(o), Some((crate::car::Cause::Ahead(a) | crate::car::Cause::Merging(a), _)) if speed(a) >= 0.01)
            };
            let held = match world.why(e.id) {
                Some((crate::car::Cause::Junction(j), a)) => Some((j, a, game.intersections.who(j).0)),
                Some((crate::car::Cause::Merging(l), a)) if standing(l) => t.route[t.route_index..].iter().find(|&&j| game.intersections.has_passage(j, e.id) && game.intersections.has_passage(j, l)).map(|&j| (j, a, vec![l])),
                _ => None,
            };
            if let Some((j, a, them)) = held
                && a < -0.3
                && t.at(game.now).1 < crate::car::CRUISE_SPEED / 4.0
                && on_priority(world, e.id, j) == Some(true)
            {
                // Not one in the junction already, past its line, held up on
                // its way out: the jam holds them both, not the junction.
                let inside = |o: EntityId| match world.objects.get(o).map(|e| &e.object) {
                    Some(GameObject::Car(c)) => c.trip.as_ref().is_some_and(|t| {
                        (1..t.route.len()).find(|&k| t.route[k] == j).is_none_or(|k| t.along[k] - t.at(game.now).0 < t.segment_lengths[k] / 2.0)
                    }),
                    _ => false,
                };
                for o in them.into_iter().filter(|&o| on_priority(world, o, j) == Some(false) && !inside(o)) {
                    if self.said.insert((e.id, o)) {
                        out.push(format!("{}: car {} on the priority road brakes for car {o} off a minor one, at {}", clock(game.now), e.id, place(world, j)));
                    }
                }
            }
            if t.at(game.now).1 > 0.01 || t.acceleration > 0.0 {
                self.standing.remove(&e.id);
                continue;
            }
            self.standing.entry(e.id).or_insert(game.now);
            // The junction it waits at, itself or behind those ahead of it;
            // none, if one ahead of it is on its way.
            let mut waits = Some(e.id);
            let mut at_junction = None;
            let going = |o: EntityId| match world.objects.get(o).map(|e| &e.object) {
                Some(GameObject::Car(c)) => c.trip.as_ref().is_some_and(|t| t.at(game.now).1 > 0.01 || t.acceleration > 0.0),
                _ => false,
            };
            for _ in 0..64 {
                if waits.is_some_and(|w| w != e.id && going(w)) {
                    self.standing.insert(e.id, game.now);
                    break;
                }
                match waits.and_then(|w| world.why(w)) {
                    Some((crate::car::Cause::Junction(j), _)) => {
                        at_junction = Some(j);
                        break;
                    }
                    Some((crate::car::Cause::Ahead(o) | crate::car::Cause::Merging(o), _)) => waits = Some(o),
                    _ => break,
                }
            }
            let since = self.standing[&e.id];
            let moving = at_junction.map_or(since, |j| {
                // Who, not in what order: cars let through, giving it back
                // and let through again, go nowhere.
                let mut now_through = game.intersections.who(j).0;
                now_through.sort_unstable();
                let seen = self.through.entry(j).or_insert((now_through.clone(), game.now));
                if seen.0 != now_through {
                    *seen = (now_through, game.now);
                }
                seen.1.max(since)
            });
            if game.now - moving >= STUCK_MS && self.said.insert((e.id, e.id)) {
                out.push(format!("{}: car {} standing since {}, at {}", clock(game.now), e.id, clock(since), place(world, t.route[t.route_index])));
            }
        }
        out
    }
}

/// A moment of a session, as a clock: minutes and seconds since noon,
/// when every level starts.
pub fn clock(now: GameTime) -> String {
    let s = now.saturating_sub(DAY_MS as u64 / 2) / 1000;
    format!("{}:{:02}.{}", s / 60, s % 60, now % 1000 / 100)
}

/// Whether a car comes to junction `j` on a priority road, if it comes to
/// it at all.
fn on_priority(world: &crate::world::World, car: EntityId, j: EntityId) -> Option<bool> {
    let Some(GameObject::Car(c)) = world.objects.get(car).map(|e| &e.object) else { return None };
    let t = c.trip.as_ref()?;
    let k = (1..t.route.len()).find(|&k| t.route[k] == j)?;
    Some(world.is_road_between(t.route[k - 1], j))
}

/// Where a node is, as a tile.
fn place(world: &crate::world::World, node: EntityId) -> String {
    world.objects.get(node).and_then(|e| e.position).map_or("?".into(), |p| format!("{},{}", p.x, p.y))
}

/// The state of the game's traffic, in a number: when, how much is in the
/// world, and every car, where along its way and how fast. Written a word
/// at a time, so it is the same number on every machine.
pub fn fingerprint(game: &Game) -> u64 {
    let mut h = std::hash::DefaultHasher::new();
    h.write_u64(game.now);
    h.write_u64(game.world.objects.len() as u64);
    let mut cars: Vec<_> = game
        .world
        .objects
        .iter()
        .filter_map(|e| match &e.object {
            GameObject::Car(c) => Some((e.id, c.trip.as_ref())),
            _ => None,
        })
        .collect();
    cars.sort_by_key(|c| c.0);
    for (id, trip) in cars {
        h.write_u64(id);
        let Some(t) = trip else { continue };
        for x in [t.route_index as u64, t.updated_at, t.progress.to_bits(), t.speed.to_bits(), t.acceleration.to_bits()] {
            h.write_u64(x);
        }
        for &l in &t.lanes {
            h.write_u8(l);
        }
    }
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A level played as a browser plays it, its own solve laid a road at
    /// a time and tested, ticked at one speed and then another: played
    /// again from its inputs, step by step, it is the same game.
    #[test]
    fn a_level_plays_again_as_it_was_played() {
        let name = "09-rush-hour";
        let text = std::fs::read_to_string(format!("{}/levels/{name}.txt", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let mut live = Session::new(name, &text, "");
        for _ in 0..7 {
            live.tick();
        }
        for step in live.level.solve_steps(&live.game.world) {
            live.command(ClientMessage::Build(step));
            live.tick();
        }
        live.input(Input::Test);
        live.command(ClientMessage::SetSpeed(12));
        for k in 0..600 {
            if k == 300 {
                live.command(ClientMessage::SetSpeed(5));
            }
            live.tick();
        }
        let mut again = Playback::new(&live.record);
        again.to(live.game.now).expect("the same game");
        assert_eq!(fingerprint(&again.session.game), fingerprint(&live.game));
        assert!(live.record.prints.len() > 10, "{} prints", live.record.prints.len());
    }

    /// Every replay kept (`replays/`), played on today's game, with nothing
    /// going wrong in it (`Watch`): kept because something did, it is the
    /// case the fix is checked by. Not as it was played: the fix changed
    /// that.
    #[test]
    fn nothing_goes_wrong_in_a_kept_replay() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/replays");
        for path in std::fs::read_dir(dir).into_iter().flatten().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "json")) {
            let replay: Replay = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let mut play = Playback::new(&replay);
            let mut watch = Watch::default();
            while play.session.game.now < Session::end(&replay) {
                let _ = play.step();
                let wrong = watch.look(&play.session.game);
                assert!(wrong.is_empty(), "{}: {}", path.display(), wrong.join("; "));
            }
            let s = &play.session;
            assert_ne!(s.level.phase(), crate::level::Phase::Jammed, "{}: {}", path.display(), s.level.state(&s.game).message);
        }
    }
}
