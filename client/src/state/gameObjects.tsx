import {
  createContext,
  useContext,
  createSignal,
  onCleanup,
  type ParentProps,
} from "solid-js";
import { createConnection, updateClockOffset } from "../network/connection";
import type { GameObjectEntry, ClientMessage, Operation } from "../generated";

function posKey(x: number, y: number): string {
  return `${x},${y}`;
}

// --- Module-level state (plain data, no reactivity) ---

const entities = new Map<string, GameObjectEntry>();
const spatial = new Map<string, number[]>();
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

// --- Ops processing ---

function applyOps(ops: Operation[]) {
  ops.sort((a, b) => (a.op === "Delete" ? 0 : 1) - (b.op === "Delete" ? 0 : 1));
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
        break;
      }
    }
  }
  opsListener?.(ops);
}

// --- Context (thin — just what UI needs) ---

interface GameContext {
  terrainSeed(): number;
  send(msg: ClientMessage): void;
  getObjectsAt(x: number, y: number): GameObjectEntry[];
}

const Ctx = createContext<GameContext>();

export function GameProvider(props: ParentProps) {
  const [terrainSeed, setTerrainSeed] = createSignal(0);

  const { send, close } = createConnection("ws://localhost:3001/ws", (msg) => {
    switch (msg.type) {
      case "Update":
        updateClockOffset(msg.data.server_time);
        if (msg.data.terrain_seed) setTerrainSeed(msg.data.terrain_seed);
        applyOps(msg.data.ops);
        break;
      case "Error":
        console.error("[ws] server error:", msg.data.message);
        break;
      case "Pong":
        updateClockOffset(msg.data);
        break;
    }
  });

  onCleanup(close);

  return (
    <Ctx.Provider value={{ terrainSeed, send, getObjectsAt }}>
      {props.children}
    </Ctx.Provider>
  );
}

export function useGame() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useGame must be used within <GameProvider>");
  return ctx;
}
