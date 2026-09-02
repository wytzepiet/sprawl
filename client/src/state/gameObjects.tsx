import {
  createContext,
  useContext,
  createSignal,
  onCleanup,
  type ParentProps,
} from "solid-js";
import { createConnection } from "../network/connection";
import { syncClock, syncFromClock } from "../network/clock";
import type {
  GameObjectEntry,
  ClientMessage,
  ChunkBounds,
  ChunkCoord,
  Operation,
  TerrainChunk,
} from "../generated";

function posKey(x: number, y: number): string {
  return `${x},${y}`;
}

// --- Module-level state (plain data, no reactivity) ---

const entities = new Map<string, GameObjectEntry>();
const spatial = new Map<string, number[]>();

/**
 * Who the server says we are. Module-level rather than owned by the provider
 * because the ops pass reads it, and that runs outside any component.
 */
const [me, setMe] = createSignal(0);
export { me };

/**
 * Our own uncommitted entities. Kept as ops arrive rather than derived on
 * demand, since it decides whether the commit bar is on screen at all.
 */
const myDrafts = new Set<number>();
const [pending, setPending] = createSignal(0);
export { pending };

/**
 * What carries a pin: every building, and every proposal. Kept as ops
 * arrive, with a version the pin layer re-reads on; the entities map itself
 * is deliberately not reactive, and pins are the one view that wants a list.
 */
const pinnedEntries = new Map<number, GameObjectEntry>();
const [pinsVersion, setPinsVersion] = createSignal(0);
export function pinned(): GameObjectEntry[] {
  pinsVersion();
  return [...pinnedEntries.values()];
}
function trackPin(entry: GameObjectEntry | undefined, id: number) {
  const kind = entry?.object.kind;
  const was = pinnedEntries.has(id);
  if (entry && (kind === "Building" || kind === "Proposal") && entry.position) {
    pinnedEntries.set(id, entry);
  } else {
    pinnedEntries.delete(id);
  }
  if (was || pinnedEntries.has(id)) setPinsVersion((v) => v + 1);
}

function trackDraft(entry: GameObjectEntry) {
  if (entry.draft != null && entry.draft.owner === me()) myDrafts.add(entry.id);
  else myDrafts.delete(entry.id);
}
export function getEntity(id: number): GameObjectEntry | undefined {
  return entities.get(String(id));
}

export function getObjectsAt(x: number, y: number): GameObjectEntry[] {
  return (spatial.get(posKey(x, y)) ?? [])
    .map((id) => entities.get(String(id)))
    .filter((e): e is GameObjectEntry => !!e);
}

// --- Ops listener for ECS ---

type OpsListener = (ops: Operation[]) => void;
let opsListener: OpsListener | null = null;
export function setOpsListener(fn: OpsListener | null) {
  opsListener = fn;
}

/** Terrain arrives per chunk rather than as entities, so it bypasses ops. */
export interface TerrainListener {
  setChunk(chunk: TerrainChunk): void;
  unloadChunk(coord: ChunkCoord): void;
}
let terrainListener: TerrainListener | null = null;
export function setTerrainListener(fn: TerrainListener | null) {
  terrainListener = fn;
}

// --- Ops processing ---

/**
 * Ops are applied in the order they arrive, and must not be reordered.
 *
 * They are causal: the server emits a tick's upserts before its deletes, and
 * the socket batches several ticks into one message, so a batch can carry an
 * entity being created and then destroyed. Sorting deletes to the front — as
 * this used to — applied that pair backwards and left the entity in the store
 * for good, a ghost the server had already forgotten. Redrawing a paint stroke
 * churns entities every tick, which is what made it show.
 *
 * Nothing needs the reordering: the spatial index is keyed by entity id, so an
 * upsert and a delete touching one tile cannot tread on each other whichever
 * way round they land.
 */
function applyOps(ops: Operation[]) {
  for (const op of ops) {
    switch (op.op) {
      case "Upsert": {
        const key = String(op.data.id);
        const existing = entities.get(key);
        if (existing?.position) {
          const pk = posKey(existing.position.x, existing.position.y);
          const ids = spatial.get(pk);
          if (ids) {
            const filtered = ids.filter((i) => i !== existing.id);
            if (filtered.length === 0) spatial.delete(pk);
            else spatial.set(pk, filtered);
          }
        }
        if (op.data.position) {
          const pk = posKey(op.data.position.x, op.data.position.y);
          const ids = spatial.get(pk);
          if (!ids) spatial.set(pk, [op.data.id]);
          else if (!ids.includes(op.data.id)) ids.push(op.data.id);
        }
        entities.set(key, op.data);
        trackDraft(op.data);
        trackPin(op.data, op.data.id);
        break;
      }
      case "Delete": {
        const key = String(op.data);
        const existing = entities.get(key);
        if (existing) {
          if (existing.position) {
            const pk = posKey(existing.position.x, existing.position.y);
            const ids = spatial.get(pk);
            if (ids) {
              const filtered = ids.filter((i) => i !== existing.id);
              if (filtered.length === 0) spatial.delete(pk);
              else spatial.set(pk, filtered);
            }
          }
          entities.delete(key);
        }
        myDrafts.delete(Number(key));
        trackPin(undefined, Number(key));
        break;
      }
    }
  }
  setPending(myDrafts.size);
  opsListener?.(ops);
}

// --- Context (thin — just what UI needs) ---

interface GameContext {
  /** Who this client is. Drafts belong to a player, so this is what tells
   *  your own pending work from everyone else's. */
  me(): number;
  terrainSeed(): number;
  /** Surveyed extent, in chunks. max < min means nothing is surveyed yet. */
  revealedBounds(): ChunkBounds;
  send(msg: ClientMessage): boolean;
  getObjectsAt(x: number, y: number): GameObjectEntry[];
}

const Ctx = createContext<GameContext>();

export function GameProvider(props: ParentProps & { wsUrl: string }) {
  const [terrainSeed, setTerrainSeed] = createSignal(0);
  const [revealedBounds, setRevealedBounds] = createSignal<ChunkBounds>({
    min_cx: 0,
    min_cy: 0,
    max_cx: -1,
    max_cy: -1,
  });

  const wsUrl = props.wsUrl;
  const { send, close } = createConnection(wsUrl, (msg) => {
    switch (msg.type) {
      case "Update":
        syncFromClock(msg.data.clock);
        if (msg.data.terrain_seed) setTerrainSeed(msg.data.terrain_seed);
        setRevealedBounds(msg.data.revealed_bounds);
        applyOps(msg.data.ops);
        break;
      case "Error":
        console.error("[ws] server error:", msg.data.message);
        break;
      case "TerrainChunk":
        terrainListener?.setChunk(msg.data);
        break;
      case "UnloadChunk":
        terrainListener?.unloadChunk(msg.data);
        break;
      case "Welcome":
        setMe(msg.data);
        break;
      case "Pong":
        syncClock(msg.data);
        break;
    }
  });

  onCleanup(close);

  return (
    <Ctx.Provider value={{ me, terrainSeed, revealedBounds, send, getObjectsAt }}>
      {props.children}
    </Ctx.Provider>
  );
}

export function useGame() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useGame must be used within <GameProvider>");
  return ctx;
}
