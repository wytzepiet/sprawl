import { Constants, MaterialDefines, MaterialPluginBase, RawTexture, type Material, type PBRMaterial, type Scene } from "@babylonjs/core";
import { townMaterial } from "./material";
import { CHUNK_SIZE, CLIFF_OUT, CLIFF_REACH, CLIFF_RUN, CLIFF_WANDER, SHORE_DENSITY, SHORE_REACH } from "./objects/terrainGeometry";
import { CALM, slate } from "./peaks";
import { SPAN as SLATE_SPAN } from "./slate";

/**
 * The sea and the lakes, drawn as water: their own meshes (`terrainGeometry`
 * keeps them apart from the ground) on their own material, lacquered to
 * gleam. The surface's facing is turned this way and that by a ripple read
 * twice from one tiling texture, at two sizes drifting different ways, as
 * water shaders do: the two never fall in step, so the pattern never shows
 * itself, and the sun's glint breaks up and wanders on it as on open water.
 *
 * Each chunk's water knows how far it lies from land (`shoreField`), and
 * takes that for its depth. Near the shore one sees the sandy bottom
 * through it, tinted by the water; further out the bottom fades into the
 * water's own deeper colour. Along the shore lies a band of foam, its edge
 * ragged with the same ripple and lapping in and out, and crests of it
 * running in, one each `WAVE_PERIOD`, to break on it; under a cliff, along
 * its foot, as its face is painted (`peaks.ts`), the same field and slate
 * telling where. All of it is lit as
 * any ground is, so it dims and takes the light's colour by night.
 */

/** The ripple texture's side, in texels, and how many waves make it. */
const SIDE = 256;
const WAVES = 48;
/** Each reading of it: how many tiles it spans, which way it drifts and
 *  how fast, in tiles a second, how far it tilts the surface, and how far
 *  it is turned, so the readings' grids never line up into a repeat. */
const LAYERS: [number, number, number, number, number, number][] = [
  [5.3, 0.8, 0.6, 0.12, 0.22, 0.31],
  [2.9, -0.5, 0.86, 0.09, 0.14, -0.83],
];

/** Deep water: the water's own colour, this dark. How far one sees down
 *  through it, in tiles: the bottom shows less by e the further out. How
 *  much the water tints the bottom seen through it. */
const DEEP = 0.55;
/** The surface, near enough smooth: the sun's glint broken up only by the
 *  ripple's facing. */
const WATER_ROUGHNESS = 0.17;
const CLARITY = 0.6;
/** Pale sand under clear water, the red drunk out of the light: turquoise,
 *  as off a Hebridean beach; and right at the sand, barely any water over
 *  it, all but white, within this far of the shore, in tiles. */
const TURQUOISE = [0.32, 0.72, 0.66];
const PALE = [0.8, 0.93, 0.89];
const NEAR = 0.18;
/** How far out the foam reaches, at most, in tiles, and how white it is. */
const FOAM = 0.3;
const FOAM_WHITE = 0.97;
/** The waves washing ashore: one every this many seconds (a whole part of
 *  the hour the clock wraps at), a crest of foam running in from this far
 *  out, in tiles, as wide as this; and as it breaks it runs up a beach as
 *  far as this, the sand drawing back from it (`ground.ts`). */
export const WAVE_PERIOD = 6;
const WAVE_FROM = 0.9;
const CREST = 0.12;
export const SWASH = 0.22;
/** A crest is lost in the foam at the shore this far through its wave
 *  before it reaches the sand: the swash starts then. */
export const WAVE_LEAD = FOAM / WAVE_FROM;
/** Not one wave for the whole coast: the ripple's height, read this many
 *  tiles across, puts a stretch of shore this many waves behind or ahead;
 *  and read again this many tiles across, afresh for every wave, breaks
 *  each crest into pieces, where it is over this. The beach's swash reads
 *  them alike (`ground.ts`). */
export const WAVE_STAGGER = [61, 1.6];
export const WAVE_PIECES = [23, -0.05];
/** A wave's phase at a point of the map: `R(uv)` reads the ripple's height
 *  there, `t` the clock, `d` how far through it the point is. */
export const wavePhase = (R: (uv: string) => string, at: string, t: string, d: string) =>
  `(${t} / ${f(WAVE_PERIOD)} + ${d} + ${R(`${at} / ${f(WAVE_STAGGER[0])}`)} * ${f(WAVE_STAGGER[1])})`;
/** Whether a wave of that phase reaches a point, 0 to 1. */
export const wavePiece = (R: (uv: string) => string, at: string, phase: string, v2: string) =>
  `smoothstep(${f(WAVE_PIECES[1] - 0.08)}, ${f(WAVE_PIECES[1] + 0.08)}, ${R(`${at} / ${f(WAVE_PIECES[0])} + floor(${phase}) * ${v2}(0.37, 0.61)`)})`;

/** A tiling field of the surface's slope, two channels, and its height, a third, from waves of
 *  whole numbers of crests across it, so it meets itself at its edges:
 *  longer waves stronger, as on open water, and all leaning one way, as
 *  wind lays them. */
function rippleData(): Float32Array {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const waves: [number, number, number, number][] = [];
  while (waves.length < WAVES) {
    const [kx, ky] = [Math.round((random() * 2 - 1) * 14), Math.round((random() * 2 - 1) * 14)];
    const k = Math.hypot(kx, ky);
    if (k < 2) continue;
    // Toward the wind, (1, 0.4), the stronger.
    const lean = 0.35 + 0.65 * Math.max(0, (kx + 0.4 * ky) / (k * 1.077));
    waves.push([kx, ky, lean / k ** 1.5, random() * Math.PI * 2]);
  }
  const data = new Float32Array(SIDE * SIDE * 4);
  let [most, highest] = [0, 0];
  for (let j = 0; j < SIDE; j++) {
    for (let i = 0; i < SIDE; i++) {
      const [u, v] = [(i / SIDE) * Math.PI * 2, (j / SIDE) * Math.PI * 2];
      let [sx, sy, height] = [0, 0, 0];
      for (const [kx, ky, a, phase] of waves) {
        const d = -a * Math.sin(kx * u + ky * v + phase);
        sx += d * kx;
        sy += d * ky;
        height += a * Math.cos(kx * u + ky * v + phase);
      }
      const at = (j * SIDE + i) * 4;
      [data[at], data[at + 1], data[at + 2], data[at + 3]] = [sx, sy, height, 1];
      most = Math.max(most, Math.abs(sx), Math.abs(sy));
      highest = Math.max(highest, Math.abs(height));
    }
  }
  for (let k = 0; k < data.length; k += 4) [data[k], data[k + 1], data[k + 2]] = [data[k] / most, data[k + 1] / most, data[k + 2] / highest];
  return data;
}

const RIPPLES = new WeakMap<Scene, RawTexture>();
export function ripples(scene: Scene): RawTexture {
  let texture = RIPPLES.get(scene);
  if (!texture) {
    texture = new RawTexture(rippleData(), SIDE, SIDE, Constants.TEXTUREFORMAT_RGBA, scene, true, false, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT);
    texture.wrapU = texture.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
    RIPPLES.set(scene, texture);
  }
  return texture;
}

const f = (x: number) => x.toFixed(4);
const water = (wgsl: boolean) => {
  const [at, here, time, v2, v3] = wgsl
    ? ["fragmentInputs.vPositionW.xy", "fragmentInputs.vWaterAt", "uniforms.waterTime", "vec2f", "vec3f"]
    : ["vPositionW.xy", "vWaterAt", "waterTime", "vec2", "vec3"];
  const read = (tex: string, uv: string) => (wgsl ? `textureSample(${tex}, ${tex}Sampler, ${uv})` : `texture2D(${tex}, ${uv})`);
  // Where a reading is on the texture: drifting, then turned.
  const drift = ([span, dx, dy, speed, , turn]: number[]) => {
    const [c, s] = [Math.cos(turn), Math.sin(turn)];
    const p = `(${at} - ${v2}(${f(dx)}, ${f(dy)}) * ${f(speed)} * ${time})`;
    return `${v2}(${p}.x * ${f(c)} - ${p}.y * ${f(s)}, ${p}.x * ${f(s)} + ${p}.y * ${f(c)}) / ${f(span)}`;
  };
  // Its slope, turned back to the map's frame.
  const slope = LAYERS.map((l) => {
    const [c, s] = [Math.cos(l[5]), Math.sin(l[5])];
    const g = `${read("waterRipple", drift(l))}.rg`;
    return `${v2}(${g}.x * ${f(c)} + ${g}.y * ${f(s)}, ${g}.y * ${f(c)} - ${g}.x * ${f(s)}) * ${f(l[4])}`;
  }).join(" + ");
  // The slate at the pixel, as the cliff's shader reads it for its edge.
  const slateTop = wgsl
    ? `textureSampleBias(waterSlate, waterSlateSampler, ${at} / ${f(SLATE_SPAN)}, ${f(CALM)})`
    : `texture2D(waterSlate, ${at} / ${f(SLATE_SPAN)}, ${f(CALM)})`;
  // The ripple's height, for the waves' timing.
  const height = (uv: string) => `${read("waterRipple", uv)}.b`;
  const let_ = (name: string, type: string) => (wgsl ? `let ${name} = ` : `${type} ${name} = `);
  const colour = wgsl ? "baseColor = vec4f(" : "baseColor.rgb = (";
  const end = wgsl ? ", baseColor.a);" : ");";
  return [
    `normalW = normalize(normalW + ${v3}(-(${slope}), 0.));`,
    `${let_("shore", "float")}${read("waterShore", `${here} / ${f(CHUNK_SIZE)}`)}.r * ${f(SHORE_REACH)};`,
    `${let_("swell", "float")}${read("waterRipple", drift(LAYERS[0]))}.b;`,
    `${let_("foamEdge", "float")}${f(FOAM)} * (0.5 + 0.5 * swell) * (0.85 + 0.15 * sin(1.3 * ${time}));`,
    `${let_("cliffField", "float")}${read("waterCliff", `${here} / ${f(CHUNK_SIZE)}`)}.r;`,
    // As far as the field reaches is no cliff near at all, whatever the slate.
    `${let_("cliffFoot", "float")}(cliffField - 0.5) * ${f(2 * CLIFF_REACH)} - (${slateTop}.b * 2. - 1.) * ${f(CLIFF_WANDER)} - ${f(CLIFF_OUT + CLIFF_RUN)} + step(0.995, cliffField) * 9.;`,
    `${let_("ashore", "float")}min(shore, max(cliffFoot, 0.));`,
    `${let_("wave", "float")}${wavePhase(height, at, time, `ashore / ${f(WAVE_FROM)}`)};`,
    `${let_("foam", "float")}max(1. - smoothstep(foamEdge * 0.7, foamEdge, ashore), smoothstep(${f(1 - CREST / WAVE_FROM)}, 1., fract(wave)) * ${wavePiece(height, at, "wave", v2)} * (1. - smoothstep(${f(WAVE_FROM * 0.6)}, ${f(WAVE_FROM)}, ashore)) * (0.5 + 0.5 * swell));`,
    `${colour}mix(baseColor.rgb * ${f(DEEP)}, mix(${v3}(${TURQUOISE.map(f).join(", ")}), ${v3}(${PALE.map(f).join(", ")}), exp(-shore / ${f(NEAR)})), exp(-shore / ${f(CLARITY)}))${end}`,
    `${colour}mix(baseColor.rgb, ${v3}(${f(FOAM_WHITE)}), foam)${end}`,
  ].join("\n");
};

class WaterDefines extends MaterialDefines {
  WATER = false;
}

class WaterPlugin extends MaterialPluginBase {
  constructor(
    material: Material,
    private shore: RawTexture,
    private cliff: RawTexture,
  ) {
    super(material, "Water", 210, new WaterDefines());
    this._enable(true);
  }

  isCompatible() {
    return true;
  }

  prepareDefines(defines: WaterDefines) {
    defines.WATER = true;
  }

  getSamplers(samplers: string[]) {
    samplers.push("waterRipple", "waterShore", "waterCliff", "waterSlate");
  }

  getUniforms(shaderLanguage = 0) {
    return {
      ubo: [
        { name: "waterTime", size: 1, type: "float" },
      ],
      fragment: shaderLanguage === 1 ? "uniform waterTime: f32;" : "uniform float waterTime;",
    };
  }

  bindForSubMesh(ubo: { updateFloat(name: string, v: number): void; setTexture(name: string, t: RawTexture): void }) {
    // Seconds, wrapped so a long session keeps the drift's precision.
    ubo.updateFloat("waterTime", (performance.now() / 1000) % 3600);
    ubo.setTexture("waterRipple", ripples(this._material.getScene()));
    ubo.setTexture("waterShore", this.shore);
    ubo.setTexture("waterCliff", this.cliff);
    ubo.setTexture("waterSlate", slate(this._material.getScene()));
  }

  getClassName() {
    return "WaterPlugin";
  }

  getCustomCode(shaderType: string, shaderLanguage = 0): Record<string, string> {
    const wgsl = shaderLanguage === 1;
    // Where on its chunk a pixel is: the mesh's own frame, however placed.
    if (shaderType === "vertex") {
      return wgsl
        ? { CUSTOM_VERTEX_DEFINITIONS: "varying vWaterAt: vec2f;", CUSTOM_VERTEX_MAIN_END: "vertexOutputs.vWaterAt = positionUpdated.xy;" }
        : { CUSTOM_VERTEX_DEFINITIONS: "varying vec2 vWaterAt;", CUSTOM_VERTEX_MAIN_END: "vWaterAt = positionUpdated.xy;" };
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: wgsl
        ? "varying vWaterAt: vec2f; var waterRippleSampler: sampler; var waterRipple: texture_2d<f32>; var waterShoreSampler: sampler; var waterShore: texture_2d<f32>; var waterCliffSampler: sampler; var waterCliff: texture_2d<f32>; var waterSlateSampler: sampler; var waterSlate: texture_2d<f32>;"
        : "varying vec2 vWaterAt; uniform sampler2D waterRipple; uniform sampler2D waterShore; uniform sampler2D waterCliff; uniform sampler2D waterSlate;",
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: water(wgsl),
    };
  }
}

/** A material for one chunk's water, its colour the mesh's own, by
 *  vertex, its shore as `shoreField` gives it, if it has one, its land's
 *  cliff as `cliffField` does. Their textures go
 *  with it. */
export function waterMaterial(scene: Scene, shore: Uint8Array | null, cliff: Uint8Array | null): PBRMaterial {
  const mat = townMaterial("water", scene, WATER_ROUGHNESS);
  const side = shore ? CHUNK_SIZE * SHORE_DENSITY : 1;
  const texture = new RawTexture(shore ?? new Uint8Array([255]), side, side, Constants.TEXTUREFORMAT_R, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
  texture.wrapU = texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  const cliffSide = cliff ? CHUNK_SIZE * SHORE_DENSITY : 1;
  const cliffs = new RawTexture(cliff ?? new Uint8Array([255]), cliffSide, cliffSide, Constants.TEXTUREFORMAT_R, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
  cliffs.wrapU = cliffs.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  new WaterPlugin(mat, texture, cliffs);
  mat.onDisposeObservable.addOnce(() => (texture.dispose(), cliffs.dispose()));
  return mat;
}
