import { createFilledTexture, drawnOnce, fillTexture, RANDOM, type EngineContext, type Texture2D } from "./gpu";

/**
 * The lace foam leaves as a broken wave runs back (`water.ts` reads it),
 * drawn on the GPU: strands of foam round clear holes, a square this many
 * texels a side, wrapping, laid over this many tiles. Cells' borders, of
 * two sizes of cell, thickest along a border's middle and thinning to
 * nothing: so as the water reads it against a rising line, the holes open
 * first, then the strands thin and part, then the last of it is islands,
 * and gone.
 */
export const LACE_SIDE = 256;
export const LACE_TILES = 1.4;

/** Cells across the square, of each size; each size's strands, how wide
 *  as a share of a cell, and how much of the foam they make. */
const SIZES: [number, number, number][] = [
  [9, 0.22, 1],
  [23, 0.2, 0.6],
];

/** How far a strand wanders off its cell's border, of the square, and how
 *  much grain frays its edges. */
const WAVER = 0.025;
const FRAY = 0.45;

const f = (x: number) => x.toFixed(5);
const n = LACE_SIDE;

/** Every texel's foam, 0 clear to 1 the thick of a strand: read a little
 *  off where it lies, so strands waver; along a border the two nearest
 *  cells' points are as near, the strand's middle; thick in some places
 *  and thin in others, so strands part unevenly and what is left last is
 *  clumps, not the whole net gone faint at once; and frayed, grain in the
 *  foam, so its edges are rough, not cut. */
const LACE = `${RANDOM}
// Smooth noise over the wrapping square, 0 to 1, of this many lumps a side.
fn lump(c: vec2i, lumps: i32, salt: u32) -> f32 { let w = vec2u(((c % lumps) + lumps) % lumps); return rnd(w.y * u32(lumps) + w.x, salt); }
fn lumpy(uv: vec2f, lumps: i32, salt: u32) -> f32 {
  let p = uv * f32(lumps);
  let i = vec2i(floor(p));
  let s = fract(p) * fract(p) * (3. - 2. * fract(p));
  return mix(mix(lump(i, lumps, salt), lump(i + vec2i(1, 0), lumps, salt), s.x), mix(lump(i + vec2i(0, 1), lumps, salt), lump(i + vec2i(1, 1), lumps, salt), s.x), s.y);
}
fn strands(uv: vec2f, cells: i32, wide: f32, salt: u32) -> f32 {
  let p = uv * f32(cells);
  var near = 9.;
  var next = 9.;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let c = vec2i(floor(p)) + vec2i(dx, dy);
      let w = vec2u(((c % cells) + cells) % cells);
      let k = w.y * u32(cells) + w.x;
      let d = distance(p, vec2f(c) + vec2f(rnd(k, salt), rnd(k, salt + 1u)));
      if (d < near) { next = near; near = d; } else if (d < next) { next = d; }
    }
  }
  return 1. - smoothstep(0., 1., min(1., (next - near) / wide));
}
fn fill(at: vec2f) -> vec4f {
  let whole = floor(at) / ${n}.;
  let uv = at / ${n}. + (vec2f(lumpy(whole, 29, 1u), lumpy(whole, 29, 2u)) - 0.5) * ${f(WAVER)};
  let net = max(${SIZES.map(([cells, wide, share], i) => `strands(uv, ${cells}, ${f(wide)}, ${3 + 2 * i}u) * ${f(share)}`).join(", ")});
  let thick = 0.15 + 0.9 * lumpy(whole, 5, 7u) + 0.35 * lumpy(whole, 13, 8u);
  return vec4f(net * thick + (0.6 * lumpy(whole, 61, 9u) + 0.4 * lumpy(whole, 127, 10u) - 0.5) * ${f(FRAY)});
}`;

/** An engine's lace, drawn once. */
export const lace = drawnOnce("lace", (engine: EngineContext): Texture2D => {
  const texture = createFilledTexture(engine, n, n, "r8unorm", true);
  fillTexture(engine, texture, LACE, []);
  return texture;
});
