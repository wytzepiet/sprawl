pub mod bezier;
mod buildings;
mod geometry;
pub mod pathfinding;
mod roads;
pub mod segments;

use std::collections::{HashMap, HashSet};

use crate::protocol::{
    CHUNK_SIZE, CHUNK_SKIRT, CHUNK_STRIDE, ChunkCoord, EdgeKey, EntityId, GameObject, TILE_ABSENT,
    TerrainChunk, TerrainType,
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
}

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

    /// Serialise one chunk's tile types, including the skirt the client needs
    /// to derive corner shapes. Tiles outside the world, and the unplayable rim,
    /// are marked absent so the client renders nothing there.
    pub fn terrain_chunk(&self, coord: ChunkCoord) -> TerrainChunk {
        let origin_x = coord.cx * CHUNK_SIZE - CHUNK_SKIRT;
        let origin_y = coord.cy * CHUNK_SIZE - CHUNK_SKIRT;
        let mut tiles = Vec::with_capacity((CHUNK_STRIDE * CHUNK_STRIDE) as usize);
        for dy in 0..CHUNK_STRIDE {
            for dx in 0..CHUNK_STRIDE {
                let (x, y) = (origin_x + dx, origin_y + dy);
                tiles.push(match self.terrain.get(&(x, y)) {
                    Some(&t) if !crate::road_gen::is_edge_chunk_tile(x, y) => t.to_byte(),
                    _ => TILE_ABSENT,
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
