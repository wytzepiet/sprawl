import { createShaderMaterial, createTexture2DFromPixels, wgsl, setShaderTexture, setShaderUniform, updateTexture2DFromPixels, type Mesh, type Texture2D } from "@babylonjs/lite";
import { CHUNK_SIZE } from "./objects/terrainGeometry";
import type { EngineContext } from "./Canvas";
import { drop, meshOf, show } from "./geometry";
import { toneMapWGSL } from "./toneMap";

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
/** The fog: the mask's alpha over the sky's colour, brought onto the screen
 *  as the lit world is (`toneMap.ts`), so it dissolves into what lies under. */
const VERTEX = wgsl`struct VertexOutput { @builtin(position) position: vec4f, @location(0) uv: vec2f, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = shaderSystem.worldViewProjection * vec4f(input.position, 1.);
  out.uv = input.uv;
  return out;
}`;
const FRAGMENT = wgsl`struct VertexOutput { @builtin(position) position: vec4f, @location(0) uv: vec2f, };
${toneMapWGSL}
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4f {
  let c = toneMap(pow(shaderUniforms.colour.rgb, vec3f(2.2)) * shaderUniforms.colour.a);
  return vec4f(pow(c, vec3f(1. / 2.2)), textureSample(mask, maskSampler, input.uv).a);
}`;

export class FogOfWar {
  private revealed = new Set<string>();
  private mesh: Mesh;
  private texture: Texture2D;
  private material: ReturnType<typeof createShaderMaterial>;
  private data = new Uint8Array(TEX * TEX * 4);
  private dirty = true;
  private stop: () => void;

  // Scratch buffers for the mask build, reused so a rebuild allocates nothing.
  private coverage = new Float32Array(TEX * TEX);
  private scratch = new Float32Array(TEX * TEX);

  constructor(private ctx: EngineContext) {
    // Only the alpha channel carries the mask; the colour comes from the
    // material, so the rest of the buffer is written once and left alone.
    this.data.fill(255);
    this.texture = createTexture2DFromPixels(ctx.engine, this.data, TEX, TEX, { minFilter: "linear", magFilter: "linear" });

    // Drawn after everything else, whatever stands nearer, so it closes over
    // roads and cars too, and writing no depth: last of the see-through, in
    // the same pass as the rest.
    this.material = createShaderMaterial({
      name: "fog",
      vertexSource: VERTEX,
      fragmentSource: FRAGMENT,
      attributes: ["position", "uv"],
      uniforms: ["worldViewProjection", { name: "colour", type: "vec4<f32>" }],
      samplers: ["mask"],
      needAlphaBlending: true,
      backFaceCulling: false,
      depthWrite: false,
      depthCompare: "always",
    });
    setShaderTexture(this.material, "mask", this.texture);

    const h = SPAN / 2;
    this.mesh = meshOf(ctx.engine, "fog", {
      positions: [-h, -h, 0, h, -h, 0, h, h, 0, -h, h, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 1, 1, 0, 1],
      indices: [0, 2, 1, 0, 3, 2],
    });
    this.mesh.material = this.material;
    this.mesh.position.z = FOG_Z;
    this.mesh.renderOrder = Number.MAX_SAFE_INTEGER;
    show(ctx.scene, this.mesh);

    this.stop = ctx.beforeRender(() => this.update());
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
    const clear = this.ctx.scene.clearColor;
    setShaderUniform(this.material, "colour", [clear.r, clear.g, clear.b, this.ctx.scene.imageProcessing.exposure]);

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
    updateTexture2DFromPixels(this.ctx.engine, this.texture, data);
  }

  dispose(): void {
    this.stop();
    drop(this.ctx.scene, this.mesh);
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
