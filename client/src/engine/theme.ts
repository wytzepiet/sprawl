import { Color3, Color4 } from "@babylonjs/core";

function getCSSColor(varName: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

function hexToColor3(hex: string): Color3 {
  return Color3.FromHexString(hex);
}

function hexToColor4(hex: string, alpha = 1): Color4 {
  const c = Color3.FromHexString(hex);
  return new Color4(c.r, c.g, c.b, alpha);
}

function readTheme() {
  return {
    land: hexToColor4(getCSSColor("--color-land")),
    grid: hexToColor3(getCSSColor("--color-grid")),
    road: hexToColor3(getCSSColor("--color-road")),
  };
}

export type Theme = ReturnType<typeof readTheme>;

export function useTheme(): Theme {
  return readTheme();
}
