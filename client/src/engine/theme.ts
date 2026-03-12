import { Color3, Color4 } from "@babylonjs/core";

const hex3 = (h: string) => Color3.FromHexString(h);
const hex4 = (h: string) => new Color4(...hex3(h).asArray(), 1);

export const theme = {
  land: hex4("#C7D9B1"),
  water: hex3("#5B8FAF"),
  forest: hex3("#6B8E5A"),
  mountain: hex3("#9A9A8E"),
  grid: hex3("#8BA87A"),
  road: hex3("#4D5365"),
};

export type Theme = typeof theme;

export function useTheme(): Theme {
  return theme;
}
