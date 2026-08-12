import { Color3 } from "@babylonjs/core";
import type { Draft } from "../../generated";

/** Red, for something on its way out. */
const DOOMED = new Color3(0.85, 0.25, 0.2);

/**
 * How a thing is drawn, given whether it has been committed.
 *
 * The renderer follows the planner rather than the traffic: it shows the world
 * as it will be once the commit lands. Pending work is drawn, just visibly not
 * finished.
 *
 * `key` keeps each treatment in its own instance bucket, since a bucket is one
 * material and drafts do not share one with the real thing.
 */
export interface Look {
  key: string;
  alpha: number;
  tint(base: Color3): Color3;
  castShadow: boolean;
}

const COMMITTED: Look = { key: "", alpha: 1, tint: (c) => c, castShadow: true };

/** Other people's pending work: present and reserving its land, but not yours. */
const THEIRS: Look = {
  key: "_theirs",
  alpha: 0.4,
  // Drained of colour, so a glance separates what you can act on from what you
  // are merely waiting on.
  tint: (c) => {
    const grey = (c.r + c.g + c.b) / 3;
    return new Color3(grey, grey, grey);
  },
  castShadow: false,
};

const MINE: Look = { key: "_mine", alpha: 0.55, tint: (c) => c, castShadow: false };

/**
 * Staged for demolition. Still drawn, and still carrying traffic — the marker
 * is the one thing about a draft that is purely visual, so cars are never seen
 * driving over ground that has nothing on it.
 */
const DOOMED_LOOK: Look = {
  key: "_doomed",
  alpha: 0.75,
  tint: (c) => Color3.Lerp(c, DOOMED, 0.75),
  castShadow: false,
};

export function lookOf(draft: Draft | null | undefined, me: number): Look {
  if (!draft) return COMMITTED;
  if (draft.state === "Removed") return DOOMED_LOOK;
  return draft.owner === me ? MINE : THEIRS;
}
