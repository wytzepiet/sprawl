/**
 * What each kind of thing in view costs a frame, in the running game.
 *
 *   bun run cost 6,80          round tile (6, 80), fifteen tiles each way up and down
 *   bun run cost 6,80,8        eight
 *   --t 0.95                   at this time of day (0 midnight, 0.5 noon; default noon)
 *   --rounds 3                 how many times each condition is measured
 *   --only ground_             only the kinds whose name holds this (quicker)
 *   --q pbr=1                  more for the page's address
 *
 * Tiles are the game's, as `bun run look` takes them. The page draws its
 * frames by hand while it measures (`client/src/engine/cost.ts`): every kind
 * of mesh hidden in turn, and kept out of the shadow map in turn, and what
 * the frame lost is its cost. Prints a table and writes it, with the numbers,
 * to `.dev/cost/`. Desktop Chrome's WebGPU, at the size the benchmark uses.
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CostReport } from "../src/engine/cost";

const ROOT = resolve(import.meta.dir, "../..");
const OUT = `${ROOT}/.dev/cost`;
const CLIENT = `http://localhost:${process.env.SPRAWL_CLIENT_PORT ?? 4800}`;
/** Long enough for the chunks, the buildings and the cars to arrive. */
const SETTLE_MS = 6000;

const args = process.argv.slice(2);
const flag = (name: string, or: number) => {
  const i = args.indexOf(name);
  return i < 0 ? or : Number(args.splice(i, 2)[1]);
};
const t = flag("--t", 0.5);
const rounds = flag("--rounds", 3);
const text = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? "" : args.splice(i, 2)[1];
};
const only = text("--only");
const q = text("--q");
const [x, y, half = 15] = (args[0] ?? "0,0").split(",").map(Number);

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-webgpu"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
await page.goto(`${CLIENT}/?t=${t}${q ? `&${q}` : ""}`);
await page.waitForFunction(() => "sprawlCamera" in window && "sprawlCost" in window, null, { timeout: 60_000 });
await page.evaluate(([x, y, h]) => (window as any).sprawlCamera.look(x + 0.5, y + 0.5, h), [x, y, half]);
await page.waitForTimeout(SETTLE_MS);
const report: CostReport = await page.evaluate(([rounds, only]) => (window as any).sprawlCost(rounds, only), [rounds, only] as const);
await browser.close();

const pad = (s: string | number, n: number) => String(s).padStart(n);
const lines = [
  `${x},${y},${half} at t=${t}: frame ${report.base.frame} ms (CPU ${report.base.cpu}), ${report.base.drawCalls} draw calls, ${report.base.meshes} meshes`,
  "",
  `${"kind".padEnd(28)}${pad("meshes", 7)}${pad("in view", 8)}${pad("inst", 8)}${pad("tris", 9)}${pad("cast", 6)}${pad("draws", 7)}${pad("frame", 8)}${pad("cpu", 7)}${pad("shadow", 8)}`,
  ...report.kinds.map((k) =>
    `${k.kind.slice(0, 27).padEnd(28)}${pad(k.meshes, 7)}${pad(k.inView, 8)}${pad(k.instances, 8)}${pad(Math.round(k.triangles), 9)}${pad(k.casters, 6)}${pad(k.draws, 7)}${pad(k.frame.toFixed(2), 8)}${pad(k.cpu.toFixed(2), 7)}${pad(k.shadow === null ? "" : k.shadow.toFixed(2), 8)}`,
  ),
  "",
  "ms a frame saved by hiding it (frame: whichever of CPU and GPU is slower, so the GPU when the frame is well over the CPU; cpu: drawing it), and by keeping it out of the shadow map alone (shadow, frame).",
];
console.log(lines.join("\n"));
mkdirSync(OUT, { recursive: true });
const name = `${OUT}/${x}_${y}_${half}_t${t}`;
writeFileSync(`${name}.txt`, lines.join("\n") + "\n");
writeFileSync(`${name}.json`, JSON.stringify(report, null, 1));
console.log(`→ ${name}.txt`);
