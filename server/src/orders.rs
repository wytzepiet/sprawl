//! The order board: letters from the mayors of the towns beyond the map's
//! edge, each asking for packages of a good, and paying for them as they sail
//! (docs/missions.md §Orders).
//!
//! A letter comes in on a ferry. An order is a mission (`Key::Order`): one
//! step, so many units of a good sailed for its town, and its reward the
//! mayor's. While it wants more, its mayor is a partner to book a slot
//! going out to (`offers`): the package carries the order's number as its
//! shipment's, rides a lorry to the quay and sails with the ferry to the edge,
//! and the mayor's coins land at the harbour as it casts off (`sailed`).
//! An order not filled by its day lapses as a ferry comes in.
//!
//! The deck is booked here too (docs/trade.md §The deck): a package from
//! the market or for it (`market.rs`), or for a mayor whose letter asks for
//! it. A slot coming in rides the next ferry and lands for the nearest
//! depot with room; a slot going out waits at the harbour for a depot's
//! lorry to load it.
//!
//! A mayor's standing with the town is read off the orders: what they
//! started with, a point for each filled and half one off for each that
//! lapsed. Nothing else about a mayor is kept.

use model::orders::{Mayor, Compass, Neighbour, Letter};

use model::blueprint::blueprint;
use model::GameTime;
use model::missions::{Goal, Key, Mission, Reward, Step};
use model::{BuildingKind, EntityId, GameObject, Good, Leg, News, Package, DAY_MS};
use crate::world::World;

struct Who {
    mayor: Mayor,
    name: &'static str,
    town: &'static str,
    toward: Compass,
    colour: &'static str,
    /// What they ask for, most wanted first.
    goods: &'static [Good],
    /// What their town makes: what pushes the market's price down, as
    /// what they want pushes it up.
    sells: &'static [Good],
    /// Packages in a letter, before standing adds to it.
    packages: u32,
    /// What they pay, over the world's price.
    price: f64,
    /// Standing before any order.
    trust: f64,
    /// A letter: cool, then warm, `{n}` how many of what.
    voice: [&'static str; 2],
}

const WHO: [Who; 4] = [
    Who {
        mayor: Mayor::Tam,
        name: "Old Tam",
        town: "Saltmere",
        toward: Compass::West,
        colour: "#3f7fa8",
        goods: &[Good::Crates, Good::Fuel],
        sells: &[Good::Crates],
        packages: 5,
        price: 1.25,
        trust: 1.0,
        voice: [
            "The boats are in and the larder isn't. Could you spare {n}? No great hurry, the fish keep.",
            "You've never let Saltmere down. {n} again, if you would, and a pint for whoever drives it.",
        ],
    },
    Who {
        mayor: Mayor::Mira,
        name: "Mira",
        town: "Northgate",
        toward: Compass::North,
        colour: "#6b5b7b",
        goods: &[Good::Timber],
        sells: &[Good::Stone],
        packages: 10,
        price: 1.5,
        trust: 0.0,
        voice: [
            "We're short of timber before winter. Can you send {n}?",
            "Your props hold. {n}. Same as before.",
        ],
    },
    Who {
        mayor: Mayor::Bess,
        name: "Bess",
        town: "Fernhollow",
        toward: Compass::South,
        colour: "#c98a2b",
        goods: &[Good::Stone, Good::Timber],
        sells: &[Good::Crates, Good::Timber],
        packages: 10,
        price: 1.5,
        trust: 0.0,
        voice: [
            "Hello from Fernhollow! The cows have kicked the barn down again. {n} would put it right!",
            "Our favourite town! Another barn, another {n}. The cows send their love.",
        ],
    },
    Who {
        mayor: Mayor::Aldra,
        name: "Lord Aldra",
        town: "Port Aldra",
        toward: Compass::East,
        colour: "#a33b3b",
        goods: &[Good::Crates, Good::Timber, Good::Stone, Good::Fuel],
        sells: &[Good::Fuel, Good::Timber],
        packages: 20,
        price: 2.0,
        trust: 0.0,
        voice: [
            "Port Aldra has heard well of you. We require {n}, and pay accordingly.",
            "My dear friend: {n}, at your earliest convenience. The usual terms, with our thanks.",
        ],
    },
];

fn who(mayor: Mayor) -> &'static Who {
    &WHO[mayor as usize]
}

/// Orders open at once, at most.
pub const OPEN: usize = 3;
/// Between one letter and the next, at least: a third of the town's day.
pub const GAP: GameTime = DAY_MS as GameTime / 3;
/// How long an order stands: two of the town's days.
pub const LASTS: GameTime = 2 * DAY_MS as GameTime;
/// Standing, as filled orders raise it and lapsed ones lower it, between
/// none and this.
pub const MOST: f64 = 5.0;
const FILLED: f64 = 1.0;
const LAPSED: f64 = 0.5;
/// Standing with another mayor before Port Aldra writes.
pub const GOOD: f64 = 3.0;
/// Each point of standing adds this much to what a letter pays.
const WARMTH: f64 = 0.1;

fn orders(world: &World) -> impl Iterator<Item = &Mission> {
    world.missions.list.iter().filter(|m| matches!(m.key, Key::Order(_)))
}

fn open(world: &World) -> impl Iterator<Item = &Mission> {
    orders(world).filter(|m| m.finished.is_none())
}

/// How a mayor stands with the town, read off their orders.
pub fn standing(world: &World, mayor: Mayor) -> f64 {
    orders(world).filter(|m| m.from == Some(mayor) && m.finished.is_some()).fold(who(mayor).trust, |s, m| {
        let filled = m.steps.iter().all(|s| s.done);
        (s + if filled { FILLED } else { -LAPSED }).clamp(0.0, MOST)
    })
}

/// Does the mayor write yet: Port Aldra only once the town stands well
/// with someone else.
fn writes(world: &World, mayor: Mayor) -> bool {
    mayor != Mayor::Aldra || WHO.iter().any(|w| w.mayor != Mayor::Aldra && standing(world, w.mayor) >= GOOD)
}

pub fn neighbours(world: &World) -> Vec<Neighbour> {
    WHO.iter()
        .map(|w| Neighbour {
            mayor: w.mayor,
            name: w.name.into(),
            town: w.town.into(),
            toward: w.toward,
            colour: w.colour.into(),
            standing: standing(world, w.mayor),
            writes: writes(world, w.mayor),
        })
        .collect()
}

/// What the town can send: goods a maker in town makes and the depots
/// have two lorryloads of; and, one step further, goods a kind of building
/// not built yet would make.
pub fn sourceable(world: &World) -> (Vec<Good>, Vec<Good>) {
    let mut now = Vec::new();
    let mut built = Vec::new();
    let kept = |good: Good| world.map.depots().into_iter().map(|(_, b)| b.stocks.get(&good).map_or(0.0, |s| s.level)).sum::<f64>();
    for e in world.map.objects.iter() {
        let GameObject::Building(ref b) = e.object else { continue };
        built.push(b.kind);
        let made = blueprint(b.kind).makes.filter(|&g| b.site.is_none() && world.map.street_of(e.id).is_some() && kept(g) >= crate::haul::LOAD as f64 * g.per_package());
        if let Some(g) = made.filter(|g| !now.contains(g)) {
            now.push(g);
        }
    }
    let further = BuildingKind::ALL.iter().filter(|&&k| !built.contains(&k)).filter_map(|&k| blueprint(k).makes).filter(|g| !now.contains(g)).collect();
    (now, further)
}

fn named(good: Good) -> String {
    format!("{good:?}").to_lowercase()
}

/// A ferry came in at the harbour: what is overdue lapses, and a letter
/// may come with it. At most `OPEN` at once, one a `GAP`, and none before
/// the opening is done.
pub fn post(world: &mut World, harbour: EntityId, now: GameTime) {
    // One whose last package has sailed is filled, if not yet read as filled.
    for m in world.missions.list.iter_mut().filter(|m| m.finished.is_none() && !m.steps[0].done && m.due.is_some_and(|d| d <= now)) {
        m.finished = Some(now);
        let (w, Goal::Delivered { good, .. }) = (who(m.from.unwrap_or(Mayor::Tam)), m.steps[0].goal) else { continue };
        world.news.push(News { text: format!("{} of {} gave up waiting", w.name, w.town), sub: format!("for {}: standing falls", named(good)), at: harbour });
    }
    let last = orders(world).map(|m| m.opened).max();
    if !world.missions.finished(Key::Opening) || open(world).count() >= OPEN || last.is_some_and(|t| now < t + GAP) {
        return;
    }
    if let Some(order) = write(world, now) {
        let Goal::Delivered { good, units, .. } = order.steps[0].goal else { return };
        let n = crate::economy::whole(units, good);
        let (w, Reward::Order { coins, .. }) = (who(order.from.unwrap()), order.reward) else { return };
        world.news.push(News {
            text: format!("A letter from {} of {}", w.name, w.town),
            sub: format!("{} for {coins:.0} coins", good.packages(n)),
            at: harbour,
        });
        world.missions.list.push(order);
        world.missions.stir();
    }
}

/// The next letter: from whoever has written least, of those who write
/// and want something the town can send, Tam before Mira before Bess
/// before Port Aldra. Every third reaches one step further, for a good
/// another building would make, where a mayor wants one, and so does the
/// first, while the town makes nothing to spare. Otherwise nobody asks
/// what the town cannot send now: no letter is better than one that
/// lapses.
pub fn write(world: &mut World, now: GameTime) -> Option<Mission> {
    let (can, further) = sourceable(world);
    let stretch = orders(world).count() % 3 == 2 || can.is_empty();
    let sets = if stretch { vec![&further, &can] } else { vec![&can] };
    let mut by: Vec<(usize, Mayor)> = WHO.iter().filter(|w| writes(world, w.mayor) && !open(world).any(|m| m.from == Some(w.mayor))).map(|w| (orders(world).filter(|m| m.from == Some(w.mayor)).count(), w.mayor)).collect();
    by.sort();
    let (w, good) = sets.into_iter().find_map(|goods| {
        by.iter().find_map(|&(n, mayor)| {
            let w = who(mayor);
            let wanted: Vec<Good> = w.goods.iter().copied().filter(|g| goods.contains(g)).collect();
            (!wanted.is_empty()).then(|| (w, wanted[n % wanted.len()]))
        })
    })?;
    let standing = standing(world, w.mayor);
    let count = w.packages + crate::haul::LOAD * (standing / 2.0).floor() as u32;
    let units = count as f64 * good.per_package();
    let coins = (units * crate::economy::world_price(good) * w.price * (1.0 + WARMTH * standing)).round();
    let letter = w.voice[(standing >= 2.0) as usize].replace("{n}", &good.packages(count));
    let id = world.map.objects.reserve_id();
    Some(Mission {
        key: Key::Order(id),
        title: format!("{} of {}", w.name, w.town),
        steps: vec![Step {
            goal: Goal::Delivered { good, units, sailed: 0.0 },
            title: format!("{} to {}", good.packages(count), w.town),
            text: format!("{}, mayor of {}: {letter}\n\nSend them from the letter's card: a depot's lorry takes them to the quay, and the coins land as each sails.", w.name, w.town),
            done: false,
            at: None,
        }],
        reward: Reward::Order { coins, standing: FILLED },
        opened: now,
        finished: None,
        from: Some(w.mayor),
        due: Some(now + LASTS),
    })
}

/// A package went out on the ferry: if it was booked for an open order,
/// it is counted to it, and the last fills it.
pub fn sailed(world: &mut World, t: &Package) {
    let Some(m) = world.missions.list.iter_mut().find(|m| m.key == Key::Order(t.order) && m.finished.is_none()) else { return };
    let Goal::Delivered { units, sailed, .. } = &mut m.steps[0].goal else { return };
    *sailed += t.good.per_package();
    m.steps[0].done = *sailed >= *units - 1e-6;
    world.missions.stir();
}

/// What each mayor's town wants and makes: what pushes the market
/// (`market.rs`).
pub fn trades() -> impl Iterator<Item = (&'static [Good], &'static [Good])> {
    WHO.iter().map(|w| (w.goods, w.sells))
}

/// Every open letter that wants packages not yet booked.
pub fn letters(world: &World) -> Vec<Letter> {
    let marked = crate::haul::packages(world);
    let waiting: Vec<Package> = world.map.harbours.keys().filter_map(|&h| match world.map.objects.get(h).map(|e| &e.object) {
        Some(GameObject::Building(b)) => Some(b.outgoing.clone()),
        _ => None,
    }).flatten().collect();
    open(world)
        .filter_map(|m| {
            let (Key::Order(id), Goal::Delivered { good, units, sailed }, Reward::Order { coins, .. }, Some(partner)) = (m.key, m.steps[0].goal, m.reward, m.from) else { return None };
            let going = marked.iter().map(|(t, ..)| t).chain(&waiting).filter(|t| t.outbound && t.order == id).count() as f64 * good.per_package();
            let packages = ((units - sailed - going) / good.per_package() - 1e-9).ceil().max(0.0) as u32;
            (packages > 0).then_some(Letter { letter: id, good, partner, price: coins / units, packages })
        })
        .collect()
}

/// Send so many of the packages a letter wants: each waits at the harbour
/// for a depot's lorry. How many were booked.
pub fn send(world: &mut World, letter: u64, packages: u32) -> u32 {
    let (Some(&harbour), Some(l)) = (world.map.harbours.keys().next(), letters(world).into_iter().find(|l| l.letter == letter)) else { return 0 };
    (0..packages.min(l.packages)).take_while(|_| book(world, harbour, l.good, true, Some(l.partner), l.price, Some(letter))).count() as u32
}

/// Book a place on a harbour's deck at a price a unit: a package of a
/// good on the next ferry in, as far as the treasury goes once what is
/// already coming is paid for; or one going out, for a partner or the
/// market, to wait at the harbour for a lorry. Whether it was booked.
pub fn book(world: &mut World, harbour: EntityId, good: Good, out: bool, partner: Option<Mayor>, price: f64, letter: Option<u64>) -> bool {
    let deck = map::sea::DECK;
    let id = world.map.objects.reserve_id();
    let t = Package { id, good, to: None, outbound: out, order: letter.unwrap_or(id), partner, price };
    if out {
        let Some(b) = world.map.harbours.contains_key(&harbour).then(|| world.map.building_mut(harbour)).flatten().filter(|b| b.outgoing.len() < deck) else { return false };
        b.outgoing.push(t);
        world.missions.stir();
        return true;
    }
    let owed: f64 = crate::haul::packages(world).iter().filter(|(t, l, _)| !t.outbound && matches!(l, Leg::Booked | Leg::Aboard)).map(|(t, ..)| t.value()).sum();
    if world.treasury - owed < t.value() {
        return false;
    }
    let Some(ferry) = world.next_ferry(harbour) else { return false };
    let Some(c) = world.map.car_mut(ferry) else { return false };
    if c.booked.len() >= deck {
        return false;
    }
    c.booked.push(t);
    world.missions.stir();
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::tests::*;
    use model::{BuildingKind, Good, DAY_MS};

    /// A letter written and opened, as a ferry brings it.
    fn letter(world: &mut World, now: GameTime) -> model::missions::Mission {
        let m = crate::orders::write(world, now).expect("nobody wrote");
        world.missions.list.push(m.clone());
        m
    }

    /// The good an order asks for.
    fn asked(m: &model::missions::Mission) -> Good {
        match m.steps[0].goal {
            model::missions::Goal::Delivered { good, .. } => good,
            _ => panic!("{} is not an order", m.title),
        }
    }

    /// An order finished: filled, or lapsed.
    fn close(world: &mut World, key: model::missions::Key, filled: bool, now: GameTime) {
        let m = world.missions.list.iter_mut().find(|m| m.key == key).unwrap();
        m.steps[0].done = filled;
        m.finished = Some(now);
    }

    /// A letter asks only for what the town can send: what a maker in
    /// town makes, or, one step further, what a building not yet built
    /// would make. Fuel has no maker, so nobody asks for it.
    #[test]
    fn orders_ask_only_for_what_the_town_can_send() {
        use crate::orders::{sourceable, GAP};
        let mut world = street();
        opening_done(&mut world);
        build(&mut world, HARBOUR_X - 12, BuildingKind::Depot);
        let asks = |world: &mut World, from: u64| -> Vec<Good> {
            (0..9)
                .map(|n| {
                    let (can, further) = sourceable(world);
                    let m = letter(world, (from + n) * GAP);
                    assert!(can.contains(&asked(&m)) || further.contains(&asked(&m)), "{} asked for {:?}: the town can send {can:?}, and {further:?} a step on", m.title, asked(&m));
                    close(world, m.key, true, (from + n) * GAP);
                    asked(&m)
                })
                .collect()
        };
        // A town that makes nothing: the first letters reach a step on.
        let first = asks(&mut world, 0);
        assert!(!first.contains(&Good::Fuel), "asked for fuel nobody can make: {first:?}");
        assert_eq!(first[0], Good::Crates, "Tam writes first, for the crates a farm would make");
        // A farm stands: crates are made in town.
        build(&mut world, 20, BuildingKind::Farm);
        assert_eq!(sourceable(&world).0, [Good::Crates]);
        let then = asks(&mut world, 9);
        assert!(!then.contains(&Good::Fuel), "asked for fuel nobody can make: {then:?}");
    }

    /// At most three orders stand open, a letter comes no oftener than a
    /// third of a day, and none before the opening is done. One not
    /// filled lapses as a ferry comes in after its day, and its mayor
    /// thinks a little less of the town; a box still booked for it counts
    /// to nothing.
    #[test]
    fn orders_come_three_at_most_and_lapse_without_harm() {
        use crate::orders::{post, standing, GAP, LASTS, OPEN};
        use model::orders::Mayor;
        let mut world = street();
        let harbour = harbour_of(&world);
        post(&mut world, harbour, 0);
        assert!(world.missions.list.iter().all(|m| !matches!(m.key, model::missions::Key::Order(_))), "a letter came before the opening was done");
        opening_done(&mut world);
        let open = |w: &World| w.missions.list.iter().filter(|m| matches!(m.key, model::missions::Key::Order(_)) && m.finished.is_none()).count();
        let mut most = 0;
        // A ferry every tenth of a day, for three days.
        for call in 0..30 {
            post(&mut world, harbour, call * DAY_MS as u64 / 10);
            most = most.max(open(&world));
            assert!(open(&world) <= OPEN, "{} open at call {call}", open(&world));
        }
        assert_eq!(most, OPEN, "the board never filled");
        let opened: Vec<GameTime> = world.missions.list.iter().filter(|m| matches!(m.key, model::missions::Key::Order(_))).map(|m| m.opened).collect();
        assert!(opened.windows(2).all(|w| w[1] - w[0] >= GAP), "letters came closer than a third of a day: {opened:?}");
        // Tam's first lapsed after its two days, nothing filled: standing
        // fell from where it started, and the news said so.
        let tam = world.missions.list.iter().find(|m| m.from == Some(Mayor::Tam)).unwrap().clone();
        assert!(tam.finished.is_some_and(|f| f >= tam.opened + LASTS), "Tam's order never lapsed");
        assert!(standing(&world, Mayor::Tam) < 1.0, "a lapsed order cost no standing");
        assert!(world.news.iter().any(|n| n.text.contains("gave up")), "no news of it");
        // A package booked for it sails after all.
        let model::missions::Key::Order(id) = tam.key else { unreachable!() };
        let t = model::Package { id: 1, good: asked(&tam), to: None, outbound: true, order: id, partner: Some(Mayor::Tam), price: 1.0 };
        crate::orders::sailed(&mut world, &t);
        let tam = world.missions.list.iter().find(|m| m.key == tam.key).unwrap();
        assert!(matches!(tam.steps[0].goal, model::missions::Goal::Delivered { sailed, .. } if sailed == 0.0), "a lapsed order took a package");
    }

    /// Port Aldra writes only once the town stands well with someone
    /// else: until then, the letters are Tam's, Mira's and Bess's.
    #[test]
    fn port_aldra_is_silent_until_the_town_stands_well() {
        use crate::orders::{standing, GAP, GOOD};
        use model::orders::Mayor;
        let mut world = street();
        opening_done(&mut world);
        build(&mut world, 20, BuildingKind::Farm);
        build(&mut world, HARBOUR_X - 12, BuildingKind::Depot);
        let mut t = 0;
        // Every order but Tam's lapses: the town keeps to one friend.
        while standing(&world, Mayor::Tam) < GOOD {
            assert!(t < 30 * GAP, "Tam never wrote enough to stand at {GOOD}");
            let m = letter(&mut world, t);
            assert_ne!(m.from, Some(Mayor::Aldra), "Port Aldra wrote while Tam stood at {}", standing(&world, Mayor::Tam));
            close(&mut world, m.key, m.from == Some(Mayor::Tam), t);
            t += GAP;
        }
        let from: Vec<_> = (0..4)
            .map(|_| {
                let m = letter(&mut world, t);
                close(&mut world, m.key, true, t);
                t += GAP;
                m.from.unwrap()
            })
            .collect();
        assert!(from.contains(&Mayor::Aldra), "Port Aldra never wrote: {from:?}");
    }

    /// An order filled the way a player fills it: packages going out
    /// booked for its mayor are loaded at the depot, ride the lorry to
    /// the quay and the ferry to the edge, and the mayor's coins land at the
    /// harbour as it casts off, once; the mayor's standing rises, once.
    #[test]
    fn an_order_filled_pays_coins_and_standing_once() {
        use model::missions::Reward;
        use crate::orders::{post, standing};
        use model::orders::Mayor;
        let mut world = street();
        let harbour = harbour_of(&world);
        build(&mut world, HARBOUR_X - 12, BuildingKind::Depot);
        let mut game = game(world);
        let world = &mut game.world;
        opening_done(world);
        post(world, harbour, 0);
        let order = world.missions.list.last().unwrap().clone();
        assert_eq!((order.from, asked(&order)), (Some(Mayor::Tam), Good::Crates), "Tam's letter, for crates");
        let (model::missions::Key::Order(id), Reward::Order { coins, .. }) = (order.key, order.reward) else { panic!("not an order") };
        let before = (world.treasury, standing(world, Mayor::Tam));
        let n = crate::orders::letters(world).iter().find(|l| l.letter == id).unwrap().packages;
        assert_eq!(crate::orders::send(world, id, n), n, "no room for Tam's crates");
        crate::haul::call_lorries(world, &mut game.events);
        let mut marked = false;
        let finished = |w: &World| w.missions.list.iter().any(|m| m.key == order.key && m.finished.is_some());
        while !finished(&game.world) && game.step_to(DAY_MS as u64) {
            marked |= crate::haul::packages(&game.world).iter().any(|(t, ..)| t.order == id && t.outbound);
        }
        let world = &game.world;
        assert!(marked, "no package was marked for Saltmere");
        assert!(finished(world), "the order was never filled");
        let paid = world.lumps.iter().filter(|l| l.building == harbour && l.coins > 0.0).map(|l| l.coins).sum::<f64>();
        assert!((paid - coins).abs() < 1e-6, "Tam paid {paid}, the letter said {coins}");
        assert!((world.treasury - before.0 - coins).abs() < 1e-6, "the purse moved by {}", world.treasury - before.0);
        assert_eq!(standing(world, Mayor::Tam), before.1 + 1.0, "standing rose by other than a point");
        // A day on, nothing more for it.
        let treasury = world.treasury;
        game.run_to(game.now + DAY_MS as u64);
        let world = &game.world;
        let crates_sold: f64 = world.town.season().map(|p| p.sold.get(&Good::Crates).copied().unwrap_or(0.0)).sum();
        assert!((crates_sold - coins).abs() < 1e-6, "crates sold for {crates_sold} in all");
        assert!(world.treasury <= treasury + 1e-6, "paid again: {} more", world.treasury - treasury);
        assert_eq!(standing(world, Mayor::Tam), before.1 + 1.0, "standing rose again");
    }

    /// The board outlives a restart: the orders open and done, who wrote
    /// them, and so how each mayor stands. Through the JSON a save keeps
    /// them in (the host's `persistence`, which tests its own round trip).
    #[test]
    fn the_order_board_survives_a_restart() {
        let mut world = street();
        opening_done(&mut world);
        let filled = letter(&mut world, 0);
        close(&mut world, filled.key, true, 10);
        letter(&mut world, 20);
        let kept = serde_json::to_string(&world.missions.list).unwrap();
        let mut again = street();
        again.missions.list = serde_json::from_str(&kept).unwrap();
        assert_eq!(serde_json::to_string(&again.missions.list).unwrap(), serde_json::to_string(&world.missions.list).unwrap());
        assert_eq!(serde_json::to_string(&crate::orders::neighbours(&again)).unwrap(), serde_json::to_string(&crate::orders::neighbours(&world)).unwrap());
    }
}
