import { createFilledTexture, drawnOnce, fillTexture, layTexture, releaseTexture, SHAPE_READ, shapesTexture, type EngineContext, type Texture2D } from "./gpu";

/**
 * A wheat field's stages, drawn on the GPU (`objects/field.ts` reads them): a square
 * a stage, a pass wide (across, x) and a tile long (along, y), wrapping
 * both ways, stacked one under the next with a margin of each wrapped
 * round it, so a stage read at its edge, or far off from a smaller copy,
 * reads none of the next. Each the earth, then the plants painted onto it
 * a stroke at a time, as wheat is from the air: no leaves to see, but a
 * fine grain running with the rows: the strokes worked out here, a plant
 * at a time, and laid down there, the highest at each texel showing
 * (`layTexture`).
 *
 * The stages, in order: ploughed; drilled, ten rows a pass, ridged, and
 * the tramlines, the wheel tracks, pressed in either side of the middle
 * row; seedlings, a blade or two along the row; the crop grown, tufts of
 * blades leaning out of the rows and over them; in ear, the ears standing
 * up out of the leaves; ripe, the same, the ears heavier; and stubble, a
 * short stalk or two where each plant stood.
 */
export const WHEAT_TEXELS = 512;
export const WHEAT_MARGIN = 16;
export const WHEAT_STAGES = 7;
export const WHEAT_STRIDE = WHEAT_TEXELS + 2 * WHEAT_MARGIN;

/** Ten rows to a pass, a plant every fortieth of a tile along each; the
 *  tramlines a hair either side of these, across the pass; how deep the
 *  shade gets down among the plants, and how hard the slopes turn the
 *  light. */
const ROWS = 10;
const PLANTS = 48;
const TRAMS = [0.4, 0.6];
const TRAM_WIDE = 0.012;
const SHADE = 18;
const SLOPE = 3;
const STEEP = 1;

const n = WHEAT_TEXELS;

let seed = 1;
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

const f = (x: number) => x.toFixed(5);

/** Value noise of a cell `size` texels wide, wrapping round the square;
 *  and the earth of a stage at a texel of it, its height (in tiles) and
 *  how light it is: ploughed, four furrow slices a pass, broad and
 *  rounded, a narrow furrow between each and the next, the same whichever
 *  way the tractor went, clods all over; or ridged along the rows, less
 *  once harrowed, the tramlines pressed in, crumbled all over. */
const noise = (size: number) => `noise(p, ${size}, ${Math.max(1, Math.round(n / size))})`;
const EARTH = `fn corner(c: vec2i, cells: i32, size: i32) -> f32 {
  let w = vec2u(((c % cells) + cells) % cells);
  var h = (w.x * 0x27d4eb2du) ^ (w.y * 0x165667b1u) ^ (u32(size) * 0x9e3779b9u);
  h = (h ^ (h >> 15u)) * 0x85ebca6bu;
  h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
  return f32(h ^ (h >> 16u)) / 4294967296.;
}
fn noise(p: vec2f, size: i32, cells: i32) -> f32 {
  let at = p / f32(size);
  let i = vec2i(floor(at));
  let t = fract(at);
  let s = t * t * (3. - 2. * t);
  return mix(mix(corner(i, cells, size), corner(i + vec2i(1, 0), cells, size), s.x), mix(corner(i + vec2i(0, 1), cells, size), corner(i + vec2i(1, 1), cells, size), s.x), s.y);
}
fn tram(x: f32) -> bool { return ${TRAMS.map((t) => `abs(x / ${n}. - ${f(t)}) < ${f(TRAM_WIDE)}`).join(" || ")}; }
fn earth(stage: i32, p: vec2f) -> vec2f {
  let tone = 0.9 + 0.1 * ${noise(5)};
  if (stage == 0) { return vec2f(0.025 * (1. - pow(abs(2. * fract(p.x / ${n}. * 4.) - 1.), 3.)) + 0.008 * ${noise(10)} + 0.004 * ${noise(4)}, tone); }
  let row = 1. - abs(fract(p.x / ${n}. * ${ROWS}.) - 0.5) * 2.;
  return vec2f(select(0.006, 0.004, stage == ${WHEAT_STAGES - 1}) * row - select(0., 0.005, tram(p.x)) + 0.003 * ${noise(8)} + 0.0015 * ${noise(3)}, tone);
}`;

/** A stroke of a plant, of a stage: from (x, y), `long` texels its way,
 *  `wide` at its foot, narrowing to its tip, `round` if an ear; from
 *  height h0 at its foot to h1 at its tip, this light. Twelve numbers,
 *  and again wherever it comes round the square's edge. */
function stroke(out: number[], stage: number, x: number, y: number, angle: number, long: number, wide: number, h0: number, h1: number, tone: number, round = false) {
  const reach = long + wide + 1;
  for (const px of [x - n, x, x + n]) {
    for (const py of [y - n, y, y + n]) {
      if (px > -reach && px < n + reach && py > -reach && py < n + reach) out.push(px, py, Math.cos(angle), Math.sin(angle), long, wide, h0, h1, tone, round ? 1 : 0, stage, 0);
    }
  }
}

/** A stroke laid: over the earth where it stands higher, never in a
 *  tramline, nor out of its stage's square. */
const STROKES = `${SHAPE_READ}
${EARTH}
struct Stroke { at: vec2f, way: vec2f, long: f32, wide: f32, foot: f32, tip: f32, tone: f32, ear: bool, stage: f32 }
fn stroke(i: u32) -> Stroke {
  let s = shapeRead(i);
  return Stroke(s[0].xy, s[0].zw, s[1].x, s[1].y, s[1].z, s[1].w, s[2].x, s[2].y > 0.5, s[2].z);
}
fn box(i: u32) -> vec4f {
  let s = stroke(i);
  let start = s.at + vec2f(0., s.stage * ${n}.);
  let reach = s.wide + 1.;
  return vec4f(floor(min(start, start + s.way * s.long) - reach), ceil(max(start, start + s.way * s.long) + reach));
}
fn stamp(i: u32, at: vec2f) -> vec4f {
  let s = stroke(i);
  let p = at - vec2f(0., s.stage * ${n}.);
  let r = p - s.at;
  let t = dot(r, s.way) / s.long;
  let side = abs(r.y * s.way.x - r.x * s.way.y);
  let w = select(s.wide * (1. - 0.7 * t), s.wide * sqrt(max(0., 1. - (2. * t - 1.) * (2. * t - 1.))), s.ear);
  if (p.y < 0. || p.y >= ${n}. || t < 0. || t > 1. || side >= w || tram(floor(p.x))) { return vec4f(-2.); }
  let across = side / w;
  let h = mix(s.foot, s.tip, t) + select(0.002, 0.0015, s.ear) * (1. - across * across);
  if (h <= earth(i32(s.stage), floor(p)).x) { return vec4f(-2.); }
  return vec4f(h, s.tone * select(0.88 + 0.12 * (1. - across), 0.9 + 0.1 * (1. - across * across), s.ear), 0., 0.);
}`;

/** Where each plant stands, the same in every stage: a row, and a spot
 *  along it, a little off its line. */
const plants = (() => {
  seed = 11;
  const out: { x: number; y: number; r: number[] }[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let p = 0; p < PLANTS; p++) {
      const r = Array.from({ length: 96 }, random);
      out.push({ x: ((row + 0.5) / ROWS) * n + (r[0] - 0.5) * 6, y: ((p + 0.5) / PLANTS) * n + (r[1] - 0.5) * 6, r });
    }
  }
  return out;
})();

const ALONG = Math.PI / 2;
const either = (r: number) => (r < 0.5 ? 0 : Math.PI);

/** A tuft: this many blades, this long, leaning out from along the row as
 *  far as this, from this high at the foot to that at the tips. */
function tuft(out: number[], stage: number, p: (typeof plants)[number], blades: number, long: [number, number], wide: number, lean: number, h0: number, h1: number, tone: number) {
  for (let b = 0; b < blades; b++) {
    const r = p.r.slice(2 + b * 3, 5 + b * 3).concat(p.r[90 - b]);
    const angle = ALONG + either(r[0]) + (r[1] - 0.5) * 2 * lean;
    stroke(out, stage, p.x, p.y, angle, long[0] + (long[1] - long[0]) * r[2], wide, h0, h1, tone * (0.85 + 0.25 * r[3]));
  }
}

/**
 * Its ears: this many, each anywhere over the field, not by its own row,
 * since over a closed crop the ears lean every way and hide the rows;
 * nodding every way, each this long and wide. An ear is its spikelets on
 * a body, grains in pairs either side of its stem one over the next,
 * tipped out a little, the top ones smaller; and from each, an awn, a
 * whisker on along the ear and past its tip, thin and pale, under the
 * grains.
 */
function ears(out: number[], stage: number, p: (typeof plants)[number], count: number, long: number, wide: number, h: number, tone: number, awns: number) {
  for (let e = 0; e < count; e++) {
    const r = p.r.slice(36 + e * 4, 40 + e * 4);
    const [angle, l] = [r[2] * Math.PI * 2, long * (0.85 + 0.3 * r[3])];
    const [dx, dy] = [Math.cos(angle), Math.sin(angle)];
    const [ex, ey] = [r[0] * n - dx * l * 0.5, r[1] * n - dy * l * 0.5];
    const top = h + 0.004 * (r[3] - 0.5);
    const spikelets = Math.max(4, Math.round(l / (wide * 0.75)));
    stroke(out, stage, ex, ey, angle, l, wide * 0.55, top - 0.001, top - 0.001, tone * 0.95, true);
    for (let j = 0; j < spikelets; j++) {
      const t = (j + 0.5) / spikelets;
      const side = j % 2 ? 1 : -1;
      const small = 1 - 0.35 * t * t;
      const [cx, cy] = [ex + dx * l * t - dy * side * wide * 0.25, ey + dy * l * t + dx * side * wide * 0.25];
      const tip = angle + side * 0.45;
      if (awns && t > 0.4) stroke(out, stage, cx, cy, angle + side * 0.15 * (1 + t), awns * t, 1.2, top - 0.002, top - 0.006, tone * 1.05);
      stroke(out, stage, cx - Math.cos(tip) * wide * 0.45, cy - Math.sin(tip) * wide * 0.45, tip, wide * 0.9 * small, wide * 0.42 * small, top, top, tone * (0.92 + 0.12 * ((j * 7 + e) % 3) / 2), true);
    }
  }
}

/** Every stage's strokes: none ploughed or drilled. */
function strokes(): Float32Array {
  const out: number[] = [];
  for (const p of plants) {
    tuft(out, 2, p, 2 + Math.round(p.r[63]), [12, 20], 3.2, 0.5, 0.008, 0.006, 1.15);
    tuft(out, 3, p, 9, [24, 44], 3, 1.3, 0.04, 0.02, 0.9);
    for (const [stage, ripe] of [[4, false], [5, true]] as const) {
      tuft(out, stage, p, 9, [24, 44], 3, 1.3, 0.05, 0.03, ripe ? 0.55 : 0.8);
      ears(out, stage, p, ripe ? 14 : 12, ripe ? 9 : 8, ripe ? 5.2 : 4.6, 0.075, ripe ? 1.15 : 1.05, ripe ? 4 : 0);
    }
    // Stubble: the harrowed ground, a short stalk or two where each
    // plant stood, cut off square.
    const stalks = 2 + Math.floor(p.r[62] * 3);
    for (let b = 0; b < stalks; b++) {
      const r = p.r.slice(20 + b * 4, 24 + b * 4);
      stroke(out, 6, p.x + (r[0] - 0.5) * 10, p.y + (r[1] - 0.5) * 10, r[2] * Math.PI * 2, 4 + 4 * r[3], 2.6, 0.012, 0.008, 1);
    }
  }
  return new Float32Array(out);
}

/** A stage's field at each texel: its height, how light it is of
 *  itself, and whether it is crop or earth. */
const FIELD = `${EARTH}
fn fill(at: vec2f) -> vec4f {
  let p = vec2i(at);
  let laid = textureLoad(src0, p, 0);
  if (laid.r > -0.5) { return vec4f(laid.rg, 1., 0.); }
  return vec4f(earth(p.y / ${n}, vec2f(vec2i(p.x, p.y % ${n}))), 0., 0.);
}`;
/** What is round about each texel, on the whole: a box this wide each
 *  way, across here, along there. Below it, in shade. */
const ROUND = 6;
const READ = `fn wrap(i: i32) -> i32 { return ((i % ${n}) + ${n}) % ${n}; }
fn high(stage: i32, x: i32, y: i32) -> vec4f { return textureLoad(src0, vec2i(wrap(x), stage * ${n} + wrap(y)), 0); }`;
const ACROSS = `${READ}
fn fill(at: vec2f) -> vec4f {
  let p = vec2i(at);
  var sum = 0.;
  for (var d = ${-ROUND}; d <= ${ROUND}; d++) { sum += high(p.y / ${n}, p.x + d, p.y % ${n}).r; }
  return vec4f(sum / ${2 * ROUND + 1}.);
}`;
/** Every stage, stacked: each texel's facing across and along (red,
 *  green, -1 to 1 as 0 to 1), how light (blue: its own tone, darker down
 *  among the plants), and whether crop or earth (alpha). Facing from the
 *  slope, a cliff a texel high no steeper than a bank, so the edge of
 *  every grain does not turn it dark. */
const WHEAT = `${READ}
fn fill(at: vec2f) -> vec4f {
  let p = vec2i(at);
  let stage = p.y / ${WHEAT_STRIDE};
  let y = p.y % ${WHEAT_STRIDE} - ${WHEAT_MARGIN};
  let here = high(stage, p.x, y);
  var around = 0.;
  for (var d = ${-ROUND}; d <= ${ROUND}; d++) { around += textureLoad(src1, vec2i(p.x, stage * ${n} + wrap(y + d)), 0).r; }
  let slope = vec2f(high(stage, p.x + 1, y).r - high(stage, p.x - 1, y).r, high(stage, p.x, y + 1).r - high(stage, p.x, y - 1).r) * ${f(n * 0.5 * SLOPE)};
  let eased = slope * min(1., ${f(STEEP)} / max(length(slope), 1e-6));
  let shade = clamp(1. - (around / ${2 * ROUND + 1}. - here.r) * ${f(SHADE)}, 0.35, 1.);
  return vec4f(0.5 - eased / length(vec3f(eased, 1.)) * 0.5, min(1., here.g * shade / 1.25), here.b);
}`;

/** An engine's wheat, drawn once. */
export const wheat = drawnOnce("wheat", (engine: EngineContext): Texture2D => {
  const texture = createFilledTexture(engine, n, WHEAT_STRIDE * WHEAT_STAGES, "rgba8unorm", true);
  const numbers = strokes();
  const shapes = shapesTexture(engine, numbers);
  const [laid, field, across] = [createFilledTexture(engine, n, n * WHEAT_STAGES, "rgba32float"), createFilledTexture(engine, n, n * WHEAT_STAGES, "rgba32float"), createFilledTexture(engine, n, n * WHEAT_STAGES, "r32float")];
  layTexture(engine, laid, STROKES, numbers.length / 12, [shapes], [-1, 0, 0, 0]);
  fillTexture(engine, field, FIELD, [laid]);
  fillTexture(engine, across, ACROSS, [field]);
  fillTexture(engine, texture, WHEAT, [field, across]);
  for (const t of [shapes, laid, field, across]) releaseTexture(t);
  return texture;
});
