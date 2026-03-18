import {
  createContext,
  useContext,
  createSignal,
  onCleanup,
  batch,
  type ParentProps,
} from "solid-js";
import { createStore } from "solid-js/store";
import { createConnection, updateClockOffset } from "../network/connection";
import type { GameObjectEntry, ClientMessage, Operation } from "../generated";

type Objects = Record<string, GameObjectEntry>;

function posKey(x: number, y: number): string {
  return `${x},${y}`;
}

interface GameContext {
  objects: Objects;
  terrainSeed(): number;
  getObjectsAt(x: number, y: number): GameObjectEntry[];
  send(msg: ClientMessage): void;
}

const Ctx = createContext<GameContext>();

export function GameProvider(props: ParentProps) {
  const [objects, setObjects] = createStore<Objects>({});
  const [terrainSeed, setTerrainSeed] = createSignal(0);
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

    batch(() => {
      for (const op of ops) {
        switch (op.op) {
          case "Upsert": {
            const key = String(op.data.id);
            if (objects[key]) {
              setObjects(key, "object", op.data.object);
              setObjects(key, "position", op.data.position);
            } else {
              setObjects(key, op.data);
            }
            break;
          }
          case "Delete": {
            setObjects(String(op.data), undefined as any);
            break;
          }
        }
      }

      for (const { id, key } of removals) {
        const ids = spatial[key];
        if (!ids) continue;
        const filtered = ids.filter(i => i !== id);
        if (filtered.length === 0) setSpatial(key, undefined as any);
        else setSpatial(key, filtered);
      }
      for (const { id, key } of additions) {
        const ids = spatial[key];
        if (!ids) setSpatial(key, [id]);
        else if (!ids.includes(id)) setSpatial(key, [...ids, id]);
      }
    });
  }

  // Chunked upsert processing — deletes flush immediately, upserts drain across frames
  const UPSERTS_PER_FRAME = 100;
  let upsertQueue: Operation[] = [];
  let drainScheduled = false;

  function enqueueOps(ops: Operation[]) {
    const deletes: Operation[] = [];
    const upserts: Operation[] = [];
    for (const op of ops) {
      if (op.op === "Delete") deletes.push(op);
      else upserts.push(op);
    }

    if (deletes.length) applyOps(deletes);

    upsertQueue.push(...upserts);
    if (!drainScheduled) scheduleDrain();
  }

  function scheduleDrain() {
    if (upsertQueue.length === 0) { drainScheduled = false; return; }
    drainScheduled = true;
    requestAnimationFrame(() => {
      const chunk = upsertQueue.splice(0, UPSERTS_PER_FRAME);
      if (chunk.length) applyOps(chunk);
      scheduleDrain();
    });
  }

  const { send, close } = createConnection("ws://localhost:3001/ws", (msg) => {
    switch (msg.type) {
      case "Update":
        updateClockOffset(msg.data.server_time);
        if (msg.data.terrain_seed) setTerrainSeed(msg.data.terrain_seed);
        enqueueOps(msg.data.ops);
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
    return (spatial[posKey(x, y)] ?? [])
      .map((id) => objects[id])
      .filter((e) => !!e);
  }

  return (
    <Ctx.Provider value={{ objects, terrainSeed, getObjectsAt, send }}>
      {props.children}
    </Ctx.Provider>
  );
}

export function useGame() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useGame must be used within <GameProvider>");
  return ctx;
}
