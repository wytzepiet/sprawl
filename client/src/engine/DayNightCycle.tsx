import {
  createSignal,
  createContext,
  useContext,
  onCleanup,
  type ParentProps,
} from "solid-js";
import {
  Color3,
  Color4,
  Vector3,
  DirectionalLight,
  HemisphericLight,
  ShadowGenerator,
} from "@babylonjs/core";
import { useEngine } from "./Canvas";

// ---------------------------------------------------------------------------
// Time config
// ---------------------------------------------------------------------------

/** Real seconds for one full game day. */
const DAY_DURATION_SECONDS = 120;

// ---------------------------------------------------------------------------
// Color palette per time-of-day
// ---------------------------------------------------------------------------

const AMB_MIDNIGHT = new Color3(0.35, 0.35, 0.5);
const AMB_DAWN = new Color3(0.85, 0.55, 0.35);
const AMB_NOON = new Color3(0.82, 0.82, 0.8);
const AMB_DUSK = new Color3(0.85, 0.45, 0.3);

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

// t: 0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk

const ambientStops: [number, Color3][] = [
  [0.0, AMB_MIDNIGHT],
  [0.2, AMB_MIDNIGHT],
  [0.28, AMB_DAWN],
  [0.38, AMB_NOON],
  [0.62, AMB_NOON],
  [0.72, AMB_DUSK],
  [0.8, AMB_MIDNIGHT],
  [1.0, AMB_MIDNIGHT],
];

const skyStops: [number, Color4][] = [
  [0.0, SKY_MIDNIGHT],
  [0.2, SKY_MIDNIGHT],
  [0.28, SKY_DAWN],
  [0.38, SKY_NOON],
  [0.62, SKY_NOON],
  [0.72, SKY_DUSK],
  [0.8, SKY_MIDNIGHT],
  [1.0, SKY_MIDNIGHT],
];

/** Sun elevation: 0 at horizon, 1 at zenith. 0 during night. */
function sunElevation(t: number): number {
  if (t < 0.25 || t > 0.75) return 0;
  return Math.sin(((t - 0.25) / 0.5) * Math.PI);
}

function sunDirection(t: number): Vector3 {
  if (t < 0.25 || t > 0.75) return new Vector3(0, -0.4, -1).normalize();
  const angle = ((t - 0.25) / 0.5) * Math.PI; // 0=dawn, π/2=noon, π=dusk
  const elev = Math.max(Math.sin(angle), 0.15);
  const horiz = Math.cos(angle);
  // Sun comes from slightly above (positive Y), so shadows fall downward on screen
  return new Vector3(-horiz, -0.4, -elev).normalize();
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface DayNightState {
  timeOfDay: () => number;
  /** Ambient tint for custom shaders (grid). */
  ambientColor: () => Color3;
  shadowGenerator: ShadowGenerator;
}

const DayNightCtx = createContext<DayNightState>();

export function useDayNight(): DayNightState {
  const ctx = useContext(DayNightCtx);
  if (!ctx) throw new Error("useDayNight must be used within <DayNightCycle>");
  return ctx;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DayNightCycle(props: ParentProps) {
  const { scene } = useEngine();

  const [timeOfDay, setTimeOfDay] = createSignal(0.35);
  const [ambient, setAmbient] = createSignal(ramp(ambientStops, 0.35, lerp3));

  // --- Lights ---

  // Hemisphere light: ambient fill (always on, color varies with time)
  const hemiLight = new HemisphericLight("hemi", new Vector3(0, 0, 1), scene);
  hemiLight.intensity = 0.65;
  hemiLight.specular = Color3.Black();

  // Directional light: sun (casts shadows, direction/intensity vary with time)
  const sunLight = new DirectionalLight("sun", sunDirection(0.35), scene);
  sunLight.intensity = 0.4 * sunElevation(0.35);
  sunLight.specular = Color3.Black();
  sunLight.autoUpdateExtends = false;

  // --- Shadow generator ---
  const shadowGen = new ShadowGenerator(4096, sunLight);
  shadowGen.usePercentageCloserFiltering = true;
  shadowGen.filteringQuality = ShadowGenerator.QUALITY_LOW;
  shadowGen.bias = 0.001;

  // --- Per-frame update ---
  const camera = scene.activeCamera!;
  const obs = scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    let t = timeOfDay() + dt / DAY_DURATION_SECONDS;
    if (t >= 1) t -= 1;
    setTimeOfDay(t);

    const amb = ramp(ambientStops, t, lerp3);
    setAmbient(amb);

    // Hemisphere light color tracks ambient
    hemiLight.diffuse = amb;

    // Sun direction and intensity
    const elev = sunElevation(t);
    sunLight.direction = sunDirection(t);
    sunLight.intensity = 0.4 * elev;

    // Sun orbits camera center at a radius derived from the ortho view size
    const orthoW = camera.orthoRight! - camera.orthoLeft!;
    const orthoH = camera.orthoTop! - camera.orthoBottom!;
    const radius = Math.max(orthoW, orthoH) / 2;
    const dir = sunLight.direction;
    sunLight.position.x = camera.position.x - dir.x * radius;
    sunLight.position.y = camera.position.y - dir.y * radius;
    sunLight.position.z = -dir.z * radius;
    sunLight.shadowMinZ = 0;
    sunLight.shadowMaxZ = radius * 2;
    sunLight.orthoLeft = -radius;
    sunLight.orthoRight = radius;
    sunLight.orthoTop = radius;
    sunLight.orthoBottom = -radius;

    // Scene background
    const sky = ramp(skyStops, t, lerp4);
    scene.clearColor.r = sky.r;
    scene.clearColor.g = sky.g;
    scene.clearColor.b = sky.b;
    scene.clearColor.a = sky.a;
  });

  onCleanup(() => {
    scene.onBeforeRenderObservable.remove(obs);
    hemiLight.dispose();
    shadowGen.dispose();
    sunLight.dispose();
  });

  const state: DayNightState = {
    timeOfDay,
    ambientColor: ambient,
    shadowGenerator: shadowGen,
  };

  return <DayNightCtx value={state}>{props.children}</DayNightCtx>;
}
