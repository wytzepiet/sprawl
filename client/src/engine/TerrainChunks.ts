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
  TREE_TRUNK,
  type ChunkGeometry,
  type MeshBuffers,
  type TerrainPalette,
} from "./objects/terrainGeometry";
import type { TerrainApi } from "./terrainWorker";

export { CHUNK_SIZE };

/**
 * Finished chunks uploaded per frame. The build is off-thread now, but the
 * upload is not — this caps how much GPU work one frame can take on.
 */
const APPLIES_PER_FRAME = 2;

/** Sun frustum half-extent beyond which per-chunk detail is dropped. */
const DETAIL_MAX_ORTHO = 30;

const TEX_SIZE = 32;
const BORDER = 1;

function createBorderTexture(scene: Scene): RawTexture {
  const data = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const i = (y * TEX_SIZE + x) * 4;
      const edge =
        x < BORDER ||
        x >= TEX_SIZE - BORDER ||
        y < BORDER ||
        y >= TEX_SIZE - BORDER;
      const v = edge ? 230 : 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return RawTexture.CreateRGBATexture(data, TEX_SIZE, TEX_SIZE, scene, false, false);
}

interface ChunkMeshes {
  ground: Mesh;
  cliffs: Mesh;
  trees: Mesh;
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
 * built on a worker. Trees are not: they yield to roads, which are live game
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

  constructor(
    private scene: Scene,
    private shadowGenerator: ShadowGenerator,
    private theme: () => Theme,
    private hasRoad: (x: number, y: number) => boolean,
  ) {
    this.borderTex = createBorderTexture(scene);

    // One material per pass, shared by every chunk — colour lives in the
    // vertex buffer, so terrain type costs nothing at the material level.
    this.groundMat = new StandardMaterial("terrain_ground", scene);
    // Back faces are never visible from a fixed top-down camera, and the
    // ground covers every pixel -- shading it twice cost half the framerate.
    // Culling is Babylon's default; all geometry winds to match it.
    this.groundMat.specularColor = Color3.Black();
    this.groundMat.diffuseTexture = this.borderTex;

    this.cliffMat = new StandardMaterial("terrain_cliff", scene);
    this.cliffMat.specularColor = Color3.Black();
    this.cliffMat.disableLighting = true;

    this.treeMat = new StandardMaterial("terrain_tree", scene);
    this.treeMat.specularColor = Color3.Black();

    this.updateMaterials(new Color3(1, 1, 1));

    this.observer = scene.onBeforeRenderObservable.add(() => {
      this.updateDetail();
      this.flush();
    });
  }

  /** The worker has no Babylon, so the theme crosses as plain floats. */
  private palette(): TerrainPalette {
    const t = this.theme();
    return {
      Water: { r: t.water.r, g: t.water.g, b: t.water.b },
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

  unloadChunk(cx: number, cy: number): void {
    const key = `${cx},${cy}`;
    this.tiles.delete(key);
    this.invalidate(key);
    this.disposeChunk(key);
  }

  /** A road appearing or vanishing changes tree placement on that tile. */
  markTile(x: number, y: number): void {
    this.dirtyTrees.add(`${floorDiv(x, CHUNK_SIZE)},${floorDiv(y, CHUNK_SIZE)}`);
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
      console.error("[terrain] chunk build failed", key, e);
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
    const matrices = buildTrees(tiles, cx, cy, this.hasRoad);
    meshes.hasTrees = matrices.length > 0;
    meshes.trees.thinInstanceSetBuffer("matrix", matrices, 16, true);
    // Without this the mesh keeps the lone base cylinder's bounds and the
    // whole chunk's trees get frustum-culled as soon as the origin leaves view.
    meshes.trees.thinInstanceRefreshBoundingInfo(true);
    this.applyDetail(meshes);
  }

  private createChunk(key: string, originX: number, originY: number): ChunkMeshes {
    const ground = new Mesh(`chunk_${key}_ground`, this.scene);
    ground.material = this.groundMat;
    ground.receiveShadows = true;

    const cliffs = new Mesh(`chunk_${key}_cliffs`, this.scene);
    cliffs.material = this.cliffMat;

    const trees = new Mesh(`chunk_${key}_trees`, this.scene);
    trees.material = this.treeMat;
    trees.receiveShadows = true;
    const treeData = new VertexData();
    treeData.positions = TREE_TRUNK.positions;
    treeData.indices = TREE_TRUNK.indices;
    treeData.normals = TREE_TRUNK.normals;
    treeData.applyToMesh(trees);

    const meshes: ChunkMeshes = { ground, cliffs, trees, hasCliffs: false, hasTrees: false };
    for (const mesh of [ground, cliffs, trees]) {
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
    this.chunks.delete(key);
  }

  /** Cliffs and trees are illegible when zoomed far out — skip them entirely. */
  private updateDetail(): void {
    const orthoTop = this.scene.activeCamera?.orthoTop;
    if (orthoTop == null) return;
    const visible = orthoTop < DETAIL_MAX_ORTHO;
    if (visible === this.detailVisible) return;
    this.detailVisible = visible;
    for (const meshes of this.chunks.values()) this.applyDetail(meshes);
  }

  private applyDetail(meshes: ChunkMeshes): void {
    meshes.cliffs.setEnabled(this.detailVisible && meshes.hasCliffs);
    meshes.trees.setEnabled(this.detailVisible && meshes.hasTrees);
  }

  updateMaterials(ambient: Color3): void {
    // Vertex colours carry terrain colour; these scalars carry the lighting,
    // and the shader multiplies the two.
    this.groundMat.diffuseColor = Color3.White();
    this.groundMat.emissiveColor = ambient.scale(0.15);
    this.cliffMat.emissiveColor = ambient.scale(0.7);

    // Trees are a single colour, so they keep it on the material.
    const tree = this.theme().forest;
    this.treeMat.diffuseColor = tree;
    this.treeMat.emissiveColor = new Color3(
      tree.r * ambient.r * 0.15,
      tree.g * ambient.g * 0.15,
      tree.b * ambient.b * 0.15,
    );
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
