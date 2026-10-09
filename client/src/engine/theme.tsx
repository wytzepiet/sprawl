import { hex } from "./rgb";
import {
  createContext,
  createMemo,
  createSignal,
  useContext,
  type ParentProps,
} from "solid-js";

const hex3 = hex;
const hex4 = hex;

const light = {
  // After a Scottish coast from the air, made light: sage pasture, a
  // slate-teal sea, pale taupe sand, off-white roads, and the trees the one
  // dark note on the ground, so the buildings carry the colour.
  land: hex4("#7A8F66"),
  water: hex3("#76AAB2"),
  beach: hex3("#E2DCCF"),
  // The floor between the crowns: the wood's shade, of the crowns' teal
  // greens, darker than them as the ground under a canopy is, so a forest
  // reads as one even zoomed out past its trees.
  forest: hex3("#4A6461"),
  // Tree crowns, dark to light: deep teal-greens, the dark note, light
  // enough that a forest reads as a wood and not a hole.
  crowns: [hex3("#325E57"), hex3("#3F705E"), hex3("#52846A")],
  // Conifers, dark to light: darker and bluer than the broadleaves, as a
  // stand of spruce is beside an oak wood.
  conifers: [hex3("#2A554B"), hex3("#325F53"), hex3("#3D6B5C")],
  // A field through its season: ploughed earth beside the beach, the
  // growing crop beside the grass, the ripe crop beside the highway's
  // yellow, the stubble between.
  earth: hex3("#EBD3A8"),
  growing: hex3("#B5D594"),
  ripe: hex3("#F2D680"),
  stubble: hex3("#ECE3C4"),
  // A mountain: its snow, its bare rock; the cliffs the land stands on.
  mountain: hex3("#F4F3F0"),
  rock: hex3("#A89C8A"),
  // A yard, a car park or a pavement: a worn, warm stone grey, light
  // beside the asphalt.
  paved: hex3("#ADA596"),
  // Asphalt: a dark, matte grey.
  road: hex3("#585C61"),
  // A road, as against a street: the map's yellow for a through route,
  // muted.
  highway: hex3("#D6B55E"),
};

const dark = {
  land: hex4("#1A3028"),
  water: hex3("#0A1535"),
  beach: hex3("#2A2518"),
  forest: hex3("#053030"),
  crowns: [hex3("#042626"), hex3("#053030"), hex3("#0A3A34")],
  conifers: [hex3("#031E20"), hex3("#04262A"), hex3("#072E2C")],
  earth: hex3("#6B5230"),
  growing: hex3("#4A6B2A"),
  ripe: hex3("#7A6428"),
  stubble: hex3("#5E5A40"),
  mountain: hex3("#4D4D47"),
  rock: hex3("#3A3833"),
  paved: hex3("#30333B"),
  road: hex3("#2A2D35"),
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

export const themes = { light, dark } as const;

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
