import { createTexture2DFromPixels, type EngineContext, type MaterialPlugin, type Texture2D } from "@babylonjs/lite";
import { retire } from "./geometry";
import type { Rgb } from "./rgb";
import { RIM } from "./town/draw";
import type { KerbTexels } from "./kerbLines";

/**
 * Kerbs rounded from a texture rather than a rim of triangles. A flat sheet
 * (paving, a road) gets a texture over its own extent holding, at every
 * texel, how far it lies inside the sheet's kerbs: positive within,
 * negative beyond. Distance to a straight edge changes evenly and the
 * texture is read between texels evenly, so a kerb comes out exact even
 * where texels are coarser than the round. Drawing the sheet, a pixel
 * within reach of a kerb turns its facing outward as a rim's would: halfway
 * out at the edge, up again at the round's inner side. However the sheet is
 * cut into triangles, and however many kerbs come near one.
 *
 * Of a sheet whose every edge is a kerb, as the paving's, the texture can
 * hold the sheet itself too, how far inside it each point is, and the
 * sheet is then drawn as a square over its box, cut to it (as road tiles
 * are, `roads.ts`). In the sheet's own frame: a sheet is moved, never
 * turned. The texels are worked out apart, with no Babylon, so the town's
 * are worked out off the main thread (`kerbLines.ts`).
 */

/** A sheet's kerb texture, made of its texels (`kerbTexels`). */
export function kerbField(engine: EngineContext, { half, origin, size, texels }: KerbTexels): KerbField {
  const texture = createTexture2DFromPixels(engine, half, texels[0], texels[1], { format: "rgba16float", minFilter: "linear", magFilter: "linear" });
  return { texture, origin, size, texels };
}

export interface KerbField {
  texture: Texture2D;
  /** The texture's low corner in the sheet's frame, and its extent. */
  origin: [number, number];
  size: [number, number];
  texels: [number, number];
}

/** Where roads are cut into a sheet (`kerbTexels`' roads): the sheet
 *  reaches this far over a road's edge, in tiles, over the crumbled fringe
 *  of its asphalt (`roads.ts`), and its kerb stone rounds down to the road
 *  over this far. */
const CUT = 0.04;
const STONE = 0.035;
/** A sheet's kerb stones, along every edge of it, onto the roads cut into
 *  it and onto what lies round it: a row this wide, this much lighter than
 *  the sheet, set off from it by a joint the stone and the sheet each round
 *  down into, over this far either side, this steeply, as the slabs' do
 *  (`paving.ts`). */
const BAND = 0.04;
const BAND_LIGHT = 1.07;
const JOINT = 0.008;
const JOINT_DEPTH = 0.6;
const n = (x: number) => x.toFixed(4);

/** Kerbs rounded from a sheet's kerb texture, on its material, its lines
 *  painted in `line` on a sheet of colour `sheet`. Its texture is let go
 *  with `unkerb`. The sheet's own frame is carried to every pixel: a sheet is
 *  moved, never turned, so its ways are the world's. */
export function kerbPlugin(field: KerbField, line: Rgb, sheet: Rgb): MaterialPlugin {
  return {
    name: "Kerb",
    priority: 210,
    getVaryings: () => [{ name: "vKerbAt", type: "vec2f" }],
    getSamplers: () => [{ texture: "kerbField", sampler: "kerbFieldSampler" }],
    bindTextures: (out) => out.push({ texture: field.texture }),
    getUniforms: () => ({
      ubo: [
        { name: "kerbOrigin", type: "vec2<f32>" },
        { name: "kerbSize", type: "vec2<f32>" },
        { name: "kerbTexel", type: "vec2<f32>" },
        { name: "kerbWidth", type: "f32" },
        { name: "kerbLine", type: "vec4<f32>" },
      ],
    }),
    writeUbo: (data, offsets) => {
      const at = (name: string) => offsets.get(name)! / 4;
      data.set(field.origin, at("kerbOrigin"));
      data.set(field.size, at("kerbSize"));
      data.set([1 / field.texels[0], 1 / field.texels[1]], at("kerbTexel"));
      data[at("kerbWidth")] = RIM;
      // The line's colour over the sheet's, so the sheet's light and glow
      // come out the line's own.
      data.set([line.r / Math.max(sheet.r, 1e-3), line.g / Math.max(sheet.g, 1e-3), line.b / Math.max(sheet.b, 1e-3), 1], at("kerbLine"));
    },
    getCustomCode: (stage) =>
      stage === "vertex"
        ? { CUSTOM_VERTEX_MAIN_END: "out.vKerbAt = position.xy;" }
        : {
            CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `let kerbUv = (input.vKerbAt - material.kerbOrigin) / material.kerbSize;
let kerbTx = vec2f(material.kerbTexel.x, 0.);
let kerbTy = vec2f(0., material.kerbTexel.y);
let kerbAt = textureSampleLevel(kerbField, kerbFieldSampler, kerbUv, 0.);
if (kerbAt.g < 0.) { discard; }
if (kerbAt.a > ${n(CUT)}) { discard; }
if (abs(kerbAt.b) < 1.) { baseColor *= material.kerbLine.rgb; }
let kerbD = kerbAt.r;
let kerbEdge = min(select(9., kerbD, kerbD >= 0.), ${n(CUT)} - kerbAt.a);
let kerbBand = 1. - step(${n(BAND)}, kerbEdge);
baseColor *= mix(1., ${n(BAND_LIGHT)}, kerbBand);
let kerbDx = textureSampleLevel(kerbField, kerbFieldSampler, kerbUv + kerbTx, 0.).r - textureSampleLevel(kerbField, kerbFieldSampler, kerbUv - kerbTx, 0.).r;
let kerbDy = textureSampleLevel(kerbField, kerbFieldSampler, kerbUv + kerbTy, 0.).r - textureSampleLevel(kerbField, kerbFieldSampler, kerbUv - kerbTy, 0.).r;
if (kerbD >= 0. && kerbD < material.kerbWidth && kerbDx * kerbDx + kerbDy * kerbDy > 0.) {
  let kerbOut = normalize(vec3f(-kerbDx, -kerbDy, 0.));
  N = normalize(mix(N, normalize(N + kerbOut), 1. - kerbD / material.kerbWidth));
}
let kerbStone = (${n(CUT)} - kerbAt.a) / ${n(STONE)};
let kerbToRoad = vec2f(textureSampleLevel(kerbField, kerbFieldSampler, kerbUv + kerbTx, 0.).a - textureSampleLevel(kerbField, kerbFieldSampler, kerbUv - kerbTx, 0.).a, textureSampleLevel(kerbField, kerbFieldSampler, kerbUv + kerbTy, 0.).a - textureSampleLevel(kerbField, kerbFieldSampler, kerbUv - kerbTy, 0.).a);
if (kerbStone < 1. && dot(kerbToRoad, kerbToRoad) > 0.) {
  N = normalize(mix(N, normalize(N + vec3f(normalize(kerbToRoad), 0.)), 1. - kerbStone));
}
// The joint behind the kerb stones: in from whichever edge is nearer, the
// stone on its one side and the sheet on the other rounding down into it.
let kerbIn = select(vec2f(kerbDx, kerbDy), -kerbToRoad, ${n(CUT)} - kerbAt.a < select(9., kerbD, kerbD >= 0.));
let kerbJoint = kerbEdge - ${n(BAND)};
if (abs(kerbJoint) < ${n(JOINT)} && dot(kerbIn, kerbIn) > 0.) {
  N = normalize(N - vec3f(normalize(kerbIn) * sign(kerbJoint) * (1. - abs(kerbJoint) / ${n(JOINT)}) * ${n(JOINT_DEPTH)}, 0.));
}`,
          },
  };
}

/** A kerb texture let go of. */
export function unkerb(field: KerbField) {
  retire(field.texture);
}
