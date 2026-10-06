import { Color3, Constants, MaterialDefines, MaterialPluginBase, RawTexture, StandardMaterial, type Material, type Scene } from "@babylonjs/core";
import { PEAK_APRON, PEAK_SAMPLES, PEAK_SIDE } from "./objects/terrainGeometry";
import { grain } from "./ground";

/**
 * The mountains lit at every pixel: their surface is coarse (`layPeaks`),
 * and a pixel's facing is read off their facing at every point of the
 * heights the server eroded (`mountains.rs`), eight to a tile, a texture a
 * chunk, by where the pixel is on the map (the surface's points are laid
 * there) and turned into the world's frame. So a gully is as fine as the
 * heights, however few points the surface has.
 */

/** How a mountain is coloured, as real ones are: bare rock where it is
 *  steep, the meadow carried up its foot where it is gentle and low, snow
 *  where it is high and not too steep; each line wandered by the grain's
 *  broad noise, this many tiles across, by this much. How steep is rock,
 *  how low is grass, how high is snow, in tiles. And its grit: the grain
 *  over this many tiles, tilting the rock's facing this far, the snow's
 *  less. */
const WANDER = 2.5;
const ROCKY = [0.3, 0.5];
const MEADOW = [0.25, 1.4];
/** Up the mountain, grass still clings here and there where it is gentle:
 *  in patches this many tiles across, of this share of the ground. */
const TUFTS = 0.9;
const TUFTED = 0.3;
const SNOWLINE = [3.2, 5.5];
const GRIT_SPAN = 1.2;
const GRIT = 1.1;
const SNOW_GRIT = 0.12;
/** And coarser grit under it, this many times bigger, this much of it. */
const COARSE = 4;
const COARSE_GRIT = 0.7;

class PeakDefines extends MaterialDefines {
  PEAK = false;
}

const f = (x: number) => x.toFixed(4);
/** From a point of the map to its place in a chunk's texture. */
const [samples, side] = [f(PEAK_SAMPLES), f(PEAK_SIDE)];
const [wander, gritSpan, step, tufts] = [f(WANDER * 256), f(GRIT_SPAN), f(1 / 256), f(TUFTS * 256)];

/** The colouring and the grit, in a shader's own words, after the facing
 *  is read: `T(name)` a texture read, `v3` its vectors, `u(name)` a
 *  uniform. */
const colour = (T: (uv: string) => string, v2: string, v3: string, decl: string, u: (n: string) => string, at: string, h: string) => `${decl} peakWander = ${T(`${at} / ${wander}`)} - 0.5;
${decl} peakGritUv = ${at} / ${gritSpan};
${decl} peakGrit = ${v2}(${T(`peakGritUv + ${v2}(${step}, 0.)`)} - ${T(`peakGritUv - ${v2}(${step}, 0.)`)}, ${T(`peakGritUv + ${v2}(0., ${step})`)} - ${T(`peakGritUv - ${v2}(0., ${step})`)});
${decl} peakCoarseUv = ${at} / ${f(GRIT_SPAN * COARSE)};
${decl} peakCoarse = ${v2}(${T(`peakCoarseUv + ${v2}(${step}, 0.)`)} - ${T(`peakCoarseUv - ${v2}(${step}, 0.)`)}, ${T(`peakCoarseUv + ${v2}(0., ${step})`)} - ${T(`peakCoarseUv - ${v2}(0., ${step})`)});
${decl} peakTuft = ${T(`${at} / ${tufts}`)};
${decl} peakGrain = ${T("peakGritUv")};
${decl} peakSlope = 1. - normalW.z;
${decl} peakRock = smoothstep(${f(ROCKY[0])}, ${f(ROCKY[1])}, peakSlope + peakWander * 0.12);
${decl} peakMeadow = max(1. - smoothstep(${f(MEADOW[0])}, ${f(MEADOW[1])}, ${h} + peakWander * 0.8), smoothstep(${f(1 - TUFTED)}, ${f(1 - TUFTED + 0.12)}, peakTuft + peakWander * 0.3)) * (1. - peakRock);
${decl} peakSnow = smoothstep(${f(SNOWLINE[0])}, ${f(SNOWLINE[1])}, ${h} + peakWander * 2.) * (1. - smoothstep(0.35, 0.6, peakSlope));
${decl} peakStone = ${u("peakRockColour")} * (0.88 + 0.24 * peakGrain);
baseColor = vec4${v3 === "vec3f" ? "f" : ""}(mix(mix(peakStone, ${u("peakGrassColour")} * (0.94 + 0.12 * peakGrain), peakMeadow), ${u("peakSnowColour")}, peakSnow), baseColor.a);
normalW = normalize(normalW - ${v3}((peakGrit * ${f(GRIT)} + peakCoarse * ${f(COARSE_GRIT)}) * mix(1. - 0.7 * peakMeadow, ${f(SNOW_GRIT / GRIT)}, peakSnow), 0.));`;

class PeakPlugin extends MaterialPluginBase {
  constructor(
    material: Material,
    private light: RawTexture,
    /** The map's point at the texture's first texel. */
    private origin: [number, number],
    /** Its rock's, meadow's and snow's colours. */
    private colours: [Color3, Color3, Color3],
  ) {
    super(material, "Peak", 200, new PeakDefines());
    this._enable(true);
  }

  isCompatible() {
    return true;
  }

  prepareDefines(defines: PeakDefines) {
    defines.PEAK = true;
  }

  getSamplers(samplers: string[]) {
    samplers.push("peakLight", "peakGrain");
  }

  getUniforms(shaderLanguage = 0) {
    return {
      ubo: [
        { name: "peakOrigin", size: 2, type: "vec2" },
        { name: "peakRockColour", size: 3, type: "vec3" },
        { name: "peakGrassColour", size: 3, type: "vec3" },
        { name: "peakSnowColour", size: 3, type: "vec3" },
      ],
      fragment:
        shaderLanguage === 1
          ? "uniform peakOrigin: vec2f; uniform peakRockColour: vec3f; uniform peakGrassColour: vec3f; uniform peakSnowColour: vec3f;"
          : "uniform vec2 peakOrigin; uniform vec3 peakRockColour; uniform vec3 peakGrassColour; uniform vec3 peakSnowColour;",
    };
  }

  bindForSubMesh(ubo: { updateFloat2(n: string, x: number, y: number): void; updateColor3(n: string, c: Color3): void; setTexture(n: string, t: RawTexture): void }) {
    ubo.updateFloat2("peakOrigin", ...this.origin);
    ubo.updateColor3("peakRockColour", this.colours[0]);
    ubo.updateColor3("peakGrassColour", this.colours[1]);
    ubo.updateColor3("peakSnowColour", this.colours[2]);
    ubo.setTexture("peakLight", this.light);
    ubo.setTexture("peakGrain", grain(this._material.getScene()));
  }

  getClassName() {
    return "PeakPlugin";
  }

  getCustomCode(shaderType: string, shaderLanguage = 0): Record<string, string> {
    if (shaderLanguage === 1) {
      return shaderType === "vertex"
        ? {
            CUSTOM_VERTEX_DEFINITIONS: `varying vPeakAt: vec2f; varying vPeakX: vec3f; varying vPeakY: vec3f; varying vPeakZ: vec3f;`,
            CUSTOM_VERTEX_MAIN_END: `vertexOutputs.vPeakAt = vertexInputs.position.xy; vertexOutputs.vPeakX = normalize((finalWorld * vec4f(1., 0., 0., 0.)).xyz); vertexOutputs.vPeakY = normalize((finalWorld * vec4f(0., 1., 0., 0.)).xyz); vertexOutputs.vPeakZ = normalize((finalWorld * vec4f(0., 0., 1., 0.)).xyz);`,
          }
        : {
            CUSTOM_FRAGMENT_DEFINITIONS: `varying vPeakAt: vec2f; varying vPeakX: vec3f; varying vPeakY: vec3f; varying vPeakZ: vec3f; var peakLightSampler: sampler; var peakLight: texture_2d<f32>; var peakGrainSampler: sampler; var peakGrain: texture_2d<f32>;`,
            CUSTOM_FRAGMENT_BEFORE_LIGHTS: `let peakFacing = textureSampleLevel(peakLight, peakLightSampler, ((fragmentInputs.vPeakAt - uniforms.peakOrigin) * ${samples} + 0.5) / ${side}, 0.).rg * 2. - 1.;
normalW = normalize(peakFacing.x * fragmentInputs.vPeakX + peakFacing.y * fragmentInputs.vPeakY + sqrt(max(0., 1. - dot(peakFacing, peakFacing))) * fragmentInputs.vPeakZ);
${colour((uv) => `textureSample(peakGrain, peakGrainSampler, ${uv}).r`, "vec2f", "vec3f", "let", (n) => `uniforms.${n}`, "fragmentInputs.vPeakAt", "fragmentInputs.vPositionW.z")}`,
          };
    }
    return shaderType === "vertex"
      ? {
          CUSTOM_VERTEX_DEFINITIONS: `varying vec2 vPeakAt; varying vec3 vPeakX; varying vec3 vPeakY; varying vec3 vPeakZ;`,
          CUSTOM_VERTEX_MAIN_END: `vPeakAt = position.xy; vPeakX = normalize((finalWorld * vec4(1., 0., 0., 0.)).xyz); vPeakY = normalize((finalWorld * vec4(0., 1., 0., 0.)).xyz); vPeakZ = normalize((finalWorld * vec4(0., 0., 1., 0.)).xyz);`,
        }
      : {
          CUSTOM_FRAGMENT_DEFINITIONS: `varying vec2 vPeakAt; varying vec3 vPeakX; varying vec3 vPeakY; varying vec3 vPeakZ; uniform sampler2D peakLight; uniform sampler2D peakGrain;`,
          CUSTOM_FRAGMENT_BEFORE_LIGHTS: `vec2 peakFacing = texture2D(peakLight, ((vPeakAt - peakOrigin) * ${samples} + 0.5) / ${side}).rg * 2. - 1.;
normalW = normalize(peakFacing.x * vPeakX + peakFacing.y * vPeakY + sqrt(max(0., 1. - dot(peakFacing, peakFacing))) * vPeakZ);
${colour((uv) => `texture2D(peakGrain, ${uv}).r`, "vec2", "vec3", "float", (n) => n, "vPeakAt", "vPositionW.z")
  .replace(/float (peakGritUv|peakGrit|peakCoarseUv|peakCoarse) =/g, "vec2 $1 =")
  .replace(/float peakStone =/, "vec3 peakStone =")}`,
        };
  }
}

/** A chunk's mountains' material, coloured as rock, meadow and snow, lit
 *  by their facing (`layPeaks`), the chunk's low corner at (x, y) on the
 *  map. */
export function peakMaterial(scene: Scene, name: string, light: Uint8Array, [x, y]: [number, number], colours: [Color3, Color3, Color3]): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = Color3.White();
  material.specularColor = new Color3(0.07, 0.07, 0.07);
  material.specularPower = 64;
  material.backFaceCulling = false;
  const texture = new RawTexture(light, PEAK_SIDE, PEAK_SIDE, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
  texture.wrapU = texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  material.onDisposeObservable.addOnce(() => texture.dispose());
  new PeakPlugin(material, texture, [x - PEAK_APRON, y - PEAK_APRON], colours);
  return material;
}
