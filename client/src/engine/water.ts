import { Color3, Constants, MaterialDefines, MaterialPluginBase, RawTexture, StandardMaterial, type Material, type Scene } from "@babylonjs/core";
import { CHUNK_SIZE, SHORE_DENSITY, SHORE_REACH } from "./objects/terrainGeometry";

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
 * ragged with the same ripple and lapping in and out. All of it is lit as
 * any ground is, so it dims and takes the light's colour by night.
 */

/** The ripple texture's side, in texels, and how many waves make it. */
const SIDE = 256;
const WAVES = 48;
/** Each reading of it: how many tiles it spans, which way it drifts and
 *  how fast, in tiles a second, and how far it tilts the surface. */
const LAYERS: [number, number, number, number, number][] = [
  [5.3, 0.8, 0.6, 0.12, 0.22],
  [2.9, -0.5, 0.86, 0.09, 0.14],
];

/** Deep water: the water's own colour, this dark. How far one sees down
 *  through it, in tiles: the bottom shows less by e the further out. How
 *  much the water tints the bottom seen through it. */
const DEEP = 0.55;
const CLARITY = 0.45;
const TINT = 0.6;
/** How far out the foam reaches, at most, in tiles, and how white it is. */
const FOAM = 0.3;
const FOAM_WHITE = 0.97;

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
function ripples(scene: Scene): RawTexture {
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
  const [at, here, time, sand, v2, v3] = wgsl
    ? ["fragmentInputs.vPositionW.xy", "fragmentInputs.vWaterAt", "uniforms.waterTime", "uniforms.waterSand", "vec2f", "vec3f"]
    : ["vPositionW.xy", "vWaterAt", "waterTime", "waterSand", "vec2", "vec3"];
  const read = (tex: string, uv: string) => (wgsl ? `textureSample(${tex}, ${tex}Sampler, ${uv})` : `texture2D(${tex}, ${uv})`);
  const drift = ([span, dx, dy, speed]: number[]) => `(${at} - ${v2}(${f(dx)}, ${f(dy)}) * ${f(speed)} * ${time}) / ${f(span)}`;
  const slope = LAYERS.map((l) => `${read("waterRipple", drift(l))}.rg * ${f(l[4])}`).join(" + ");
  const let_ = (name: string, type: string) => (wgsl ? `let ${name} = ` : `${type} ${name} = `);
  const colour = wgsl ? "baseColor = vec4f(" : "baseColor.rgb = (";
  const end = wgsl ? ", baseColor.a);" : ");";
  return [
    `normalW = normalize(normalW + ${v3}(-(${slope}), 0.));`,
    `${let_("shore", "float")}${read("waterShore", `${here} / ${f(CHUNK_SIZE)}`)}.r * ${f(SHORE_REACH)};`,
    `${let_("swell", "float")}${read("waterRipple", drift(LAYERS[0]))}.b;`,
    `${let_("foamEdge", "float")}${f(FOAM)} * (0.5 + 0.5 * swell) * (0.85 + 0.15 * sin(1.3 * ${time}));`,
    `${let_("foam", "float")}1. - smoothstep(foamEdge * 0.7, foamEdge, shore);`,
    `${colour}mix(baseColor.rgb * ${f(DEEP)}, ${sand} * mix(${v3}(1.), baseColor.rgb, ${f(TINT)}), exp(-shore / ${f(CLARITY)}))${end}`,
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
    private sand: Color3,
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
    samplers.push("waterRipple", "waterShore");
  }

  getUniforms(shaderLanguage = 0) {
    return {
      ubo: [
        { name: "waterTime", size: 1, type: "float" },
        { name: "waterSand", size: 3, type: "vec3" },
      ],
      fragment: shaderLanguage === 1 ? "uniform waterTime: f32; uniform waterSand: vec3f;" : "uniform float waterTime; uniform vec3 waterSand;",
    };
  }

  bindForSubMesh(ubo: { updateFloat(name: string, v: number): void; updateColor3(name: string, c: Color3): void; setTexture(name: string, t: RawTexture): void }) {
    // Seconds, wrapped so a long session keeps the drift's precision.
    ubo.updateFloat("waterTime", (performance.now() / 1000) % 3600);
    ubo.updateColor3("waterSand", this.sand);
    ubo.setTexture("waterRipple", ripples(this._material.getScene()));
    ubo.setTexture("waterShore", this.shore);
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
        ? "varying vWaterAt: vec2f; var waterRippleSampler: sampler; var waterRipple: texture_2d<f32>; var waterShoreSampler: sampler; var waterShore: texture_2d<f32>;"
        : "varying vec2 vWaterAt; uniform sampler2D waterRipple; uniform sampler2D waterShore;",
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: water(wgsl),
    };
  }
}

/** A material for one chunk's water, its colour the mesh's own, by
 *  vertex, its shore as `shoreField` gives it, if it has one, and its
 *  bottom `sand`. Its shore's texture goes with it. */
export function waterMaterial(scene: Scene, shore: Uint8Array | null, sand: Color3): StandardMaterial {
  const mat = new StandardMaterial("water", scene);
  mat.specularColor = new Color3(0.45, 0.45, 0.45);
  mat.specularPower = 64;
  const side = shore ? CHUNK_SIZE * SHORE_DENSITY : 1;
  const texture = new RawTexture(shore ?? new Uint8Array([255]), side, side, Constants.TEXTUREFORMAT_R, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
  texture.wrapU = texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  new WaterPlugin(mat, texture, sand);
  mat.onDisposeObservable.addOnce(() => texture.dispose());
  return mat;
}
