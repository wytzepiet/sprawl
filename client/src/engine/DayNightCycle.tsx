import {
  createSignal,
  createContext,
  useContext,
  onCleanup,
  type ParentProps,
} from "solid-js";
import { timeOfDay as simTimeOfDay } from "../network/clock";
import {
  Color3,
  Color4,
  Vector3,
  DirectionalLight,
  ImageProcessingConfiguration,
  ShadowGenerator,
  type AbstractEngine,
} from "@babylonjs/core";
import { useEngine } from "./Canvas";
import { groundCover } from "./view";
import { skyEnvironment } from "./sky";

// ---------------------------------------------------------------------------
// Time config
// ---------------------------------------------------------------------------

const pinned = import.meta.env.DEV ? new URLSearchParams(location.search).get("t") : null;
const PINNED = pinned === null ? null : Number(pinned);
/** How open the eye is to the scene's light, and how strong
 *  the sky's light is beside the sun's. A low sky gives deep shadows and
 *  sunlit surfaces that glow; the eye opened wide brings the whole back up. */
const EYE = 2.7;
const SKY = 0.21;

/**
 * A light as PBR takes it. The palette is written as an eye sees it, and a
 * stop may run past 1 where a light is brighter than white: so its hue is
 * the colour over its brightest channel, made linear, and its strength the
 * rest. Converted here once, where the light is handed over.
 */
function linearLight(colour: Color3, strength: number): Color3 {
  const peak = Math.max(colour.r, colour.g, colour.b, 1e-6);
  return colour.scale(1 / peak).toLinearSpace().scale(strength * peak);
}

/** Half-extent of the sun's ortho frustum beyond which shadows stop rendering. */
const SHADOW_MAX_RADIUS = 50;

/**
 * Shadow map resolution: the power of two under the longer side of the screen,
 * so the map holds at most a texel per pixel. It is bilinearly compared, so a
 * texel short of a pixel only softens the edge, which is the look anyway. The
 * map is cleared and written every frame, and its size is the bandwidth —
 * 4096 once cost 67MB a frame for detail a top-down view cannot show.
 *
 * Every frame, not every other: a map drawn at half rate shimmers. Its texel
 * grid is laid down afresh wherever the sun and the view have moved to, and
 * skipping frames doubles the jump between one grid and the next.
 */
function shadowMapSize(engine: AbstractEngine): number {
  const longest = Math.max(engine.getRenderWidth(), engine.getRenderHeight());
  return Math.min(2048, Math.max(512, 2 ** Math.floor(Math.log2(longest))));
}

// ---------------------------------------------------------------------------
// Color palette per time-of-day
// ---------------------------------------------------------------------------

const AMB_MIDNIGHT = new Color3(0.35, 0.35, 0.5);
// The sky stays cool as the sun goes down, dimmer and a little lavender:
// it is the sun that turns gold, so a golden hour is warm light and blue
// shadows at once.
const AMB_DAWN = new Color3(0.55, 0.52, 0.66);
const AMB_NOON = new Color3(0.82, 0.82, 0.8);
const AMB_DUSK = new Color3(0.5, 0.48, 0.62);
/** The sky's light is blue and the sun's warm, so where the sun is shut out
 *  a surface is its colour times the blue: grass goes teal, a red roof
 *  raspberry, white periwinkle. In the sun the two add to near white. */
const SKY_LIGHT = new Color3(0.74, 0.86, 1.22);
/** The sun by its elevation: the lower, the more air its light has
 *  crossed and the more blue is scattered out of it, so near white high,
 *  gold low, and a deep orange red as it sets. */
const sunStops: [number, Color3][] = [
  [0, new Color3(1.8, 0.42, 0.16)],
  [0.14, new Color3(1.8, 0.42, 0.16)],
  [0.3, new Color3(1.65, 0.78, 0.3)],
  [0.7, new Color3(1.15, 1.02, 0.75)],
  [1, new Color3(1.15, 1.02, 0.75)],
];

/** A shadow is drawn no longer than the sun this high would cast it. */
const LOWEST = 0.1;

/** The sun's light at an elevation. It is stronger when low, as an eye opens up to it, since a
 *  low sun lights the ground at a slant and its gold should still reach
 *  it; and it fades out just above the lowest sun, so the roofs it lights
 *  and the shadows it casts go together, before the shadows stop growing. */
function sunLightAt(elev: number): { colour: Color3; strength: number } {
  return { colour: ramp(sunStops, elev, lerp3), strength: (0.5 * Math.min(1, Math.max(0, (elev - LOWEST) / 0.15))) / Math.max(elev, 0.42) };
}

const SKY_MIDNIGHT = new Color4(0.15, 0.15, 0.25, 1);
const SKY_DAWN = new Color4(0.58, 0.42, 0.3, 1);
const SKY_NOON = new Color4(0.72, 0.8, 0.75, 1);
const SKY_DUSK = new Color4(0.52, 0.32, 0.22, 1);

// ---------------------------------------------------------------------------
// Interpolation helpers
// ---------------------------------------------------------------------------

function lerp3(a: Color3, b: Color3, t: number): Color3 {
  return new Color3(
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t,
  );
}

function lerp4(a: Color4, b: Color4, t: number): Color4 {
  return new Color4(
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t,
    a.a + (b.a - a.a) * t,
  );
}

function ramp<T>(
  stops: [number, T][],
  t: number,
  fn: (a: T, b: T, f: number) => T,
): T {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const f = (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      return fn(stops[i - 1][1], stops[i][1], f);
    }
  }
  return stops[stops.length - 1][1];
}

// ---------------------------------------------------------------------------
// Time-of-day stops
// ---------------------------------------------------------------------------

// t: 0 = midnight, 0.5 = noon. A Dutch summer's day, by the clock: the sun
// is up from twenty past five to ten at night, highest at twenty to two,
// and the night is short.
export const SUNRISE = 5.33 / 24;
export const SUNSET = 22 / 24;

const ambientStops: [number, Color3][] = [
  [0.0, AMB_MIDNIGHT],
  [SUNRISE - 0.03, AMB_MIDNIGHT],
  [SUNRISE + 0.04, AMB_DAWN],
  [SUNRISE + 0.14, AMB_NOON],
  [SUNSET - 0.14, AMB_NOON],
  [SUNSET - 0.04, AMB_DUSK],
  [SUNSET + 0.03, AMB_MIDNIGHT],
  [1.0, AMB_MIDNIGHT],
];

const skyStops: [number, Color4][] = [
  [0.0, SKY_MIDNIGHT],
  [SUNRISE - 0.03, SKY_MIDNIGHT],
  [SUNRISE + 0.04, SKY_DAWN],
  [SUNRISE + 0.14, SKY_NOON],
  [SUNSET - 0.14, SKY_NOON],
  [SUNSET - 0.04, SKY_DUSK],
  [SUNSET + 0.03, SKY_MIDNIGHT],
  [1.0, SKY_MIDNIGHT],
];

// The sky's horizon, for PBR's environment (`sky.ts`): toward the sun the
// glow, and away from it the belt. By day both are haze. As the sun nears
// the horizon the glow turns gold, then orange, and after it has gone rose
// and mauve, while the far side takes the Belt of Venus, pink over the blue
// of the earth's own shadow rising; the same backwards at dawn.
const HAZE = new Color3(0.85, 0.9, 1.0);
const GLOW_NIGHT = new Color3(0.28, 0.3, 0.55);
const BELT_NIGHT = new Color3(0.2, 0.22, 0.45);
const glowStops: [number, Color3][] = [
  [0.0, GLOW_NIGHT],
  [SUNRISE - 0.05, GLOW_NIGHT],
  [SUNRISE - 0.015, new Color3(0.85, 0.4, 0.45)],
  [SUNRISE + 0.01, new Color3(1.0, 0.55, 0.3)],
  [SUNRISE + 0.06, new Color3(1.0, 0.8, 0.55)],
  [SUNRISE + 0.14, HAZE],
  [SUNSET - 0.14, HAZE],
  [SUNSET - 0.06, new Color3(1.0, 0.78, 0.5)],
  [SUNSET - 0.015, new Color3(1.0, 0.5, 0.25)],
  [SUNSET + 0.015, new Color3(0.9, 0.38, 0.35)],
  [SUNSET + 0.05, new Color3(0.45, 0.3, 0.5)],
  [SUNSET + 0.08, GLOW_NIGHT],
  [1.0, GLOW_NIGHT],
];
const beltStops: [number, Color3][] = [
  [0.0, BELT_NIGHT],
  [SUNRISE - 0.04, BELT_NIGHT],
  [SUNRISE, new Color3(0.8, 0.55, 0.7)],
  [SUNRISE + 0.06, new Color3(0.85, 0.75, 0.8)],
  [SUNRISE + 0.14, HAZE],
  [SUNSET - 0.14, HAZE],
  [SUNSET - 0.06, new Color3(0.85, 0.72, 0.78)],
  [SUNSET, new Color3(0.85, 0.55, 0.7)],
  [SUNSET + 0.03, new Color3(0.4, 0.38, 0.62)],
  [SUNSET + 0.06, BELT_NIGHT],
  [1.0, BELT_NIGHT],
];

/** How far the sun has come across the sky, 0 at sunrise to π at sunset. */
const sunAngle = (t: number) => ((t - SUNRISE) / (SUNSET - SUNRISE)) * Math.PI;

/** How high the sun climbs at noon, where 1 is overhead: a northern
 *  summer's sun, which never quite gets there, so more of the day is spent
 *  low and gold. */
const PEAK = 0.8;
/** How far to the north the sun's path lies: up the screen, so shadows
 *  fall down it. */
const NORTH = 0.55;

/** Sun elevation: 0 at horizon, PEAK at noon. 0 during night. */
function sunElevation(t: number): number {
  if (t < SUNRISE || t > SUNSET) return 0;
  return PEAK * Math.sin(sunAngle(t));
}

function sunDirection(t: number): Vector3 {
  if (t < SUNRISE || t > SUNSET) return new Vector3(0, -NORTH, -1).normalize();
  const angle = sunAngle(t); // 0=dawn, π/2=noon, π=dusk
  const elev = Math.max(PEAK * Math.sin(angle), LOWEST);
  const horiz = Math.cos(angle);
  return new Vector3(-horiz, -NORTH, -elev).normalize();
}

/**
 * The moon, full, as the night's light: up when the sun is down, crossing
 * the same way along a lower path, its light the sun's own thrown back, pale
 * and a little blue to an eye at night. It shines through the sun's light
 * and casts with its shadows; the two hand over below the horizon, where
 * both have faded to nothing.
 */
const MOON_PEAK = 0.55;
const MOON_COLOUR = new Color3(0.72, 0.82, 1.0);
const MOON = 0.16;

/** How far the moon has come across the night, 0 at sunset to π at sunrise. */
const moonAngle = (t: number) => ((((t - SUNSET) % 1) + 1) % 1 / (1 - (SUNSET - SUNRISE))) * Math.PI;

function isNight(t: number): boolean {
  return t < SUNRISE || t > SUNSET;
}

function moonElevation(t: number): number {
  return isNight(t) ? MOON_PEAK * Math.sin(moonAngle(t)) : 0;
}

function moonDirection(t: number): Vector3 {
  const angle = moonAngle(t);
  return new Vector3(-Math.cos(angle), -NORTH, -Math.max(MOON_PEAK * Math.sin(angle), LOWEST)).normalize();
}

function moonLightAt(elev: number): { colour: Color3; strength: number } {
  return { colour: MOON_COLOUR, strength: MOON * Math.min(1, Math.max(0, (elev - LOWEST) / 0.15)) };
}

/** Where the sun is as the screen sees it: which way across the screen
 *  (degrees, clockwise from the right, as SVG's lights take it), how
 *  high (0 to 1), and its light. Up the screen is north, where its path
 *  lies; it rises on the left and sets on the right, as the shadows show. */
export function sunOnScreen(t: number): { azimuth: number; elevation: number; colour: [number, number, number]; strength: number } {
  const horiz = Math.cos(sunAngle(t));
  const elevation = sunElevation(t);
  const sun = sunLightAt(elevation);
  return {
    azimuth: (Math.atan2(-NORTH, -horiz) * 180) / Math.PI,
    elevation,
    colour: [sun.colour.r, sun.colour.g, sun.colour.b],
    strength: sun.strength,
  };
}

/** Light as an eye takes it: a little shows its colour, a lot goes white. */
const EXPOSURE = 3;
const expose = (light: number[]) => light.map((v) => 1 - Math.exp(-v * EXPOSURE));
/** A glint's core is whiter than the light that makes it. */
const CORE = 0.35;

/**
 * The sun's glint on a glassy edge, the UI's and the world's alike: its
 * colour (0..1), how strong, and which way the sun lies on the screen (a
 * unit step, y down). As bright as the sun truly is on glass, the ground's
 * low-sun boost left off, and seen as an eye sees it: white when strong,
 * its colour only when faint; nothing at night.
 */
export function sunGlint(t: number): { colour: [number, number, number]; strength: number; toward: [number, number] } {
  const sun = sunOnScreen(t);
  const glint = expose(sun.colour.map((v) => v * sun.strength * Math.max(sun.elevation, 0.42)));
  const peak = Math.max(...glint, 1e-6);
  const a = (sun.azimuth * Math.PI) / 180;
  return {
    colour: glint.map((v) => v / peak + (1 - v / peak) * CORE) as [number, number, number],
    strength: Math.min(0.85, peak),
    toward: [Math.cos(a), Math.sin(a)],
  };
}

/** The sky's light on an edge, as an eye takes it, at full brightness. */
export function skyGlint(t: number): [number, number, number] {
  const sky = expose(skyLight(t));
  return sky.map((v) => v / Math.max(...sky)) as [number, number, number];
}

/** The sky's light alone, without the sun's: pale by day, lavender at a
 *  low sun, blue at night. What a glass edge reflects all the way round. */
export function skyLight(t: number): [number, number, number] {
  const sky = ramp(ambientStops, t, lerp3).multiply(SKY_LIGHT);
  return [sky.r, sky.g, sky.b];
}

/** The light on a pane held up to the sun at this time of day: the sky's
 *  and the whole of the sun's, so white at noon, rose and gold as it sets,
 *  the sky's blue alone at night. What the UI's glass is lit by. */
export function lightOnPane(t: number): [number, number, number] {
  const sky = ramp(ambientStops, t, lerp3).multiply(SKY_LIGHT);
  const sun = sunLightAt(sunElevation(t));
  return [sky.r + sun.colour.r * sun.strength, sky.g + sun.colour.g * sun.strength, sky.b + sun.colour.b * sun.strength];
}

// ---------------------------------------------------------------------------
// Context — time signals (no Babylon dependency)
// ---------------------------------------------------------------------------

export interface DayNightState {
  timeOfDay: () => number;
  ambientColor: () => Color3;
  shadowGenerator: () => ShadowGenerator | undefined;
  /** @internal used by DayNightLights */
  _setTimeOfDay: (t: number) => void;
  /** @internal used by DayNightLights */
  _setAmbient: (v: Color3) => void;
  /** @internal used by DayNightLights */
  _setShadowGen: (v: ShadowGenerator) => void;
}

const DayNightCtx = createContext<DayNightState>();

export function useDayNight(): DayNightState {
  const ctx = useContext(DayNightCtx);
  if (!ctx) throw new Error("useDayNight must be used within <DayNightProvider>");
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider — pure signals, no Babylon
// ---------------------------------------------------------------------------

export function DayNightProvider(props: ParentProps) {
  const [timeOfDay, setTimeOfDay] = createSignal(0.35);
  const [ambient, setAmbient] = createSignal(ramp(ambientStops, 0.35, lerp3));
  const [shadowGen, setShadowGen] = createSignal<ShadowGenerator>();

  const state: DayNightState = {
    timeOfDay,
    ambientColor: ambient,
    _setTimeOfDay: setTimeOfDay,
    shadowGenerator: shadowGen,
    _setAmbient: setAmbient,
    _setShadowGen: setShadowGen,
  };

  return <DayNightCtx.Provider value={state}>{props.children}</DayNightCtx.Provider>;
}

// ---------------------------------------------------------------------------
// Lights — Babylon lights + render loop (must be inside Canvas)
// ---------------------------------------------------------------------------

export default function DayNightLights(props: ParentProps) {
  const { scene } = useEngine();
  const { timeOfDay, _setTimeOfDay: setTimeOfDay, _setAmbient: setAmbient, _setShadowGen: setShadowGen } = useDayNight();

  // --- Lights ---
  // The sun by day and the moon by night, one light that casts; the sky's
  // light from all round is the environment (`sky.ts`).
  const sunLight = new DirectionalLight("sun", sunDirection(0.35), scene);
  sunLight.specular = Color3.Black();
  sunLight.autoUpdateExtends = false;

  // --- Shadow generator ---
  const engine = scene.getEngine();
  const shadowGen = new ShadowGenerator(shadowMapSize(engine), sunLight);
  shadowGen.usePercentageCloserFiltering = true;
  shadowGen.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  shadowGen.bias = 0.001;
  // Tree trunks are cylinders, so most of their surface sits at a grazing angle
  // to a low sun — the case a constant bias cannot cover without detaching the
  // shadows from the flat ground. Slope-scaled bias handles it per-fragment.
  shadowGen.normalBias = 0.02;
  setShadowGen(shadowGen);

  const sky = skyEnvironment(scene);
  // Bright light is drawn in, not cut off, its hue kept: a low sun stays
  // deep orange where it is strongest, rather than clipping to yellow.
  const look = scene.imageProcessingConfiguration;
  look.toneMappingEnabled = true;
  look.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL;
  look.exposure = EYE;

  const resizeObs = engine.onResizeObservable.add(() => {
    const size = shadowMapSize(engine);
    if (size !== shadowGen.mapSize) shadowGen.mapSize = size;
  });

  // --- Per-frame update ---
  let lastColorStep = -1;
  const obs = scene.onBeforeRenderObservable.add(() => {
    // The sun follows the simulation, not the render loop — so fast-forwarding
    // moves the light with the traffic, and a reconnect resumes the same hour.
    // In development `?t=` holds the light at a time of day (0 midnight,
    // 0.5 noon), to judge a look at an hour without moving the world's clock.
    const t = PINNED ?? simTimeOfDay();
    setTimeOfDay(t);

    const night = isNight(t);
    const elev = night ? moonElevation(t) : sunElevation(t);
    sunLight.direction = night ? moonDirection(t) : sunDirection(t);
    const sun = night ? moonLightAt(elev) : sunLightAt(elev);
    sunLight.diffuse = sunLight.specular = linearLight(sun.colour, sun.strength);

    // The sky is redrawn, and the flat things' tint walked over every
    // bucket, only when the quantized time moves: 1/1024 of a day is below
    // the 8-bit colour step, invisible, and ~8 times a second, not 60.
    const colorStep = Math.floor(t * 1024);
    if (colorStep !== lastColorStep) {
      lastColorStep = colorStep;
      const qt = colorStep / 1024;

      const amb = ramp(ambientStops, qt, lerp3);
      setAmbient(amb);

      const clear = ramp(skyStops, qt, lerp4);
      scene.clearColor.r = clear.r;
      scene.clearColor.g = clear.g;
      scene.clearColor.b = clear.b;
      scene.clearColor.a = clear.a;

      // Where the sun is, or last was, or will rise: the glow stays on its
      // side of the sky after it has set.
      const a = Math.min(Math.PI, Math.max(0, sunAngle(t)));
      sky.draw({
        zenith: linearLight(amb.multiply(SKY_LIGHT), SKY),
        glow: linearLight(ramp(glowStops, qt, lerp3), SKY),
        belt: linearLight(ramp(beltStops, qt, lerp3), SKY),
        sun: sunLight.diffuse,
        sunward: new Vector3(Math.cos(a), NORTH, 0).normalize(),
      });
    }

    // Round the ground in view, not round the camera: leaning back, the
    // camera stands well behind what it looks at.
    const { cx, cy, radius } = groundCover(scene, engine.getRenderingCanvas()!);
    const dir = sunLight.direction;
    sunLight.position.x = cx - dir.x * radius;
    sunLight.position.y = cy - dir.y * radius;
    sunLight.position.z = -dir.z * radius;
    sunLight.shadowMinZ = 0;
    sunLight.shadowMaxZ = radius * 2;
    sunLight.orthoLeft = -radius;
    sunLight.orthoRight = radius;
    sunLight.orthoTop = radius;
    sunLight.orthoBottom = -radius;
    // The ortho extents are plain fields — writing them does not invalidate the
    // cached projection. Babylon otherwise only rebuilds it when the light's
    // position or direction moves, so a zoom (camera still, extents changed)
    // would keep rendering the shadow map at the previous scale.
    sunLight.forceProjectionMatrixCompute();

    // Zoomed out far enough that shadows are sub-pixel, or the sun down and
    // its light at zero: skip the whole shadow pass rather than draw every
    // caster into a map nobody can read.
    sunLight.shadowEnabled = radius < SHADOW_MAX_RADIUS && elev > 0;
  });

  onCleanup(() => {
    scene.onBeforeRenderObservable.remove(obs);
    engine.onResizeObservable.remove(resizeObs);
    sky.dispose();
    shadowGen.dispose();
    sunLight.dispose();
  });

  return <>{props.children}</>;
}
