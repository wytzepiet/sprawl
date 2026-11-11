import { createFilledTexture, fillTexture, type EngineContext, type Texture2D } from "./gpu";
import { dryAt } from "./ground";
import { CHUNK_SIZE, SHORE_DENSITY, SHORE_REACH } from "./objects/terrainGeometry";

/**
 * How far each point of a chunk lies from land: 0 at the shore to 1 at
 * `SHORE_REACH` tiles or more, `SHORE_DENSITY` texels to a tile, for the
 * water to take its depth, its foam and its waves from (`water.ts`) and
 * the cliff its wet foot (`peaks.ts`).
 *
 * Worked out on the GPU from the chunk's kinds (`ground.ts`), in three
 * fills: which texels of the chunk and `SHORE_REACH` round it are dry, as
 * the ground is drawn; how far along its row each lies from a dry one; and
 * from those, up and down its column, how far from the nearest dry one
 * anywhere: the distance exactly, in two short loops a texel.
 */
const [D, R] = [SHORE_DENSITY, SHORE_REACH * SHORE_DENSITY];
const WIDE = (CHUNK_SIZE + 2 * SHORE_REACH) * D;

const DRY = `fn fill(at: vec2f) -> vec4f {
  let tile = at / ${D}. - ${SHORE_REACH}.;
  ${dryAt("tile", "src0")}
  return vec4f(dry);
}`;
const ACROSS = `fn fill(at: vec2f) -> vec4f {
  var best = ${R + 1};
  for (var k = ${-R}; k <= ${R}; k++) {
    let x = i32(at.x) + k;
    if (x >= 0 && x < ${WIDE} && textureLoad(src0, vec2i(x, i32(at.y)), 0).r > 0.5) { best = min(best, abs(k)); }
  }
  return vec4f(f32(best) / 255.);
}`;
const UP = `fn fill(at: vec2f) -> vec4f {
  var best = ${R * R}.;
  for (var k = ${-R}; k <= ${R}; k++) {
    let across = textureLoad(src0, vec2i(at) + vec2i(${R}, ${R} + k), 0).r * 255.;
    best = min(best, across * across + f32(k * k));
  }
  return vec4f(sqrt(best) / ${R}.);
}`;

/** The two fills between, an engine's: every chunk's shore goes through them. */
const BETWEEN = new WeakMap<EngineContext, [Texture2D, Texture2D]>();

/** A chunk's shore, to be drawn (`drawShore`). */
export const shoreMap = (engine: EngineContext): Texture2D => createFilledTexture(engine, CHUNK_SIZE * D, CHUNK_SIZE * D);

/** A chunk's shore drawn from its kinds, as they are now. */
export function drawShore(engine: EngineContext, kinds: Texture2D, shore: Texture2D) {
  const [dry, across] = BETWEEN.get(engine) ?? [createFilledTexture(engine, WIDE, WIDE), createFilledTexture(engine, WIDE, WIDE)];
  BETWEEN.set(engine, [dry, across]);
  fillTexture(engine, dry, DRY, [kinds]);
  fillTexture(engine, across, ACROSS, [dry]);
  fillTexture(engine, shore, UP, [across]);
}
