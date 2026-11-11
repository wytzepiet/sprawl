import { createFilledTexture, fillTexture, mostOf, releaseTexture, type EngineContext, type Texture2D } from "./gpu";

/**
 * The water's ripple, drawn on the GPU (`water.ts` reads it, as do the
 * beach's and the cliff's swash): a tiling field of the surface's slope,
 * two channels, and its height, a third, from waves of whole numbers of
 * crests across it, so it meets itself at its edges: longer waves
 * stronger, as on open water, and all leaning one way, as wind lays them.
 */
export const WAVES_SIDE = 256;
const WAVES = 48;

const n = WAVES_SIDE;

/** The waves: each its crests across and up, how strong, and where in
 *  its swing it starts. */
const waves: [number, number, number, number][] = [];
let seed = 7;
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
while (waves.length < WAVES) {
  const [kx, ky] = [Math.round((random() * 2 - 1) * 14), Math.round((random() * 2 - 1) * 14)];
  const k = Math.hypot(kx, ky);
  if (k < 2) continue;
  // Toward the wind, (1, 0.4), the stronger.
  const lean = 0.35 + 0.65 * Math.max(0, (kx + 0.4 * ky) / (k * 1.077));
  waves.push([kx, ky, lean / k ** 1.5, random() * Math.PI * 2]);
}

/** Every texel's slope, across and up, and its height, as the waves sum. */
const SUM = `const WAVES = array<vec4f, ${WAVES}>(${waves.map((w) => `vec4f(${w.join(", ")})`).join(", ")});
fn fill(at: vec2f) -> vec4f {
  let turn = floor(at) / ${n}. * 6.2831853;
  var sum = vec3f(0.);
  for (var w = 0; w < ${WAVES}; w++) {
    let wave = WAVES[w];
    let angle = dot(wave.xy, turn) + wave.w;
    sum += wave.z * vec3f(-sin(angle) * wave.xy, cos(angle));
  }
  return vec4f(sum, 1.);
}`;
/** And each -1 to 1: the slopes of the steepest, the height of the highest. */
const RIPPLE = `fn fill(at: vec2f) -> vec4f {
  let sum = textureLoad(src0, vec2i(at), 0).xyz;
  let most = textureLoad(src1, vec2i(0), 0).xyz;
  return vec4f(sum / vec3f(vec2f(max(most.x, most.y)), most.z), 1.);
}`;

const DRAWN = new WeakMap<EngineContext, Texture2D>();
/** An engine's ripple, drawn once. */
export function ripples(engine: EngineContext): Texture2D {
  let texture = DRAWN.get(engine);
  if (!texture) {
    texture = createFilledTexture(engine, n, n, "rgba16float", true);
    const sum = createFilledTexture(engine, n, n, "rgba32float");
    fillTexture(engine, sum, SUM, []);
    const most = mostOf(engine, sum, "abs(h)");
    fillTexture(engine, texture, RIPPLE, [sum, most]);
    for (const t of [sum, most]) releaseTexture(t);
    DRAWN.set(engine, texture);
  }
  return texture;
}
