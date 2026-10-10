//! Stocks, and the border, as docs/trade.md lays it out. Inside a town
//! nothing has a price: a good is a load on a shelf, a buyer takes the
//! nearest seller with stock, by road (`calls`), and a visit draws the
//! shelf it was served from. Coins are what trade across the border is
//! priced in, and only that: they move when goods cross it, in when the
//! town sells to the world and out when it buys, and a placement is
//! materials bought in. The treasury is the town's balance of trade.
//!
//! The level is GDP to date: the value the town adds, counted once,
//! where and when it appears on the map. A crop is worth the world's
//! price as it is cut; a meal or a tank served is worth the counter's
//! price less the crate or the fuel it used, whoever made that; an hour
//! at a desk that sells no good is worth what it costs, a wage, the way
//! statisticians count government work. Imports add nothing; exports add
//! nothing again, having counted when they were made. Coins and GDP are
//! different numbers: the treasury is the balance of trade, and what the
//! town makes for itself raises GDP and moves no coin.
//!
//! What is a number lives here, with the referent that set it. What is a
//! verb — settling a visit, finding a seller — lives with the code that
//! does it, and takes its numbers from here.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::blueprint::blueprint;
use crate::engine::GameTime;
use crate::needs::{Need, Stock, Tap};
use crate::protocol::{BuildingKind, EntityId, GameObject, Good, Growth, Lump, DAY_MS};
use crate::world::World;

pub const HOUR: f64 = DAY_MS as f64 / 24.0;

/// What the world beyond the border reckons a unit of a good is worth,
/// in coins. A crate is a farm hand's few minutes and a tank half its
/// price at the pump, what the price economy's wholesale came to
/// (shelved.md, the price economy); timber is a coin a unit, so a house's
/// four is about what a house cost the mayor when it cost coins. trade.md
/// §Open 7 leaves the world's prices open; these hold the place.
pub fn world_price(good: Good) -> f64 {
    match good {
        Good::Crates => 0.1,
        Good::Fuel => 1.5,
        Good::Timber => 1.0,
    }
}

/// The world sells at its price and this much over, and buys at its
/// price and this much under: the premium and the discount of trade.md,
/// a tenth each way, the low end of what trade costs between a region
/// and its towns. A town that sells to the world never gets what it pays
/// for the same load.
pub const MARGIN: f64 = 0.1;
/// What a unit of a need is worth served over a counter in town, in
/// coins: the crate or the fuel it draws, and the work of serving it. A
/// meal at twice its crate, a tank at twice its fuel, the margins the
/// price economy's counters came to. The counter adds the difference.
pub fn served_price(good: Good) -> f64 {
    2.0 * world_price(good)
}

/// What an hour of work is worth where it makes no good to sell: an
/// office, a factory until it has a product, the harbour's tug. Valued at
/// cost, as GDP counts government work. A meal out's worth an hour, so a
/// desk adds about what a farm hand's crates do in a fifth of the time;
/// it sets how much of GDP desks are until they make something.
pub const WAGE: f64 = 0.2;

/// What the town pays the world for `units` of a good.
pub fn import(good: Good, units: f64) -> f64 {
    units * world_price(good) * (1.0 + MARGIN)
}
/// What the world pays the town for `units` of a good.
pub fn export(good: Good, units: f64) -> f64 {
    units * world_price(good) * (1.0 - MARGIN)
}

/// What the mayor founds the town with: enough for a few weeks of a
/// starting town's crates and fuel, and the timber for its first streets
/// of houses, until it has something to sell.
pub const STAKE: f64 = 500.0;

/// How long a delivery is assumed to take before a building has had one:
/// two hours, the reorder point's lead until it learns its own.
pub const LEAD_MS: GameTime = DAY_MS as GameTime / 12;

/// Hours of the shift a kind's row posts.
pub fn shift_hours(kind: BuildingKind) -> f64 {
    blueprint(kind).taps.iter().find(|t| t.need == Need::Work).map_or(0.0, |t| t.curve.per_day() / HOUR)
}

/// The shelves a kind keeps, and their caps.
pub fn stocks(kind: BuildingKind) -> BTreeMap<Good, f64> {
    blueprint(kind).shelves.iter().map(|&(good, cap)| (good, cap as f64)).collect()
}

/// The goods a kind keeps a shelf of.
pub fn shelves(kind: BuildingKind) -> Vec<Good> {
    blueprint(kind).shelves.iter().map(|&(good, _)| good).collect()
}

/// Units of a good a kind could pass on in a day: what its taps could
/// serve with every slot busy, and a depot's shelf, turned once.
pub fn rated(kind: BuildingKind, good: Good) -> f64 {
    let over_the_counter: f64 = blueprint(kind).taps.iter().filter(|t| t.need.good() == Some(good)).map(Tap::rated).sum();
    over_the_counter + if depot(kind) { stocks(kind).get(&good).copied().unwrap_or(0.0) } else { 0.0 }
}

/// A seller in town whose shelf is filled without a fetch from town: a
/// maker's yard, its land's. What a depot's lorry may fetch from, so that
/// a depot never fetches from a depot, round and round for nothing. §7.
pub fn source(kind: BuildingKind, good: Good) -> bool {
    makes(kind, good)
}

/// Its land fills its shelf with this: it never calls for it.
pub fn makes(kind: BuildingKind, good: Good) -> bool {
    blueprint(kind).makes == Some(good)
}

/// What lands on a maker's shelf at once: a tile's crop, at the least a
/// farm's land comes to. A shelf with less room than this offers no work
/// meanwhile (`hiring`).
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
    blueprint(kind).makes.and_then(|g| stocks(kind).get(&g).copied()).unwrap_or(0.0) / tiles.max(1) as f64
}

/// The tractor cut a tile: its crop lands in the yard, and is GDP at the
/// world's price. §12.8.
pub fn harvested(world: &mut World, farm: EntityId, load: f64, now: GameTime) {
    let Some(GameObject::Building(b)) = world.objects.get_mut(farm).map(|e| &mut e.object) else { return };
    let Some(good) = blueprint(b.kind).makes else { return };
    let Some(yard) = b.stocks.get_mut(&good) else { return };
    let grown = load.min(yard.short());
    yard.add(grown);
    added(world, farm, grown * world_price(good), now);
}

/// A row calls for what it keeps: the shelf its counter serves from or
/// its vans deliver, unless its own land fills it; or, a site, its timber.
pub fn buys(kind: BuildingKind, good: Good) -> bool {
    !makes(kind, good) && shelves(kind).contains(&good) && (blueprint(kind).taps.iter().any(|t| t.need.good() == Some(good)) || depot(kind))
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

/// Keeps shelves and runs vans: delivers its shelves, answering the calls
/// of stocks running low.
pub fn depot(kind: BuildingKind) -> bool {
    let bp = blueprint(kind);
    !bp.shelves.is_empty() && bp.vehicles.contains(&crate::protocol::CarRole::Van)
}

/// A building saved before it had its shelves or its yard gets them the
/// way a standing one does; one whose row changed a shelf gets the new
/// one. A site has neither until it stands.
pub fn open(world: &mut World, id: EntityId) {
    let Some(GameObject::Building(b)) = world.objects.get_mut(id).map(|e| &mut e.object) else { return };
    if b.site.is_some() {
        return;
    }
    let caps = stocks(b.kind);
    b.stocks.retain(|good, stock| caps.get(good) == Some(&stock.cap));
    for (good, cap) in caps {
        b.stocks.entry(good).or_insert(Stock { level: 0.0, cap });
    }
}

/// The last of a site's timber landed: it stands, its shelves empty and
/// calling; its vehicles stand in its yard, and a farm claims its land.
pub fn stand(world: &mut World, id: EntityId) {
    if let Some(GameObject::Building(b)) = world.objects.get_mut(id).map(|e| &mut e.object) {
        b.site = None;
    }
    open(world, id);
    world.unsettled.insert(id);
    if world.street_of(id).is_some() {
        crate::calls::stable(world, id);
        world.claim_land(id);
    }
}

/// The reorder point: the `s` of the `(s, S)` policy of every inventory
/// textbook, with the stock's cap as `S`. Expected use over the lead
/// time — what the taps could serve in the time the last delivery took —
/// plus a margin, which is a full house: everyone the taps seat at once,
/// so a rush during the lead does not empty the shelf. Until a building
/// has had a delivery, one is assumed to take `LEAD_MS`. §6.2.
pub fn reorder(world: &World, building: EntityId, good: Good) -> f64 {
    let Some(kind) = kind_of(world, building) else { return 0.0 };
    let lead = world.books.get(&building).and_then(|k| k.lead).unwrap_or(LEAD_MS);
    // A full house is everyone the taps seat at once: two bays with seven
    // cars at the door is a rush of seven.
    let seats: u32 = blueprint(kind).taps.iter().filter(|t| t.need.good() == Some(good)).map(|t| crate::blueprint::seats(kind, t)).sum();
    rated(kind, good) * lead as f64 / DAY_MS as f64 + seats as f64
}

/// Coins crossing the border at a building, for a good: in when the town
/// sold, out when it bought. Money out stops at nothing: an import the
/// treasury cannot pay for is paid as far as it goes. A lump on the map
/// where it landed, and a line on the town's page.
fn door(world: &mut World, at: EntityId, good: Good, amount: f64, now: GameTime) {
    let amount = amount.max(-world.treasury);
    let page = world.town.today(now);
    if amount >= 0.0 {
        *page.sold.entry(good).or_default() += amount;
    } else {
        *page.bought.entry(good).or_default() -= amount;
    }
    world.treasury += amount;
    if amount != 0.0 {
        world.lumps.push(Lump { building: at, coins: amount, gdp: 0.0, at: now, good: Some(good), units: 0.0 });
    }
}

/// Value added at a building: GDP, the level's running sum, a line on
/// the town's page under the building's kind, and a lump on the map.
fn added(world: &mut World, at: EntityId, gdp: f64, now: GameTime) {
    let Some(kind) = kind_of(world, at).filter(|_| gdp > 0.0) else { return };
    world.gdp += gdp;
    *world.town.today(now).gdp.entry(kind).or_default() += gdp;
    world.lumps.push(Lump { building: at, coins: 0.0, gdp, at: now, good: None, units: 0.0 });
}

/// Hours of a need served at a building: a line on its page, what its
/// card says it did today.
pub fn served(world: &mut World, at: EntityId, need: Need, hours: f64, now: GameTime) {
    *world.books.entry(at).or_default().today(now).served.entry(need).or_default() += hours;
}

/// A visit is over: `units` of `need` served at `at` come off the shelf
/// they were served from, and the value it added is GDP. A meal or a
/// tank off a counter's shelf adds the counter's work; a shift where the
/// work makes no good to sell adds its cost. A home's kitchen keeps no
/// shelf and adds nothing; a shift at a counter or a farm is already in
/// what it serves or grows.
pub fn visited(world: &mut World, at: EntityId, need: Need, units: f64, now: GameTime) {
    let Some(GameObject::Building(b)) = world.objects.get_mut(at).map(|e| &mut e.object) else { return };
    let kind = b.kind;
    let gdp = match need.good().and_then(|g| Some((g, b.stocks.get_mut(&g)?))) {
        Some((good, stock)) => {
            stock.take(units);
            units * (served_price(good) - world_price(good))
        }
        None if need == Need::Work && blueprint(kind).shelves.is_empty() => units * WAGE,
        None => 0.0,
    };
    added(world, at, gdp, now);
}

/// A van loads at a depot: as much of the order as the shelf has. §7.
pub fn loaded(world: &mut World, depot: EntityId, good: Good, order: f64) -> f64 {
    let Some(GameObject::Building(b)) = world.objects.get_mut(depot).map(|e| &mut e.object) else { return 0.0 };
    let Some(stock) = b.stocks.get_mut(&good) else { return 0.0 };
    let load = order.min(stock.level);
    stock.take(load);
    load
}

/// A facility's vehicle is home: its tank is filled in the yard, off the
/// building's own fuel where it keeps some, else bought from the world.
/// Nobody sits in a fleet vehicle, so nobody weighs its tank; the
/// building's turn does, when it comes home.
pub fn refilled(world: &mut World, car: EntityId, now: GameTime) {
    let Some(GameObject::Car(c)) = world.objects.get_mut(car).map(|e| &mut e.object) else { return };
    let owner = c.owner;
    let mut due = 0.0;
    for stock in c.stocks.values_mut() {
        due += stock.short() / stock.cap;
        stock.level = stock.cap;
    }
    if due <= 0.0 || kind_of(world, owner).is_none() {
        return;
    }
    let kept = loaded(world, owner, Good::Fuel, due);
    door(world, owner, Good::Fuel, -import(Good::Fuel, due - kept), now);
}

/// A delivery landed: `load` of `good` onto `buyer`'s shelf from a depot
/// in town, which moves no coins; or onto a site, which stands when the
/// last of its timber is in. What does not fit comes back.
pub fn delivered(world: &mut World, buyer: EntityId, good: Good, load: f64) -> f64 {
    let Some(GameObject::Building(b)) = world.objects.get_mut(buyer).map(|e| &mut e.object) else { return load };
    let stock = match b.site.as_mut() {
        Some(site) if good == Good::Timber => site,
        Some(_) => return load,
        None => match b.stocks.get_mut(&good) {
            Some(stock) => stock,
            None => return load,
        },
    };
    let units = load.min(stock.short()).max(0.0);
    stock.add(units);
    if b.site.is_some_and(|s| s.short() <= 1e-9) {
        stand(world, buyer);
    }
    load - units
}

/// A box from the world landed in a harbour's park: the town pays for
/// what is in it, at the harbour, as far as the treasury goes. The
/// starter pack is the world's gift and costs nothing.
pub fn landed(world: &mut World, harbour: EntityId, good: Good, units: f64, now: GameTime) {
    door(world, harbour, good, -import(good, units), now);
}

/// A box went out on the ferry: the world pays for what is in it, at the
/// harbour, as the ferry casts off.
pub fn exported(world: &mut World, harbour: EntityId, good: Good, units: f64, now: GameTime) {
    door(world, harbour, good, export(good, units), now);
}

/// What booking `boxes` of a good costs, full, at the world's price and
/// the margin: what the treasury must hold to book them.
pub fn quote(good: Good, boxes: u32) -> f64 {
    import(good, boxes as f64 * good.per_box())
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

/// One day of the town's books: GDP, per kind of building it was added
/// at, which adds up to the level's step; and what crossed the border,
/// per good, in and out, which add up to the treasury's step. §10.
#[derive(Debug, Default, Clone)]
pub struct Town {
    pub gdp: BTreeMap<BuildingKind, f64>,
    pub sold: BTreeMap<Good, f64>,
    pub bought: BTreeMap<Good, f64>,
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

/// GDP for the first level. Each one after costs a level more than the
/// last.
const LEVEL_BASE: f64 = 6.0;

/// The city's level from its GDP to date, and what it took to reach it.
///
/// Level `n` is reached at `LEVEL_BASE * n * (n + 1) / 2`, so each one asks for
/// a little more than the last.
pub fn level(gdp: f64) -> (u32, f64) {
    let n = (((1.0 + 8.0 * gdp / LEVEL_BASE).sqrt() - 1.0) / 2.0).floor().max(0.0);
    (n as u32, LEVEL_BASE * n * (n + 1.0) / 2.0)
}

/// Everything the dials need to draw themselves.
pub fn growth(world: &World, now: GameTime) -> Growth {
    let (level, reached) = level(world.gdp);
    let town = world.town.on(now);
    Growth {
        level,
        toward: world.gdp - reached,
        needed: LEVEL_BASE * (level as f64 + 1.0),
        gdp: town.gdp.values().sum(),
        treasury: world.treasury,
        income: town.revenue() - town.purchases(),
        imports: town.purchases(),
        taken: world.build.taken(),
        road_tiles_left: world.build.road_tiles().saturating_sub(world.laid),
    }
}

/// The town's page: the GDP it added today and what crossed the border,
/// and the season behind it. Each line is the level's step read back by
/// kind of building, or the treasury's by good. §10.
pub fn town(world: &World, now: GameTime) -> Value {
    let page = |t: &Town| json!({ "gdp": t.gdp, "sold": t.sold, "bought": t.bought });
    json!({
        "gdp": world.gdp,
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
        let built = |t: &Town| t.gdp.get(&House).copied().unwrap_or(0.0);
        *b.today(100).gdp.entry(House).or_default() += 3.0;
        assert_eq!(built(b.on(100)), 3.0);
        *b.today(day + 5).gdp.entry(House).or_default() += 1.0;
        assert_eq!((built(b.before(day + 5)), built(b.on(day + 5))), (3.0, 1.0));
        // A day skipped is a day with nothing in it.
        b.today(3 * day);
        assert_eq!(built(b.before(3 * day)), 0.0);
        // And the first day has no yesterday at all.
        assert_eq!(built(Books::<Town>::default().before(100)), 0.0);
        // The season is every page since the books were opened, and no
        // more than thirty: the first page is written over by the
        // thirty-first, and a day before the season is blank.
        assert_eq!(b.season().map(built).collect::<Vec<_>>(), vec![3.0, 1.0, 0.0, 0.0]);
        *b.today(SEASON as u64 * day).gdp.entry(House).or_default() += 5.0;
        assert_eq!(b.season().count(), SEASON);
        assert_eq!((built(b.season().next().unwrap()), built(b.on(0))), (1.0, 0.0));
    }

    /// Grass, and a street along it, and whatever is built beside it.
    fn town() -> World {
        let mut world = World::new();
        // Deep enough for a depot and its yard behind the street.
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

    fn shelf(world: &World, id: EntityId, good: Good) -> Stock {
        building(world, id).stocks[&good]
    }

    fn take(world: &mut World, id: EntityId, good: Good, units: f64) {
        if let Some(GameObject::Building(b)) = world.objects.get_mut(id).map(|e| &mut e.object) {
            b.stocks.get_mut(&good).unwrap().take(units);
        }
    }

    /// A delivery from a depot in town moves no money. What the town pays
    /// for is a box from the world as it lands, at the world's price and
    /// the margin; what it is paid for is a box out on the ferry, at the
    /// world's price less the margin. Each lands as a lump where it
    /// crossed, and nothing goes under zero.
    #[test]
    fn only_what_crosses_the_border_is_paid_for() {
        let mut world = town();
        let shop = world.place_on_street(at(4), Shop).unwrap();
        let depot = world.place_on_street(at(20), Depot).unwrap();
        world.treasury = 100.0;
        take(&mut world, shop, Good::Crates, 30.0);
        let load = loaded(&mut world, depot, Good::Crates, 30.0);
        assert_eq!(delivered(&mut world, shop, Good::Crates, load), 0.0, "the load did not fit");
        assert_eq!(world.treasury, 100.0, "a delivery inside the town moved money");
        assert!(world.lumps.is_empty(), "a delivery inside the town landed coins");
        assert_eq!(shelf(&world, shop, Good::Crates).short(), 0.0, "the shelf is full");
        assert_eq!(shelf(&world, depot, Good::Crates).short(), 30.0, "the depot's shelf went down by the same");
        // What does not fit comes back.
        assert_eq!(delivered(&mut world, shop, Good::Crates, 5.0), 5.0);
        // A box lands at the harbour, which here is the depot: paid for.
        landed(&mut world, depot, Good::Crates, 100.0, 0);
        assert!((100.0 - world.treasury - import(Good::Crates, 100.0)).abs() < 1e-9, "the box cost {}", 100.0 - world.treasury);
        assert!(matches!(world.lumps[..], [Lump { building, coins, .. }] if building == depot && coins < 0.0), "no lump where it landed");
        assert!((world.town.on(0).bought[&Good::Crates] - import(Good::Crates, 100.0)).abs() < 1e-9, "the town's page");
        let before = world.treasury;
        exported(&mut world, depot, Good::Timber, 20.0, 0);
        assert!((world.treasury - before - export(Good::Timber, 20.0)).abs() < 1e-9);
        // The world buys for less than it sells.
        assert!(export(Good::Crates, 1.0) < world_price(Good::Crates) && world_price(Good::Crates) < import(Good::Crates, 1.0));
        world.treasury = 1.0;
        landed(&mut world, depot, Good::Fuel, 50.0, 0);
        assert_eq!(world.treasury, 0.0, "an import went under zero");
    }

    /// The farm: a tile cut lands its crop in the yard, and is GDP, and no
    /// money; a yard with no room for a crop offers no work.
    #[test]
    fn a_farm_grows_on_its_land() {
        let mut world = town();
        world.place_on_street(at(4), House).unwrap();
        let farm = world.place_on_street(at(8), Farm).unwrap();
        world.settle();
        world.treasury = 100.0;
        assert!(!depot(Farm) && makes(Farm, Good::Crates) && shelves(Farm) == [Good::Crates], "the farm is not a maker of crates");
        assert!(source(Farm, Good::Crates) && !source(Depot, Good::Crates));
        assert!(super::farm(Farm) && !super::farm(Office));
        assert!((crop(Farm, 200) - 1944.0 / 200.0).abs() < 1e-9 && (lump(Farm) - 1944.0 / crate::world::fields::capacity(Farm)).abs() < 1e-9);
        assert_eq!(shelf(&world, farm, Good::Crates).level, 0.0, "the yard is founded with a harvest");
        assert!(hiring(&world, farm), "an empty yard offers no work");
        assert!(!buys(Farm, Good::Crates) && buys(Shop, Good::Crates) && buys(Depot, Good::Crates) && !buys(House, Good::Crates), "the rows buy the wrong things");

        harvested(&mut world, farm, crop(Farm, 200), 0);
        assert_eq!((shelf(&world, farm, Good::Crates).level, world.treasury), (crop(Farm, 200), 100.0), "the harvest moved money");
        assert!((world.gdp - crop(Farm, 200) * world_price(Good::Crates)).abs() < 1e-9, "a crop cut is GDP at the world's price: {}", world.gdp);
        // A shift at the farm is in its crops already.
        visited(&mut world, farm, Need::Work, 9.0, 0);
        assert!((world.gdp - crop(Farm, 200) * world_price(Good::Crates)).abs() < 1e-9, "a farm hand's shift counted twice");
        let yard = shelf(&world, farm, Good::Crates).cap;
        if let Some(GameObject::Building(b)) = world.objects.get_mut(farm).map(|e| &mut e.object) {
            b.stocks.get_mut(&Good::Crates).unwrap().level = yard - lump(Farm) / 2.0;
        }
        assert!(!hiring(&world, farm), "a full yard hires");
    }

    /// A visit draws the shelf it was served from and moves no money. What
    /// it adds is GDP, landing on the building: a meal the counter's work
    /// over its crate, a shift at a desk that sells nothing its cost; a
    /// meal at home or a shift at a counter, nothing of its own.
    #[test]
    fn a_visit_draws_the_shelf_and_adds_its_value() {
        let mut world = town();
        let home = world.place_on_street(at(4), House).unwrap();
        let shop = world.place_on_street(at(8), Shop).unwrap();
        let office = world.place_on_street(at(12), Office).unwrap();
        visited(&mut world, shop, Need::Eat, 3.0, 0);
        assert_eq!(shelf(&world, shop, Good::Crates).short(), 3.0);
        assert!((world.gdp - 3.0 * (served_price(Good::Crates) - world_price(Good::Crates))).abs() < 1e-9, "three meals added {}", world.gdp);
        let gdp = world.gdp;
        visited(&mut world, home, Need::Eat, 3.0, 0);
        visited(&mut world, shop, Need::Work, 9.0, 0);
        assert!(building(&world, home).stocks.is_empty(), "a home keeps a shelf");
        assert_eq!(world.gdp, gdp, "a meal at home or a shift at a counter added value of its own");
        visited(&mut world, office, Need::Work, 9.0, 0);
        assert!((world.gdp - gdp - 9.0 * WAGE).abs() < 1e-9, "a shift at a desk is not worth its cost");
        assert_eq!(world.treasury, STAKE, "a visit moved money");
        assert!((world.town.on(0).gdp[&Office] - 9.0 * WAGE).abs() < 1e-9, "the town's page");
        assert!(matches!(world.lumps.last(), Some(Lump { building, gdp, coins, .. }) if *building == office && *gdp > 0.0 && *coins == 0.0), "no lump at the office");
    }

    /// A depot's van is filled in the yard off the depot's own fuel; with
    /// none left, it is bought from the world.
    #[test]
    fn a_fleet_vehicle_is_refilled_in_the_yard() {
        let mut world = town();
        let depot = world.place_on_street(at(20), Depot).unwrap();
        let van = world.objects.iter().find(|e| matches!(e.object, GameObject::Car(ref c) if c.owner == depot && c.role == crate::protocol::CarRole::Van)).map(|e| e.id).expect("a van in the yard");
        world.treasury = 100.0;
        crate::resident::drove(&mut world, van, 250.0);
        let fuel = shelf(&world, depot, Good::Fuel).level;
        refilled(&mut world, van, 0);
        let full = match world.objects.get(van).map(|e| &e.object) {
            Some(GameObject::Car(c)) => c.stocks.values().all(|s| s.level == s.cap),
            _ => unreachable!(),
        };
        assert!(full, "the yard did not fill it");
        assert!((fuel - shelf(&world, depot, Good::Fuel).level - 0.5).abs() < 1e-9, "half a tank came off the depot's shelf");
        assert_eq!(world.treasury, 100.0, "the depot's own fuel was paid for");
        take(&mut world, depot, Good::Fuel, f64::INFINITY);
        crate::resident::drove(&mut world, van, 250.0);
        refilled(&mut world, van, 0);
        assert!((100.0 - world.treasury - import(Good::Fuel, 0.5)).abs() < 1e-9, "the fill cost {}", 100.0 - world.treasury);
    }

    /// A shelf that reorders before it is full never stops ordering: every
    /// counter's shelf holds more than its taps could sell over the lead a
    /// fresh building assumes, with the lot full.
    #[test]
    fn every_shelf_is_bigger_than_its_reorder_point() {
        let mut world = town();
        let mut x = 4;
        for kind in BuildingKind::ALL {
            if blueprint(kind).shelves.is_empty() || blueprint(kind).quay || blueprint(kind).makes.is_some() {
                continue;
            }
            let b = world.place_on_street(at(x), kind).unwrap();
            x += 8;
            for (good, cap) in stocks(kind) {
                let s = reorder(&world, b, good);
                assert!(s < cap, "{kind:?} reorders {good:?} at {s} with a shelf of {cap}");
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
        let a_day = rated(Shop, Good::Crates);
        let s = reorder(&world, shop, Good::Crates);
        assert!((s - (a_day * LEAD_MS as f64 / DAY_MS as f64 + seats)).abs() < 1e-9, "{s}");
        world.books.entry(shop).or_default().lead = Some(0);
        assert_eq!(reorder(&world, shop, Good::Crates), seats, "a depot next door leaves the full house");
        world.books.entry(shop).or_default().lead = Some(DAY_MS as GameTime);
        assert!(reorder(&world, shop, Good::Crates) > 40.0, "a day's lead asks for more than the shelf holds");
    }

    /// A building costs timber, not coins: placed, it is a site, with no
    /// shelf, no door for anyone but its timber; the timber in, it stands,
    /// its shelves empty and calling. The town's first depot stands at
    /// once: it is where the first timber is kept.
    #[test]
    fn a_site_stands_when_its_timber_is_in() {
        let mut world = town();
        let depot = world.place_building(at(20), Depot, 2).unwrap();
        assert!(building(&world, depot).site.is_none(), "the first depot waited for timber");
        let shop = world.place_building(at(4), Shop, 2).unwrap();
        let b = building(&world, shop);
        assert_eq!(b.site.map(|s| s.cap), Some(blueprint(Shop).timber as f64));
        assert!(b.stocks.is_empty(), "a site keeps a shelf");
        assert_eq!(delivered(&mut world, shop, Good::Crates, 10.0), 10.0, "a site took crates");
        assert_eq!(delivered(&mut world, shop, Good::Timber, 3.0), 0.0);
        assert!(building(&world, shop).site.is_some(), "it stood short of its timber");
        assert_eq!(delivered(&mut world, shop, Good::Timber, 3.0), 2.0, "it took more timber than it needs");
        let b = building(&world, shop);
        assert!(b.site.is_none(), "it did not stand");
        assert_eq!(b.stocks[&Good::Crates].level, 0.0, "it stood stocked");
        assert_eq!(world.treasury, STAKE, "a building cost coins");
        let second = world.place_building(at(40), Depot, 2).unwrap();
        assert!(building(&world, second).site.is_some(), "a second depot stood for nothing");
    }

    #[test]
    fn levels_come_a_little_further_apart_each_time() {
        assert_eq!(level(0.0), (0, 0.0));
        assert_eq!(level(LEVEL_BASE), (1, LEVEL_BASE));
        assert_eq!(level(3.0 * LEVEL_BASE - 0.1).0, 1);
        assert_eq!(level(3.0 * LEVEL_BASE), (2, 3.0 * LEVEL_BASE));
    }
}
