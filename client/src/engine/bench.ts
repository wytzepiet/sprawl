/** The bench's phases, its reports and what they sum to: what
 *  `PerfReport.tsx` posts and `scripts/bench.ts` reads. */
/**
 * What the camera does, a phase a report: the first four are the land
 * coming in and a test town's traffic filling its streets, not measured;
 * then still, panning out over new land and back, zooming in and out, and
 * the whole town from far out, by day and again by night (`n-`), its lamps
 * and headlights on.
 */
const LOOKS = ["still", "pan", "zoom", "far"] as const;
export const PHASES = ["settle", "settle", "settle", "settle", ...["", "n-"].flatMap((night) => LOOKS.flatMap((p) => [`${night}${p}`, `${night}${p}`, `${night}${p}`]))];
/** `?bench&power`: the camera held still, and the frames drawn each way in
 *  turn, for a phone's power meters to read (bench/android): as played at
 *  rest, nothing drawn at all, every frame drawn, panning, and at night. */
export const POWER = ["settle", "settle", "settle", "settle", ...["rest", "off", "f60", "pan", "n-rest"].flatMap((p) => Array<string>(12).fill(p))];
/** The light each kind of phase is drawn in: noon, or nearly midnight. */
export const lightOf = (phase: string) => (phase.startsWith("n-") ? 0.95 : 0.5);

import type { CostReport } from "./cost";

/** A report, a line of the game's `/perf`. */
export interface Report {
  at: string;
  tab: string;
  phase: string;
  gpu: string;
  seconds: number;
  frames: number;
  fps: number;
  gap: { p50: number; p90: number; p99: number; max: number; over20: number; over34: number };
  cpuMs: { mean: number; max: number };
  gpuMs: number | null;
  canvas: [number, number];
  dpr: number;
  visible: DocumentVisibilityState;
  camera: { x: number; y: number; half: number };
  meshes: { total: number };
  draws: number;
  long: { ms: number; scripts: { ms: number; what: string }[] }[];
  errors?: Record<string, number>;
  counts: Record<string, number>;
  profile: { busyMs: number; own: [string, number][]; all: [string, number][] } | "unavailable";
  agent: string;
}

/** A phase's reports, as one line of numbers. */
export function summarise(reports: Report[]) {
  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const phases = [...new Set(reports.map((r) => r.phase))].filter((p) => p !== "settle");
  return phases.map((phase) => {
    const mine = reports.filter((r) => r.phase === phase);
    return {
      phase,
      fps: mean(mine.map((r) => r.fps)),
      p90: Math.max(...mine.map((r) => r.gap.p90)),
      worst: Math.max(...mine.map((r) => r.gap.max)),
      cpu: mean(mine.map((r) => r.cpuMs.mean)),
      gpu: mine[0].gpuMs === null ? null : mean(mine.map((r) => r.gpuMs ?? 0)),
      draws: mean(mine.map((r) => r.draws)),
      reports: mine,
    };
  });
}

/** What the cost meter found (`cost.ts`), as a table: posted at the end of a
 *  bench, and what `bun run cost` prints. */
export function costLines(report: CostReport, title: string) {
  const pad = (s: string | number, n: number) => String(s).padStart(n);
  return [
    `${title}: frame ${report.base.frame} ms (CPU ${report.base.cpu}), ${report.base.drawCalls} draw calls, ${report.base.meshes} meshes, ${report.base.rounds} rounds`,
    "",
    `${"kind".padEnd(28)}${pad("meshes", 7)}${pad("in view", 8)}${pad("inst", 8)}${pad("tris", 9)}${pad("cast", 6)}${pad("draws", 7)}${pad("frame", 8)}${pad("cpu", 7)}${pad("shadow", 8)}`,
    ...report.kinds.map((k) =>
      `${k.kind.slice(0, 27).padEnd(28)}${pad(k.meshes, 7)}${pad(k.inView, 8)}${pad(k.instances, 8)}${pad(Math.round(k.triangles), 9)}${pad(k.casters, 6)}${pad(k.draws, 7)}${pad(k.frame.toFixed(2), 8)}${pad(k.cpu.toFixed(2), 7)}${pad(k.shadow === null ? "" : k.shadow.toFixed(2), 8)}`,
    ),
    "",
    "ms a frame saved by hiding it (frame: whichever of CPU and GPU is slower, so the GPU when the frame is well over the CPU; cpu: drawing it), and by keeping it out of the shadow map alone (shadow, frame).",
  ];
}
