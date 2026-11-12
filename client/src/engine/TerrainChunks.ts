import { addToScene, readTexture, type Mesh, type Texture2D } from "./gpu";
import { drawShore, shoreMap } from "./shore";
import { cliffMap, drawCliff } from "./cliff";
import { spread } from "./budget";
import type { TownMaterial } from "./material";
import type { EngineContext } from "./Canvas";
import type { Casters } from "./DayNightCycle";
import { drop, meshOf, retire } from "./geometry";
import * as Comlink from "comlink";
import {
  CHUNK_SIZE,
  CHUNK_SKIRT,
  CHUNK_STRIDE,
  TYPE_BY_BYTE,
  type Ground,
  type ChunkGeometry,
  type MeshBuffers,
  cliffed,
  waterOf,
} from "./objects/terrainGeometry";
import { theme } from "./theme";
import { GroundTiles } from "./ground";
import { cliffMaterial, peakMaterial } from "./peaks";
import { waterMaterial } from "./water";
import { live } from "./still";
import { grove, plant, showGrove, uproot, type Grove, type Kind } from "./trees";
import type { TerrainApi } from "./terrainWorker";
import { slateRead } from "./slateTexture";
import { perfMark } from "./PerfReport";

import { groundCover } from "./view";

export { CHUNK_SIZE };

/** Sun frustum half-extent beyond which per-chunk detail is dropped. */
const DETAIL_MAX_HALF = 30;

/** A chunk's meshes, as last drawn: its land's cliff; its mountains. None
 *  where it has none. And its trees, kept as it is drawn again; and what
 *  goes with its materials. */
interface ChunkMeshes {
  meshes: Mesh[];
  trees: Record<Kind, Grove>;
  dispose: (() => void)[];
}

/** The sea a shade deeper than a lake. */
const WATERS = { Water: theme.water, Sea: { r: theme.water.r * 0.85, g: theme.water.g * 0.85, b: theme.water.b * 0.9 } };

const floorDiv = (a: number, b: number) => Math.floor(a / b);
const parseKey = (key: string) => key.split(",").map(Number) as [number, number];

/**
 * Terrain: the land drawn from its tiles' kinds (`GroundTiles`), and per
 * chunk one merged mesh of its water and one of its cliffs.
 *
 * The water and cliff geometry are a pure function of the chunk's tiles,
 * so they are built on a worker. Trees are not: they yield to what is built, which is live game
 * state, so they stay here and are cheap enough to rebuild on demand.
 */
export class TerrainChunks {
  private tiles = new Map<string, Uint8Array>();
  /** The mountains' heights, eroded (`TerrainChunk::heights`). */
  private heights = new Map<string, Uint8Array>();
  private chunks = new Map<string, ChunkMeshes>();
  /** Each chunk's shore, if it has water (`shore.ts`). */
  private shores = new Map<string, Texture2D>();
  /** Each chunk's cliff, if the land's edge runs through it (`cliff.ts`). */
  private cliffs = new Map<string, Texture2D>();
  /** Each chunk's water, if it has any: its mesh, its clock, and its
   *  material's textures to let go. */
  private waters = new Map<string, { mesh: Mesh; tick: () => void; dispose: () => void }>();

  private dirtyGeometry = new Set<string>();
  private dirtyTrees = new Set<string>();
  /** How many times each chunk's trees were asked for: the last answer stands. */
  private planting = new Map<string, number>();
  /**
   * Bumped whenever a chunk's geometry is invalidated. A build carries the
   * generation it started with, so results that arrive after the chunk was
   * unloaded or re-dirtied are dropped instead of resurrecting it.
   */
  private generation = new Map<string, number>();

  private worker = new Worker(new URL("./terrainWorker.ts", import.meta.url), {
    type: "module",
  });
  private builder = Comlink.wrap<TerrainApi>(this.worker);
  /** The worker handed the slate its rock's edges break along, before it builds any. */
  private slated: Promise<void>;

  private ground: GroundTiles;
  private stop: () => void;
  private detailVisible = true;
  /** The chunks the worker is building. */
  private building = new Set<string>();

  constructor(
    private ctx: EngineContext,
    private casters: Casters,
    private isBuilt: (x: number, y: number) => boolean,
    private isQuay: (x: number, y: number) => boolean,
  ) {
    this.ground = new GroundTiles(ctx.engine, ctx.scene, ctx.beforeRender, ctx.cull);
    this.slated = slateRead(ctx.engine).then((texels) => (perfMark("slate read"), this.builder.slate(texels)));

    this.stop = ctx.beforeRender(() => {
      this.updateDetail();
      this.flush();
      for (const water of this.waters.values()) water.tick();
    });
  }


  // --- Tile data ---------------------------------------------------------

  /**
   * A chunk arrives with a skirt of surrounding tiles, so it can be meshed
   * without consulting its neighbours -- no cross-chunk dependency, and the
   * shared skirt keeps the seams consistent.
   */
  setChunk(cx: number, cy: number, tiles: Uint8Array, heights: Uint8Array, deposits: Uint8Array): void {
    const key = `${cx},${cy}`;
    // Grass over a deposit of clay is drawn as clay (`Ground`).
    const [grass, clay] = [TYPE_BY_BYTE.indexOf("Grass"), TYPE_BY_BYTE.indexOf("Clay")];
    this.tiles.set(key, deposits.length ? tiles.map((b, k) => (deposits[k] && b === grass ? clay : b)) : tiles);
    this.heights.set(key, heights);
    this.invalidate(key);
    this.lay(key);
    this.flood(key);
  }

  /** A chunk's tiles as the land is drawn on them. A wood's tile built on
   *  is grass, its floor cleared with its trees; and a harbour's tile at
   *  the water's edge, water: the coast steps back under its paving, which
   *  runs on to the water as a quay (`town/draw.ts`), its wall straight
   *  down where the shore was, and the shore's beach, cliff and foam hid
   *  under it. Anything else built by the water keeps its shore, the
   *  land's cliff past its edge. */
  private drawn(key: string): Uint8Array {
    const tiles = this.tiles.get(key)!;
    const [cx, cy] = parseKey(key);
    const [forest, grass, sea] = [TYPE_BY_BYTE.indexOf("Forest"), TYPE_BY_BYTE.indexOf("Grass"), TYPE_BY_BYTE.indexOf("Sea")];
    const [ox, oy] = [cx * CHUNK_SIZE - CHUNK_SKIRT, cy * CHUNK_SIZE - CHUNK_SKIRT];
    const own = (x: number, y: number) => {
      const [i, j] = [x - ox, y - oy];
      return i >= 0 && j >= 0 && i < CHUNK_STRIDE && j < CHUNK_STRIDE ? TYPE_BY_BYTE[tiles[j * CHUNK_STRIDE + i]] : this.typeAt(x, y);
    };
    return tiles.map((b, k) => {
      const [x, y] = [ox + (k % CHUNK_STRIDE), oy + Math.floor(k / CHUNK_STRIDE)];
      if (!this.isBuilt(x, y)) return b;
      return this.isQuay(x, y) && this.ashore(x, y, own) ? sea : b === forest ? grass : b;
    });
  }

  /** A chunk's ground, drawn from its tiles (`ground.ts`): at once, no
   *  worker; again `within` x0 y0 x1 y1, where something was built. */
  private lay(key: string, within?: number[]): void {
    const [cx, cy] = parseKey(key);
    const drawn = this.drawn(key);
    this.ground.set(key, [cx * CHUNK_SIZE, cy * CHUNK_SIZE], drawn, within);
    // Its cliff, if the land's edge runs through it: drawn from the same
    // kinds, and again where it had one, as it now is.
    if (cliffed(drawn) || this.cliffs.has(key)) {
      const cliff = this.cliffs.get(key) ?? cliffMap(this.ctx.engine);
      this.cliffs.set(key, cliff);
      drawCliff(this.ctx.engine, this.ground.kinds(key)!, cliff, [cx * CHUNK_SIZE, cy * CHUNK_SIZE]);
    }
    // Its shore, if it has water at or beside it: drawn from the same kinds.
    const wet = drawn.some((b, k) => (TYPE_BY_BYTE[b] === "Sea" || TYPE_BY_BYTE[b] === "Water") && [k % CHUNK_STRIDE, Math.floor(k / CHUNK_STRIDE)].every((i) => i > 0 && i < CHUNK_STRIDE - 1));
    if (!wet) return;
    const shore = this.shores.get(key) ?? shoreMap(this.ctx.engine);
    this.shores.set(key, shore);
    drawShore(this.ctx.engine, this.ground.kinds(key)!, shore);
  }

  /** The chunks whose tiles, skirt and all, take a tile in. */
  private around(x: number, y: number): string[] {
    const keys = [-CHUNK_SKIRT, 0, CHUNK_SKIRT].flatMap((dy) => [-CHUNK_SKIRT, 0, CHUNK_SKIRT].map((dx) => `${floorDiv(x + dx, CHUNK_SIZE)},${floorDiv(y + dy, CHUNK_SIZE)}`));
    return [...new Set(keys)].filter((key) => this.tiles.has(key));
  }


  /** A chunk's water, up as its tiles arrive, not when the worker is done
   *  with its land: a pan over the sea shows it at once, breaking on its
   *  land's cliff as that is drawn (`lay`). It ripples every frame: drawn
   *  over the still town, not into it. */
  private flood(key: string): void {
    this.drain(key);
    const buf = waterOf(this.drawn(key), WATERS);
    if (!buf.indices.length) return;
    const { engine, scene, cull } = this.ctx;
    const [ox, oy] = parseKey(key).map((c) => c * CHUNK_SIZE);
    const water = waterMaterial(engine, this.shores.get(key) ?? null, this.cliffs.get(key) ?? null);
    const mesh = meshOf(engine, `chunk_${key}_water`, { positions: buf.positions, normals: buf.normals, indices: buf.indices, colors: buf.colors });
    mesh.material = water.material;
    mesh.receiveShadows = true;
    mesh.position.x = ox;
    mesh.position.y = oy;
    cull.keep(mesh, [ox - CHUNK_SKIRT, oy - CHUNK_SKIRT, ox + CHUNK_SIZE + CHUNK_SKIRT, oy + CHUNK_SIZE + CHUNK_SKIRT]);
    live(mesh);
    addToScene(scene, mesh);
    this.waters.set(key, { mesh, tick: water.tick, dispose: water.dispose });
  }

  private drain(key: string): void {
    const water = this.waters.get(key);
    if (!water) return;
    this.ctx.cull.forget(water.mesh);
    drop(this.ctx.scene, water.mesh);
    water.dispose();
    this.waters.delete(key);
  }

  /** Whether a tile of land has water beside it. */
  private ashore(x: number, y: number, typeAt: (x: number, y: number) => Ground | undefined): boolean {
    const wet = (t: Ground | undefined) => t === "Sea" || t === "Water";
    return !wet(typeAt(x, y)) && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => wet(typeAt(x + dx, y + dy)));
  }

  /** The ground on a tile, if its chunk has arrived. */
  typeAt(x: number, y: number): Ground | undefined {
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
    this.ground.delete(key);
    const shore = this.shores.get(key);
    if (shore) retire(shore), this.shores.delete(key);
    const cliff = this.cliffs.get(key);
    if (cliff) retire(cliff), this.cliffs.delete(key);
    this.drain(key);
    this.disposeChunk(key);
  }

  /** Something built appearing or vanishing, a road or a building, moves
   *  the trees there; and in a wood, the ground under it too, the wood's
   *  floor cleared to grass: a texel of each chunk's kinds that holds it,
   *  the picture drawn again as far round it as it shows. */
  markTile(x: number, y: number): void {
    this.markTrees(x, y);
    if (this.typeAt(x, y) === "Forest") for (const key of this.around(x, y)) this.lay(key, [x - 2, y - 2, x + 3, y + 3]);
  }

  /** A quay built or gone at the water's edge: the coast steps back under
   *  it, or comes back (`drawn`), its water and its cliff with it. */
  markQuay(x: number, y: number): void {
    for (const key of this.around(x, y)) this.lay(key, [x - 2, y - 2, x + 3, y + 3]), this.flood(key), this.invalidate(key);
  }

  /** The trees on a tile planted again, nothing else: a building in hand
   *  moves them, and the town's drawing of it covers the ground. */
  markTrees(x: number, y: number): void {
    this.dirtyTrees.add(`${floorDiv(x, CHUNK_SIZE)},${floorDiv(y, CHUNK_SIZE)}`);
  }

  private invalidate(key: string): void {
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
    this.dirtyGeometry.add(key);
  }

  // --- Rendering ---------------------------------------------------------

  private flush(): void {
    for (const key of this.dirtyTrees) void this.rebuildTrees(key);
    this.dirtyTrees.clear();

    // Dispatch is free — the worker does the work; what it hands back is
    // taken up in frames' spare time (`arriving`).
    // One build of a chunk at a time: changed again meanwhile, it is built
    // once more as it then stands, not once for every change, each behind
    // the last and all but the last thrown away.
    for (const key of this.dirtyGeometry) {
      if (this.building.has(key)) continue;
      this.dirtyGeometry.delete(key);
      this.building.add(key);
      void this.requestBuild(key).finally(() => this.building.delete(key));
    }
  }

  /** A built chunk taken up in two parts, in frames' spare time
   *  (`budget.ts`): its land and meshes, then its trees; neither if it was
   *  unloaded or drawn anew while it waited. */
  private *arriving(key: string, generation: number | undefined, geometry: ChunkGeometry) {
    const current = () => this.tiles.has(key) && this.generation.get(key) === generation;
    if (!current()) return;
    this.applyGeometry(key, geometry);
    perfMark("land in");
    yield;
    if (current()) void this.rebuildTrees(key);
  }

  private async requestBuild(key: string): Promise<void> {
    await this.slated;
    perfMark("land asked");
    const tiles = this.tiles.get(key);
    if (!tiles) {
      this.disposeChunk(key);
      return;
    }
    const [cx, cy] = parseKey(key);
    const generation = this.generation.get(key);

    let geometry: ChunkGeometry | null;
    try {
      // Its cliff as the GPU drew it, read back for its wall to be traced along.
      const cliff = this.cliffs.get(key);
      const field = cliff ? await readTexture(this.ctx.engine, cliff, 0, 1) : null;
      if (!this.tiles.has(key)) return;
      geometry = await this.builder.build(this.drawn(key), this.heights.get(key)!, cx, cy, field && Comlink.transfer(field, [field.buffer]));
      perfMark("land built");
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
    void spread(this.arriving(key, generation, geometry));
  }

  private applyGeometry(key: string, geometry: ChunkGeometry): void {
    const [cx, cy] = parseKey(key);
    const [ox, oy] = [cx * CHUNK_SIZE, cy * CHUNK_SIZE];
    const { engine, scene } = this.ctx;
    const old = this.chunks.get(key);
    const chunk: ChunkMeshes = { meshes: [], trees: old?.trees ?? { broad: grove("chunk", [ox, oy]), conifer: grove("chunk", [ox, oy], "conifer") }, dispose: [] };
    if (old) this.dropMeshes(old);

    // A mesh of what there is, if anything, placed from the chunk's corner
    // or, the mountains' laid where they are on the map, not.
    const add = (name: string, buf: MeshBuffers, material: TownMaterial, at: [number, number]) => {
      if (!buf.indices.length) return null;
      const mesh = meshOf(engine, `chunk_${key}_${name}`, { positions: buf.positions, normals: buf.normals, indices: buf.indices, colors: buf.colors });
      mesh.material = material;
      mesh.receiveShadows = true;
      mesh.position.x = at[0];
      mesh.position.y = at[1];
      // A chunk's own, and its skirt's, over its area; a mountain stands no further out.
      this.ctx.cull.keep(mesh, [ox - CHUNK_SKIRT, oy - CHUNK_SKIRT, ox + CHUNK_SIZE + CHUNK_SKIRT, oy + CHUNK_SIZE + CHUNK_SKIRT]);
      addToScene(scene, mesh);
      this.casters.add(mesh);
      chunk.meshes.push(mesh);
      return mesh;
    };
    // Its own materials: for its own shore, its own field, its own heights.
    const shore = this.shores.get(key) ?? null;
    const field = this.cliffs.get(key);
    if (field) {
      const cliff = cliffMaterial(engine, field, shore);
      chunk.dispose.push(cliff.dispose);
      add("cliff", geometry.cliff, cliff.material, [ox, oy]);
    }
    if (geometry.peakHeights) {
      const peaks = peakMaterial(engine, geometry.peakHeights, [ox, oy]);
      chunk.dispose.push(peaks.dispose);
      add("peaks", geometry.peaks, peaks.material, [0, 0]);
    }
    this.chunks.set(key, chunk);
    this.applyDetail(chunk);

  }

  /** A chunk's trees planted in the worker, round what is built now, and
   *  stood here when they come, unless it was asked again or drawn anew
   *  meanwhile: placement is seeded off the tile coords. */
  private async rebuildTrees(key: string): Promise<void> {
    const chunk = this.chunks.get(key);
    const tiles = this.tiles.get(key);
    if (!chunk || !tiles) return;

    const [cx, cy] = parseKey(key);
    const [ox, oy] = [cx * CHUNK_SIZE - CHUNK_SKIRT, cy * CHUNK_SIZE - CHUNK_SKIRT];
    const built = tiles.map((_, k) => +this.isBuilt(ox + (k % CHUNK_STRIDE), oy + Math.floor(k / CHUNK_STRIDE)));
    const asked = (this.planting.get(key) ?? 0) + 1;
    this.planting.set(key, asked);
    const sets = await this.builder.trees(tiles, built, cx, cy);
    if (this.chunks.get(key) !== chunk || this.planting.get(key) !== asked) return;
    for (const kind of ["broad", "conifer"] as const) {
      const { matrices, colors } = sets[kind];
      plant(this.ctx, chunk.trees[kind], matrices, colors, this.casters);
    }
    this.applyDetail(chunk);
  }

  /** A chunk's meshes and their materials' textures gone; its trees kept. */
  private dropMeshes(chunk: ChunkMeshes): void {
    for (const mesh of chunk.meshes) {
      this.casters.remove(mesh);
      this.ctx.cull.forget(mesh);
      drop(this.ctx.scene, mesh);
    }
    for (const dispose of chunk.dispose) dispose();
  }

  private disposeChunk(key: string): void {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.dropMeshes(chunk);
    for (const g of Object.values(chunk.trees)) uproot(this.ctx, g, this.casters);
    this.chunks.delete(key);
  }

  /** Trees are illegible when zoomed far out — skip them entirely. */
  private updateDetail(): void {
    if (!this.ctx.scene.camera) return;
    const visible = groundCover(this.ctx.scene, this.ctx.canvas).halfH < DETAIL_MAX_HALF;
    if (visible === this.detailVisible) return;
    this.detailVisible = visible;
    for (const chunk of this.chunks.values()) this.applyDetail(chunk);
  }

  private applyDetail(chunk: ChunkMeshes): void {
    for (const kind of ["broad", "conifer"] as const) showGrove(this.ctx, chunk.trees[kind], this.detailVisible);
  }

  dispose(): void {
    this.stop();
    for (const key of [...this.chunks.keys()]) this.disposeChunk(key);
    for (const key of [...this.waters.keys()]) this.drain(key);
    this.ground.dispose();
    for (const shore of this.shores.values()) retire(shore);
    for (const cliff of this.cliffs.values()) retire(cliff);
    this.shores.clear();
    this.worker.terminate();
    this.tiles.clear();
    this.heights.clear();
    this.dirtyGeometry.clear();
    this.dirtyTrees.clear();
  }
}
