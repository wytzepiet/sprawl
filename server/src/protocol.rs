use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub type EntityId = u64;
pub type EdgeKey = (EntityId, EntityId);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Hash)]
#[ts(export)]
pub struct GridCoord {
    pub x: i32,
    pub y: i32,
}

/// A step of the mayor's road or demolisher: one tile to the next, or a
/// tap, from and to the same tile. A drag is its steps, each built as it
/// is sent.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Build {
    pub tool: Tool,
    pub from: GridCoord,
    pub to: GridCoord,
    /// How high each end stands, in half-levels (`RoadNode::height`);
    /// none, both on the ground.
    #[serde(default)]
    #[ts(optional)]
    pub up: Option<[u8; 2]>,
    /// Which side of its tile each end stands (`RoadNode::side`); none,
    /// both in the middle.
    #[serde(default)]
    #[ts(optional)]
    pub sides: Option<[[i8; 2]; 2]>,
    /// The road laid has priority (`RoadNode::road`): whoever joins or
    /// crosses it gives way. Along a road already there, it gains or loses
    /// it.
    #[serde(default)]
    pub road: bool,
}

/// A drag of road, the whole of it so far (`draw.rs`): sent again as it
/// goes on, and laid as a whole, the server keeping what it laid of it
/// before where that still stands as planned.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Stroke {
    /// Which drag this is: the same as the last sent, that drag drawn on;
    /// another, a new one.
    pub id: u32,
    /// Street, OneWay or Wide.
    pub tool: Tool,
    /// The road laid has priority (`RoadNode::road`).
    #[serde(default)]
    pub road: bool,
    /// The tiles the drag has been through, the first where it was
    /// pressed, each a step from the one before; and with each, the pen's
    /// height, in half-levels, as the drag reached it.
    pub tiles: Vec<Spot>,
    /// Where on the first tile it was pressed: the road there it starts
    /// on, its height and side; none, at the pen's height in the middle.
    #[serde(default)]
    #[ts(optional)]
    pub start: Option<Stand>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
pub struct Spot {
    pub at: GridCoord,
    pub want: u8,
}

/// Where on a tile a road stands: its height and side.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
pub struct Stand {
    pub h: u8,
    pub side: [i8; 2],
}

/// What the hand asks before it acts, to show where it may (`hint.rs`):
/// answered with a `Hint`, to the asking client alone.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", content = "data")]
pub enum Ask {
    /// Which tiles in this area a drag with the tool in hand may start
    /// from, or the building in hand stand round.
    Starts { hand: Holding, area: Area },
    /// Where a drag may go on from the last tile of this one: for a road,
    /// the drag as drawn so far; for the eraser, the tile it is on and
    /// where on it it stands (`Stroke::start`).
    Reach(Stroke),
    /// Where the building in hand, held over this tile, would be placed.
    Placing { kind: BuildingKind, at: GridCoord, facing: Option<u8> },
}

/// What the hand holds, for `Ask::Starts`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", content = "data")]
pub enum Holding {
    /// A tool, with priority or not, the pen at this height in half-levels.
    Tool { tool: Tool, road: bool, want: u8 },
    /// A building, turned this way, or left to find its way.
    Building { kind: BuildingKind, facing: Option<u8> },
}

/// Tiles from one corner to the other, both in.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Area {
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
}

/// The game's answer to an `Ask`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", content = "data")]
pub enum Hint {
    Starts { hand: Holding, area: Area, tiles: Vec<GridCoord> },
    /// For the drag `id`, `len` tiles long: the eight steps on from its
    /// last tile (east, then on round toward +y), each where it would
    /// stand, or none where it may not go.
    Reach { id: u32, len: u32, ways: Vec<Option<Stand>> },
    Placing(Placing),
}

/// A building held over the map: where letting go would place it, the
/// way it would face, its door if it has one, and, if it may not go
/// there, why, in words.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Placing {
    pub kind: BuildingKind,
    /// The tile it is placed round.
    pub at: GridCoord,
    pub tiles: Vec<GridCoord>,
    pub facing: u8,
    /// The tile its drive runs onto, and the street it runs from.
    pub door: Option<Door>,
    pub why: Option<String>,
}

/// What the mayor's hand holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Tool {
    /// A street, both ways: what buildings front.
    Street,
    /// A street one way, `from` to `to`.
    OneWay,
    /// Whatever stands on `to`, a building whole; a drag cuts the road
    /// between its tiles.
    Demolish,
    /// Traffic lights at the junction on `to`, or none where it has them.
    Light,
    /// A road of two lanes, one way, `from` to `to`.
    Wide,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RoadNode {
    #[ts(type = "Array<number>")]
    pub outgoing: Vec<EntityId>,
    #[ts(type = "Array<number>")]
    pub incoming: Vec<EntityId>,
    /// Part of a network that reaches a harbour, the door everything comes
    /// in and goes out by. Otherwise an island: drawn red, driven by nobody.
    #[serde(default)]
    pub joined: bool,
    /// The neighbours the way to is a road rather than a street: a through
    /// road, which the streets that meet it give way to. Both ends hold it.
    /// A node on one is a road's: buildings front streets only, no driveway
    /// is ever laid onto a road, and nothing arrives beside one.
    #[serde(default)]
    #[ts(type = "Array<number>")]
    pub road: Vec<EntityId>,
    /// Laid by the mayor, so it was paid for. A fixture's or a level's
    /// roads, and driveways, are free.
    #[serde(default)]
    pub laid: bool,
    /// How high it stands, in half-levels: 0 the ground, 2 a level up, 4
    /// two, 6 three; odd, a slope between the level below and the one
    /// above (`world/decks.rs`).
    #[serde(default)]
    pub height: u8,
    /// Traffic lights, if the junction has them: which phase is green
    /// (`intersection::phases_of`), or `ALL_RED` between phases.
    #[serde(default)]
    pub light: Option<u8>,
    /// The neighbours the road out to has two lanes, one way: a two-lane
    /// one-way (`Tool::Wide`).
    #[serde(default)]
    #[ts(type = "Array<number>")]
    pub wide: Vec<EntityId>,
    /// Which side of its tile it stands: the step across its road it is
    /// moved by, or none, the middle. Two one-ways share a tile side by
    /// side, each a thin road beside the other (`world/decks.rs`).
    #[serde(default)]
    pub side: [i8; 2],
}

/// A junction's lights between phases, none green.
pub const ALL_RED: u8 = u8::MAX;

/// What stands on a plot. The kind follows from the footprint the layout chose,
/// so a wide plot becomes an Apartment where a single tile becomes a House.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, PartialOrd, Ord)]
#[ts(export)]
pub enum BuildingKind {
    House,
    Apartment,
    Shop,
    Office,
    Factory,
    /// Pumps that never close, and a kiosk that does.
    GasStation,
    /// Shopping for the whole street, with shelves that a warehouse keeps
    /// full. Placed by the mayor.
    Supermarket,
    /// Where the town's goods are kept, in the open, every good on its
    /// pad: a lorry that fetches packages from the harbour and vans that
    /// deliver to shops and sites. Placed by the mayor.
    Depot,
    /// Where grain comes from: a tractor on its land, and hands that fill
    /// a yard with its bags. A depot's lorry fetches them. Placed by the
    /// mayor.
    Farm,
    /// The door: a ramp on the coast and a quay, where the world's ferry
    /// lands settlers and pallets and takes pallets away (`world/sea.rs`).
    /// Placed by the mayor, with its back to the sea.
    Harbour,
    /// Where timber comes from: hands felling the forest round it and
    /// sawing it, the planks stacked in its yard for a depot's lorry.
    /// Placed by the mayor, beside the woods.
    Sawmill,
    /// Where stone comes from: hands breaking the rock of the mountain
    /// beside it, the stone heaped in its yard for a depot's lorry.
    /// Placed by the mayor, at the mountain's foot.
    Quarry,
    /// Where bread comes from: hands opening the town's grain and baking
    /// it, the crates stacked in its yard for a depot's lorry. Placed by
    /// the mayor, among the houses.
    Bakery,
}

impl BuildingKind {
    /// Every kind, in declaration order — the order of the blueprint table.
    pub const ALL: [BuildingKind; 13] = [
        BuildingKind::House,
        BuildingKind::Apartment,
        BuildingKind::Shop,
        BuildingKind::Office,
        BuildingKind::Factory,
        BuildingKind::GasStation,
        BuildingKind::Supermarket,
        BuildingKind::Depot,
        BuildingKind::Farm,
        BuildingKind::Harbour,
        BuildingKind::Sawmill,
        BuildingKind::Quarry,
        BuildingKind::Bakery,
    ];
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Building {
    pub kind: BuildingKind,
    /// The tiles it stands on, its lot's among them; the first is where it
    /// is, the tile it is known by.
    #[serde(default)]
    pub tiles: Vec<GridCoord>,
    /// Which side of the building the lot and the street are on; see
    /// `blueprint::FACINGS`. The client lays the building and the lot out
    /// within the footprint from this.
    pub facing: u8,
    /// Its stocks, by good: the shelf of what it serves or keeps — meals,
    /// tanks, a farm's grain — drawn down by visits and loads and filled
    /// by a delivery or its own land. Empty shelves serve nothing. A save
    /// from before a stock existed gets it issued at load
    /// (`economy::open`).
    #[serde(default)]
    pub stocks: std::collections::BTreeMap<Good, crate::needs::Stock>,
    /// Still going up: each material delivered toward it, of what its
    /// row takes (`blueprint::Blueprint::materials`). A site has no door
    /// for anyone but the vans bringing its materials; all in, it stands.
    #[serde(default)]
    pub site: Option<std::collections::BTreeMap<Good, crate::needs::Stock>>,
    /// A harbour's quay: the packages standing on it, off the ferry for
    /// the town or brought by a lorry for the ferry (`world/sea.rs`),
    /// each in a slot of the pad the client lays out, in order.
    #[serde(default)]
    pub pad: Vec<Package>,
    /// A harbour's slots going out, booked and not yet loaded: a package
    /// each, its good, partner and price, for the first depot's lorry
    /// with the good to fill (`haul::lorry_wake`).
    #[serde(default)]
    pub outgoing: Vec<Package>,
    /// Its forklifts' work: each a run of packages lifted between its pad
    /// and a vehicle standing at it, one at a time (`World::lift`). The
    /// server moves the goods as a run starts; the client plays it.
    #[serde(default)]
    pub lifts: Vec<Lift>,
    /// Lorries bought for it beyond the one its row comes with.
    #[serde(default)]
    pub lorries: u8,
    /// A farm's land: the grass it claimed when a street reached it, each
    /// tile at a stage of the cycle the tractor drives it through
    /// (`world/fields.rs`). A tile built over is dropped.
    #[serde(default)]
    pub land: Vec<Tile>,
    /// Where the tractor last drove: one run's path, which the client
    /// draws the field along, corners and all. Every run works the same
    /// ground, so the last run's path is the field. Redrawn by the next.
    #[serde(default)]
    pub ruts: Vec<GridCoord>,
    /// Where it is driven into: one of its tiles, and the street tile
    /// beside it the drive runs from. The drive is the building's, not a
    /// road: drawn as one, driven by the cars of its lot, and gone with it.
    /// Kept when the street goes, and good again if it comes back.
    #[serde(default)]
    pub door: Option<Door>,
}

/// A building's door: its tile a drive runs onto, and the street tile the
/// drive runs from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Door {
    pub tile: GridCoord,
    pub street: GridCoord,
}

/// A tile of a farm's land, and where it is in the cycle: grass until the
/// tractor ploughs it, bare until it seeds it, growing from `since` until a
/// day on, cut after the harvest, and ploughed again.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Tile {
    pub at: GridCoord,
    pub stage: Stage,
    #[ts(type = "number")]
    pub since: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Stage {
    Grass,
    Ploughed,
    Sown,
    Cut,
}

/// What a tractor does to a tile as it drives over it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Job {
    Plough,
    Seed,
    Harvest,
}

/// A ship's leg over the water (`shipping::water::route`): the way, in
/// tiles, from the ferry's middle at one end to the other, and when it
/// set out and arrives. It gathers way from a berth and comes into one
/// at an even push (`ease`: the start is a berth, the end is), at full
/// speed over the map's edge; `shipping::covered` says how far along it
/// is at any moment, here and in the client. A leg is sailed in pieces
/// where it stops at a junction's mouth (`shipping::voyage`); each piece
/// is sent once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Sail {
    pub path: Vec<[f64; 2]>,
    #[ts(type = "number")]
    pub started: u64,
    #[ts(type = "number")]
    pub ends: u64,
    pub ease: [bool; 2],
    /// Its land end trails: it is sailing out from a berth, as a
    /// double-ended ferry does, never turning.
    pub astern: bool,
}

/// A tractor's run off the roads, over its farm's land. The tiles it
/// drives in order, doing its job to each as it arrives, standing on the first at `started` and reaching one more
/// every `pace` milliseconds. No route, no claims, no queue — and nothing
/// that changes as it goes, so the run is sent once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Run {
    pub job: Job,
    pub path: Vec<GridCoord>,
    #[ts(type = "number")]
    pub started: u64,
    #[ts(type = "number")]
    pub pace: u64,
}

impl Building {
    /// One of a kind, placed: a site waiting for its materials, or
    /// standing at once where its row takes none (`economy::stand`).
    pub fn new(kind: BuildingKind, tiles: Vec<GridCoord>, facing: u8) -> Building {
        let materials = crate::blueprint::blueprint(kind).materials;
        Building {
            kind,
            tiles,
            facing,
            stocks: Default::default(),
            site: (!materials.is_empty()).then(|| materials.iter().map(|&(g, n)| (g, crate::needs::Stock { level: 0.0, cap: n as f64 })).collect()),
            pad: Vec::new(),
            outgoing: Vec::new(),
            lifts: Vec::new(),
            lorries: 0,
            land: Vec::new(),
            ruts: Vec::new(),
            door: None,
        }
    }
}

/// What a car is for, which is who drives it and what it looks like.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum CarRole {
    /// A resident's own, driven by them.
    #[default]
    Private,
    /// An articulated lorry with a flatbed: a depot's, hauling packages
    /// between the harbour's quay, makers' yards and its own.
    Truck,
    /// A depot's van, on the last mile to a shop.
    Van,
    /// A farm's: out along the track to a ripe field and home with the
    /// crop, driven by a hand on shift. On the road it is a slow car.
    Tractor,
    /// The world's ferry: in from the map's edge to a harbour's ramp on the
    /// timetable, settlers and pallets on its deck, and away again. Never
    /// on a road.
    Ferry,
}

/// Someone's car. It outlives its journeys: between trips it sits parked at a
/// building, doing nothing and costing nothing, and everything about the
/// journey it is currently on lives in `trip`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Car {
    /// Who it belongs to: the resident driving it, whose `at` points back
    /// at this car while they are aboard; or the facility it works for.
    #[ts(type = "number")]
    pub owner: EntityId,
    pub trip: Option<Trip>,
    #[serde(default)]
    pub role: CarRole,
    /// Where it stands while parked, if the lot had room: the spot's centre
    /// and the way its nose points, in radians. `None` is parked out of
    /// sight.
    #[serde(default)]
    pub spot: Option<Pose>,
    /// The tank and the wear: used by the tile, filled at a pump and put
    /// right at a workshop. The car's, though its driver decides when to
    /// stop. A save from before cars had them gets them full.
    #[serde(default = "crate::needs::Bucket::driven")]
    pub stocks: std::collections::BTreeMap<crate::needs::Need, crate::needs::Stock>,
    /// A tractor's run over its farm's land, while it is on one.
    #[serde(default)]
    pub run: Option<Run>,
    /// A ship's leg, while it sails one.
    #[serde(default)]
    pub sail: Option<Sail>,
    /// The packages on a lorry's flatbed, a few (`haul::LOAD`).
    #[serde(default)]
    pub cargo: Vec<Package>,
    /// What a van carries on a call, and how much, whole packages of it:
    /// from its depot to the caller's door. Loaded before it sets out,
    /// landed at the end; on the vehicle, so it is seen.
    #[serde(default)]
    pub load: Option<(Good, f64)>,
    /// A ferry's deck, by place (`world/sea.rs` DECK): a pallet each.
    /// Settlers' cars ride in the bays with none.
    #[serde(default)]
    pub deck: Vec<Option<Package>>,
    #[serde(default)]
    #[ts(type = "Array<number>")]
    pub passengers: Vec<EntityId>,
    /// A ferry's packages booked beyond the sea, waiting for a sailing
    /// with room on its deck.
    #[serde(default)]
    pub booked: Vec<Package>,
    /// Its next moment: a ferry's on the timetable, when it berths, while
    /// it is away or at sea, and when it casts off, while it is at the
    /// ramp; a lorry's or a van's when the forklift is done with it.
    #[serde(default)]
    #[ts(type = "number")]
    pub due: u64,
}

impl Car {
    /// A car as it arrives: parked out of sight, going nowhere, full.
    pub fn new(owner: EntityId, role: CarRole) -> Car {
        Car { owner, trip: None, role, spot: None, stocks: crate::needs::Bucket::driven(), run: None, sail: None, cargo: Vec::new(), load: None, deck: Vec::new(), passengers: Vec::new(), booked: Vec::new(), due: 0 }
    }
}

/// A place to stand, and which way.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Pose {
    pub at: [f64; 2],
    pub heading: f64,
}

/// A good: what a shelf, a yard or a package holds, and what the world
/// prices. A resident's need draws one off a counter's shelf (`Need::good`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Good {
    /// Bread, in wooden crates: what a shop serves meals from. Baked in
    /// town and eaten fresh, so never on the market (`market::GOODS`).
    Bread,
    /// What a pump fills a tank from, in drums on a pallet.
    Fuel,
    /// What buildings are built from, the first material: logs in a
    /// strapped bundle.
    Timber,
    /// Broken rock in blocks on a pallet: what roads are laid on, and the
    /// masonry of the bigger buildings.
    Stone,
    /// What a farm grows and a bakery bakes, in a big bag open at the
    /// top: the food the world trades.
    Grain,
}

impl Good {
    /// Every good, in declaration order.
    pub const ALL: [Good; 5] = [Good::Bread, Good::Fuel, Good::Timber, Good::Stone, Good::Grain];

    /// Units one package holds: the thing that is traded, carried and
    /// stacked, whole (docs/plan-goods.md §Goods you can see). A crate of
    /// bread is twenty-five meals, a bag of grain the same unbaked, a
    /// pallet of drums ten tanks, a bundle
    /// or a pallet of blocks a house's timber or four tiles of road.
    pub fn per_package(self) -> f64 {
        match self {
            Good::Bread | Good::Grain => 25.0,
            Good::Fuel => 10.0,
            Good::Timber | Good::Stone => 4.0,
        }
    }

    /// What one package of it is called, and several.
    pub fn package(self) -> (&'static str, &'static str) {
        match self {
            Good::Bread => ("crate of bread", "crates of bread"),
            Good::Grain => ("bag of grain", "bags of grain"),
            Good::Fuel => ("pallet of fuel drums", "pallets of fuel drums"),
            Good::Timber => ("bundle of timber", "bundles of timber"),
            Good::Stone => ("pallet of stone", "pallets of stone"),
        }
    }

    /// So many packages of it, in words: "3 bundles of timber".
    pub fn packages(self, n: u32) -> String {
        let (one, many) = self.package();
        format!("{n} {}", if n == 1 { one } else { many })
    }
}

/// A package: a bundle, a crate, a pallet, the unit everything is traded
/// and carried in, whole. Never an entity: a value that stands in one
/// place at a time, on a ferry's deck, on a quay, on a lorry, or booked
/// beyond the sea (`Car::booked`, a ferry's). A package of the town's is
/// gone once it is in a depot's stock; one going out, once the ferry
/// carries it off. Inside the town goods are counted, not followed: a
/// depot's or a maker's stock is so many packages on its pad, opened only
/// where they are used. docs/plan-goods.md.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Package {
    /// Its number, for following it wherever it is.
    #[ts(type = "number")]
    pub id: u64,
    pub good: Good,
    /// The depot it is bound for; None is the town's, for whichever depot's
    /// lorry comes first, or the world's, going back.
    #[ts(type = "number | null")]
    pub to: Option<EntityId>,
    /// Going out: an export, brought to a harbour's quay for the ferry.
    pub outbound: bool,
    /// The shipment it is part of: a booking, a pin's, a letter's, the
    /// starter pack.
    #[ts(type = "number")]
    pub order: u64,
    /// Who it is from or for: a mayor beyond the edge, or None, the world.
    #[serde(default)]
    pub partner: Option<crate::orders::Mayor>,
    /// The deal: coins a unit, paid as it lands or as it sails.
    #[serde(default)]
    pub price: f64,
}

impl Package {
    /// What it is worth at its deal's price.
    pub fn value(&self) -> f64 {
        self.price * self.good.per_package()
    }
}

/// A forklift's run at a building's pad: `n` packages of a good lifted
/// one at a time between the pad and a vehicle standing at it (`car`, a
/// lorry, a van, a ferry), onto it or off it, the first from `start`, one
/// every `every` ms, by the building's forklift `k`. The client plays it
/// (docs/plan-goods.md §Pads and handling).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Lift {
    #[ts(type = "number")]
    pub car: EntityId,
    pub good: Good,
    pub n: u32,
    pub onto: bool,
    #[ts(type = "number")]
    pub start: u64,
    #[ts(type = "number")]
    pub every: u64,
    pub k: u8,
}

impl Lift {
    pub fn ends(&self) -> u64 {
        self.start + self.n as u64 * self.every
    }
}

/// Where a package is on its way, as the shipments list reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Leg {
    /// Ordered, waiting beyond the sea for its sailing.
    Booked,
    /// On a ferry's deck, at sea or at the berth.
    Aboard,
    /// On a harbour's quay.
    Quay,
    /// On a lorry.
    Hauled,
    /// On a lorry standing in its depot's yard: home, to be unloaded
    /// or taken out again.
    Yard,
}

/// A package with an order, where it is: the shipments list and its pins.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Shipment {
    #[ts(type = "number")]
    pub order: u64,
    pub partner: Option<crate::orders::Mayor>,
    pub price: f64,
    #[ts(type = "number")]
    pub package: u64,
    pub good: Good,
    #[ts(type = "number | null")]
    pub to: Option<EntityId>,
    pub outbound: bool,
    pub leg: Leg,
    /// What it is on or in: the ferry, the lorry, the harbour, the depot.
    #[ts(type = "number | null")]
    pub carrier: Option<EntityId>,
    /// Where that is on the map, to the tile, when it is on it.
    pub at: Option<GridCoord>,
    /// When it lands where it is going next: the ferry's berthing for a
    /// package booked or at sea.
    #[ts(type = "number | null")]
    pub eta: Option<u64>,
}

/// A harbour's ferry, as its timetable reads.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Sailing {
    #[ts(type = "number")]
    pub harbour: EntityId,
    #[ts(type = "number")]
    pub ferry: EntityId,
    /// When it next berths, or berthed; and when it casts off.
    #[ts(type = "number")]
    pub arrives: u64,
    #[ts(type = "number")]
    pub departs: u64,
    /// At the ramp now.
    pub berthed: bool,
    /// Packages and settlers aboard, and how many packages the deck holds.
    pub packages: u32,
    pub settlers: u32,
    pub deck: u32,
    /// Packages booked beyond the sea for this harbour.
    pub booked: u32,
    /// Households moved in and waiting beyond the sea for a sailing.
    pub waiting: u32,
    /// When a package booked now berths: the sailing from the world the
    /// ferry has not yet left on.
    #[ts(type = "number")]
    pub lands: u64,
    /// From casting off to berthing again, by the line's timetable.
    #[ts(type = "number")]
    pub turn: u64,
    /// Slots going out not yet filled.
    pub outgoing: Vec<Package>,
}

/// The sea's part of an update: every shipment on its way, every
/// harbour's timetable, and the lanes its lines are laid as. Small, and
/// summarised afresh each update.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Sea {
    pub shipments: Vec<Shipment>,
    pub sailings: Vec<Sailing>,
    #[serde(default)]
    pub lanes: Vec<Lane>,
    /// What the open letters still want.
    #[serde(default)]
    pub letters: Vec<crate::orders::Letter>,
}

/// A stretch of a line's way as it lies on the map (`shipping::lanes`):
/// a lane, one way, the way the points run; or a junction between lanes.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Lane {
    pub path: Vec<[f64; 2]>,
    pub kind: LaneKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum LaneKind {
    OneWay,
    /// Shared both ways, one way at a time: a berth's approach, or water
    /// too narrow for two lanes.
    TwoWay,
    /// Lanes crossing: ships whose ways cross take turns.
    Crossing,
}

/// One journey: born when the driver pulls out, gone on arrival.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Trip {
    /// The building this trip ends at.
    #[ts(type = "number")]
    pub destination: EntityId,
    /// When this trip would end on empty roads, fixed at departure. The gap
    /// between this and the actual arrival is time lost to traffic.
    #[ts(type = "number")]
    pub eta: u64,
    #[serde(skip)]
    #[ts(skip)]
    pub route: Vec<EntityId>,
    pub route_positions: Vec<[f64; 2]>,
    /// How high each node of the route stands (`RoadNode::height`): the
    /// client lifts the car over a deck, and finds which node it is on.
    #[serde(default)]
    pub route_heights: Vec<u8>,
    /// The lane kept on the edge into each node of the route
    /// (`World::lanes_for`): 0 the right, 1 the left of a road of two.
    #[serde(default)]
    pub lanes: Vec<u8>,
    /// How many nodes at either end of the route are in a lot rather than on
    /// the street: the spot pulled out of, the spot driven into. Lot nodes
    /// are drawn where they are, not offset onto a lane.
    pub from_lot: usize,
    pub to_lot: usize,
    /// The stretches driven backwards, as `[a, b]`: the edges from route[k]
    /// to route[k + 1] for a <= k < b. A car backing out of its driveway, a
    /// lorry backing into its dock. Each end of one is a change of gear.
    #[serde(default)]
    pub backing: Vec<[usize; 2]>,
    /// How far along the route each change of gear is, by `progress`: the
    /// client drives each stretch between them to fit exactly.
    #[serde(default)]
    pub cusps: Vec<f64>,
    /// Where it stood when it set out, and where it will stand at the end:
    /// a spot's own pose, which a route's first and last edges need not
    /// point along. The client's drive starts from the one and ends on the
    /// other, so leaving and parking are no jump.
    #[serde(default)]
    pub leaves: Option<Pose>,
    #[serde(default)]
    pub stands: Option<Pose>,
    /// Cumulative distance along the route.
    pub progress: f64,
    pub speed: f64,
    pub acceleration: f64,
    /// Total arc length of the entire route.
    pub total_route_length: f64,
    #[ts(type = "number")]
    pub updated_at: u64,
    /// Current segment (1-based). The car is between route[ri-1] and route[ri].
    #[ts(skip)]
    pub route_index: usize,
    /// Precomputed arc length of each segment. segment_lengths[i] = length from
    /// route[i-1] to route[i]. Index 0 is unused (always 0.0).
    #[serde(skip)]
    #[ts(skip)]
    pub segment_lengths: Vec<f64>,
    /// How far along the route each node is: `along[k]` is
    /// `segment_lengths[1..=k]` summed (`car::spawn::along`).
    #[serde(skip)]
    #[ts(skip)]
    pub along: Vec<f64>,
    /// Where it joined the run of road it is on, which way it set off, and
    /// when: the direction names the run, since two runs can share both
    /// ends (`RoadNetwork::observe_passage`).
    #[serde(skip)]
    #[ts(skip)]
    pub joined: Option<(EntityId, EntityId, u64)>,
    /// Standing where its gear changes, until when.
    #[serde(skip)]
    #[ts(skip)]
    pub standing: Option<u64>,
    /// What it last slowed or stopped for, and how hard (`car::Cause`):
    /// for a replay to read, never the game.
    #[serde(skip)]
    #[ts(skip)]
    pub why: Option<(crate::car::Cause, f64)>,
    /// The street nodes either side of the stretch a kerb bay is turned
    /// across, at the trip's start and its end: the street waits at both
    /// while the car turns (`car::simulation`).
    #[serde(skip)]
    #[ts(skip)]
    pub stretches: [Vec<EntityId>; 2],
    /// Its last change of lanes along a road of two (`car::simulation`):
    /// for the client to slide it across while it lasts.
    #[serde(default)]
    pub shift: Option<Shift>,
    /// The lane it waits to get into, with no room there yet: whoever
    /// comes along behind in it may drop back and let it in.
    #[serde(default)]
    #[ts(skip)]
    pub signal: Option<u8>,
}

/// A change of lanes: from one to the other, from `at` until `until`, in
/// sim ms. While it lasts the car stands in both. It steers across from
/// `along` its way, over `over` of it (the client's path bends there).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq)]
#[ts(export)]
pub struct Shift {
    pub from: u8,
    pub to: u8,
    #[ts(type = "number")]
    pub at: u64,
    #[ts(type = "number")]
    pub until: u64,
    pub along: f64,
    pub over: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
pub enum TerrainType {
    /// The sea: water on the ocean's side of the step in `terrain.rs`, where
    /// a ship can sail. Water is a lake.
    Sea,
    Water,
    Beach,
    Grass,
    Forest,
    Mountain,
}

/// Tiles per chunk edge. Shared by terrain transport and client meshing.
pub const CHUNK_SIZE: i32 = 32;
/// Extra tiles sent around a chunk so the client can derive corner shapes.
pub const CHUNK_SKIRT: i32 = 2;
/// Edge length of a chunk payload, in tiles.
pub const CHUNK_STRIDE: i32 = CHUNK_SIZE + CHUNK_SKIRT * 2;

/// Marks a tile outside the generated world in a chunk payload.
pub const TILE_ABSENT: u8 = 255;

impl TerrainType {
    /// Wire encoding. The client decodes by the same order, so this must not
    /// be reordered without updating it there.
    pub fn to_byte(self) -> u8 {
        match self {
            TerrainType::Water => 0,
            TerrainType::Beach => 1,
            TerrainType::Grass => 2,
            TerrainType::Forest => 3,
            TerrainType::Mountain => 4,
            TerrainType::Sea => 5,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Hash)]
#[ts(export)]
pub struct ChunkCoord {
    pub cx: i32,
    pub cy: i32,
}

/// Terrain is static, so it travels as a block of tile types rather than as
/// entities. The payload carries CHUNK_SKIRT tiles of margin on every side:
/// the client derives corner shapes from surrounding types, reaching up to
/// two tiles past the one it is drawing.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TerrainChunk {
    pub coord: ChunkCoord,
    /// CHUNK_STRIDE^2 bytes, row-major from the chunk origin minus the skirt.
    #[serde(with = "serde_bytes")]
    #[ts(type = "Uint8Array")]
    pub tiles: Vec<u8>,
    /// The mountains' heights over the chunk and a tile round it, eroded
    /// (`mountains.rs`): `mountains::SIDE` by `SIDE` points, `SAMPLES` to
    /// a tile, a row of x at a time from a tile short of its corner, each
    /// two bytes, low first, in `UNIT`s of a tile. Empty off the mountains.
    #[serde(with = "serde_bytes")]
    #[ts(type = "Uint8Array")]
    pub heights: Vec<u8>,
}

/// Someone who lives in the city, and the two buildings their day runs between.
///
/// Deliberately position-less: a resident is not a thing on the map but the
/// reason a car exists. `flush_dirty` only streams entities that have a
/// position, so residents persist and stay entirely server-side for free.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Resident {
    #[ts(type = "number")]
    pub home: EntityId,
    /// `None` while nowhere within reach has a job going.
    #[ts(type = "number | null")]
    pub work: Option<EntityId>,
    /// Where they are: a building, or the car they are riding in. `None` is
    /// off-map — someone who exists but has not driven in yet.
    #[ts(type = "number | null")]
    pub at: Option<EntityId>,
    /// The car they own. Settled alongside homes and jobs; defaults so saves
    /// from before cars were owned settle themselves a car on load.
    #[serde(default)]
    #[ts(type = "number")]
    pub car: EntityId,
    /// What they owe each need. Issued fresh to anyone saved before needs
    /// existed.
    #[serde(default = "crate::needs::Bucket::fresh")]
    pub buckets: Vec<crate::needs::Bucket>,
    /// The need being served where they stand, if any. A record of what is
    /// happening, like `at` — not a plan.
    #[serde(default)]
    pub selected: Option<crate::needs::Need>,
    /// When the buckets were last brought up to date.
    #[serde(default)]
    #[ts(type = "number")]
    pub last_update: u64,
    /// Units of the selected need served since this visit began: drawn
    /// off the shelf it was served from when the visit ends. A record of
    /// what is happening, like `at`.
    #[serde(default)]
    pub tab: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "kind", content = "data")]
pub enum GameObject {
    RoadNode(RoadNode),
    Building(Building),
    Car(Car),
    Resident(Resident),
}

/// Who a player is. Assigned on connect.
pub type OwnerId = u64;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GameObjectEntry {
    #[ts(type = "number")]
    pub id: EntityId,
    pub object: GameObject,
    pub position: Option<GridCoord>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChunkBounds {
    pub min_cx: i32,
    pub min_cy: i32,
    pub max_cx: i32,
    pub max_cy: i32,
}

impl ChunkBounds {
    pub fn coords(&self) -> impl Iterator<Item = ChunkCoord> + '_ {
        (self.min_cy..=self.max_cy)
            .flat_map(move |cy| (self.min_cx..=self.max_cx).map(move |cx| ChunkCoord { cx, cy }))
    }

}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", content = "data")]
pub enum ClientMessage {
    /// A step of a road or the demolisher, built as it is sent.
    Build(Build),
    /// A drag of road, the whole of it so far (`draw.rs`).
    Draw(Stroke),
    /// Where the hand may go (`hint.rs`).
    Ask(Ask),
    /// A building placed whole round `at`, its front this way
    /// (`blueprint::FACINGS`); none, the first way it fits.
    Place { kind: BuildingKind, at: GridCoord, facing: Option<u8> },
    /// A building taken down whole, kept to undo.
    Raze { #[ts(type = "number")] building: EntityId },
    /// The player's last action taken back (`undo.rs`).
    Undo,
    DespawnAllCars,
    /// Packages of a good bought from the market or sold to it (`market::trade`).
    Trade { good: Good, packages: u32, out: bool },
    /// Packages a letter wants, sent (`orders::send`).
    Send { #[ts(type = "number")] letter: u64, packages: u32 },
    /// Packages bought once the price falls to this, or sold once it rises to it.
    Order { good: Good, out: bool, packages: u32, price: f64 },
    Cancel { #[ts(type = "number")] order: u64 },
    /// Buy a depot another lorry from the world.
    BuyLorry { #[ts(type = "number")] depot: EntityId },
    /// The card of one thing on the map, asked for again while it is open.
    Card(#[ts(type = "number")] EntityId),
    /// Sim steps per tick. 0 pauses; dev-only, and it moves the whole world.
    SetSpeed(u32),
    ResetWorld,
    SetChunks(ChunkBounds),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "op", content = "data")]
pub enum Operation {
    Upsert(Box<GameObjectEntry>),
    Delete(#[ts(type = "number")] EntityId),
}

/// Simulated time of one full day/night cycle.
///
/// This is the scale of the whole game rather than a cosmetic setting. A tile
/// is about 12 m — a car is 0.35 tiles long and a car is 4.2 m, and a one-tile
/// road is a 12 m two-way street — so CRUISE_SPEED works out at 65 km/h and a
/// chunk is 384 m across. Against a twenty-minute day an hour is 900 m of
/// driving, putting a town commute at half an hour and a crossing of a
/// sprawling city at four, which is what earns a highway. At two minutes, the
/// length this was, that same crossing took two days.
pub const DAY_MS: u32 = 1_200_000;
/// An hour of the clock.
pub const HOUR: u32 = DAY_MS / 24;

/// The simulation's clock, as the client needs to see it.
///
/// `speed` is how many 10ms steps the server runs per tick, so it is also the
/// rate sim time advances relative to wall time — the client extrapolates car
/// positions with it between updates.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Clock {
    #[ts(type = "number")]
    pub now: u64,
    pub speed: u32,
    pub day_ms: u32,
}

/// How the city is doing, as the two dials read it.
///
/// The level is the town's GDP to date.
/// The treasury is the mayor's coins, stepped as goods cross the border.
/// Neither is extrapolated: a dial that steps is the event landing.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Growth {
    pub level: u32,
    /// GDP since the level was reached, and what the next takes.
    pub toward: f64,
    pub needed: f64,
    /// GDP added in town today so far.
    pub gdp: f64,
    /// What the town has to spend, in coins: earned at the border, net of
    /// what it bought and built.
    pub treasury: f64,
    /// Today's net at the border so far, and what went out: the treasury
    /// over it is days of imports left.
    pub income: f64,
    pub imports: f64,
    /// Every standing depot's shelves added up, wherever the camera is:
    /// none, no depot yet.
    pub held: std::collections::BTreeMap<Good, crate::needs::Stock>,
}

/// Something landing on a building: coins as goods cross the border, a
/// load sold to the world or a delivery bought from it, negative leaving;
/// or GDP as value is added there, a meal served, a crop cut, a shift
/// worked at a desk. docs/trade.md.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Lump {
    #[ts(type = "number")]
    pub building: EntityId,
    pub coins: f64,
    pub gdp: f64,
    #[ts(type = "number")]
    pub at: u64,
    /// Or goods landing: a package unloaded onto a depot's pad; or, less
    /// than none, leaving it: stone off its pad for a road laid.
    #[serde(default)]
    pub good: Option<Good>,
    #[serde(default)]
    pub units: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StateUpdate {
    pub ops: Vec<Operation>,
    /// Lumps that landed on buildings in view since the last update.
    #[serde(default)]
    pub lumps: Vec<Lump>,
    pub clock: Clock,
    pub growth: Growth,
    /// Every shipment on its way and every harbour's timetable.
    #[serde(default)]
    pub sea: Sea,
    /// The town's open missions, and those just finished.
    #[serde(default)]
    pub missions: Vec<crate::missions::Mission>,
    /// The mayors of the towns beyond the edge, and how they stand.
    #[serde(default)]
    pub neighbours: Vec<crate::orders::Neighbour>,
    /// The island's map, which the client keeps its camera inside.
    pub island: ChunkBounds,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", content = "data")]
pub enum ServerMessage {
    /// Who you are.
    Welcome(#[ts(type = "number")] OwnerId),
    Update(StateUpdate),
    TerrainChunk(TerrainChunk),
    UnloadChunk(ChunkCoord),
    /// What the town did with the mayor's coins of its own accord, or more
    /// than it was asked: stone bought express. And
    /// what the hand did, to its player alone: an undo, a building refused.
    News(Vec<News>),
    /// The answer to an `Ask`.
    Hint(Hint),
    /// The market's prices, its week and the orders waiting: on joining,
    /// and whenever they change.
    Market(crate::market::Prices),
    /// The answer to a `Card`.
    Card(crate::card::Card),
}

/// A line of news, and the building a tap on it goes to.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct News {
    pub text: String,
    pub sub: String,
    #[ts(type = "number")]
    pub at: EntityId,
}


