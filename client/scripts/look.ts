/**
 * A photograph of the running game: a place, how much of it, and a short
 * run of frames for what a still cannot show (how a car steers).
 *
 *   bun run look 6,80         the game round tile (6, 80), ten tiles each way
 *   bun run look 6,80,4       four tiles each way
 *   --frames 8 --every 250    eight frames a quarter second apart, and a strip
 *                             of them side by side
 *   T=0.7 bun run look ...    at this time of day (0 midnight, 0.5 noon)
 *
 * Tiles are the game's, as `bun run plan --live` numbers them. Writes
 * `.dev/look/frame-<n>.png` and `.dev/look/strip.png`. The game is the one
 * `bun run dev` runs, or SPRAWL_CLIENT_PORT's, in `browser.ts`'s browser.
 */
import { launch } from "./browser";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const OUT = `${ROOT}/.dev/look`;
const CLIENT = `http://localhost:${process.env.SPRAWL_CLIENT_PORT ?? 4800}`;
const VIEW = { width: 800, height: 800 };

const args = process.argv.slice(2);
const flag = (name: string, or: number) => {
  const i = args.indexOf(name);
  return i < 0 ? or : Number(args.splice(i, 2)[1]);
};
/** Long enough for the chunks, the buildings and the cars to arrive; in
 *  software (`browser.ts`) far longer: `--settle 30000`. */
const SETTLE_MS = flag("--settle", 6000);
const frames = flag("--frames", 1);
const every = flag("--every", 250);
const [x, y, half = 10] = (args[0] ?? "0,0").split(",").map(Number);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await launch();
const page = await browser.newPage({ viewport: VIEW });
page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
page.on("console", (m) => m.type() === "error" && console.log(`console: ${m.text().slice(0, 300)}`));
await page.goto(process.env.T ? `${CLIENT}/?t=${process.env.T}` : CLIENT);
await page.waitForFunction(() => "sprawlCamera" in window, null, { timeout: 60_000 });
// The map alone: no toolbar, dials or pins over it.
await page.addStyleTag({ content: "#root * { visibility: hidden } #root canvas { visibility: visible }" });
// The camera looks at a tile's middle; `look` takes the half height seen.
await page.evaluate(([x, y, h]) => (window as any).sprawlCamera.look(x + 0.5, y + 0.5, h), [x, y, half]);
await page.waitForTimeout(SETTLE_MS);
for (let n = 0; n < frames; n++) {
  await page.screenshot({ path: `${OUT}/frame-${n}.png` });
  if (n + 1 < frames) await page.waitForTimeout(every);
}
if (frames > 1) {
  const png = async (n: number) => Buffer.from(await Bun.file(`${OUT}/frame-${n}.png`).arrayBuffer()).toString("base64");
  const cells = (await Promise.all(Array.from({ length: frames }, async (_, n) => `<img src="data:image/png;base64,${await png(n)}">`))).join("");
  const strip = await browser.newPage({ viewport: { width: 400 * Math.min(frames, 4), height: 400 } });
  await strip.setContent(`<style>body{margin:0;display:grid;grid-template-columns:repeat(${Math.min(frames, 4)},400px);gap:2px;background:#fff}img{width:400px}</style>${cells}`);
  await strip.screenshot({ path: `${OUT}/strip.png`, fullPage: true });
}
await browser.close();
console.log(`${frames} frame${frames > 1 ? "s" : ""} → ${OUT}/${frames > 1 ? "strip" : "frame-0"}.png`);
