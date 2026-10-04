import {
  Color3,
  Mesh,
  RawTexture,
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
  GRID_LINE,
  TREE_BODY,
  TREE_TOP,
  TYPE_BY_BYTE,
  type ChunkGeometry,
  type MeshBuffers,
  type TerrainPalette,
} from "./objects/terrainGeometry";
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

const TEX_SIZE = 32;
/** Each tile draws half of every boundary it shares, hence the halving. */
const BORDER = Math.round((GRID_LINE / 2) * TEX_SIZE);

/** How long the grid takes to come and go, in seconds. */
const GRID_FADE = 0.2;

/** The tile's grid line, as a texture every tile wears and the ground's
 *  colour is multiplied by: `border` texels of it along each edge, at
 *  `strength` of a full line (none at 0). The map's zoom sets how wide
 *  that comes out. */
function borderData(border: number, strength: number): Uint8Array {
  const data = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const i = (y * TEX_SIZE + x) * 4;
      const edge =
        x < border ||
        x >= TEX_SIZE - border ||
        y < border ||
        y >= TEX_SIZE - border;
      const v = edge ? Math.round(255 - 25 * strength) : 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}

export function createBorderTexture(scene: Scene, border = BORDER, strength = 1): RawTexture {
  return RawTexture.CreateRGBATexture(borderData(border, strength), TEX_SIZE, TEX_SIZE, scene, false, false);
}

interface ChunkMeshes {
  ground: Mesh;
  cliffs: Mesh;
  /** The trees' smooth tops, which take shadows, and their coarse bodies,
   *  which cast them: one set of instances drawn with both. */
  trees: Mesh;
  treeTops: Mesh;
  /** Empty meshes must stay disabled — see applyBuffers. */
  hasCliffs: boolean;
  hasTrees: boolean;
}

const floorDiv = (a: number, b: number) => Math.floor(a / b);
const parseKey = (key: string) => key.split(",").map(Number) as [number, number];

/**
 * Terrain rendered as one merged mesh per chunk rather than per-tile instances.
 *
 * Ground and cliff geometry is a pure function of the chunk's tiles, so it is
 * built on a worker. Trees are not: they yield to what is built, which is live game
 * state, so they stay here and are cheap enough to rebuild on demand.
 */
export class TerrainChunks {
  private tiles = new Map<string, Uint8Array>();
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

  private groundMat: StandardMaterial;
  private cliffMat: StandardMaterial;
  private treeMat: StandardMaterial;
  private borderTex: RawTexture;
  private observer: Nullable<Observer<Scene>>;
  private detailVisible = true;
  /** The grid, shown while building and faded out otherwise: how much of
   *  it shows, and how much should. */
  private grid = 0;
  private gridTarget = 0;

  constructor(
    private scene: Scene,
    private shadowGenerator: ShadowGenerator,
    private theme: () => Theme,
    private isBuilt: (x: number, y: number) => boolean,
  ) {
    this.borderTex = createBorderTexture(scene, BORDER, 0);

    // One material per pass, shared by every chunk — colour lives in the
    // vertex buffer, so terrain type costs nothing at the material level.
    this.groundMat = new StandardMaterial("terrain_ground", scene);
    // Back faces are never visible from a fixed top-down camera, and the
    // ground covers every pixel -- shading it twice cost half the framerate.
    // Culling is Babylon's default; all geometry winds to match it.
    this.groundMat.specularColor = Color3.Black();
    this.groundMat.diffuseTexture = this.borderTex;

    this.cliffMat = new StandardMaterial("terrain_cliff", scene);
    // The one material that genuinely wants both sides. Cliff walls exist only
    // to cast shadows, and the sun swings through 360 degrees while a wall's
    // facing is fixed -- culled, a wall pointing away from the sun writes no
    // depth into the shadow map and its cliff stops casting for half the day.
    // They are edge-on to the camera, so the second side costs no fill.
    this.cliffMat.backFaceCulling = false;
    this.cliffMat.specularColor = Color3.Black();
    this.cliffMat.disableLighting = true;

    // Plot boundaries are their own geometry because the shared border texture
    // can only darken the ground, never recolour it.

    this.treeMat = new StandardMaterial("terrain_tree", scene);
    this.treeMat.specularColor = Color3.Black();

    this.updateMaterials(new Color3(1, 1, 1));

    this.observer = scene.onBeforeRenderObservable.add(() => {
      this.updateDetail();
      this.fadeGrid();
      this.flush();
    });
  }

  /** Show the grid, as while building, or let it fade from the map. */
  setGrid(shown: boolean): void {
    this.gridTarget = shown ? 1 : 0;
  }

  private fadeGrid(): void {
    if (this.grid === this.gridTarget) return;
    const step = this.scene.getEngine().getDeltaTime() / 1000 / GRID_FADE;
    this.grid = this.gridTarget > this.grid ? Math.min(this.gridTarget, this.grid + step) : Math.max(this.gridTarget, this.grid - step);
    this.borderTex.update(borderData(BORDER, this.grid));
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
  setChunk(cx: number, cy: number, tiles: Uint8Array): void {
    const key = `${cx},${cy}`;
    this.tiles.set(key, tiles);
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
    this.invalidate(key);
    this.disposeChunk(key);
  }

  /** Something built appearing or vanishing changes tree placement there. */
  markTile(x: number, y: number): void {
    this.dirtyTrees.add(`${floorDiv(x, CHUNK_SIZE)},${floorDiv(y, CHUNK_SIZE)}`);
  }

  /**
   * A building appearing or vanishing changes the tint and the boundary lines,
   * which live in the meshed geometry — so this needs a full rebuild, not the
   * cheap tree pass. The skirt means a tile near an edge shows up in its
   * neighbour's mesh too.
   */
  markBuilt(x: number, y: number): void {
    const cx = floorDiv(x, CHUNK_SIZE);
    const cy = floorDiv(y, CHUNK_SIZE);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = `${cx + dx},${cy + dy}`;
        if (this.tiles.has(key)) this.invalidate(key);
      }
    }
  }

  /** Rebuild every chunk — used when the theme changes all terrain colours. */
  markAllDirty(): void {
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
      geometry = await this.builder.build(tiles, cx, cy, this.palette());
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

    meshes.ground.setEnabled(this.applyBuffers(meshes.ground, geometry.ground));
    meshes.hasCliffs = this.applyBuffers(meshes.cliffs, geometry.cliffs);
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
    meshes.hasTrees = matrices.length > 0;
    for (const mesh of [meshes.trees, meshes.treeTops]) {
      mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
      mesh.thinInstanceSetBuffer("color", colors, 4, true);
      // Without this the mesh keeps the lone base crown's bounds and the
      // whole chunk's trees get frustum-culled as soon as the origin leaves view.
      mesh.thinInstanceRefreshBoundingInfo(true);
    }
    this.applyDetail(meshes);
  }

  private createChunk(key: string, originX: number, originY: number): ChunkMeshes {
    const ground = new Mesh(`chunk_${key}_ground`, this.scene);
    ground.material = this.groundMat;
    ground.receiveShadows = true;

    const cliffs = new Mesh(`chunk_${key}_cliffs`, this.scene);
    cliffs.material = this.cliffMat;

    const [trees, treeTops] = [TREE_BODY, TREE_TOP].map((geo, i) => {
      const mesh = new Mesh(`chunk_${key}_tree${i ? "_tops" : "s"}`, this.scene);
      mesh.material = this.treeMat;
      const data = new VertexData();
      data.positions = geo.positions;
      data.indices = geo.indices;
      data.normals = geo.normals;
      data.applyToMesh(mesh);
      return mesh;
    });
    treeTops.receiveShadows = true;

    const meshes: ChunkMeshes = { ground, cliffs, trees, treeTops, hasCliffs: false, hasTrees: false };
    for (const mesh of [ground, cliffs, trees, treeTops]) {
      mesh.isPickable = false;
      mesh.position.x = originX;
      mesh.position.y = originY;
    }
    this.shadowGenerator.addShadowCaster(cliffs);
    this.shadowGenerator.addShadowCaster(trees);
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
    if (buf.uvs) data.uvs = buf.uvs;
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
    this.shadowGenerator.removeShadowCaster(meshes.trees);
    meshes.ground.dispose();
    meshes.cliffs.dispose();
    meshes.trees.dispose();
    meshes.treeTops.dispose();
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
    meshes.trees.setEnabled(this.detailVisible && meshes.hasTrees);
    meshes.treeTops.setEnabled(this.detailVisible && meshes.hasTrees);
  }

  updateMaterials(ambient: Color3): void {
    // Vertex colours carry terrain colour; these scalars carry the lighting,
    // and the shader multiplies the two.
    this.groundMat.diffuseColor = Color3.White();
    this.groundMat.emissiveColor = ambient.scale(0.15);
    this.cliffMat.emissiveColor = ambient.scale(0.7);

    // Each tree carries its own crown colour, as the ground carries its.
    this.treeMat.diffuseColor = Color3.White();
    this.treeMat.emissiveColor = ambient.scale(0.15);
  }

  dispose(): void {
    this.scene.onBeforeRenderObservable.remove(this.observer);
    for (const key of [...this.chunks.keys()]) this.disposeChunk(key);
    this.groundMat.dispose();
    this.cliffMat.dispose();
    this.treeMat.dispose();
    this.borderTex.dispose();
    this.worker.terminate();
    this.tiles.clear();
    this.dirtyGeometry.clear();
    this.dirtyTrees.clear();
    this.ready.length = 0;
  }
}
