//! What each client is sent: the objects and terrain of the chunks it
//! looks at, what changed in them, and the town's state beside them.

use fixed::{HashMap, HashSet};
use crate::game::ClientId;
use model::{ChunkBounds, Clock, EntityId, GameObject, GameObjectEntry, Operation, OwnerId, Pedal, ServerMessage, StateUpdate};
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
    /// How many of its messages have been done, and how many of those it
    /// has been told of (`ServerMessage::Seen`).
    pub(crate) seen: u32,
    pub(crate) told: u32,
}

/// Every update carries the ambient world state alongside its ops, so a client
/// never has to ask for the island's extent or the town separately: this,
/// its ops empty.
pub fn state_update(world: &World, clk: Clock) -> StateUpdate {
    StateUpdate {
        ops: Vec::new(),
        clock: clk,
        town: world.town.view(&world.map),
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

    pub(crate) fn update(&mut self, ops: Vec<Operation>) -> ServerMessage {
        let (world, clk) = (self.world, self.clk);
        ServerMessage::Update(StateUpdate { ops, ..self.built.get_or_insert_with(|| state_update(world, clk)).clone() })
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
        outbox.push((client_id, shared.update(ops)));
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
    let (changed, pedalled, removed) = world.map.objects.drain_dirty();
    let crossings: Vec<(EntityId, ChunkCoord, ChunkCoord)> =
        std::mem::take(&mut world.map.chunk_crossings)
            .into_iter()
            .filter(|(id, ..)| !removed.contains(id))
            .collect();
    // The town as its mayor sees it, to everyone, when it changed.
    let town = world.town.view(&world.map);
    let stirred = world.shown.as_ref() != Some(&town);
    world.shown = Some(town);

    if !(changed.is_empty() && pedalled.is_empty() && removed.is_empty() && crossings.is_empty() && !stirred) {
        send_changes(world, clients, outbox, clk, &changed, &pedalled, &removed, &crossings, stirred);
    }
    // After what they changed: what the client guessed of them may go.
    for (&client_id, cs) in clients.iter_mut() {
        if cs.seen != cs.told {
            cs.told = cs.seen;
            outbox.push((client_id, ServerMessage::Seen(cs.seen)));
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn send_changes(
    world: &World,
    clients: &mut HashMap<ClientId, ClientState>,
    outbox: &mut Vec<(ClientId, ServerMessage)>,
    clk: Clock,
    changed: &[EntityId],
    pedalled: &[EntityId],
    removed: &[EntityId],
    crossings: &[(EntityId, ChunkCoord, ChunkCoord)],
    stirred: bool,
) {
    // Group by chunk so a client walks the chunks it subscribes to rather than
    // every entity that changed. A client sees a handful of chunks; the world
    // can have hundreds of moving cars.
    let mut by_chunk: HashMap<ChunkCoord, Vec<&GameObjectEntry>> = HashMap::default();
    let mut pedals_by_chunk: HashMap<ChunkCoord, Vec<&GameObjectEntry>> = HashMap::default();
    for (ids, chunks) in [(changed, &mut by_chunk), (pedalled, &mut pedals_by_chunk)] {
        for id in ids {
            if let Some(entry) = world.map.objects.get(*id)
                && let Some(pos) = entry.position
            {
                chunks.entry(chunk_of(pos)).or_default().push(entry);
            }
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
            // One it holds hears of the pedal alone; one it does not, all of it.
            for &entry in pedals_by_chunk.get(coord).into_iter().flatten() {
                ops.push(match (cs.known.insert(entry.id), &entry.object) {
                    (false, GameObject::Car(model::Car { trip: Some(t), .. })) => Operation::Pedal(Pedal {
                        id: entry.id,
                        position: entry.position,
                        progress: t.progress,
                        speed: t.speed,
                        acceleration: t.acceleration,
                        updated_at: t.updated_at,
                    }),
                    _ => Operation::Upsert(Box::new(entry.clone())),
                });
            }
        }

        // A crossing is the only way an entity leaves a view without being
        // deleted, and the only way one enters without being dirty.
        for &(id, from, to) in crossings {
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

        for id in removed {
            if cs.known.remove(id) {
                ops.push(Operation::Delete(*id));
            }
        }
        if !ops.is_empty() || stirred {
            outbox.push((client_id, shared.update(ops)));
        }
    }
}
