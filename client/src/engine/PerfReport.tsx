import { createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { isGpuTimingSupported, setGpuTimingEnabled } from "@babylonjs/lite";
import { useEngine } from "./Canvas";
import { eye } from "./Camera";
import { groundCover } from "./view";
import { lightOf, PHASES as LOOKED, POWER, summarise, type Report } from "./bench";
import { forced } from "./Canvas";
import { pinTimeOfDay } from "./DayNightCycle";
import { beamCount } from "./lights";
import { useGame } from "../state/gameObjects";
import { simNow } from "../network/clock";
import type { CostReport } from "./cost";

const params = new URLSearchParams(location.search);
const PHASES = params.has("power") ? POWER : LOOKED;
/**
 * The bench's run, by name: `?bench` (a name made up) or `?bench&tab=<name>`,
 * in any build, on any device. `?bench=x,y,half` where it looks.
 */
export const run = params.has("bench") ? (params.get("tab") ?? `bench-${Math.random().toString(36).slice(2, 7)}`) : null;

/** Things the game counts as it goes, by name, for the next report. */
const counts = new Map<string, number>();
export function perfCount(name: string, by = 1) {
  if (run) counts.set(name, (counts.get(name) ?? 0) + by);
}

/** How often the tab reports, and how finely it samples its JavaScript. */
const EVERY_MS = 5000;
const SAMPLE_MS = 5;
/** How much of a test town's day is lived through before the bench. */
const TRAFFIC_MS = 8 * 60_000;
/** How far out the far phase looks, in the still view's sizes. */
const FAR = 2.5;

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
 * The bench (`?bench`): the camera through its phases round one place, and
 * what the tab spends drawing in each, posted to the game's server
 * (`server/host/src/perf.rs`), so how the game runs on any device that opens
 * it can be read from outside it. Every few seconds: the frames' spread,
 * worst gaps and all; the CPU's time on a frame and the GPU's; the long
 * animation frames and what ran in them; and, where the browser samples, where
 * the JavaScript went, by function. At the end, the numbers on the screen.
 */
export default function PerfReport() {
  const { engine, scene, canvas, beforeRender, afterRender } = useEngine();
  const [x, y, h] = (params.get("bench") || "6,80,15").split(",").map(Number);
  let phase = 0;
  let phaseBegan = performance.now();
  const [done, setDone] = createSignal<Report[] | null>(null);
  const sent: Report[] = [];
  // A phone left alone would lock its screen half way.
  void (navigator as { wakeLock?: { request(t: string): Promise<unknown> } }).wakeLock?.request("screen").catch(() => {});
  let gpu = "?";
  void navigator.gpu?.requestAdapter({ powerPreference: "high-performance" }).then((a) => {
    // `info` since Chrome 127; before, it was asked for.
    const ask = (a as unknown as { requestAdapterInfo?: () => Promise<GPUAdapterInfo> } | null)?.requestAdapterInfo;
    void (a?.info ? Promise.resolve(a.info) : ask ? ask.call(a) : Promise.resolve(undefined)).then((i) => {
      if (i) gpu = [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(" ");
    });
  });
  // What went wrong, by message: a throw in a frame costs the frame, and a
  // phone's console is out of reach.
  let errors = new Map<string, number>();
  const caught = (e: ErrorEvent | PromiseRejectionEvent) => {
    const what = String("message" in e ? `${e.message}${e.filename ? ` ${e.filename.split("/").pop()}:${e.lineno}` : ""}` : (e.reason?.stack ?? e.reason)).slice(0, 300);
    errors.set(what, (errors.get(what) ?? 0) + 1);
  };
  addEventListener("error", caught);
  addEventListener("unhandledrejection", caught);
  // And the GPU's own complaints, which no page sees otherwise.
  const device = (engine as unknown as { _device: GPUDevice })._device;
  const gpuError = (e: Event) => caught({ message: `GPU: ${(e as GPUUncapturedErrorEvent).error.message}` } as ErrorEvent);
  device.addEventListener("uncapturederror", gpuError);
  void device.lost.then((l) => caught({ message: `GPU lost: ${l.reason} ${l.message}` } as ErrorEvent));
  // A test town's traffic comes in from its edges: the first minutes of it
  // lived through at once, so the streets are full when the bench begins.
  const { send } = useGame();
  let filled = 0;
  if (params.has("town")) setTimeout(() => send({ type: "RunTo", data: (filled = simNow() + (PHASES === POWER ? TRAFFIC_MS / 2 : TRAFFIC_MS)) }), 1000);
  const look = () => {
    if (phase >= PHASES.length) return;
    const t = (performance.now() - phaseBegan) / 1000;
    pinTimeOfDay(lightOf(PHASES[phase]));
    const p = PHASES[phase].replace("n-", "");
    // Looked at once and left: the rest of the power run stands still.
    if (POWER === PHASES && p !== "pan") return void (p === "settle" && eye.look(x, y, h));
    if (p === "pan") eye.look(x + h * 3 * Math.sin((Math.PI * t) / 7.5), y, h);
    else if (p === "zoom") eye.look(x, y, h * 2 ** (1.2 * Math.sin((2 * Math.PI * t) / 5)));
    else eye.look(x, y, p === "far" ? h * FAR : h);
  };
  const stopLook = beforeRender(look);
  // The GPU's own timer, where the GPU keeps one.
  const timed = isGpuTimingSupported(engine);
  if (timed) setGpuTimingEnabled(engine, true);
  let gpuMs: number[] = [];

  let gaps: number[] = [];
  let cpu: number[] = [];
  let last = 0;
  let began = 0;
  const stopBefore = beforeRender(() => (began = performance.now()));
  const stopAfter = afterRender(() => {
    const now = performance.now();
    cpu.push(now - began);
    if (timed) gpuMs.push(engine.gpuFrameTimeMs);
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
    const body: Report = {
      at: new Date().toISOString(),
      tab: run!,
      phase: PHASES[phase],
      gpu,
      seconds: EVERY_MS / 1000,
      frames: gaps.length,
      fps: +(gaps.length / (EVERY_MS / 1000)).toFixed(1),
      gap: { p50: at(0.5), p90: at(0.9), p99: at(0.99), max: at(1), over20: gaps.filter((g) => g > 20).length, over34: gaps.filter((g) => g > 34).length },
      cpuMs: { mean: mean(cpu), max: +Math.max(0, ...cpu).toFixed(1) },
      gpuMs: timed ? mean(gpuMs) : null,
      canvas: [canvas.width, canvas.height],
      dpr: devicePixelRatio,
      visible: document.visibilityState,
      camera: (({ cx, cy, halfH }) => ({ x: +cx.toFixed(0), y: +cy.toFixed(0), half: +halfH.toFixed(1) }))(groundCover(scene, canvas)),
      meshes: { total: scene.meshes.length },
      draws: engine.drawCallCount,
      long: long.sort((a, b) => b.ms - a.ms).slice(0, 6),
      errors: Object.fromEntries(errors),
      counts: Object.fromEntries([...counts, ["vehicles moving", beamCount()] as const].map(([k, v]) => [k, Math.round(v)])),
      profile: trace ? tally(trace) : "unavailable",
      agent: navigator.userAgent,
    };
    [gaps, cpu, long, gpuMs] = [[], [], [], []];
    errors = new Map();
    counts.clear();
    void fetch("/perf", { method: "POST", body: JSON.stringify(body) });
    sent.push(body);
    // The last settle lasts until the traffic has filled the streets and
    // the town is drawn: five seconds with no drawing of it.
    if (!(PHASES[phase] === "settle" && PHASES[phase + 1] !== "settle" && (simNow() < filled || body.counts["town.draws"]))) phase++;
    phaseBegan = performance.now();
    // Set here, not as the frame is drawn: a frame not drawn would never set it back.
    forced.fps = PHASES[phase] === "off" ? 0 : PHASES[phase] === "f60" ? 60 : null;
    if (phase === PHASES.length) {
      clearInterval(timer);
      setDone(sent);
      // Then what each kind of thing in view costs (`cost.ts`): close in,
      // as a street is built, by day, the shadows on, and by night, the
      // lights on; and the whole town by day, where the most is drawn. The
      // run is over once that is in.
      forced.fps = null;
      if (PHASES === POWER) return;
      eye.look(x, y, h / 2);
      const meter = (window as { sprawlCost?: (rounds: number) => Promise<CostReport> }).sprawlCost;
      const post = (phase: string) => (cost: CostReport) => fetch("/perf", { method: "POST", body: JSON.stringify({ at: new Date().toISOString(), tab: run, phase, cost }) });
      if (meter) {
        pinTimeOfDay(lightOf(""));
        void meter(3)
          .then(post("d-cost"))
          .then(() => (pinTimeOfDay(lightOf("n-")), meter(3)))
          .then(post("n-cost"))
          .then(() => (pinTimeOfDay(lightOf("")), eye.look(x, y, h * FAR), meter(3)))
          .then(post("cost"));
      }
    }
  };
  const timer = setInterval(() => void report(), EVERY_MS);

  onCleanup(() => {
    clearInterval(timer);
    stopBefore();
    stopAfter();
    stopLook();
    watch.disconnect();
    removeEventListener("error", caught);
    removeEventListener("unhandledrejection", caught);
    device.removeEventListener("uncapturederror", gpuError);
    void profiler?.stop();
  });

  const f1 = (v: number) => v.toFixed(1);
  return (
    <Show when={done()}>
      {(reports) => (
        <Portal>
          <div style={{ position: "fixed", inset: "auto 12px 12px 12px", "z-index": 1000, background: "#000", color: "#fff", "border-radius": "18px", padding: "14px 16px", font: "13px/1.5 ui-monospace, monospace" }}>
            <div>
              {run} · {reports()[0].canvas.join("×")} @{reports()[0].dpr}x · {reports()[0].gpu}
            </div>
            <For each={summarise(reports())}>
              {(s) => (
                <div>
                  {s.phase.padEnd(6, "\u00a0")} {f1(s.fps)} fps · p90 {f1(s.p90)} ms · cpu {f1(s.cpu)} · gpu {s.gpu === null ? "?" : f1(s.gpu)} ms
                </div>
              )}
            </For>
          </div>
        </Portal>
      )}
    </Show>
  );
}
