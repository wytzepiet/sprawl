import {
  createContext,
  useContext,
  createSignal,
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
  objectIds: readonly number[];
  terrainSeed(): number;
  getObjectsAt(x: number, y: number): GameObjectEntry[];
  send(msg: ClientMessage): void;
}

const Ctx = createContext<GameContext>();

export function GameProvider(props: ParentProps) {
  const [objects, setObjects] = createStore<Objects>({});
  const [terrainSeed, setTerrainSeed] = createSignal(0);
  const [objectIds, setObjectIds] = createStore<number[]>([]);
  const [spatial, setSpatial] = createStore<Record<string, number[]>>({});

  function applyOps(ops: Operation[]) {
    // Collect spatial changes before mutating objects
    const removals: { id: number; key: string }[] = [];
    const additions: { id: number; key: string }[] = [];

    for (const op of ops) {
      switch (op.op) {
        case "Upsert": {
          const existing = objects[op.data.id];
          if (existing?.position) {
            removals.push({ id: existing.id, key: posKey(existing.position.x, existing.position.y) });
          }
          if (op.data.position) {
            additions.push({ id: op.data.id, key: posKey(op.data.position.x, op.data.position.y) });
          }
          break;
        }
        case "Delete": {
          const old = objects[String(op.data)];
          if (old?.position) {
            removals.push({ id: old.id, key: posKey(old.position.x, old.position.y) });
          }
          break;
        }
      }
    }

    const added: number[] = [];
    const deleted: number[] = [];

    setObjects((objects) => {
      for (const op of ops) {
        switch (op.op) {
          case "Upsert": {
            const existing = objects[op.data.id];
            if (existing) {
              existing.object = op.data.object;
              existing.position = op.data.position;
            } else {
              objects[op.data.id] = op.data;
              added.push(op.data.id);
            }
            break;
          }
          case "Delete":
            delete objects[String(op.data)];
            deleted.push(op.data as number);
            break;
        }
      }
    });

    if (added.length || deleted.length) {
      setObjectIds((ids) => {
        for (const id of deleted) {
          const idx = ids.indexOf(id);
          if (idx !== -1) ids.splice(idx, 1);
        }
        ids.push(...added);
      });
    }

    setSpatial((s) => {
      for (const { id, key } of removals) {
        const ids = s[key];
        if (!ids) continue;
        const filtered = ids.filter((i) => i !== id);
        if (filtered.length === 0) delete s[key];
        else s[key] = filtered;
      }
      for (const { id, key } of additions) {
        const ids = s[key];
        if (!ids) s[key] = [id];
        else if (!ids.includes(id)) s[key] = [...ids, id];
      }
    });
  }

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

  function getObjectsAt(x: number, y: number): GameObjectEntry[] {
    console.log("getObjectsAt", x, y);
    return (spatial[posKey(x, y)] ?? [])
      .map((id) => objects[id])
      .filter((e) => !!e);
  }

  return (
    <Ctx value={{ objects, objectIds, terrainSeed, getObjectsAt, send }}>
      {props.children}
    </Ctx>
  );
}

export function useGame() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useGame must be used within <GameProvider>");
  return ctx;
}
