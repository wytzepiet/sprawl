import { Color3 } from "@babylonjs/core";
import type { InstancePool } from "../InstancePool";
import type { Theme } from "../theme";
import { parsePiece, type Role, type Shape } from "./svg";
import { raise, SOLID_ROLES } from "./raise";
import type { Placed } from "./rules";

/** Every drawing in `drawings/`, by file name. */
const PIECES: Record<string, Shape[]> = Object.fromEntries(
  Object.entries(import.meta.glob<string>("./drawings/*.svg", { query: "?raw", import: "default", eager: true })).map(
    ([path, svg]) => [path.slice("./drawings/".length, -".svg".length), parsePiece(svg)],
  ),
);

const solids = new Map<string, ReturnType<typeof raise>>();
const solid = (piece: string, role: Role, mirror: boolean) => {
  const k = `${piece}${mirror ? "_m" : ""}_${role}`;
  if (!solids.has(k)) solids.set(k, raise(PIECES[piece], role, mirror));
  return solids.get(k)!;
};

/** A role's colour: a building's own for its roof and walls, the theme's
 *  for the rest. */
function colour(theme: Theme, role: Role, own?: Color3): Color3 {
  switch (role) {
    case "roof":
    case "wall": return own ?? theme.mountain;
    case "tree": return theme.crowns[1];
    case "lamp": return theme.lamp;
    case "garden": return theme.garden;
    case "pavement": return theme.road;
    case "marking": return theme.marking;
    case "water": return theme.water;
  }
}

/**
 * Put pieces down: one instance per role per piece, each role's solid built
 * once and shared. `own` is the colour a building gives its roof and walls,
 * `tint` the look it is drawn with, and `key` names both, since a bucket is
 * one material. Returns what was placed, the solid parts first.
 */
export function lay(
  pool: InstancePool,
  theme: Theme,
  placed: Placed[],
  key = "",
  own?: Color3,
  tint: (c: Color3) => Color3 = (c) => c,
): { key: string; id: number }[] {
  const out: { key: string; id: number }[] = [];
  for (const p of placed) {
    const shapes = PIECES[p.piece];
    if (!shapes) throw new Error(`no drawing for piece "${p.piece}"`);
    for (const role of new Set(shapes.map((s) => s.role))) {
      const bucket = `piece_${p.piece}${p.mirror ? "_m" : ""}_${role}${key}`;
      pool.ensureBucket(bucket, solid(p.piece, role, p.mirror), tint(colour(theme, role, own)), SOLID_ROLES.has(role), true);
      const at = { key: bucket, id: pool.addInstance(bucket, [p.x + 0.5, p.y + 0.5, 0], [0, 0, p.rot]) };
      if (SOLID_ROLES.has(role)) out.unshift(at);
      else out.push(at);
    }
  }
  return out;
}
