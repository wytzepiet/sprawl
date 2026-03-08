import {
  createContext,
  useContext,

  onCleanup,
  type ParentProps,
  createStore,
} from "solid-js";
import { createConnection } from "../network/connection";
import type { GameObjectEntry, ClientMessage, Operation } from "../generated";

type Objects = Record<string, GameObjectEntry>;
type SpatialIndex = Record<string, number[]>;

function posKey(x: number, y: number): string {
  return `${x},${y}`;
}

interface GameContext {
  objects: Objects;
  /** Get all game objects at a grid position. */
  getObjectsAt(x: number, y: number): GameObjectEntry[];
  send(msg: ClientMessage): void;
}

const Ctx = createContext<GameContext>();

export function GameProvider(props: ParentProps) {
  const [objects, setObjects] = createStore<Objects>({});
  const [spatial, setSpatial] = createStore<SpatialIndex>({});

  function removeFromSpatial(entry: GameObjectEntry) {
    if (!entry.position) return;
    const key = posKey(entry.position.x, entry.position.y);
    setSpatial((s) => {
      const ids = s[key];
      if (!ids) return;
      const filtered = ids.filter((id) => id !== entry.id);
      if (filtered.length === 0) {
        delete s[key];
      } else {
        s[key] = filtered;
      }
    });
  }

  function addToSpatial(entry: GameObjectEntry) {
    if (!entry.position) return;
    const key = posKey(entry.position.x, entry.position.y);
    setSpatial((s) => {
      const ids = s[key];
      if (!ids) {
        s[key] = [entry.id];
      } else if (!ids.includes(entry.id)) {
        s[key] = [...ids, entry.id];
      }
    });
  }

  function applyOps(ops: Operation[]) {
    setObjects((objects) => {
      for (const op of ops) {
        switch (op.op) {
          case "Upsert": {
            const old = objects[op.data.id];
            if (old) removeFromSpatial(old);
            objects[op.data.id] = op.data;
            addToSpatial(op.data);
            break;
          }
          case "Delete": {
            const old = objects[String(op.data)];
            if (old) removeFromSpatial(old);
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
          applyOps(msg.data);
          break;
        case "Error":
          console.error("[ws] server error:", msg.data.message);
          break;
        case "Pong":
          break;
      }
    },
  );

  onCleanup(close);

  function getObjectsAt(x: number, y: number): GameObjectEntry[] {
    const ids = spatial[posKey(x, y)];
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
