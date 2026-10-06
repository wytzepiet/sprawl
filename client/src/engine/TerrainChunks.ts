import {
  Color3,
  Mesh,
  StandardMaterial,
  VertexData,
  type Nullable,
  type Observer,
  type Scene,
  type ShadowGenerator,
} from "@babylonjs/core";
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
import { giveClimb, peakMaterial } from "./peaks";
import { waterMaterial } from "./water";
import { grove, plant, treeMaterials, uproot, type Grove } from "./trees";
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

interface ChunkMeshes {
  water: Mesh;
  cliffs: Mesh;
  peaks: Mesh;
  trees: Grove;
  /** Empty meshes must stay disabled — see applyBuffers. */
  hasCliffs: boolean;
  hasTrees: boolean;
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
  /** How far into its range each tile is (`TerrainChunk::depths`). */
  private depths = new Map<string, Uint8Array>();
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
  /** The light the water's materials, one a chunk, are lit with. */
  private ambient = new Color3(1, 1, 1);
  private cliffMat: StandardMaterial;
  /** The mountains' peaks, lit as the rock is. */
  private peakMat: StandardMaterial;
  private observer: Nullable<Observer<Scene>>;
  private detailVisible = true;

  constructor(
    private scene: Scene,
    private shadowGenerator: ShadowGenerator,
    private theme: () => Theme,
    private isBuilt: (x: number, y: number) => boolean,
  ) {
    this.cliffMat = new StandardMaterial("terrain_cliff", scene);
    // The one material that genuinely wants both sides. Cliff walls exist only
    // to cast shadows, and the sun swings through 360 degrees while a wall's
    // facing is fixed -- culled, a wall pointing away from the sun writes no
    // depth into the shadow map and its cliff stops casting for half the day.
    // They are edge-on to the camera, so the second side costs no fill.
    this.cliffMat.backFaceCulling = false;
    this.cliffMat.specularColor = Color3.Black();
    this.cliffMat.disableLighting = true;

    this.peakMat = peakMaterial(scene, "terrain_peaks");

    this.ground = new GroundTiles(scene);
    this.paintGround();
    this.updateMaterials(new Color3(1, 1, 1));

    this.observer = scene.onBeforeRenderObservable.add(() => {
      this.updateDetail();
      this.flush();
    });
  }

  /** Each layer of the land its colour, bottom up (`LAYERS`). */
  private paintGround(): void {
    const t = this.theme();
    this.ground.paint([t.beach, t.land, t.forest].map((c) => new Color3(c.r, c.g, c.b)));
    this.peakMat.diffuseColor = new Color3(t.mountain.r, t.mountain.g, t.mountain.b);
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
  setChunk(cx: number, cy: number, tiles: Uint8Array, depths: Uint8Array): void {
    const key = `${cx},${cy}`;
    this.tiles.set(key, tiles);
    this.depths.set(key, depths);
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
    this.depths.delete(key);
    this.invalidate(key);
    this.disposeChunk(key);
  }

  /** Something built appearing or vanishing, a road or a building, moves
   *  the trees there, and nothing else of the land. */
  markTile(x: number, y: number): void {
    this.dirtyTrees.add(`${floorDiv(x, CHUNK_SIZE)},${floorDiv(y, CHUNK_SIZE)}`);
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
      // tiles is cloned, not transferred — we keep it for tree rebuilds.
      geometry = await this.builder.build(tiles, this.depths.get(key)!, cx, cy, this.palette());
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
    const meshes =
      this.chunks.get(key) ?? this.createChunk(key, cx * CHUNK_SIZE, cy * CHUNK_SIZE);

    this.ground.set(key, [cx * CHUNK_SIZE, cy * CHUNK_SIZE], geometry.layers);
    // Its own material, for its own shore.
    meshes.water.material?.dispose();
    meshes.water.material = waterMaterial(this.scene, geometry.shore, this.theme().beach);
    (meshes.water.material as StandardMaterial).emissiveColor = this.ambient.scale(0.15);
    meshes.water.setEnabled(this.applyBuffers(meshes.water, geometry.water));
    meshes.hasCliffs = this.applyBuffers(meshes.cliffs, geometry.cliffs);
    meshes.peaks.setEnabled(this.applyBuffers(meshes.peaks, geometry.peaks));
    giveClimb(meshes.peaks, geometry.peaks);
    this.applyDetail(meshes);

    this.rebuildTrees(key);
  }

  /** Cheap enough to run on demand: placement is seeded off the tile coords. */
  private rebuildTrees(key: string): void {
    const meshes = this.chunks.get(key);
    const tiles = this.tiles.get(key);
    if (!meshes || !tiles) return;

    const [cx, cy] = parseKey(key);
    const { matrices, colors } = buildTrees(tiles, cx, cy, this.isBuilt, this.theme().crowns);
    meshes.hasTrees = plant(meshes.trees, matrices, colors);
    this.applyDetail(meshes);
  }

  private createChunk(key: string, originX: number, originY: number): ChunkMeshes {
    const water = new Mesh(`chunk_${key}_water`, this.scene);
    water.receiveShadows = true;

    const cliffs = new Mesh(`chunk_${key}_cliffs`, this.scene);
    cliffs.material = this.cliffMat;

    const peaks = new Mesh(`chunk_${key}_peaks`, this.scene);
    peaks.material = this.peakMat;
    peaks.receiveShadows = true;
    peaks.setEnabled(false);

    const trees = grove(this.scene, `chunk_${key}`, this.shadowGenerator);

    // Laid where they are on the map, not from the chunk's corner.
    peaks.isPickable = false;

    const meshes: ChunkMeshes = { water, cliffs, peaks, trees, hasCliffs: false, hasTrees: false };
    for (const mesh of [water, cliffs, trees.bodies, trees.tops]) {
      mesh.isPickable = false;
      mesh.position.x = originX;
      mesh.position.y = originY;
    }
    this.shadowGenerator.addShadowCaster(cliffs);
    this.shadowGenerator.addShadowCaster(peaks);
    this.applyDetail(meshes);

    this.chunks.set(key, meshes);
    return meshes;
  }

  /**
   * Returns false when there is nothing to draw. Applying empty VertexData
   * leaves a zero-sized index buffer behind a draw call that still carries the
   * old index count — WebGPU rejects it and drops the entire frame — so an
   * empty chunk mesh is left alone and disabled instead.
   */
  private applyBuffers(mesh: Mesh, buf: MeshBuffers): boolean {
    if (buf.indices.length === 0) return false;

    const data = new VertexData();
    data.positions = buf.positions;
    data.indices = buf.indices;
    data.normals = buf.normals;
    if (buf.colors) data.colors = buf.colors;
    data.applyToMesh(mesh);
    // Vertex colours are opaque; without this Babylon routes the mesh through
    // the alpha-blended pass and it sorts against the rest of the terrain.
    mesh.hasVertexAlpha = false;
    return true;
  }

  private disposeChunk(key: string): void {
    const meshes = this.chunks.get(key);
    if (!meshes) return;
    this.shadowGenerator.removeShadowCaster(meshes.cliffs);
    this.shadowGenerator.removeShadowCaster(meshes.peaks);
    meshes.peaks.dispose();
    uproot(meshes.trees, this.shadowGenerator);
    this.ground.delete(key);
    meshes.water.material?.dispose();
    meshes.water.dispose();
    meshes.cliffs.dispose();
    this.chunks.delete(key);
  }

  /** Cliffs and trees are illegible when zoomed far out — skip them entirely. */
  private updateDetail(): void {
    const canvas = this.scene.getEngine().getRenderingCanvas();
    if (!this.scene.activeCamera || !canvas) return;
    const visible = viewExtent(this.scene, canvas).halfH < DETAIL_MAX_ORTHO;
    if (visible === this.detailVisible) return;
    this.detailVisible = visible;
    for (const meshes of this.chunks.values()) this.applyDetail(meshes);
  }

  private applyDetail(meshes: ChunkMeshes): void {
    meshes.cliffs.setEnabled(this.detailVisible && meshes.hasCliffs);
    meshes.trees.bodies.setEnabled(this.detailVisible && meshes.hasTrees);
    meshes.trees.tops.setEnabled(this.detailVisible && meshes.hasTrees);
  }

  updateMaterials(ambient: Color3): void {
    // Vertex colours carry the water's colour; these scalars carry the
    // lighting, and the shader multiplies the two.
    this.ambient = ambient;
    this.ground.light(ambient);
    for (const { water } of this.chunks.values()) if (water.material) (water.material as StandardMaterial).emissiveColor = ambient.scale(0.15);
    this.cliffMat.emissiveColor = ambient.scale(0.7);
    this.peakMat.emissiveColor = ambient.scale(0.15);

    // Each tree carries its own crown colour, as the ground carries its;
    // the street trees share these.
    for (const mat of Object.values(treeMaterials(this.scene))) mat.emissiveColor = ambient.scale(0.15);
  }

  dispose(): void {
    this.scene.onBeforeRenderObservable.remove(this.observer);
    for (const key of [...this.chunks.keys()]) this.disposeChunk(key);
    this.cliffMat.dispose();
    this.peakMat.dispose();
    this.ground.dispose();
    this.worker.terminate();
    this.tiles.clear();
    this.depths.clear();
    this.dirtyGeometry.clear();
    this.dirtyTrees.clear();
    this.ready.length = 0;
  }
}
