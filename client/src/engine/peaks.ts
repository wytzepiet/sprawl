import { Color3, Constants, MaterialDefines, MaterialPluginBase, RawTexture, ShadowDepthWrapper, type Material, type PBRMaterial, type Scene } from "@babylonjs/core";
import { townMaterial } from "./material";
import { lacquer } from "./bevel";
import { CHUNK_SIZE, CLIFF_OUT, CLIFF_REACH, CLIFF_WANDER, CLIFF_RUN, EDGE, LAYER, PEAK_APRON, PEAK_SAMPLES, PEAK_SIDE, REACH, SHORE_DENSITY } from "./objects/terrainGeometry";
import { SECOND, SPAN } from "./slate";

/**
 * The mountains as dark slate, drawn as trees' crowns are: the mesh is
 * plain, the look is worked out at every pixel.
 *
 * The mesh (`layPeaks`) is a stack of flat planes, one a layer, a square a
 * tile wherever that layer could show, reaching past where its edge will
 * be and on under every layer above, dropped there when drawn and kept in
 * the shadow map, so the stack casts a solid's shadow. The rock's height
 * comes with its chunk, a texture (the heights the server sends), found by
 * where the pixel is on the map. A pixel adds the slate's height (`slate.ts`) to that,
 * scaled by how steep the rock is, so a step's edge wanders as far on a
 * steep range as a gentle one, and is dropped if that falls short of where
 * its layer begins: the edge breaks along the slate's plates, a plate
 * standing proud jutting out and a missing one biting in, and the shadow
 * map, drawn by this same shader, is cut to it. Near its edge a layer's
 * lip rolls over; just below the next layer's edge, the plane is drawn as
 * that layer's cliff; both facing down the slope, turned by the slate,
 * so a notch's sides face across it.
 *
 * Over it all the slate's own grain, read twice, at two sizes and turned,
 * so its repeat does not show, tilting the light; and on the flats its
 * hollows a little darker than its plates and shining much less. A lip
 * or cliff is the stone's own colour: its shape is only the facing's.
 */

/** The stone's colour; how far the slate tilts the facing; and how many mipmap levels coarser the slate is read,
 *  its plates kept and its grit gone, so the cliffs' shapes show. */
const STONE = new Color3(0.66, 0.61, 0.54);
const RELIEF = 0.5;
export const CALM = 2;
/** On the flats the slate's hollows, between its plates, are darker than
 *  its highest plates by this much, and shine this much less; never on a
 *  lip or cliff, which keep the stone's own colour and shine. */
const HOLLOW = 0.12;
const DULL = 0.85;
/** How far the slate's faces are glossed from the rock's roughness, where
 *  the hollows leave them: worn smooth, as a crag catches the sun. */
const ROCK_SHINE = 0.4;
/** How far, in tiles, a step's edge wanders with the slate, the slate's
 *  height added scaled by how steep the rock is; the steepness counted at
 *  most this; fading out over this much height at the foot, so the rock
 *  keeps to its own ground. */
const WANDER = 0.4;
const STEEPEST = 4;
const JAG_FOOT = 0.25;
/** A lip rolls over this far in from its edge, in tiles, tilting this far
 *  at the edge; a cliff is drawn this far out below it, facing down the
 *  slope this far. */
const LIP = 0.08;
const ROLL = 1.2;
const CLIFF = 0.14;
const CLIFF_TILT = 1.8;
/** A plane runs on under every layer above it, for the shadow map; drawn,
 *  it is dropped this far, in tiles, under the next. */
const HIDDEN = 0.02;
/** Both face down the rock's smooth slope, turned by the slate's own
 *  facing this much, so a notch's sides face across it: read from the
 *  slate's smooth facing, not from how the broken edge changes from one
 *  pixel to the next, which is grainy. */
const TURN = 1.5;

class BasaltDefines extends MaterialDefines {
  BASALT = false;
}

const f = (x: number) => x.toFixed(4);
const rgb = (c: Color3) => `${f(c.r)}, ${f(c.g)}, ${f(c.b)}`;
const [c2, s2] = [Math.cos(SECOND[1]), Math.sin(SECOND[1])];

/** The slate at a point of the map, both sizes of it: its facing's x and y
 *  in `xy`, the turned one's turned back, and its height in `z`, -1 to 1.
 *  `T(uv)` reads the texture. */
const read = (T: (uv: string) => string, v2: string, head: string, decl: string) => `${head} {
  ${decl} a = ${T(`p / ${f(SPAN)}`)};
  ${decl} b = ${T(`${v2}(p.x * ${f(c2)} - p.y * ${f(s2)}, p.x * ${f(s2)} + p.y * ${f(c2)}) / ${f(SPAN * SECOND[0])}`)};
  ${decl === "let" ? "let" : v2} bf = b.rg * 2. - 1.;
  return mix(a.rgb * 2. - 1., ${v2 === "vec2f" ? "vec3f" : "vec3"}(bf.x * ${f(c2)} + bf.y * ${f(s2)}, bf.y * ${f(c2)} - bf.x * ${f(s2)}, b.b * 2. - 1.), ${f(SECOND[2])});
}`;

/** The rock's height at a point of the map, from the texture of the chunk
 *  whose heights start at `corner`, and its slope: the four texels round it blended here, not by the sampler,
 *  whose blend steps in 256ths of a texel and makes the slope shimmer from
 *  one pixel to the next. `L(x, y)` reads a texel, `v2`, `v3` and `vi`
 *  the vectors. */
const heightFn = (L: (c: string) => string, v2: string, v3: string, vi: string, head: string, decl: string) => `${head} {
  ${decl === "let" ? "let" : v2} t = (p - corner) * ${f(PEAK_SAMPLES)};
  ${decl === "let" ? "let" : v2} i = clamp(floor(t), ${v2}(0.), ${v2}(${f(PEAK_SIDE - 2)}));
  ${decl === "let" ? "let" : v2} u = t - i;
  ${decl} a = ${L(`${vi}(i)`)};
  ${decl} b = ${L(`${vi}(i) + ${vi}(1, 0)`)};
  ${decl} c = ${L(`${vi}(i) + ${vi}(0, 1)`)};
  ${decl} d = ${L(`${vi}(i) + ${vi}(1, 1)`)};
  return ${v3}(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), ${v2}(mix(b - a, d - c, u.y), mix(c - a, d - b, u.x)) * ${f(PEAK_SAMPLES)});
}`;

/** A pixel's layer cut and lit, in a shader's own words: `at` its place on
 *  the map (the mesh is laid there). Every texture read comes before the
 *  discard, as WGSL asks. */
const peak = (v2: string, v3: string, decl: string, at: string) => {
  const vec = decl === "let" ? "let" : v2;
  const wgsl = v3 === "vec3f";
  const choose = (no: string, yes: string, when: string) => (wgsl ? `select(${no}, ${yes}, ${when})` : `(${when} ? ${yes} : ${no})`);
  return `${vec} peakCorner = floor(${at}.xy / ${f(CHUNK_SIZE)}) * ${f(CHUNK_SIZE)} - ${f(PEAK_APRON)};
${wgsl ? "let" : "vec3"} peakRock = peakHeightAt(${at}.xy, peakCorner);
${decl} peakOwn = peakRock.x;
${vec} peakFall = -peakRock.yz;
${wgsl ? "let" : "vec3"} peakSlate = slateRead(${at}.xy);
${decl} peakSteep = max(length(peakFall), 0.05);
${decl} peakLayer = floor(${at}.z / ${f(LAYER)} + 0.5);
${decl} peakS = peakOwn + clamp(${f(WANDER)} * min(peakSteep, ${f(STEEPEST)}) * peakSlate.z * 0.5 * min(1., peakOwn / ${f(JAG_FOOT)}), ${f(-0.9 * REACH)}, ${f(0.9 * REACH)});
${vec} peakDown = normalize(peakFall / peakSteep + peakSlate.xy * ${f(TURN)});
${decl} peakIn = (peakS - (${f(EDGE)} + (peakLayer - 1.) * ${f(LAYER)})) / peakSteep;
${decl} peakBelow = (${f(EDGE)} + peakLayer * ${f(LAYER)} - peakS) / peakSteep;
if (peakLayer > 0.5 && peakIn < 0.) { discard; }
#ifndef SM_FLOAT
if (peakBelow < ${f(-HIDDEN)}) { discard; }
#endif
${decl} peakLip = ${choose("0.", `1. - smoothstep(0., ${f(LIP)}, peakIn)`, "peakLayer > 0.5")};
${decl} peakCliff = 1. - smoothstep(${f(CLIFF * 0.6)}, ${f(CLIFF)}, peakBelow);
${decl} peakHollow = (0.5 - 0.5 * peakSlate.z) * (1. - max(peakLip, peakCliff));
baseColor = vec4${wgsl ? "f" : ""}(${v3}(${rgb(STONE)}) * (1. - ${f(HOLLOW)} * peakHollow), baseColor.a);
${decl} peakShine = 1. - ${f(DULL)} * peakHollow;
townShine = ${f(ROCK_SHINE)} * peakShine;
normalW = normalize(${v3}(peakDown * (peakLip * ${f(ROLL)} + peakCliff * ${f(CLIFF_TILT)}) + peakSlate.xy * ${f(RELIEF)}, 1.));`;
};

/** Each scene's slate: flat until the worker has baked it. The cliffs the
 *  land stands on break along it too (`ground.ts`). */
const SLATES = new Map<Scene, RawTexture>();
export function slate(scene: Scene): RawTexture {
  let texture = SLATES.get(scene);
  if (!texture) {
    const make = (data: Uint8Array, side: number) => {
      const t = new RawTexture(data, side, side, Constants.TEXTUREFORMAT_RGBA, scene, true, false, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE);
      t.wrapU = t.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
      return t;
    };
    texture = make(new Uint8Array([128, 128, 255, 255]), 1);
    SLATES.set(scene, texture);
    const worker = new Worker(new URL("./slateWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<Uint8Array>) => {
      worker.terminate();
      SLATES.get(scene)?.dispose();
      SLATES.set(scene, make(data, Math.sqrt(data.length / 4)));
    };
  }
  return texture;
}

class BasaltPlugin extends MaterialPluginBase {
  constructor(
    material: Material,
    /** Its chunk's heights. */
    private heights: RawTexture,
  ) {
    super(material, "Basalt", 200, new BasaltDefines());
    this._enable(true);
  }

  isCompatible() {
    return true;
  }

  prepareDefines(defines: BasaltDefines) {
    defines.BASALT = true;
  }

  getSamplers(samplers: string[]) {
    samplers.push("slate", "peakHeights");
  }

  bindForSubMesh(ubo: { setTexture(n: string, t: unknown): void }) {
    ubo.setTexture("slate", slate(this._material.getScene()));
    ubo.setTexture("peakHeights", this.heights);
  }

  getClassName() {
    return "BasaltPlugin";
  }

  getCustomCode(shaderType: string, shaderLanguage = 0): Record<string, string> | null {
    const wgsl = shaderLanguage === 1;
    if (shaderType === "vertex") {
      return wgsl
        ? {
            CUSTOM_VERTEX_DEFINITIONS: `varying vPeakAt: vec3f;`,
            CUSTOM_VERTEX_UPDATE_WORLDPOS: `let peakNormal = vec3f(0., 0., 1.);`,
            CUSTOM_VERTEX_MAIN_END: `vertexOutputs.vPeakAt = vertexInputs.position;`,
          }
        : {
            CUSTOM_VERTEX_DEFINITIONS: `varying vec3 vPeakAt;`,
            CUSTOM_VERTEX_UPDATE_WORLDPOS: `vec3 peakNormal = vec3(0., 0., 1.);`,
            CUSTOM_VERTEX_MAIN_END: `vPeakAt = position;`,
          };
    }
    return wgsl
      ? {
          CUSTOM_FRAGMENT_DEFINITIONS: `var slateSampler: sampler; var slate: texture_2d<f32>; var peakHeightsSampler: sampler; var peakHeights: texture_2d<f32>; varying vPeakAt: vec3f;
${read((uv) => `textureSampleBias(slate, slateSampler, ${uv}, ${f(CALM)})`, "vec2f", "fn slateRead(p: vec2f) -> vec3f", "let")}
${heightFn((c) => `textureLoad(peakHeights, ${c}, 0).r`, "vec2f", "vec3f", "vec2i", "fn peakHeightAt(p: vec2f, corner: vec2f) -> vec3f", "let")}`,
          CUSTOM_FRAGMENT_BEFORE_LIGHTS: peak("vec2f", "vec3f", "let", "fragmentInputs.vPeakAt"),
        }
      : {
          CUSTOM_FRAGMENT_DEFINITIONS: `uniform sampler2D slate; uniform sampler2D peakHeights; varying vec3 vPeakAt;
${read((uv) => `texture2D(slate, ${uv}, ${f(CALM)})`, "vec2", "vec3 slateRead(vec2 p)", "vec4")}
${heightFn((c) => `texelFetch(peakHeights, ${c}, 0).r`, "vec2", "vec3", "ivec2", "vec3 peakHeightAt(vec2 p, vec2 corner)", "float")}`,
          CUSTOM_FRAGMENT_BEFORE_LIGHTS: peak("vec2", "vec3", "float", "vPeakAt"),
        };
  }
}

/** A chunk's mountains' material, with the chunk's heights (half floats,
 *  `PEAK_SIDE` to a side): their surface is laid where it is on the map, so
 *  the slate and the heights are read by where a pixel is. Drawn into the
 *  shadow map by its own shader, so a layer's shadow is cut to its broken
 *  edge. */
export function peakMaterial(scene: Scene, name: string, heights: Uint16Array): PBRMaterial {
  const texture = new RawTexture(heights, PEAK_SIDE, PEAK_SIDE, Constants.TEXTUREFORMAT_R, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT);
  texture.wrapU = texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  const material = townMaterial(name, scene);
  material.onDisposeObservable.addOnce(() => texture.dispose());
  material.albedoColor = Color3.White();
  lacquer(material, "rock");
  material.backFaceCulling = false;
  new BasaltPlugin(material, texture);
  material.shadowDepthWrapper = new ShadowDepthWrapper(material, scene, { remappedVariables: ["worldPos", "worldPos", "vNormalW", "peakNormal"] });
  return material;
}

/** How far in from the land's edge its cliff's plane is drawn, in tiles:
 *  past its lip, under where the grass stops (`ground.ts`). */
const CLIFF_INNER = 0.9;

class CliffDefines extends MaterialDefines {
  LANDCLIFF = false;
}

/** The land's cliff, painted as a mountain's is on the plane under its
 *  edge (`layCliffPlane`): how far out from the land's edge a pixel is
 *  (`cliffField`). Inside the edge, the lip, rolling over as a mountain
 *  layer's does; outside, within `CLIFF_RUN` of it, the face, both facing
 *  out, turned by the slate, the slate's grain over them; past that
 *  nothing, the beach or the water showing; far inside, the grass. Only the facing: the
 *  colour is the stone's own. */
const landCliff = (T: (uv: string) => string, v2: string, v3: string, decl: string, at: string, local: string, ax: string, ay: string) => {
  const vec = decl === "let" ? "let" : v2;
  const e = f(1 / (CHUNK_SIZE * SHORE_DENSITY));
  const field = (uv: string) => `((${T(uv)}.r - 0.5) * ${f(2 * CLIFF_REACH)})`;
  const choose = (no: string, yes: string, when: string) => (v3 === "vec3f" ? `select(${no}, ${yes}, ${when})` : `(${when} ? ${yes} : ${no})`);
  return `${vec} cliffUv = ${local}.xy / ${f(CHUNK_SIZE)};
${decl} cliffFar = ${field("cliffUv")} - ${f(CLIFF_OUT)} - (cliffSlateTop(${at}.xy) * 2. - 1.) * ${f(CLIFF_WANDER)};
${vec} cliffGrad = ${v2}(${field(`cliffUv + ${v2}(${e}, 0.)`)} - ${field(`cliffUv - ${v2}(${e}, 0.)`)}, ${field(`cliffUv + ${v2}(0., ${e})`)} - ${field(`cliffUv - ${v2}(0., ${e})`)});
${decl === "let" ? "let" : "vec3"} cliffSlate = slateRead(${at}.xy);
if (cliffFar > ${f(CLIFF_RUN)} || cliffFar < ${f(-CLIFF_INNER)}) { discard; }
${decl} cliffTilt = ${choose("1. - smoothstep(0., " + f(LIP) + ", -cliffFar)", f(CLIFF_TILT), "cliffFar > 0.")} * ${choose(f(ROLL), "1.", "cliffFar > 0.")};
${vec} cliffOut = normalize(normalize(cliffGrad.x * ${ax} + cliffGrad.y * ${ay} + 1e-6) + cliffSlate.xy * ${f(TURN)});
baseColor = vec4${v3 === "vec3f" ? "f" : ""}(${v3}(${rgb(STONE)}), baseColor.a);
normalW = normalize(${v3}(cliffOut * cliffTilt + cliffSlate.xy * ${f(RELIEF)}, 1.));`;
};

class LandCliffPlugin extends MaterialPluginBase {
  constructor(
    material: Material,
    /** Its chunk's field. */
    private field: RawTexture,
  ) {
    super(material, "LandCliff", 200, new CliffDefines());
    this._enable(true);
  }

  isCompatible() {
    return true;
  }

  prepareDefines(defines: CliffDefines) {
    defines.LANDCLIFF = true;
  }

  getSamplers(samplers: string[]) {
    samplers.push("slate", "cliffField");
  }

  bindForSubMesh(ubo: { setTexture(n: string, t: unknown): void }) {
    ubo.setTexture("slate", slate(this._material.getScene()));
    ubo.setTexture("cliffField", this.field);
  }

  getClassName() {
    return "LandCliffPlugin";
  }

  getCustomCode(shaderType: string, shaderLanguage = 0): Record<string, string> | null {
    const wgsl = shaderLanguage === 1;
    if (shaderType === "vertex") {
      return wgsl
        ? {
            CUSTOM_VERTEX_DEFINITIONS: `varying vCliffAt: vec2f; varying vCliffX: vec2f; varying vCliffY: vec2f;`,
            CUSTOM_VERTEX_MAIN_END: `vertexOutputs.vCliffAt = vertexInputs.position.xy; vertexOutputs.vCliffX = (finalWorld * vec4f(1., 0., 0., 0.)).xy; vertexOutputs.vCliffY = (finalWorld * vec4f(0., 1., 0., 0.)).xy;`,
          }
        : {
            CUSTOM_VERTEX_DEFINITIONS: `varying vec2 vCliffAt; varying vec2 vCliffX; varying vec2 vCliffY;`,
            CUSTOM_VERTEX_MAIN_END: `vCliffAt = position.xy; vCliffX = (finalWorld * vec4(1., 0., 0., 0.)).xy; vCliffY = (finalWorld * vec4(0., 1., 0., 0.)).xy;`,
          };
    }
    return wgsl
      ? {
          CUSTOM_FRAGMENT_DEFINITIONS: `var slateSampler: sampler; var slate: texture_2d<f32>; var cliffFieldSampler: sampler; var cliffField: texture_2d<f32>; varying vCliffAt: vec2f; varying vCliffX: vec2f; varying vCliffY: vec2f;
${read((uv) => `textureSampleBias(slate, slateSampler, ${uv}, ${f(CALM)})`, "vec2f", "fn slateRead(p: vec2f) -> vec3f", "let")}
fn cliffSlateTop(p: vec2f) -> f32 { return textureSampleBias(slate, slateSampler, p / ${f(SPAN)}, ${f(CALM)}).b; }`,
          CUSTOM_FRAGMENT_BEFORE_LIGHTS: landCliff((uv) => `textureSampleLevel(cliffField, cliffFieldSampler, ${uv}, 0.)`, "vec2f", "vec3f", "let", "fragmentInputs.vPositionW", "fragmentInputs.vCliffAt", "fragmentInputs.vCliffX", "fragmentInputs.vCliffY"),
        }
      : {
          CUSTOM_FRAGMENT_DEFINITIONS: `uniform sampler2D slate; uniform sampler2D cliffField; varying vec2 vCliffAt; varying vec2 vCliffX; varying vec2 vCliffY;
${read((uv) => `texture2D(slate, ${uv}, ${f(CALM)})`, "vec2", "vec3 slateRead(vec2 p)", "vec4")}
float cliffSlateTop(vec2 p) { return texture2D(slate, p / ${f(SPAN)}, ${f(CALM)}).b; }`,
          CUSTOM_FRAGMENT_BEFORE_LIGHTS: landCliff((uv) => `texture2D(cliffField, ${uv})`, "vec2", "vec3", "float", "vPositionW", "vCliffAt", "vCliffX", "vCliffY"),
        };
  }
}

/** A chunk's land's cliff's material, with its field (`cliffField`). */
export function cliffMaterial(scene: Scene, name: string, field: Uint8Array): PBRMaterial {
  const side = CHUNK_SIZE * SHORE_DENSITY;
  const texture = new RawTexture(field, side, side, Constants.TEXTUREFORMAT_R, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
  texture.wrapU = texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  const material = townMaterial(name, scene);
  material.onDisposeObservable.addOnce(() => texture.dispose());
  material.albedoColor = Color3.White();
  material.backFaceCulling = false;
  new LandCliffPlugin(material, texture);
  return lacquer(material, "rock");
}
