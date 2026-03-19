import { onCleanup } from "solid-js";
import { useInstancePool } from "./InstancePool";
import { useEngine } from "./Canvas";
import { useTheme } from "./theme";
import { useHeadlights } from "./Headlights";
import { setOpsListener, getEntity, getObjectsAt } from "../state/gameObjects";
import type { Operation, GameObjectEntry } from "../generated";

import { mountTerrain } from "./objects/TerrainTile";
import { mountBuilding } from "./objects/BuildingObject";
import { mountCar } from "./objects/CarObject";
import { mountRoad } from "./objects/RoadNode";

interface MountedEntry {
  kind: string;
  cleanup: () => void;
  neighbors?: number[]; // road node neighbor IDs for dirty tracking
}

export default function World() {
  const pool = useInstancePool();
  const { scene } = useEngine();
  const theme = useTheme();
  const headlights = useHeadlights();

  const mounted = new Map<string, MountedEntry>();

  function mount(entry: GameObjectEntry): (() => void) | null {
    const th = theme();
    switch (entry.object.kind) {
      case "Terrain":
        return mountTerrain(entry, pool, th, getObjectsAt, scene);
      case "Building":
        return mountBuilding(entry, pool);
      case "Car":
        return mountCar(entry, pool, scene, headlights);
      case "RoadNode":
        return mountRoad(entry, pool, th, getEntity);
    }
  }

  function processOps(ops: Operation[]) {
    const dirtyRoads = new Set<string>();

    for (const op of ops) {
      switch (op.op) {
        case "Upsert": {
          const key = String(op.data.id);
          const existing = mounted.get(key);
          if (existing) {
            if (existing.neighbors) markDirty(existing.neighbors, dirtyRoads);
            existing.cleanup();
          }

          const entry = getEntity(op.data.id)!;
          const cleanup = mount(entry);
          if (cleanup) {
            const m: MountedEntry = { kind: entry.object.kind, cleanup };
            if (entry.object.kind === "RoadNode") {
              const rd = entry.object.data;
              m.neighbors = [...rd.outgoing, ...rd.incoming];
            }
            mounted.set(key, m);
          }

          // Mark road neighbors dirty (new connections)
          if (op.data.object.kind === "RoadNode") {
            markDirty([...op.data.object.data.outgoing, ...op.data.object.data.incoming], dirtyRoads);
            dirtyRoads.delete(key); // just mounted, skip
          }

          // Remount terrain at this position if a road was placed (tree visibility)
          if (op.data.object.kind === "RoadNode" && op.data.position) {
            remountTerrainAt(op.data.position.x, op.data.position.y, dirtyRoads);
          }
          break;
        }
        case "Delete": {
          const key = String(op.data);
          const existing = mounted.get(key);
          if (existing) {
            if (existing.neighbors) markDirty(existing.neighbors, dirtyRoads);
            // Remount terrain if road was removed (tree visibility)
            if (existing.kind === "RoadNode") {
              const entry = getEntity(op.data); // already deleted, won't find it
              // Use position from mounted neighbors or skip — terrain will be correct on next road change
            }
            existing.cleanup();
            mounted.delete(key);
          }
          break;
        }
      }
    }

    // Recompute dirty road neighbors
    for (const id of dirtyRoads) {
      const m = mounted.get(id);
      if (!m || m.kind !== "RoadNode") continue;
      m.cleanup();
      const entry = getEntity(Number(id));
      if (!entry) { mounted.delete(id); continue; }
      const cleanup = mount(entry);
      if (cleanup) {
        mounted.set(id, {
          kind: "RoadNode",
          cleanup,
          neighbors: [...(entry.object.data as { outgoing: number[]; incoming: number[] }).outgoing, ...(entry.object.data as { outgoing: number[]; incoming: number[] }).incoming],
        });
      } else {
        mounted.delete(id);
      }
    }
  }

  function markDirty(neighbors: number[], dirty: Set<string>) {
    for (const id of neighbors) dirty.add(String(id));
  }

  function remountTerrainAt(x: number, y: number, skipSet: Set<string>) {
    for (const entry of getObjectsAt(x, y)) {
      if (entry.object.kind !== "Terrain") continue;
      const key = String(entry.id);
      if (skipSet.has(key)) continue;
      const existing = mounted.get(key);
      if (existing) existing.cleanup();
      const cleanup = mount(entry);
      if (cleanup) mounted.set(key, { kind: "Terrain", cleanup });
      else mounted.delete(key);
    }
  }

  setOpsListener(processOps);

  onCleanup(() => {
    setOpsListener(null);
    for (const m of mounted.values()) m.cleanup();
    mounted.clear();
  });

  return <></>;
}
