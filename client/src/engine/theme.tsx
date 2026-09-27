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
  // Ground, water and sand after a pen-and-wash town plan, lifted lighter and
  // fresher than the colours sampled from it.
  land: hex4("#CFE58A"),
  water: hex3("#7CC4EE"),
  beach: hex3("#F7EBCB"),
  // The floor between the crowns: the shade of the darkest of them.
  forest: hex3("#5A9A3E"),
  // Tree crowns, dark to light: the plan's three greens, lifted out of olive.
  crowns: [hex3("#5FA543"), hex3("#86C451"), hex3("#B4DC66")],
  // A field through its season: ploughed earth beside the beach, the
  // growing crop beside the grass, the ripe crop beside the highway's
  // yellow, the stubble between.
  earth: hex3("#F1CE9A"),
  growing: hex3("#C3EA7C"),
  ripe: hex3("#F7D96E"),
  stubble: hex3("#EFE6BC"),
  mountain: hex3("#F8F7F6"),
  grid: hex3("#B5CF6E"),
  road: hex3("#FFFFFF"),
  roadBorder: hex3("#DFE1E1"),
  // A road, as against a street: the map's yellow for a through route.
  highway: hex3("#F9DC72"),
  highwayBorder: hex3("#D9B44A"),
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
  grid: hex3("#3A4A34"),
  road: hex3("#2A2D35"),
  roadBorder: hex3("#151720"),
  highway: hex3("#5A4C22"),
  highwayBorder: hex3("#2E2610"),
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
