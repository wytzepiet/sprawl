pub mod bezier;
mod buildings;
pub use buildings::Link;
pub mod fields;
mod geometry;
pub mod lots;
pub mod network;
pub mod pathfinding;
mod residents;
pub mod roads;
pub mod sea;
pub mod segments;

use std::collections::{BTreeSet, HashMap, HashSet};

use crate::engine::GameTime;

use crate::protocol::{
    CHUNK_SIZE, CHUNK_SKIRT, CHUNK_STRIDE, ChunkCoord, EdgeKey, EntityId,
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
    /// Where each lot node is: off the grid, and not an entity.
    pub lot_nodes: HashMap<EntityId, [f64; 2]>,
    /// Which lot each car holds a place in.
    pub claims: HashMap<EntityId, EntityId>,
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
    /// The car turning between the street and a lot at each street node,
    /// and when it was last seen moving: pulling out, from the moment it
    /// found a gap until its tail is clear of the node; turning in, from
    /// leaving the street there until it is parked. The street waits for it
    /// (`car::simulation`, `gap_at`), unless it stands still too long.
    pub manoeuvres: HashMap<EntityId, (EntityId, crate::engine::GameTime)>,
    pub terrain_seed: u32,
    /// Every building's books: what its taps served, a season of days. Learned, not saved — a loaded world
    /// starts counting afresh.
    pub books: HashMap<EntityId, crate::economy::Books>,
    /// The town's own books: what it served, and what crossed the border.
    pub town: crate::economy::Books<crate::economy::Town>,
    /// GDP to date: the value the town has added, banked as it appears
    /// (`economy`). The level is its running sum.
    pub gdp: f64,
    /// The mayor's coins: the town's balance of trade, less what it built.
    /// docs/trade.md, Coins.
    pub treasury: f64,
    /// Coins and GDP that landed on buildings since the last flush, for
    /// the clients looking at them.
    pub lumps: Vec<crate::protocol::Lump>,
    /// The nodes of the tree the player has taken: the gate for everything
    /// the city may do. See `tree.rs`.
    pub build: crate::tree::Build,
    /// Tiles of road the mayor has laid, against the build's allowance.
    /// Derived at startup from the nodes' own flag, like every other index.
    pub laid: u32,
    /// Tile types for the whole world, regenerated from the seed at startup.
    pub terrain: HashMap<(i32, i32), TerrainType>,
    /// The mountains' heights, eroded, made from the terrain the first time
    /// a chunk of it is sent (`mountains.rs`).
    pub peaks: std::sync::OnceLock<crate::mountains::Peaks>,
    /// Entities that changed chunk since the last flush, as (id, from, to).
    /// Chunks are what clients subscribe to, so a crossing is the exact moment
    /// an entity enters or leaves someone's view.
    pub chunk_crossings: Vec<(EntityId, ChunkCoord, ChunkCoord)>,
    /// Chunks a building has stood in: where a search for one looks. It
    /// never shrinks, and a chunk a building has left is looked in for
    /// nothing. Derived from the buildings at load, like every other index.
    pub built: HashSet<ChunkCoord>,
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
    /// Every harbour, and the street node it is reached by: a way out of
    /// the town, so what reaches it is joined. Derived by `mark_harbours`,
    /// never saved.
    pub harbours: std::collections::BTreeMap<EntityId, Option<EntityId>>,
    /// The dock a lorry is on its way to back under, to hook the box in it
    /// (`haul`). Trips are not saved, and neither is this.
    pub aims: HashMap<EntityId, (EntityId, usize)>,
    /// Lorries the mayor has tapped and that have not set out yet.
    pub sent: HashSet<EntityId>,
    /// Who lives or works at each building. Derived from the residents at
    /// startup (`resettle`), and kept by the only code that moves anyone.
    pub people: HashMap<EntityId, BTreeSet<EntityId>>,
    /// Buildings placed, reached, cut off or taken away since the last
    /// `settle`: everything a build changed, and all `settle` reads.
    pub unsettled: BTreeSet<EntityId>,
}

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
            lot_nodes: HashMap::new(),
            claims: HashMap::new(),
            network: RoadNetwork::default(),
            car_segment: HashMap::new(),
            node_cars: HashMap::new(),
            manoeuvres: HashMap::new(),
            terrain_seed: 0,
            books: HashMap::new(),
            town: Default::default(),
            gdp: 0.0,
            treasury: crate::economy::STAKE,
            lumps: Vec::new(),
            build: Default::default(),
            laid: 0,
            terrain: HashMap::new(),
            peaks: Default::default(),
            chunk_crossings: Vec::new(),
            built: HashSet::new(),
            occupied: HashMap::new(),
            roads: HashMap::new(),
            calls: Vec::new(),
            harbours: Default::default(),
            aims: HashMap::new(),
            sent: HashSet::new(),
            people: HashMap::new(),
            unsettled: BTreeSet::new(),
        }
    }

    pub fn from_loaded(objects: Tracked, terrain_seed: u32) -> Self {
        let mut world = Self {
            spatial: HashMap::new(),
            edges: HashMap::new(),
            lots: HashMap::new(),
            lot_nodes: HashMap::new(),
            claims: HashMap::new(),
            network: RoadNetwork::default(),
            car_segment: HashMap::new(),
            node_cars: HashMap::new(),
            manoeuvres: HashMap::new(),
            terrain_seed,
            books: HashMap::new(),
            town: Default::default(),
            gdp: 0.0,
            treasury: 0.0,
            lumps: Vec::new(),
            build: Default::default(),
            laid: 0,
            terrain: HashMap::new(),
            peaks: Default::default(),
            chunk_crossings: Vec::new(),
            built: HashSet::new(),
            occupied: HashMap::new(),
            roads: HashMap::new(),
            calls: Vec::new(),
            harbours: Default::default(),
            aims: HashMap::new(),
            sent: HashSet::new(),
            people: HashMap::new(),
            unsettled: BTreeSet::new(),
            objects,
        };
        // Rebuild the spatial index and the road index from loaded objects.
        for entry in world.objects.iter().chain(world.objects.roads()) {
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
        let entries: Vec<_> = self.objects.roads()
            .filter_map(|e| {
                if let GameObject::RoadNode(ref node) = e.object {
                    Some((e.id, node.outgoing.clone()))
                } else {
                    None
                }
            })
            .collect();
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
            self.manoeuvres.retain(|_, (c, _)| *c != car_id);
        }
    }

    /// Remove a car from the world entirely — scrap, not parking.
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

    /// Make a road a way out of the town, as a harbour's street is, so what
    /// it reaches is joined. For towns written as fixtures, which have no
    /// harbour and are only looked at.
    pub fn open_exit(&mut self, node: EntityId) {
        let turning = self.network.set_exit(node, true);
        self.mark_joined(turning.into_iter().chain([node]));
    }

    /// Every harbour's street node is a way out of the town: a road that
    /// reaches one is joined, and drawn so; one that reaches none is red.
    /// Derived from the buildings rather than remembered: running this
    /// twice changes nothing.
    pub fn mark_harbours(&mut self, now: GameTime) {
        let standing: Vec<EntityId> = self
            .objects
            .iter()
            .filter(|e| matches!(e.object, GameObject::Building(ref b) if b.kind == crate::protocol::BuildingKind::Harbour && b.site.is_none()))
            .map(|e| e.id)
            .collect();
        let was = std::mem::take(&mut self.harbours);
        for (h, node) in &was {
            if let Some(node) = node
                && (!standing.contains(h) || self.street_of(*h) != Some(*node))
            {
                let turning = self.network.set_exit(*node, false);
                self.mark_joined(turning.into_iter().chain([*node]));
            }
        }
        for h in standing {
            let node = self.street_of(h);
            if let Some(node) = node {
                let turning = self.network.set_exit(node, true);
                self.mark_joined(turning.into_iter().chain([node]));
            }
            self.harbours.insert(h, node);
            self.commission(h, now);
        }
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
        let peaks = self.raise_mountains();
        let heights = peaks.chunk(coord).iter().flat_map(|h| h.to_le_bytes()).collect();
        TerrainChunk { coord, tiles, heights }
    }

    /// The mountains' heights, eroded from the terrain the first time they
    /// are asked for: at startup, after the terrain is made, so no player
    /// waits on them.
    pub fn raise_mountains(&self) -> &crate::mountains::Peaks {
        self.peaks.get_or_init(|| {
            let started = std::time::Instant::now();
            let peaks = crate::mountains::Peaks::new(&self.terrain, self.terrain_seed);
            println!("mountains: worn in {:.1}s", started.elapsed().as_secs_f32());
            peaks
        })
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
        let routes: Vec<(EntityId, Vec<EntityId>)> = self.objects.iter()
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

