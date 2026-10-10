import {
  createContext,
  useContext,
  createSignal,
  onCleanup,
  type ParentProps,
} from "solid-js";
import { createConnection } from "../network/connection";
import { spread } from "../engine/budget";
import { syncClock, syncFromClock } from "../network/clock";
import { hearSea } from "./sea";
import { hearDrafts } from "./drafts";
import type { Building,
  GameObjectEntry,
  ClientMessage,
  ChunkBounds,
  Growth,
  ChunkCoord,
  Operation,
  Lump,
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
 * What carries a pin: every building. Kept as ops arrive, with a version the
 * pin layer re-reads on; the entities map itself is deliberately not
 * reactive, and pins are the one view that wants a list. The version also
 * moves when a road lands on or leaves a building's tile, since whether a
 * building is reached is part of how its pin is drawn.
 */
const pinnedEntries = new Map<number, GameObjectEntry>();
const [pinsVersion, setPinsVersion] = createSignal(0);
export function pinned(): GameObjectEntry[] {
  pinsVersion();
  return [...pinnedEntries.values()];
}
/**
 * Coins, GDP and goods that landed on buildings in view, for a moment:
 * each lump floats up over its building and is gone. Kept for a couple of seconds of wall time
 * and read by the lump layer; nothing else wants it.
 */
const LUMP_MS = 3200;
const [lumps, setLumps] = createSignal<(Lump & { key: number; since: number })[]>([]);
let lumpKey = 0;
export function recentLumps() {
  return lumps();
}
function land(lumps: Lump[]) {
  if (lumps.length === 0) return;
  const since = performance.now();
  setLumps((l) => [...l.filter((s) => since - s.since < LUMP_MS), ...lumps.map((s) => ({ ...s, key: lumpKey++, since }))]);
  setTimeout(() => setLumps((l) => l.filter((s) => performance.now() - s.since < LUMP_MS)), LUMP_MS + 50);
}
export { LUMP_MS };

/** Tile → the building standing on it. */
const occupiedBy = new Map<string, number>();
function trackPin(entry: GameObjectEntry | undefined, id: number) {
  const was = pinnedEntries.has(id);
  const before = pinnedEntries.get(id);
  if (before?.position && before.object.kind === "Building") {
    for (const t of keys(before.object.data as Building)) occupiedBy.delete(t);
  }
  if (entry && entry.object.kind === "Building" && entry.position) {
    pinnedEntries.set(id, entry);
    for (const t of keys(entry.object.data as Building)) occupiedBy.set(t, id);
  } else {
    pinnedEntries.delete(id);
  }
  if (was || pinnedEntries.has(id)) setPinsVersion((v) => v + 1);
}
const keys = (b: Building) => b.tiles.map((t) => posKey(t.x, t.y));
/**
 * Does this building's door open onto a street joined to the world? A door
 * onto an island is no way in. Reactive on the pins' version, which moves
 * when a road lands, leaves or changes.
 */
export function reached(entry: GameObjectEntry): boolean {
  pinsVersion();
  if (entry.object.kind !== "Building") return false;
  const b = entry.object.data as Building;
  const door = b.door;
  if (!door || !b.tiles.some((t) => t.x === door.tile.x && t.y === door.tile.y)) return false;
  return (spatial.get(posKey(door.street.x, door.street.y)) ?? []).some((id) => {
    const o = entities.get(String(id))?.object;
    return o?.kind === "RoadNode" && o.data.joined && !o.data.road;
  });
}

/** The building standing on this tile, any tile of its plot. */
export function buildingAt(x: number, y: number): GameObjectEntry | undefined {
  const id = occupiedBy.get(posKey(x, y));
  return id === undefined ? undefined : entities.get(String(id));
}

export function getEntity(id: number): GameObjectEntry | undefined {
  return entities.get(String(id));
}

/** Every entity the client holds, for checks that want the whole picture. */
export function eachEntity(f: (e: GameObjectEntry) => void) {
  for (const e of entities.values()) f(e);
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
/** Bumped whenever a road or a building lands, changes or goes: what the
 *  map of where the hand may go is asked again on. */
const [builtVersion, setBuiltVersion] = createSignal(0);
export { builtVersion };

function applyOps(ops: Operation[]) {
  let built = false;
  for (const op of ops) {
    const was = entities.get(String(op.op === "Upsert" ? op.data.id : op.data))?.object.kind;
    const is = op.op === "Upsert" ? op.data.object.kind : undefined;
    if ([was, is].some((k) => k === "RoadNode" || k === "Building")) built = true;
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
        trackPin(op.data, op.data.id);
        if (op.data.object.kind === "RoadNode") setPinsVersion((v) => v + 1);
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
          if (existing.object.kind === "RoadNode") setPinsVersion((v) => v + 1);
        }
        trackPin(undefined, Number(key));
        break;
      }
    }
  }
  if (built) setBuiltVersion((v) => v + 1);
  opsListener?.(ops);
}

/** A message's ops, so many at a time, then its lumps. */
const OPS_A_PART = 64;
function* applying(ops: Operation[], lumps: Lump[]) {
  for (let i = 0; i < ops.length; i += OPS_A_PART) {
    applyOps(ops.slice(i, i + OPS_A_PART));
    yield;
  }
  land(lumps);
}

// --- Context (thin — just what UI needs) ---

interface GameContext {
  /** Who this client is. */
  me(): number;
  terrainSeed(): number;
  /** The island's map, in chunks: the camera stays over it. */
  island(): ChunkBounds;
  /** The two dials: the city's level, and what the mayor has to spend. */
  growth(): Growth;
  send(msg: ClientMessage): boolean;
  getObjectsAt(x: number, y: number): GameObjectEntry[];
}

const Ctx = createContext<GameContext>();

export function GameProvider(props: ParentProps & { wsUrl: string }) {
  const [terrainSeed, setTerrainSeed] = createSignal(0);
  const [growth, setGrowth] = createSignal<Growth>({
    level: 0,
    toward: 0,
    needed: 0,
    gdp: 0,
    treasury: 0,
    income: 0,
    imports: 0,
    taken: [],
    road_tiles_left: 0,
  });
  const [island, setIsland] = createSignal<ChunkBounds>({
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
        setIsland(msg.data.island);
        setGrowth(msg.data.growth);
        hearSea(msg.data.sea);
        hearDrafts(msg.data.drafts);
        // Many at once when the view travels: spread over frames, in order.
        void spread(applying(msg.data.ops, msg.data.lumps));
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
    <Ctx.Provider value={{ me, terrainSeed, island, growth, send, getObjectsAt }}>
      {props.children}
    </Ctx.Provider>
  );
}

/** No server behind it: the sandbox, whose camera still asks what it may
 *  see and has no one to tell. */
export function OfflineGame(props: ParentProps) {
  const none = { min_cx: 0, min_cy: 0, max_cx: -1, max_cy: -1 };
  const growth = { level: 0, toward: 0, needed: 0, gdp: 0, treasury: 0, income: 0, imports: 0, taken: [], road_tiles_left: 0 };
  return (
    <Ctx.Provider value={{ me: () => 0, terrainSeed: () => 0, island: () => none, growth: () => growth, send: () => true, getObjectsAt: () => [] }}>
      {props.children}
    </Ctx.Provider>
  );
}

export function useGame() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useGame must be used within <GameProvider>");
  return ctx;
}
