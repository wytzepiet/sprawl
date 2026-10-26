import type { BuildingKind, Ghost, Placing } from "../generated";
import { missions } from "./missions";

/** Where the opening's step at hand would have its building go, and the
 *  street it needs first, as the game sees it (`ghost::best`). */
export function ghost(): Ghost | null {
  const opening = missions().find((m) => m.key === "Opening" && m.finished === null);
  return opening?.steps.find((s) => !s.done)?.ghost ?? null;
}

/** The ghost as the town draws a building in hand: standing there. */
export function ghostPlacing(): Placing | null {
  const g = ghost();
  return g && { kind: g.kind, at: g.at, tiles: g.tiles, facing: g.facing, door: null, why: null };
}

/** Whether the build menu holds a kind: while the opening is on, only
 *  the kinds its steps have come to, the newest the step at hand's;
 *  after it, every kind. */
export function unlocked(kind: BuildingKind): boolean {
  const opening = missions().find((m) => m.key === "Opening" && m.finished === null);
  if (!opening) return true;
  for (const s of opening.steps) {
    if ((s.goal.kind === "Stands" ? s.goal.data : s.goal.kind === "Settled" ? "House" : null) === kind) return true;
    if (!s.done) return false;
  }
  return false;
}
