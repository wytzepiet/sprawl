import { createFilledTexture, createTexture2DFromPixels, fillTexture, type EngineContext, type Texture2D } from "./gpu";
import { landAt } from "./ground";
import { CHUNK_SIZE, CLIFF_OUT, CLIFF_REACH, CLIFF_WANDER, SHORE_DENSITY } from "./objects/terrainGeometry";
import { EDGE_LEVEL, SIDE, SPAN } from "./slate";
import { slate } from "./slateTexture";

/**
 * How far each point of a chunk, and `CLIFF_REACH` tiles round it, lies
 * out from the land's lip: its edge `CLIFF_OUT` past its tiles, wandering
 * along the slate, `SHORE_DENSITY` texels to a tile, inside negative,
 * `CLIFF_REACH` either way from half-way. The cliff's lip is painted by it
 * (`peaks.ts`), the sea breaks on it (`water.ts`), and, read back, its
 * wall is traced along it (`terrainGeometry.ts`): one picture, so the
 * three stand on one line.
 *
 * Worked out on the GPU from the chunk's kinds (`ground.ts`), in three
 * fills: which texels are land, as the ground is drawn; how far along its
 * row each lies from land and from what is not; and from those, up and
 * down its column, how far from the nearest of each anywhere, the one
 * less the other, moved by the slate's height there.
 */
const [D, R] = [SHORE_DENSITY, (CLIFF_REACH + 1) * SHORE_DENSITY - 4];
const CLIFF_WIDE = (CHUNK_SIZE + 2 * CLIFF_REACH) * D;
const f = (x: number) => x.toFixed(5);

const LAND = `fn fill(at: vec2f) -> vec4f {
  let tile = at / ${D}. - ${CLIFF_REACH}.;
  ${landAt("tile", "src0")}
  return vec4f(land);
}`;
const ACROSS = `fn fill(at: vec2f) -> vec4f {
  var best = vec2i(${R + 1});
  for (var k = ${-R}; k <= ${R}; k++) {
    let x = i32(at.x) + k;
    if (x < 0 || x >= ${CLIFF_WIDE}) { continue; }
    if (textureLoad(src0, vec2i(x, i32(at.y)), 0).r > 0.5) { best.x = min(best.x, abs(k)); } else { best.y = min(best.y, abs(k)); }
  }
  return vec4f(vec2f(best) / 255., 0., 0.);
}`;
// The slate's smaller copy, blended as a sampler does, wrapping: as
// `slate.ts` reads it for the mountains' edges.
const [SMALL, NONE] = [SIDE >> EDGE_LEVEL, (R + 1) * (R + 1)];
const FIELD = `fn small(i: vec2i) -> f32 { return textureLoad(src1, ((i % ${SMALL}) + ${SMALL}) % ${SMALL}, ${EDGE_LEVEL}).b; }
fn slateHeight(p: vec2f) -> f32 {
  let t = p / ${f(SPAN)} * ${SMALL}. - 0.5;
  let i = vec2i(floor(t));
  let u = t - floor(t);
  return mix(mix(small(i), small(i + vec2i(1, 0)), u.x), mix(small(i + vec2i(0, 1)), small(i + vec2i(1, 1)), u.x), u.y) * 2. - 1.;
}
fn fill(at: vec2f) -> vec4f {
  var best = vec2f(${NONE}.);
  for (var k = ${-R}; k <= ${R}; k++) {
    let y = i32(at.y) + k;
    if (y < 0 || y >= ${CLIFF_WIDE}) { continue; }
    let across = textureLoad(src0, vec2i(i32(at.x), y), 0).rg * 255.;
    best = min(best, across * across + f32(k * k));
  }
  // None within reach is far beyond it, either way.
  let far = sqrt(best) + step(vec2f(${NONE - 0.5}), best) * 1e6;
  let edge = (far.x - far.y) / ${D}. - ${f(CLIFF_OUT)};
  let here = textureLoad(src2, vec2i(0), 0).xy + at / ${D}. - ${CLIFF_REACH}.;
  let wandered = select(edge - slateHeight(here) * ${f(CLIFF_WANDER)}, edge, abs(edge) > ${f(CLIFF_REACH + CLIFF_WANDER)});
  return vec4f(0.5 + wandered / ${f(2 * CLIFF_REACH)});
}`;

/** The two fills between, an engine's: every chunk's cliff goes through them. */
const BETWEEN = new WeakMap<EngineContext, [Texture2D, Texture2D]>();

/** A chunk's cliff, to be drawn (`drawCliff`). */
export const cliffMap = (engine: EngineContext): Texture2D => createFilledTexture(engine, CLIFF_WIDE, CLIFF_WIDE);

/** A chunk's cliff drawn from its kinds, as they are now, the chunk's low
 *  corner at `origin` on the map. */
export function drawCliff(engine: EngineContext, kinds: Texture2D, cliff: Texture2D, origin: [number, number]) {
  const [land, across] = BETWEEN.get(engine) ?? [createFilledTexture(engine, CLIFF_WIDE, CLIFF_WIDE), createFilledTexture(engine, CLIFF_WIDE, CLIFF_WIDE, "rg8unorm")];
  BETWEEN.set(engine, [land, across]);
  const at = createTexture2DFromPixels(engine, new Float32Array([...origin, 0, 0]), 1, 1, { format: "rgba32float" });
  fillTexture(engine, land, LAND, [kinds]);
  fillTexture(engine, across, ACROSS, [land]);
  fillTexture(engine, cliff, FIELD, [across, slate(engine), at]);
  at.texture.destroy();
}
