import { createResource } from "solid-js";
import type { Cell, Effect, Row } from "../generated";

/**
 * The skill tree as the server draws it: a small map — `.` road, a letter
 * from the legend for a node, anything else open land, a space between
 * cells so it can be read — and the legend. Fetched once; what the player
 * has taken comes with every growth update.
 */
export interface Tree {
  map: string[];
  legend: Record<string, Row>;
}

const [tree] = createResource<Tree>(() => fetch("/tree").then((r) => r.json()));
export { tree };

export const at = (t: Tree, x: number, y: number) => t.map[y]?.[x * 2] ?? " ";
export const rowAt = (t: Tree, c: Cell): Row | undefined => t.legend[at(t, c.x, c.y)];

/** The effects of everything taken. */
export function effects(t: Tree | undefined, taken: Cell[]): Effect[] {
  if (!t) return [];
  return taken.map((c) => rowAt(t, c)?.effect).filter((e): e is Effect => !!e);
}

/** Has the build unlocked this? A kind no node names is always unlocked. */
export function unlocked(t: Tree | undefined, taken: Cell[], want: (e: Effect) => boolean, named = true): boolean {
  if (!t) return !named;
  if (!Object.values(t.legend).some((r) => want(r.effect))) return true;
  return effects(t, taken).some(want);
}
