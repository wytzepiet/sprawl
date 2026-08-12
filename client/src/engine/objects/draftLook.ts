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
  /**
   * Height offset, in world units. Roads all sit within a hundredth of the
   * ground, so a draft has to be nudged off that plane to settle the order:
   * what is arriving lies over what is leaving.
   */
  lift: number;
}

const COMMITTED: Look = { key: "", alpha: 1, tint: (c) => c, castShadow: true, lift: 0 };

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
  lift: 0.004,
};

const MINE: Look = { key: "_mine", alpha: 0.55, tint: (c) => c, castShadow: false, lift: 0.004 };

/**
 * Staged for demolition. Still drawn, and still carrying traffic — the marker
 * is the one thing about a draft that never touches the simulation, so cars are
 * never seen driving over ground that has nothing on it.
 *
 * Faded well back rather than merely tinted, because something can be drafted
 * on top of it: rerouting an artery means building over the old alignment, and
 * the road on its way out has to give the new work the foreground.
 */
export const DOOMED_LOOK: Look = {
  key: "_doomed",
  alpha: 0.32,
  tint: (c) => Color3.Lerp(c, DOOMED, 0.75),
  castShadow: false,
  // Under the live network, and under all of it: a road is a border at 0.015
  // with its surface at 0.020, so anything shallower than -0.005 leaves the
  // demolished tarmac riding over the surviving pavement.
  lift: -0.008,
};

/**
 * Traffic still using a road that is on its way out. Fades with the road it is
 * driving on, so the pair reads as one thing being replaced rather than as
 * cars stranded on top of a ghost.
 */
export const DOOMED_TRAFFIC: Look = {
  key: "_leaving",
  alpha: 0.35,
  tint: (c) => c,
  castShadow: false,
  lift: 0,
};

export function lookOf(draft: Draft | null | undefined, me: number): Look {
  if (!draft) return COMMITTED;
  if (draft.state === "Removed") return DOOMED_LOOK;
  return draft.owner === me ? MINE : THEIRS;
}
