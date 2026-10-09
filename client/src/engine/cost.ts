import { crownsBaked } from "./trees";
import { renderFrame, setMeshVisible, setShadowGeneratorEnabled, setShadowTaskCasterMeshes, waitForGpuIdle, type EngineContext, type Mesh, type SceneContext, type ShadowGenerator } from "@babylonjs/lite";

/**
 * Development only: what each kind of thing in view costs a frame, found by
 * taking it away. The render loop is held while it measures, and frames are
 * drawn by hand, a run of them back to back and then waited on: a frame's
 * time, whichever of the CPU and the GPU is slower, and the CPU's alone.
 * (A GPU timer read frame by frame cannot keep up with a run, and a frame waited on
 * alone lets the GPU drop its clock between frames, so neither is used.) Each kind is then hidden, and
 * then kept out of the shadow map alone, and what the frame lost is its cost.
 * Conditions alternate round by round and the medians are taken, as the
 * laptop throttles; rounds go on until a further one moves no median by
 * more than `STEADY`, between two rounds and `rounds`. It first waits for
 * the scene to be ready: the crowns baked, and nothing more arriving.
 * `client/scripts/cost.ts` drives it from outside.
 *
 * A kind is a mesh's name with its chunk or tile taken out (`ground_3,-1`
 * is `ground_`), so every chunk's ground is one kind and a new kind of mesh
 * needs no list kept.
 */

/** Frames drawn before measuring a condition, and measured. */
const WARM = 4;
const FRAMES = 16;

export interface Kind {
  kind: string;
  meshes: number;
  /** Of those, drawn in the last frame. */
  inView: number;
  instances: number;
  triangles: number;
  /** Meshes of it the shadow map draws. */
  casters: number;
  /** Draw calls it makes a frame, all passes. */
  draws: number;
  /** What hiding it saved a frame, in ms: the frame (whichever of the CPU
   *  and the GPU is slower; the GPU, when the frame is well over the CPU's
   *  time), and the CPU's drawing of it. */
  frame: number;
  cpu: number;
  /** What keeping it out of the shadow map alone saved the whole frame. */
  shadow: number | null;
}

export interface CostReport {
  base: { frame: number; cpu: number; drawCalls: number; meshes: number; rounds: number };
  kinds: Kind[];
}

const kindOf = (m: Mesh) => m.name.replace(/-?\d+(\.\d+)?/g, "").replace(/[,#]+/g, "").replace(/_+/g, "_");
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? (s[(s.length - 1) / 2] ?? 0) : ((s[s.length / 2 - 1] ?? 0) + (s[s.length / 2] ?? 0)) / 2;
};
/** A round moving no condition's median by more than this, in ms, ends the run. */
const STEADY = 0.2;
/** The scene is ready when its meshes and their draws have held this long. */
const READY_MS = 1000;

export function costMeter(engine: EngineContext, scene: SceneContext, after: () => void, hold: (held: boolean) => void) {
  /** One frame drawn and handed to the GPU, not waited on. */
  function frame() {
    const t0 = performance.now();
    renderFrame(engine, 16);
    after();
    return { cpu: performance.now() - t0, draws: engine.drawCallCount };
  }

  const FIELDS = ["cpu", "frame", "draws"] as const;
  type Sample = Record<(typeof FIELDS)[number], number>;

  /** A run of frames back to back, as the game draws them, so the GPU
   *  keeps its clock up; then waited on. A frame's time is the run's over
   *  its length: whichever of the CPU and the GPU is the slower. */
  async function measure(): Promise<Sample> {
    for (let i = 0; i < WARM; i++) frame();
    await waitForGpuIdle(engine);
    const got: ReturnType<typeof frame>[] = [];
    const t0 = performance.now();
    for (let i = 0; i < FRAMES; i++) got.push(frame());
    await waitForGpuIdle(engine);
    const each = (performance.now() - t0) / FRAMES;
    return { cpu: median(got.map((g) => g.cpu)), draws: median(got.map((g) => g.draws)), frame: each };
  }

  /** Until the crowns are baked and nothing has come or gone a while:
   *  chunks, buildings and cars arriving at a fresh view. */
  async function ready() {
    await crownsBaked(engine);
    const state = () => `${scene.meshes.length},${(scene as unknown as { _renderables: unknown[] })._renderables.length}`;
    let [seen, since] = [state(), performance.now()];
    for (const end = performance.now() + 20_000; performance.now() < end && performance.now() - since < READY_MS; ) {
      await new Promise((r) => setTimeout(r, 100));
      if (state() !== seen) [seen, since] = [state(), performance.now()];
    }
  }

  return async function report(rounds = 5, only = ""): Promise<CostReport> {
    await ready();
    hold(true);
    try {
      await measure();
      // A shadow pass the game has switched off (zoomed out) is not measured,
      // or switching it back on would add a pass the game never draws.
      const sun = scene.lights.map((l) => l.shadowGenerator).find((g): g is ShadowGenerator => !!g && g._runtimeEnabledState?.enabled !== false);
      // The casters, as the shadow task holds them (development only, so its insides will do).
      const castList = (): Mesh[] => [...((sun as { _shadowTaskState?: { _casterMeshes: Mesh[] } } | undefined)?._shadowTaskState?._casterMeshes ?? [])];
      const casters = new Set(castList());
      // What the culler shows (`cull.ts`).
      const active = new Set(scene.meshes.filter((m) => m.visible !== false));
      const kinds = new Map<string, Mesh[]>();
      for (const m of scene.meshes) kinds.set(kindOf(m), [...(kinds.get(kindOf(m)) ?? []), m]);

      // Each kind's conditions measured right after the scene as it is, one
      // baseline for them all, round by round, and what each saved over it:
      // the laptop's drift between them is small, and the median over the
      // rounds drops a stray one.
      const bases: Sample[] = [];
      const saved = new Map<string, Sample[]>();
      const against = async (changes: [string, () => () => void][]) => {
        const base = await measure();
        bases.push(base);
        for (const [name, change] of changes) {
          const undo = change();
          const cut = await measure();
          undo();
          saved.set(name, [...(saved.get(name) ?? []), Object.fromEntries(FIELDS.map((f) => [f, base[f] - cut[f]])) as Sample]);
        }
      };
      const shown = [...kinds].filter(([kind, ms]) => kind.includes(only) && ms.some((m) => active.has(m) || casters.has(m)));
      // What belongs to no one mesh: the shadow map's pass as a whole.
      const whole: Record<string, () => () => void> = sun
        ? { "(shadow map)": () => (setShadowGeneratorEnabled(sun, false), () => setShadowGeneratorEnabled(sun, true)) }
        : {};
      const medians = () => new Map([...saved].map(([name, samples]) => [name, median(samples.map((x) => x.frame))]));
      let done = 0;
      for (let r = 0, before = medians(); r < rounds; r++, done = r) {
        for (const [kind, meshes] of shown) {
          const changes: [string, () => () => void][] = [
            [`hide ${kind}`, () => {
              const was = meshes.map((m) => m.visible !== false);
              meshes.forEach((m) => setMeshVisible(m, false));
              return () => meshes.forEach((m, i) => setMeshVisible(m, was[i]));
            }],
          ];
          if (sun && meshes.some((m) => casters.has(m))) {
            changes.push([`noshadow ${kind}`, () => {
              const list = castList();
              setShadowTaskCasterMeshes(sun, list.filter((m) => !meshes.includes(m)));
              return () => setShadowTaskCasterMeshes(sun, list);
            }]);
          }
          await against(changes);
        }
        if (!only && sun) await against(Object.entries(whole).map(([name, change]) => [`hide ${name}`, change]));
        const now = medians();
        if (r >= 1 && [...now].every(([name, m]) => Math.abs(m - (before.get(name) ?? Infinity)) <= STEADY)) {
          done = r + 1;
          break;
        }
        before = now;
      }
      const round = (x: number) => +x.toFixed(2);
      const of = (name: string, f: (typeof FIELDS)[number]) => round(median((saved.get(name) ?? []).map((s) => s[f])));
      const base = (f: (typeof FIELDS)[number]) => round(median(bases.map((b) => b[f])));
      return {
        base: { frame: base("frame"), cpu: base("cpu"), drawCalls: base("draws"), meshes: scene.meshes.length, rounds: done },
        kinds: [...[...kinds], ...Object.keys(whole).map((name) => [name, [] as Mesh[]] as const)]
          .map(([kind, meshes]) => {
            const instances = (m: Mesh) => m.thinInstances?.count ?? 1;
            return {
              kind,
              meshes: meshes.length,
              inView: meshes.filter((m) => active.has(m)).length,
              instances: meshes.reduce((n, m) => n + instances(m), 0),
              triangles: meshes.reduce((n, m) => n + (m._gpu.indexCount / 3) * instances(m), 0),
              casters: meshes.filter((m) => casters.has(m)).length,
              draws: of(`hide ${kind}`, "draws"),
              frame: of(`hide ${kind}`, "frame"),
              cpu: of(`hide ${kind}`, "cpu"),
              shadow: saved.has(`noshadow ${kind}`) ? of(`noshadow ${kind}`, "frame") : null,
            };
          })
          .sort((a, b) => b.frame - a.frame),
      };
    } finally {
      hold(false);
    }
  };
}
