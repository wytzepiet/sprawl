//! The mayors of the towns beyond the map's edge, and the deck booked
//! for the market (docs/trade.md §The deck, docs/core.md §Trade).
//!
//! The mayors are the market until there are players: what their towns
//! want pushes a price up, what they make pushes it down (`market.rs`),
//! and a package bought or sold is named for one of them on the map.
//!
//! A slot coming in rides the next ferry and lands for the nearest depot
//! with room; a slot going out waits at the harbour for a depot's lorry
//! to load it.

use model::orders::{Mayor, Compass, Neighbour};

use model::{EntityId, Good, Leg, Package};
use crate::world::World;

struct Who {
    mayor: Mayor,
    name: &'static str,
    town: &'static str,
    toward: Compass,
    colour: &'static str,
    /// What their town wants: what pushes the market's price up.
    goods: &'static [Good],
    /// What their town makes: what pushes it down.
    sells: &'static [Good],
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
    },
    Who {
        mayor: Mayor::Mira,
        name: "Mira",
        town: "Northgate",
        toward: Compass::North,
        colour: "#6b5b7b",
        goods: &[Good::Timber],
        sells: &[Good::Stone],
    },
    Who {
        mayor: Mayor::Bess,
        name: "Bess",
        town: "Fernhollow",
        toward: Compass::South,
        colour: "#c98a2b",
        goods: &[Good::Stone, Good::Timber],
        sells: &[Good::Crates, Good::Timber],
    },
    Who {
        mayor: Mayor::Aldra,
        name: "Lord Aldra",
        town: "Port Aldra",
        toward: Compass::East,
        colour: "#a33b3b",
        goods: &[Good::Crates, Good::Timber, Good::Stone, Good::Fuel],
        sells: &[Good::Fuel, Good::Timber],
    },
];

pub fn neighbours() -> Vec<Neighbour> {
    WHO.iter()
        .map(|w| Neighbour { mayor: w.mayor, name: w.name.into(), town: w.town.into(), toward: w.toward, colour: w.colour.into() })
        .collect()
}

/// What each mayor's town wants and makes: what pushes the market
/// (`market.rs`).
pub fn trades() -> impl Iterator<Item = (&'static [Good], &'static [Good])> {
    WHO.iter().map(|w| (w.goods, w.sells))
}

/// Book a place on a harbour's deck at a price a unit: a package of a
/// good on the next ferry in, as far as the treasury goes once what is
/// already coming is paid for; or one going out, for a partner or the
/// market, to wait at the harbour for a lorry. Whether it was booked.
pub fn book(world: &mut World, harbour: EntityId, good: Good, out: bool, partner: Option<Mayor>, price: f64) -> bool {
    let deck = map::sea::DECK;
    let id = world.map.objects.reserve_id();
    let t = Package { id, good, to: None, outbound: out, order: id, partner, price };
    if out {
        let Some(b) = world.map.harbours.contains_key(&harbour).then(|| world.map.building_mut(harbour)).flatten().filter(|b| b.outgoing.len() < deck) else { return false };
        b.outgoing.push(t);
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
    true
}
