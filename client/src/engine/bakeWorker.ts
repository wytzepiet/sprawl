import { bakeCrowns } from "./crowns";
import { bakeLace } from "./lace";
import { bakeRipples } from "./sand";
import { bakeSlate } from "./slate";
import { bakeWaves } from "./waves";
import { bakeWheat } from "./wheat";

/** Bakes a texture off the main thread, the one it is sent the name of
 *  (`bakeCache.ts`), and hands its texels back. */
const RECIPES = {
  crowns: bakeCrowns,
  lace: bakeLace,
  sand: bakeRipples,
  slate: () => bakeSlate().texels,
  waves: bakeWaves,
  wheat: bakeWheat,
};
export type Bake = keyof typeof RECIPES;

onmessage = ({ data }: MessageEvent<Bake>) => {
  const texels = RECIPES[data]();
  postMessage(texels, { transfer: [texels.buffer] });
};
