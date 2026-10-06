import { Color3, Constants, MaterialDefines, MaterialPluginBase, RawTexture, StandardMaterial, type Material, type Scene } from "@babylonjs/core";
import { CHUNK_SIZE, SHORE_DENSITY } from "./objects/terrainGeometry";
import { ShinePlugin } from "./shine";

/**
 * The land as it is drawn. A fine grain, so it reads as a surface rather
 * than one sheet of plastic: one tiling texture of noise, read by where on
 * the map a pixel lies, lightens and darkens the colour a little. And a
 * bevel: each chunk's ground knows which way and how far its facing turns
 * as it rounds over an edge onto lower ground (`bevelField`), grass onto
 * sand, sand into the water, so each lies on the one below it.
 */

/** The texture's side, in texels, how many tiles it spans, and how much
 *  it lightens and darkens. A texel is about a pixel at the usual zoom;
 *  further out the mipmaps smooth it away. */
const SIDE = 256;
const SPAN = 4;
const GRAIN = 0.06;

/** A random byte a texel. */
function grainData(): Uint8Array {
  let seed = 11;
  return Uint8Array.from({ length: SIDE * SIDE }, () => (seed = (seed * 16807) % 2147483647) % 256);
}

const GRAINS = new WeakMap<Scene, RawTexture>();
function grain(scene: Scene): RawTexture {
  let texture = GRAINS.get(scene);
  if (!texture) {
    texture = new RawTexture(grainData(), SIDE, SIDE, Constants.TEXTUREFORMAT_R, scene, true, false, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE);
    texture.wrapU = texture.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
    GRAINS.set(scene, texture);
  }
  return texture;
}

class GroundDefines extends MaterialDefines {
  GROUND = false;
}

class GroundPlugin extends MaterialPluginBase {
  constructor(
    material: Material,
    private bevel: RawTexture,
  ) {
    super(material, "Ground", 220, new GroundDefines());
    this._enable(true);
  }

  isCompatible() {
    return true;
  }

  prepareDefines(defines: GroundDefines) {
    defines.GROUND = true;
  }

  getSamplers(samplers: string[]) {
    samplers.push("groundGrain", "groundBevel");
  }

  bindForSubMesh(ubo: { setTexture(name: string, t: RawTexture): void }) {
    ubo.setTexture("groundGrain", grain(this._material.getScene()));
    ubo.setTexture("groundBevel", this.bevel);
  }

  getClassName() {
    return "GroundPlugin";
  }

  getCustomCode(shaderType: string, shaderLanguage = 0): Record<string, string> {
    const wgsl = shaderLanguage === 1;
    // Where on its chunk a pixel is, and which ways the chunk's own x and y
    // run in the world, however the mesh is placed.
    if (shaderType === "vertex") {
      return wgsl
        ? {
            CUSTOM_VERTEX_DEFINITIONS: "varying vGroundAt: vec2f; varying vGroundX: vec2f; varying vGroundY: vec2f;",
            CUSTOM_VERTEX_MAIN_END:
              "vertexOutputs.vGroundAt = positionUpdated.xy; vertexOutputs.vGroundX = (finalWorld * vec4f(1., 0., 0., 0.)).xy; vertexOutputs.vGroundY = (finalWorld * vec4f(0., 1., 0., 0.)).xy;",
          }
        : {
            CUSTOM_VERTEX_DEFINITIONS: "varying vec2 vGroundAt; varying vec2 vGroundX; varying vec2 vGroundY;",
            CUSTOM_VERTEX_MAIN_END: "vGroundAt = positionUpdated.xy; vGroundX = (finalWorld * vec4(1., 0., 0., 0.)).xy; vGroundY = (finalWorld * vec4(0., 1., 0., 0.)).xy;",
          };
    }
    const f = (x: number) => x.toFixed(4);
    const [span, strength, chunk] = [f(SPAN), f(GRAIN * 2), f(CHUNK_SIZE)];
    // Turned out by `turn`, as a cliff's rounded top was: 45 degrees at the
    // edge itself, level by BEVEL in.
    return wgsl
      ? {
          CUSTOM_FRAGMENT_DEFINITIONS:
            "varying vGroundAt: vec2f; varying vGroundX: vec2f; varying vGroundY: vec2f; var groundGrainSampler: sampler; var groundGrain: texture_2d<f32>; var groundBevelSampler: sampler; var groundBevel: texture_2d<f32>;",
          CUSTOM_FRAGMENT_BEFORE_LIGHTS: [
            `baseColor = vec4f(baseColor.rgb * (1. + (textureSample(groundGrain, groundGrainSampler, fragmentInputs.vPositionW.xy / ${span}).r - 0.5) * ${strength}), baseColor.a);`,
            `let turn = textureSample(groundBevel, groundBevelSampler, fragmentInputs.vGroundAt / ${chunk}).rg * 2. - 1.;`,
            `normalW = normalize(normalW * (1. - 0.2929 * length(turn)) + vec3f((turn.x * fragmentInputs.vGroundX + turn.y * fragmentInputs.vGroundY) * 0.7071, 0.));`,
          ].join("\n"),
        }
      : {
          CUSTOM_FRAGMENT_DEFINITIONS: "varying vec2 vGroundAt; varying vec2 vGroundX; varying vec2 vGroundY; uniform sampler2D groundGrain; uniform sampler2D groundBevel;",
          CUSTOM_FRAGMENT_BEFORE_LIGHTS: [
            `baseColor.rgb *= 1. + (texture2D(groundGrain, vPositionW.xy / ${span}).r - 0.5) * ${strength};`,
            `vec2 turn = texture2D(groundBevel, vGroundAt / ${chunk}).rg * 2. - 1.;`,
            `normalW = normalize(normalW * (1. - 0.2929 * length(turn)) + vec3((turn.x * vGroundX + turn.y * vGroundY) * 0.7071, 0.));`,
          ].join("\n"),
        };
  }
}

/** A material for one chunk's ground, its colour and shine the mesh's own,
 *  by vertex, its bevel as `bevelField` gives it, if it has one. Its
 *  bevel's texture goes with it. */
export function groundMaterial(scene: Scene, bevel: Uint8Array | null): StandardMaterial {
  const mat = new StandardMaterial("ground", scene);
  // Lacquered as the rest of the toy, the glint tight, and as much of it as
  // each ground has (`SHINE`).
  mat.specularColor = new Color3(0.45, 0.45, 0.45);
  mat.specularPower = 64;
  new ShinePlugin(mat);
  const side = bevel ? CHUNK_SIZE * SHORE_DENSITY : 1;
  const texture = new RawTexture(bevel ?? new Uint8Array([128, 128]), side, side, Constants.TEXTUREFORMAT_RG, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
  texture.wrapU = texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  new GroundPlugin(mat, texture);
  mat.onDisposeObservable.addOnce(() => texture.dispose());
  return mat;
}
