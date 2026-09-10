pub mod bezier;
mod buildings;
mod geometry;
pub mod lots;
pub mod network;
pub mod pathfinding;
mod residents;
pub mod roads;
pub mod segments;

use std::collections::{BTreeSet, HashMap, HashSet};

use crate::engine::GameTime;

use crate::protocol::{
    CHUNK_SIZE, CHUNK_SKIRT, CHUNK_STRIDE, ChunkBounds, ChunkCoord, EdgeKey, EntityId,
    GameObject, TILE_ABSENT, TerrainChunk, TerrainType,
};
use crate::engine::tracked::Tracked;
use crate::world::network::RoadNetwork;
use crate::world::segments::EdgeSegment;

pub struct World {
    pub objects: Tracked,
    /// Entities by chunk. Chunk-granular because that is the unit clients
    /// subscribe to; exact-tile queries filter a chunk's set, which stays small
    /// now that terrain is not an entity.
    pub(super) spatial: HashMap<ChunkCoord, HashSet<EntityId>>,
    pub edges: HashMap<EdgeKey, EdgeSegment>,
    /// Every lot, by the run of lot tiles it is, built when first asked
    /// for; see `lots.rs`.
    pub lots: lots::Lots,
    /// Which lot each building is on.
    pub lot_of: HashMap<EntityId, lots::RunKey>,
    /// Where each lot node is: off the grid, and not an entity.
    pub lot_nodes: HashMap<EntityId, [f64; 2]>,
    /// Which lot each car holds a place in.
    pub claims: HashMap<EntityId, lots::RunKey>,
    /// Who can reach whom, kept in step with `edges` — the one gate the
    /// committed road graph passes through, so nothing that lays or pulls up a
    /// road has to know this index exists.
    pub network: RoadNetwork,
    /// Where each moving car joined the run of road it is on, which way it set
    /// off, and when. The direction is what names the run: two runs can share
    /// both ends, so the junction alone would not say which one is being
    /// driven. Disposable — a car with no entry here simply does not report
    /// its first stretch, and the next junction starts it off.
    pub car_segment: HashMap<EntityId, (EntityId, EntityId, crate::engine::GameTime)>,
    /// Maps node_id → set of car_ids whose route passes through that node.
    pub node_cars: HashMap<EntityId, HashSet<EntityId>>,
    pub terrain_seed: u32,
    /// Every building's books: what came in, what went out, what its taps
    /// served, today and yesterday. Learned, not saved — a loaded world
    /// starts counting afresh.
    pub books: HashMap<EntityId, crate::economy::Books>,
    /// The treasury's own books: what swept in, today and yesterday.
    pub income: crate::economy::Books,
    /// GDP to date: value served in town at the world's prices, banked as
    /// each visit ends. The level is its running sum; today's rate is what
    /// it has grown since midnight.
    pub gdp: f64,
    pub gdp_at_midnight: f64,
    /// The mayor's money, in hours of the edge's wage. docs/economy.md §8.2.
    pub treasury: f64,
    /// Money that landed on buildings since the last flush, for the clients
    /// looking at them.
    pub sales: Vec<crate::protocol::Sale>,
    /// The nodes of the tree the player has taken: the gate for everything
    /// the city may do. See `tree.rs`.
    pub build: crate::tree::Build,
    /// Tiles of road the mayor has laid, against the build's allowance.
    /// Derived at startup from the nodes' own flag, like every other index.
    pub laid: u32,
    /// Tile types for the whole world, regenerated from the seed at startup.
    pub terrain: HashMap<(i32, i32), TerrainType>,
    /// Entities that changed chunk since the last flush, as (id, from, to).
    /// Chunks are what clients subscribe to, so a crossing is the exact moment
    /// an entity enters or leaves someone's view.
    pub chunk_crossings: Vec<(EntityId, ChunkCoord, ChunkCoord)>,
    /// Chunks the world has been revealed in. Terrain outside this set is not
    /// sent, so looking somewhere is not enough to see it — a building has to
    /// have reached. Derived from building positions, like every other index.
    pub revealed: HashSet<ChunkCoord>,
    /// Chunks revealed since the last flush, for pushing terrain to clients
    /// already looking at them.
    pub newly_revealed: Vec<ChunkCoord>,
    /// Extent of `revealed`. The client clamps the camera to it, so it has to
    /// know the whole survey, not just the part it happens to be looking at.
    pub revealed_bounds: ChunkBounds,
    /// Chunks whose procedural roads have been laid. Derived at startup from
    /// where road already stands, like every other index — a chunk with road
    /// in it has been through this once.
    pub roads_generated: HashSet<ChunkCoord>,
    /// Tile → building covering it. Buildings span several tiles but carry one
    /// position, so without this "what is on this tile" would only ever find a
    /// building at its origin corner. Derived, like every other index.
    pub occupied: HashMap<(i32, i32), EntityId>,
    /// Calls raised and not yet resolved. Not saved: a shop still low when
    /// the world comes back calls again at its next visit.
    pub calls: Vec<crate::calls::Call>,
    /// Tile → the road node on it. Asked for constantly — every driveway
    /// check, every bend, every site the placer tries — and a chunk's
    /// entity set was being walked for each answer. Derived at load.
    pub roads: HashMap<(i32, i32), EntityId>,
    /// The buildings standing at the road exits: the world beyond the map,
    /// one for each road that runs off it. Derived from the road graph by
    /// `stand_edges`, never placed and never saved.
    pub edge: BTreeSet<EntityId>,
}

/// Marks an empty box: max below min, so the first reveal replaces it outright.
const NO_BOUNDS: ChunkBounds = ChunkBounds { min_cx: 0, min_cy: 0, max_cx: -1, max_cy: -1 };

/// How far a building sees, in tiles. Generous on purpose: the frontier has to
/// stay ahead of what you have built, or you are siting blind — a chunk and a
/// half beyond, so there is always ground in view to build the next thing on.
const REVEAL_RADIUS: i32 = 80;

use crate::protocol::GridCoord;

pub fn chunk_of(coord: GridCoord) -> ChunkCoord {
    ChunkCoord {
        cx: coord.x.div_euclid(CHUNK_SIZE),
        cy: coord.y.div_euclid(CHUNK_SIZE),
    }
}

impl World {
    pub fn unindex(&mut self, id: EntityId, coord: GridCoord) {
        if let Some(ids) = self.spatial.get_mut(&chunk_of(coord)) {
            ids.remove(&id);
        }
    }
    pub fn new() -> Self {
        Self {
            objects: Tracked::new(),
            spatial: HashMap::new(),
            edges: HashMap::new(),
            lots: HashMap::new(),
            lot_of: HashMap::new(),
            lot_nodes: HashMap::new(),
            claims: HashMap::new(),
            network: RoadNetwork::default(),
            car_segment: HashMap::new(),
            node_cars: HashMap::new(),
            terrain_seed: 0,
            books: HashMap::new(),
            income: Default::default(),
            gdp: 0.0, gdp_at_midnight: 0.0,
            treasury: crate::economy::STAKE,
            sales: Vec::new(),
            build: Default::default(),
            laid: 0,
            terrain: HashMap::new(),
            chunk_crossings: Vec::new(),
            revealed: HashSet::new(),
            newly_revealed: Vec::new(),
            revealed_bounds: NO_BOUNDS,
            occupied: HashMap::new(),
            roads: HashMap::new(),
            calls: Vec::new(),
            roads_generated: HashSet::new(),
            edge: BTreeSet::new(),
        }
    }

    pub fn from_loaded(objects: Tracked, terrain_seed: u32) -> Self {
        let mut world = Self {
            spatial: HashMap::new(),
            edges: HashMap::new(),
            lots: HashMap::new(),
            lot_of: HashMap::new(),
            lot_nodes: HashMap::new(),
            claims: HashMap::new(),
            network: RoadNetwork::default(),
            car_segment: HashMap::new(),
            node_cars: HashMap::new(),
            terrain_seed,
            books: HashMap::new(),
            income: Default::default(),
            gdp: 0.0, gdp_at_midnight: 0.0,
            treasury: 0.0,
            sales: Vec::new(),
            build: Default::default(),
            laid: 0,
            terrain: HashMap::new(),
            chunk_crossings: Vec::new(),
            revealed: HashSet::new(),
            newly_revealed: Vec::new(),
            revealed_bounds: NO_BOUNDS,
            occupied: HashMap::new(),
            roads: HashMap::new(),
            calls: Vec::new(),
            roads_generated: HashSet::new(),
            edge: BTreeSet::new(),
            objects,
        };
        // Rebuild the spatial index and the road index from loaded objects.
        for entry in world.objects.all_entries() {
            if let Some(pos) = entry.position {
                world.spatial.entry(chunk_of(pos)).or_default().insert(entry.id);
                if matches!(entry.object, GameObject::RoadNode(_)) {
                    world.roads.insert((pos.x, pos.y), entry.id);
                }
            }
        }
        world
    }

    /// Rebuild edges from the road graph. Only needed when loading saved state.
    pub fn rebuild_edges(&mut self) {
        self.edges.clear();
        self.network = RoadNetwork::default();
        let entries: Vec<_> = self.objects.all_entries().iter()
            .filter_map(|e| {
                if let GameObject::RoadNode(ref node) = e.object {
                    Some((e.id, node.outgoing.clone()))
                } else {
                    None
                }
            })
            .collect();
        for (id, _) in &entries {
            let beyond = self.objects.get(*id).and_then(|e| e.position).is_some_and(|p| !self.revealed.contains(&chunk_of(p)));
            self.network.set_exit(*id, beyond);
        }
        for (id, outgoing) in &entries {
            for neighbor in outgoing {
                let len = self.segment_length(*id, *neighbor);
                self.edges.insert((*id, *neighbor), EdgeSegment::new(len));
                self.network.link(*id, *neighbor, len);
            }
        }
        self.mark_joined(entries.iter().map(|(id, _)| *id));
    }

    /// Take a car off every edge deque along its route. Not just the edge it
    /// was last seen on: a lot's edges are short, a car can cross several in
    /// one wake, and a car that parks without being taken off the ones it
    /// crossed is a ghost the traffic behind it waits on for ever.
    pub fn remove_car_from_edges(&mut self, car_id: EntityId) {
        if let Some(entry) = self.objects.get(car_id)
            && let GameObject::Car(ref car) = entry.object
            && let Some(ref trip) = car.trip
        {
            for w in trip.route.windows(2) {
                if let Some(seg) = self.edges.get_mut(&(w[0], w[1])) {
                    seg.cars.retain(|&id| id != car_id);
                }
            }
        }
    }

    /// Remove a car from the world entirely — scrap, not parking.
    /// A lorry drives off the map: off the roads and out of sight, its dock
    /// let go of, until `until`, when it comes back in.
    pub fn leave_map(&mut self, car_id: EntityId, until: GameTime) {
        self.release_spot(car_id);
        self.car_segment.remove(&car_id);
        self.remove_car_from_edges(car_id);
        if let Some(entry) = self.objects.get(car_id)
            && let Some(pos) = entry.position
        {
            self.unindex(car_id, pos);
        }
        if let Some(entry) = self.objects.get_mut(car_id) {
            entry.position = None;
            if let GameObject::Car(ref mut c) = entry.object {
                c.trip = None;
                c.spot = None;
                c.away = until;
            }
        }
    }

    pub fn despawn_car(&mut self, car_id: EntityId) {
        self.release_spot(car_id);
        self.car_segment.remove(&car_id);
        self.remove_car_from_edges(car_id);
        if let Some(entry) = self.objects.get(car_id)
            && let Some(pos) = entry.position
        {
            self.unindex(car_id, pos);
        }
        self.objects.remove(car_id);
    }

    /// Insert an entity and register it in the spatial index.
    ///
    /// Everything positioned must go through here: the viewport query reads
    /// `spatial`, so an entity missing from it is invisible to clients.
    pub fn insert_at(&mut self, object: GameObject, pos: Option<GridCoord>) -> EntityId {
        let id = self.objects.insert(object, pos);
        if let Some(pos) = pos {
            self.spatial.entry(chunk_of(pos)).or_default().insert(id);
        }
        id
    }

    /// The standing buildings in one chunk, by id, so a search over them
    /// comes out the same however the set iterated.
    pub fn buildings_in(&self, chunk: ChunkCoord) -> Vec<EntityId> {
        let mut ids: Vec<EntityId> = self
            .spatial
            .get(&chunk)
            .into_iter()
            .flatten()
            .copied()
            .filter(|&id| {
                self.objects
                    .get(id)
                    .is_some_and(|e| matches!(e.object, GameObject::Building(_)))
            })
            .collect();
        ids.sort_unstable();
        ids
    }

    /// The nearest road exit to a tile, as a building: the door everything
    /// from beyond the map comes in by, and the last stop of everything
    /// leaving. By id at a tie, so a world answers the same way however its
    /// sets iterate.
    pub fn nearest_edge(&self, pos: GridCoord) -> Option<EntityId> {
        self.edge
            .iter()
            .filter_map(|&b| Some((b, self.objects.get(b)?.position?)))
            .min_by_key(|&(b, p)| ((p.x - pos.x).abs().max((p.y - pos.y).abs()), b))
            .map(|(b, _)| b)
    }

    /// The road that door stands on: where a car appears from off the map,
    /// and where one drives off it.
    pub fn entry_node_near(&self, pos: GridCoord) -> Option<EntityId> {
        self.road_node_for_building(self.nearest_edge(pos)?)
    }

    /// Stand a building at every road exit — every stretch of the survey's
    /// road that runs off the map, at the tile where it crosses out of what
    /// has been surveyed. Everything the city lacks is served there, so the
    /// search finds one like any other shop; see `blueprint.rs`.
    ///
    /// Derived from the road graph rather than remembered, like every other
    /// index: the frontier moves as the map is revealed and the doors move
    /// with it, and running this twice changes nothing.
    pub fn stand_edges(&mut self) {
        let doors: HashSet<EntityId> = self
            .network
            .exits()
            .collect::<Vec<_>>()
            .into_iter()
            .filter(|&n| self.arms_of(n, false).iter().any(|&a| !self.network.is_exit(a)))
            .collect();
        let standing: HashMap<EntityId, EntityId> = self
            .edge
            .iter()
            .filter_map(|&b| Some((self.road_node_for_building(b)?, b)))
            .collect();
        for (node, building) in &standing {
            if !doors.contains(node) {
                self.drop_edge(*building);
            }
        }
        for node in doors {
            if standing.contains_key(&node) {
                continue;
            }
            let Some(pos) = self.objects.get(node).and_then(|e| e.position) else { continue };
            // Straight in at the road, with no plot and no land under it:
            // the tile is the road's, and the building is only what stands
            // for what lies past it.
            let id = self.insert_at(
                GameObject::Building(crate::protocol::Building::new(crate::protocol::BuildingKind::Edge, (1, 1), 2)),
                Some(pos),
            );
            self.edge.insert(id);
        }
    }

    /// Take one down: the road it stood on is inside the survey now, or gone.
    fn drop_edge(&mut self, building: EntityId) {
        self.drop_lot(building);
        if let Some(pos) = self.objects.get(building).and_then(|e| e.position) {
            self.unindex(building, pos);
        }
        self.objects.remove(building);
        self.edge.remove(&building);
    }

    /// Update the spatial position of an entity.
    pub fn update_position(&mut self, id: EntityId, new_pos: GridCoord) {
        if let Some(entry) = self.objects.get(id) {
            if entry.position == Some(new_pos) {
                return;
            }
            if let Some(old_pos) = entry.position {
                let (from, to) = (chunk_of(old_pos), chunk_of(new_pos));
                if from != to {
                    self.unindex(id, old_pos);
                    self.chunk_crossings.push((id, from, to));
                }
            }
        }
        self.spatial.entry(chunk_of(new_pos)).or_default().insert(id);
        if let Some(entry) = self.objects.get_mut_silent(id) {
            entry.position = Some(new_pos);
        }
    }

    /// Find the car behind a given car on the same edge.
    pub fn car_behind_on_edge(&self, edge: EdgeKey, car_id: EntityId) -> Option<EntityId> {
        let seg = self.edges.get(&edge)?;
        let pos = seg.car_position(car_id)?;
        if pos + 1 < seg.cars.len() {
            Some(seg.cars[pos + 1])
        } else {
            None
        }
    }

    /// Insert an edge for a directed connection between two nodes.
    ///
    /// `edges` is what traffic reads, so this is the one gate that keeps drafts
    /// out of the simulation: a road that has not been committed carries no
    /// cars, however completely it is drawn. A road merely *marked* for removal
    /// still carries them — that marker is visual until the moment it commits.
    pub fn insert_edge(&mut self, from: EntityId, to: EntityId) {
        let len = self.segment_length(from, to);
        self.edges.insert((from, to), EdgeSegment::new(len));
        let turning = self.network.link(from, to, len);
        self.mark_joined(turning.into_iter().chain([from, to]));
    }

    /// Keep nodes' marks in step with their network: joined to the world
    /// beyond the survey, or an island. Only the nodes named are touched, and
    /// only those whose mark actually changed are sent.
    fn mark_joined(&mut self, ids: impl IntoIterator<Item = EntityId>) {
        for id in ids {
            let joined = self.network.joined(id);
            let stale = matches!(
                self.objects.get(id).map(|e| &e.object),
                Some(GameObject::RoadNode(n)) if n.joined != joined
            );
            if stale
                && let Some(e) = self.objects.get_mut(id)
                && let GameObject::RoadNode(ref mut n) = e.object
            {
                n.joined = joined;
            }
        }
    }

    /// Remove an edge.
    ///
    /// The network is undirected — a one-way pair is still one piece of city —
    /// so it only comes apart once the last direction is gone.
    pub fn remove_edge(&mut self, from: EntityId, to: EntityId) {
        self.edges.remove(&(from, to));
        if !self.edges.contains_key(&(to, from)) {
            let turning = self.network.unlink(from, to);
            self.mark_joined(turning.into_iter().chain([from, to]));
        }
    }

    /// Collect all edge keys involving a node (as from or to).
    pub fn edges_involving(&self, node_id: EntityId) -> Vec<EdgeKey> {
        self.edges.keys()
            .filter(|&&(from, to)| from == node_id || to == node_id)
            .copied()
            .collect()
    }

    pub fn register_car_route(&mut self, car_id: EntityId, route: &[EntityId]) {
        for &node in route {
            self.node_cars.entry(node).or_default().insert(car_id);
        }
    }

    pub fn unregister_car_route(&mut self, car_id: EntityId, route: &[EntityId]) {
        for &node in route {
            if let Some(set) = self.node_cars.get_mut(&node) {
                set.remove(&car_id);
            }
        }
    }

    /// Reveal everything within REVEAL_RADIUS of a tile, chunk-granular.
    ///
    /// Monotonic: a chunk never leaves the set. Terrain does not change, so
    /// re-hiding it would only make the map flicker as a city's shape shifts.
    pub fn reveal_around(&mut self, pos: GridCoord) {
        let min = chunk_of(GridCoord { x: pos.x - REVEAL_RADIUS, y: pos.y - REVEAL_RADIUS });
        let max = chunk_of(GridCoord { x: pos.x + REVEAL_RADIUS, y: pos.y + REVEAL_RADIUS });
        let mut moved = false;
        for cy in min.cy..=max.cy {
            for cx in min.cx..=max.cx {
                let coord = ChunkCoord { cx, cy };
                if self.revealed.insert(coord) {
                    moved = true;
                    self.newly_revealed.push(coord);
                    self.grow_bounds(coord);
                    // Road here is surveyed now, not the world beyond. The
                    // road that runs on past the new frontier is laid before
                    // any client hears of this, so nothing flashes red.
                    let here: Vec<EntityId> = self.spatial.get(&coord).into_iter().flatten().copied().collect();
                    for id in here {
                        if matches!(self.objects.get(id).map(|e| &e.object), Some(GameObject::RoadNode(_))) {
                            let turning = self.network.set_exit(id, false);
                            self.mark_joined(turning);
                        }
                    }
                }
            }
        }
        // The frontier moved, so the doors onto the world beyond it have.
        if moved {
            self.stand_edges();
        }
    }

    fn grow_bounds(&mut self, c: ChunkCoord) {
        let b = &mut self.revealed_bounds;
        if b.max_cx < b.min_cx {
            *b = ChunkBounds { min_cx: c.cx, min_cy: c.cy, max_cx: c.cx, max_cy: c.cy };
            return;
        }
        b.min_cx = b.min_cx.min(c.cx);
        b.min_cy = b.min_cy.min(c.cy);
        b.max_cx = b.max_cx.max(c.cx);
        b.max_cy = b.max_cy.max(c.cy);
    }

    /// Rebuild the revealed set from building positions on startup. Nothing is
    /// newly revealed from a client's point of view, so the queue is dropped.
    /// Which chunks already hold road, so generation does not lay it twice.
    pub fn rebuild_roads_generated(&mut self) {
        let chunks: Vec<ChunkCoord> = self
            .objects
            .all_entries()
            .iter()
            .filter(|e| matches!(e.object, GameObject::RoadNode(_)))
            .filter_map(|e| e.position.map(chunk_of))
            .collect();
        self.roads_generated.extend(chunks);
    }

    /// Every road link in the world, as the path search reads them.
    pub fn road_edge_set(&self) -> HashSet<((i32, i32), (i32, i32))> {
        let mut out = HashSet::new();
        for entry in self.objects.all_entries() {
            let GameObject::RoadNode(ref node) = entry.object else { continue };
            let Some(a) = entry.position else { continue };
            for id in node.outgoing.iter().chain(node.incoming.iter()) {
                if let Some(b) = self.objects.get(*id).and_then(|e| e.position) {
                    out.insert(((a.x, a.y), (b.x, b.y)));
                }
            }
        }
        out
    }

    pub fn rebuild_revealed(&mut self) {
        let positions: Vec<GridCoord> = self
            .objects
            .all_entries()
            .iter()
            .filter(|e| matches!(e.object, GameObject::Building(_)))
            .filter_map(|e| e.position)
            .collect();
        for pos in positions {
            self.reveal_around(pos);
        }
        self.newly_revealed.clear();
    }

    /// Serialise one chunk's tile types, including the skirt the client needs
    /// to derive corner shapes. Tiles outside the generated world are marked
    /// absent so the client renders nothing there.
    pub fn terrain_chunk(&self, coord: ChunkCoord) -> TerrainChunk {
        let origin_x = coord.cx * CHUNK_SIZE - CHUNK_SKIRT;
        let origin_y = coord.cy * CHUNK_SIZE - CHUNK_SKIRT;
        let mut tiles = Vec::with_capacity((CHUNK_STRIDE * CHUNK_STRIDE) as usize);
        for dy in 0..CHUNK_STRIDE {
            for dx in 0..CHUNK_STRIDE {
                let (x, y) = (origin_x + dx, origin_y + dy);
                tiles.push(match self.terrain.get(&(x, y)) {
                    Some(&t) => t.to_byte(),
                    None => TILE_ABSENT,
                });
            }
        }
        TerrainChunk { coord, tiles }
    }

    /// Every entity in the given chunks.
    pub fn entities_in_chunks(&self, chunks: &HashSet<ChunkCoord>) -> HashSet<EntityId> {
        let mut result = HashSet::new();
        for coord in chunks {
            if let Some(ids) = self.spatial.get(coord) {
                result.extend(ids);
            }
        }
        result
    }

    /// Rebuild node_cars index from all existing cars.
    pub fn rebuild_node_cars(&mut self) {
        self.node_cars.clear();
        let routes: Vec<(EntityId, Vec<EntityId>)> = self.objects.all_entries()
            .iter()
            .filter_map(|e| {
                if let GameObject::Car(ref car) = e.object {
                    car.trip.as_ref().map(|t| (e.id, t.route.clone()))
                } else {
                    None
                }
            })
            .collect();
        for (car_id, route) in routes {
            self.register_car_route(car_id, &route);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::BuildingKind;

    /// A long road across open ground, and one house on it. Revealing the
    /// ground around the house leaves the far end of the road beyond the
    /// survey, which is what a road exit is.
    fn frontier() -> (World, EntityId) {
        let mut world = World::new();
        for y in -4..4 {
            for x in -4..400 {
                world.terrain.insert((x, y), TerrainType::Grass);
            }
        }
        world.place_road_path(&(-2..400).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>());
        let house = world.place_on_street(GridCoord { x: 0, y: 1 }, BuildingKind::House).expect("a driveway");
        (world, house)
    }

    /// One building stands where the road crosses out of the survey, and
    /// only there: the road runs on for chunks past it, and none of that is
    /// a door.
    #[test]
    fn the_edge_stands_where_the_road_leaves_the_map() {
        let (world, _) = frontier();
        assert_eq!(world.edge.len(), 1, "one road out, one door");
        let door = *world.edge.iter().next().unwrap();
        let node = world.road_node_for_building(door).expect("the door stands on the road");
        assert!(world.network.is_exit(node), "the door is beyond the survey");
        let pos = world.objects.get(door).unwrap().position.unwrap();
        assert!(!world.revealed.contains(&chunk_of(pos)), "the door is past the frontier");
        assert!(
            world.revealed.contains(&chunk_of(GridCoord { x: pos.x - 1, y: pos.y })),
            "and the tile behind it is inside",
        );
    }

    /// Build out toward it and the frontier moves; the door moves with it,
    /// rather than piling up behind.
    #[test]
    fn the_door_moves_with_the_frontier() {
        let (mut world, _) = frontier();
        let was = world.objects.get(*world.edge.iter().next().unwrap()).unwrap().position.unwrap();
        world.place_on_street(GridCoord { x: 120, y: 1 }, BuildingKind::House).expect("a driveway");
        assert_eq!(world.edge.len(), 1, "one road out is still one door");
        let now = world.objects.get(*world.edge.iter().next().unwrap()).unwrap().position.unwrap();
        assert!(now.x > was.x, "the door stayed at {was:?} while the survey grew");
    }

    /// Standing them again changes nothing: it is derived from the roads,
    /// so it can run after any commit.
    #[test]
    fn standing_the_edge_twice_stands_one_edge() {
        let (mut world, _) = frontier();
        let before: Vec<EntityId> = world.edge.iter().copied().collect();
        world.stand_edges();
        world.stand_edges();
        assert_eq!(world.edge.iter().copied().collect::<Vec<_>>(), before);
    }

    /// A world nobody has surveyed has no doors: every road is beyond the
    /// edge, so no road crosses out of it.
    #[test]
    fn an_unsurveyed_world_has_no_doors() {
        let mut world = World::new();
        for x in -4..40 {
            world.terrain.insert((x, 0), TerrainType::Grass);
        }
        world.place_road_path(&(0..40).map(|x| GridCoord { x, y: 0 }).collect::<Vec<_>>());
        world.stand_edges();
        assert!(world.edge.is_empty());
        assert!(world.nearest_edge(GridCoord { x: 0, y: 0 }).is_none());
    }
}
