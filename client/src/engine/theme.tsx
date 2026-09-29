import { Color3, Color4 } from "@babylonjs/core";
import {
  createContext,
  createMemo,
  createSignal,
  useContext,
  type ParentProps,
} from "solid-js";

const hex3 = (h: string) => Color3.FromHexString(h);
const hex4 = (h: string) => new Color4(...hex3(h).asArray(), 1);

const light = {
  // After Mini Motorways: sage land, mint water, off-white roads, and the
  // trees the one dark note on the ground, so the buildings carry the colour.
  land: hex4("#C6DBAB"),
  water: hex3("#A6E1D6"),
  beach: hex3("#F2E4C4"),
  // The floor between the crowns: a shade under the land, as the map's
  // darker meadows are.
  forest: hex3("#A3C68F"),
  // Tree crowns, dark to light: teal-greens, light enough that a forest
  // reads as a wood and not a hole.
  crowns: [hex3("#4F8A6C"), hex3("#63A07F"), hex3("#80B892")],
  // A field through its season: ploughed earth beside the beach, the
  // growing crop beside the grass, the ripe crop beside the highway's
  // yellow, the stubble between.
  earth: hex3("#EBD3A8"),
  growing: hex3("#B5D594"),
  ripe: hex3("#F2D680"),
  stubble: hex3("#ECE3C4"),
  mountain: hex3("#F8F7F6"),
  // A courtyard's lawn, a shade greener than the land round it.
  garden: hex3("#AED08F"),
  // A yard or a car park: paving, a shade under the road's white.
  paved: hex3("#DDD9CE"),
  grid: hex3("#BBD29E"),
  road: hex3("#F8F6F0"),
  bayLine: hex3("#E6E2D6"),
  // A road, as against a street: the map's yellow for a through route.
  highway: hex3("#F6CF6A"),
};

const dark = {
  land: hex4("#1A3028"),
  water: hex3("#0A1535"),
  beach: hex3("#2A2518"),
  forest: hex3("#053030"),
  crowns: [hex3("#042626"), hex3("#053030"), hex3("#0A3A34")],
  earth: hex3("#6B5230"),
  growing: hex3("#4A6B2A"),
  ripe: hex3("#7A6428"),
  stubble: hex3("#5E5A40"),
  mountain: hex3("#4D4D47"),
  garden: hex3("#1F4030"),
  paved: hex3("#30333B"),
  grid: hex3("#3A4A34"),
  road: hex3("#2A2D35"),
  bayLine: hex3("#151720"),
  highway: hex3("#5A4C22"),
};

export type Theme = typeof light;
export type ThemeMode = "light" | "dark";

type ThemeContextType = {
  theme: () => Theme;
  mode: () => ThemeMode;
  setMode: (mode: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextType>();

const themes = { light, dark } as const;

export function ThemeProvider(props: ParentProps) {
  const [mode, setMode] = createSignal<ThemeMode>("light");
  const theme = createMemo(() => themes[mode()]);

  return (
    <ThemeContext.Provider value={{ theme, mode, setMode }}>
      {props.children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): () => Theme {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
  return ctx.theme;
}
