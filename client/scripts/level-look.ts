/**
 * A photograph of a level as it plays (`/interchange`), driven from here:
 * `bun scripts/level-look.ts <level> [steps.json]` opens it on the dev client
 * (SPRAWL_CLIENT_PORT, default 4800), lays the steps given, if any (a
 * JSON list of `Build`s), waits, photographs, tests, and photographs the
 * verdict, in .dev/look/.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { launch, open } from "./browser";

const [name = "01-first-road", stepsFile] = process.argv.slice(2);
const port = process.env.SPRAWL_CLIENT_PORT ?? "4800";
const out = new URL("../../.dev/look/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const browser = await launch();
const page = await open(browser, { width: 1280, height: 800 });
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && console.log(`[page ${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log("[page error]", e.message));
await page.goto(`http://localhost:${port}/interchange?l=${name}`);
await page.waitForFunction(() => (window as any).sprawlLevel?.state(), null, { timeout: 60_000 });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${out}${name}-empty.png` });
const steps = stepsFile ? JSON.parse(readFileSync(stepsFile, "utf8")) : null;
await page.evaluate((steps) => {
  const L = (window as any).sprawlLevel;
  for (const s of steps ?? []) L.line().send({ type: "Build", data: s });
}, steps);
await page.waitForTimeout(6000);
await page.screenshot({ path: `${out}${name}-built.png` });
await page.evaluate(() => (window as any).sprawlLevel.line().test());
await page.waitForTimeout(5000);
await page.screenshot({ path: `${out}${name}-testing.png` });
await page.evaluate(() => (window as any).sprawlLevel.line().finish());
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}${name}-done.png` });
console.log(JSON.stringify(await page.evaluate(() => (window as any).sprawlLevel.state())).slice(0, 400));
await browser.close();
