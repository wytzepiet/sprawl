import { onCleanup } from "solid-js";
import { useEngine } from "./Canvas";

/** Things the game counts as it goes, by name, for the next report. */
const counts = new Map<string, number>();
export function perfCount(name: string, by = 1) {
  if (import.meta.env.DEV) counts.set(name, (counts.get(name) ?? 0) + by);
}

/** How often the tab reports, and how finely it samples its JavaScript. */
const EVERY_MS = 5000;
const SAMPLE_MS = 5;

/** The browser's sampling profiler, where the page has asked for it. */
interface ProfilerTrace {
  frames: { name: string; resourceId?: number; line?: number }[];
  stacks: { frameId: number; parentId?: number }[];
  samples: { stackId?: number; timestamp: number }[];
  resources: string[];
}
interface Profiler {
  stop(): Promise<ProfilerTrace>;
}
declare const Profiler: { new (options: { sampleInterval: number; maxBufferSize: number }): Profiler } | undefined;

/**
 * Development only: what this tab spends drawing, sent to the dev server
 * (`vite.config.ts`), which appends it to `.dev/perf.jsonl`, so how the game
 * runs in a player's own browser can be read from outside it. Every few
 * seconds: the frames' spread, worst gaps and all; the CPU's time on a frame
 * and the GPU's; the long animation frames and what ran in them; and a
 * sample of where the JavaScript went, by function.
 */
export default function PerfReport() {
  const { engine, scene } = useEngine();
  // The GPU's own timer, where the engine is WebGPU's and the GPU keeps one.
  const gpu = engine as typeof engine & { enableGPUTimingMeasurements?: boolean; gpuTimeInFrameForMainPass?: { counter: { lastSecAverage: number } } };
  gpu.enableGPUTimingMeasurements = true;

  let gaps: number[] = [];
  let cpu: number[] = [];
  let last = 0;
  let began = 0;
  const before = scene.onBeforeAnimationsObservable.add(() => (began = performance.now()));
  const after = scene.onAfterRenderObservable.add(() => {
    const now = performance.now();
    cpu.push(now - began);
    if (last) gaps.push(now - last);
    last = now;
  });

  // Long animation frames, and the scripts that ran in them.
  let long: { ms: number; scripts: { ms: number; what: string }[] }[] = [];
  const watch = new PerformanceObserver((list) => {
    for (const e of list.getEntries() as (PerformanceEntry & { scripts?: { duration: number; invoker?: string; sourceFunctionName?: string; sourceURL?: string; sourceCharPosition?: number }[] })[]) {
      long.push({
        ms: Math.round(e.duration),
        scripts: (e.scripts ?? []).map((s) => ({ ms: Math.round(s.duration), what: `${s.sourceFunctionName || s.invoker} ${s.sourceURL?.split("/").pop()?.split("?")[0] ?? ""}` })),
      });
    }
  });
  try {
    watch.observe({ type: "long-animation-frame", buffered: false });
  } catch {
    // Not every browser sees animation frames: then none are reported.
  }

  let profiler: Profiler | null = null;
  const sample = () => {
    try {
      profiler = typeof Profiler === "undefined" ? null : new Profiler({ sampleInterval: SAMPLE_MS, maxBufferSize: 100_000 });
    } catch {
      profiler = null;
    }
  };
  sample();

  /** Time in each function, its own and with what it called, of a trace. */
  const tally = (trace: ProfilerTrace) => {
    const own = new Map<string, number>();
    const all = new Map<string, number>();
    const name = (f: ProfilerTrace["frames"][number]) => `${f.name || "(anon)"} ${f.resourceId !== undefined ? trace.resources[f.resourceId].split("/").pop()!.split("?")[0] : ""}:${f.line ?? ""}`;
    for (const s of trace.samples) {
      if (s.stackId === undefined) continue;
      let at: number | undefined = s.stackId;
      const seen = new Set<string>();
      let first = true;
      while (at !== undefined) {
        const stack: ProfilerTrace["stacks"][number] = trace.stacks[at];
        const n = name(trace.frames[stack.frameId]);
        if (first) own.set(n, (own.get(n) ?? 0) + SAMPLE_MS);
        if (!seen.has(n)) all.set(n, (all.get(n) ?? 0) + SAMPLE_MS);
        seen.add(n);
        first = false;
        at = stack.parentId;
      }
    }
    const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 25);
    return { busyMs: trace.samples.filter((s) => s.stackId !== undefined).length * SAMPLE_MS, own: top(own), all: top(all) };
  };

  const report = async () => {
    const trace = profiler ? await profiler.stop() : null;
    sample();
    const sorted = [...gaps].sort((a, b) => a - b);
    const at = (q: number) => (sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(1) : 0);
    const mean = (a: number[]) => (a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2) : 0);
    const canvas = engine.getRenderingCanvas()!;
    const body = {
      at: new Date().toISOString(),
      seconds: EVERY_MS / 1000,
      frames: gaps.length,
      fps: +(gaps.length / (EVERY_MS / 1000)).toFixed(1),
      gap: { p50: at(0.5), p90: at(0.9), p99: at(0.99), max: at(1), over20: gaps.filter((g) => g > 20).length, over34: gaps.filter((g) => g > 34).length },
      cpuMs: { mean: mean(cpu), max: +Math.max(0, ...cpu).toFixed(1) },
      gpuMainMs: gpu.gpuTimeInFrameForMainPass ? +(gpu.gpuTimeInFrameForMainPass.counter.lastSecAverage / 1e6).toFixed(2) : null,
      canvas: [canvas.width, canvas.height],
      dpr: devicePixelRatio,
      scaling: engine.getHardwareScalingLevel(),
      visible: document.visibilityState,
      camera: { x: +scene.activeCamera!.position.x.toFixed(0), y: +scene.activeCamera!.position.y.toFixed(0), half: +(scene.activeCamera!.orthoTop ?? 0).toFixed(1) },
      meshes: { active: scene.getActiveMeshes().length, total: scene.meshes.length },
      long: long.sort((a, b) => b.ms - a.ms).slice(0, 6),
      counts: Object.fromEntries([...counts].map(([k, v]) => [k, Math.round(v)])),
      profile: trace ? tally(trace) : "unavailable",
      agent: navigator.userAgent,
    };
    [gaps, cpu, long] = [[], [], []];
    counts.clear();
    void fetch("/__perf", { method: "POST", body: JSON.stringify(body) });
  };
  const timer = setInterval(() => void report(), EVERY_MS);

  onCleanup(() => {
    clearInterval(timer);
    scene.onBeforeAnimationsObservable.remove(before);
    scene.onAfterRenderObservable.remove(after);
    watch.disconnect();
    void profiler?.stop();
  });

  return null;
}
