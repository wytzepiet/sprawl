/**
 * The town on its subgrid (`src/engine/town/sub.ts`), flat as SVG, in the
 * plan's palette: `bun run plan --sub` draws it beside today's plan. The
 * ground and the asphalt are today's; the buildings, drives, car parks,
 * loading bays and kerb cars are the subgrid's pieces, the subgrid itself
 * drawn faintly over all.
 */
import type { BuildingKind } from "../src/generated";
import { parseTown, type Tile } from "../src/engine/town/grid";
import { blunt, soften, unite, type Polygon, type Pt } from "../src/engine/town/footprint";
import { asphalt, pavement } from "../src/engine/town/dressing";
import { bodies, N, subdivide } from "../src/engine/town/sub";
import { BLUEPRINTS } from "../src/blueprints";
import { themes } from "../src/engine/theme";

const T = themes.light;
const hex = (c: { r: number; g: number; b: number }) =>
  "#" + [c.r, c.g, c.b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
const CARS = ["#e64033", "#d9d9e0", "#333847", "#4066bf", "#a6a6ad", "#8c2626", "#338066", "#cca640"];

export function planSvg(text: string, { crop, px }: { crop?: [number, number, number, number]; px: number }): string {
  const town = parseTown(text);
  const [c0, r0, c1, r1] = crop ?? [0, 0, town.w, town.h];
  const out: string[] = [];
  const f = (v: number) => +v.toFixed(3);
  const d = (poly: Polygon) => poly.map((ring) => "M" + ring.map(([x, y]) => `${f(x)} ${f(y)}`).join("L") + "Z").join("");
  const fill = (polys: Polygon[], colour: string, extra = "") =>
    polys.length && out.push(`<path fill-rule="evenodd" fill="${colour}" ${extra} d="${polys.map(d).join("")}"/>`);
  const box = (x: number, y: number, angle: number, l: number, w: number, colour: string) =>
    out.push(`<rect x="${f(-l / 2)}" y="${f(-w / 2)}" width="${f(l)}" height="${f(w)}" fill="${colour}" transform="translate(${f(x)} ${f(y)}) rotate(${f((angle * 180) / Math.PI)})"/>`);
  const tiles = (pick: (t: Tile) => boolean): Polygon[] => {
    const squares: Polygon[] = [];
    for (let r = 0; r < town.h; r++) for (let c = 0; c < town.w; c++) if (pick(town.tile(c, r))) squares.push([[[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]]]);
    return squares;
  };

  fill(soften(unite(tiles((t) => t.kind === "water")), 0.3), hex(T.water));
  fill(soften(unite(tiles((t) => t.kind === "wood")), 0.3), hex(T.forest));
  fill(pavement(town), hex(T.paved));

  const sub = subdivide(town);
  const regions = sub.pieces.map((_, id) => unite(sub.region(id)));
  const of = (use: string) => sub.pieces.flatMap((p, id) => (p.use === use ? [{ p, region: regions[id] }] : []));

  // The asphalt: the road, and the drives off it, one surface.
  const lanes = of("drive").flatMap(({ region }) => region.map((poly) => poly[0]));
  const { street, through } = asphalt(town, lanes);
  fill(street, hex(T.road));
  fill(through, hex(T.highway));

  // A car park's bays, each outlined.
  for (const { region } of of("spot")) fill(region, "none", `stroke="#b8b2a0" stroke-width="0.012"`);

  // The buildings, a kind's tiles one region.
  const kinds = new Set(of("building").map(({ p }) => p.kind));
  for (const kind of kinds) fill(blunt(unite(of("building").filter(({ p }) => p.kind === kind).flatMap(({ region }) => region)), 0.04), BLUEPRINTS[kind as BuildingKind]?.color ?? "#888888");

  for (const piece of sub.pieces) {
    for (const b of bodies(piece)) box(b.x, b.y, b.angle, b.l, b.w, piece.use === "lorry" ? (b.cab ? "#475c94" : "#e6e6e0") : CARS[b.colour]);
    if (piece.use === "lorry") {
      // The door, across the lorry's tail.
      const { x, y, angle } = piece.poses[0];
      const [ux, uy] = [Math.cos(angle), Math.sin(angle)];
      out.push(`<line x1="${f(x - uy * 0.11)}" y1="${f(y + ux * 0.11)}" x2="${f(x + uy * 0.11)}" y2="${f(y - ux * 0.11)}" stroke="#383d4d" stroke-width="0.03"/>`);
    }
  }

  // The subgrid, faint, and the tiles a little less so.
  for (let k = c0 * N; k <= c1 * N; k++) out.push(`<line x1="${k / N}" y1="${r0}" x2="${k / N}" y2="${r1}" stroke="#000" stroke-opacity="${k % N ? 0.04 : 0.1}" stroke-width="0.01"/>`);
  for (let k = r0 * N; k <= r1 * N; k++) out.push(`<line x1="${c0}" y1="${k / N}" x2="${c1}" y2="${k / N}" stroke="#000" stroke-opacity="${k % N ? 0.04 : 0.1}" stroke-width="0.01"/>`);

  const [w, h] = [c1 - c0, r1 - r0];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * px}" height="${h * px}" viewBox="${c0} ${r0} ${w} ${h}" font-family="system-ui"><rect x="${c0}" y="${r0}" width="${w}" height="${h}" fill="${hex(T.land)}"/>${out.join("")}</svg>\n`;
}

export type { Pt };
