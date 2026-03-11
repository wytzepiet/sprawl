import {
  createContext,
  useContext,

  onCleanup,
  type ParentProps,
  createStore,
} from "solid-js";
import { createConnection, updateClockOffset } from "../network/connection";
import type { GameObjectEntry, ClientMessage, Operation } from "../generated";

type Objects = Record<string, GameObjectEntry>;

function posKey(x: number, y: number): string {
  return `${x},${y}`;
}

interface GameContext {
  objects: Objects;
  getObjectsAt(x: number, y: number): GameObjectEntry[];
  send(msg: ClientMessage): void;
}

const Ctx = createContext<GameContext>();

export function GameProvider(props: ParentProps) {
  const [objects, setObjects] = createStore<Objects>({});
  const spatial = new Map<string, number[]>();

  function spatialRemove(id: number, pos: { x: number; y: number } | null | undefined) {
    if (!pos) return;
    const key = posKey(pos.x, pos.y);
    const ids = spatial.get(key);
    if (!ids) return;
    const filtered = ids.filter((i) => i !== id);
    if (filtered.length === 0) spatial.delete(key);
    else spatial.set(key, filtered);
  }

  function spatialAdd(id: number, pos: { x: number; y: number } | null | undefined) {
    if (!pos) return;
    const key = posKey(pos.x, pos.y);
    const ids = spatial.get(key);
    if (!ids) spatial.set(key, [id]);
    else if (!ids.includes(id)) ids.push(id);
  }

  function applyOps(ops: Operation[]) {
    setObjects((objects) => {
      for (const op of ops) {
        switch (op.op) {
          case "Upsert": {
            const existing = objects[op.data.id];
            if (existing) {
              spatialRemove(existing.id, existing.position);
              existing.object = op.data.object;
              existing.position = op.data.position;
            } else {
              objects[op.data.id] = op.data;
            }
            spatialAdd(op.data.id, op.data.position);
            break;
          }
          case "Delete": {
            const old = objects[String(op.data)];
            if (old) spatialRemove(old.id, old.position);
            delete objects[String(op.data)];
            break;
          }
        }
      }
    });
  }

  const { send, close } = createConnection(
    "ws://localhost:3001/ws",
    (msg) => {
      switch (msg.type) {
        case "Update":
          updateClockOffset(msg.data.server_time);
          applyOps(msg.data.ops);
          break;
        case "Error":
          console.error("[ws] server error:", msg.data.message);
          break;
        case "Pong":
          updateClockOffset(msg.data);
          break;
      }
    },
  );

  onCleanup(close);

  function getObjectsAt(x: number, y: number): GameObjectEntry[] {
    const ids = spatial.get(posKey(x, y));
    if (!ids) return [];
    const result: GameObjectEntry[] = [];
    for (const id of ids) {
      const entry = objects[id];
      if (entry) result.push(entry);
    }
    return result;
  }

  return <Ctx value={{ objects, getObjectsAt, send }}>{props.children}</Ctx>;
}

export function useGame() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useGame must be used within <GameProvider>");
  return ctx;
}
