/**
 * A piece is drawn as an SVG, top-down, in the frame of the situation it
 * answers: a hundred units to a tile, the tile from 0 to 100, and the thing
 * the piece is answering at the bottom (the street for a plot, the frontage
 * for a street, the arm for a junction). Each shape carries its role as its
 * class, and may carry `data-h`, its height in tiles.
 *
 * Only what a drawing needs is read: `rect` (with `rx`), `polygon` and
 * `circle`. Anything else in the file is the drawing's own, and ignored.
 */

export type Role = "roof" | "wall" | "tree" | "lamp" | "garden" | "pavement" | "water" | "marking";
const ROLES = new Set<string>(["roof", "wall", "tree", "lamp", "garden", "pavement", "water", "marking"]);

export type Shape =
  | { role: Role; h?: number; kind: "rect"; x: number; y: number; w: number; d: number; r: number }
  | { role: Role; h?: number; kind: "polygon"; points: [number, number][] }
  | { role: Role; h?: number; kind: "circle"; x: number; y: number; r: number };

/** The shapes of a piece, in tiles, with the tile running 0 to 1. */
export function parsePiece(svg: string): Shape[] {
  const shapes: Shape[] = [];
  for (const [, tag, body] of svg.matchAll(/<(rect|polygon|circle)\b([^>]*)>/g)) {
    const a = Object.fromEntries([...body.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
    const role = a.class;
    if (!ROLES.has(role)) throw new Error(`a piece's ${tag} has no role we know: "${role}"`);
    const n = (k: string) => Number(a[k] ?? 0) / 100;
    const base = { role: role as Role, h: a["data-h"] === undefined ? undefined : Number(a["data-h"]) };
    if (tag === "rect") shapes.push({ ...base, kind: "rect", x: n("x"), y: n("y"), w: n("width"), d: n("height"), r: n("rx") });
    else if (tag === "circle") shapes.push({ ...base, kind: "circle", x: n("cx"), y: n("cy"), r: n("r") });
    else {
      const v = a.points.trim().split(/[\s,]+/).map((s) => Number(s) / 100);
      shapes.push({ ...base, kind: "polygon", points: Array.from({ length: v.length / 2 }, (_, i) => [v[2 * i], v[2 * i + 1]]) });
    }
  }
  return shapes;
}
