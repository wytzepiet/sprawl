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

/// What the edge sells a unit of each need for: what the row behind it
/// is worth, link by link (§8.1). A meal is the crate plus the world's
/// counter over two thirds, and the crate is the farm's row read back
/// (`wholesale`); a unit of services is the office's row. The rest have
/// no row in town yet, so each is a number with the row's name on it
/// (§13.3), set by the household's budget: a day at the edge earns
/// eight, a sixth of it goes on transport, a tenth on leisure. The tank
/// is three, and a service six (`Need::Wear`). An evening out is less
/// than its share, because the price is added to the visit in the
/// resident's own hours (§6.1) and the ladder of residents.md §5.5 is
/// tuned to tenths: at an hour an evening loses to waiting up for bed
/// and nobody goes out. Housing's third is in the household's services.
/// Low stakes: the band turns a wrong number into a town that is a
/// little dear or a little cheap, never one that runs away. §12.1,
/// §12.2, §12.7.
pub fn edge_price(need: Need) -> f64 {
    match need {
        Need::Eat => worth(wholesale(need), COUNTER),
        Need::Services => wholesale(need),
        Need::Leisure => 0.5,
        Need::Fuel => 3.0,
        // A service, every two and a half tanks: with the tank's price,
        // the two come to the transport sixth at a commuter's hundred and
        // twenty tiles a day. Half the drive's cost is fuel and half is
        // upkeep, near enough what running a car costs.
        Need::Wear => 6.0,
        Need::Work => EDGE_WAGE,
        Need::Home | Need::Rest => 0.0,
    }
}

/// Hours of labour the world's counter spends on a meal: under two
/// minutes, so that labour is a sixth of the till, between a
/// supermarket's tenth and a restaurant's third. With the crate at the
/// farm's rate this puts the meal at the fifth of an hour the ladder is
/// tuned to (§12.2): at half an hour a full sitting ties the shift it
/// would interrupt and nobody lunches out. The town's own counters are
/// staffed far over this (§13.7), and pay for it.
pub const COUNTER: f64 = 1.0 / 36.0;

/// What the edge sells the unit on the shelf for. A good a row in town
/// makes is worth that row's labour over two thirds: a crate is a
/// farm hand's few minutes, a unit of services an office's hour. The
/// delivery behind a tank and the parts behind a service have no row
/// in town yet, and are half the price over the counter: retail margins
/// on fuel and parts sit between a third and a half.
pub const WHOLESALE: f64 = 0.5;
pub fn wholesale(need: Need) -> f64 {
    match crate::blueprint::maker(need) {
        Some(row) => adds(1.0 / row.per_hour),
        None => WHOLESALE * edge_price(need),
    }
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

/// What the mayor founds the town with: a few weeks of the starting
/// households' imports, so the town can buy fuel and crates until its
/// first shifts are sold beyond the edge. A treasury at zero cannot
/// import fuel, and a town without fuel cannot work, which is a trap a
/// fresh town must not start in. The floats every building used to open
/// with, in one place. §12.4.
pub const STAKE: f64 = 500.0;

/// What a row keeps of what it adds, and so what the town's money is
/// (§8.1). A firm's output is worth its inputs plus its labour over one
/// less capital's share: the split of value added between labour and
/// capital, about a third to capital, is among the steadiest numbers in
/// economics. A household's labour is worth its inputs over one less its
/// saving: households consume about nine tenths of what they earn.
pub const CAPITAL: f64 = 1.0 / 3.0;
pub const SAVING: f64 = 0.1;
/// What a firm buys in services for each hour of labour it buys, at the
/// world's price: purchased services against the wage bill, about a fifth
/// in input-output tables. The one input every firm's row has besides
/// what its shelf holds (§4), the same fifth on every row until a row
/// has a referent of its own (§13.15).
pub const SERVICES: f64 = 0.2;
/// What a row's output is worth at the world's prices: its inputs bought
/// in, plus its labour with the services bought in for it, over two
/// thirds (§8.1). One link of the chain.
pub fn worth(inputs: f64, labour: f64) -> f64 {
    (inputs + labour * (1.0 + SERVICES)) / (1.0 - CAPITAL)
}
/// What an hour of labour makes on its own: a pass-through's export,
/// and a maker's unit at its rate.
pub fn adds(labour: f64) -> f64 {
    worth(0.0, labour)
}

/// The household row's inputs a head a day, at the world's prices,
/// which come to nine tenths of a day's wage at the edge (§4, §8.1).
/// Sittings and an evening are the table's; transport is its budget
/// sixth, an estimate of what the car burns; services — the night's
/// upkeep, repairs, and everything else on no shelf — are the rest,
/// drawn from the home's services stock by the day, made by an office in
/// town or a consultant from beyond the edge. A night served is worth
/// its services in GDP.
/// Hours a head sells a day at the edge: a shift.
pub const SHIFT: f64 = 8.0;
pub const TRANSPORT: f64 = SHIFT / 6.0;
pub fn household() -> f64 {
    SHIFT * EDGE_WAGE * (1.0 - SAVING)
}
pub fn services() -> f64 {
    let sittings = 2.4 * edge_price(Need::Eat);
    let evening = edge_price(Need::Leisure);
    household() - sittings - evening - TRANSPORT
}

/// Days of its own draw a building's services stock holds: two, so it
/// calls about every other day, as a shop's shelf does. A week was
/// tried: forty buildings founded together order the same day, the
/// office has shipped its shelf to the edge by then, and the town buys
/// the week from consultants. §12.5.
pub const SERVICES_COVER: f64 = 2.0;

/// Units of services a kind's row draws a day: a head's share for each
/// room, and a fifth of an hour's worth for each hour its desks could
/// work. The edge draws nothing; it runs at capacity. The rate on the
/// row; what a home draws is by its actual heads (`drawn`).
pub fn draw(kind: BuildingKind) -> f64 {
    if kind == BuildingKind::Edge {
        return 0.0;
    }
    let bp = blueprint(kind);
    (bp.homes as f64 * services() + rated(kind, Need::Work) * SERVICES * EDGE_WAGE) / edge_price(Need::Services)
}

/// The stocks a kind holds, and their caps: its shelf, if the row keeps
/// one, and a week of the services it draws — or, for a kind that makes
/// them, its shelf is the services. §4.
pub fn stocks(kind: BuildingKind) -> BTreeMap<Need, f64> {
    let bp = blueprint(kind);
    let mut stocks = BTreeMap::new();
    if draw(kind) > 0.0 {
        stocks.insert(Need::Services, SERVICES_COVER * draw(kind));
    }
    if bp.stock > 0 {
        stocks.insert(shelf_need(kind), bp.stock as f64);
    }
    stocks
}

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
pub const PRICE_UP: f64 = 0.05;
pub const PRICE_DOWN: f64 = 0.03;
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

/// The good a kind's shelf holds: what its labour makes, or what its
/// deliveries are — fuel where it pumps, parts where it services cars,
/// food everywhere else that keeps a shelf.
pub fn shelf_need(kind: BuildingKind) -> Need {
    let bp = blueprint(kind);
    bp.makes.map(|m| m.good).or_else(|| bp.taps.iter().map(|t| t.need).find(|n| Need::DRIVEN.contains(n))).unwrap_or(Need::Eat)
}

/// Its labour fills its shelf with this, at its row's rate: it never
/// calls for it, and ships what nobody in town buys to the edge.
pub fn makes(kind: BuildingKind, need: Need) -> bool {
    blueprint(kind).makes.is_some_and(|m| m.good == need)
}

/// What lands on a maker's shelf at once: a field's crop where the row
/// is a farm's, else a shift's make, its hours at the row's rate in one
/// lump as the tab is paid. A shelf with less room than this ships, or
/// calls for pickup, before the load is lost to it (`calls::turn`), and
/// offers no work meanwhile (`hiring`).
pub fn lump(kind: BuildingKind) -> f64 {
    if farm(kind) {
        return crop(kind);
    }
    blueprint(kind).makes.map_or(0.0, |m| shift_hours(kind) * m.per_hour)
}

/// Works land with a tractor. §12.8.
pub fn farm(kind: BuildingKind) -> bool {
    blueprint(kind).farm
}

/// What one tile of a farm's land grows in a cycle: the yard, a
/// harvest, over the tiles a shift's ploughing makes a farm of. A farm
/// on cramped ground has fewer, and makes less.
pub fn crop(kind: BuildingKind) -> f64 {
    blueprint(kind).stock as f64 / crate::world::fields::capacity(kind)
}

/// The tractor cut a tile: its crop lands in the yard. The farm's own,
/// so no line and no money. §12.8.
pub fn harvested(world: &mut World, farm: EntityId, load: f64) {
    let Some(GameObject::Building(b)) = world.objects.get_mut(farm).map(|e| &mut e.object) else { return };
    if let Some(m) = blueprint(b.kind).makes
        && let Some(yard) = b.stocks.get_mut(&m.good)
    {
        yard.add(load);
    }
}

/// A row calls only for what it buys: the services it draws, and the
/// shelf its counter sells from or its vans deliver, unless its own
/// labour or fields fill it.
pub fn buys(kind: BuildingKind, need: Need) -> bool {
    let bp = blueprint(kind);
    if makes(kind, need) {
        return false;
    }
    if need == Need::Services {
        return draw(kind) > 0.0;
    }
    need == shelf_need(kind) && bp.stock > 0 && (bp.taps.iter().any(|t| t.need == need) || depot(kind))
}

/// Does a maker's shelf have room for the next load? One with none
/// offers no work: a full yard stops the line, felt as wages not paid
/// (§4, §13.19). Everything else always hires.
pub fn hiring(world: &World, building: EntityId) -> bool {
    let Some(GameObject::Building(b)) = world.objects.get(building).map(|e| &e.object) else { return false };
    match blueprint(b.kind).makes {
        Some(m) => b.stocks.get(&m.good).is_none_or(|s| s.short() >= lump(b.kind)),
        None => true,
    }
}

/// Keeps a shelf and runs vehicles: sells its shelf by delivery,
/// answering the calls of stocks running low with a van or a car of its
/// own.
pub fn depot(kind: BuildingKind) -> bool {
    let bp = blueprint(kind);
    bp.stock > 0 && !bp.vehicles.is_empty()
}

/// What one unit costs a kind to sell: the delivery behind it, and
/// nothing behind an evening out. The floor a price never goes under is
/// marginal cost — the shutdown rule: a firm sells while the price covers
/// what the sale itself costs, and pays its staff from the margin or
/// runs through its float (§9). The hours behind the counter are not in
/// it on purpose: spread over a bar's evenings they come to an hour's
/// wage each, and at that price nobody goes out (`edge_price`); spread
/// over the day's actual sales they rise as trade falls and price a
/// quiet shop out. A maker's floor is what the edge pays for a unit,
/// since it can always ship one there instead. §5.1.
pub fn unit_cost(kind: BuildingKind, need: Need) -> f64 {
    if need != shelf_need(kind) || blueprint(kind).stock == 0 {
        0.0
    } else if makes(kind, need) {
        export(wholesale(need))
    } else {
        wholesale(need)
    }
}

/// What one of a kind costs the mayor: the row's price, with the build's
/// discount on its class. Paid to the outside: a placement is an import.
pub fn price(world: &World, kind: BuildingKind) -> f64 {
    let b = blueprint(kind);
    b.price / world.build.weight(b.class)
}

/// A building saved before it had a stock or prices gets them the way a
/// placed one does; one whose row changed a stock gets the new one, full.
pub fn open(world: &mut World, id: EntityId) {
    let Some(GameObject::Building(b)) = world.objects.get_mut(id).map(|e| &mut e.object) else { return };
    let fresh = crate::protocol::Building::new(b.kind, b.size, b.facing);
    b.stocks.retain(|need, stock| fresh.stocks.get(need).is_some_and(|f| f.cap == stock.cap));
    for (need, stock) in fresh.stocks {
        b.stocks.entry(need).or_insert(stock);
    }
    if b.prices.is_empty() {
        b.prices = fresh.prices;
    }
}

/// The reorder point: the `s` of the `(s, S)` policy of every inventory
/// textbook, with the stock's cap as `S`. Expected use over the lead
/// time — what the taps could sell, and the row draws, in the time the
/// last delivery took — plus a margin, which is a full house: everyone
/// the taps seat at once, so a rush during the lead does not empty the
/// shelf. Until a building has had a delivery, one is assumed to take as
/// long as a lorry is away beyond the edge. §6.2.
pub fn reorder(world: &World, building: EntityId, need: Need) -> f64 {
    let Some(kind) = kind_of(world, building) else { return 0.0 };
    let lead = world.books.get(&building).and_then(|k| k.lead).unwrap_or(crate::calls::AWAY_MS);
    // A full house is everyone who can be there at once, which for a
    // visitor tap is the lot's spots, as the crowd is counted
    // (`resident::slots_at`): two bays with seven cars queued in the lot
    // is a rush of seven.
    let seats: u32 = match world.spots_at(building) {
        Some(n) if blueprint(kind).taps.iter().any(|t| t.need == need) => n,
        _ => blueprint(kind).taps.iter().filter(|t| t.need == need).map(|t| t.slots).sum(),
    };
    let draw = if need == Need::Services { draw(kind) } else { 0.0 };
    (rated(kind, need) + draw) * lead as f64 / DAY_MS as f64 + seats as f64
}

/// Time passed at a building: at every look at its stocks, what the row
/// used since the last look comes off its services — a home by the
/// heads under its roof, a firm by its row — and what the stock had of
/// it a home banks as GDP, a night served at the world's price. A
/// firm's draw is a line, not GDP: intermediate. An empty stock serves
/// nothing. The first look after a load only starts the clock. §4, §10.
pub fn passed(world: &mut World, building: EntityId, now: GameTime) {
    let Some(kind) = kind_of(world, building) else { return };
    let bp = blueprint(kind);
    let Some(since) = world.books.entry(building).or_default().looked.replace(now) else { return };
    let days = now.saturating_sub(since) as f64 / DAY_MS as f64;
    let rate = if bp.homes > 0 {
        let heads = world.objects.iter().filter(|e| matches!(e.object, GameObject::Resident(ref r) if r.home == building)).count() as f64;
        heads * services() / edge_price(Need::Services)
    } else {
        draw(kind)
    };
    let Some(GameObject::Building(b)) = world.objects.get_mut(building).map(|e| &mut e.object) else { return };
    let Some(stock) = b.stocks.get_mut(&Need::Services) else { return };
    let due = rate * days;
    let served = due.min(stock.level);
    stock.take(due);
    if bp.homes > 0 {
        world.gdp += served * wholesale(Need::Services);
    }
}

/// What a kind's row is worth a day at the world's prices, at capacity:
/// what its taps sell over the counter and its vehicles deliver; a
/// pass-through's hours over two thirds; a home's household's shifts.
pub fn output(kind: BuildingKind) -> f64 {
    let bp = blueprint(kind);
    if bp.homes > 0 {
        return bp.homes as f64 * SHIFT * EDGE_WAGE;
    }
    let sold: f64 = sells(kind).map(|need| edge_price_of(kind, need) * rated(kind, need)).sum();
    if sold > 0.0 { sold } else { adds(rated(kind, Need::Work) * EDGE_WAGE) }
}

/// What a building makes an hour, which is what an hour of money is
/// worth to it: yesterday's takings over the day, or, before it has a
/// day of them, what the edge would pay for everything it could sell
/// (§13.3). A home's takings are its residents' wages, booked where they
/// work, so it always prices money in its row. What it weighs a
/// delivery's lead time against. §6.1.
pub fn earns(world: &World, building: EntityId, now: GameTime) -> f64 {
    let Some(kind) = kind_of(world, building) else { return EDGE_WAGE };
    let yesterday = world.books.get(&building).map_or(0.0, |k| k.before(now).revenue);
    (if yesterday > 0.0 { yesterday } else { output(kind) }) / 24.0
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
/// meal, an evening, a tank or a service is bought by the resident and
/// sold by the building. Two lines in the books, and a lump on the map; the treasury
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
            // edge, at what an hour makes, less the crossing: a
            // pass-through, until goods give it an output. §12.1, §8.1.
            if sells(kind).next().is_none() {
                let made = adds(units * EDGE_WAGE);
                world.gdp += made;
                world.books.entry(at).or_default().today(now).revenue += export(made);
                world.sales.push(Sale { building: at, amount: export(made), at: now });
                door(world, export(made), now);
            }
            // A row that makes something fills its shelf at its rate;
            // what does not fit is lost, which is the full yard stopping
            // the line (§4). A farm makes by the harvest: its hands drive
            // the tractor (`world/fields.rs`).
            if let Some(row) = blueprint(kind).makes
                && !farm(kind)
                && let Some(GameObject::Building(b)) = world.objects.get_mut(at).map(|e| &mut e.object)
                && let Some(stock) = b.stocks.get_mut(&row.good)
            {
                stock.add(units * row.per_hour);
            }
            let book = world.books.entry(at).or_default().today(now);
            book.wages += due;
            book.hours += units;
            // A commuter takes the wage home, beyond the edge.
            if commuter {
                door(world, -due, now);
            }
        }
        Need::Home | Need::Rest | Need::Services => {}
        Need::Eat | Need::Leisure | Need::Fuel | Need::Wear => {
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
            if let Some(GameObject::Building(b)) = world.objects.get_mut(at).map(|e| &mut e.object)
                && let Some(stock) = b.stocks.get_mut(&need)
            {
                stock.take(units);
                if stock.level == 0.0 {
                    world.books.entry(at).or_default().today(now).sold_out = true;
                }
            }
        }
    }
}

/// A van loads at a depot: as much of the order as the shelf has. The
/// shelf goes down as the load leaves, and a shelf that empties is sold
/// out; the money moves when the load lands (`delivered`). §7.
pub fn loaded(world: &mut World, depot: EntityId, need: Need, order: f64, now: GameTime) -> f64 {
    let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) else { return 0.0 };
    let Some(stock) = b.stocks.get_mut(&need) else { return 0.0 };
    let load = order.min(stock.level);
    stock.take(load);
    if stock.level == 0.0 {
        world.books.entry(depot).or_default().today(now).sold_out = true;
    }
    load
}

/// A maker's car loads for the edge: the whole shelf, since the edge
/// buys without limit. Not a sale for the nudge — nobody in town bought
/// it, which is piling up, not selling out — and paid when the car is
/// home (`exported`). §8.1.
pub fn shipped(world: &mut World, maker: EntityId, need: Need) -> f64 {
    let Some(GameObject::Building(b)) = world.objects.get_mut(maker).map(|e| &mut e.object) else { return 0.0 };
    let Some(stock) = b.stocks.get_mut(&need) else { return 0.0 };
    std::mem::replace(&mut stock.level, 0.0)
}

/// A maker's car came home from the edge: the town sold the load at the
/// edge's price less the crossing, and what it sold out is GDP at the
/// world's price. §8.1.
pub fn exported(world: &mut World, maker: EntityId, need: Need, load: f64, now: GameTime) {
    let due = export(load * wholesale(need));
    world.gdp += load * wholesale(need);
    world.books.entry(maker).or_default().today(now).revenue += due;
    world.sales.push(Sale { building: maker, amount: due, at: now });
    door(world, due, now);
}

/// A facility's vehicle is home: its tank is filled and its wear put
/// right in the yard, and the building pays the world's price for what
/// the trip used, at wholesale plus the crossing, as the depot's fuel
/// and parts are bought in bulk from beyond the edge until a row in
/// town sells them. The freight of §5.3 in money: fuel and upkeep per
/// tile, on the row that sent the vehicle. Nobody sits in a fleet
/// vehicle, so nobody weighs its needs; the building's turn does, when
/// it comes home. A line in the books and the door, no GDP:
/// intermediate. §12.6.
pub fn refilled(world: &mut World, car: EntityId, now: GameTime) {
    let Some(GameObject::Car(c)) = world.objects.get_mut(car).map(|e| &mut e.object) else { return };
    let owner = c.owner;
    let mut due = 0.0;
    for (&need, stock) in c.stocks.iter_mut() {
        due += stock.short() / stock.cap * wholesale(need);
        stock.level = stock.cap;
    }
    if due <= 0.0 || kind_of(world, owner).is_none() {
        return;
    }
    world.books.entry(owner).or_default().today(now).purchases += import(due);
    door(world, -import(due), now);
}

/// A delivery landed: `load` of `need` onto `buyer`'s stock, from
/// `seller`'s or from beyond the edge. From a seller in town it is two
/// lines at the seller's posted price and moves nothing; from beyond
/// the edge the town buys the load at the edge's wholesale plus the
/// crossing, as far as the treasury goes. A lorry home from a fetch
/// beyond the edge lands a load without limit: the shelf fills. §7,
/// §8.2.
pub fn delivered(world: &mut World, buyer: EntityId, seller: Option<EntityId>, need: Need, load: f64, now: GameTime) {
    let unit = seller.map_or(import(wholesale(need)), |s| price_of(world, s, need));
    let Some(GameObject::Building(b)) = world.objects.get_mut(buyer).map(|e| &mut e.object) else { return };
    let Some(stock) = b.stocks.get_mut(&need) else { return };
    let units = load.min(stock.short());
    if units <= 0.0 {
        return;
    }
    let due = units * unit;
    stock.add(units);
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

/// Midnight: every building counts its day. Each price steps by its own
/// stock, and the books turn a page. §5.
pub fn day(world: &mut World, now: GameTime) {
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
    /// When time last passed at it (`passed`): services drawn, a crop
    /// grown. None until the first look, which starts the clock.
    pub looked: Option<GameTime>,
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
/// the world's price; up by a third again when a night became the
/// household's services (§12.5), so a level comes at the pace it did.
const LEVEL_BASE: f64 = 13.0;

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
        imports: door.purchases,
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
        "stocks": b.stocks.iter().map(|(need, s)| json!({ "need": need, "level": s.level, "cap": s.cap, "reorder": reorder(world, id, *need) })).collect::<Vec<_>>(),
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

    fn shelf(world: &World, id: EntityId, need: Need) -> crate::needs::Stock {
        building(world, id).stocks[&need]
    }

    fn take(world: &mut World, id: EntityId, need: Need, units: f64) {
        if let Some(GameObject::Building(b)) = world.objects.get_mut(id).map(|e| &mut e.object) {
            b.stocks.get_mut(&need).unwrap().take(units);
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
        take(&mut world, shop, Need::Eat, 30.0);
        let load = loaded(&mut world, depot, Need::Eat, 30.0, 0);
        delivered(&mut world, shop, Some(depot), Need::Eat, load, 0);
        assert_eq!(world.treasury, 100.0, "a delivery inside the town moved money");
        assert_eq!(shelf(&world, shop, Need::Eat).short(), 0.0, "the shelf is full");
        assert_eq!(shelf(&world, depot, Need::Eat).short(), 30.0, "the depot's shelf went down by the same");
        let crates = 30.0 * wholesale(Need::Eat);
        assert!((world.books[&shop].on(0).purchases - crates).abs() < 1e-9 && (world.books[&depot].on(0).revenue - crates).abs() < 1e-9, "the books disagree");
        // The lorry home from beyond the edge fills the shelf.
        delivered(&mut world, depot, None, Need::Eat, f64::INFINITY, 0);
        assert_eq!(shelf(&world, depot, Need::Eat).short(), 0.0, "the fetch did not fill the depot");
        assert!((100.0 - world.treasury - import(crates)).abs() < 1e-9, "the fetch cost {}", 100.0 - world.treasury);
        take(&mut world, shop, Need::Eat, 30.0);
        let before = world.treasury;
        delivered(&mut world, shop, None, Need::Eat, 30.0, 0);
        assert!((before - world.treasury - import(crates)).abs() < 1e-9, "from beyond the edge cost {}", before - world.treasury);
    }

    /// §4, services: an office's shift fills its shelf a unit an hour and
    /// sells nothing at the door; a home's stock is filled by the office's
    /// car at the office's price, two lines, or by a consultant from
    /// beyond the edge at the edge's price plus the crossing; and a load
    /// nobody in town bought goes out to the edge for its price less the
    /// crossing, GDP at the world's, and is no sale for the nudge.
    #[test]
    fn services_are_made_at_the_office_and_delivered_by_its_car() {
        let mut world = town();
        let home = world.place_on_street(at(4), House).unwrap();
        let office = world.place_on_street(at(20), Office).unwrap();
        world.settle();
        world.treasury = 100.0;
        let worker = world.resident_ids().into_iter().find(|&id| resident(&world, id).work == Some(office)).expect("the office hired");
        let day = shelf(&world, office, Need::Services).cap;
        assert_eq!(day, rated(Office, Need::Work), "the office's shelf is a day's make");
        assert!(sells(Office).eq([Need::Services]), "the office sells its services and nothing else");
        assert_eq!(building(&world, office).prices[&Need::Services], edge_price(Need::Services), "it opens at the edge's price");
        take(&mut world, office, Need::Services, day);
        sale(&mut world, worker, office, Need::Work, 9.0, 0);
        assert_eq!(shelf(&world, office, Need::Services).level, 9.0, "a shift made a unit an hour");
        assert_eq!((world.treasury, world.gdp), (100.0, 0.0), "the shift crossed the door, or counted before it was sold");

        let order = 5.0;
        take(&mut world, home, Need::Services, order);
        let load = loaded(&mut world, office, Need::Services, order, 0);
        delivered(&mut world, home, Some(office), Need::Services, load, 0);
        assert_eq!(world.treasury, 100.0, "a delivery inside the town moved money");
        assert_eq!(shelf(&world, home, Need::Services).short(), 0.0, "the home's stock is full again");
        let due = order * edge_price(Need::Services);
        assert!((world.books[&office].on(0).revenue - due).abs() < 1e-9 && (world.books[&home].on(0).purchases - due).abs() < 1e-9, "the books disagree");

        take(&mut world, home, Need::Services, order);
        delivered(&mut world, home, None, Need::Services, order, 0);
        assert!((100.0 - world.treasury - import(due)).abs() < 1e-9, "the consultant from the edge cost {}", 100.0 - world.treasury);

        let before = world.treasury;
        let left = shelf(&world, office, Need::Services).level;
        let load = shipped(&mut world, office, Need::Services);
        assert_eq!((load, shelf(&world, office, Need::Services).level), (left, 0.0), "the car took the whole shelf");
        assert!(!world.books[&office].on(0).sold_out && world.books[&office].on(0).sold.get(&Need::Services).copied().unwrap_or(0.0) == order, "a shipment counted as selling out");
        exported(&mut world, office, Need::Services, load, 0);
        assert!((world.treasury - before - export(load * edge_price(Need::Services))).abs() < 1e-9, "the edge paid {}", world.treasury - before);
        assert!((world.gdp - load * edge_price(Need::Services)).abs() < 1e-9, "what the town sold out is GDP at the world's price: {}", world.gdp);
    }

    /// §12.7 and §12.8, the farm: its crates are a depot's shelf — it
    /// opens at the crate's price and floors at what the edge pays — but
    /// a shift grows nothing in the yard, its land does: a tile cut lands
    /// its crop in the yard with no line and no money. A yard with no
    /// room for a crop offers no work; a lorry from beyond the edge takes
    /// the yard away at the crate's price less the crossing.
    #[test]
    fn a_farm_grows_on_its_land_and_sells_crates_like_a_depot() {
        let mut world = town();
        world.place_on_street(at(4), House).unwrap();
        let farm = world.place_on_street(at(8), Farm).unwrap();
        world.settle();
        world.treasury = 100.0;
        let hand = world.resident_ids().into_iter().find(|&id| resident(&world, id).work == Some(farm) && !world.edge.contains(&resident(&world, id).home)).expect("the farm hired next door");
        assert!(depot(Farm) && makes(Farm, Need::Eat) && sells(Farm).eq([Need::Eat]), "the farm is not a depot of crates");
        assert!(super::farm(Farm) && !super::farm(Office));
        assert!((crop(Farm) - 1944.0 / crate::world::fields::capacity(Farm)).abs() < 1e-9);
        assert_eq!(shelf(&world, farm, Need::Eat), crate::needs::Stock { level: 0.0, cap: rated(Farm, Need::Eat) }, "the yard is founded with a make, or is not a day's");
        assert_eq!(building(&world, farm).prices[&Need::Eat], wholesale(Need::Eat), "it opens at the crate's price");
        assert_eq!(unit_cost(Farm, Need::Eat), export(wholesale(Need::Eat)), "its floor is not what the edge pays");
        assert!(hiring(&world, farm), "an empty yard offers no work");
        sale(&mut world, hand, farm, Need::Work, 2.0, 0);
        assert_eq!(shelf(&world, farm, Need::Eat).level, 0.0, "a shift grew crates in the yard");
        assert!(!buys(Farm, Need::Eat) && !buys(Office, Need::Services) && buys(Shop, Need::Eat) && buys(Warehouse, Need::Eat) && buys(Shop, Need::Services), "the rows buy the wrong things");

        // A tile cut is a crop in the yard, and no line.
        harvested(&mut world, farm, crop(Farm));
        assert_eq!((shelf(&world, farm, Need::Eat).level, world.treasury, world.gdp), (crop(Farm), 100.0, 0.0), "the harvest moved money, or counted");
        assert!(world.books.get(&farm).is_none_or(|k| k.on(0).purchases == 0.0) && world.sales.is_empty(), "a harvest is a line");

        // A yard with no room for a crop offers no work, and a lorry
        // from beyond the edge takes it away.
        let yard = shelf(&world, farm, Need::Eat).cap;
        if let Some(GameObject::Building(b)) = world.objects.get_mut(farm).map(|e| &mut e.object) {
            b.stocks.get_mut(&Need::Eat).unwrap().level = yard - crop(Farm) / 2.0;
        }
        assert!(!hiring(&world, farm), "a full yard hires");
        let load = shipped(&mut world, farm, Need::Eat);
        exported(&mut world, farm, Need::Eat, load, 0);
        assert!((world.treasury - 100.0 - export(load * wholesale(Need::Eat))).abs() < 1e-9, "the edge paid {}", world.treasury - 100.0);
        assert!((world.gdp - load * wholesale(Need::Eat)).abs() < 1e-9, "crates sold out are GDP at the world's price");
        let shop = world.place_on_street(at(30), Shop).unwrap();
        assert!(hiring(&world, farm) && hiring(&world, shop), "an emptied yard, or a shop, does not hire");
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
        let factory = world.place_on_street(at(30), Factory).unwrap();
        let office = world.place_on_street(at(40), Office).unwrap();
        world.settle();
        let edge = *world.edge.iter().next().expect("the street runs off the map");
        let people = world.resident_ids();
        let local = *people.iter().find(|&&id| resident(&world, id).work == Some(shop)).expect("the shop hired next door");
        let commuter = *people.iter().find(|&&id| world.edge.contains(&resident(&world, id).home) && resident(&world, id).work == Some(factory)).expect("the factory hired from beyond the edge");

        sale(&mut world, local, shop, Need::Work, 9.0, 0);
        assert_eq!(world.treasury, STAKE, "a shift in town moved money");
        assert!((world.books[&shop].on(0).wages - 9.0 * resident(&world, local).wage).abs() < 1e-9);

        let pay = 9.0 * resident(&world, commuter).wage;
        assert!(pay > 9.0 * import(EDGE_WAGE), "a commuter is paid the crossing and the drive: {pay}");
        sale(&mut world, commuter, factory, Need::Work, 9.0, 0);
        let door = world.income.on(0).clone();
        assert!((door.revenue - export(adds(9.0 * EDGE_WAGE))).abs() < 1e-9, "the factory sold its hours for {}", door.revenue);
        assert!((door.purchases - pay).abs() < 1e-9, "the commuter took home {}", door.purchases);
        assert!((world.gdp - adds(9.0)).abs() < 1e-9, "hours made in town are GDP at the world's price: {}", world.gdp);

        let home_ask = ask(&world, resident(&world, local).home);
        if let Some(GameObject::Resident(r)) = world.objects.get_mut(local).map(|e| &mut e.object) {
            r.wage = home_ask;
        }
        let before = world.treasury;
        sale(&mut world, local, edge, Need::Work, 8.0, 0);
        assert!((world.treasury - before - export(8.0 * EDGE_WAGE)).abs() < 1e-9, "a shift beyond the edge brought {}", world.treasury - before);
        // An office's shift is made, not sold: it goes on the shelf.
        let (gdp, before) = (world.gdp, world.treasury);
        if let Some(GameObject::Building(b)) = world.objects.get_mut(office).map(|e| &mut e.object) {
            let s = b.stocks.get_mut(&Need::Services).unwrap();
            s.level = s.cap - 9.0;
        }
        sale(&mut world, local, office, Need::Work, 9.0, 0);
        assert_eq!((world.gdp, world.treasury), (gdp, before), "an office's shift was sold at the door");
        assert_eq!(shelf(&world, office, Need::Services).short(), 0.0, "and did not fill the shelf");

        let before = world.treasury;
        sale(&mut world, local, shop, Need::Eat, 1.0, 0);
        assert_eq!(world.treasury, before, "a meal in town moved money");
        sale(&mut world, commuter, shop, Need::Eat, 1.0, 0);
        assert!((world.treasury - before - price_of(&world, shop, Need::Eat)).abs() < 1e-9, "a commuter's lunch is an export");
        let before = world.treasury;
        sale(&mut world, local, edge, Need::Eat, 1.0, 0);
        assert!((before - world.treasury - edge_price(Need::Eat)).abs() < 1e-9, "a meal at the edge is an import");
    }

    /// §8.1, §11.9: the household row's inputs at the world's prices are
    /// nine tenths of what its labour sells for, so a household that
    /// works and consumes at the edge nets the town its saving less the
    /// crossing, which at a tenth each is nothing. And a firm's hour is
    /// worth its labour and the services behind it over two thirds, which
    /// is what a unit of services is.
    #[test]
    fn the_door_breaks_even_by_the_rows_arithmetic() {
        let inputs = 2.4 * edge_price(Need::Eat) + edge_price(Need::Leisure) + TRANSPORT + services();
        assert!((inputs - 8.0 * (1.0 - SAVING)).abs() < 1e-9, "the row draws {inputs}");
        assert!(services() > 8.0 / 3.0, "the table prices the rest of the row over a day's wage");
        let net = export(8.0 * EDGE_WAGE) - inputs;
        assert!(net.abs() < 8.0 * SAVING + 1e-9, "a commuter nets the town {net}");
        assert!((adds(2.0) - 3.0 * (1.0 + SERVICES)).abs() < 1e-9);
        assert_eq!(edge_price(Need::Services), adds(EDGE_WAGE));
        // §8.1, link by link: the crate is the farm hand's minutes over
        // two thirds, the meal the crate and the counter's over two
        // thirds, and the meal lands on the ladder's fifth of an hour.
        let crate_ = wholesale(Need::Eat);
        assert!((crate_ - adds(1.0 / 18.0)).abs() < 1e-9, "the crate is {crate_}");
        assert!((edge_price(Need::Eat) - (crate_ + COUNTER * (1.0 + SERVICES)) / (1.0 - CAPITAL)).abs() < 1e-9);
        assert!((edge_price(Need::Eat) - 0.2).abs() < 0.01, "a meal is {}", edge_price(Need::Eat));
        assert!((crate_ - 0.1).abs() < 0.01, "a crate is {crate_}");
        // No row in town yet: the tank's delivery is the authored half.
        assert_eq!(wholesale(Need::Fuel), WHOLESALE * edge_price(Need::Fuel));
        // A head's day of services, a house's week of them, a desk's hour.
        assert!((draw(House) - 2.0 * services() / edge_price(Need::Services)).abs() < 1e-9);
        assert!((stocks(House)[&Need::Services] - SERVICES_COVER * draw(House)).abs() < 1e-9);
        assert!((draw(Factory) - 12.0 * 9.0 * SERVICES / edge_price(Need::Services)).abs() < 1e-9);
        assert!(stocks(Edge).is_empty(), "the edge keeps stock");
    }

    /// §10: GDP is value served in town at the world's prices, whatever
    /// the town charged; labour counts inside what it makes; a night is
    /// the household's services, drawn from its stock once a head at
    /// midnight, and nothing crosses the door for it then. A firm's draw
    /// is a line, not GDP. An empty stock serves nothing.
    #[test]
    fn gdp_is_value_at_the_worlds_prices() {
        assert_eq!(value(Shop, Need::Eat), edge_price(Need::Eat));
        assert_eq!(value(Warehouse, Need::Eat), wholesale(Need::Eat));
        assert_eq!((value(Shop, Need::Work), value(House, Need::Rest), value(House, Need::Home)), (0.0, 0.0, 0.0));
        let mut world = town();
        let home = world.place_on_street(at(4), House).unwrap();
        let shop = world.place_on_street(at(8), Shop).unwrap();
        world.settle();
        world.treasury = 15.0;
        let heads = world.resident_ids().len() as f64;
        let two_days = shelf(&world, home, Need::Services).cap;
        // The first look starts the clock; a day later, a day is drawn.
        for id in [home, shop] {
            passed(&mut world, id, 0);
        }
        assert_eq!((world.gdp, shelf(&world, home, Need::Services).level), (0.0, two_days), "the first look drew");
        for id in [home, shop] {
            passed(&mut world, id, DAY_MS as u64);
        }
        assert!((world.gdp - heads * services()).abs() < 1e-9, "{heads} nights served: {}", world.gdp);
        assert_eq!(world.treasury, 15.0, "the night crossed the door");
        assert!((two_days - shelf(&world, home, Need::Services).level - heads * services() / edge_price(Need::Services)).abs() < 1e-9, "the home drew {}", two_days - shelf(&world, home, Need::Services).level);
        assert!((stocks(Shop)[&Need::Services] - shelf(&world, shop, Need::Services).level - draw(Shop)).abs() < 1e-9, "the shop drew its row's");
        take(&mut world, home, Need::Services, two_days);
        passed(&mut world, home, 2 * DAY_MS as u64);
        assert!((world.gdp - heads * services()).abs() < 1e-9, "a night with nothing in the stock was served");
    }

    /// §12.6: a depot's van is filled and put right in the yard, and the
    /// depot buys what the trip used from beyond the edge, at wholesale
    /// plus the crossing; a consultant's car from the edge is never in
    /// anyone's yard, and costs the town nothing but its call.
    #[test]
    fn a_fleet_vehicle_is_refilled_in_the_yard() {
        let mut world = town();
        let depot = world.place_on_street(at(20), Warehouse).unwrap();
        crate::calls::stable(&mut world, depot);
        let van = world.objects.iter().find(|e| matches!(e.object, GameObject::Car(ref c) if c.owner == depot)).map(|e| e.id).expect("a van in the yard");
        world.treasury = 100.0;
        crate::resident::drove(&mut world, van, 250.0);
        let tanks = 250.0 / Need::Fuel.tiles();
        let services = 250.0 / Need::Wear.tiles();
        refilled(&mut world, van, 0);
        let fuel = match world.objects.get(van).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.stocks.clone(),
            _ => unreachable!(),
        };
        assert!(fuel.values().all(|s| s.level == s.cap), "the yard did not fill it");
        let cost = import(tanks * wholesale(Need::Fuel) + services * wholesale(Need::Wear));
        assert!((100.0 - world.treasury - cost).abs() < 1e-9, "the fill cost {}", 100.0 - world.treasury);
        assert!((world.books[&depot].on(0).purchases - cost).abs() < 1e-9, "the depot's books say {}", world.books[&depot].on(0).purchases);
        assert_eq!(world.gdp, 0.0, "a fleet's fuel is not a need served");
        refilled(&mut world, van, 0);
        assert!((100.0 - world.treasury - cost).abs() < 1e-9, "a full van was charged");
    }

    /// A shelf that reorders before it is full never stops ordering: every
    /// kind's shelf holds more than its taps could sell while a lorry is
    /// away beyond the edge with the lot full, which is where a fresh
    /// building's reorder point stands.
    #[test]
    fn every_shelf_is_bigger_than_its_reorder_point() {
        let mut world = town();
        let mut x = 4;
        for kind in BuildingKind::ALL {
            if blueprint(kind).stock == 0 || !blueprint(kind).price.is_finite() {
                continue;
            }
            let b = world.place_on_street(at(x), kind).unwrap();
            x += 8;
            let need = shelf_need(kind);
            let s = reorder(&world, b, need);
            assert!(s < blueprint(kind).stock as f64, "{kind:?} reorders {need:?} at {s} with a shelf of {}", blueprint(kind).stock);
        }
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
        let s = reorder(&world, shop, Need::Eat);
        assert!((s - (a_day * crate::calls::AWAY_MS as f64 / DAY_MS as f64 + seats)).abs() < 1e-9, "{s}");
        world.books.entry(shop).or_default().lead = Some(0);
        assert_eq!(reorder(&world, shop, Need::Eat), seats, "a depot next door leaves the full house");
        assert_eq!(reorder(&world, shop, Need::Services), 0.0, "an office next door leaves nothing to cover");
        world.books.entry(shop).or_default().lead = Some(DAY_MS as GameTime);
        assert!((reorder(&world, shop, Need::Services) - draw(Shop)).abs() < 1e-9, "a day's lead asks for a day's draw");
        world.books.entry(shop).or_default().lead = Some(DAY_MS as GameTime);
        assert!(reorder(&world, shop, Need::Eat) > blueprint(Shop).stock as f64, "a day's lead asks for more than the shelf holds");
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
        // A home in its household's shifts, a pass-through in its hours.
        let home = world.place_on_street(at(8), House).unwrap();
        assert!((earns(&world, home, 0) - 2.0 * SHIFT / 24.0).abs() < 1e-9);
        let factory = world.place_on_street(at(12), Factory).unwrap();
        assert!((earns(&world, factory, 0) - adds(12.0 * 9.0) / 24.0).abs() < 1e-9);
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
        take(&mut world, depot, Need::Eat, 230.0);
        take(&mut world, shop, Need::Eat, 30.0);
        let load = loaded(&mut world, depot, Need::Eat, 30.0, 1);
        assert_eq!((load, shelf(&world, depot, Need::Eat).level), (10.0, 0.0), "the van loaded more than the shelf had");
        delivered(&mut world, shop, Some(depot), Need::Eat, load, 1);
        assert_eq!(shelf(&world, shop, Need::Eat).level, 20.0);
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
