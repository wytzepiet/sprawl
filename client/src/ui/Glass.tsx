import { createEffect } from "solid-js";
import { lightOnPane, skyLight, sunOnScreen, useDayNight } from "../engine/DayNightCycle";

type Rgb = [number, number, number];

/** The rim the sun lights, and the shade on the far side, in pixels. */
const RIM = 1.6;
const SHADE = 2.2;
/** Light as an eye takes it: a little of it shows its colour, a lot of it
 *  goes white. Per channel, light in, 0..1 out. */
const EXPOSURE = 3;
const expose = (light: number[]) => light.map((v) => 1 - Math.exp(-v * EXPOSURE));
/** A glint's core is whiter than the light that makes it. */
const CORE = 0.35;
/** The sky round every edge: faint. */
const SKY_RIM = 0.32;
/** How much of the body the glass shows: the rest is the frost beneath. */
const BODY = 0.6;

/** How far the light's colour is softened toward white: a tint, not a gel. */
const SOFT = 0.55;

const luma = ([r, g, b]: Rgb) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const mix = (a: Rgb, b: Rgb, f: number): Rgb => a.map((v, i) => Math.round(v + (b[i] - v) * f)) as Rgb;

/**
 * The UI is a pane held up in the game's own light (`lightOnPane`): white
 * at noon, rose and gold as the sun goes down, the sky's blue at night. Set
 * as CSS variables (`app.css`) whenever the day turns it a shade: the
 * glass, the ink on it (its own colour, deepened or paled), its shadow, and
 * how what is built is laid on it — dye on light glass, lanterns on dark.
 *
 * And the goo filters the glass's shapes run together through, as the
 * hand's dots do, whose rims catch the sun from where it stands.
 */
export default function Glass() {
  const { timeOfDay } = useDayNight();
  let last = "";
  let lastSun = "";
  let defs!: SVGSVGElement;
  // The rims: the sky's light round every edge, and the sun's on the edge
  // that faces it, as it stands on the screen. The sun's as bright as it
  // truly is on glass (the ground's low-sun boost left off), seen as an eye
  // sees it: white when strong, its colour only when faint; none at night.
  createEffect(() => {
    const t = timeOfDay();
    const sun = sunOnScreen(t);
    const glint = expose(sun.colour.map((v) => v * sun.strength * Math.max(sun.elevation, 0.42)));
    const peak = Math.max(...glint, 1e-6);
    const hue = glint.map((v) => Math.round(255 * (v / peak + (1 - v / peak) * CORE)));
    const sky = expose(skyLight(t));
    const skyHue = sky.map((v) => Math.round((255 * v) / Math.max(...sky)));
    const a = (sun.azimuth * Math.PI) / 180;
    const [dx, dy] = [Math.cos(a), Math.sin(a)].map((v) => Math.round(v * 10) / 10);
    const strength = Math.min(0.85, peak).toFixed(2);
    const key = `${hue} ${skyHue} ${dx} ${dy} ${strength}`;
    if (key === lastSun) return;
    lastSun = key;
    const set = (sel: string, attrs: Record<string, string>) =>
      defs.querySelectorAll(sel).forEach((el) => Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v)));
    set("[data-away]", { dx: `${-dx * RIM}`, dy: `${-dy * RIM}` });
    set("[data-toward]", { dx: `${dx * SHADE}`, dy: `${dy * SHADE}` });
    set("[data-sun]", { "flood-color": `rgb(${hue.join(",")})`, "flood-opacity": strength });
    set("[data-sky]", { "flood-color": `rgb(${skyHue.join(",")})` });
  });
  createEffect(() => {
    // The light keeps its hue however bright it is (the sun's is well over
    // white), softened toward white, and dimmed only where it is weak.
    const lit = lightOnPane(timeOfDay());
    const b = Math.max(...lit);
    const glass = lit.map((v) => Math.round(255 * (v / b + (1 - v / b) * SOFT) * Math.min(1, b) ** 1.5)) as Rgb;
    const light = luma(glass) > 0.5;
    const ink = light ? mix(glass, [0, 0, 0], 0.72) : mix(glass, [255, 255, 255], 0.85);
    const key = `${glass}`;
    if (key === last) return;
    last = key;
    const s = document.documentElement.style;
    s.setProperty("--glass", glass.join(" "));
    s.setProperty("--ink", ink.join(" "));
    s.setProperty("--shade", `${mix(glass, [0, 0, 0], 0.7).join(" ")} / ${light ? 0.18 : 0.4}`);
    s.setProperty("--dye", light ? "multiply" : "screen");
  });
  return (
    <svg ref={defs} width="0" height="0" class="absolute" aria-hidden="true">
      <Goo id="goo" body={1} />
      <Goo id="glass-goo" body={BODY} />
    </svg>
  );
}

/**
 * Shapes run together like liquid: blurred, and cut again where the blur
 * is thick enough. Then the edge facing the sun is lit, a thin line in its
 * colour, and the far edge shaded, so the glass has an edge even white on
 * white: the shape and a copy nudged off it, one cut from the other. And
 * all the way round, faintly, the sky it reflects.
 */
function Goo(props: { id: string; body: number }) {
  return (
    <filter id={props.id}>
      <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="blur" />
      <feColorMatrix in="blur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10" result="goo" />
      <feComposite in="SourceGraphic" in2="goo" operator="atop" result="cut" />
      <feColorMatrix in="cut" type="matrix" values={`1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${props.body} 0`} result="shape" />
      <feOffset data-away in="goo" dx="0" dy="0" result="away" />
      <feComposite in="goo" in2="away" operator="out" result="litEdge" />
      <feGaussianBlur in="litEdge" stdDeviation="0.4" result="litSoft" />
      <feFlood data-sun flood-color="white" flood-opacity="0" result="sun" />
      <feComposite in="sun" in2="litSoft" operator="in" result="rim" />
      <feOffset data-toward in="goo" dx="0" dy="0" result="toward" />
      <feComposite in="goo" in2="toward" operator="out" result="farEdge" />
      <feGaussianBlur in="farEdge" stdDeviation="0.8" result="farSoft" />
      <feFlood style={{ "flood-color": "rgb(var(--ink))" }} flood-opacity="0.14" result="ink" />
      <feComposite in="ink" in2="farSoft" operator="in" result="shade" />
      <feMorphology in="goo" operator="erode" radius="1.2" result="inner" />
      <feComposite in="goo" in2="inner" operator="out" result="ring" />
      <feGaussianBlur in="ring" stdDeviation="0.4" result="ringSoft" />
      <feFlood data-sky flood-color="white" flood-opacity={`${SKY_RIM}`} result="sky" />
      <feComposite in="sky" in2="ringSoft" operator="in" result="skyRim" />
      <feMerge>
        <feMergeNode in="shape" />
        <feMergeNode in="shade" />
        <feMergeNode in="skyRim" />
        <feMergeNode in="rim" />
      </feMerge>
    </filter>
  );
}
