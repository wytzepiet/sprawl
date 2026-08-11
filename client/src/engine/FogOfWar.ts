import {
  Color3,
  Mesh,
  MeshBuilder,
  RawTexture,
  StandardMaterial,
  Texture,
  type Nullable,
  type Observer,
  type Scene,
} from "@babylonjs/core";
import { CHUNK_SIZE } from "./objects/terrainGeometry";

/** Chunks per axis covered by the mask, centred on the origin. */
const FOG_CHUNKS = 64;
/** Mask resolution. Higher means a tighter fade, since the ramp is baked in. */
const TEXELS_PER_CHUNK = 8;
const TEX = FOG_CHUNKS * TEXELS_PER_CHUNK;

const SPAN = FOG_CHUNKS * CHUNK_SIZE;
const MIN_CHUNK = -FOG_CHUNKS / 2;

/** Above every piece of world geometry, below the camera at z=10. */
const FOG_Z = 3;

/**
 * Fade depth in texels, measured inwards from the frontier.
 *
 * The ramp has to be fully opaque by the time it reaches the edge of the
 * revealed region: terrain geometry stops dead there, so any residual
 * transparency shows up as a hard step against the background.
 */
const FADE = 5;
/**
 * How far inside the frontier the fog is still fully opaque. The outermost
 * revealed texel is already a texel clear of the unrevealed ones, so without
 * this the ramp peaks just short of 1 exactly where the geometry stops.
 */
const MARGIN = 1.5;
const MAX_D = MARGIN + FADE + 1;
const SQRT2 = Math.SQRT2;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Unsurveyed ground, drawn as the sky closing over the map.
 *
 * The revealed region is chunk-granular, which would show as a staircase, so
 * the mask is upsampled and a distance transform bakes the fade into its alpha.
 * The colour tracks the scene's clear colour, so the frontier dissolves into the
 * background at every hour of the day rather than sitting on top of it.
 */
export class FogOfWar {
  private revealed = new Set<string>();
  private mesh: Mesh;
  private material: StandardMaterial;
  private texture: RawTexture;
  private data = new Uint8Array(TEX * TEX * 4);
  private dirty = true;
  private observer: Nullable<Observer<Scene>>;

  // Scratch buffers for the mask build, reused so a rebuild allocates nothing.
  private coverage = new Float32Array(TEX * TEX);
  private scratch = new Float32Array(TEX * TEX);

  constructor(private scene: Scene) {
    this.texture = RawTexture.CreateRGBATexture(
      this.data,
      TEX,
      TEX,
      scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE,
    );
    // Only the alpha channel carries the mask; the colour comes from the
    // material, so the rest of the buffer is written once and left alone.
    this.data.fill(255);
    this.texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;

    this.material = new StandardMaterial("fog", scene);
    this.material.disableLighting = true;
    this.material.diffuseColor = Color3.Black();
    this.material.specularColor = Color3.Black();
    this.material.emissiveColor = Color3.White();
    this.material.opacityTexture = this.texture;
    this.material.backFaceCulling = false;

    this.mesh = MeshBuilder.CreatePlane("fog", { size: SPAN }, scene);
    this.mesh.material = this.material;
    this.mesh.position.z = FOG_Z;
    this.mesh.isPickable = false;
    this.mesh.receiveShadows = false;
    // Drawn after everything else so it closes over roads and cars too, and
    // writes no depth so it never occludes itself.
    this.mesh.renderingGroupId = 1;
    this.material.disableDepthWrite = true;

    this.observer = scene.onBeforeRenderObservable.add(() => this.update());
  }

  setChunk(cx: number, cy: number): void {
    const key = `${cx},${cy}`;
    if (this.revealed.has(key)) return;
    this.revealed.add(key);
    this.dirty = true;
  }

  unloadChunk(cx: number, cy: number): void {
    if (this.revealed.delete(`${cx},${cy}`)) this.dirty = true;
  }

  private update(): void {
    // The frontier has to dissolve into whatever the sky currently is, or it
    // reads as a grey sheet laid over the map at dawn and dusk.
    const clear = this.scene.clearColor;
    this.material.emissiveColor.set(clear.r, clear.g, clear.b);

    if (!this.dirty) return;
    this.dirty = false;
    this.rebuild();
  }

  private rebuild(): void {
    const { coverage, scratch } = this;
    coverage.fill(0);

    for (const key of this.revealed) {
      const [cx, cy] = key.split(",").map(Number);
      const tx = (cx - MIN_CHUNK) * TEXELS_PER_CHUNK;
      const ty = (cy - MIN_CHUNK) * TEXELS_PER_CHUNK;
      if (tx < 0 || ty < 0 || tx >= TEX || ty >= TEX) continue;
      for (let y = ty; y < ty + TEXELS_PER_CHUNK; y++) {
        for (let x = tx; x < tx + TEXELS_PER_CHUNK; x++) coverage[y * TEX + x] = 1;
      }
    }

    distanceInside(coverage, scratch);

    const { data } = this;
    for (let i = 0; i < TEX * TEX; i++) {
      // 0 at the frontier, FADE deep inside — so the map is fully clear well
      // before its geometry ends, and fully fogged exactly where it stops.
      const alpha = 1 - smoothstep(MARGIN, MARGIN + FADE, scratch[i]);
      data[i * 4 + 3] = (alpha * 255) | 0;
    }
    this.texture.update(data);
  }

  dispose(): void {
    this.scene.onBeforeRenderObservable.remove(this.observer);
    this.mesh.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.revealed.clear();
  }
}

/**
 * Chamfer distance transform: for every revealed texel, how far it is from the
 * nearest unrevealed one. Two sweeps over the grid, and the diagonal weight is
 * what keeps the corners of a chunk-aligned frontier from looking square.
 *
 * Anything off the edge of the window counts as unrevealed, so the mask closes
 * at the border of its own coverage instead of ending abruptly.
 */
function distanceInside(binary: Float32Array, dist: Float32Array): void {
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= TEX || y >= TEX ? 0 : dist[y * TEX + x];

  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const i = y * TEX + x;
      if (binary[i] === 0) {
        dist[i] = 0;
        continue;
      }
      dist[i] = Math.min(
        MAX_D,
        at(x, y - 1) + 1,
        at(x - 1, y) + 1,
        at(x - 1, y - 1) + SQRT2,
        at(x + 1, y - 1) + SQRT2,
      );
    }
  }

  for (let y = TEX - 1; y >= 0; y--) {
    for (let x = TEX - 1; x >= 0; x--) {
      const i = y * TEX + x;
      if (dist[i] === 0) continue;
      dist[i] = Math.min(
        dist[i],
        at(x, y + 1) + 1,
        at(x + 1, y) + 1,
        at(x + 1, y + 1) + SQRT2,
        at(x - 1, y + 1) + SQRT2,
      );
    }
  }
}
