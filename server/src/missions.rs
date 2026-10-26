//! Missions: a few steps, each a fact the server reads off the town, a
//! line of text each, and a reward when the last is done. The opening is
//! one, the trunk follows it, and the town's situation opens the rest
//! when something first matters. docs/missions.md.
//!
//! Nothing here runs per tick. A mission's steps are read when something
//! that could have done one happened (`stir`): a build settled, a command,
//! a box unloaded, coins in, a settler off the ferry. A situation is
//! sensed where the server already finds it (`sense`): a call nothing in
//! town can answer, a car low on fuel with nowhere to fill. An order from
//! a town beyond the edge is a mission too, written by its mayor
//! (`orders.rs`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::engine::GameTime;
use crate::protocol::{BuildingKind, EntityId, GameObject, Good, Lump, DAY_MS};
use crate::world::World;

/// Which mission this is: each opens once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Key {
    Opening,
    Book,
    Sell,
    Pump,
    Quarry,
    Sawmill,
    Farm,
    Bakery,
    /// An order from a town beyond the edge, by its number: the number
    /// its boxes carry as their shipment's.
    Order(#[ts(type = "number")] u64),
}

/// What a step asks of the town: a fact read off the world.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "kind", content = "data")]
pub enum Goal {
    /// A building of this kind stands, built and reached by a street.
    Stands(BuildingKind),
    /// A depot's street joined to the harbour's.
    Joined,
    /// Something on a depot's shelf: a box fetched and unloaded.
    Fetched,
    /// Settlers in town: someone has driven off the ferry.
    Settled,
    /// A box booked to come in on the deck.
    Booked,
    /// Something sold over the sea.
    Sold,
    /// So many units of a good sailed for an order's town: counted by the
    /// ferry as it casts off (`orders::sailed`).
    Delivered { good: Good, units: f64, sailed: f64 },
}

/// What finishing a mission pays. Coins for now; XP once the level means
/// something.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "kind", content = "data")]
pub enum Reward {
    Coins(f64),
    /// An order's: its coins paid a box at a time as each sails, and
    /// standing with its mayor once the last has.
    Order { coins: f64, standing: f64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Step {
    pub goal: Goal,
    /// What it asks, in a line.
    pub title: String,
    /// How, paragraphs apart by a blank line.
    pub text: String,
    pub done: bool,
    /// The building the step's button acts on: the depot, for a depot's
    /// goal.
    #[ts(type = "number | null")]
    pub at: Option<EntityId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Mission {
    pub key: Key,
    pub title: String,
    pub steps: Vec<Step>,
    pub reward: Reward,
    #[ts(type = "number")]
    pub opened: GameTime,
    /// Finished, its steps done; or, for an order, given up on with a
    /// step not done.
    #[ts(type = "number | null")]
    pub finished: Option<GameTime>,
    /// Who asked, for an order.
    #[serde(default)]
    pub from: Option<crate::orders::Mayor>,
    /// When an order lapses.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub due: Option<GameTime>,
}

/// When a mission opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum When {
    /// With the town.
    Start,
    /// When another is finished: the trunk.
    After(Key),
    /// A call for this good that no depot in town has any of.
    Short(Good),
    /// A car low on fuel with nowhere to fill it.
    Dry,
}

struct Row {
    key: Key,
    when: When,
    title: &'static str,
    steps: &'static [(Goal, &'static str, &'static str)],
    reward: Reward,
}

/// Every mission the town can be given, a row each. A situation's waits
/// for the opening, and opens only if its steps are not already done.
const ROWS: &[Row] = &[
    Row {
        key: Key::Opening,
        when: When::Start,
        title: "The opening",
        steps: &[
            (Goal::Stands(BuildingKind::Harbour), "Build a harbour on the coast", "Take the harbour and drag it onto the coast. It stands half on the water, its back to the sea, and shows how it would stand, or, in red, why it cannot: the ferry needs open sea straight out behind it.\n\nLet go, and it stands at once, with a street of its own."),
            (Goal::Stands(BuildingKind::Depot), "Build a depot", "Where the town keeps what lands: drag it from the build menu beside the harbour's street, its yard to the street. Its lorry fetches boxes; its vans take timber and stone to the sites, and roads are laid on its stone."),
            (Goal::Joined, "Join them with a street", "From the depot's yard to the harbour's park. A street that reaches nothing is drawn red.\n\nA street is laid on stone, a unit a tile, off the depot's shelf. Till the starter pack's stone is in, the world sends it express, about a coin a tile."),
            (Goal::Fetched, "Fetch the starter pack", "Timber, stone, grain and fuel, the world's gift, come on the first ferry, and the harbour's forklifts lift them onto the quay. The depot's lorry fetches them as they land: tap it, and ride along."),
            (Goal::Settled, "Build houses", "Drag them from the build menu onto a street, side by side: each is a site till a van brings its four timber, and beside it as you drag is what the depot has. Then the next ferry brings their people. Take one down while it is new and you get back what it cost."),
        ],
        reward: Reward::Coins(100.0),
    },
    Row {
        key: Key::Book,
        when: When::After(Key::Opening),
        title: "The market",
        steps: &[(Goal::Booked, "Buy a box of timber", "Open the market: each good has a price that moves, and a graph of it. Tap timber and buy a box. It comes on the next ferry, and the nearest depot with room fetches it. Buying pushes the price up a little, and freight is on top.")],
        reward: Reward::Coins(25.0),
    },
    Row {
        key: Key::Sell,
        when: When::After(Key::Book),
        title: "Sell over the sea",
        steps: &[(Goal::Sold, "Sell a bag of grain", "Sell grain at the market, or send it to a mayor whose letter asks for it, at a better price. A depot's lorry takes it to the quay, and the coins land as the ferry casts off.")],
        reward: Reward::Coins(25.0),
    },
    Row {
        key: Key::Pump,
        when: When::Dry,
        title: "Cars running dry",
        steps: &[(Goal::Stands(BuildingKind::GasStation), "Build a gas station", "Cars are running low on fuel, with nowhere in town to fill up: build a gas station on the high street, where they pass.")],
        reward: Reward::Coins(50.0),
    },
    Row {
        key: Key::Quarry,
        when: When::Short(Good::Stone),
        title: "Sites wait on stone",
        steps: &[(Goal::Stands(BuildingKind::Quarry), "Build a quarry", "Your sites wait on stone, and no depot has any: build a quarry at the mountain's foot, and the depot's lorry fetches from its yard.")],
        reward: Reward::Coins(50.0),
    },
    Row {
        key: Key::Sawmill,
        when: When::Short(Good::Timber),
        title: "Sites wait on timber",
        steps: &[(Goal::Stands(BuildingKind::Sawmill), "Build a sawmill", "Your sites wait on timber, and no depot has any: build a sawmill at the forest's edge, and the depot's lorry fetches from its yard.")],
        reward: Reward::Coins(50.0),
    },
    Row {
        key: Key::Bakery,
        when: When::Short(Good::Bread),
        title: "Shelves run empty",
        steps: &[(Goal::Stands(BuildingKind::Bakery), "Build a bakery", "Shops call for bread, and no depot has any: build a bakery among the houses. It bakes the town's grain, and the depot's lorry takes its crates to the shops.")],
        reward: Reward::Coins(50.0),
    },
    Row {
        key: Key::Farm,
        when: When::Short(Good::Grain),
        title: "The bakery waits on grain",
        steps: &[(Goal::Stands(BuildingKind::Farm), "Build a farm", "The bakery calls for grain, and no depot has any: build a farm on open grass, or buy grain at the market. A farm's grain feeds the town, and what is over sells.")],
        reward: Reward::Coins(50.0),
    },
];

/// A finished mission stays in what the clients are sent this long, so
/// its last tick and its reward are seen: three hours of the town's day,
/// a few minutes of the player's.
const SHOWN_MS: GameTime = DAY_MS as GameTime / 8;

/// The town's missions, open and finished, and whether something has
/// happened since they were last read.
#[derive(Debug, Clone)]
pub struct Missions {
    pub list: Vec<Mission>,
    pub stirred: bool,
}

impl Default for Missions {
    /// A new town's: what opens with it.
    fn default() -> Self {
        let list = ROWS.iter().filter(|r| r.when == When::Start).map(|r| open(r, 0)).collect();
        Self { list, stirred: true }
    }
}

impl Missions {
    /// Something happened that could have done a step.
    pub fn stir(&mut self) {
        self.stirred = true;
    }

    fn has(&self, key: Key) -> bool {
        self.list.iter().any(|m| m.key == key)
    }

    pub fn finished(&self, key: Key) -> bool {
        self.list.iter().any(|m| m.key == key && m.finished.is_some())
    }

    /// What the clients are sent: every open mission, and those finished
    /// a little while ago.
    pub fn shown(&self, now: GameTime) -> Vec<Mission> {
        self.list.iter().filter(|m| m.finished.is_none_or(|f| now < f + SHOWN_MS)).cloned().collect()
    }
}

fn open(row: &Row, now: GameTime) -> Mission {
    Mission {
        key: row.key,
        title: row.title.into(),
        steps: row.steps.iter().map(|&(goal, title, text)| Step { goal, title: title.into(), text: text.into(), done: false, at: None }).collect(),
        reward: row.reward,
        opened: now,
        finished: None,
        from: None,
        due: None,
    }
}

/// Is the fact true of the town now.
fn met(world: &World, goal: Goal) -> bool {
    match goal {
        Goal::Stands(kind) => world.objects.iter().any(|e| matches!(e.object, GameObject::Building(ref b) if b.kind == kind && b.site.is_none()) && world.street_of(e.id).is_some()),
        Goal::Joined => world.depots().into_iter().any(|(id, _)| world.street_of(id).and_then(|s| world.objects.get(s)).is_some_and(|s| matches!(s.object, GameObject::RoadNode(ref n) if n.joined))),
        Goal::Fetched => world.depots().into_iter().any(|(_, b)| b.stocks.values().any(|s| s.level > 0.0)),
        Goal::Settled => world.objects.iter().any(|e| matches!(e.object, GameObject::Resident(ref r) if r.at.is_some())),
        Goal::Booked => crate::haul::packages(world).iter().any(|(t, ..)| !t.outbound && t.price > 0.0),
        Goal::Sold => world.town.season().any(|p| p.sold.values().any(|&c| c > 0.0)),
        Goal::Delivered { units, sailed, .. } => sailed >= units - 1e-6,
    }
}

/// What a step's button acts on.
fn at(world: &World, goal: Goal) -> Option<EntityId> {
    match goal {
        Goal::Stands(_) | Goal::Settled => None,
        // The deck is the harbour's.
        Goal::Booked | Goal::Sold | Goal::Delivered { .. } => world.harbours.keys().next().copied(),
        _ => world.depots().into_iter().next().map(|(id, _)| id),
    }
}

/// Read every open mission's steps, if anything happened that could have
/// done one; pay for what is finished, and open what follows it. A box
/// unloaded and coins in are lumps, so they need no hook of their own.
pub fn check(world: &mut World, now: GameTime) {
    let landed = world.lumps.iter().any(|l| l.units > 0.0 || l.coins > 0.0);
    if !std::mem::take(&mut world.missions.stirred) && !landed {
        return;
    }
    loop {
        for i in 0..world.missions.list.len() {
            if world.missions.list[i].finished.is_some() {
                continue;
            }
            for s in 0..world.missions.list[i].steps.len() {
                let step = &world.missions.list[i].steps[s];
                let (done, here) = (step.done || met(world, step.goal), at(world, step.goal));
                let step = &mut world.missions.list[i].steps[s];
                (step.done, step.at) = (done, here);
            }
            if world.missions.list[i].steps.iter().all(|s| s.done) {
                world.missions.list[i].finished = Some(now);
                if let Reward::Coins(coins) = world.missions.list[i].reward {
                    pay(world, coins, now);
                }
            }
        }
        let next: Vec<Mission> = ROWS.iter().filter(|r| matches!(r.when, When::After(k) if world.missions.finished(k)) && !world.missions.has(r.key)).map(|r| open(r, now)).collect();
        if next.is_empty() {
            return;
        }
        world.missions.list.extend(next);
    }
}

/// A reward: coins from the world, landing at the harbour as trade does.
fn pay(world: &mut World, coins: f64, now: GameTime) {
    world.treasury += coins;
    if let Some(&harbour) = world.harbours.keys().next() {
        world.lumps.push(Lump { building: harbour, coins, gdp: 0.0, at: now, good: None, units: 0.0 });
    }
}

/// The server found a situation: the mission it opens does, once, after
/// the opening, and only if the town has not already done what it asks.
pub fn sense(world: &mut World, when: When, now: GameTime) {
    let Some(row) = ROWS.iter().find(|r| r.when == when && !world.missions.has(r.key)) else { return };
    if !world.missions.finished(Key::Opening) {
        return;
    }
    // Short is short in the whole town: a van busy elsewhere is not.
    let real = match when {
        When::Short(good) => !world.depots().into_iter().any(|(_, b)| b.stocks.get(&good).is_some_and(|s| s.level > 0.0)),
        _ => true,
    };
    if !real || row.steps.iter().all(|&(goal, ..)| met(world, goal)) {
        return;
    }
    world.missions.list.push(open(row, now));
    world.missions.stir();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::tests::*;
    use crate::calls;
    use crate::resident::handle_resident_wake;
    use crate::game::settle_and_wake;
    use crate::protocol::{BuildingKind, Good, GridCoord, TerrainType};
    use crate::engine::event_queue::EventQueue;

    /// A shelf emptied, or filled.
    fn shelve(world: &mut World, at: EntityId, good: Good, level: f64) {
        if let Some(b) = world.building_mut(at) {
            b.stocks.get_mut(&good).unwrap().level = level;
        }
    }

    /// A situation opens its mission when it first matters, once: a site
    /// calls for stone that no depot in town has. Not during the opening,
    /// not while a depot has some and only its van is busy, and not
    /// again once open; and building the quarry it asks for finishes it
    /// and pays.
    #[test]
    fn a_site_short_of_stone_asks_for_a_quarry_once() {
        use crate::missions::Key;
        let mut world = street();
        for x in QUARRY_X - 5..QUARRY_X + 7 {
            for y in 5..14 {
                world.terrain.insert((x, y), TerrainType::Mountain);
            }
        }
        let depot = build(&mut world, 30, BuildingKind::Depot);
        for good in [Good::Stone, Good::Timber, Good::Bread, Good::Fuel] {
            shelve(&mut world, depot, good, if good == Good::Stone { 0.0 } else { 100.0 });
        }
        let mut events = EventQueue::new();
        settle_and_wake(&mut world, &mut events);
        // Its missions read, as the step after this reads them.
        let quarry = |world: &mut World| {
            check(world, 0);
            world.missions.list.iter().filter(|m| m.key == Key::Quarry).map(|m| m.finished.is_some()).collect::<Vec<_>>()
        };
        // Flats, a site of timber and stone, call for both, and the depot
        // has no stone.
        let at = GridCoord { x: 100, y: 1 };
        let facing = world.site_for(at, BuildingKind::Apartment).unwrap();
        let flats = world.place_building(at, BuildingKind::Apartment, facing).unwrap();
        world.orient(flats);
        calls::turn(&mut world, &mut events, flats, 0);
        assert!(world.calls.iter().any(|c| c.at == flats && c.good == Good::Stone && c.answered_by.is_none()), "the flats never called for stone");
        assert_eq!(quarry(&mut world), [false; 0], "it opened during the opening");
        opening_done(&mut world);
        // A depot with stone sends its van, and the town is not short.
        shelve(&mut world, depot, Good::Stone, 10.0);
        calls::dispatch(&mut world, &mut events, 0);
        let van = world.calls.iter().find(|c| c.at == flats && c.good == Good::Stone).and_then(|c| c.answered_by).expect("the van never set out");
        assert!(car_of(&world, van).load.is_some_and(|(g, u)| g == Good::Stone && u > 0.0), "the van set out without its stone on it, to be seen");
        assert_eq!(quarry(&mut world), [false; 0], "it opened while the depot had stone");
        // Then the shelf is empty, and the flats call again.
        world.calls.clear();
        shelve(&mut world, depot, Good::Stone, 0.0);
        calls::turn(&mut world, &mut events, flats, 0);
        assert_eq!(quarry(&mut world), [false], "no depot has stone, and nothing asked for a quarry");
        calls::dispatch(&mut world, &mut events, 0);
        calls::turn(&mut world, &mut events, flats, 0);
        assert_eq!(quarry(&mut world), [false], "it opened twice");
        let before = world.treasury;
        build(&mut world, QUARRY_X, BuildingKind::Quarry);
        settle_and_wake(&mut world, &mut events);
        assert_eq!(quarry(&mut world), [true], "the quarry stands and the mission is open");
        assert!((world.treasury - before - 50.0).abs() < 1e-9, "the quarry's mission paid {}", world.treasury - before);
    }

    /// A car low on fuel with nowhere in town to fill it asks for a gas
    /// station, once the opening is done; a full tank does not.
    #[test]
    fn a_car_running_dry_asks_for_a_gas_station() {
        use crate::missions::Key;
        use crate::needs::Need;
        let mut world = street();
        let house = build(&mut world, 10, BuildingKind::House);
        let mut events = EventQueue::new();
        settle_and_wake(&mut world, &mut events);
        let id = world.household(house)[0];
        let car = world.resident(id).unwrap().car;
        if let Some(r) = world.resident_mut(id) {
            r.at = Some(house);
        }
        let tank = |world: &mut World, full: f64| {
            if let Some(c) = world.car_mut(car) {
                let s = c.stocks.get_mut(&Need::Fuel).unwrap();
                s.level = s.cap * full;
            }
        };
        let pump = |world: &World| world.missions.list.iter().filter(|m| m.key == Key::Pump).count();
        tank(&mut world, 0.1);
        handle_resident_wake(&mut world, &mut events, id, 0);
        assert_eq!(pump(&world), 0, "it opened during the opening");
        opening_done(&mut world);
        tank(&mut world, 0.9);
        handle_resident_wake(&mut world, &mut events, id, 1);
        assert_eq!(pump(&world), 0, "a full tank asked for a pump");
        tank(&mut world, 0.1);
        handle_resident_wake(&mut world, &mut events, id, 2);
        handle_resident_wake(&mut world, &mut events, id, 3);
        assert_eq!(pump(&world), 1, "a dry tank with nowhere to fill opened {} missions", pump(&world));
    }
}
