import { setMeshVisible, type Mesh } from "@babylonjs/lite";
import { CAST_ONLY, FLAT, townMaterial, type TownMaterial } from "./material";
import type { EngineContext } from "./Canvas";
import type { Casters } from "./DayNightCycle";
import { drop, meshOf, show } from "./geometry";
import * as Comlink from "comlink";
import type { Theme } from "./theme";
import {
  buildTrees,
  CHUNK_SIZE,
  CHUNK_SKIRT,
  CHUNK_STRIDE,
  TYPE_BY_BYTE,
  type ChunkGeometry,
  type MeshBuffers,
  type TerrainPalette,
} from "./objects/terrainGeometry";
import { GroundTiles } from "./ground";
import { cliffMaterial, peakMaterial } from "./peaks";
import { waterMaterial } from "./water";
import { grove, plant, uproot, type Grove } from "./trees";
import type { TerrainApi } from "./terrainWorker";
import type { TerrainType } from "../generated";

import { viewExtent } from "./view";

export { CHUNK_SIZE };

/**
 * Finished chunks uploaded per frame. The build is off-thread now, but the
 * upload is not — this caps how much GPU work one frame can take on.
 */
const APPLIES_PER_FRAME = 2;

/** Sun frustum half-extent beyond which per-chunk detail is dropped. */
const DETAIL_MAX_ORTHO = 30;

/** A chunk's meshes, as last drawn: its water; its cliffs' walls, flat; the
 *  plane under the land's edge its cliff is painted on; its mountains; the
 *  walls under their layers, in the shadow map alone. None where it has none.
 *  And its trees, kept as it is drawn again; what goes with its materials;
 *  and its water's clock. */
interface ChunkMeshes {
  meshes: Mesh[];
  cliffs: Mesh | null;
  trees: Grove;
  hasTrees: boolean;
  dispose: (() => void)[];
  tick: (() => void) | null;
}

const floorDiv = (a: number, b: number) => Math.floor(a / b);
const parseKey = (key: string) => key.split(",").map(Number) as [number, number];

/**
 * Terrain: the land's layers as tiles (`GroundTiles`), and per chunk one
 * merged mesh of its water and one of its cliffs.
 *
 * Which shape each tile of the land takes, and the water and cliff geometry,
 * are a pure function of the chunk's tiles, so they are built on a worker. Trees are not: they yield to what is built, which is live game
 * state, so they stay here and are cheap enough to rebuild on demand.
 */
export class TerrainChunks {
  private tiles = new Map<string, Uint8Array>();
  /** The mountains' heights, eroded (`TerrainChunk::heights`). */
  private heights = new Map<string, Uint8Array>();
  private chunks = new Map<string, ChunkMeshes>();

  private dirtyGeometry = new Set<string>();
  private dirtyTrees = new Set<string>();
  /**
   * Bumped whenever a chunk's geometry is invalidated. A build carries the
   * generation it started with, so results that arrive after the chunk was
   * unloaded or re-dirtied are dropped instead of resurrecting it.
   */
  private generation = new Map<string, number>();
  private ready: { key: string; geometry: ChunkGeometry }[] = [];

  private worker = new Worker(new URL("./terrainWorker.ts", import.meta.url), {
    type: "module",
  });
  private builder = Comlink.wrap<TerrainApi>(this.worker);

  private ground: GroundTiles;
  /** The cliffs' walls, drawn flat; the mountains' walls, cast only. The
   *  walls cast only from the side away from the sun; the faces turned to
   *  it, whose shadow falls on the layer they hold up, are culled. Which
   *  side that is, wound as `layWalls` winds them and seen from the sun, was
   *  found by the shadow a lee side throws on the ground. */
  private cliffMat: TownMaterial;
  private wallMat: TownMaterial;
  private stop: () => void;
  private detailVisible = true;

  constructor(
    private ctx: EngineContext,
    private casters: Casters,
    private theme: () => Theme,
    private isBuilt: (x: number, y: number) => boolean,
  ) {
    // The one material that genuinely wants both sides. Cliff walls exist only
    // to cast shadows, and the sun swings through 360 degrees while a wall's
    // facing is fixed -- culled, a wall pointing away from the sun writes no
    // depth into the shadow map and its cliff stops casting for half the day.
    // They are edge-on to the camera, so the second side costs no fill.
    this.cliffMat = townMaterial([FLAT]);
    this.cliffMat.doubleSided = true;
    this.wallMat = townMaterial([CAST_ONLY]);

    this.ground = new GroundTiles(ctx.engine, ctx.scene, ctx.beforeRender);
    this.paintGround();

    this.stop = ctx.beforeRender(() => {
      this.updateDetail();
      this.flush();
      for (const chunk of this.chunks.values()) chunk.tick?.();
    });
  }

  /** Each layer of the land its colour, bottom up (`LAYERS`). */
  private paintGround(): void {
    const t = this.theme();
    this.ground.paint([t.beach, t.rock, t.land, t.forest]);
  }

  /** The worker has no Babylon, so the theme crosses as plain floats. */
  private palette(): TerrainPalette {
    const t = this.theme();
    return {
      Water: { r: t.water.r, g: t.water.g, b: t.water.b },
      // The sea a shade deeper than a lake.
      Sea: { r: t.water.r * 0.85, g: t.water.g * 0.85, b: t.water.b * 0.9 },
      Beach: { r: t.beach.r, g: t.beach.g, b: t.beach.b },
      Grass: { r: t.land.r, g: t.land.g, b: t.land.b },
      Forest: { r: t.forest.r, g: t.forest.g, b: t.forest.b },
      Mountain: { r: t.mountain.r, g: t.mountain.g, b: t.mountain.b },
    };
  }

  // --- Tile data ---------------------------------------------------------

  /**
   * A chunk arrives with a skirt of surrounding tiles, so it can be meshed
   * without consulting its neighbours -- no cross-chunk dependency, and the
   * shared skirt keeps the seams consistent.
   */
  setChunk(cx: number, cy: number, tiles: Uint8Array, heights: Uint8Array): void {
    const key = `${cx},${cy}`;
    this.tiles.set(key, tiles);
    this.heights.set(key, heights);
    this.invalidate(key);
  }


  /** The ground on a tile, if its chunk has arrived. */
  typeAt(x: number, y: number): TerrainType | undefined {
    const [cx, cy] = [floorDiv(x, CHUNK_SIZE), floorDiv(y, CHUNK_SIZE)];
    const tiles = this.tiles.get(`${cx},${cy}`);
    if (!tiles) return undefined;
    const [ix, iy] = [x - cx * CHUNK_SIZE + CHUNK_SKIRT, y - cy * CHUNK_SIZE + CHUNK_SKIRT];
    return TYPE_BY_BYTE[tiles[iy * CHUNK_STRIDE + ix]];
  }

  unloadChunk(cx: number, cy: number): void {
    const key = `${cx},${cy}`;
    this.tiles.delete(key);
    this.heights.delete(key);
    this.invalidate(key);
    this.disposeChunk(key);
  }

  /** Something built appearing or vanishing, a road or a building, moves
   *  the trees there; and in a wood, the ground under it too, the wood's
   *  floor cleared to grass (`requestBuild`): for every chunk whose tiles,
   *  skirt and all, take it in. Nothing else of the land. */
  markTile(x: number, y: number): void {
    this.dirtyTrees.add(`${floorDiv(x, CHUNK_SIZE)},${floorDiv(y, CHUNK_SIZE)}`);
    if (this.typeAt(x, y) !== "Forest") return;
    for (const dy of [-CHUNK_SKIRT, 0, CHUNK_SKIRT]) {
      for (const dx of [-CHUNK_SKIRT, 0, CHUNK_SKIRT]) {
        const key = `${floorDiv(x + dx, CHUNK_SIZE)},${floorDiv(y + dy, CHUNK_SIZE)}`;
        if (this.chunks.has(key)) this.invalidate(key);
      }
    }
  }

  /** Rebuild every chunk — used when the theme changes all terrain colours. */
  markAllDirty(): void {
    this.paintGround();
    for (const key of this.chunks.keys()) this.invalidate(key);
  }

  private invalidate(key: string): void {
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
    this.dirtyGeometry.add(key);
    this.dirtyTrees.delete(key);
  }

  // --- Rendering ---------------------------------------------------------

  private flush(): void {
    for (const key of this.dirtyTrees) this.rebuildTrees(key);
    this.dirtyTrees.clear();

    // Dispatch is free — the worker does the work. Only the uploads are capped.
    for (const key of this.dirtyGeometry) void this.requestBuild(key);
    this.dirtyGeometry.clear();

    let budget = APPLIES_PER_FRAME;
    while (this.ready.length > 0 && budget-- > 0) {
      const { key, geometry } = this.ready.shift()!;
      this.applyGeometry(key, geometry);
    }
  }

  private async requestBuild(key: string): Promise<void> {
    const tiles = this.tiles.get(key);
    if (!tiles) {
      this.disposeChunk(key);
      return;
    }
    const [cx, cy] = parseKey(key);
    const generation = this.generation.get(key);

    let geometry: ChunkGeometry | null;
    try {
      // tiles is cloned, not transferred — we keep it for tree rebuilds. A
      // wood's tile built on is drawn as grass, its floor cleared with its trees.
      const [forest, grass] = [TYPE_BY_BYTE.indexOf("Forest"), TYPE_BY_BYTE.indexOf("Grass")];
      const [ox, oy] = [cx * CHUNK_SIZE - CHUNK_SKIRT, cy * CHUNK_SIZE - CHUNK_SKIRT];
      const cleared = tiles.map((b, k) => (b === forest && this.isBuilt(ox + (k % CHUNK_STRIDE), oy + Math.floor(k / CHUNK_STRIDE)) ? grass : b));
      geometry = await this.builder.build(cleared, this.heights.get(key)!, cx, cy, this.palette());
    } catch (e) {
      // Terrain is sent once and never re-requested, so dropping a failed build
      // leaves a permanent hole that now reads as fog. Queue it again instead.
      console.error("[terrain] chunk build failed, retrying", key, e);
      this.dirtyGeometry.add(key);
      return;
    }

    if (this.generation.get(key) !== generation) return; // superseded
    if (!geometry) {
      this.disposeChunk(key);
      return;
    }
    this.ready.push({ key, geometry });
  }

  private applyGeometry(key: string, geometry: ChunkGeometry): void {
    const [cx, cy] = parseKey(key);
    const [ox, oy] = [cx * CHUNK_SIZE, cy * CHUNK_SIZE];
    const { engine, scene } = this.ctx;
    const old = this.chunks.get(key);
    const chunk: ChunkMeshes = { meshes: [], cliffs: null, trees: old?.trees ?? grove(this.ctx, `chunk_${key}`), hasTrees: old?.hasTrees ?? false, dispose: [], tick: null };
    if (old) this.dropMeshes(old);

    this.ground.set(key, [ox, oy], geometry.layers);
    // A mesh of what there is, if anything, placed from the chunk's corner
    // or, the mountains' laid where they are on the map, not.
    const add = (name: string, buf: MeshBuffers, material: TownMaterial, at: [number, number], shadows: { cast: boolean; receive: boolean }) => {
      if (!buf.indices.length) return null;
      const mesh = meshOf(engine, `chunk_${key}_${name}`, { positions: buf.positions, normals: buf.normals, indices: buf.indices, colors: buf.colors });
      mesh.material = material;
      mesh.receiveShadows = shadows.receive;
      mesh.position.x = at[0];
      mesh.position.y = at[1];
      show(scene, mesh);
      if (shadows.cast) this.casters.add(mesh);
      chunk.meshes.push(mesh);
      return mesh;
    };
    // Its own materials: for its own shore, its own field, its own heights.
    const water = waterMaterial(engine, geometry.shore, geometry.cliffField);
    chunk.dispose.push(water.dispose);
    chunk.tick = water.tick;
    add("water", geometry.water, water.material, [ox, oy], { cast: false, receive: true });
    chunk.cliffs = add("cliffs", geometry.cliffs, this.cliffMat, [ox, oy], { cast: true, receive: false });
    if (geometry.cliffField) {
      const cliff = cliffMaterial(engine, geometry.cliffField);
      chunk.dispose.push(cliff.dispose);
      add("cliff", geometry.cliff, cliff.material, [ox, oy], { cast: false, receive: true });
    }
    if (geometry.peakHeights) {
      const peaks = peakMaterial(engine, geometry.peakHeights);
      chunk.dispose.push(peaks.dispose);
      add("peaks", geometry.peaks, peaks.material, [0, 0], { cast: true, receive: true });
    }
    add("walls", geometry.peakWalls, this.wallMat, [0, 0], { cast: true, receive: false });
    this.chunks.set(key, chunk);
    this.applyDetail(chunk);

    this.rebuildTrees(key);
  }

  /** Cheap enough to run on demand: placement is seeded off the tile coords. */
  private rebuildTrees(key: string): void {
    const chunk = this.chunks.get(key);
    const tiles = this.tiles.get(key);
    if (!chunk || !tiles) return;

    const [cx, cy] = parseKey(key);
    const { matrices, colors } = buildTrees(tiles, cx, cy, this.isBuilt, this.theme().crowns);
    // Grown from the chunk's corner.
    for (const mesh of [chunk.trees.bodies, chunk.trees.tops]) {
      mesh.position.x = cx * CHUNK_SIZE;
      mesh.position.y = cy * CHUNK_SIZE;
    }
    chunk.hasTrees = plant(this.ctx, chunk.trees, matrices, colors, this.casters);
    this.applyDetail(chunk);
  }

  /** A chunk's meshes and their materials' textures gone; its trees kept. */
  private dropMeshes(chunk: ChunkMeshes): void {
    for (const mesh of chunk.meshes) {
      this.casters.remove(mesh);
      drop(this.ctx.scene, mesh);
    }
    for (const dispose of chunk.dispose) dispose();
  }

  private disposeChunk(key: string): void {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.dropMeshes(chunk);
    uproot(this.ctx, chunk.trees, this.casters);
    this.ground.delete(key);
    this.chunks.delete(key);
  }

  /** Cliffs and trees are illegible when zoomed far out — skip them entirely. */
  private updateDetail(): void {
    if (!this.ctx.scene.camera) return;
    const visible = viewExtent(this.ctx.scene, this.ctx.canvas).halfH < DETAIL_MAX_ORTHO;
    if (visible === this.detailVisible) return;
    this.detailVisible = visible;
    for (const chunk of this.chunks.values()) this.applyDetail(chunk);
  }

  private applyDetail(chunk: ChunkMeshes): void {
    if (chunk.cliffs) setMeshVisible(chunk.cliffs, this.detailVisible);
    if (chunk.hasTrees) for (const mesh of [chunk.trees.bodies, chunk.trees.tops]) setMeshVisible(mesh, this.detailVisible);
  }

  dispose(): void {
    this.stop();
    for (const key of [...this.chunks.keys()]) this.disposeChunk(key);
    this.ground.dispose();
    this.worker.terminate();
    this.tiles.clear();
    this.heights.clear();
    this.dirtyGeometry.clear();
    this.dirtyTrees.clear();
    this.ready.length = 0;
  }
}
