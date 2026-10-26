//! What each client is sent: the objects and terrain of the chunks it
//! looks at, what changed in them, and the town's state beside them.

use fixed::{HashMap, HashSet};
use crate::game::ClientId;
use model::{ChunkBounds, Clock, EntityId, GameObjectEntry, Lump, Operation, OwnerId, ServerMessage, StateUpdate};
use land::ChunkCoord;
use map::chunk_of;
use crate::world::World;

/// What the game knows of one who is watching: who they are and what they
/// have been sent. What it has to say to them waits in the outbox until
/// whatever carries it (a socket, a worker's port) takes it.
pub(crate) struct ClientState {
    /// Who is playing. Several sockets can share one.
    pub(crate) owner: OwnerId,
    pub(crate) subscribed: Option<ChunkBounds>,
    pub(crate) known: HashSet<EntityId>,
    pub(crate) known_chunks: HashSet<ChunkCoord>,
}

/// Every update carries the ambient world state alongside its ops, so a client
/// never has to ask for the island's extent separately: this, its ops and
/// lumps empty.
pub fn state_update(world: &World, clk: Clock) -> StateUpdate {
    StateUpdate {
        ops: Vec::new(),
        lumps: Vec::new(),
        clock: clk,
        growth: crate::economy::growth(world, clk.now),
        sea: crate::haul::sea(world),
        neighbours: crate::orders::neighbours(),
        island: ChunkBounds { min_cx: land::terrain::CHUNKS_MIN, min_cy: land::terrain::CHUNKS_MIN, max_cx: land::terrain::CHUNKS_MAX, max_cy: land::terrain::CHUNKS_MAX },
    }
}

/// The ambient state of one moment, the same for every client: built the
/// first time an update needs it, and each update after a copy of it.
pub(crate) struct Shared<'a> {
    world: &'a World,
    clk: Clock,
    built: Option<StateUpdate>,
}

impl<'a> Shared<'a> {
    pub(crate) fn new(world: &'a World, clk: Clock) -> Self {
        Shared { world, clk, built: None }
    }

    pub(crate) fn update(&mut self, ops: Vec<Operation>, lumps: Vec<Lump>) -> ServerMessage {
        let (world, clk) = (self.world, self.clk);
        ServerMessage::Update(StateUpdate { ops, lumps, ..self.built.get_or_insert_with(|| state_update(world, clk)).clone() })
    }
}

/// Reconcile a client's subscription. Chunk-granular, so panning within a
/// chunk produces no work at all — which is why there is no throttle.
pub(crate) fn handle_set_chunks(
    shared: &mut Shared,
    clients: &mut HashMap<ClientId, ClientState>,
    outbox: &mut Vec<(ClientId, ServerMessage)>,
    client_id: ClientId,
    bounds: ChunkBounds,
) {
    let world = shared.world;
    let visible_chunks: HashSet<ChunkCoord> = bounds.coords().collect();
    let in_view = world.map.entities_in_chunks(&visible_chunks);

    let cs = match clients.get_mut(&client_id) {
        Some(cs) => cs,
        None => return,
    };
    cs.subscribed = Some(bounds);

    // Terrain travels per chunk, so only the chunks that just came into view
    // are sent, and panning inside a chunk sends nothing at all. The whole
    // island is seen from the first minute: there is no fog.
    for &coord in visible_chunks.iter() {
        if cs.known_chunks.insert(coord) {
            outbox.push((client_id, ServerMessage::TerrainChunk(world.map.terrain_chunk(coord))));
        }
    }
    let dropped: Vec<ChunkCoord> = cs.known_chunks
        .iter()
        .filter(|c| !visible_chunks.contains(c))
        .copied()
        .collect();
    for coord in dropped {
        cs.known_chunks.remove(&coord);
        outbox.push((client_id, ServerMessage::UnloadChunk(coord)));
    }

    // Enter: in view but not known
    let mut ops = Vec::new();
    for &id in &in_view {
        if !cs.known.contains(&id)
            && let Some(entry) = world.map.objects.get(id) {
                ops.push(Operation::Upsert(Box::new(entry.clone())));
            }
    }

    // Exit: known but no longer in view
    let exits: Vec<EntityId> = cs.known.iter()
        .filter(|id| !in_view.contains(id))
        .copied()
        .collect();
    for id in &exits {
        ops.push(Operation::Delete(*id));
    }

    cs.known = in_view;

    if !ops.is_empty() {
        outbox.push((client_id, shared.update(ops, vec![])));
    }
}

pub(crate) fn flush_dirty(
    world: &mut World,
    clients: &mut HashMap<ClientId, ClientState>,
    outbox: &mut Vec<(ClientId, ServerMessage)>,
    clk: Clock,
) {
    // The news, to every player, wherever they are looking.
    let news = std::mem::take(&mut world.news);
    if !news.is_empty() {
        for &id in clients.keys() {
            outbox.push((id, ServerMessage::News(news.clone())));
        }
    }
    let (changed, removed) = world.map.objects.drain_dirty();
    let crossings: Vec<(EntityId, ChunkCoord, ChunkCoord)> =
        std::mem::take(&mut world.map.chunk_crossings)
            .into_iter()
            .filter(|(id, ..)| !removed.contains(id))
            .collect();
    // Money that landed, for whoever is looking at where it landed.
    let lumps: Vec<(ChunkCoord, Lump)> = std::mem::take(&mut world.lumps)
        .into_iter()
        .filter_map(|s| Some((chunk_of(world.map.objects.get(s.building)?.position?), s)))
        .collect();

    if changed.is_empty() && removed.is_empty() && crossings.is_empty() && lumps.is_empty() {
        return;
    }

    // Group by chunk so a client walks the chunks it subscribes to rather than
    // every entity that changed. A client sees a handful of chunks; the world
    // can have hundreds of moving cars.
    let world = &*world;
    let mut by_chunk: HashMap<ChunkCoord, Vec<&GameObjectEntry>> = HashMap::default();
    for id in &changed {
        if let Some(entry) = world.map.objects.get(*id)
            && let Some(pos) = entry.position
        {
            by_chunk.entry(chunk_of(pos)).or_default().push(entry);
        }
    }
    let mut shared = Shared::new(world, clk);

    for (&client_id, cs) in clients.iter_mut() {
        if cs.subscribed.is_none() {
            continue;
        }

        let mut ops = Vec::new();

        for coord in &cs.known_chunks {
            for &entry in by_chunk.get(coord).into_iter().flatten() {
                cs.known.insert(entry.id);
                ops.push(Operation::Upsert(Box::new(entry.clone())));
            }
        }

        // A crossing is the only way an entity leaves a view without being
        // deleted, and the only way one enters without being dirty.
        for &(id, from, to) in &crossings {
            let had = cs.known_chunks.contains(&from);
            let has = cs.known_chunks.contains(&to);
            if had && !has {
                if cs.known.remove(&id) {
                    ops.push(Operation::Delete(id));
                }
            } else if has && !had && !cs.known.contains(&id)
                && let Some(entry) = world.map.objects.get(id)
            {
                cs.known.insert(id);
                ops.push(Operation::Upsert(Box::new(entry.clone())));
            }
        }

        for id in &removed {
            if cs.known.remove(id) {
                ops.push(Operation::Delete(*id));
            }
        }
        let lumps: Vec<Lump> = lumps.iter().filter(|(c, _)| cs.known_chunks.contains(c)).map(|(_, s)| *s).collect();

        if !ops.is_empty() || !lumps.is_empty() {
            outbox.push((client_id, shared.update(ops, lumps)));
        }
    }
}
