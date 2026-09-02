pub mod bezier;
mod buildings;
mod geometry;
pub mod network;
pub mod pathfinding;
mod residents;
mod roads;
pub mod segments;

use std::collections::{HashMap, HashSet};

use crate::protocol::{
    CHUNK_SIZE, CHUNK_SKIRT, CHUNK_STRIDE, ChunkBounds, ChunkCoord, Draft, EdgeKey, EntityId,
    GameObject, OwnerId, TILE_ABSENT, TerrainChunk, TerrainType,
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
    /// How much longer journeys are taking than empty roads would promise,
    /// learned from every arrival. Residents leave this much earlier, so
    /// congestion feeds back into when — and whether — trips happen.
    pub delay: f64,
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
    /// Uncommitted entities by owner. Derived from the `draft` field, like
    /// every other index, and rebuilt at startup — where it always comes out
    /// empty, since drafts are never saved.
    pub drafts: HashMap<OwnerId, HashSet<EntityId>>,
    /// Who the current player action belongs to, for the duration of that
    /// action. Ambient rather than a parameter on every creation path: laying a
    /// driveway is three calls deep, and an owner threaded through all of them
    /// would be forwarded by every one and read by none.
    pub acting_as: Option<OwnerId>,
    /// Tile → building covering it. Buildings span several tiles but carry one
    /// position, so without this "what is on this tile" would only ever find a
    /// building at its origin corner. Derived, like every other index.
    pub occupied: HashMap<(i32, i32), EntityId>,
}

/// What a commit turned into. Removals are handed back rather than performed
/// here because demolishing has to account for the cars on the road, which is
/// the game loop's business.
#[derive(Default)]
pub struct Committed {
    pub added: Vec<EntityId>,
    pub removed: Vec<EntityId>,
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
    /// Entity ids at an exact tile.
    pub(super) fn ids_at(&self, coord: GridCoord) -> Vec<EntityId> {
        let Some(ids) = self.spatial.get(&chunk_of(coord)) else {
            return Vec::new();
        };
        ids.iter()
            .copied()
            .filter(|id| {
                self.objects.get(*id).and_then(|e| e.position) == Some(coord)
            })
            .collect()
    }

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
            network: RoadNetwork::default(),
            car_segment: HashMap::new(),
            node_cars: HashMap::new(),
            terrain_seed: 0,
            delay: 1.0,
            terrain: HashMap::new(),
            chunk_crossings: Vec::new(),
            revealed: HashSet::new(),
            newly_revealed: Vec::new(),
            revealed_bounds: NO_BOUNDS,
            occupied: HashMap::new(),
            drafts: HashMap::new(),
            acting_as: None,
            roads_generated: HashSet::new(),
        }
    }

    pub fn from_loaded(objects: Tracked, terrain_seed: u32) -> Self {
        let mut world = Self {
            spatial: HashMap::new(),
            edges: HashMap::new(),
            network: RoadNetwork::default(),
            car_segment: HashMap::new(),
            node_cars: HashMap::new(),
            terrain_seed,
            delay: 1.0,
            terrain: HashMap::new(),
            chunk_crossings: Vec::new(),
            revealed: HashSet::new(),
            newly_revealed: Vec::new(),
            revealed_bounds: NO_BOUNDS,
            occupied: HashMap::new(),
            drafts: HashMap::new(),
            acting_as: None,
            roads_generated: HashSet::new(),
            objects,
        };
        // Rebuild spatial index from loaded objects
        for entry in world.objects.all_entries() {
            if let Some(pos) = entry.position {
                world.spatial.entry(chunk_of(pos)).or_default().insert(entry.id);
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
        for (id, outgoing) in entries {
            for neighbor in outgoing {
                let len = self.segment_length(id, neighbor);
                self.edges.insert((id, neighbor), EdgeSegment::new(len));
                self.network.link(id, neighbor, len);
            }
        }
    }

    /// Take a car off the edge deques it is registered on — the current edge
    /// and any pre-registration on the next.
    pub fn remove_car_from_edges(&mut self, car_id: EntityId) {
        if let Some(entry) = self.objects.get(car_id)
            && let GameObject::Car(ref car) = entry.object
            && let Some(ref trip) = car.trip
        {
            let ri = trip.route_index;
            let mut edges = Vec::new();
            if ri >= 1 {
                edges.push((trip.route[ri - 1], trip.route[ri]));
            }
            if ri + 1 < trip.route.len() {
                edges.push((trip.route[ri], trip.route[ri + 1]));
            }
            for edge in edges {
                if let Some(seg) = self.edges.get_mut(&edge) {
                    seg.cars.retain(|&id| id != car_id);
                }
            }
        }
    }

    /// Remove a car from the world entirely — scrap, not parking.
    pub fn despawn_car(&mut self, car_id: EntityId) {
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
        // Anything a player builds is a draft until they commit it, so the
        // owner is stamped here rather than remembered at each call site.
        let draft = self.acting_as.map(Draft::Added);
        let id = self.objects.insert(object, pos, draft);
        if let Some(pos) = pos {
            self.spatial.entry(chunk_of(pos)).or_default().insert(id);
        }
        if let Some(owner) = self.acting_as {
            self.drafts.entry(owner).or_default().insert(id);
        }
        id
    }

    pub fn draft_of(&self, id: EntityId) -> Option<Draft> {
        self.objects.get(id).and_then(|e| e.draft)
    }

    /// Is this staged for demolition — present now, absent after the commit?
    pub fn is_going_away(&self, id: EntityId) -> bool {
        matches!(self.draft_of(id), Some(Draft::Removed(_)))
    }

    /// Mark a committed entity for demolition. Purely a marker: it keeps
    /// carrying traffic until commit, so staging a demolition never reroutes
    /// anyone else's cars for a change that may not happen.
    pub fn draft_remove(&mut self, id: EntityId) {
        let Some(owner) = self.acting_as else { return };
        if self.draft_of(id).is_some() {
            return; // already drafted, one way or the other
        }
        if let Some(entry) = self.objects.get_mut(id) {
            entry.draft = Some(Draft::Removed(owner));
        }
        self.drafts.entry(owner).or_default().insert(id);
    }

    /// Make an owner's drafts real. Additions join the simulation; removals are
    /// handed back for the caller to demolish, since that has to account for
    /// the cars currently on them.
    pub fn commit_drafts(&mut self, owner: OwnerId) -> Committed {
        let ids: Vec<EntityId> = self.drafts.remove(&owner).unwrap_or_default().into_iter().collect();
        let mut committed = Committed::default();

        for id in ids {
            match self.draft_of(id) {
                Some(Draft::Added(_)) => {
                    if let Some(entry) = self.objects.get_mut(id) {
                        entry.draft = None;
                    }
                    committed.added.push(id);
                }
                Some(Draft::Removed(_)) => committed.removed.push(id),
                None => {}
            }
        }

        // Edges only once every node is real: wiring one up while its neighbour
        // still counted as a draft would leave the pair connected one way.
        for &id in &committed.added {
            self.connect_node(id);
            if let Some(entry) = self.objects.get(id)
                && matches!(entry.object, GameObject::Building(_))
                && let Some(pos) = entry.position
            {
                self.reveal_around(pos);
            }
        }
        committed
    }

    /// Throw away an owner's drafts. Additions never entered `edges`, so they
    /// are simply dropped; removals only ever had a marker to clear. Nothing
    /// committed was touched, so there is nothing to restore.
    pub fn discard_drafts(&mut self, owner: OwnerId) {
        for id in self.drafts.remove(&owner).unwrap_or_default() {
            match self.draft_of(id) {
                Some(Draft::Added(_)) => self.drop_entity(id),
                Some(Draft::Removed(_)) => {
                    if let Some(entry) = self.objects.get_mut(id) {
                        entry.draft = None;
                    }
                }
                None => {}
            }
        }
    }

    /// Erase one of your own uncommitted additions, as though it were never
    /// drawn. Other people's drafts, and anything committed, are not yours to
    /// erase this way.
    pub fn erase_draft(&mut self, id: EntityId) -> bool {
        let Some(owner) = self.acting_as else { return false };
        if self.draft_of(id) != Some(Draft::Added(owner)) {
            return false;
        }
        self.drafts.entry(owner).or_default().remove(&id);
        self.drop_entity(id);
        true
    }

    /// Take an entity out of the world, whatever kind it is.
    fn drop_entity(&mut self, id: EntityId) {
        let Some(entry) = self.objects.get(id) else { return };
        let pos = entry.position;
        let is_building = matches!(entry.object, GameObject::Building(_));
        let is_road = matches!(entry.object, GameObject::RoadNode(_));
        if is_building {
            self.remove_building(id);
        } else if is_road && let Some(pos) = pos {
            self.handle_demolish_road(pos);
        }
    }

    /// Give a newly committed road node its edges, in both directions. Its
    /// neighbours already list it — they always did, since the shape of the
    /// network is what drafts are for — but the edges were withheld.
    fn connect_node(&mut self, id: EntityId) {
        let Some(entry) = self.objects.get(id) else { return };
        let GameObject::RoadNode(ref node) = entry.object else { return };
        let (outgoing, incoming) = (node.outgoing.clone(), node.incoming.clone());
        for to in outgoing {
            self.insert_edge(id, to);
        }
        for from in incoming {
            self.insert_edge(from, id);
        }
    }

    /// Where the outside world reaches in: the nearest road node on ground
    /// nobody has revealed. Road generation keeps roads running out past the
    /// frontier, so this is how anything enters the map — close for a lone
    /// pioneer precisely because their own buildings drew the frontier in.
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
                    .is_some_and(|e| e.draft.is_none() && matches!(e.object, GameObject::Building(_)))
            })
            .collect();
        ids.sort_unstable();
        ids
    }

    pub fn entry_node_near(&self, pos: GridCoord) -> Option<EntityId> {
        self.objects
            .all_entries()
            .iter()
            .filter(|e| matches!(e.object, GameObject::RoadNode(_)))
            .filter_map(|e| e.position.map(|p| (e.id, p)))
            .filter(|&(_, p)| !self.revealed.contains(&chunk_of(p)))
            .min_by_key(|&(id, p)| ((p.x - pos.x).abs().max((p.y - pos.y).abs()), id))
            .map(|(id, _)| id)
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
        if matches!(self.draft_of(from), Some(Draft::Added(_)))
            || matches!(self.draft_of(to), Some(Draft::Added(_)))
        {
            return;
        }
        let len = self.segment_length(from, to);
        self.edges.insert((from, to), EdgeSegment::new(len));
        self.network.link(from, to, len);
    }

    /// Remove an edge.
    ///
    /// The network is undirected — a one-way pair is still one piece of city —
    /// so it only comes apart once the last direction is gone.
    pub fn remove_edge(&mut self, from: EntityId, to: EntityId) {
        self.edges.remove(&(from, to));
        if !self.edges.contains_key(&(to, from)) {
            self.network.unlink(from, to);
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
        for cy in min.cy..=max.cy {
            for cx in min.cx..=max.cx {
                let coord = ChunkCoord { cx, cy };
                if self.revealed.insert(coord) {
                    self.newly_revealed.push(coord);
                    self.grow_bounds(coord);
                }
            }
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
