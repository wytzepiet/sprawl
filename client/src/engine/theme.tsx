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
  land: hex4("#D5F2A4"),
  water: hex3("#85D7FA"),
  water2: hex3("#78CFF6"),
  water3: hex3("#6BC7F2"),
  beach: hex3("#F5F1D8"),
  forest: hex3("#B3E590"),
  mountain: hex3("#F8F7F6"),
  grid: hex3("#8BA87A"),
  road: hex3("#FFFFFF"),
  roadBorder: hex3("#DFE1E1"),
};

const dark = {
  land: hex4("#1A3028"),
  water: hex3("#0A1535"),
  water2: hex3("#091330"),
  water3: hex3("#08112B"),
  beach: hex3("#2A2518"),
  forest: hex3("#053030"),
  mountain: hex3("#4D4D47"),
  grid: hex3("#3A4A34"),
  road: hex3("#2A2D35"),
  roadBorder: hex3("#151720"),
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
    <ThemeContext value={{ theme, mode, setMode }}>
      {props.children}
    </ThemeContext>
  );
}

export function useTheme(): () => Theme {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
  return ctx.theme;
}
