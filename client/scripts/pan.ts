/**
 * How the game runs while it is moved about: frames, the CPU's and the
 * GPU's time on them, long frames, and where the JavaScript went, phase by
 * phase, from the tab's own reports (`PerfReport.tsx`, `.dev/perf.jsonl`).
 *
 *   bun run pan              round tile (6, 80), fifteen tiles each way up and down
 *   bun run pan 6,80,8       eight
 *   --t 0.95                 at this time of day (default noon)
 *   --phase 15               seconds a phase
 *
 * Its own Chrome, at the size `cost` uses, driven by the mouse as a player
 * drives it: still; then panning, drag after drag one way, so new land
 * comes in as it does in play; then zooming in and out with the wheel.
 * Desktop Chrome's WebGPU.
 */
import { launch } from "./browser";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const CLIENT = `http://localhost:${process.env.SPRAWL_CLIENT_PORT ?? 4800}`;
const [W, H] = [1200, 800];

const args = process.argv.slice(2);
const flag = (name: string, or: number) => {
  const i = args.indexOf(name);
  return i < 0 ? or : Number(args.splice(i, 2)[1]);
};
const t = flag("--t", 0.5);
const PHASE_MS = flag("--phase", 15) * 1000;
const [x, y, half = 15] = (args[0] ?? "6,80").split(",").map(Number);
const tab = `pan-${Date.now()}`;

const browser = await launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
await page.goto(`${CLIENT}/?t=${t}&tab=${tab}`);
await page.waitForFunction(() => "sprawlCamera" in window, null, { timeout: 60_000 });
await page.evaluate(([x, y, h]) => (window as any).sprawlCamera.look(x + 0.5, y + 0.5, h), [x, y, half]);
await page.waitForTimeout(8000);

const phases: { name: string; from: number; to: number }[] = [];
const phase = async (name: string, run: (until: number) => Promise<void>) => {
  const from = Date.now();
  await run(from + PHASE_MS);
  phases.push({ name, from, to: Date.now() });
};
const frame = () => page.waitForTimeout(16);

await phase("still", async (until) => {
  while (Date.now() < until) await page.waitForTimeout(250);
});
// Drag after drag to the left, a third of the screen in half a second, so
// the view travels on over new land.
await phase("panning", async (until) => {
  while (Date.now() < until) {
    await page.mouse.move(W * 0.8, H / 2);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(W * 0.8 - (W * 0.35 * i) / 30, H / 2 + Math.sin(i / 5) * 20);
      await frame();
    }
    await page.mouse.up();
  }
});
// In and out with the wheel, about the middle, a notch a frame.
await phase("zooming", async (until) => {
  await page.mouse.move(W / 2, H / 2);
  for (let i = 0; Date.now() < until; i++) {
    await page.mouse.wheel(0, Math.floor(i / 60) % 2 ? 40 : -40);
    await frame();
  }
});
await page.waitForTimeout(6000);
await browser.close();

interface Report {
  at: string;
  tab?: string | null;
  fps: number;
  gap: { p50: number; p90: number; p99: number; max: number; over34: number };
  cpuMs: { mean: number; max: number };
  gpuMs: number | null;
  draws: number;
  long: { ms: number; scripts: { ms: number; what: string }[] }[];
  profile: { busyMs: number; own: [string, number][] } | string;
  counts?: Record<string, number>;
}
const reports: Report[] = readFileSync(`${ROOT}/.dev/perf.jsonl`, "utf8")
  .split("\n")
  .filter((l) => l.includes(tab))
  .map((l) => JSON.parse(l));
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const f1 = (v: number) => v.toFixed(1);
for (const { name, from, to } of phases) {
  // A report covers the five seconds before it: those wholly within the phase.
  const mine = reports.filter((r) => Date.parse(r.at) - 5000 >= from - 250 && Date.parse(r.at) <= to + 250);
  if (!mine.length) {
    console.log(`${name}: no report fell wholly within it (lengthen --phase)`);
    continue;
  }
  const own = new Map<string, number>();
  for (const r of mine) if (typeof r.profile !== "string") for (const [what, ms] of r.profile.own) own.set(what, (own.get(what) ?? 0) + ms);
  const busy = mean(mine.map((r) => (typeof r.profile === "string" ? 0 : r.profile.busyMs))) / 5000;
  console.log(
    `${name.padEnd(8)} ${f1(mean(mine.map((r) => r.fps)))} fps, gaps p90 ${f1(Math.max(...mine.map((r) => r.gap.p90)))} max ${f1(Math.max(...mine.map((r) => r.gap.max)))} ms, over 34 ms ${mine.reduce((s, r) => s + r.gap.over34, 0)}; ` +
      `CPU ${f1(mean(mine.map((r) => r.cpuMs.mean)))} ms (max ${f1(Math.max(...mine.map((r) => r.cpuMs.max)))}), GPU ${mine[0].gpuMs === null ? "?" : f1(mean(mine.map((r) => r.gpuMs ?? 0)))} ms a frame; JS busy ${(busy * 100).toFixed(0)}%; ${mine.length} reports`,
  );
  const top = [...own].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (top.length) console.log(`         JS: ${top.map(([w, ms]) => `${w} ${ms}`).join(", ")}`);
  const counted = new Map<string, number>();
  for (const r of mine) for (const [k, v] of Object.entries(r.counts ?? {})) counted.set(k, (counted.get(k) ?? 0) + v);
  if (counted.size) console.log(`         counted: ${[...counted].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const worst = mine.flatMap((r) => r.long).sort((a, b) => b.ms - a.ms)[0];
  if (worst) console.log(`         longest frame ${worst.ms} ms: ${worst.scripts.slice(0, 3).map((s) => `${s.what} ${s.ms}`).join(", ") || "no script"}`);
}
