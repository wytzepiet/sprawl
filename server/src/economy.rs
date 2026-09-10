//! Money, as docs/economy.md lays it out: the town has one purse,
//! everything is a stock and every building a row, everyone posts a price
//! and nudges it by their own stock, everyone prices time at what they
//! earn, the edge is a world with the same rows and a crossing, and the
//! mayor owns the town.
//!
//! The unit is the hour, and the edge's wage is one. A sale in town is a
//! line in two sets of books; money moves only at the door — a shift
//! worked beyond the edge, a crate brought in from it, a commuter's wage
//! going home — and the treasury is the town's balance of payments, less
//! what the mayor built. GDP is something else: value served in town at
//! the world's prices, banked as each visit ends, and the level is its
//! running sum.
//!
//! What is a number lives here, with the referent that set it. What is a
//! verb — settling a visit, ranking a job — lives with the code that does
//! it, and takes its numbers from here.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::blueprint::blueprint;
use crate::engine::GameTime;
use crate::needs::{Need, Tap};
use crate::protocol::{BuildingKind, EntityId, GameObject, Growth, Sale, DAY_MS};
use crate::world::World;

pub const HOUR: f64 = DAY_MS as f64 / 24.0;

/// One hour of labour beyond the edge: the numéraire.
pub const EDGE_WAGE: f64 = 1.0;
pub fn edge_wage() -> f64 {
    EDGE_WAGE
}

/// What the edge sells a unit of each need for. Household budget shares
/// — a day at the edge earns eight, a sixth of it goes on food, a sixth
/// on transport, a tenth on leisure — would make a sitting half an hour,
/// an evening out an hour, and a tank, every few days, three. The tank
/// is three. The other two are less, because the price is added to the
/// visit in the resident's own hours (§6.1) and the ladder of
/// residents.md §5.5 is tuned to tenths: at half an hour a full sitting
/// ties the shift it would interrupt and nobody lunches out, and at an
/// hour an evening loses to waiting up for bed and nobody goes out.
/// Housing's third is the sweep (§8.2). Low stakes: the band turns a
/// wrong number into a town that is a little dear or a little cheap,
/// never one that runs away. docs/economy.md §12.1, §12.2.
pub fn edge_price(need: Need) -> f64 {
    match need {
        Need::Eat => 0.2,
        Need::Leisure => 0.5,
        Need::Fuel => 3.0,
        Need::Work => EDGE_WAGE,
        Need::Home | Need::Rest => 0.0,
    }
}

/// What the edge sells the unit on the shelf for — the crate behind a
/// meal, the delivery behind a tank: half the price it sells the meal
/// for. Retail margins on food sit between a third and a half.
pub const WHOLESALE: f64 = 0.5;
pub fn wholesale(need: Need) -> f64 {
    WHOLESALE * edge_price(need)
}

/// The crossing: the share of a good's value lost each way for carrying
/// it over the edge, the iceberg cost of trade theory (Samuelson 1954).
/// The world sells to the town at cost plus it and buys at cost less it,
/// labour included. Estimates of trade costs run from a tenth to a half;
/// a border between a town and its region is the low end. §8.1.
pub const CROSSING: f64 = 0.1;
/// What the town pays to bring a unit in, and what it gets for sending
/// one out.
pub fn import(cost: f64) -> f64 {
    cost * (1.0 + CROSSING)
}
pub fn export(cost: f64) -> f64 {
    cost * (1.0 - CROSSING)
}

/// What the mayor founds the town with: enough to import for a few days
/// before the first shift is sold beyond the edge. The floats every
/// building used to open with, in one place. §12.4.
pub const STAKE: f64 = 100.0;

/// A night of housing, per head: what the household row draws in upkeep
/// a day, imported from beyond the edge until an office in town makes
/// services, and what a night served in town is worth in GDP. Households
/// spend a third of their income on housing; a day at the edge earns
/// eight. §4, §13.10.
pub const HOUSING: f64 = 8.0 / 3.0;

/// What a household asks for an hour of its labour. The town's: what the
/// edge would pay them, net of the crossing, since below that they sell
/// there instead. The world's, beyond the edge: the edge wage plus the
/// crossing. The commute is added on delivery (`delivered_wage`). Not
/// yet nudged by the household's own stock (§12.4). §5.2.
pub fn ask(world: &World, home: EntityId) -> f64 {
    if world.edge.contains(&home) { import(EDGE_WAGE) } else { export(EDGE_WAGE) }
}

/// What a household's hour costs a building, delivered: the ask, with the
/// drive there and back spread over the shift, since labour is the good
/// the seller delivers in person. Rosen's compensating differential with
/// no rule about distance. §5.2.
pub fn delivered_wage(ask: f64, commute_h: f64, shift_h: f64) -> f64 {
    ask * (shift_h + 2.0 * commute_h) / shift_h
}

/// A building swaps a worker only for one cheaper delivered by this
/// much: firms replace people for a saving of a tenth to a fifth, not for
/// a penny (Topel & Ward 1992 on the wage gains that move people). §5.2.
pub const HIRING: f64 = 0.15;

/// A price steps a few percent a day. Firms reprice about once a year
/// (Blinder et al., 1998), and the arcade day stands in for a quarter, so
/// a step is what a quarter's repricing comes to. Down is smaller than
/// up: prices are sticky, and a cut that holds is worth less than a rise
/// that sticks.
const PRICE_UP: f64 = 0.05;
const PRICE_DOWN: f64 = 0.03;
/// Selling more than this share of what the tap could sell in a day is
/// selling out; less than this is piling up. The stock behind a tap with
/// no shelf is its capacity.
const SELLING_OUT: f64 = 0.8;
const PILING_UP: f64 = 0.4;
/// Hours of the shift a kind's row posts.
pub fn shift_hours(kind: BuildingKind) -> f64 {
    blueprint(kind).taps.iter().find(|t| t.need == Need::Work).map_or(0.0, |t| t.curve.per_day() / HOUR)
}

/// What a kind charges a price for: every need its taps serve over the
/// counter, and, for a depot, the crate off its shelf that its vans
/// deliver. A home sells nothing: its kitchen is its household's, and
/// what they eat there is groceries, bought from beyond the edge until
/// something in town delivers them (`price_of`).
pub fn sells(kind: BuildingKind) -> impl Iterator<Item = Need> {
    let bp = blueprint(kind);
    bp.taps
        .iter()
        .filter(move |t| bp.homes == 0 && t.need != Need::Work && edge_price(t.need) > 0.0)
        .map(|t| t.need)
        .chain(depot(kind).then(|| shelf_need(kind)))
}

/// Units of a need a kind could sell in a day with every slot busy: what
/// selling out and piling up are measured against. A depot's shelf has
/// no tap; what it could sell in a day is the shelf, turned once.
pub fn rated(kind: BuildingKind, need: Need) -> f64 {
    let bp = blueprint(kind);
    let over_the_counter: f64 = bp.taps.iter().filter(|t| t.need == need).map(Tap::rated).sum();
    over_the_counter + if depot(kind) && need == shelf_need(kind) { bp.stock as f64 } else { 0.0 }
}

/// What the edge charges for the unit a kind sells of a need: the crate,
/// wholesale, that a depot's van delivers; the meal, the evening or the
/// tank over anyone else's counter. What a kind opens charging, since a
/// price it has sold nothing at cannot be known yet. §12.2.
pub fn edge_price_of(kind: BuildingKind, need: Need) -> f64 {
    if depot(kind) && need == shelf_need(kind) { wholesale(need) } else { edge_price(need) }
}

/// The need a kind's shelf backs: what its deliveries are. Fuel where it
/// pumps, food everywhere else that keeps a shelf.
pub fn shelf_need(kind: BuildingKind) -> Need {
    if blueprint(kind).taps.iter().any(|t| t.need == Need::Fuel) { Need::Fuel } else { Need::Eat }
}

/// Answers calls, so its wages are the treasury's. §8.2, the one special case.
pub fn service(kind: BuildingKind) -> bool {
    blueprint(kind).answers.is_some()
}

/// Sells its shelf by delivery: answers the calls of shelves running low
/// with a van of its own, and fetches its own stock from beyond the edge.
pub fn depot(kind: BuildingKind) -> bool {
    blueprint(kind).answers == Some(crate::calls::CallKind::Stock)
}

/// What one unit costs a kind to sell: the delivery behind it, and
/// nothing behind an evening out. The floor a price never goes under is
/// marginal cost — the shutdown rule: a firm sells while the price covers
/// what the sale itself costs, and pays its staff from the margin or
/// runs through its float (§9). The hours behind the counter are not in
/// it on purpose: spread over a bar's evenings they come to an hour's
/// wage each, and at that price nobody goes out (`edge_price`); spread
/// over the day's actual sales they rise as trade falls and price a
/// quiet shop out. §5.1.
pub fn unit_cost(kind: BuildingKind, need: Need) -> f64 {
    if need == shelf_need(kind) && blueprint(kind).stock > 0 { wholesale(need) } else { 0.0 }
}

/// What one of a kind costs the mayor: the row's price, with the build's
/// discount on its class. Paid to the outside: a placement is an import.
pub fn price(world: &World, kind: BuildingKind) -> f64 {
    let b = blueprint(kind);
    b.price / world.build.weight(b.class)
}

/// A building saved before it had a shelf or prices gets them the way a
/// placed one does; one whose row changed its shelf gets the new one.
pub fn open(world: &mut World, id: EntityId) {
    let Some(GameObject::Building(b)) = world.objects.get_mut(id).map(|e| &mut e.object) else { return };
    let fresh = crate::protocol::Building::new(b.kind, b.size, b.facing);
    if b.stock.cap != fresh.stock.cap {
        b.stock = fresh.stock;
    }
    if b.prices.is_empty() {
        b.prices = fresh.prices;
    }
}

/// The reorder point: the `s` of the `(s, S)` policy of every inventory
/// textbook, with the shelf as `S`. Expected use over the lead time —
/// what the taps could sell in the time the last delivery took — plus a
/// margin, which is a full house: everyone the taps seat at once, so a
/// rush during the lead does not empty the shelf. Until a building has
/// had a delivery, one is assumed to take as long as a lorry is away
/// beyond the edge. §6.2.
pub fn reorder(world: &World, building: EntityId) -> f64 {
    let Some(kind) = kind_of(world, building) else { return 0.0 };
    let need = shelf_need(kind);
    let lead = world.books.get(&building).and_then(|k| k.lead).unwrap_or(crate::calls::AWAY_MS);
    let seats: u32 = blueprint(kind).taps.iter().filter(|t| t.need == need).map(|t| t.slots).sum();
    rated(kind, need) * lead as f64 / DAY_MS as f64 + seats as f64
}

/// What a building makes an hour, which is what an hour of money is
/// worth to it: yesterday's takings over the day, or, before it has a
/// day of them, what the edge would pay for everything it could sell
/// (§13.3). What it weighs a delivery's lead time against. §6.1.
pub fn earns(world: &World, building: EntityId, now: GameTime) -> f64 {
    let Some(kind) = kind_of(world, building) else { return EDGE_WAGE };
    let yesterday = world.books.get(&building).map_or(0.0, |k| k.before(now).revenue);
    let could: f64 = sells(kind).map(|need| edge_price_of(kind, need) * rated(kind, need)).sum();
    (if yesterday > 0.0 { yesterday } else { could }) / 24.0
}

/// What a building charges per unit of a need. The edge charges its own;
/// a meal at home costs what the groceries behind it cost.
pub fn price_of(world: &World, building: EntityId, need: Need) -> f64 {
    if world.edge.contains(&building) {
        return edge_price(need);
    }
    match world.objects.get(building).map(|e| &e.object) {
        Some(GameObject::Building(b)) if blueprint(b.kind).homes > 0 => if need == Need::Eat { wholesale(need) } else { 0.0 },
        Some(GameObject::Building(b)) => b.prices.get(&need).copied().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// What a resident makes an hour: what their job pays them. What they
/// price money in. §6.1.
pub fn earning(world: &World, resident: EntityId) -> f64 {
    match world.objects.get(resident).map(|e| &e.object) {
        Some(GameObject::Resident(r)) => r.wage,
        _ => EDGE_WAGE,
    }
}

/// What a unit of a need served in town is worth in GDP: the world's
/// price for it. Labour is inside whatever it makes and counts there;
/// a night is housing, banked once a head a day (`day`). §10.
pub fn value(kind: BuildingKind, need: Need) -> f64 {
    match need {
        Need::Work | Need::Rest | Need::Home => 0.0,
        _ => edge_price_of(kind, need),
    }
}

/// Money crossing the door: in when the town sold, out when it bought.
/// Money out stops at nothing: an import the treasury cannot pay for is
/// paid as far as it goes. Returns what moved. §8.2.
fn door(world: &mut World, amount: f64, now: GameTime) -> f64 {
    let book = world.income.today(now);
    if amount >= 0.0 {
        book.revenue += amount;
        world.treasury += amount;
        amount
    } else {
        let paid = (-amount).min(world.treasury);
        book.purchases += paid;
        world.treasury -= paid;
        -paid
    }
}

fn outside(world: &World, resident: EntityId) -> bool {
    match world.objects.get(resident).map(|e| &e.object) {
        Some(GameObject::Resident(r)) => world.edge.contains(&r.home),
        _ => false,
    }
}

/// One visit paid for, as it ends: `units` of `need` served at `at` to
/// `who`. A shift is sold by the resident and bought by the building; a
/// meal, an evening or a tank is bought by the resident and sold by the
/// building. Two lines in the books, and a lump on the map; the treasury
/// moves only when one party is the outside — the edge, or a household
/// beyond it. Anything that runs a shelf draws it down. §6, §8.
pub fn sale(world: &mut World, who: EntityId, at: EntityId, need: Need, units: f64, now: GameTime) {
    if units <= 0.0 {
        return;
    }
    let edge = world.edge.contains(&at);
    let Some(kind) = kind_of(world, at) else { return };
    let commuter = outside(world, who);
    match need {
        Need::Work => {
            let wage = earning(world, who);
            let due = units * wage;
            if edge {
                // A shift beyond the edge: the town sold its labour.
                if !commuter {
                    door(world, due, now);
                }
                return;
            }
            // A workplace with nothing to sell sells its hours to the
            // edge, at the world's price less the crossing: a
            // pass-through, until goods give it an output. §12.1.
            if !service(kind) && sells(kind).next().is_none() {
                let made = units * EDGE_WAGE;
                world.gdp += made;
                world.books.entry(at).or_default().today(now).revenue += export(made);
                world.sales.push(Sale { building: at, amount: export(made), at: now });
                door(world, export(made), now);
            }
            let book = world.books.entry(at).or_default().today(now);
            book.wages += due;
            book.hours += units;
            // A commuter takes the wage home, beyond the edge.
            if commuter {
                door(world, -due, now);
            }
        }
        Need::Home | Need::Rest => {}
        Need::Eat | Need::Leisure | Need::Fuel => {
            let due = units * price_of(world, at, need);
            if edge {
                // A meal beyond the edge is the town buying one, unless
                // the eater lives there too.
                if !commuter {
                    door(world, -due, now);
                }
                return;
            }
            // The groceries behind a meal at home are the edge's, until
            // something in town sells them.
            if blueprint(kind).homes > 0 {
                door(world, -import(due), now);
                return;
            }
            let book = world.books.entry(at).or_default().today(now);
            book.revenue += due;
            *book.sold.entry(need).or_default() += units;
            if due > 0.0 {
                world.sales.push(Sale { building: at, amount: due, at: now });
            }
            // A commuter's lunch is a meal sold to the outside.
            if commuter {
                door(world, due, now);
            }
            if need == shelf_need(kind)
                && let Some(GameObject::Building(b)) = world.objects.get_mut(at).map(|e| &mut e.object)
                && b.stock.cap > 0.0
            {
                b.stock.take(units);
                if b.stock.level == 0.0 {
                    world.books.entry(at).or_default().today(now).sold_out = true;
                }
            }
        }
    }
}

/// A van loads at a depot: as much of the order as the shelf has. The
/// shelf goes down as the load leaves, and a shelf that empties is sold
/// out; the money moves when the load lands (`delivered`). §7.
pub fn loaded(world: &mut World, depot: EntityId, order: f64, now: GameTime) -> f64 {
    let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) else { return 0.0 };
    let load = order.min(b.stock.level);
    b.stock.take(load);
    if b.stock.level == 0.0 {
        world.books.entry(depot).or_default().today(now).sold_out = true;
    }
    load
}

/// A delivery landed: `load` onto `buyer`'s shelf, from `seller`'s or
/// from beyond the edge. From a depot it is two lines at the depot's
/// posted price and moves nothing; from beyond the edge the town buys
/// the load at the edge's wholesale plus the crossing. §7, §8.2.
pub fn delivered(world: &mut World, buyer: EntityId, seller: Option<EntityId>, load: f64, now: GameTime) {
    let Some(kind) = kind_of(world, buyer) else { return };
    let need = shelf_need(kind);
    let unit = seller.map_or(import(wholesale(need)), |s| price_of(world, s, need));
    let Some(GameObject::Building(b)) = world.objects.get_mut(buyer).map(|e| &mut e.object) else { return };
    let units = load.min(b.stock.short());
    if units <= 0.0 {
        return;
    }
    let due = units * unit;
    b.stock.add(units);
    world.books.entry(buyer).or_default().today(now).purchases += due;
    world.sales.push(Sale { building: buyer, amount: -due, at: now });
    match seller {
        Some(seller) => {
            let book = world.books.entry(seller).or_default().today(now);
            book.revenue += due;
            *book.sold.entry(need).or_default() += units;
            world.sales.push(Sale { building: seller, amount: due, at: now });
        }
        None => {
            door(world, -due, now);
        }
    }
}

/// A depot's lorry came home full from beyond the edge: the town bought
/// what it brought, at the edge's wholesale plus the crossing.
pub fn fetched(world: &mut World, depot: EntityId, now: GameTime) {
    let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) else { return };
    let units = b.stock.short();
    let due = units * import(wholesale(Need::Eat));
    b.stock.add(units);
    world.books.entry(depot).or_default().today(now).purchases += due;
    world.sales.push(Sale { building: depot, amount: -due, at: now });
    door(world, -due, now);
}

/// Midnight: every building counts its day. Each price steps by its own
/// stock, the books turn a page, and every household in town draws its
/// night of housing: a night served, and its upkeep bought from beyond
/// the edge. §4, §5.
pub fn day(world: &mut World, now: GameTime) {
    let heads = world.resident_ids().into_iter().filter(|&id| !outside(world, id)).count() as f64;
    world.gdp += heads * HOUSING;
    door(world, -heads * HOUSING, now);
    world.gdp_at_midnight = world.gdp;
    world.income.today(now);
    let mut ids: Vec<EntityId> = world.objects.iter().filter(|e| matches!(e.object, GameObject::Building(_))).map(|e| e.id).collect();
    ids.sort_unstable();
    for id in ids {
        if world.edge.contains(&id) {
            continue;
        }
        // Turn the page, and read the day that just ended.
        let books = world.books.entry(id).or_default();
        books.today(now);
        let book = books.before(now).clone();
        let Some(GameObject::Building(b)) = world.objects.get_mut(id).map(|e| &mut e.object) else { continue };
        let kind = b.kind;
        for need in sells(kind) {
            let Some(price) = b.prices.get_mut(&need) else { continue };
            let sold = book.sold.get(&need).copied().unwrap_or(0.0);
            let could = rated(kind, need);
            if (need == shelf_need(kind) && book.sold_out) || sold > SELLING_OUT * could {
                *price *= 1.0 + PRICE_UP;
            } else if sold < PILING_UP * could {
                *price *= 1.0 - PRICE_DOWN;
            }
            *price = price.max(unit_cost(kind, need));
        }
    }
}

fn kind_of(world: &World, building: EntityId) -> Option<BuildingKind> {
    match world.objects.get(building)?.object {
        GameObject::Building(ref b) => Some(b.kind),
        _ => None,
    }
}

/// One day of a building's books: what came in, what went out, what was
/// sold, and how much labour was bought. The town's own books are the
/// door: in and out.
#[derive(Debug, Default, Clone)]
pub struct Day {
    pub revenue: f64,
    pub purchases: f64,
    pub wages: f64,
    /// Hours of labour paid for.
    pub hours: f64,
    /// Units sold, per need.
    pub sold: BTreeMap<Need, f64>,
    /// Hours of need served, per tap: for a workplace, labour received.
    pub served: BTreeMap<Need, f64>,
    /// The shelf ran empty at some point.
    pub sold_out: bool,
}

static EMPTY: std::sync::LazyLock<Day> = std::sync::LazyLock::new(Day::default);

/// A building's books: today's page and yesterday's, keyed by the day
/// today is. Learned, not saved — a loaded world starts counting afresh.
#[derive(Debug, Default, Clone)]
pub struct Books {
    pub day: u64,
    pub today: Day,
    pub yesterday: Day,
    /// How long the last delivery took, from the call to the load
    /// landing: the lead time the reorder point covers. None until there
    /// has been one.
    pub lead: Option<GameTime>,
}

impl Books {
    /// Today's page, turning it if the day has moved on.
    pub fn today(&mut self, now: GameTime) -> &mut Day {
        let day = now / DAY_MS as u64;
        if day != self.day {
            self.yesterday = if day == self.day + 1 { std::mem::take(&mut self.today) } else { Day::default() };
            self.today = Day::default();
            self.day = day;
        }
        &mut self.today
    }

    /// Today's page as it stands, without turning it.
    pub fn on(&self, now: GameTime) -> &Day {
        self.page(now / DAY_MS as u64)
    }

    /// The last whole day's page: yesterday's, as of `now`. The first day
    /// has none.
    pub fn before(&self, now: GameTime) -> &Day {
        (now / DAY_MS as u64).checked_sub(1).map_or(&EMPTY, |day| self.page(day))
    }

    /// The page for a day, by the calendar: a day nothing was written on
    /// is empty, however long ago the last entry was.
    fn page(&self, day: u64) -> &Day {
        if day == self.day {
            &self.today
        } else if day + 1 == self.day {
            &self.yesterday
        } else {
            &EMPTY
        }
    }
}

/// GDP for the first level, in hours of the world's labour. Each one
/// after costs a level more than the last. A third of what it was when
/// the level counted hours served, since a meal is a fifth of an hour at
/// the world's price and a night a third of a day.
const LEVEL_BASE: f64 = 10.0;

/// The city's level from its GDP to date, and what it took to reach it.
///
/// Level `n` is reached at `LEVEL_BASE * n * (n + 1) / 2`, so each one asks for
/// a little more than the last.
pub fn level(served: f64) -> (u32, f64) {
    let n = (((1.0 + 8.0 * served / LEVEL_BASE).sqrt() - 1.0) / 2.0).floor().max(0.0);
    (n as u32, LEVEL_BASE * n * (n + 1.0) / 2.0)
}

/// Everything the dials need to draw themselves.
pub fn growth(world: &World, now: GameTime) -> Growth {
    let (level, reached) = level(world.gdp);
    let door = world.income.on(now);
    Growth {
        level,
        toward: world.gdp - reached,
        needed: LEVEL_BASE * (level as f64 + 1.0),
        gdp: world.gdp - world.gdp_at_midnight,
        treasury: world.treasury,
        income: door.revenue - door.purchases,
        taken: world.build.taken(),
        road_tiles_left: world.build.road_tiles().saturating_sub(world.laid),
    }
}

/// A building's money, readable: what it charges, and its books. §10.
pub fn inspect(world: &World, id: EntityId, now: GameTime) -> Value {
    let Some(GameObject::Building(b)) = world.objects.get(id).map(|e| &e.object) else { return Value::Null };
    let books = world.books.get(&id);
    let page = |d: &Day| {
        json!({
            "revenue": d.revenue,
            "purchases": d.purchases,
            "wages": d.wages,
            "margin": d.revenue - d.purchases - d.wages,
            "sold": d.sold,
        })
    };
    json!({
        "earns": earns(world, id, now),
        "jobs": blueprint(b.kind).jobs,
        "stock": b.stock,
        "reorder": reorder(world, id),
        "lead": books.and_then(|k| k.lead),
        "prices": b.prices.iter().map(|(need, p)| json!({
            "need": need, "price": p, "unit_cost": unit_cost(b.kind, *need), "edge": edge_price_of(b.kind, *need),
        })).collect::<Vec<_>>(),
        "today": books.map(|k| page(k.on(now))),
        "yesterday": books.map(|k| page(k.before(now))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use BuildingKind::*;

    /// The floor: nothing sells for less than its delivery cost, and every
    /// kind opens with room between that and what it charges.
    #[test]
    fn every_opening_price_covers_its_delivery() {
        for kind in BuildingKind::ALL {
            let b = crate::protocol::Building::new(kind, (1, 1), 2);
            for need in sells(kind) {
                let floor = unit_cost(kind, need);
                let price = b.prices[&need];
                assert!(price >= floor, "{kind:?} opens {need:?} at {price}, under its cost {floor}");
                // Room for a margin over the counter; a depot's margin is
                // the drive it saves (§6.2), so it opens at its floor.
                assert!(floor < edge_price_of(kind, need) || depot(kind), "{kind:?} cannot make a margin on {need:?}");
            }
        }
    }

    #[test]
    fn the_books_turn_a_page_at_midnight() {
        let day = DAY_MS as u64;
        let mut b = Books::default();
        b.today(100).revenue += 3.0;
        assert_eq!(b.on(100).revenue, 3.0);
        b.today(day + 5).revenue += 1.0;
        assert_eq!((b.yesterday.revenue, b.today.revenue), (3.0, 1.0));
        // A day skipped is a day with nothing in it.
        b.today(3 * day);
        assert_eq!(b.yesterday.revenue, 0.0);
        // And the first day has no yesterday at all.
        assert_eq!(Books::default().before(100).revenue, 0.0);
    }

    /// Grass, a street that runs off the survey so the edge stands at its
    /// end, and whatever is built beside it.
    fn town() -> World {
        let mut world = World::new();
        // Deep enough for a warehouse and its yard behind the street.
        for y in -6..6 {
            for x in -4..300 {
                world.terrain.insert((x, y), crate::protocol::TerrainType::Grass);
            }
        }
        world.place_road_path(&(-2..300).map(|x| crate::protocol::GridCoord { x, y: 0 }).collect::<Vec<_>>());
        world
    }

    fn at(x: i32) -> crate::protocol::GridCoord {
        crate::protocol::GridCoord { x, y: 1 }
    }

    fn resident(world: &World, id: EntityId) -> crate::protocol::Resident {
        match world.objects.get(id).unwrap().object {
            GameObject::Resident(ref r) => r.clone(),
            _ => unreachable!(),
        }
    }

    fn building(world: &World, id: EntityId) -> crate::protocol::Building {
        match world.objects.get(id).unwrap().object {
            GameObject::Building(ref b) => b.clone(),
            _ => unreachable!(),
        }
    }

    /// §11.7, the conga: a delivery from a depot is two lines and moves
    /// the treasury by nothing; what the town pays is the depot's fetch
    /// from beyond the edge, at the edge's wholesale plus the crossing,
    /// which is what a delivery straight from beyond the edge costs too.
    #[test]
    fn a_delivery_from_a_depot_moves_no_money() {
        let mut world = town();
        let shop = world.place_on_street(at(4), Shop).unwrap();
        let depot = world.place_on_street(at(20), Warehouse).unwrap();
        world.treasury = 100.0;
        if let Some(GameObject::Building(b)) = world.objects.get_mut(shop).map(|e| &mut e.object) {
            b.stock.take(30.0);
        }
        let load = loaded(&mut world, depot, 30.0, 0);
        delivered(&mut world, shop, Some(depot), load, 0);
        assert_eq!(world.treasury, 100.0, "a delivery inside the town moved money");
        assert_eq!(building(&world, shop).stock.level, building(&world, shop).stock.cap, "the shelf is full");
        assert_eq!(building(&world, depot).stock.short(), 30.0, "the depot's shelf went down by the same");
        let crates = 30.0 * wholesale(Need::Eat);
        assert!((world.books[&shop].on(0).purchases - crates).abs() < 1e-9 && (world.books[&depot].on(0).revenue - crates).abs() < 1e-9, "the books disagree");
        fetched(&mut world, depot, 0);
        assert!((100.0 - world.treasury - import(crates)).abs() < 1e-9, "the fetch cost {}", 100.0 - world.treasury);
        if let Some(GameObject::Building(b)) = world.objects.get_mut(shop).map(|e| &mut e.object) {
            b.stock.take(30.0);
        }
        let before = world.treasury;
        delivered(&mut world, shop, None, 30.0, 0);
        assert!((before - world.treasury - import(crates)).abs() < 1e-9, "from beyond the edge cost {}", before - world.treasury);
    }

    /// §8.2, the door: money moves only when one party is the outside. A
    /// resident's shift at a shop is two lines; at a pass-through it is
    /// hours sold to the edge; at the edge it is the edge wage less the
    /// crossing coming in. A commuter's shift takes their wage home, and
    /// their lunch in town is a meal sold to the outside.
    #[test]
    fn money_moves_only_at_the_door() {
        let mut world = town();
        world.place_on_street(at(4), House).unwrap();
        let shop = world.place_on_street(at(8), Shop).unwrap();
        let office = world.place_on_street(at(30), Office).unwrap();
        world.settle();
        let edge = *world.edge.iter().next().expect("the street runs off the map");
        let people = world.resident_ids();
        let local = *people.iter().find(|&&id| resident(&world, id).work == Some(shop)).expect("the shop hired next door");
        let commuter = *people.iter().find(|&&id| world.edge.contains(&resident(&world, id).home)).expect("the office hired from beyond the edge");
        assert_eq!(resident(&world, commuter).work, Some(office));

        sale(&mut world, local, shop, Need::Work, 9.0, 0);
        assert_eq!(world.treasury, STAKE, "a shift in town moved money");
        assert!((world.books[&shop].on(0).wages - 9.0 * resident(&world, local).wage).abs() < 1e-9);

        let pay = 9.0 * resident(&world, commuter).wage;
        assert!(pay > 9.0 * import(EDGE_WAGE), "a commuter is paid the crossing and the drive: {pay}");
        sale(&mut world, commuter, office, Need::Work, 9.0, 0);
        let door = world.income.on(0).clone();
        assert!((door.revenue - export(9.0 * EDGE_WAGE)).abs() < 1e-9, "the office sold its hours for {}", door.revenue);
        assert!((door.purchases - pay).abs() < 1e-9, "the commuter took home {}", door.purchases);
        assert!((world.gdp - 9.0).abs() < 1e-9, "hours made in town are GDP at the world's price: {}", world.gdp);

        let home_ask = ask(&world, resident(&world, local).home);
        if let Some(GameObject::Resident(r)) = world.objects.get_mut(local).map(|e| &mut e.object) {
            r.wage = home_ask;
        }
        let before = world.treasury;
        sale(&mut world, local, edge, Need::Work, 8.0, 0);
        assert!((world.treasury - before - export(8.0 * EDGE_WAGE)).abs() < 1e-9, "a shift beyond the edge brought {}", world.treasury - before);

        let before = world.treasury;
        sale(&mut world, local, shop, Need::Eat, 1.0, 0);
        assert_eq!(world.treasury, before, "a meal in town moved money");
        sale(&mut world, commuter, shop, Need::Eat, 1.0, 0);
        assert!((world.treasury - before - price_of(&world, shop, Need::Eat)).abs() < 1e-9, "a commuter's lunch is an export");
        let before = world.treasury;
        sale(&mut world, local, edge, Need::Eat, 1.0, 0);
        assert!((before - world.treasury - edge_price(Need::Eat)).abs() < 1e-9, "a meal at the edge is an import");
    }

    /// §10: GDP is value served in town at the world's prices, whatever
    /// the town charged; labour counts inside what it makes; a night is
    /// housing, banked once a head at midnight and bought at the door.
    #[test]
    fn gdp_is_value_at_the_worlds_prices() {
        assert_eq!(value(Shop, Need::Eat), edge_price(Need::Eat));
        assert_eq!(value(Warehouse, Need::Eat), wholesale(Need::Eat));
        assert_eq!((value(Shop, Need::Work), value(House, Need::Rest), value(House, Need::Home)), (0.0, 0.0, 0.0));
        let mut world = town();
        world.place_on_street(at(4), House).unwrap();
        world.settle();
        world.treasury = 10.0;
        let heads = world.resident_ids().len() as f64;
        day(&mut world, DAY_MS as u64);
        assert!((world.gdp - heads * HOUSING).abs() < 1e-9, "{heads} nights served: {}", world.gdp);
        assert!((10.0 - world.treasury - heads * HOUSING).abs() < 1e-9, "and bought from beyond the edge: {}", world.treasury);
        // An import the treasury cannot pay for is paid as far as it goes.
        day(&mut world, 2 * DAY_MS as u64);
        assert_eq!(world.treasury, 0.0);
        assert!((world.gdp - 2.0 * heads * HOUSING).abs() < 1e-9, "a night unpaid for is still a night");
    }

    /// §6.2, `(s, S)`: a shelf reorders when what is on it would not last
    /// the lead time at the taps' full rate with a full house to spare,
    /// and the lead time is the last delivery's.
    #[test]
    fn the_reorder_point_covers_the_lead_and_a_full_house() {
        let mut world = town();
        let shop = world.place_on_street(at(4), Shop).unwrap();
        let seats = 7.0;
        let a_day = rated(Shop, Need::Eat);
        // No delivery yet: as long as a lorry is away beyond the edge.
        let s = reorder(&world, shop);
        assert!((s - (a_day * crate::calls::AWAY_MS as f64 / DAY_MS as f64 + seats)).abs() < 1e-9, "{s}");
        world.books.entry(shop).or_default().lead = Some(0);
        assert_eq!(reorder(&world, shop), seats, "a depot next door leaves the full house");
        world.books.entry(shop).or_default().lead = Some(DAY_MS as GameTime);
        assert!(reorder(&world, shop) > blueprint(Shop).stock as f64, "a day's lead asks for more than the shelf holds");
    }

    /// §6.1 and §13.3: a building prices money in what it makes an hour —
    /// yesterday's takings, or, before it has any, what the edge would pay
    /// for its rated output.
    #[test]
    fn a_building_prices_money_in_what_it_makes() {
        let mut world = town();
        let shop = world.place_on_street(at(4), Shop).unwrap();
        let could: f64 = sells(Shop).map(|need| edge_price_of(Shop, need) * rated(Shop, need)).sum();
        assert!((earns(&world, shop, 0) - could / 24.0).abs() < 1e-9);
        let day = DAY_MS as u64;
        world.books.entry(shop).or_default().today(0).revenue += 6.0;
        assert!((earns(&world, shop, day) - 0.25).abs() < 1e-9, "six hours of takings over a day");
    }

    /// A depot's crate is priced like anything else: it opens at the
    /// edge's wholesale, which is its floor, steps up the day its shelf
    /// ran empty, and never goes under what it paid. A van loads what
    /// the shelf has, and no more.
    #[test]
    fn a_depot_posts_a_price_on_its_shelf() {
        let mut world = town();
        let shop = world.place_on_street(at(4), Shop).unwrap();
        let depot = world.place_on_street(at(20), Warehouse).unwrap();
        let floor = wholesale(Need::Eat);
        let price = |world: &World| building(world, depot).prices[&Need::Eat];
        assert_eq!(price(&world), floor);
        if let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) {
            b.stock.level = 10.0;
        }
        if let Some(GameObject::Building(b)) = world.objects.get_mut(shop).map(|e| &mut e.object) {
            b.stock.take(30.0);
        }
        let load = loaded(&mut world, depot, 30.0, 1);
        assert_eq!((load, building(&world, depot).stock.level), (10.0, 0.0), "the van loaded more than the shelf had");
        delivered(&mut world, shop, Some(depot), load, 1);
        assert_eq!(building(&world, shop).stock.level, 20.0);
        let midnight = DAY_MS as u64;
        day(&mut world, midnight);
        assert!((price(&world) - floor * 1.05).abs() < 1e-9, "an emptied shelf did not step up: {}", price(&world));
        day(&mut world, 2 * midnight);
        day(&mut world, 3 * midnight);
        assert_eq!(price(&world), floor, "quiet days took it under the floor, or not back to it");
    }

    #[test]
    fn levels_come_a_little_further_apart_each_time() {
        assert_eq!(level(0.0), (0, 0.0));
        assert_eq!(level(LEVEL_BASE), (1, LEVEL_BASE));
        assert_eq!(level(3.0 * LEVEL_BASE - 0.1).0, 1);
        assert_eq!(level(3.0 * LEVEL_BASE), (2, 3.0 * LEVEL_BASE));
    }
}
