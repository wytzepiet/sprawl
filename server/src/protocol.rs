use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub type EntityId = u64;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Hash)]
#[ts(export)]
pub struct GridCoord {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PlaceRoad {
    pub from: GridCoord,
    pub to: GridCoord,
    pub one_way: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RoadNode {
    #[ts(type = "Array<number>")]
    pub neighbors: Vec<EntityId>,
    #[ts(type = "Array<number>")]
    pub incoming: Vec<EntityId>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
pub enum BuildingType {
    CarSpawner,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Building {
    pub building_type: BuildingType,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PlaceBuilding {
    pub pos: GridCoord,
    pub building_type: BuildingType,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Car {
    #[ts(type = "Array<number>")]
    pub route: Vec<EntityId>,
    /// Cumulative distance along the route
    pub progress: f64,
    pub speed: f64,
    pub acceleration: f64,
    /// Total arc length of the entire route
    pub total_route_length: f64,
    #[ts(type = "number")]
    pub updated_at: u64,
    #[serde(skip)]
    #[ts(skip)]
    pub plan_gen: u32,
    /// Current segment index (1-based, internal only)
    #[serde(skip)]
    #[ts(skip)]
    pub route_index: usize,
    /// Cumulative distance to start of current segment
    #[serde(skip)]
    #[ts(skip)]
    pub seg_start_dist: f64,
    /// Arc length of current segment
    #[serde(skip)]
    #[ts(skip)]
    pub seg_length: f64,
    /// Distance into segment where the bezier corner starts
    #[serde(skip)]
    #[ts(skip)]
    pub seg_corner_start: f64,
    /// Precomputed target speed at each route node (backward pass)
    #[serde(skip)]
    #[ts(skip)]
    pub target_speeds: Vec<f64>,
    /// Which intersection this car is currently waiting at
    #[serde(skip)]
    #[ts(skip)]
    pub waiting_at_intersection: Option<EntityId>,
    /// Precomputed route indices that are intersections (interior nodes only)
    #[serde(skip)]
    #[ts(skip)]
    pub intersection_stops: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "kind", content = "data")]
pub enum GameObject {
    RoadNode(RoadNode),
    Building(Building),
    Car(Car),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GameObjectEntry {
    #[ts(type = "number")]
    pub id: EntityId,
    pub object: GameObject,
    pub position: Option<GridCoord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ErrorMessage {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DemolishRoad {
    pub pos: GridCoord,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", content = "data")]
pub enum ClientMessage {
    PlaceRoad(PlaceRoad),
    PlaceBuilding(PlaceBuilding),
    DemolishRoad(DemolishRoad),
    ResetWorld,
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "op", content = "data")]
pub enum Operation {
    Upsert(GameObjectEntry),
    Delete(#[ts(type = "number")] EntityId),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StateUpdate {
    pub ops: Vec<Operation>,
    #[ts(type = "number")]
    pub server_time: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", content = "data")]
pub enum ServerMessage {
    Update(StateUpdate),
    Error(ErrorMessage),
    Pong(#[ts(type = "number")] u64),
}
