import { onCleanup, createEffect, on } from "solid-js";
import { useInstancePool } from "./InstancePool";
import { useEngine } from "./Canvas";
import { useDayNight } from "./DayNightCycle";
import { useTheme } from "./theme";
import { TerrainChunks } from "./TerrainChunks";
import { FogOfWar } from "./FogOfWar";
import {
  eachEntity,
  setOpsListener,
  setTerrainListener,
  getEntity,
  getObjectsAt,
  reached,
  useGame,
} from "../state/gameObjects";
import { SOLID, DORMANT, EMPTY } from "./objects/look";
import type { Operation, GameObjectEntry } from "../generated";

import type { Building } from "../generated";

import { mountBuilding } from "./objects/BuildingObject";
import { mountCar } from "./objects/CarObject";
import { mountRoad } from "./objects/RoadNode";

interface MountedEntry {
  kind: string;
  cleanup: () => void;
  /** Tile keys this building covers, kept because the store has already
   *  dropped the entity by the time a Delete reaches us. */
  covers?: string[];
  neighbors?: number[]; // road node neighbor IDs for dirty tracking
  pos?: { x: number; y: number }; // road node position, for tree suppression
}

export default function World() {
  const pool = useInstancePool();
  const { scene } = useEngine();
  const { ambientColor, shadowGenerator } = useDayNight();
  const theme = useTheme();

  const mounted = new Map<string, MountedEntry>();

  const hasRoad = (x: number, y: number) =>
    getObjectsAt(x, y).some((o) => o.object.kind === "RoadNode");

  /** Trees give way to anything built — a road, or any tile of a plot. */
  const isBuilt = (x: number, y: number) => hasRoad(x, y) || builtTiles.has(`${x},${y}`);

  /**
   * Every tile under a building and whose it is, mirroring the server's
   * occupancy index. The store only knows a building at its origin tile, so
   * without this a footprint would clear the trees from one corner of itself,
   * and a road landing on its far side would not be seen to reach it.
   */
  const builtTiles = new Map<string, number>();

  function footprint(pos: { x: number; y: number }, [w, h]: [number, number]) {
    const tiles: { x: number; y: number }[] = [];
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) tiles.push({ x: pos.x + dx, y: pos.y + dy });
    }
    return tiles;
  }

  /** Claim a building's tiles, returning the keys so they can be released. */
  function cover(entry: GameObjectEntry): string[] {
    if (entry.object.kind !== "Building" || !entry.position) return [];
    const b = entry.object.data as Building;
    return footprint(entry.position, b.size).map((t) => {
      const key = `${t.x},${t.y}`;
      builtTiles.set(key, entry.id);
      terrain.markBuilt(t.x, t.y);
      return key;
    });
  }

  function uncover(keys: string[] | undefined) {
    for (const key of keys ?? []) {
      builtTiles.delete(key);
      const [x, y] = key.split(",").map(Number);
      terrain.markBuilt(x, y);
    }
  }

  const terrain = new TerrainChunks(scene, shadowGenerator()!, theme, isBuilt);
  const fog = new FogOfWar(scene);

  createEffect(on(ambientColor, (amb) => terrain.updateMaterials(amb)));
  createEffect(on(theme, () => terrain.markAllDirty(), { defer: true }));

  function mount(entry: GameObjectEntry): (() => void) | null {
    switch (entry.object.kind) {
      case "Building":
        // Red where no joined road reaches it; grey where the shelves are bare.
        return mountBuilding(entry, pool, !reached(entry) ? DORMANT : (entry.object.data as Building).stock > 0 ? SOLID : EMPTY);
      case "Car":
        return mountCar(entry, pool, scene, SOLID);
      case "RoadNode":
        return mountRoad(entry, pool, theme(), getEntity);
      default:
        return null;
    }
  }

  function processOps(ops: Operation[]) {
    const dirtyRoads = new Set<string>();
    // Buildings whose tile a road landed on or left: reached, or no longer.
    const dirtyBuildings = new Set<string>();
    // Anything landing or leaving on these tiles is beside the plots
    // around them, which redraw: a road on a plot's tile is its driveway.
    const touched = (x0: number, y0: number, x1: number, y1: number, except?: number) => {
      for (let y = y0 - 1; y <= y1 + 1; y++) {
        for (let x = x0 - 1; x <= x1 + 1; x++) {
          const owner = builtTiles.get(`${x},${y}`);
          if (owner !== undefined && owner !== except) dirtyBuildings.add(String(owner));
        }
      }
    };
    const roadTouched = (pos: { x: number; y: number } | null | undefined) => {
      if (pos) touched(pos.x, pos.y, pos.x, pos.y);
    };
    const plotTouched = (entry: GameObjectEntry | undefined) => {
      if (!entry?.position || entry.object.kind !== "Building") return;
      const [w, h] = (entry.object.data as Building).size;
      touched(entry.position.x, entry.position.y, entry.position.x + w - 1, entry.position.y + h - 1, entry.id);
    };

    for (const op of ops) {
      switch (op.op) {
        case "Upsert": {
          const key = String(op.data.id);
          plotTouched(op.data);


          const existing = mounted.get(key);
          if (existing) {
            if (existing.neighbors) markDirty(existing.neighbors, dirtyRoads);
            uncover(existing.covers);
            existing.cleanup();
          }

          // The store already holds the batch's end state, so an entity
          // upserted and then deleted in one batch is gone from it by now.
          // Mount what the op carried; the delete that follows cleans it up.
          const entry = getEntity(op.data.id) ?? op.data;
          const cleanup = mount(entry);
          if (!cleanup) mounted.delete(key);
          if (cleanup) {
            const m: MountedEntry = { kind: entry.object.kind, cleanup };
            if (entry.object.kind === "Building") m.covers = cover(entry);
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
            roadTouched(op.data.position);
          }
          break;
        }
        case "Delete": {
          const key = String(op.data);
          const existing = mounted.get(key);
          if (existing?.covers) {
            for (const t of existing.covers) {
              const [x, y] = t.split(",").map(Number);
              for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const owner = builtTiles.get(`${x + dx},${y + dy}`);
                if (owner !== undefined && String(owner) !== key) dirtyBuildings.add(String(owner));
              }
            }
          }
          if (existing) {
            if (existing.neighbors) markDirty(existing.neighbors, dirtyRoads);
            if (existing.pos) {
              terrain.markTile(existing.pos.x, existing.pos.y);
              roadTouched(existing.pos);
            }
            uncover(existing.covers);
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
    remountBuildings(dirtyBuildings);
    audit(ops);
  }

  /**
   * What is drawn has to be exactly what the store holds: every mounted thing
   * a live entity of the same kind, every road node with a neighbour in the
   * store drawn. A drift here is a ghost on the map — a stub of road with no
   * node behind it — and the batch that caused it is far easier to read than
   * the picture it left. Development only; it walks every entity.
   */
  function audit(ops: Operation[]) {
    if (!import.meta.env.DEV) return;
    const drift: string[] = [];
    for (const [key, m] of mounted) {
      const e = getEntity(Number(key));
      if (!e) drift.push(`drawn ${m.kind} ${key} has no entity`);
      else if (e.object.kind !== m.kind) drift.push(`drawn ${m.kind} ${key} is a ${e.object.kind}`);
    }
    eachEntity((e) => {
      if (e.object.kind !== "RoadNode" || mounted.has(String(e.id))) return;
      const rd = e.object.data;
      if ([...rd.outgoing, ...rd.incoming].some((n) => getEntity(n)?.position)) {
        drift.push(`road ${e.id} at ${e.position?.x},${e.position?.y} has neighbours but is not drawn`);
      }
    });
    if (drift.length) console.warn(`[world] drawing drifted from the store after a batch`, drift, ops);
  }

  function remountBuildings(ids: Set<string>) {
    for (const id of ids) {
      const m = mounted.get(id);
      const entry = getEntity(Number(id));
      if (!m || !entry || entry.object.kind !== "Building") continue;
      m.cleanup();
      const cleanup = mount(entry);
      if (cleanup) mounted.set(id, { kind: "Building", cleanup, covers: m.covers });
      else mounted.delete(id);
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
