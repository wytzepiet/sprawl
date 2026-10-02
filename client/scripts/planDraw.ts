/**
 * A fixture's town as a flat SVG, layer on layer as the sandbox lays its
 * meshes (`src/sandbox/Sandbox.tsx`), from the same code: the ground, the
 * pavement, the roads, the dressing, the buildings and their roofs' edges.
 * `plan.ts` is the command.
 */
import type { BuildingKind } from "../src/generated";
import { parseTown, type Tile } from "../src/engine/town/grid";
import { intersect, soften, unite, type Polygon, type Pt } from "../src/engine/town/footprint";
import { facts } from "../src/engine/town/facts";
import { asphalt, dress, FERRY, pavement } from "../src/engine/town/dressing";
import { plans, roofFaces } from "../src/engine/town/roof";
import { capped, slope } from "../src/engine/town/mass";
import { CAB, CAR, TRAILER } from "../src/engine/objects/roadGeometry";
import { BLUEPRINTS } from "../src/blueprints";
import { themes } from "../src/engine/theme";

const T = themes.light;
const hex = (c: { r: number; g: number; b: number }) =>
  "#" + [c.r, c.g, c.b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
const CARS = ["#e64033", "#d9d9e0", "#333847", "#4066bf", "#a6a6ad", "#8c2626", "#338066", "#cca640"];

type Traced = { points: Pt[]; tight: Pt[]; strobe: Pt[][] }[];

export function planSvg(text: string, { crop, px, paths }: { crop?: [number, number, number, number]; px: number; paths?: Traced }): string {
  const town = parseTown(text);
  const [c0, r0, c1, r1] = crop ?? [0, 0, town.w, town.h];
  const out: string[] = [];
  const f = (v: number) => +v.toFixed(3);
  const d = (poly: Polygon) => poly.map((ring) => "M" + ring.map(([x, y]) => `${f(x)} ${f(y)}`).join("L") + "Z").join("");
  const fill = (polys: Polygon[], colour: string, extra = "") =>
    polys.length && out.push(`<path fill-rule="evenodd" fill="${colour}" ${extra} d="${polys.map(d).join("")}"/>`);
  const line = (pts: Pt[], colour: string, w: number) =>
    out.push(`<polyline fill="none" stroke="${colour}" stroke-width="${w}" points="${pts.map(([x, y]) => `${f(x)},${f(y)}`).join(" ")}"/>`);
  /** A box `l` long along `angle`, `w` wide, its middle at (x, y). */
  const box = (x: number, y: number, angle: number, l: number, w: number, colour: string) =>
    out.push(`<rect x="${f(-l / 2)}" y="${f(-w / 2)}" width="${f(l)}" height="${f(w)}" fill="${colour}" transform="translate(${f(x)} ${f(y)}) rotate(${f((angle * 180) / Math.PI)})"/>`);
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
  fill(dressing.gardens.map(([c, r]): Polygon => [[[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]]]), hex(T.garden));

  // The asphalt: roads, and the drives and ramps leading off them, one
  // surface.
  const { street, through } = asphalt(town, dressing.lanes);
  fill(street, hex(T.road));
  fill(through, hex(T.highway));

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
  for (const ship of dressing.ships) {
    box(ship.x, ship.y, ship.angle, FERRY.l, FERRY.w, "#f5f5f2");
    const [ux, uy] = [Math.cos(ship.angle), Math.sin(ship.angle)];
    box(ship.x + ux * 0.4, ship.y + uy * 0.4, ship.angle, FERRY.l * 0.5, FERRY.w * 0.75, "#2b6ba3");
  }

  // The buildings: each part its kind's colour, a head lighter; the roof's
  // faces' edges, ridges and hips, thin and light; an office's cap.
  for (const { mass, polygon, outline } of plans(town)) {
    for (const part of mass.parts) {
      const base = BLUEPRINTS[part.tile.kind as BuildingKind]?.color ?? "#888888";
      const rgb = [1, 3, 5].map((k) => parseInt(base.slice(k, k + 2), 16) / 255).map((v) => (part.head ? v + (1 - v) * 0.45 : v));
      fill(mass.parts.length === 1 ? outline : intersect(part.polygons, outline), hex({ r: rgb[0], g: rgb[1], b: rgb[2] }));
    }
    if (capped(mass.tile)) {
      out.push(`<path fill="#ffffff" fill-opacity="0.25" d="${d(polygon)}"/>`);
    } else {
      const { pitch, height } = slope(mass.tile);
      if (height > 0) for (const face of roofFaces(polygon, height / pitch)) fill(face.region, "none", `stroke="#ffffff" stroke-opacity="0.55" stroke-width="0.02"`);
    }
  }

  for (const t of dressing.trees) out.push(`<circle cx="${f(t.x)}" cy="${f(t.y)}" r="${f(0.2 * t.scale)}" fill="${hex(T.crowns[t.shade])}"/>`);

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
  for (let c = c0; c <= c1; c++) out.push(`<line x1="${c}" y1="${r0}" x2="${c}" y2="${r1}" stroke="#000" stroke-opacity="${fifth(nameC(c)) ? 0.18 : 0.06}" stroke-width="0.02"/>`);
  for (let r = r0; r <= r1; r++) out.push(`<line x1="${c0}" y1="${r}" x2="${c1}" y2="${r}" stroke="#000" stroke-opacity="${fifth(nameR(r)) ? 0.18 : 0.06}" stroke-width="0.02"/>`);
  for (let c = c0 + 1; c < c1; c++) if (fifth(nameC(c))) out.push(`<text x="${c + 0.08}" y="${r0 + 0.35}" font-size="0.3" fill="#000" fill-opacity="0.5">${nameC(c)}</text>`);
  for (let r = r0 + 1; r < r1; r++) if (fifth(nameR(r))) out.push(`<text x="${c0 + 0.08}" y="${r + 0.35}" font-size="0.3" fill="#000" fill-opacity="0.5">${nameR(r)}</text>`);

  const [w, h] = [c1 - c0, r1 - r0];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * px}" height="${h * px}" viewBox="${c0} ${r0} ${w} ${h}" font-family="system-ui"><rect x="${c0}" y="${r0}" width="${w}" height="${h}" fill="${hex(T.land)}"/>${out.join("")}</svg>\n`;
}
