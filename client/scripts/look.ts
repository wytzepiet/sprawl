/**
 * A photograph of the running game: a place, how much of it, and a short
 * run of frames for what a still cannot show (how a car steers).
 *
 *   bun run look 6,80         the game round tile (6, 80), ten tiles each way
 *   bun run look 6,80,4       four tiles each way
 *   --ui                      with the toolbar, cards and pins, as played
 *   --select 117              with the card of thing 117 open (and --ui)
 *   --menu                    with the build menu open (and --ui)
 *   --size 1024x768           the window, with --ui (1280x860 by default)
 *   --hold Depot@5,86[,1]     with a depot in hand over that tile, as if
 *                             dragged there, turned that way or left to
 *                             turn itself (and --ui)
 *   --tap '[title=Fold]'      a tap on what that selector finds, after the
 *                             settle, and as long again for it to move;
 *                             again for each (and --ui)
 *   --click 900,60            a tap at that point of the window, as --tap
 *   --eval 'js'               run in the page after the settle, before the taps:
 *                             `await import("/src/state/sea.ts")` reaches the game's modules
 *   --frames 8 --every 250    eight frames a quarter second apart, and a strip
 *                             of them side by side
 *   T=0.7 bun run look ...    at this time of day (0 midnight, 0.5 noon)
 *   PLAYER=4242 bun run look  as that player (`act`'s hand is 4242)
 *
 * Tiles are the game's, as `bun run plan --live` numbers them. Writes
 * `.dev/look/frame-<n>.png` and `.dev/look/strip.png`. The game is the one
 * `bun run dev` runs, or SPRAWL_CLIENT_PORT's, in `lib.ts`'s browser.
 */
import { args, CLIENT, flag, has, launch, open, ROOT, sheet, word } from "./lib";
import { mkdirSync, rmSync } from "node:fs";

const OUT = `${ROOT}/.dev/look`;
const VIEW = { width: 800, height: 800 };

/** Long enough for the chunks, the buildings and the cars to arrive; in
 *  software (`lib.ts`) far longer: `--settle 30000`. */
const SETTLE_MS = flag("--settle", 6000);
const frames = flag("--frames", 1);
const chosen = flag("--select", -1);
const every = flag("--every", 250);
const [x, y, half = 10] = (args[0] ?? "0,0").split(",").map(Number);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const held = word("--hold")?.match(/^(\w+)@(-?\d+),(-?\d+)(?:,(\d))?$/);
const menu = has("--menu");
const size = word("--size")?.split("x").map(Number) ?? [1280, 860];
const taps: string[] = [];
for (let t = word("--tap"); t; t = word("--tap")) taps.push(t);
for (let t = word("--click"); t; t = word("--click")) taps.push(`@${t}`);
const evals: string[] = [];
for (let t = word("--eval"); t; t = word("--eval")) evals.push(t);
const ui = has("--ui") || chosen >= 0 || !!held || menu || taps.length > 0;
const browser = await launch();
const page = ui ? await open(browser, { width: size[0], height: size[1] }) : await browser.newPage({ viewport: VIEW });
// As that player.
if (process.env.PLAYER) await page.addInitScript((p) => localStorage.setItem("sprawl.player", p), process.env.PLAYER);
page.on("pageerror",(e) => console.log(`page error: ${e.message}`));
page.on("console", (m) => m.type() === "error" && console.log(`console: ${m.text().slice(0, 300)}`));
const query = new URLSearchParams({ ...(process.env.T ? { t: process.env.T } : {}) });
await page.goto(`${CLIENT}/${query.size ? `?${query}` : ""}`);
await page.waitForFunction(() => "sprawlCamera" in window, null, { timeout: 60_000 });
// The map alone: no toolbar, dials or pins over it, unless asked for.
if (!ui) await page.waitForFunction(() => (window as any).sprawlLite?.hideUi() ?? false);
// The camera looks at a tile's middle; `look` takes the half height seen.
await page.evaluate(([x, y, h]) => (window as any).sprawlCamera.look(x + 0.5, y + 0.5, h), [x, y, half]);
if (chosen >= 0) await page.evaluate((id) => (window as any).sprawlSelect(id), chosen);
// The hand in a pose a photograph cannot drag it into (`Brush`).
await page.waitForTimeout(held || menu ? SETTLE_MS / 2 : 0);
if (held) await page.evaluate(([k, x, y, f]) => (window as any).sprawlHold(k, Number(x), Number(y), f === undefined ? null : Number(f)), held.slice(1));
if (menu) await page.keyboard.press("b");
await page.waitForTimeout(SETTLE_MS);
for (const js of evals) await page.evaluate(`(async () => { ${js} })()`);
if (evals.length) await page.waitForTimeout(4000);
for (const t of taps) {
  if (t.startsWith("@")) {
    const [cx, cy] = t.slice(1).split(",").map(Number);
    await page.mouse.click(cx, cy);
  } else await page.locator(t).first().click({ force: true });
  await page.waitForTimeout(SETTLE_MS);
}
for (let n = 0; n < frames; n++) {
  // Software rendering draws a tall frame slowly: room for it.
  await page.screenshot({ path: `${OUT}/frame-${n}.png`, timeout: 180_000 });
  if (n + 1 < frames) await page.waitForTimeout(every);
}
if (frames > 1) {
  const png = async (n: number) => Buffer.from(await Bun.file(`${OUT}/frame-${n}.png`).arrayBuffer()).toString("base64");
  const cells = await Promise.all(Array.from({ length: frames }, async (_, n) => `<figure><img src="data:image/png;base64,${await png(n)}"></figure>`));
  await sheet(await browser.newPage(), cells, Math.min(frames, 4), `${OUT}/strip.png`);
}
await browser.close();
console.log(`${frames} frame${frames > 1 ? "s" : ""} → ${OUT}/${frames > 1 ? "strip" : "frame-0"}.png`);
