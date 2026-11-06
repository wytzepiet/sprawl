import {
  createContext,
  useContext,
  createSignal,
  onCleanup,
  createComponent,
  type ParentProps,
} from "solid-js";
import type { Connection } from "../network/connection";
import { spread } from "../engine/budget";
import { syncFromClock } from "../network/clock";
import { setTown, tell } from "./town";
import type { Place } from "../engine/pen";
import type { Side } from "../engine/tiles";
import type { Building,
  GameObjectEntry,
  GridCoord,
  Hint,
  ClientMessage,
  ChunkBounds,
  ChunkCoord,
  Operation,
  TerrainChunk,
  ServerMessage,
} from "../generated";

function posKey(x: number, y: number): string {
  return `${x},${y}`;
}

// --- Module-level state (plain data, no reactivity) ---

const entities = new Map<string, GameObjectEntry>();
const spatial = new Map<string, number[]>();

/**
 * What carries a sign: every building. Kept as ops arrive, with a version the
 * sign layer re-reads on; the entities map itself is deliberately not
 * reactive, and signs are the one view that wants a list. The version also
 * moves when a road lands on or leaves a building's tile, since whether a
 * building is reached is part of how its sign is drawn.
 */
const signedEntries = new Map<number, GameObjectEntry>();
const [signsVersion, setSignsVersion] = createSignal(0);
export function signed(): GameObjectEntry[] {
  signsVersion();
  return [...signedEntries.values()];
}
/** One building carrying a sign, as it is now: read on the signs' version. */
export function signedOne(id: number): GameObjectEntry | undefined {
  signsVersion();
  return signedEntries.get(id);
}
/** Tile → the building standing on it. */
const occupiedBy = new Map<string, number>();
/** Told of each building as it changes: what it was, if it was seen,
 *  and what it is now. */
type BuildingListener = (before: GameObjectEntry | undefined, after: GameObjectEntry) => void;
let buildingListener: BuildingListener | null = null;
export function setBuildingListener(fn: BuildingListener | null) {
  buildingListener = fn;
}
function trackSign(entry: GameObjectEntry | undefined, id: number) {
  const was = signedEntries.has(id);
  const before = signedEntries.get(id);
  if (entry?.object.kind === "Building") buildingListener?.(before, entry);
  if (before?.position && before.object.kind === "Building") {
    for (const t of keys(before.object.data as Building)) occupiedBy.delete(t);
  }
  if (entry && entry.object.kind === "Building" && entry.position) {
    signedEntries.set(id, entry);
    for (const t of keys(entry.object.data as Building)) occupiedBy.set(t, id);
  } else {
    signedEntries.delete(id);
  }
  if (was || signedEntries.has(id)) setSignsVersion((v) => v + 1);
}
const keys = (b: Building) => b.tiles.map((t) => posKey(t.x, t.y));
/**
 * Does this building's door open onto a street joined to the world? A door
 * onto an island is no way in. Reactive on the signs' version, which moves
 * when a road lands, leaves or changes.
 */
export function reached(entry: GameObjectEntry): boolean {
  signsVersion();
  if (entry.object.kind !== "Building") return false;
  const b = entry.object.data as Building;
  const door = b.door;
  if (!door || !b.tiles.some((t) => t.x === door.tile.x && t.y === door.tile.y)) return false;
  return (spatial.get(posKey(door.street.x, door.street.y)) ?? []).some((id) => {
    const o = entities.get(String(id))?.object;
    return o?.kind === "RoadNode" && o.data.joined && !o.data.road.length;
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

/** Where each road on a tile stands: its height and side. */
export function roadsAt(t: GridCoord): Place[] {
  return getObjectsAt(t.x, t.y).flatMap((e) => (e.object.kind === "RoadNode" ? [{ h: e.object.data.height, s: e.object.data.side as Side }] : []));
}

// --- The game's answers to the hand (`Ask`) ---

type HintListener = (h: Hint) => void;
const hintListeners = new Set<HintListener>();
/** Told each answer to the hand's asks while listening; stop with what
 *  this returns. */
export function listenHints(fn: HintListener): () => void {
  hintListeners.add(fn);
  return () => void hintListeners.delete(fn);
}

// --- Ops listener for ECS ---

type OpsListener = (ops: Operation[]) => void;
let opsListener: OpsListener | null = null;
export function setOpsListener(fn: OpsListener | null) {
  opsListener = fn;
}

/** The ground of every chunk heard of, kept after it is out of view, since
 *  it never changes: the feed reads the island as far as it was seen. */
const ground = new Map<string, Uint8Array>();
export const groundOf = (cx: number, cy: number) => ground.get(`${cx},${cy}`);

/** Terrain arrives per chunk rather than as entities, so it bypasses ops. */
interface TerrainListener {
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
        trackSign(op.data, op.data.id);
        if (op.data.object.kind === "RoadNode") setSignsVersion((v) => v + 1);
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
          if (existing.object.kind === "RoadNode") setSignsVersion((v) => v + 1);
        }
        trackSign(undefined, Number(key));
        break;
      }
    }
  }
  if (built) setBuiltVersion((v) => v + 1);
  opsListener?.(ops);
}

/** A message's ops, so many at a time. */
const OPS_A_PART = 64;
function* applying(ops: Operation[]) {
  for (let i = 0; i < ops.length; i += OPS_A_PART) {
    applyOps(ops.slice(i, i + OPS_A_PART));
    yield;
  }
}

// --- Context (thin — just what UI needs) ---

interface GameContext {
  /** How many times the server has welcomed this client: once a socket. */
  welcomed(): number;
  /** The island's map, in chunks: the camera stays over it. */
  island(): ChunkBounds;
  send(msg: ClientMessage): boolean;
}

const Ctx = createContext<GameContext>();

/** Opens the line to the game: a socket to the server, or a worker running
 *  a level in the browser. Told where to send what the game says. */
export type Connect = (onMessage: (msg: ServerMessage) => void) => Connection;

/** What the camera has before the game first says. */
const NO_ISLAND: ChunkBounds = { min_cx: 0, min_cy: 0, max_cx: -1, max_cy: -1 };

export function GameProvider(props: ParentProps & { connect: Connect }) {
  const [welcomed, setWelcomed] = createSignal(0);
  const [island, setIsland] = createSignal<ChunkBounds>(NO_ISLAND);

  const { send, close } = props.connect((msg) => {
    switch (msg.type) {
      case "Update":
        syncFromClock(msg.data.clock);
        setIsland(msg.data.island);
        setTown(msg.data.town);
        // Many at once when the view travels: spread over frames, in order.
        void spread(applying(msg.data.ops));
        break;
      case "TerrainChunk":
        ground.set(`${msg.data.coord.cx},${msg.data.coord.cy}`, msg.data.tiles);
        terrainListener?.setChunk(msg.data);
        break;
      case "UnloadChunk":
        terrainListener?.unloadChunk(msg.data);
        break;
      case "Welcome":
        // A server new to this client, or come back after a restart, that
        // knows nothing of what it held: let it all go, and the camera asks
        // for its view again. In line behind what the old server said and
        // is still landing, or that lands after, over what it says now.
        void spread((function* () {
          applyOps([...entities.values()].map((e) => ({ op: "Delete", data: e.id })));
        })());
        for (const key of ground.keys()) {
          const [cx, cy] = key.split(",").map(Number);
          terrainListener?.unloadChunk({ cx, cy });
        }
        ground.clear();
        setWelcomed((n) => n + 1);
        break;
      case "News":
        for (const n of msg.data) tell(n.text, n.sub, n.at);
        break;
      case "Hint":
        for (const f of hintListeners) f(msg.data);
        break;
    }
  });

  onCleanup(close);

  // Built by hand, as Solid compiles it: this module is also the engine's,
  // which `bun test` loads with no JSX transform.
  return createComponent(Ctx.Provider, { value: { welcomed, island, send }, get children() { return props.children; } });
}

export function useGame() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useGame must be used within <GameProvider>");
  return ctx;
}
