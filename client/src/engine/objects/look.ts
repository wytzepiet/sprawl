import { lerp, rgb, type Rgb } from "../rgb";

/**
 * How a thing is drawn. `key` keeps each treatment in its own instance
 * bucket, since a bucket is one material.
 */
export interface Look {
  key: string;
  tint(base: Rgb): Rgb;
  castShadow: boolean;
}

export const SOLID: Look = { key: "", tint: (c) => c, castShadow: true };

const RED = rgb(0.85, 0.25, 0.2);

/** A building no road reaches: standing, empty, and asking for one. */
export const DORMANT: Look = {
  key: "_dormant",
  tint: (c) => lerp(c, RED, 0.65),
  castShadow: true,
};

const GREY = rgb(0.45, 0.45, 0.47);

/** A shop with nothing on its shelves: open, and selling nothing. */
export const EMPTY: Look = {
  key: "_empty",
  tint: (c) => lerp(c, GREY, 0.6),
  castShadow: true,
};
