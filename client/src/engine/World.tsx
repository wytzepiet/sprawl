import { onCleanup, createEffect, on } from "solid-js";
import { useInstancePool } from "./InstancePool";
import { useEngine } from "./Canvas";
import { useDayNight } from "./DayNightCycle";
import { useTheme } from "./theme";
import { useHeadlights } from "./Headlights";
import { TerrainChunks } from "./TerrainChunks";
import { setOpsListener, getEntity, getObjectsAt } from "../state/gameObjects";
import type { Operation, GameObjectEntry } from "../generated";

import { mountBuilding } from "./objects/BuildingObject";
import { mountCar } from "./objects/CarObject";
import { mountRoad } from "./objects/RoadNode";

interface MountedEntry {
  kind: string;
  cleanup: () => void;
  neighbors?: number[]; // road node neighbor IDs for dirty tracking
  pos?: { x: number; y: number }; // road node position, for tree suppression
}

export default function World() {
  const pool = useInstancePool();
  const { scene } = useEngine();
  const { ambientColor, shadowGenerator } = useDayNight();
  const theme = useTheme();
  const headlights = useHeadlights();

  const mounted = new Map<string, MountedEntry>();

  const hasRoad = (x: number, y: number) =>
    getObjectsAt(x, y).some((o) => o.object.kind === "RoadNode");

  const terrain = new TerrainChunks(scene, shadowGenerator()!, theme, hasRoad);

  createEffect(on(ambientColor, (amb) => terrain.updateMaterials(amb)));
  createEffect(on(theme, () => terrain.markAllDirty(), { defer: true }));

  function mount(entry: GameObjectEntry): (() => void) | null {
    const th = theme();
    switch (entry.object.kind) {
      case "Building":
        return mountBuilding(entry, pool);
      case "Car":
        return mountCar(entry, pool, scene, headlights);
      case "RoadNode":
        return mountRoad(entry, pool, th, getEntity);
      default:
        return null;
    }
  }

  function processOps(ops: Operation[]) {
    const dirtyRoads = new Set<string>();

    for (const op of ops) {
      switch (op.op) {
        case "Upsert": {
          const key = String(op.data.id);

          if (op.data.object.kind === "Terrain" && op.data.position) {
            const { x, y } = op.data.position;
            terrain.setTile(op.data.id, x, y, op.data.object.data.terrain_type);
            break;
          }

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
              m.pos = entry.position ?? undefined;
            }
            mounted.set(key, m);
          }

          // Mark road neighbors dirty (new connections)
          if (op.data.object.kind === "RoadNode") {
            markDirty(
              [...op.data.object.data.outgoing, ...op.data.object.data.incoming],
              dirtyRoads,
            );
            dirtyRoads.delete(key); // just mounted, skip

            // Trees yield to roads, so the chunk needs remeshing.
            if (op.data.position) {
              terrain.markTile(op.data.position.x, op.data.position.y);
            }
          }
          break;
        }
        case "Delete": {
          const key = String(op.data);
          if (terrain.removeTile(op.data)) break;

          const existing = mounted.get(key);
          if (existing) {
            if (existing.neighbors) markDirty(existing.neighbors, dirtyRoads);
            if (existing.pos) terrain.markTile(existing.pos.x, existing.pos.y);
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
      if (!entry) {
        mounted.delete(id);
        continue;
      }
      const cleanup = mount(entry);
      if (cleanup) {
        const rd = entry.object.data as { outgoing: number[]; incoming: number[] };
        mounted.set(id, {
          kind: "RoadNode",
          cleanup,
          neighbors: [...rd.outgoing, ...rd.incoming],
          pos: entry.position ?? undefined,
        });
      } else {
        mounted.delete(id);
      }
    }
  }

  function markDirty(neighbors: number[], dirty: Set<string>) {
    for (const id of neighbors) dirty.add(String(id));
  }

  setOpsListener(processOps);

  onCleanup(() => {
    setOpsListener(null);
    for (const m of mounted.values()) m.cleanup();
    mounted.clear();
    terrain.dispose();
  });

  return <></>;
}
