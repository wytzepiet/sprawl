import {
  Color3,
  Mesh,
  StandardMaterial,
  VertexData,
  type Nullable,
  type Observer,
  type RawTexture,
  type Scene,
  type ShadowGenerator,
} from "@babylonjs/core";
import type { Theme } from "./theme";
import type { TerrainType } from "../generated";
import {
  appendTile,
  createBorderTexture,
  createSampler,
  emptyBuffers,
  emptyDepthBuffers,
  terrainColor,
  TREE_TRUNK,
  type ChunkSink,
  type TerrainBuffers,
} from "./objects/terrainGeometry";

/** Must match the server's CHUNK_SIZE / CHUNK_SKIRT. */
export const CHUNK_SIZE = 32;
const CHUNK_SKIRT = 2;
const CHUNK_STRIDE = CHUNK_SIZE + CHUNK_SKIRT * 2;

/** Wire encoding, in the server's TerrainType::to_byte order. */
const TYPE_BY_BYTE: TerrainType[] = ["Water", "Beach", "Grass", "Forest", "Mountain"];

/** Chunks rebuilt per frame. Caps the hitch while a viewport streams in. */
const REBUILDS_PER_FRAME = 2;

/** Sun frustum half-extent beyond which per-chunk detail is dropped. */
const DETAIL_MAX_ORTHO = 30;

interface ChunkMeshes {
  ground: Mesh;
  cliffs: Mesh;
  trees: Mesh;
  /** Empty meshes must stay disabled — see applyBuffers. */
  hasCliffs: boolean;
  hasTrees: boolean;
}

const floorDiv = (a: number, b: number) => Math.floor(a / b);

/**
 * Terrain rendered as one merged mesh per chunk rather than per-tile instances.
 * Tiles arrive individually, mark their chunk dirty, and the chunk is rebuilt
 * once per frame — so a tile edit and a streaming burst cost the same rebuild.
 */
export class TerrainChunks {
  private tiles = new Map<string, Uint8Array>();
  private chunks = new Map<string, ChunkMeshes>();
  private dirty = new Set<string>();

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
    this.groundMat.backFaceCulling = false;
    this.groundMat.specularColor = Color3.Black();
    this.groundMat.diffuseTexture = this.borderTex;

    this.cliffMat = new StandardMaterial("terrain_cliff", scene);
    this.cliffMat.backFaceCulling = false;
    this.cliffMat.specularColor = Color3.Black();
    this.cliffMat.disableLighting = true;

    this.treeMat = new StandardMaterial("terrain_tree", scene);
    this.treeMat.backFaceCulling = false;
    this.treeMat.specularColor = Color3.Black();

    this.updateMaterials(new Color3(1, 1, 1));

    this.observer = scene.onBeforeRenderObservable.add(() => {
      this.updateDetail();
      this.flush();
    });
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
    this.dirty.add(key);
  }

  unloadChunk(cx: number, cy: number): void {
    const key = `${cx},${cy}`;
    this.tiles.delete(key);
    this.dirty.delete(key);
    this.disposeChunk(key);
  }

  /** A road appearing or vanishing changes tree placement on that tile. */
  markTile(x: number, y: number): void {
    this.dirty.add(`${floorDiv(x, CHUNK_SIZE)},${floorDiv(y, CHUNK_SIZE)}`);
  }

  /** Rebuild every chunk — used when the theme changes all terrain colours. */
  markAllDirty(): void {
    for (const key of this.chunks.keys()) this.dirty.add(key);
  }

  // --- Rendering ---------------------------------------------------------

  private flush(): void {
    if (this.dirty.size === 0) return;
    let budget = REBUILDS_PER_FRAME;
    for (const key of this.dirty) {
      if (budget-- <= 0) break;
      this.dirty.delete(key);
      this.rebuild(key);
    }
  }

  private rebuild(key: string): void {
    const [cx, cy] = key.split(",").map(Number);
    const originX = cx * CHUNK_SIZE;
    const originY = cy * CHUNK_SIZE;
    const theme = this.theme();

    const sink: ChunkSink = {
      ground: emptyBuffers(),
      cliffs: emptyDepthBuffers(),
      trees: [],
    };

    const tiles = this.tiles.get(key);
    if (!tiles) {
      this.disposeChunk(key);
      return;
    }

    const skirtX = originX - CHUNK_SKIRT;
    const skirtY = originY - CHUNK_SKIRT;
    const sampler = createSampler((x, y) => {
      const ix = x - skirtX;
      const iy = y - skirtY;
      if (ix < 0 || iy < 0 || ix >= CHUNK_STRIDE || iy >= CHUNK_STRIDE) return undefined;
      return TYPE_BY_BYTE[tiles[iy * CHUNK_STRIDE + ix]];
    });

    let tileCount = 0;
    for (let y = originY; y < originY + CHUNK_SIZE; y++) {
      for (let x = originX; x < originX + CHUNK_SIZE; x++) {
        const type = sampler.typeAt(x, y);
        if (!type) continue;
        tileCount++;
        appendTile(sink, x, y, originX, originY, type, theme, sampler, this.hasRoad);
      }
    }

    if (tileCount === 0) {
      this.disposeChunk(key);
      return;
    }

    const meshes = this.chunks.get(key) ?? this.createChunk(key, originX, originY);

    meshes.ground.setEnabled(this.applyBuffers(meshes.ground, sink.ground));

    meshes.hasCliffs = this.applyBuffers(meshes.cliffs, sink.cliffs);
    meshes.hasTrees = sink.trees.length > 0;

    meshes.trees.thinInstanceSetBuffer("matrix", new Float32Array(sink.trees), 16, true);
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
  private applyBuffers(mesh: Mesh, buf: TerrainBuffers): boolean {
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
    const tree = terrainColor("Forest", this.theme());
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
    this.tiles.clear();
    this.dirty.clear();
  }
}
