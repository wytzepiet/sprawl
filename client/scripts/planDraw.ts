/**
 * A fixture's town drawn flat, layer on layer as the sandbox lays its
 * meshes (`src/sandbox/Sandbox.tsx`), from the same code: the ground, the
 * pavement, the roads, the dressing, the buildings and their roofs' edges.
 * As SVG (`plan.ts` is the command), and as the shapes the GPU's UI draws
 * (the build menu's pictures, `src/ui/Build.tsx`).
 */
import type { BuildingKind } from "../src/generated";
import { parseTown, type Tile } from "../src/engine/town/grid";
import { intersect, soften, unite, type Polygon, type Pt } from "../src/engine/town/footprint";
import { facts } from "../src/engine/town/facts";
import { dress } from "../src/engine/town/dressing";
import { asphalt, pavement } from "../src/engine/town/surface";
import { plans, roofFaces } from "../src/engine/town/roof";
import { slope } from "../src/engine/town/mass";
import { CAB, CAR, TRAILER } from "../src/engine/objects/roadGeometry";
import { BLUEPRINTS } from "../src/blueprints";
import { themes } from "../src/engine/theme";

const T = themes.light;
const hex = (c: { r: number; g: number; b: number }) =>
  "#" + [c.r, c.g, c.b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
const CARS = ["#e64033", "#d9d9e0", "#333847", "#4066bf", "#a6a6ad", "#8c2626", "#338066", "#cca640"];

type Traced = { points: Pt[]; tight: Pt[]; strobe: Pt[][] }[];
type Options = { crop?: [number, number, number, number]; px: number; paths?: Traced };

/** A shape the GPU's UI draws: its outline, its colour, and its line's
 *  width if it is drawn as a line. */
export interface Shape {
  d: string;
  ink: string;
  stroke?: number;
}

/** The plan as SVG. */
export const planSvg = (text: string, options: Options): string => plan(text, options).svg;
/** The plan as shapes: what the SVG fills and strokes, but its lines
 *  drawn through points, its outlines and its words. */
export const shapes = (text: string, options: Options): Shape[] => plan(text, options).shapes;

function plan(text: string, { crop, px, paths }: Options): { svg: string; shapes: Shape[] } {
  const town = parseTown(text);
  const [c0, r0, c1, r1] = crop ?? [0, 0, town.w, town.h];
  const out: string[] = [];
  const shaped: Shape[] = [];
  const f = (v: number) => +v.toFixed(3);
  const d = (poly: Polygon) => poly.map((ring) => "M" + ring.map(([x, y]) => `${f(x)} ${f(y)}`).join("L") + "Z").join("");
  const fill = (polys: Polygon[], colour: string, rule = "evenodd") => {
    if (!polys.length) return;
    out.push(`<path fill="${colour}" fill-rule="${rule}" d="${polys.map(d).join("")}"/>`);
    shaped.push({ d: polys.map(d).join(""), ink: colour });
  };
  /** Edges alone: a roof's faces'. */
  const edges = (polys: Polygon[], colour: string, opacity: number, w: number) => {
    if (!polys.length) return;
    out.push(`<path fill="none" stroke="${colour}" stroke-opacity="${opacity}" stroke-width="${w}" d="${polys.map(d).join("")}"/>`);
    shaped.push({ d: polys.map(d).join(""), ink: `${colour}/${opacity}`, stroke: w });
  };
  const line = (pts: Pt[], colour: string, w: number) =>
    out.push(`<polyline fill="none" stroke="${colour}" stroke-width="${w}" points="${pts.map(([x, y]) => `${f(x)},${f(y)}`).join(" ")}"/>`);
  /** A box `l` long along `angle`, `w` wide, its middle at (x, y). */
  const box = (x: number, y: number, angle: number, l: number, w: number, colour: string) => {
    const deg = f((angle * 180) / Math.PI);
    out.push(`<rect x="${f(-l / 2)}" y="${f(-w / 2)}" width="${f(l)}" height="${f(w)}" fill="${colour}" transform="translate(${f(x)} ${f(y)}) rotate(${deg})"/>`);
    const [c, s, tx, ty] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), f(x), f(y)];
    const p = (u: number, v: number) => `${(tx + u * c - v * s).toFixed(3)} ${(ty + u * s + v * c).toFixed(3)}`;
    const [u0, v0, u1, v1] = [f(-l / 2), f(-w / 2), f(-l / 2) + f(l), f(-w / 2) + f(w)];
    shaped.push({ d: `M${p(u0, v0)}L${p(u1, v0)}L${p(u1, v1)}L${p(u0, v1)}Z`, ink: colour });
  };
  /** A disc, at a share of its colour. */
  const disc = (x: number, y: number, r: number, colour: string, share?: number) => {
    out.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${r}" fill="${colour}"${share === undefined ? "" : ` fill-opacity="${share}"`}/>`);
    const p = (u: number) => `${(f(x) + u).toFixed(3)} ${f(y).toFixed(3)}`;
    shaped.push({ d: `M${p(-r)}A${r} ${r} 0 1 0 ${p(r)}A${r} ${r} 0 1 0 ${p(-r)}Z`, ink: share === undefined ? colour : `${colour}/${share}` });
  };
  /** A straight line, at a share of its colour. */
  const segment = (x1: number, y1: number, x2: number, y2: number, colour: string, w: number, share?: number) => {
    out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${colour}"${share === undefined ? "" : ` stroke-opacity="${share}"`} stroke-width="${w}"/>`);
    const p = (x: number, y: number) => `${x.toFixed(3)} ${y.toFixed(3)}`;
    shaped.push({ d: `M${p(x1, y1)}L${p(x2, y2)}`, ink: share === undefined ? colour : `${colour}/${share}`, stroke: w });
  };
  const tiles = (pick: (t: Tile, c: number, r: number) => boolean): Polygon[] => {
    const squares: Polygon[] = [];
    for (let r = 0; r < town.h; r++) for (let c = 0; c < town.w; c++) if (pick(town.tile(c, r), c, r)) squares.push([[[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]]]);
    return squares;
  };

  // The ground: water and woods rounded as the terrain rounds them.
  fill(soften(unite(tiles((t) => t.kind === "water")), 0.3), hex(T.water));
  fill(soften(unite(tiles((t) => t.kind === "wood")), 0.3), hex(T.forest));

  fill(pavement(town), hex(T.paved));

  const fs = facts(town);
  const dressing = dress(town, fs);

  // The asphalt: roads, drives, yards and bays, one surface, a piece a
  // tile overlapping the next.
  const { street, through } = asphalt(town);
  fill(street, hex(T.road), "nonzero");
  fill(through, hex(T.highway), "nonzero");

  // What stands on the ground: yard lines, lorries at docks, parked
  // cars.
  fill(dressing.yardLines.map((r) => [r]), "#b8b2a0");
  for (const car of dressing.cars) box(car.x, car.y, car.angle, CAR.l, CAR.w, CARS[car.colour]);
  for (const dock of dressing.docks) {
    const [ux, uy] = [Math.cos(dock.angle), Math.sin(dock.angle)];
    line([[dock.x - uy * 0.11, dock.y + ux * 0.11], [dock.x + uy * 0.11, dock.y - ux * 0.11]], "#383d4d", 0.03);
    if (!dock.lorry) continue;
    const trailer = 0.01 + TRAILER.l / 2, cab = 0.01 + TRAILER.l + 0.02 + CAB.l / 2;
    box(dock.x + ux * trailer, dock.y + uy * trailer, dock.angle, TRAILER.l, TRAILER.w, "#e6e6e0");
    box(dock.x + ux * cab, dock.y + uy * cab, dock.angle, CAB.l, CAB.w, "#475c94");
  }

  // The buildings: each part its kind's colour; the roof's
  // faces' edges, ridges and hips, thin and light.
  for (const { mass, polygon, outline } of plans(fs)) {
    for (const part of mass.parts) {
      const base = BLUEPRINTS[part.tile.kind as BuildingKind]?.color ?? "#888888";
      const rgb = [1, 3, 5].map((k) => parseInt(base.slice(k, k + 2), 16) / 255);
      fill(mass.parts.length === 1 ? outline : intersect(part.polygons, outline), hex({ r: rgb[0], g: rgb[1], b: rgb[2] }));
    }
    const { pitch, height } = slope(mass.tile);
    if (height > 0) for (const face of roofFaces(polygon, height / pitch)) edges(face.region, "#ffffff", 0.55, 0.02);
  }

  // The street lamps: the pool each throws, its arm and its head.
  for (const l of dressing.lamps) {
    disc(l.hx, l.hy, 0.9, "#ffb347", 0.18);
    segment(f(l.x), f(l.y), f(l.hx), f(l.hy), "#333", 0.03);
    disc(l.hx, l.hy, 0.05, "#ffa000");
  }
  for (const t of dressing.trees) disc(t.x, t.y, f(0.2 * t.scale), hex(T.crowns[t.shade]));

  // Vehicles' paths, in the game's tiles: a column on is a tile less of x.
  const origin = text.match(/^# origin (-?\d+),(-?\d+)/m)?.slice(1).map(Number);
  if (origin && paths) {
    const map = ([x, y]: Pt): Pt => [origin[0] + 1 - x, origin[1] + 1 - y];
    for (const p of paths) line(p.points.map(map), "#3a5bd9", 0.015);
    for (const p of paths) for (const b of p.strobe) out.push(`<polygon points="${b.map(map).map(([x, y]) => `${f(x)},${f(y)}`).join(" ")}" fill="#3a5bd9" fill-opacity="0.12" stroke="#3a5bd9" stroke-width="0.008"/>`);
    for (const p of paths) for (const t of p.tight.map(map)) out.push(`<circle cx="${f(t[0])}" cy="${f(t[1])}" r="0.035" fill="#e0301e"/>`);
  }

  // The grid, faint, every fifth tile's edge darker and the tile numbered:
  // in the fixture's columns and rows, or for the game's map (`/map`), in
  // the game's own tiles, a column on being a tile less of x.
  const nameC = (c: number) => (origin ? origin[0] - c : c), nameR = (r: number) => (origin ? origin[1] - r : r);
  const fifth = (n: number) => ((n % 5) + 5) % 5 === 0;
  for (let c = c0; c <= c1; c++) segment(c, r0, c, r1, "#000", 0.02, fifth(nameC(c)) ? 0.18 : 0.06);
  for (let r = r0; r <= r1; r++) segment(c0, r, c1, r, "#000", 0.02, fifth(nameR(r)) ? 0.18 : 0.06);
  for (let c = c0 + 1; c < c1; c++) if (fifth(nameC(c))) out.push(`<text x="${c + 0.08}" y="${r0 + 0.35}" font-size="0.3" fill="#000" fill-opacity="0.5">${nameC(c)}</text>`);
  for (let r = r0 + 1; r < r1; r++) if (fifth(nameR(r))) out.push(`<text x="${c0 + 0.08}" y="${r + 0.35}" font-size="0.3" fill="#000" fill-opacity="0.5">${nameR(r)}</text>`);

  // The land under it all.
  const [w, h] = [c1 - c0, r1 - r0];
  const p = (x: number, y: number) => `${x.toFixed(3)} ${y.toFixed(3)}`;
  shaped.unshift({ d: `M${p(c0, r0)}L${p(c0 + w, r0)}L${p(c0 + w, r0 + h)}L${p(c0, r0 + h)}Z`, ink: hex(T.land) });
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w * px}" height="${h * px}" viewBox="${c0} ${r0} ${w} ${h}" font-family="system-ui"><rect x="${c0}" y="${r0}" width="${w}" height="${h}" fill="${hex(T.land)}"/>${out.join("")}</svg>\n`,
    shapes: shaped,
  };
}
