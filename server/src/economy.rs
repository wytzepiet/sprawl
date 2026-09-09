//! Money, as docs/economy.md lays it out: everyone has a purse, everything
//! is a stock, everyone posts a price and nudges it by their own stock,
//! everyone prices time at what they earn, the edge is the band, and the
//! mayor owns the town.
//!
//! The unit is the hour, and the edge's wage is one. Money moves between
//! purses in lumps — a shift, a meal, a delivery — and is made and
//! destroyed only at the edge. Every purse keeps a float; the rest sweeps
//! to the treasury, which is the one place money accumulates, and so the
//! score. Level is something else: hours of need served, banked as each
//! visit ends.
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

/// A resident's float: a payday of meals, evenings and fuel, which is a
/// day's wage at the edge. What is over it at each payday is rent. §8.2.
pub const RESIDENT_FLOAT: f64 = 8.0;
pub fn resident_float() -> f64 {
    RESIDENT_FLOAT
}

/// A price steps a few percent a day. Firms reprice about once a year
/// (Blinder et al., 1998), and the arcade day stands in for a quarter, so
/// a step is what a quarter's repricing comes to. Down is smaller than
/// up: prices are sticky, and a cut that holds is worth less than a rise
/// that sticks.
const PRICE_UP: f64 = 0.05;
const PRICE_DOWN: f64 = 0.03;
/// Wages are sticky downward in every labour market ever measured: a cut
/// is a fifth of a rise. §5.2.
const WAGE_UP: f64 = 0.05;
const WAGE_DOWN: f64 = 0.01;
/// The least any hour is paid: a tenth of the edge's wage. A wage of
/// nothing makes money worth infinitely many hours to whoever earns it,
/// and the score cannot price that.
const WAGE_FLOOR: f64 = 0.1 * EDGE_WAGE;
/// Selling more than this share of what the tap could sell in a day is
/// selling out; less than this is piling up. The stock behind a tap with
/// no shelf is its capacity.
const SELLING_OUT: f64 = 0.8;
const PILING_UP: f64 = 0.4;
/// A resident leaves one job for another when the new one scores this
/// much better: people move for a raise of a tenth to a fifth (the median
/// job-to-job wage gain, Topel & Ward 1992). §6.3.
pub const SWITCH: f64 = 0.15;

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

/// What a kind's purse keeps: what it spends between two incomes. A day
/// of wages, for a kind whose takings come in through the day and whose
/// wages go out at the end of it; a full shelf at the edge's price. A
/// house spends nothing. A service's wages are the treasury's. §8.2.
pub fn float(kind: BuildingKind, wage: f64) -> f64 {
    let bp = blueprint(kind);
    let wages = if service(kind) || sells(kind).next().is_none() { 0.0 } else { bp.jobs as f64 * shift_hours(kind) * wage };
    wages + bp.stock as f64 * wholesale(shelf_need(kind))
}

/// What one of a kind costs the mayor: the row's price, with the build's
/// discount on its class. Includes the float it opens with.
pub fn price(world: &World, kind: BuildingKind) -> f64 {
    let b = blueprint(kind);
    b.price / world.build.weight(b.class)
}

/// A building saved before it had a shelf, prices or a purse gets them the
/// way a placed one does; one whose row changed its shelf gets the new one.
pub fn open(world: &mut World, id: EntityId) {
    let Some(GameObject::Building(b)) = world.objects.get_mut(id).map(|e| &mut e.object) else { return };
    let fresh = crate::protocol::Building::new(b.kind, b.size, b.facing);
    if b.stock.cap != fresh.stock.cap {
        b.stock = fresh.stock;
    }
    if b.prices.is_empty() {
        b.prices = fresh.prices;
        b.balance = fresh.balance;
    }
}

/// The treasury pays a purse that has run dry back up to its float, as a
/// placement would have. §9.
pub fn fund(world: &mut World, id: EntityId, now: GameTime) {
    let Some(GameObject::Building(b)) = world.objects.get(id).map(|e| &e.object) else { return };
    let want = float(b.kind, b.wage) - b.balance;
    if want <= 0.0 || world.treasury < want {
        return;
    }
    world.treasury -= want;
    if let Some(GameObject::Building(b)) = world.objects.get_mut(id).map(|e| &mut e.object) {
        b.balance += want;
    }
    world.sales.push(Sale { building: id, amount: want, at: now });
}

/// Whether a building can buy and hire: there is money in its purse. The
/// float is the reserve the sweep leaves it; a building that has run
/// through it stops, and stands. A service always can. §9.
pub fn solvent(world: &World, id: EntityId) -> bool {
    match world.objects.get(id).map(|e| &e.object) {
        // A pass-through sells its hours as it pays for them and needs no
        // purse; nor does a service, whose wages are the treasury's.
        Some(GameObject::Building(b)) => float(b.kind, b.wage) == 0.0 || b.balance > 0.0,
        _ => false,
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

/// What a building pays an hour. The edge pays its own.
pub fn wage_of(world: &World, building: EntityId) -> f64 {
    if world.edge.contains(&building) {
        return EDGE_WAGE;
    }
    match world.objects.get(building).map(|e| &e.object) {
        Some(GameObject::Building(b)) => b.wage,
        _ => EDGE_WAGE,
    }
}

/// What a resident makes an hour: their employer's wage, or the edge's
/// for anyone without one. What they price money in. §6.1.
pub fn earning(world: &World, resident: EntityId) -> f64 {
    match world.objects.get(resident).map(|e| &e.object) {
        Some(GameObject::Resident(r)) => r.work.map_or(EDGE_WAGE, |w| wage_of(world, w)),
        _ => EDGE_WAGE,
    }
}

/// One visit paid for, as it ends: `units` of `need` served at `at` to
/// `who`. A shift is sold by the resident and paid by the building; a
/// meal, an evening or a tank is bought by the resident and lands on the
/// building. Anything that runs a shelf draws it down. The edge pays and
/// charges its own prices, and serves anyone who cannot pay: the floor has
/// to be a floor. Then the sweeps. §6, §8, §12.1.
pub fn sale(world: &mut World, who: EntityId, at: EntityId, need: Need, units: f64, now: GameTime) {
    if units <= 0.0 {
        return;
    }
    let edge = world.edge.contains(&at);
    let Some(kind) = kind_of(world, at) else { return };
    match need {
        Need::Work => {
            // A workplace with nothing to sell sells its hours to the edge,
            // at the edge's wage, before it pays for them: a pass-through,
            // until goods give it an output. §12.1.
            if !edge && !service(kind) && sells(kind).next().is_none() {
                let sold = units * EDGE_WAGE;
                pay(world, at, sold);
                world.books.entry(at).or_default().today(now).revenue += sold;
                world.sales.push(Sale { building: at, amount: sold, at: now });
            }
            let due = units * wage_of(world, at);
            let paid = if edge {
                due
            } else if service(kind) {
                let paid = due.min(world.treasury);
                world.treasury -= paid;
                paid
            } else {
                let paid = balance(world, at).min(due);
                pay(world, at, -paid);
                paid
            };
            if let Some(GameObject::Resident(r)) = world.objects.get_mut(who).map(|e| &mut e.object) {
                r.wallet += paid;
            }
            if !edge {
                let book = world.books.entry(at).or_default().today(now);
                book.wages += paid;
                book.hours += units;
                sweep(world, at, now);
            }
            rent(world, who, now);
        }
        Need::Home | Need::Rest => {}
        Need::Eat | Need::Leisure | Need::Fuel => {
            let due = units * price_of(world, at, need);
            let Some(GameObject::Resident(r)) = world.objects.get_mut(who).map(|e| &mut e.object) else { return };
            let paid = due.min(r.wallet);
            r.wallet -= paid;
            // The edge's takings are the edge's; so are the groceries
            // behind a meal at home, until something in town sells them.
            if edge || blueprint(kind).homes > 0 {
                return;
            }
            pay(world, at, paid);
            let book = world.books.entry(at).or_default().today(now);
            book.revenue += paid;
            *book.sold.entry(need).or_default() += units;
            if paid > 0.0 {
                world.sales.push(Sale { building: at, amount: paid, at: now });
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
            sweep(world, at, now);
        }
    }
}

/// A building's sweep, at each income: what is over the float goes to
/// the treasury, and the float is what it runs on until the next one —
/// the day's wages, and a restock. The lump on the map is the sale
/// itself; the treasury steps with it. §8.2.
fn sweep(world: &mut World, building: EntityId, now: GameTime) {
    let Some(GameObject::Building(b)) = world.objects.get_mut(building).map(|e| &mut e.object) else { return };
    let over = b.balance - float(b.kind, b.wage);
    if over <= 0.0 {
        return;
    }
    b.balance -= over;
    world.treasury += over;
    world.income.today(now).revenue += over;
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
/// from beyond the edge. The buyer pays the seller's posted price per
/// unit — beyond the edge, the edge's wholesale. §7.
pub fn delivered(world: &mut World, buyer: EntityId, seller: Option<EntityId>, load: f64, now: GameTime) {
    let Some(kind) = kind_of(world, buyer) else { return };
    let need = shelf_need(kind);
    let unit = seller.map_or(wholesale(need), |s| price_of(world, s, need));
    let Some(GameObject::Building(b)) = world.objects.get_mut(buyer).map(|e| &mut e.object) else { return };
    let units = load.min(b.stock.short());
    if units <= 0.0 {
        return;
    }
    let due = units * unit;
    let paid = due.min(b.balance).max(0.0);
    b.stock.add(units);
    b.balance -= paid;
    world.books.entry(buyer).or_default().today(now).purchases += paid;
    world.sales.push(Sale { building: buyer, amount: -paid, at: now });
    if let Some(seller) = seller {
        pay(world, seller, paid);
        let book = world.books.entry(seller).or_default().today(now);
        book.revenue += paid;
        *book.sold.entry(need).or_default() += units;
        world.sales.push(Sale { building: seller, amount: paid, at: now });
        sweep(world, seller, now);
    }
}

/// A depot's lorry came home full from beyond the edge: the depot pays
/// the edge for what it brought.
pub fn fetched(world: &mut World, depot: EntityId, now: GameTime) {
    let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) else { return };
    let units = b.stock.short();
    let paid = (units * wholesale(Need::Eat)).min(b.balance).max(0.0);
    b.stock.add(units);
    b.balance -= paid;
    world.books.entry(depot).or_default().today(now).purchases += paid;
    world.sales.push(Sale { building: depot, amount: -paid, at: now });
}

/// A resident's sweep, at each payday: what is over the float is rent,
/// and rent lands on the home. A home beyond the edge is the edge's. §8.2.
fn rent(world: &mut World, who: EntityId, now: GameTime) {
    let Some(GameObject::Resident(r)) = world.objects.get_mut(who).map(|e| &mut e.object) else { return };
    let rent = r.wallet - RESIDENT_FLOAT;
    if rent <= 0.0 {
        return;
    }
    r.wallet = RESIDENT_FLOAT;
    let home = r.home;
    if world.edge.contains(&home) {
        return;
    }
    world.treasury += rent;
    world.income.today(now).revenue += rent;
    world.sales.push(Sale { building: home, amount: rent, at: now });
}

/// Midnight: every building counts its day. Each price steps by its own
/// stock; the wage steps by who filled the desks; and the books turn a
/// page. §5.
pub fn day(world: &mut World, now: GameTime) {
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
        let commuters = world.staff_from_the_edge(id);
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
        if blueprint(kind).jobs > 0 && !service(kind) {
            // What an hour of labour brought in: the day's takings less
            // what it bought, over the hours it paid for. A pass-through's
            // is the edge's wage exactly. A wage never rises past it, and
            // a wage above it is cut to it at once: wages are sticky
            // downward in a firm that is making money, and cut in one
            // that is not (Bewley, 1999) — a shop with no trade pays what
            // its trade is worth, and its staff take the next best score.
            // A day nobody worked says nothing, and the wage stands.
            let brings = if book.hours > 0.0 { (book.revenue - book.purchases) / book.hours } else { b.wage };
            // A desk the edge had to fill is a vacancy the town's wage did
            // not: the building pays for the commute through the wage.
            b.wage = if b.wage > brings {
                brings
            } else if commuters > 0 {
                (b.wage * (1.0 + WAGE_UP)).min(brings)
            } else {
                b.wage * (1.0 - WAGE_DOWN)
            }
            .max(WAGE_FLOOR);
        }
    }
}

fn kind_of(world: &World, building: EntityId) -> Option<BuildingKind> {
    match world.objects.get(building)?.object {
        GameObject::Building(ref b) => Some(b.kind),
        _ => None,
    }
}

fn balance(world: &World, building: EntityId) -> f64 {
    match world.objects.get(building).map(|e| &e.object) {
        Some(GameObject::Building(b)) => b.balance,
        _ => 0.0,
    }
}

fn pay(world: &mut World, building: EntityId, amount: f64) {
    if let Some(GameObject::Building(b)) = world.objects.get_mut(building).map(|e| &mut e.object) {
        b.balance += amount;
    }
}

/// One day of a purse's books: what came in, what went out, what was
/// sold, and how much labour was bought.
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

/// A purse's books: today's page and yesterday's, keyed by the day today
/// is. Learned, not saved — a loaded world starts counting afresh.
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

/// Hours served for the first level. Each one after costs a level more
/// than the last.
const LEVEL_BASE: f64 = 30.0;

/// The city's level from hours served, and what it took to reach it.
///
/// Level `n` is reached at `LEVEL_BASE * n * (n + 1) / 2`, so each one asks for
/// a little more than the last.
pub fn level(served: f64) -> (u32, f64) {
    let n = (((1.0 + 8.0 * served / LEVEL_BASE).sqrt() - 1.0) / 2.0).floor().max(0.0);
    (n as u32, LEVEL_BASE * n * (n + 1.0) / 2.0)
}

/// Everything the dials need to draw themselves.
pub fn growth(world: &World, now: GameTime) -> Growth {
    let (level, reached) = level(world.served);
    Growth {
        level,
        xp: world.served - reached,
        xp_needed: LEVEL_BASE * (level as f64 + 1.0),
        treasury: world.treasury,
        income: world.income.on(now).revenue,
        taken: world.build.taken(),
        road_tiles_left: world.build.road_tiles().saturating_sub(world.laid),
    }
}

/// A building's money, readable: what it holds against its float, what it
/// charges, and its books. §10.
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
        "balance": b.balance,
        "float": float(b.kind, b.wage),
        "solvent": solvent(world, id),
        "earns": earns(world, id, now),
        "jobs": blueprint(b.kind).jobs,
        "wage": b.wage,
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
    fn a_house_keeps_no_float_and_a_shop_keeps_a_day() {
        assert_eq!(float(House, EDGE_WAGE), 0.0);
        let shop = float(Shop, EDGE_WAGE);
        let wages = 2.0 * shift_hours(Shop);
        let shelf = blueprint(Shop).stock as f64 * wholesale(Need::Eat);
        assert!((shop - wages - shelf).abs() < 1e-9, "{shop} vs {wages} + {shelf}");
        // A pass-through sells its hours the moment it pays for them.
        assert_eq!(float(Office, EDGE_WAGE), 0.0);
        // A service's wages are the treasury's; its float is its shelf.
        assert_eq!(float(Warehouse, EDGE_WAGE), blueprint(Warehouse).stock as f64 * wholesale(Need::Eat));
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

    /// Grass, a street, and whatever is built beside it.
    fn town() -> World {
        let mut world = World::new();
        // Deep enough for a warehouse and its yard behind the street.
        for y in -6..6 {
            for x in -4..40 {
                world.terrain.insert((x, y), crate::protocol::TerrainType::Grass);
            }
        }
        world.place_road_path(&(-2..40).map(|x| crate::protocol::GridCoord { x, y: 0 }).collect::<Vec<_>>());
        world
    }

    fn building(world: &World, id: EntityId) -> crate::protocol::Building {
        match world.objects.get(id).unwrap().object {
            GameObject::Building(ref b) => b.clone(),
            _ => unreachable!(),
        }
    }

    /// §11.7, the conga: a delivery moves exactly what it costs from the
    /// buyer to the seller, so a warehouse that shortens nothing makes no
    /// margin, and has nothing over its float to sweep.
    #[test]
    fn a_delivery_moves_exactly_what_it_costs() {
        let mut world = town();
        let shop = world.place_on_street(crate::protocol::GridCoord { x: 4, y: 1 }, Shop).unwrap();
        let depot = world.place_on_street(crate::protocol::GridCoord { x: 20, y: 1 }, Warehouse).unwrap();
        let (before_shop, before_depot) = (building(&world, shop), building(&world, depot));
        if let Some(GameObject::Building(b)) = world.objects.get_mut(shop).map(|e| &mut e.object) {
            b.stock.take(30.0);
        }
        let load = loaded(&mut world, depot, 30.0, 0);
        delivered(&mut world, shop, Some(depot), load, 0);
        let (after_shop, after_depot) = (building(&world, shop), building(&world, depot));
        let paid = before_shop.balance - after_shop.balance;
        assert!((paid - 30.0 * wholesale(Need::Eat)).abs() < 1e-9, "the shop paid {paid}");
        // The depot was at its float, so what it got swept at once.
        assert!((after_depot.balance - before_depot.balance).abs() < 1e-9 && (world.treasury - paid).abs() < 1e-9, "the depot got something else");
        assert_eq!(after_shop.stock.level, after_shop.stock.cap, "the shelf is full");
        assert_eq!(before_depot.stock.level - after_depot.stock.level, 30.0, "the depot's shelf went down by the same");
        // The sale over the float sweeps at once; the depot's own restock
        // then costs it exactly what it sold for, so from the second round
        // on its purse comes back to where it was and nothing more sweeps.
        fetched(&mut world, depot, 0);
        let settled = building(&world, depot).balance;
        let swept = world.treasury;
        for _ in 0..3 {
            if let Some(GameObject::Building(b)) = world.objects.get_mut(shop).map(|e| &mut e.object) {
                b.stock.take(30.0);
            }
            let load = loaded(&mut world, depot, 30.0, 0);
            delivered(&mut world, shop, Some(depot), load, 0);
            fetched(&mut world, depot, 0);
        }
        assert!((building(&world, depot).balance - settled).abs() < 1e-9, "the warehouse made a margin");
        assert!((world.treasury - swept).abs() < 1e-9, "the warehouse swept {}", world.treasury - swept);
    }

    /// §11.9, the door breaks even: a payday leaves a resident their float
    /// and no more, whatever they earned, and the rest is rent on the home.
    #[test]
    fn a_payday_leaves_the_float() {
        let mut world = town();
        let home = world.place_on_street(crate::protocol::GridCoord { x: 4, y: 1 }, House).unwrap();
        let office = world.place_on_street(crate::protocol::GridCoord { x: 12, y: 1 }, Office).unwrap();
        world.settle();
        let who = world.resident_ids()[0];
        if let Some(GameObject::Resident(r)) = world.objects.get_mut(who).map(|e| &mut e.object) {
            r.wallet = RESIDENT_FLOAT - 1.0;
        }
        sale(&mut world, who, office, Need::Work, 9.0, 0);
        let wallet = match world.objects.get(who).unwrap().object {
            GameObject::Resident(ref r) => r.wallet,
            _ => unreachable!(),
        };
        assert_eq!(wallet, RESIDENT_FLOAT, "the wallet is the float again");
        assert!((world.treasury - (9.0 - 1.0)).abs() < 1e-9, "the rest is rent: {}", world.treasury);
        assert!(world.sales.iter().any(|s| s.building == home && (s.amount - 8.0).abs() < 1e-9), "the rent landed on the home");
    }

    /// §6.2, `(s, S)`: a shelf reorders when what is on it would not last
    /// the lead time at the taps' full rate with a full house to spare,
    /// and the lead time is the last delivery's.
    #[test]
    fn the_reorder_point_covers_the_lead_and_a_full_house() {
        let mut world = town();
        let shop = world.place_on_street(crate::protocol::GridCoord { x: 4, y: 1 }, Shop).unwrap();
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
        let shop = world.place_on_street(crate::protocol::GridCoord { x: 4, y: 1 }, Shop).unwrap();
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
        let shop = world.place_on_street(crate::protocol::GridCoord { x: 4, y: 1 }, Shop).unwrap();
        let depot = world.place_on_street(crate::protocol::GridCoord { x: 20, y: 1 }, Warehouse).unwrap();
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
