import { createEffect } from "solid-js";
import { lightOnPane, skyGlint, sunGlint, sunOnScreen, useDayNight } from "../engine/DayNightCycle";
import { light } from "../engine/glass";

type Rgb = [number, number, number];

/** How far the light's colour is softened toward white: a tint, not a gel. */
const SOFT = 0.55;

const luma = ([r, g, b]: Rgb) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const mix = (a: Rgb, b: Rgb, f: number): Rgb => a.map((v, i) => Math.round(v + (b[i] - v) * f)) as Rgb;

/**
 * The UI is a pane held up in the game's own light (`lightOnPane`): white
 * at noon, rose and gold as the sun goes down, the sky's blue at night. Set
 * as CSS variables (`app.css`) whenever the day turns it a shade: the
 * glass's colour and the ink on it, black on light glass, white on dark.
 * The glass itself the GPU draws (`engine/glass.ts`), in the same light:
 * its body, the sky round its edges, and the sun's glint on the rim that
 * faces it.
 */
export default function Glass() {
  const { timeOfDay } = useDayNight();
  let last = "";
  createEffect(() => {
    const t = timeOfDay();
    const sun = sunGlint(t);
    // The sun's own colour, not the glint's whitened core: gold at dawn
    // and dusk, white at noon.
    const own = sunOnScreen(t).colour;
    light.sun = own.map((v) => v / Math.max(...own, 1e-6)) as Rgb;
    light.sunStrength = sun.strength;
    light.toward = sun.toward;
    light.sky = skyGlint(t);
  });
  createEffect(() => {
    // The light keeps its hue however bright it is (the sun's is well over
    // white), softened toward white, and dimmed only where it is weak.
    const lit = lightOnPane(timeOfDay());
    const b = Math.max(...lit);
    const glass = lit.map((v) => Math.round(255 * (v / b + (1 - v / b) * SOFT) * Math.min(1, b) ** 1.5)) as Rgb;
    const bright = luma(glass) > 0.5;
    // What sits on the glass stands off it fully: black on light, white on dark.
    const ink: Rgb = bright ? [0, 0, 0] : [255, 255, 255];
    const key = `${glass}`;
    if (key === last) return;
    last = key;
    light.tint = glass.map((v) => v / 255) as Rgb;
    light.ink = mix(glass, [0, 0, 0], 0.7).map((v) => v / 255) as Rgb;
    const s = document.documentElement.style;
    s.setProperty("--glass", glass.join(" "));
    s.setProperty("--ink", ink.join(" "));
  });
  return null;
}
