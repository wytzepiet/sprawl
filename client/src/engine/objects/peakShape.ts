/**
 * The mountains' shape over their climb (`layPeaks`): ridged multifractal
 * noise, Musgrave's, ridges in layers each finer than the last and each
 * weighted by the one over it, so the finer ones run off the crests of the
 * coarser as spurs off a spine, not everywhere at once; from a gradient
 * noise turned off the map's grain so no line of it runs with the tiles. Written three times, alike to the
 * bit: here for the terrain worker, which lays the mountains' coarse
 * surface, and for the shaders, which light every pixel of it by the shape
 * itself (`peaks.ts`), so the ridges come out sharp however coarse the
 * surface under them. The lattice is hashed in integers, which a GPU and
 * JavaScript reckon the same.
 */

/** How high the mountains stand at most, in tiles. */
export const PEAK = 8;
/** How wide the broadest ridges are, in tiles; how many layers; how much
 *  finer and how much fainter each is than the last; how strongly a crest
 *  carries the next layer; and how high the valleys lie, of the crests. */
const RIDGES = 5;
const LAYERS = 3;
const FINER = 2.2;
const FAINTER = 0.3;
const CARRY = 2;
const VALLEYS = 0.3;

function hash(ix: number, iy: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Gradient noise, -1 to 1 or near: a slope a lattice point, turned. */
function noise(x: number, y: number): number {
  [x, y] = [x * 0.8 - y * 0.6, x * 0.6 + y * 0.8];
  const [ix, iy] = [Math.floor(x), Math.floor(y)];
  const [fx, fy] = [x - ix, y - iy];
  const dot = (cx: number, cy: number) => {
    const a = hash(cx, cy) * Math.PI * 2;
    return Math.cos(a) * (x - cx) + Math.sin(a) * (y - cy);
  };
  const [sx, sy] = [fx * fx * fx * (fx * (fx * 6 - 15) + 10), fy * fy * fy * (fy * (fy * 6 - 15) + 10)];
  const a = dot(ix, iy) + (dot(ix + 1, iy) - dot(ix, iy)) * sx;
  const b = dot(ix, iy + 1) + (dot(ix + 1, iy + 1) - dot(ix, iy + 1)) * sx;
  return (a + (b - a) * sy) * 1.4;
}

/** Noise folded at nought: 1 on a crest, falling either side. */
const ridged = (n: number) => 1 - Math.min(1, Math.abs(n));

/** Which side of a ridge's crest a point is: the crest is where this
 *  crosses nought, for the surface to lay an edge along (`layPeaks`). */
export function peakCrest(x: number, y: number): number {
  return noise(x / RIDGES + 17, y / RIDGES + 31);
}

/** The shape at a point of the map: 1 on the highest crests, `VALLEYS`
 *  in the valleys. */
export function peakShape(x: number, y: number): number {
  let [scale, weight, sum, most] = [1 / RIDGES, 1, 0, 0];
  for (let k = 0, size = 1; k < LAYERS; k++, scale *= FINER, size *= FAINTER) {
    let ridge = ridged(noise(x * scale + 17 + k * 41, y * scale + 31 + k * 23));
    ridge *= ridge * weight;
    weight = Math.min(1, Math.max(0, ridge * CARRY));
    sum += ridge * size;
    most += size;
  }
  return VALLEYS + (1 - VALLEYS) * (sum / most);
}

const f = (x: number) => x.toFixed(4);

/** The same, as shader functions: `peakShape(vec2)`. */
export const PEAK_GLSL = `uint peakHash(ivec2 i) {
  uint h = (uint(i.x) * 0x27d4eb2du) ^ (uint(i.y) * 0x165667b1u);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  return h ^ (h >> 15u);
}
float peakDot(ivec2 c, vec2 p) {
  float a = float(peakHash(c)) / 4294967296. * 6.2831853;
  return cos(a) * (p.x - float(c.x)) + sin(a) * (p.y - float(c.y));
}
float peakNoise(vec2 p) {
  p = vec2(p.x * 0.8 - p.y * 0.6, p.x * 0.6 + p.y * 0.8);
  ivec2 i = ivec2(floor(p));
  vec2 t = p - floor(p);
  vec2 s = t * t * t * (t * (t * 6. - 15.) + 10.);
  float a = mix(peakDot(i, p), peakDot(i + ivec2(1, 0), p), s.x);
  float b = mix(peakDot(i + ivec2(0, 1), p), peakDot(i + ivec2(1, 1), p), s.x);
  return mix(a, b, s.y) * 1.4;
}
float peakRidged(float n) { return 1. - min(1., abs(n)); }
float peakShape(vec2 p) {
  float scale = ${f(1 / RIDGES)}, weight = 1., size = 1., sum = 0., most = 0.;
  for (int k = 0; k < ${LAYERS}; k++) {
    float ridge = peakRidged(peakNoise(p * scale + vec2(17. + float(k) * 41., 31. + float(k) * 23.)));
    ridge *= ridge * weight;
    weight = clamp(ridge * ${f(CARRY)}, 0., 1.);
    sum += ridge * size;
    most += size;
    scale *= ${f(FINER)};
    size *= ${f(FAINTER)};
  }
  return ${f(VALLEYS)} + ${f(1 - VALLEYS)} * (sum / most);
}`;

export const PEAK_WGSL = `fn peakHash(i: vec2<i32>) -> u32 {
  var h = (bitcast<u32>(i.x) * 0x27d4eb2du) ^ (bitcast<u32>(i.y) * 0x165667b1u);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  return h ^ (h >> 15u);
}
fn peakDot(c: vec2<i32>, p: vec2f) -> f32 {
  let a = f32(peakHash(c)) / 4294967296. * 6.2831853;
  return cos(a) * (p.x - f32(c.x)) + sin(a) * (p.y - f32(c.y));
}
fn peakNoise(q: vec2f) -> f32 {
  let p = vec2f(q.x * 0.8 - q.y * 0.6, q.x * 0.6 + q.y * 0.8);
  let i = vec2<i32>(floor(p));
  let t = p - floor(p);
  let s = t * t * t * (t * (t * 6. - 15.) + 10.);
  let a = mix(peakDot(i, p), peakDot(i + vec2<i32>(1, 0), p), s.x);
  let b = mix(peakDot(i + vec2<i32>(0, 1), p), peakDot(i + vec2<i32>(1, 1), p), s.x);
  return mix(a, b, s.y) * 1.4;
}
fn peakRidged(n: f32) -> f32 { return 1. - min(1., abs(n)); }
fn peakShape(p: vec2f) -> f32 {
  var scale = ${f(1 / RIDGES)};
  var weight = 1.;
  var size = 1.;
  var sum = 0.;
  var most = 0.;
  for (var k = 0; k < ${LAYERS}; k++) {
    var ridge = peakRidged(peakNoise(p * scale + vec2f(17. + f32(k) * 41., 31. + f32(k) * 23.)));
    ridge *= ridge * weight;
    weight = clamp(ridge * ${f(CARRY)}, 0., 1.);
    sum += ridge * size;
    most += size;
    scale *= ${f(FINER)};
    size *= ${f(FAINTER)};
  }
  return ${f(VALLEYS)} + ${f(1 - VALLEYS)} * (sum / most);
}`;
