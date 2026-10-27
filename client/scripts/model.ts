/**
 * A model drawn on its own, no browser and no GPU: `bun run model farm`
 * draws every model `objects/farm.ts` exports, on its plot with a street
 * before it, twice: as the game's camera sees it, and from a corner,
 * closer, for its details. In a second or so, into `.dev/model/`.
 *
 *   --side -1       its mirror, as every other one stands
 *   --ref <image>   the reference image beside it, to compare
 *   --px 220        pixels to a tile in the game's view
 *   --name <name>   the picture's name
 *
 * A sketch of the light, not the game's: the sun from one side, its
 * shadows, a sky's ambient, and each finish's look roughed in (zinc's
 * waves, tiles' courses, the grass's colour). Proportions, silhouette,
 * what is where and how it reads at the game's zoom are true; how a
 * finish looks in the game is `bun run look`'s.
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdirSync } from "node:fs";
import { args, flag, ROOT, word } from "./lib";
import type { Built, Finish, ModelProp } from "../src/engine/objects/kit";
import { theme } from "../src/engine/theme";
import type { Rgb } from "../src/engine/rgb";

const rgb = ({ r, g, b }: Rgb): V => [r, g, b];

type V = [number, number, number];
const side = flag("--side", 1);
const ref = word("--ref");
const PX = flag("--px", 220);
const name = word("--name");
const [file] = args;
if (!file) throw new Error("bun run model <file in objects/> [--side -1] [--ref image]");
const module = await import(`../src/engine/objects/${file}.ts`);
const models = Object.entries(module).filter((e): e is [string, Built] => !!e[1] && typeof e[1] === "object" && "finishes" in (e[1] as object));
if (!models.length) throw new Error(`${file}.ts exports no model`);

/** The sun, toward it: high, from behind on the right, as the game's
 *  afternoon; shadows fall forward and left. */
const SUN = norm([0.5, -0.32, 0.8]);
const [AMBIENT, DIRECT] = [[0.5, 0.53, 0.6] as V, [0.72, 0.68, 0.6] as V];

function norm(v: number[]): V {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A triangle to draw: its corners, their facings, their colours, their
 *  map, and its finish. */
interface Tri { p: V[]; n: V[]; c: V[]; uv: [number, number][]; finish: Finish | "ground" | "road" | "pavement" | "smoke" | "plot" }

/** Every triangle of a model, mirrored if it stands the other way, and
 *  its plot and the street before it. */
function scene(built: Built): { tris: Tri[]; plot: [number, number, number, number] } {
  const tris: Tri[] = [];
  const m = (v: V): V => [v[0] * side, v[1], v[2]];
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const [finish, s] of Object.entries(built.finishes) as [Finish, NonNullable<Built["finishes"][Finish]>][]) {
    const at = (i: number): V => m([s.positions[i * 3], s.positions[i * 3 + 1], s.positions[i * 3 + 2]]);
    for (let i = 0; i < s.positions.length / 3; i++) {
      const [x, y] = at(i);
      [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    }
    for (let t = 0; t < s.indices.length; t += 3) {
      const ids = [s.indices[t], s.indices[t + 1], s.indices[t + 2]];
      tris.push({
        p: ids.map(at),
        n: ids.map((i) => m([s.normals[i * 3], s.normals[i * 3 + 1], s.normals[i * 3 + 2]])),
        c: ids.map((i): V => [s.colors[i * 4], s.colors[i * 4 + 1], s.colors[i * 4 + 2]]),
        uv: ids.map((i): [number, number] => [s.uvs?.[i * 2] ?? 0, s.uvs?.[i * 2 + 1] ?? 0]),
        finish,
      });
    }
  }
  const plot: [number, number, number, number] = [Math.floor(x0 * 2 + 0.1) / 2, Math.ceil(x1 * 2 - 0.1) / 2, Math.floor(y0 * 2 + 0.1) / 2, Math.ceil(y1 * 2 - 0.1) / 2];
  const quad = (a: number, b: number, c: number, d: number, z: number, rgb: V, finish: Tri["finish"]) => {
    const n: V[] = [[0, 0, 1], [0, 0, 1], [0, 0, 1]];
    tris.push({ p: [[a, c, z], [b, c, z], [b, d, z]], n, c: [rgb, rgb, rgb], uv: [[0, 0], [0, 0], [0, 0]], finish });
    tris.push({ p: [[a, c, z], [b, d, z], [a, d, z]], n, c: [rgb, rgb, rgb], uv: [[0, 0], [0, 0], [0, 0]], finish });
  };
  // The land round it, the pavement and the street before it.
  quad(plot[0] - 2, plot[1] + 2, plot[2] - 2, plot[3], -0.004, [0.5, 0.62, 0.38], "ground");
  quad(plot[0], plot[1], plot[2], plot[3], -0.002, rgb(theme.paved), "plot");
  quad(plot[0] - 2, plot[1] + 2, plot[3], plot[3] + 0.18, 0, rgb(theme.paved), "pavement");
  quad(plot[0] - 2, plot[1] + 2, plot[3] + 0.18, plot[3] + 0.82, -0.01, rgb(theme.road), "road");
  // Its props and trees as the town draws them, roughly.
  const solid = (pts: V[], rgb: V, finish: Tri["finish"] = "matte") => {
    // A box round the points, its six faces.
    const [a, b] = [[0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]))), [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])))];
    const c = (i: number, j: number, k: number): V => [[a[0], b[0]][i], [a[1], b[1]][j], [a[2], b[2]][k]];
    const faces: [V, V, V, V, V][] = [
      [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1), [0, 0, 1]],
      [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1), [0, -1, 0]],
      [c(0, 1, 0), c(1, 1, 0), c(1, 1, 1), c(0, 1, 1), [0, 1, 0]],
      [c(0, 0, 0), c(0, 1, 0), c(0, 1, 1), c(0, 0, 1), [-1, 0, 0]],
      [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1), [1, 0, 0]],
    ];
    for (const [p, q, r, s, n] of faces)
      for (const tri of [[p, q, r], [p, r, s]]) tris.push({ p: tri, n: [n, n, n], c: [rgb, rgb, rgb], uv: [[0, 0], [0, 0], [0, 0]], finish });
  };
  const ball = (o: V, r: V, rgb: V, finish: Tri["finish"] = "leaves") => {
    const [nu, nv] = [14, 8];
    const pt = (i: number, j: number): [V, V] => {
      const [u, v] = [(i / nu) * 2 * Math.PI, (j / nv) * Math.PI];
      const n: V = [Math.sin(v) * Math.cos(u), Math.sin(v) * Math.sin(u), Math.cos(v)];
      return [[o[0] + n[0] * r[0], o[1] + n[1] * r[1], o[2] + n[2] * r[2]], n];
    };
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) {
        const q = [pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)];
        for (const t of [[0, 1, 2], [0, 2, 3]]) tris.push({ p: t.map((k) => q[k][0]), n: t.map((k) => q[k][1]), c: [rgb, rgb, rgb], uv: [[0, 0], [0, 0], [0, 0]], finish });
      }
  };
  const IRON: V = [0.18, 0.2, 0.22];
  for (const p of built.props as ModelProp[]) {
    const [x, y, z] = m(p.at);
    if (p.kind === "lamp") {
      const [tx, ty] = p.to ? [p.to[0] * side, p.to[1]] : [x, y];
      solid([[x - 0.011, y - 0.011, z], [x + 0.011, y + 0.011, z + 0.28]], IRON);
      solid([[Math.min(x, tx), Math.min(y, ty) - 0.006, z + 0.268], [Math.max(x, tx), Math.max(y, ty) + 0.006, z + 0.28]], IRON);
      solid([[tx - 0.03, ty - 0.03, z + 0.255], [tx + 0.03, ty + 0.03, z + 0.272]], [1, 0.86, 0.55], "smoke");
    } else if (p.kind === "smoke") for (let k = 1; k <= 3; k++) ball([x - 0.04 * k, y + 0.02 * k, z + 0.06 * k], [p.size * 0.25 * (0.6 + 0.3 * k), p.size * 0.25 * (0.6 + 0.3 * k), p.size * 0.2 * (0.6 + 0.3 * k)], [0.92, 0.92, 0.92], "smoke");
    else solid([[x - p.size / 2, y - p.size / 2, z], [x + p.size / 2, y + p.size / 2, z + p.high]], [0.7, 0.72, 0.75]);
  }
  for (const [tx, ty, s] of built.trees) {
    const [x, y] = [tx * side, ty];
    solid([[x - 0.015, y - 0.015, 0], [x + 0.015, y + 0.015, 0.25 * s]], [0.36, 0.27, 0.2]);
    ball([x, y, 0.32 * s], [0.3 * s, 0.3 * s, 0.24 * s], rgb(theme.crowns[1]));
  }
  return { tris, plot };
}

/** A camera looking from `tilt` off straight down, turned `yaw` round
 *  from the street side: its right, its up, and toward it. */
function camera(tilt: number, yaw: number): { r: V; u: V; c: V } {
  const [t, y] = [(tilt * Math.PI) / 180, (yaw * Math.PI) / 180];
  const c = norm([-Math.sin(t) * Math.sin(y), Math.sin(t) * Math.cos(y), Math.cos(t)]);
  const r = norm([-Math.cos(y), -Math.sin(y), 0]);
  return { r, u: cross(c, r), c };
}

/** A finish's colour at a point: zinc's waves, tiles' courses, the
 *  grass's mottle, the paving's joints, glass's gloss. */
function look(finish: Tri["finish"], base: V, uv: [number, number], p: V, n: V, view: V): V {
  const k = (s: number): V => [base[0] * s, base[1] * s, base[2] * s];
  const noise = (x: number, y: number) => Math.sin(x * 127.1 + y * 311.7) * 43758.5453 % 1;
  switch (finish) {
    case "zinc": return k(1 - 0.18 * (0.5 - 0.5 * Math.cos(2 * Math.PI * uv[0])));
    case "tiles": {
      const up = uv[0] - Math.floor(uv[0]);
      return k((1 - 0.2 * (1 - Math.min(1, up / 0.3))) * (((uv[1] + 0.5 * Math.floor(uv[0])) % 1 + 1) % 1 > 0.92 ? 0.9 : 1));
    }
    case "glass": {
      const h = norm([SUN[0] + view[0], SUN[1] + view[1], SUN[2] + view[2]]);
      return k(1 + 1.4 * Math.max(0, dot(n, h)) ** 24);
    }
    case "lawn": case "ground": return k(0.94 + 0.12 * Math.abs(noise(Math.floor(p[0] * 60), Math.floor(p[1] * 60))));
    case "earth": case "dust": case "gravel": case "chips": case "rock": return k(0.92 + 0.16 * Math.abs(noise(Math.floor(p[0] * 90), Math.floor(p[1] * 90))));
    case "paving": case "pavement": case "plot": {
      const [a, b] = [p[0] / 0.125 + 0.5 * Math.floor(p[1] / 0.125), p[1] / 0.125];
      const joint = Math.min(a - Math.floor(a), 1 - a + Math.floor(a), b - Math.floor(b), 1 - b + Math.floor(b)) < 0.06;
      return k(joint ? 0.86 : 1);
    }
    case "leaves": return k(0.85 + 0.25 * Math.abs(noise(Math.floor(p[0] * 120 + p[2] * 50), Math.floor(p[1] * 120))));
    default: return base;
  }
}

/** A picture of the scene through a camera, `px` pixels to a tile, round
 *  the plot, drawn twice the size and shrunk. */
function draw(tris: Tri[], plot: [number, number, number, number], cam: ReturnType<typeof camera>, px: number, pad: number) {
  const ss = 2, scale = px * ss;
  // What the camera sees of the plot's box, a little round it.
  const corners: V[] = [];
  for (const x of [plot[0] - pad, plot[1] + pad]) for (const y of [plot[2] - pad, plot[3] + 0.82]) for (const z of [0, 0.8]) corners.push([x, y, z]);
  const sx = corners.map((p) => dot(p, cam.r)), sy = corners.map((p) => dot(p, cam.u));
  const [l, r, b, t] = [Math.min(...sx), Math.max(...sx), Math.min(...sy), Math.max(...sy)];
  const [W, H] = [Math.round((r - l) * scale), Math.round((t - b) * scale)];
  const depth = new Float32Array(W * H).fill(-Infinity);
  const colour = new Float32Array(W * H * 3);
  // The sun's view, for the shadows: as deep as it is from the sun.
  const sr = norm(cross([0, 0, 1], SUN)), su = cross(SUN, sr);
  const all = tris.flatMap((t) => t.p);
  const [ml, mr, mb, mt] = [Math.min(...all.map((p) => dot(p, sr))), Math.max(...all.map((p) => dot(p, sr))), Math.min(...all.map((p) => dot(p, su))), Math.max(...all.map((p) => dot(p, su)))];
  const S = 2048, ss2 = (S - 2) / Math.max(mr - ml, mt - mb);
  const sun = new Float32Array(S * S).fill(-Infinity);
  const raster = (list: Tri[], w: number, h: number, project: (p: V) => [number, number, number], pixel: (i: number, z: number, bary: [number, number, number], tri: Tri) => void) => {
    for (const tri of list) {
      const [a, bb, c] = tri.p.map(project);
      const area = (bb[0] - a[0]) * (c[1] - a[1]) - (bb[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(area) < 1e-9) continue;
      const [x0, x1] = [Math.max(0, Math.floor(Math.min(a[0], bb[0], c[0]))), Math.min(w - 1, Math.ceil(Math.max(a[0], bb[0], c[0])))];
      const [y0, y1] = [Math.max(0, Math.floor(Math.min(a[1], bb[1], c[1]))), Math.min(h - 1, Math.ceil(Math.max(a[1], bb[1], c[1])))];
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const [px, py] = [x + 0.5, y + 0.5];
          const w0 = ((bb[0] - px) * (c[1] - py) - (bb[1] - py) * (c[0] - px)) / area;
          const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          pixel(y * w + x, w0 * a[2] + w1 * bb[2] + w2 * c[2], [w0, w1, w2], tri);
        }
    }
  };
  const toSun = (p: V): [number, number, number] => [(dot(p, sr) - ml) * ss2 + 1, (mt - dot(p, su)) * ss2 + 1, dot(p, SUN)];
  raster(tris.filter((t) => !["ground", "road", "pavement", "smoke", "plot"].includes(t.finish)), S, S, toSun, (i, z) => void (z > sun[i] && (sun[i] = z)));
  const lit = (p: V, n: V) => {
    let sum = 0;
    const [x, y, z] = toSun([p[0] + n[0] * 0.004, p[1] + n[1] * 0.004, p[2] + n[2] * 0.004]);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const i = Math.min(S - 1, Math.max(0, Math.floor(y) + dy)) * S + Math.min(S - 1, Math.max(0, Math.floor(x) + dx));
        sum += z >= sun[i] - 0.006 ? 1 : 0;
      }
    return sum / 9;
  };
  const toScreen = (p: V): [number, number, number] => [(dot(p, cam.r) - l) * scale, (t - dot(p, cam.u)) * scale, dot(p, cam.c)];
  raster(tris, W, H, toScreen, (i, z, [w0, w1, w2], tr) => {
      if (z <= depth[i]) return;
      const mix = (vs: V[]): V => [0, 1, 2].map((k) => vs[0][k] * w0 + vs[1][k] * w1 + vs[2][k] * w2) as V;
      const uv: [number, number] = [tr.uv[0][0] * w0 + tr.uv[1][0] * w1 + tr.uv[2][0] * w2, tr.uv[0][1] * w0 + tr.uv[1][1] * w1 + tr.uv[2][1] * w2];
      // Ground finishes stop at their edge, a little ragged.
      if (["lawn", "paving", "earth", "dust"].includes(tr.finish) && uv[0] < 0.015 * (1 + Math.sin(mix(tr.p)[0] * 90) * Math.sin(mix(tr.p)[1] * 70))) return;
      if ((tr.finish === "gravel" || tr.finish === "chips") && uv[0] > 1.3) return;
      depth[i] = z;
      const p = mix(tr.p);
      let n = norm(mix(tr.n));
      if (dot(n, cam.c) < 0 && tr.finish !== "smoke") n = [-n[0], -n[1], -n[2]];
      const base = look(tr.finish, mix(tr.c), uv, p, n, cam.c);
      const d = Math.max(0, dot(n, SUN)) * (tr.finish === "smoke" ? 1 : lit(p, n));
      const sky = 0.75 + 0.25 * n[2];
      const glow = tr.finish === "smoke" ? 0.35 : 0;
      for (let k = 0; k < 3; k++) colour[i * 3 + k] = base[k] * (AMBIENT[k] * sky + DIRECT[k] * d * 1.15 + glow);
  });
  // Shrunk to size, toned gently.
  const [w, h] = [Math.floor(W / ss), Math.floor(H / ss)];
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let k = 0; k < 3; k++) {
        let s = 0;
        for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) s += colour[((y * ss + j) * W + x * ss + i) * 3 + k];
        const v = s / (ss * ss);
        img.data[(y * w + x) * 4 + k] = Math.round(255 * Math.min(1, v / (1 + v * 0.15)) ** (1 / 1.1));
      }
  for (let i = 0; i < w * h; i++) img.data[i * 4 + 3] = 255;
  ctx.putImageData(img, 0, 0);
  return canvas;
}

mkdirSync(`${ROOT}/.dev/model`, { recursive: true });
for (const [key, built] of models) {
  const t0 = performance.now();
  const { tris, plot } = scene(built);
  const game = draw(tris, plot, camera(25, 0), PX, 0.35);
  const near = draw(tris, plot, camera(52, 32), PX * 1.1, 0.15);
  const reference = ref ? await loadImage(ref) : null;
  const refW = reference ? Math.round((reference.width * game.height) / reference.height) : 0;
  const sheet = createCanvas(refW + game.width + near.width, Math.max(game.height, near.height));
  const ctx = sheet.getContext("2d");
  ctx.fillStyle = "#222";
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  if (reference) ctx.drawImage(reference, 0, 0, refW, game.height);
  ctx.drawImage(game, refW, 0);
  ctx.drawImage(near, refW + game.width, 0);
  const out = `${ROOT}/.dev/model/${name ?? `${file}-${key}`}${side < 0 ? "-left" : ""}.png`;
  await Bun.write(out, await sheet.encode("png"));
  console.log(`${key}: ${tris.length} triangles, ${Math.round(performance.now() - t0)} ms → ${out.slice(ROOT.length + 1)}`);
}
