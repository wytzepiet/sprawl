//! Stocks, and the border, as docs/trade.md lays it out. Inside a town
//! nothing has a price: a good is a load on a shelf, a buyer takes the
//! nearest seller with stock, by road (`calls`), and a visit draws the
//! shelf it was served from. Coins are what trade across the border is
//! priced in, and only that: they move when goods cross it, in when the
//! town sells to the world and out when it buys, and a placement is
//! materials bought in. The treasury is the town's balance of trade.
//!
//! The level is hours of need served in town, banked as each visit is
//! had: the shifts worked, the meals and the tanks.
//!
//! What is a number lives here, with the referent that set it. What is a
//! verb — settling a visit, finding a seller — lives with the code that
//! does it, and takes its numbers from here.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::blueprint::blueprint;
use crate::engine::GameTime;
use crate::needs::{Need, Tap};
use crate::protocol::{BuildingKind, EntityId, GameObject, Growth, Sale, DAY_MS};
use crate::world::World;

pub const HOUR: f64 = DAY_MS as f64 / 24.0;

/// What the world beyond the border reckons a unit of a good is worth,
/// in coins: a crate, a tank. The numbers are what the price economy's
/// wholesale came to (shelved.md, the price economy): a crate a farm
/// hand's few minutes, a tank half its price at the pump. trade.md §Open
/// 7 leaves the world's prices open; these hold the place.
pub fn world_price(good: Need) -> f64 {
    match good {
        Need::Eat => 0.1,
        Need::Fuel => 1.5,
        Need::Home | Need::Work | Need::Rest => 0.0,
    }
}

/// The world sells at its price and this much over, and buys at its
/// price and this much under: the premium and the discount of trade.md,
/// a tenth each way, the low end of what trade costs between a region
/// and its towns. A town that sells to the world never gets what it pays
/// for the same load.
pub const MARGIN: f64 = 0.1;
/// What the town pays the world for `units` of a good.
pub fn import(good: Need, units: f64) -> f64 {
    units * world_price(good) * (1.0 + MARGIN)
}
/// What the world pays the town for `units` of a good.
pub fn export(good: Need, units: f64) -> f64 {
    units * world_price(good) * (1.0 - MARGIN)
}

/// What the mayor founds the town with: a few weeks of the starting
/// town's imports, so it can buy fuel and crates until it has something
/// to sell. A treasury at zero cannot import fuel, and a town without
/// fuel cannot work, which is a trap a fresh town must not start in.
pub const STAKE: f64 = 500.0;

/// Hours of the shift a kind's row posts.
pub fn shift_hours(kind: BuildingKind) -> f64 {
    blueprint(kind).taps.iter().find(|t| t.need == Need::Work).map_or(0.0, |t| t.curve.per_day() / HOUR)
}

/// The stocks a kind holds, and their caps: its shelf, if the row keeps
/// one. §4.
pub fn stocks(kind: BuildingKind) -> BTreeMap<Need, f64> {
    let bp = blueprint(kind);
    shelves(kind).into_iter().map(|need| (need, bp.stock as f64)).collect()
}

/// Units of a need a kind could serve in a day with every slot busy: what
/// its shelf is drawn down at, at most. A depot's shelf has no tap; what
/// it could deliver in a day is the shelf, turned once.
pub fn rated(kind: BuildingKind, need: Need) -> f64 {
    let bp = blueprint(kind);
    let over_the_counter: f64 = bp.taps.iter().filter(|t| t.need == need).map(Tap::rated).sum();
    over_the_counter + if depot(kind) && shelves(kind).contains(&need) { bp.stock as f64 } else { 0.0 }
}

/// The goods a kind keeps a shelf of, each of the row's size: what its
/// land grows; or every good of the class it handles, a depot's boxes;
/// or what its taps serve — fuel where it pumps, food everywhere else
/// that keeps a shelf. None for a row without one. §4.
pub fn shelves(kind: BuildingKind) -> Vec<Need> {
    let bp = blueprint(kind);
    if bp.stock == 0 {
        return Vec::new();
    }
    match (bp.makes, bp.handles) {
        (Some(m), _) => vec![m],
        (None, Some(class)) => Need::ALL.into_iter().filter(|n| n.cargo() == Some(class)).collect(),
        (None, None) => vec![bp.taps.iter().map(|t| t.need).find(|n| Need::DRIVEN.contains(n)).unwrap_or(Need::Eat)],
    }
}

/// The world's ship fills its shelves at the quay behind it
/// (`world/sea.rs`).
pub fn ships(kind: BuildingKind) -> bool {
    blueprint(kind).quay
}

/// A seller in town whose shelf is filled without a fetch from town: a
/// maker's yard, its land's; or a port's quay, the world's ship's. What a
/// depot's lorry may fetch from, so that a warehouse never fetches from
/// a warehouse, round and round for nothing. §7.
pub fn source(kind: BuildingKind, need: Need) -> bool {
    makes(kind, need) || (ships(kind) && shelves(kind).contains(&need))
}

/// Its land fills its shelf with this: it never calls for it, and what
/// nobody in town takes goes to the world.
pub fn makes(kind: BuildingKind, need: Need) -> bool {
    blueprint(kind).makes == Some(need)
}

/// What lands on a maker's shelf at once: a tile's crop, at the least a
/// farm's land comes to. A shelf with less room than this calls for
/// pickup before the load is lost to it (`calls::turn`), and offers no
/// work meanwhile (`hiring`).
pub fn lump(kind: BuildingKind) -> f64 {
    if farm(kind) { crop(kind, crate::world::fields::capacity(kind) as usize) } else { 0.0 }
}

/// Works land with a tractor. §12.8.
pub fn farm(kind: BuildingKind) -> bool {
    blueprint(kind).farm
}

/// What one tile of a farm's land grows in a cycle: the yard, a
/// harvest, over the tiles the farm has, so a harvest fills the yard
/// whatever ground the farm got. A farm on cramped ground has fewer
/// tiles and a longer wait between runs, not a smaller harvest.
pub fn crop(kind: BuildingKind, tiles: usize) -> f64 {
    blueprint(kind).stock as f64 / tiles.max(1) as f64
}

/// The tractor cut a tile: its crop lands in the yard. §12.8.
pub fn harvested(world: &mut World, farm: EntityId, load: f64) {
    let Some(GameObject::Building(b)) = world.objects.get_mut(farm).map(|e| &mut e.object) else { return };
    if let Some(good) = blueprint(b.kind).makes
        && let Some(yard) = b.stocks.get_mut(&good)
    {
        yard.add(load);
    }
}

/// A row calls only for what it keeps: the shelf its counter serves from
/// or its vans deliver, unless its own land fills it.
pub fn buys(kind: BuildingKind, need: Need) -> bool {
    !makes(kind, need) && shelves(kind).contains(&need) && (blueprint(kind).taps.iter().any(|t| t.need == need) || depot(kind))
}

/// Does a maker's shelf have room for the next load? One with none
/// offers no work: a full yard stops the line (§4). Everything else
/// always hires.
pub fn hiring(world: &World, building: EntityId) -> bool {
    let Some(GameObject::Building(b)) = world.objects.get(building).map(|e| &e.object) else { return false };
    match blueprint(b.kind).makes {
        Some(good) => b.stocks.get(&good).is_none_or(|s| s.short() >= lump(b.kind)),
        None => true,
    }
}

/// Keeps a shelf and runs vehicles: delivers its shelf, answering the
/// calls of stocks running low with a van of its own.
pub fn depot(kind: BuildingKind) -> bool {
    let bp = blueprint(kind);
    bp.stock > 0 && !bp.vehicles.is_empty()
}

/// What one of a kind costs the mayor: the row's price, with the build's
/// discount on its class. Paid to the world: the materials are bought in.
pub fn price(world: &World, kind: BuildingKind) -> f64 {
    let b = blueprint(kind);
    b.price / world.build.weight(b.class)
}

/// How many tiles the smallest of a kind is: its price is shared over
/// them, a tile paid for as it is painted.
pub fn tiles(kind: BuildingKind) -> f64 {
    let (w, h) = crate::blueprint::plot(kind, 0).size;
    (w as u32 * h as u32) as f64
}

/// A building saved before it had a stock gets it the way a placed one
/// does; one whose row changed a stock gets the new one, full.
pub fn open(world: &mut World, id: EntityId) {
    let Some(GameObject::Building(b)) = world.objects.get_mut(id).map(|e| &mut e.object) else { return };
    let fresh = crate::protocol::Building::new(b.kind, b.tiles.clone(), b.facing);
    b.stocks.retain(|need, stock| fresh.stocks.get(need).is_some_and(|f| f.cap == stock.cap));
    for (need, stock) in fresh.stocks {
        b.stocks.entry(need).or_insert(stock);
    }
}

/// The reorder point: the `s` of the `(s, S)` policy of every inventory
/// textbook, with the stock's cap as `S`. Expected use over the lead
/// time — what the taps could serve in the time the last delivery took —
/// plus a margin, which is a full house: everyone the taps seat at once,
/// so a rush during the lead does not empty the shelf. Until a building
/// has had a delivery, one is assumed to take as long as a lorry is away
/// beyond the edge. §6.2.
pub fn reorder(world: &World, building: EntityId, need: Need) -> f64 {
    let Some(kind) = kind_of(world, building) else { return 0.0 };
    let lead = world.books.get(&building).and_then(|k| k.lead).unwrap_or(crate::calls::AWAY_MS);
    // A full house is everyone the taps seat at once: two bays with seven
    // cars at the door is a rush of seven.
    let seats: u32 = blueprint(kind).taps.iter().filter(|t| t.need == need).map(|t| crate::blueprint::seats(kind, t)).sum();
    rated(kind, need) * lead as f64 / DAY_MS as f64 + seats as f64
}

/// Coins crossing the border at a building, for a good: in when the town
/// sold, out when it bought. Money out stops at nothing: an import the
/// treasury cannot pay for is paid as far as it goes. A lump on the map
/// where it landed, and a line on the town's page.
fn door(world: &mut World, at: EntityId, good: Need, amount: f64, now: GameTime) {
    let amount = amount.max(-world.treasury);
    let page = world.town.today(now);
    if amount >= 0.0 {
        *page.sold.entry(good).or_default() += amount;
    } else {
        *page.bought.entry(good).or_default() -= amount;
    }
    world.treasury += amount;
    if amount != 0.0 {
        world.sales.push(Sale { building: at, amount, at: now });
    }
}

/// Hours of a need served in town, at a building that is not a home: a
/// line on the building's page and the town's, and the level's running
/// sum.
pub fn served(world: &mut World, at: EntityId, need: Need, hours: f64, now: GameTime) {
    *world.books.entry(at).or_default().today(now).served.entry(need).or_default() += hours;
    if kind_of(world, at).is_some_and(|k| blueprint(k).homes == 0) && hours > 0.0 {
        world.served += hours;
        *world.town.today(now).served.entry(need).or_default() += hours;
    }
}

/// The mayor placed something: its materials are bought from the world,
/// paid in full. §10.
pub fn built(world: &mut World, price: f64, now: GameTime) {
    world.town.today(now).built += price;
    world.treasury -= price;
}

/// A visit is over: `units` of `need` served at `at` come off the shelf
/// they were served from, if it keeps one. A home's kitchen keeps none.
pub fn drawn(world: &mut World, at: EntityId, need: Need, units: f64) {
    if let Some(GameObject::Building(b)) = world.objects.get_mut(at).map(|e| &mut e.object)
        && let Some(stock) = b.stocks.get_mut(&need)
    {
        stock.take(units);
    }
}

/// A van loads at a depot: as much of the order as the shelf has. §7.
pub fn loaded(world: &mut World, depot: EntityId, need: Need, order: f64) -> f64 {
    let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) else { return 0.0 };
    let Some(stock) = b.stocks.get_mut(&need) else { return 0.0 };
    let load = order.min(stock.level);
    stock.take(load);
    load
}

/// A lorry from beyond the edge loads at a maker's yard for the world:
/// the whole shelf, since the world takes anything. Paid when it has
/// left (`exported`).
pub fn shipped(world: &mut World, maker: EntityId, need: Need) -> f64 {
    let Some(GameObject::Building(b)) = world.objects.get_mut(maker).map(|e| &mut e.object) else { return 0.0 };
    let Some(stock) = b.stocks.get_mut(&need) else { return 0.0 };
    std::mem::replace(&mut stock.level, 0.0)
}

/// A load left the map for the world: the town sold it, at the world's
/// price less the margin.
pub fn exported(world: &mut World, maker: EntityId, need: Need, load: f64, now: GameTime) {
    door(world, maker, need, export(need, load), now);
}

/// A facility's vehicle is home: its tank is filled in the yard, bought
/// from the world, as the depot's fuel is until something in town
/// delivers it. Nobody sits in a fleet vehicle, so nobody weighs its
/// tank; the building's turn does, when it comes home.
pub fn refilled(world: &mut World, car: EntityId, now: GameTime) {
    let Some(GameObject::Car(c)) = world.objects.get_mut(car).map(|e| &mut e.object) else { return };
    let owner = c.owner;
    let mut due = Vec::new();
    for (&need, stock) in c.stocks.iter_mut() {
        due.push((need, import(need, stock.short() / stock.cap)));
        stock.level = stock.cap;
    }
    if kind_of(world, owner).is_none() {
        return;
    }
    for (need, due) in due.into_iter().filter(|&(_, due)| due > 0.0) {
        door(world, owner, need, -due, now);
    }
}

/// A delivery landed: `load` of `need` onto `buyer`'s stock, from a
/// seller in town, which moves nothing, or from the world, which the
/// town pays for as far as the treasury goes. A lorry home from a fetch
/// beyond the edge lands a load without limit: the shelf fills. §7.
pub fn delivered(world: &mut World, buyer: EntityId, from_world: bool, need: Need, load: f64, now: GameTime) {
    let Some(GameObject::Building(b)) = world.objects.get_mut(buyer).map(|e| &mut e.object) else { return };
    let Some(stock) = b.stocks.get_mut(&need) else { return };
    let units = load.min(stock.short());
    if units <= 0.0 {
        return;
    }
    stock.add(units);
    if from_world {
        door(world, buyer, need, -import(need, units), now);
    }
}

fn kind_of(world: &World, building: EntityId) -> Option<BuildingKind> {
    match world.objects.get(building)?.object {
        GameObject::Building(ref b) => Some(b.kind),
        _ => None,
    }
}

/// One day of a building's books: hours of need served, per tap — for a
/// workplace, labour received.
#[derive(Debug, Default, Clone)]
pub struct Day {
    pub served: BTreeMap<Need, f64>,
}

/// One day of the town's books: hours served in town, per need, which
/// add up to the level's step; and what crossed the border, per good, in
/// and out, and what the mayor built, which add up to the treasury's
/// step. §10.
#[derive(Debug, Default, Clone)]
pub struct Town {
    pub served: BTreeMap<Need, f64>,
    pub sold: BTreeMap<Need, f64>,
    pub bought: BTreeMap<Need, f64>,
    pub built: f64,
}

impl Town {
    pub fn revenue(&self) -> f64 {
        self.sold.values().sum()
    }
    pub fn purchases(&self) -> f64 {
        self.bought.values().sum()
    }
}

/// How many pages the books keep: a season, the span the questions a
/// card answers are asked over. §10.
pub const SEASON: usize = 30;

/// A season of pages, one a day, written over in a circle. Learned, not
/// saved — a loaded world starts counting afresh.
#[derive(Debug, Clone)]
pub struct Books<P = Day> {
    /// The day the last page written is for, and the first day written.
    pub day: u64,
    opened: u64,
    pages: Vec<P>,
    /// A day nothing was written on.
    blank: P,
    /// How long the last delivery took, from the call to the load
    /// landing: the lead time the reorder point covers. None until there
    /// has been one.
    pub lead: Option<GameTime>,
}

impl<P: Default> Default for Books<P> {
    fn default() -> Self {
        Books { day: 0, opened: u64::MAX, pages: std::iter::repeat_with(P::default).take(SEASON).collect(), blank: P::default(), lead: None }
    }
}

impl<P: Default> Books<P> {
    /// Today's page, turning it if the day has moved on. The days skipped
    /// are days nothing was written on.
    pub fn today(&mut self, now: GameTime) -> &mut P {
        let day = now / DAY_MS as u64;
        for d in (self.day + 1).max(day.saturating_sub(SEASON as u64 - 1))..=day {
            self.pages[d as usize % SEASON] = P::default();
        }
        self.day = self.day.max(day);
        self.opened = self.opened.min(day);
        &mut self.pages[day as usize % SEASON]
    }

    /// Today's page as it stands, without turning it.
    pub fn on(&self, now: GameTime) -> &P {
        self.page(now / DAY_MS as u64)
    }

    /// The last whole day's page: yesterday's, as of `now`. The first day
    /// has none.
    pub fn before(&self, now: GameTime) -> &P {
        (now / DAY_MS as u64).checked_sub(1).map_or(&self.blank, |day| self.page(day))
    }

    /// The page for a day, by the calendar: a day nothing was written on
    /// is blank, however long ago the last entry was.
    fn page(&self, day: u64) -> &P {
        if day <= self.day && self.day - day < SEASON as u64 { &self.pages[day as usize % SEASON] } else { &self.blank }
    }

    /// Every page since the books were opened, oldest first, today's last.
    pub fn season(&self) -> impl Iterator<Item = &P> {
        (self.opened.max(self.day.saturating_sub(SEASON as u64 - 1))..=self.day).map(|d| self.page(d))
    }
}

/// Hours served for the first level. Each one after costs a level more
/// than the last. Six is a little under a shift: one resident's first
/// day at work is a level, as it was when the level counted value.
const LEVEL_BASE: f64 = 6.0;

/// The city's level from its hours served to date, and what it took to
/// reach it.
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
    let town = world.town.on(now);
    Growth {
        level,
        toward: world.served - reached,
        needed: LEVEL_BASE * (level as f64 + 1.0),
        served: town.served.values().sum(),
        treasury: world.treasury,
        income: town.revenue() - town.purchases() - town.built,
        imports: town.purchases(),
        taken: world.build.taken(),
        road_tiles_left: world.build.road_tiles().saturating_sub(world.laid),
    }
}

/// The town's page: what it served today and what crossed the border,
/// and the season behind it. Each line is the level's step or the
/// treasury's read back by need or by good. §10.
pub fn town(world: &World, now: GameTime) -> Value {
    let page = |t: &Town| json!({ "served": t.served, "sold": t.sold, "bought": t.bought, "built": t.built });
    json!({
        "served": world.served,
        "treasury": world.treasury,
        "today": page(world.town.on(now)),
        "season": world.town.season().map(page).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use BuildingKind::*;

    #[test]
    fn the_books_turn_a_page_at_midnight() {
        let day = DAY_MS as u64;
        let mut b: Books<Town> = Books::default();
        b.today(100).built += 3.0;
        assert_eq!(b.on(100).built, 3.0);
        b.today(day + 5).built += 1.0;
        assert_eq!((b.before(day + 5).built, b.on(day + 5).built), (3.0, 1.0));
        // A day skipped is a day with nothing in it.
        b.today(3 * day);
        assert_eq!(b.before(3 * day).built, 0.0);
        // And the first day has no yesterday at all.
        assert_eq!(Books::<Town>::default().before(100).built, 0.0);
        // The season is every page since the books were opened, and no
        // more than thirty: the first page is written over by the
        // thirty-first, and a day before the season is blank.
        assert_eq!(b.season().map(|p| p.built).collect::<Vec<_>>(), vec![3.0, 1.0, 0.0, 0.0]);
        b.today(SEASON as u64 * day).built += 5.0;
        assert_eq!(b.season().count(), SEASON);
        assert_eq!((b.season().next().unwrap().built, b.on(0).built), (1.0, 0.0));
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

    /// A delivery from a depot in town moves no money; what the town pays
    /// is the depot's fetch from the world, at the world's price and the
    /// margin, which is what a delivery straight from the world costs too.
    /// Each lands as a lump on the building it crossed the border at.
    #[test]
    fn only_what_crosses_the_border_is_paid_for() {
        let mut world = town();
        let shop = world.place_on_street(at(4), Shop).unwrap();
        let depot = world.place_on_street(at(20), Warehouse).unwrap();
        world.treasury = 100.0;
        take(&mut world, shop, Need::Eat, 30.0);
        let load = loaded(&mut world, depot, Need::Eat, 30.0);
        delivered(&mut world, shop, false, Need::Eat, load, 0);
        assert_eq!(world.treasury, 100.0, "a delivery inside the town moved money");
        assert!(world.sales.is_empty(), "a delivery inside the town landed coins");
        assert_eq!(shelf(&world, shop, Need::Eat).short(), 0.0, "the shelf is full");
        assert_eq!(shelf(&world, depot, Need::Eat).short(), 30.0, "the depot's shelf went down by the same");
        // The lorry home from beyond the edge fills the shelf.
        delivered(&mut world, depot, true, Need::Eat, f64::INFINITY, 0);
        assert_eq!(shelf(&world, depot, Need::Eat).short(), 0.0, "the fetch did not fill the depot");
        assert!((100.0 - world.treasury - import(Need::Eat, 30.0)).abs() < 1e-9, "the fetch cost {}", 100.0 - world.treasury);
        assert!(matches!(world.sales[..], [Sale { building, amount, .. }] if building == depot && amount < 0.0), "no lump at the depot");
        assert!((world.town.on(0).bought[&Need::Eat] - import(Need::Eat, 30.0)).abs() < 1e-9, "the town's page");
        take(&mut world, shop, Need::Eat, 30.0);
        let before = world.treasury;
        delivered(&mut world, shop, true, Need::Eat, 30.0, 0);
        assert!((before - world.treasury - import(Need::Eat, 30.0)).abs() < 1e-9, "from the world cost {}", before - world.treasury);
        // The world buys for less than it sells.
        assert!(export(Need::Eat, 1.0) < world_price(Need::Eat) && world_price(Need::Eat) < import(Need::Eat, 1.0));
        // Nothing goes under zero: an import the town cannot pay for is
        // paid as far as it goes.
        world.treasury = 1.0;
        take(&mut world, shop, Need::Eat, 30.0);
        delivered(&mut world, shop, true, Need::Eat, 30.0, 0);
        assert_eq!(world.treasury, 0.0);
    }

    /// The farm: a tile cut lands its crop in the yard, and no money; a
    /// yard with no room for a crop offers no work; a lorry from beyond
    /// the edge takes the yard away, paid at the world's price less the
    /// margin.
    #[test]
    fn a_farm_grows_on_its_land_and_the_world_takes_the_rest() {
        let mut world = town();
        world.place_on_street(at(4), House).unwrap();
        let farm = world.place_on_street(at(8), Farm).unwrap();
        world.settle();
        world.treasury = 100.0;
        assert!(depot(Farm) && makes(Farm, Need::Eat) && shelves(Farm) == [Need::Eat], "the farm is not a depot of crates");
        assert!(super::farm(Farm) && !super::farm(Office));
        assert!((crop(Farm, 200) - 1944.0 / 200.0).abs() < 1e-9 && (lump(Farm) - 1944.0 / crate::world::fields::capacity(Farm)).abs() < 1e-9);
        assert_eq!(shelf(&world, farm, Need::Eat).level, 0.0, "the yard is founded with a harvest");
        assert!(hiring(&world, farm), "an empty yard offers no work");
        assert!(!buys(Farm, Need::Eat) && buys(Shop, Need::Eat) && buys(Warehouse, Need::Eat) && !buys(House, Need::Eat), "the rows buy the wrong things");

        harvested(&mut world, farm, crop(Farm, 200));
        assert_eq!((shelf(&world, farm, Need::Eat).level, world.treasury), (crop(Farm, 200), 100.0), "the harvest moved money");

        let yard = shelf(&world, farm, Need::Eat).cap;
        if let Some(GameObject::Building(b)) = world.objects.get_mut(farm).map(|e| &mut e.object) {
            b.stocks.get_mut(&Need::Eat).unwrap().level = yard - lump(Farm) / 2.0;
        }
        assert!(!hiring(&world, farm), "a full yard hires");
        let load = shipped(&mut world, farm, Need::Eat);
        exported(&mut world, farm, Need::Eat, load, 0);
        assert!((world.treasury - 100.0 - export(Need::Eat, load)).abs() < 1e-9, "the world paid {}", world.treasury - 100.0);
        assert!(hiring(&world, farm), "an emptied yard does not hire");
    }

    /// A visit draws the shelf it was served from and moves no money; a
    /// home's kitchen keeps no shelf.
    #[test]
    fn a_visit_draws_the_shelf_and_moves_no_money() {
        let mut world = town();
        let home = world.place_on_street(at(4), House).unwrap();
        let shop = world.place_on_street(at(8), Shop).unwrap();
        drawn(&mut world, shop, Need::Eat, 3.0);
        drawn(&mut world, home, Need::Eat, 3.0);
        assert_eq!(shelf(&world, shop, Need::Eat).short(), 3.0);
        assert!(building(&world, home).stocks.is_empty(), "a home keeps a shelf");
        assert_eq!(world.treasury, STAKE, "a visit moved money");
        // Hours served at the shop are the level's; at home, not.
        served(&mut world, shop, Need::Eat, 2.0, 0);
        served(&mut world, home, Need::Eat, 2.0, 0);
        assert_eq!((world.served, world.town.on(0).served[&Need::Eat]), (2.0, 2.0));
        assert_eq!(world.books[&home].on(0).served[&Need::Eat], 2.0, "the home's card lost its hours");
    }

    /// A depot's van is filled in the yard, and the depot buys what the
    /// trip used from the world.
    #[test]
    fn a_fleet_vehicle_is_refilled_in_the_yard() {
        let mut world = town();
        let depot = world.place_on_street(at(20), Warehouse).unwrap();
        crate::calls::stable(&mut world, depot);
        let van = world.objects.iter().find(|e| matches!(e.object, GameObject::Car(ref c) if c.owner == depot)).map(|e| e.id).expect("a van in the yard");
        world.treasury = 100.0;
        crate::resident::drove(&mut world, van, 250.0);
        refilled(&mut world, van, 0);
        let full = match world.objects.get(van).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.stocks.values().all(|s| s.level == s.cap),
            _ => unreachable!(),
        };
        assert!(full, "the yard did not fill it");
        let cost = import(Need::Fuel, 250.0 / Need::Fuel.tiles());
        assert!((100.0 - world.treasury - cost).abs() < 1e-9, "the fill cost {}", 100.0 - world.treasury);
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
            if blueprint(kind).stock == 0 || !blueprint(kind).price.is_finite() || blueprint(kind).quay {
                continue;
            }
            let b = world.place_on_street(at(x), kind).unwrap();
            x += 8;
            for need in shelves(kind) {
                let s = reorder(&world, b, need);
                assert!(s < blueprint(kind).stock as f64, "{kind:?} reorders {need:?} at {s} with a shelf of {}", blueprint(kind).stock);
            }
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
        world.books.entry(shop).or_default().lead = Some(DAY_MS as GameTime);
        assert!(reorder(&world, shop, Need::Eat) > blueprint(Shop).stock as f64, "a day's lead asks for more than the shelf holds");
    }

    #[test]
    fn levels_come_a_little_further_apart_each_time() {
        assert_eq!(level(0.0), (0, 0.0));
        assert_eq!(level(LEVEL_BASE), (1, LEVEL_BASE));
        assert_eq!(level(3.0 * LEVEL_BASE - 0.1).0, 1);
        assert_eq!(level(3.0 * LEVEL_BASE), (2, 3.0 * LEVEL_BASE));
    }
}
