import { createEffect, onCleanup } from "solid-js";
import { lightOnPane, skyGlint, sunGlint, sunOnScreen, useDayNight } from "../engine/DayNightCycle";
import { light } from "../engine/glass";

type Rgb = [number, number, number];

/** How far the light's colour is softened toward white: a tint, not a gel. */
const SOFT = 0.66;
/** How dark the glass is at most by day, and how much darker than the
 *  light it is by night. */
const DARK = 0.22;
const DARKEN = 0.62;
/** How long the glass takes to come round to a new light, in seconds. */
const FADE = 0.18;

const luma = ([r, g, b]: Rgb) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const mix = (a: Rgb, b: Rgb, f: number): Rgb => a.map((v, i) => Math.round(v + (b[i] - v) * f)) as Rgb;

/**
 * The UI is a pane held up in the game's own light (`lightOnPane`): white
 * at noon, rose and gold as the sun goes down, the sky's blue at night.
 * Whenever the day turns it a shade: the glass's colour, always dark, and
 * the white ink on it.
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
  // Where the light is going, and where the glass is on its way there:
  // a turn of the light's colour fades over a moment.
  const now = { tint: [...light.tint] as Rgb, ink: [...light.ink] as Rgb, text: [...light.text] as Rgb };
  let goal = now;
  let frame = 0;
  const ease = (at: number) => {
    const dt = Math.min(0.1, (performance.now() - at) / 1000);
    const k = 1 - Math.exp(-dt / FADE);
    let still = true;
    for (const key of ["tint", "ink", "text"] as const) {
      now[key] = now[key].map((v, i) => {
        const to = goal[key][i];
        if (Math.abs(to - v) > 0.002) still = false;
        return Math.abs(to - v) > 0.002 ? v + (to - v) * k : to;
      }) as Rgb;
    }
    light.tint = now.tint;
    light.ink = now.ink;
    light.text = now.text;
    const t = performance.now();
    frame = still ? 0 : requestAnimationFrame(() => ease(t));
  };
  createEffect(() => {
    // The light keeps its hue however bright it is (the sun's is well over
    // white), softened toward white, and dimmed only where it is weak.
    const lit = lightOnPane(timeOfDay());
    const b = Math.max(...lit);
    const shade = lit.map((v) => Math.round(255 * (v / b + (1 - v / b) * SOFT) * Math.min(1, b) ** 1.5)) as Rgb;
    // The glass is always dark, in the light's hue: by day no lighter
    // than DARK, by night darker than the light still.
    const glass = shade.map((v) => Math.round(v * Math.min(DARKEN, DARK / Math.max(luma(shade), 1e-3)))) as Rgb;
    // What sits on it stands off it fully, in white.
    const ink: Rgb = [255, 255, 255];
    const key = `${glass}`;
    if (key === last) return;
    last = key;
    goal = { tint: glass.map((v) => v / 255) as Rgb, ink: mix(glass, [0, 0, 0], 0.7).map((v) => v / 255) as Rgb, text: ink.map((v) => v / 255) as Rgb };
    if (!frame) {
      const t = performance.now();
      frame = requestAnimationFrame(() => ease(t));
    }
  });
  onCleanup(() => cancelAnimationFrame(frame));
  return null;
}
