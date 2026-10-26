import { createGlyphStorage, extractGlyphCurves, loadFont, updateGlyphStorage, type Font, type GlyphCurves, type QuadCurve } from "@babylonjs/lite";
import { layoutText } from "@babylonjs/lite/src/text/layout";
import { dirt } from "./node";

/**
 * Every shape the UI draws with curves, letters and icons alike, in one
 * of Lite's glyph atlases (Slug: outlines on the GPU, sharp at any size),
 * so one draw holds them all. A letter's id is its face's and its own; an
 * icon's is its path's.
 */
export const storage = createGlyphStorage();
const SET = "ui";

/** The faces: Inter at three weights for words, and Nunito, rounded, for numbers and titles (`serif`). */
export type Face = 0 | 1 | 2 | 3;
const FILES = ["Inter-500", "Inter-600", "Inter-700", "Nunito-700"];
const fonts: (Font | null)[] = [null, null, null, null];
export const faceOf = (weight = 500, serif = false): Face => (serif ? 3 : weight >= 700 ? 2 : weight >= 600 ? 1 : 0);
export const ready = () => fonts.every(Boolean);
Promise.all(FILES.map((f) => loadFont(`/fonts/${f}.ttf`))).then((loaded) => {
  loaded.forEach((f, i) => (fonts[i] = f));
  dirt.layout++;
});

/** A glyph's place in the atlas, or -1 for one with no outline (a space). */
const slots = new Map<number, number>();
type Atlas = { _glyphSlots: Map<number, { _index: number }> };
export const atlas = () => (storage as unknown as { _curveSets: Map<string, { _atlas: Atlas }> })._curveSets.get(SET)?._atlas;

function slotOf(id: number, make: () => GlyphCurves | null): number {
  let s = slots.get(id);
  if (s !== undefined) return s;
  const g = make();
  if (g) updateGlyphStorage(storage, SET, new Map([[id, { glyphId: id, curves: g.curves, bounds: g.bounds }]]));
  s = g ? atlas()!._glyphSlots.get(id)!._index : -1;
  slots.set(id, s);
  return s;
}

/** A letter of a face, as a slot. */
function letter(face: Face, gid: number) {
  return slotOf(face * 100_000 + gid, () => {
    const out = new Map<number, GlyphCurves>();
    extractGlyphCurves(fonts[face]!, new Set([gid]), out);
    return out.get(gid) ?? null;
  });
}

/** One word shaped: its letters' slots and where each starts, and how wide it is, at 1 px. */
interface Word {
  slots: number[];
  xs: number[];
  width: number;
  /** Font units to pixels, at 1 px. */
  unit: number;
}
const words = new Map<string, Word>();
function word(face: Face, text: string): Word {
  const key = `${face}|${text}`;
  let w = words.get(key);
  if (w) return w;
  const out = layoutText(fonts[face]!, text, 1);
  w = { slots: out._glyphs.map((g) => letter(face, g.glyphId)), xs: out._glyphs.map((g) => g.x), width: out._width, unit: out._pixelsPerFontUnit };
  words.set(key, w);
  return w;
}
const spaces: number[] = [];
const space = (face: Face) => (spaces[face] ??= word(face, "x x").width - 2 * word(face, "x").width);

/** How far a face reaches above and below its baseline, at 1 px. */
function reach(face: Face) {
  const f = (fonts[face] as unknown as { _font: { ascender: number; descender: number; unitsPerEm: number } })._font;
  return { up: f.ascender / f.unitsPerEm, down: -f.descender / f.unitsPerEm };
}

/** A stretch of text in one style. */
export interface Run {
  text: string;
  face: Face;
  size: number;
  /** Its colour, read when it is drawn. */
  ink: string;
}

/** A glyph placed: its slot, where its baseline starts, its scale, its ink. */
export interface Placed {
  slot: number;
  x: number;
  y: number;
  unit: number;
  ink: string;
}

/** Text laid out at a width: its glyphs, and how big it came out. */
export interface Laid {
  glyphs: Placed[];
  w: number;
  h: number;
}

/**
 * Runs set in lines no wider than `width`, broken between words; with
 * `lines`, no more lines than that, the last cut short with an ellipsis.
 * Each line is as tall as `lead` times its biggest size, its baseline
 * placed as CSS places it: half the leading above and half below.
 */
export function setText(runs: Run[], width: number, lead: number, lines = Infinity): Laid {
  if (!ready()) return { glyphs: [], w: 0, h: 0 };
  type Piece = { run: Run; w: Word; gap: number };
  const pieces: Piece[] = [];
  let gap = 0;
  for (const run of runs) {
    for (const part of run.text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        gap += space(run.face) * run.size;
        continue;
      }
      pieces.push({ run, w: word(run.face, part), gap: pieces.length ? gap : 0 });
      gap = 0;
    }
  }
  const rows: Piece[][] = [[]];
  let x = 0;
  for (const p of pieces) {
    const row = rows[rows.length - 1];
    const wide = p.w.width * p.run.size;
    if (row.length && x + p.gap + wide > width && rows.length < lines) {
      rows.push([p]);
      x = wide;
    } else {
      row.push(p);
      x += p.gap + wide;
    }
  }
  const glyphs: Placed[] = [];
  let top = 0;
  let widest = 0;
  rows.forEach((row, i) => {
    const size = Math.max(...row.map((p) => p.run.size), runs[0]?.size ?? 0);
    const big = row.find((p) => p.run.size === size)?.run.face ?? runs[0]?.face ?? 0;
    const { up, down } = reach(big);
    const lh = size * lead;
    const base = top + (lh - (up + down) * size) / 2 + up * size;
    const cut = i === rows.length - 1 && i === lines - 1;
    const line: Placed[] = [];
    let at = 0;
    for (const p of row) {
      if (p !== row[0]) at += p.gap;
      p.w.slots.forEach((slot, k) => line.push({ slot, x: at + p.w.xs[k] * p.run.size, y: base, unit: p.w.unit * p.run.size, ink: p.run.ink }));
      at += p.w.width * p.run.size;
    }
    if (cut && at > width) {
      const last = row[row.length - 1].run;
      const dots = word(last.face, "…");
      const room = width - dots.width * last.size;
      const ends = line.map((g, k) => (k + 1 < line.length ? line[k + 1].x : at));
      let keep = ends.findIndex((e) => e > room);
      if (keep < 0) keep = line.length;
      line.length = keep;
      at = keep ? ends[keep - 1] : 0;
      dots.slots.forEach((slot, k) => line.push({ slot, x: at + dots.xs[k] * last.size, y: base, unit: dots.unit * last.size, ink: last.ink }));
      at += dots.width * last.size;
    }
    for (const g of line) if (g.slot >= 0) glyphs.push(g);
    widest = Math.max(widest, at);
    top += lh;
  });
  return { glyphs, w: widest, h: top };
}

// Icons: an SVG path, flattened into lines, filled or drawn as a stroke.

const SCALE = 100;
const icons = new Map<string, number>();

/** An icon's slot: the path filled (nonzero, every outline wound to match
 *  how deep it lies inside the others, so an even-odd path fills right),
 *  or each of its lines thickened into a ribbon with round ends. */
export function icon(d: string, stroke: number | undefined, view: number): number {
  const key = `${d}|${stroke ?? ""}|${view}`;
  let id = icons.get(key);
  if (id === undefined) icons.set(key, (id = 1_000_000 + icons.size));
  return slotOf(id, () => {
    const lines = flatten(d).map((l) => l.map(([x, y]) => [x * SCALE, (view - y) * SCALE] as Pt));
    const shapes = stroke ? lines.flatMap((l) => ribbon(l, (stroke * SCALE) / 2)) : wind(lines.filter((l) => l.length > 2));
    const curves: QuadCurve[] = [];
    for (const s of shapes)
      s.forEach((a, i) => {
        const b = s[(i + 1) % s.length];
        if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 0.2) return;
        curves.push({ p0x: a[0], p0y: a[1], p1x: (a[0] + b[0]) / 2, p1y: (a[1] + b[1]) / 2, p2x: b[0], p2y: b[1] });
      });
    if (!curves.length) return null;
    const xs = curves.flatMap((c) => [c.p0x, c.p2x]);
    const ys = curves.flatMap((c) => [c.p0y, c.p2y]);
    return { glyphId: id!, curves, bounds: { xMin: Math.min(...xs), yMin: Math.min(...ys), xMax: Math.max(...xs), yMax: Math.max(...ys) } };
  });
}
export const ICON_UNIT = 1 / SCALE;

type Pt = [number, number];
const area = (l: Pt[]) => l.reduce((a, p, i) => a + p[0] * l[(i + 1) % l.length][1] - l[(i + 1) % l.length][0] * p[1], 0) / 2;
function inside([x, y]: Pt, l: Pt[]) {
  let c = false;
  for (let i = 0, j = l.length - 1; i < l.length; j = i++)
    if (l[i][1] > y !== l[j][1] > y && x < ((l[j][0] - l[i][0]) * (y - l[i][1])) / (l[j][1] - l[i][1]) + l[i][0]) c = !c;
  return c;
}
function wind(ls: Pt[][]) {
  return ls.map((l) => {
    const depth = ls.filter((o) => o !== l && inside(l[0], o)).length;
    return area(l) > 0 === (depth % 2 === 0) ? l : [...l].reverse();
  });
}

/** A circle, wound counter-clockwise. */
const disc = ([x, y]: Pt, r: number): Pt[] => Array.from({ length: 16 }, (_, i) => [x + r * Math.cos((i / 16) * Math.PI * 2), y + r * Math.sin((i / 16) * Math.PI * 2)]);
function ribbon(l: Pt[], r: number): Pt[][] {
  const out: Pt[][] = l.map((p) => disc(p, r));
  for (let i = 0; i + 1 < l.length; i++) {
    const [a, b] = [l[i], l[i + 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const [nx, ny] = [(-(b[1] - a[1]) / len) * r, ((b[0] - a[0]) / len) * r];
    out.push([[a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]]);
  }
  return out;
}

/** An SVG path as lines: M L H V C S Q T A Z, absolute and relative. */
function flatten(d: string): Pt[][] {
  const toks = d.match(/[a-zA-Z]|-?(?:\d*\.\d+|\d+)(?:e-?\d+)?/g) ?? [];
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  let [x, y, sx, sy] = [0, 0, 0, 0];
  let cmd = "";
  let ctrl: Pt | null = null;
  let i = 0;
  const num = () => Number(toks[i++]);
  const curve = (f: (t: number) => Pt, n = 12) => {
    for (let k = 1; k <= n; k++) cur.push(f(k / n));
  };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const [ox, oy] = rel ? [x, y] : [0, 0];
    switch (cmd.toUpperCase()) {
      case "M":
        if (cur.length) out.push(cur);
        [x, y] = [ox + num(), oy + num()];
        [sx, sy] = [x, y];
        cur = [[x, y]];
        cmd = rel ? "l" : "L";
        ctrl = null;
        continue;
      case "L":
        [x, y] = [ox + num(), oy + num()];
        break;
      case "H":
        x = ox + num();
        break;
      case "V":
        y = oy + num();
        break;
      case "C":
      case "S": {
        const c1: Pt = cmd.toUpperCase() === "C" ? [ox + num(), oy + num()] : ctrl ? [2 * x - ctrl[0], 2 * y - ctrl[1]] : [x, y];
        const c2: Pt = [ox + num(), oy + num()];
        const e: Pt = [ox + num(), oy + num()];
        const s: Pt = [x, y];
        curve((t) => {
          const u = 1 - t;
          return [u * u * u * s[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * e[0], u * u * u * s[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * e[1]];
        });
        [x, y] = e;
        ctrl = c2;
        continue;
      }
      case "Q":
      case "T": {
        const c: Pt = cmd.toUpperCase() === "Q" ? [ox + num(), oy + num()] : ctrl ? [2 * x - ctrl[0], 2 * y - ctrl[1]] : [x, y];
        const e: Pt = [ox + num(), oy + num()];
        const s: Pt = [x, y];
        curve((t) => [(1 - t) ** 2 * s[0] + 2 * (1 - t) * t * c[0] + t * t * e[0], (1 - t) ** 2 * s[1] + 2 * (1 - t) * t * c[1] + t * t * e[1]]);
        [x, y] = e;
        ctrl = c;
        continue;
      }
      case "A": {
        const [rx0, ry0, rot, large, sweep] = [num(), num(), num(), num(), num()];
        const e: Pt = [ox + num(), oy + num()];
        arc([x, y], e, Math.abs(rx0), Math.abs(ry0), (rot * Math.PI) / 180, !!large, !!sweep).forEach((p) => cur.push(p));
        [x, y] = e;
        ctrl = null;
        continue;
      }
      case "Z":
        [x, y] = [sx, sy];
        cur.push([x, y]);
        if (cur.length) out.push(cur);
        cur = [];
        ctrl = null;
        continue;
    }
    cur.push([x, y]);
    ctrl = null;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** An SVG arc's points, by its centre (SVG 1.1, appendix F.6). */
function arc([x1, y1]: Pt, [x2, y2]: Pt, rx: number, ry: number, phi: number, large: boolean, sweep: boolean): Pt[] {
  if (!rx || !ry) return [[x2, y2]];
  const [c, s] = [Math.cos(phi), Math.sin(phi)];
  const [dx, dy] = [(x1 - x2) / 2, (y1 - y2) / 2];
  const [px, py] = [c * dx + s * dy, -s * dx + c * dy];
  const k = (px * px) / (rx * rx) + (py * py) / (ry * ry);
  if (k > 1) [rx, ry] = [rx * Math.sqrt(k), ry * Math.sqrt(k)];
  const num = rx * rx * ry * ry - rx * rx * py * py - ry * ry * px * px;
  const f = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / (rx * rx * py * py + ry * ry * px * px)));
  const [cx1, cy1] = [(f * rx * py) / ry, (-f * ry * px) / rx];
  const [cx, cy] = [c * cx1 - s * cy1 + (x1 + x2) / 2, s * cx1 + c * cy1 + (y1 + y2) / 2];
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (px - cx1) / rx, (py - cy1) / ry);
  let dt = ang((px - cx1) / rx, (py - cy1) / ry, (-px - cx1) / rx, (-py - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(4, Math.ceil(Math.abs(dt) / (Math.PI / 12)));
  return Array.from({ length: n }, (_, i) => {
    const t = t1 + (dt * (i + 1)) / n;
    const [ex, ey] = [rx * Math.cos(t), ry * Math.sin(t)];
    return [c * ex - s * ey + cx, s * ex + c * ey + cy] as Pt;
  });
}
