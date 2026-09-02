import { onCleanup, createEffect, on } from "solid-js";
import { useInstancePool } from "./InstancePool";
import { useEngine } from "./Canvas";
import { useDayNight } from "./DayNightCycle";
import { useTheme } from "./theme";
import { TerrainChunks } from "./TerrainChunks";
import { FogOfWar } from "./FogOfWar";
import {
  setOpsListener,
  setTerrainListener,
  getEntity,
  getObjectsAt,
  useGame,
} from "../state/gameObjects";
import { lookOf, DOOMED_TRAFFIC, GHOST } from "./objects/draftLook";
import type { Operation, GameObjectEntry } from "../generated";

import { KIND_CATEGORY, ZONE_BYTE } from "./objects/buildings";
import type { Building } from "../generated";

import { mountBuilding } from "./objects/BuildingObject";
import { mountCar } from "./objects/CarObject";
import { mountRoad } from "./objects/RoadNode";

interface MountedEntry {
  kind: string;
  cleanup: () => void;
  /** Tile keys this building tinted, kept because the store has already
   *  dropped the entity by the time a Delete reaches us. */
  zoned?: string[];
  neighbors?: number[]; // road node neighbor IDs for dirty tracking
  pos?: { x: number; y: number }; // road node position, for tree suppression
}

export default function World() {
  const pool = useInstancePool();
  const { me } = useGame();
  const { scene } = useEngine();
  const { ambientColor, shadowGenerator } = useDayNight();
  const theme = useTheme();

  const mounted = new Map<string, MountedEntry>();

  const hasRoad = (x: number, y: number) =>
    getObjectsAt(x, y).some((o) => o.object.kind === "RoadNode");

  /**
   * Trees give way to anything built — a road, or any tile of a plot. Drafts
   * count: clearing the ground is part of seeing what you are about to build,
   * and discarding puts the trees back.
   */
  const isBuilt = (x: number, y: number) => hasRoad(x, y) || zoneTiles.has(`${x},${y}`);

  const onDoomedRoad = (entry: GameObjectEntry) => {
    const p = entry.position;
    if (!p) return false;
    return getObjectsAt(p.x, p.y).some(
      (o) => o.object.kind === "RoadNode" && o.draft?.state === "Removed",
    );
  };

  /**
   * Tile → category byte, mirroring the server's occupancy index. The store
   * only knows a building at its origin tile, so without this a footprint would
   * tint one corner of itself.
   */
  const zoneTiles = new Map<string, number>();
  const zoneAt = (x: number, y: number) => zoneTiles.get(`${x},${y}`) ?? 0;

  function footprint(pos: { x: number; y: number }, [w, h]: [number, number]) {
    const tiles: { x: number; y: number }[] = [];
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) tiles.push({ x: pos.x + dx, y: pos.y + dy });
    }
    return tiles;
  }

  /** Tint a building's tiles, returning the keys so they can be cleared later. */
  function addZone(entry: GameObjectEntry): string[] {
    if (entry.object.kind !== "Building" || !entry.position) return [];
    const b = entry.object.data as Building;
    const byte = ZONE_BYTE[KIND_CATEGORY[b.kind]];
    return footprint(entry.position, b.size).map((t) => {
      const key = `${t.x},${t.y}`;
      zoneTiles.set(key, byte);
      terrain.markZone(t.x, t.y);
      return key;
    });
  }

  function clearZone(keys: string[] | undefined) {
    for (const key of keys ?? []) {
      zoneTiles.delete(key);
      const [x, y] = key.split(",").map(Number);
      terrain.markZone(x, y);
    }
  }

  const terrain = new TerrainChunks(scene, shadowGenerator()!, theme, isBuilt, zoneAt);
  const fog = new FogOfWar(scene);

  createEffect(on(ambientColor, (amb) => terrain.updateMaterials(amb)));
  createEffect(on(theme, () => terrain.markAllDirty(), { defer: true }));

  function mount(entry: GameObjectEntry): (() => void) | null {
    const th = theme();
    // Uncommitted work is drawn, just visibly unfinished. Whose it is decides
    // how: yours keeps its colour, everyone else's is drained of it.
    const look = lookOf(entry.draft, me());
    switch (entry.object.kind) {
      case "Building":
        return mountBuilding(entry, pool, look);
      case "Car":
        // A car on a road that is going away fades with it, so the two read as
        // one thing being replaced. Re-evaluated whenever the car is upserted,
        // which the simulation does at every segment it enters.
        return mountCar(entry, pool, scene, onDoomedRoad(entry) ? DOOMED_TRAFFIC : look);
      case "RoadNode":
        return mountRoad(entry, pool, th, getEntity, look);
      case "Proposal":
        // Same shape as a building, drawn as the one it would become.
        return mountBuilding(entry, pool, GHOST);
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


          const existing = mounted.get(key);
          if (existing) {
            if (existing.neighbors) markDirty(existing.neighbors, dirtyRoads);
            clearZone(existing.zoned);
            existing.cleanup();
          }

          const entry = getEntity(op.data.id)!;
          const cleanup = mount(entry);
          if (!cleanup) mounted.delete(key);
          if (cleanup) {
            const m: MountedEntry = { kind: entry.object.kind, cleanup };
            if (entry.object.kind === "Building") m.zoned = addZone(entry);
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
          const existing = mounted.get(key);
          if (existing) {
            if (existing.neighbors) markDirty(existing.neighbors, dirtyRoads);
            if (existing.pos) terrain.markTile(existing.pos.x, existing.pos.y);
            clearZone(existing.zoned);
            existing.cleanup();
            mounted.delete(key);
          }
          break;
        }
      }
    }

    // Recompute dirty road neighbours.
    //
    // A node that is not currently mounted still belongs here: one whose
    // neighbours had not arrived drew nothing and was left out, and this is the
    // moment its neighbour turned up. Skipping those is what left roads
    // invisible until a reload.
    for (const id of dirtyRoads) {
      const m = mounted.get(id);
      if (m && m.kind !== "RoadNode") continue;
      m?.cleanup();
      const entry = getEntity(Number(id));
      if (!entry || entry.object.kind !== "RoadNode") {
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
  setTerrainListener({
    setChunk: (chunk) => {
      terrain.setChunk(chunk.coord.cx, chunk.coord.cy, chunk.tiles);
      fog.setChunk(chunk.coord.cx, chunk.coord.cy);
    },
    unloadChunk: (coord) => {
      terrain.unloadChunk(coord.cx, coord.cy);
      fog.unloadChunk(coord.cx, coord.cy);
    },
  });

  onCleanup(() => {
    setOpsListener(null);
    setTerrainListener(null);
    for (const m of mounted.values()) m.cleanup();
    mounted.clear();
    terrain.dispose();
    fog.dispose();
  });

  return <></>;
}
