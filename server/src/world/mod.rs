pub mod bezier;
mod buildings;
mod geometry;
pub mod pathfinding;
mod roads;
pub mod segments;

use std::collections::{HashMap, HashSet};

use crate::protocol::{
    CHUNK_SIZE, CHUNK_SKIRT, CHUNK_STRIDE, ChunkBounds, ChunkCoord, EdgeKey, EntityId, GameObject,
    TILE_ABSENT, TerrainChunk, TerrainType,
};
use crate::engine::tracked::Tracked;
use crate::world::segments::EdgeSegment;

pub struct World {
    pub objects: Tracked,
    /// Entities by chunk. Chunk-granular because that is the unit clients
    /// subscribe to; exact-tile queries filter a chunk's set, which stays small
    /// now that terrain is not an entity.
    pub(super) spatial: HashMap<ChunkCoord, HashSet<EntityId>>,
    pub edges: HashMap<EdgeKey, EdgeSegment>,
    /// Maps node_id → set of car_ids whose route passes through that node.
    pub node_cars: HashMap<EntityId, HashSet<EntityId>>,
    pub terrain_seed: u32,
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
    /// Tile → building covering it. Buildings span several tiles but carry one
    /// position, so without this "what is on this tile" would only ever find a
    /// building at its origin corner. Derived, like every other index.
    pub occupied: HashMap<(i32, i32), EntityId>,
}

/// Marks an empty box: max below min, so the first reveal replaces it outright.
const NO_BOUNDS: ChunkBounds = ChunkBounds { min_cx: 0, min_cy: 0, max_cx: -1, max_cy: -1 };

/// How far a building sees, in tiles. Generous on purpose: the frontier has to
/// stay ahead of what you have built, or you are siting blind.
const REVEAL_RADIUS: i32 = 48;

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
            node_cars: HashMap::new(),
            terrain_seed: 0,
            terrain: HashMap::new(),
            chunk_crossings: Vec::new(),
            revealed: HashSet::new(),
            newly_revealed: Vec::new(),
            revealed_bounds: NO_BOUNDS,
            occupied: HashMap::new(),
        }
    }

    pub fn from_loaded(objects: Tracked, terrain_seed: u32) -> Self {
        let mut world = Self {
            spatial: HashMap::new(),
            edges: HashMap::new(),
            node_cars: HashMap::new(),
            terrain_seed,
            terrain: HashMap::new(),
            chunk_crossings: Vec::new(),
            revealed: HashSet::new(),
            newly_revealed: Vec::new(),
            revealed_bounds: NO_BOUNDS,
            occupied: HashMap::new(),
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
            }
        }
    }

    pub fn despawn_car(&mut self, car_id: EntityId) {
        if let Some(entry) = self.objects.get(car_id)
            && let GameObject::Car(ref car) = entry.object
        {
            let ri = car.route_index;
            // Remove from current edge
            if ri >= 1 {
                let edge = (car.route[ri - 1], car.route[ri]);
                if let Some(seg) = self.edges.get_mut(&edge) {
                    seg.cars.retain(|&id| id != car_id);
                }
            }
            // Remove from next edge (pre-registration)
            if ri + 1 < car.route.len() {
                let next_edge = (car.route[ri], car.route[ri + 1]);
                if let Some(seg) = self.edges.get_mut(&next_edge) {
                    seg.cars.retain(|&id| id != car_id);
                }
            }
        }
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
    pub fn insert_edge(&mut self, from: EntityId, to: EntityId) {
        let len = self.segment_length(from, to);
        self.edges.insert((from, to), EdgeSegment::new(len));
    }

    /// Remove an edge.
    pub fn remove_edge(&mut self, from: EntityId, to: EntityId) {
        self.edges.remove(&(from, to));
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
                    Some((e.id, car.route.clone()))
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
