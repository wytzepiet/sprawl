/** The bench's phases, its reports and what they sum to: what
 *  `PerfReport.tsx` posts and `scripts/bench.ts` reads. */
/**
 * What the camera does, a phase a report: the first two are the land
 * coming in, not measured; then still, panning out over new land and back,
 * zooming in and out, and the whole town from far out.
 */
export const PHASES = ["settle", "settle", ...(["still", "pan", "zoom", "far"] as const).flatMap((p) => [p, p, p])];

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
