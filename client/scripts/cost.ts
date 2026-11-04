/**
 * What each kind of thing in view costs a frame, in the running game.
 *
 *   bun run cost 6,80          round tile (6, 80), fifteen tiles each way up and down
 *   bun run cost 6,80,8        eight
 *   bun run cost 6,80 4,80,8   several views, the game loaded once
 *   --t 0.95                   at this time of day (0 midnight, 0.5 noon; default noon)
 *   --rounds 5                 the most times each condition is measured; fewer
 *                              when a round moves nothing (`cost.ts`)
 *   --only ground_             only the kinds whose name holds this (quicker)
 *   --q pbr=1                  more for the page's address
 *
 * Tiles are the game's, as `bun run look` takes them. The page draws its
 * frames by hand while it measures (`client/src/engine/cost.ts`): every kind
 * of mesh hidden in turn, and kept out of the shadow map in turn, and what
 * the frame lost is its cost. Prints a table and writes it, with the numbers,
 * to `.dev/cost/`. Desktop Chrome's WebGPU, at the size the benchmark uses.
 */
import { args, CLIENT, flag, launch, ROOT, word } from "./lib";
import { mkdirSync, writeFileSync } from "node:fs";
import type { CostReport } from "../src/engine/cost";
import { costLines } from "../src/engine/bench";

const OUT = `${ROOT}/.dev/cost`;

const t = flag("--t", 0.5);
const rounds = flag("--rounds", 5);
const only = word("--only") ?? "";
const q = word("--q");
const views = (args.length ? args : ["0,0"]).map((a) => a.split(",").map(Number)).map(([x, y, half = 15]) => ({ x, y, half }));

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
await page.goto(`${CLIENT}/?t=${t}${q ? `&${q}` : ""}`);
await page.waitForFunction(() => "sprawlCamera" in window && "sprawlCost" in window, null, { timeout: 60_000 });
for (const { x, y, half } of views) {
  await page.evaluate(([x, y, h]) => (window as any).sprawlCamera.look(x + 0.5, y + 0.5, h), [x, y, half]);
  // The meter waits for the view to be ready before it measures.
  const report: CostReport = await page.evaluate(([rounds, only]) => (window as any).sprawlCost(rounds, only), [rounds, only] as const);

  const lines = costLines(report, `${x},${y},${half} at t=${t}`);
  console.log(lines.join("\n"));
  mkdirSync(OUT, { recursive: true });
  const name = `${OUT}/${x}_${y}_${half}_t${t}`;
  writeFileSync(`${name}.txt`, lines.join("\n") + "\n");
  writeFileSync(`${name}.json`, JSON.stringify(report, null, 1));
  console.log(`→ ${name}.txt`);
}
await browser.close();
