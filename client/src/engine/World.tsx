import { onCleanup, createEffect, on } from "solid-js";
import { perfCount } from "./PerfReport";
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

import type { Building, RoadNode } from "../generated";

import { mountBuilding } from "./objects/BuildingObject";
import { mountCar } from "./objects/CarObject";
import { TownLayer } from "./TownLayer";
import { Brush } from "./Brush";

interface MountedEntry {
  kind: string;
  cleanup: () => void;
  /** Tile keys this building covers, kept because the store has already
   *  dropped the entity by the time a Delete reaches us. */
  covers?: string[];
}

export default function World() {
  const pool = useInstancePool();
  const { scene } = useEngine();
  const { ambientColor, shadowGenerator } = useDayNight();
  const theme = useTheme();

  const mounted = new Map<string, MountedEntry>();
  /** Where each road node stands, since a delete arrives without it. */
  const roadAt = new Map<string, { x: number; y: number }>();
  /** What the town draws of each road and building, to tell a change it
   *  must be drawn again for from a shelf filling, a purse changing or a
   *  road joining the world. */
  const drawn = new Map<string, string>();

  const hasRoad = (x: number, y: number) =>
    getObjectsAt(x, y).some((o) => o.object.kind === "RoadNode");

  /** Trees give way to anything built — a road, or any tile of a plot. */
  const isBuilt = (x: number, y: number) => hasRoad(x, y) || builtTiles.has(`${x},${y}`);

  /**
   * Every tile under a building and whose it is, mirroring the server's
   * occupancy index. The store only knows a building at its origin tile, so
   * without this a building would clear the trees from one corner of itself,
   * and a road landing on its far side would not be seen to reach it.
   */
  const builtTiles = new Map<string, number>();

  /** Claim a building's tiles, returning the keys so they can be
   *  released. */
  function cover(entry: GameObjectEntry): string[] {
    if (entry.object.kind !== "Building" || !entry.position) return [];
    const b = entry.object.data as Building;
    const keys = b.tiles.map((t) => {
      const key = `${t.x},${t.y}`;
      builtTiles.set(key, entry.id);
      terrain.markTile(t.x, t.y);
      return key;
    });
    return keys;
  }

  function uncover(keys: string[] | undefined) {
    for (const key of keys ?? []) {
      builtTiles.delete(key);
      const [x, y] = key.split(",").map(Number);
      terrain.markTile(x, y);
    }
  }

  const terrain = new TerrainChunks(scene, shadowGenerator()!, theme, isBuilt);
  const fog = new FogOfWar(scene);
  // Red where no joined road reaches it; grey where any stock is bare.
  const lookOf = (entry: GameObjectEntry) =>
    !reached(entry) ? DORMANT : Object.values((entry.object.data as Building).stocks).every((s) => s.level > 0) ? SOLID : EMPTY;
  const town = new TownLayer(scene, pool, shadowGenerator()!, theme, eachEntity, (x, y) => terrain.typeAt(x, y), lookOf);

  createEffect(on(ambientColor, (amb) => terrain.updateMaterials(amb)));
  createEffect(on(theme, () => (terrain.markAllDirty(), town.repaint()), { defer: true }));

  function mount(entry: GameObjectEntry): (() => void) | null {
    switch (entry.object.kind) {
      case "Building":
        return mountBuilding(entry, pool, scene, theme(), lookOf(entry));
      case "Car":
        return mountCar(entry, pool, scene, theme(), SOLID);
      default:
        return null;
    }
  }

  /**
   * A batch of changes from the server. Cars and what a building lays past
   * its walls are mounted one by one; anything built, a road or a building,
   * has the town drawn again, and the trees make way.
   */
  function processOps(ops: Operation[]) {
    for (const op of ops) {
      const key = String(op.op === "Upsert" ? op.data.id : op.data);
      const existing = mounted.get(key);
      // The store already holds the batch's end state, so an entity
      // upserted and then deleted in one batch is gone from it by now.
      const entry = op.op === "Upsert" ? (getEntity(op.data.id) ?? op.data) : undefined;
      const was = drawn.get(key);
      const now = entry && drawnOf(entry);
      if (now === undefined) drawn.delete(key);
      else drawn.set(key, now);
      // The town is drawn in chunks, most of a second on a grown town: a
      // building that only traded, or only looks otherwise, or a road
      // only joined, leaves it standing as it was.
      const same = now !== undefined && was === now;
      perfCount(`ops.${entry?.object.kind ?? "deleted"}`);
      // One that stands as it stood may still look otherwise, its shelves
      // bare or stocked, or its street newly joined to the world: its
      // colour, and the town not drawn again.
      if (same && entry) for (const e of beside(entry)) town.recolour(e);
      else if (was !== undefined) perfCount(`redraw.${entry?.object.kind ?? "deleted"}`);
      if (existing) {
        if (!same) uncover(existing.covers);
        existing.cleanup();
        mounted.delete(key);
      }
      if (!same) {
        // Trees make way for a road, and come back where one went; the
        // town is drawn again round anything built, as it was and as it is.
        const pos = entry?.object.kind === "RoadNode" ? entry.position : roadAt.get(key);
        if (pos) terrain.markTile(pos.x, pos.y);
        for (const p of [roadAt.get(key), pos]) if (p) town.touch(p.x, p.y);
        for (const k of existing?.covers ?? []) town.touch(...(k.split(",").map(Number) as [number, number]));
        if (entry?.object.kind === "Building") for (const t of (entry.object.data as Building).tiles) town.touch(t.x, t.y);
        if (entry?.object.kind === "RoadNode" && entry.position) roadAt.set(key, entry.position);
        else roadAt.delete(key);
      }
      if (!entry) continue;
      const cleanup = mount(entry);
      if (cleanup) mounted.set(key, { kind: entry.object.kind, cleanup, covers: same ? existing!.covers : entry.object.kind === "Building" ? cover(entry) : undefined });
    }
  }

  /** A building itself; a road, the buildings round it, whose doors
   *  may open onto it. */
  function beside(entry: GameObjectEntry): GameObjectEntry[] {
    if (entry.object.kind === "Building") return [entry];
    if (!entry.position) return [];
    const { x, y } = entry.position;
    const ids = new Set<number>();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const id = builtTiles.get(`${x + dx},${y + dy}`);
      if (id !== undefined) ids.add(id);
    }
    return [...ids].flatMap((id) => getEntity(id) ?? []);
  }

  /** What the town draws of a road, where it stands, its kind and its
   *  links; and of a building, its plot, its door, the streets it joins
   *  and its treatment. */
  function drawnOf(entry: GameObjectEntry): string | undefined {
    if (entry.object.kind === "RoadNode") {
      const n = entry.object.data as RoadNode;
      return JSON.stringify([entry.position, n.road, n.outgoing, n.incoming]);
    }
    if (entry.object.kind !== "Building") return undefined;
    const b = entry.object.data as Building;
    return JSON.stringify([b.kind, b.tiles, b.door, b.joined]);
  }

  setOpsListener(processOps);
  setTerrainListener({
    setChunk: (chunk) => {
      terrain.setChunk(chunk.coord.cx, chunk.coord.cy, chunk.tiles, chunk.heights);
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
    town.dispose();
    terrain.dispose();
    fog.dispose();
  });

  return <Brush ground={(x, y) => terrain.typeAt(x, y)} />;
}
