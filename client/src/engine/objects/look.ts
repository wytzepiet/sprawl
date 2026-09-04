import { Color3 } from "@babylonjs/core";

/**
 * How a thing is drawn. `key` keeps each treatment in its own instance
 * bucket, since a bucket is one material.
 */
export interface Look {
  key: string;
  alpha: number;
  tint(base: Color3): Color3;
  castShadow: boolean;
  /** Height offset, in world units, to settle the draw order near the ground. */
  lift: number;
}

export const SOLID: Look = { key: "", alpha: 1, tint: (c) => c, castShadow: true, lift: 0 };

/**
 * A proposal: the city's suggestion, drawn as the building it would be, faint
 * and shadowless, until the mayor says yes.
 */
export const GHOST: Look = {
  key: "_ghost",
  alpha: 0.35,
  tint: (c) => Color3.Lerp(c, new Color3(0.35, 0.55, 0.95), 0.35),
  castShadow: false,
  lift: 0.004,
};
