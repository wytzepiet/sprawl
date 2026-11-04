/**
 * The bench (`src/engine/PerfReport.tsx`): the camera through its phases
 * round one place, still, panning, zooming and far out, and each phase's
 * frames, the CPU's and the GPU's time on them, long frames, and where the
 * JavaScript went, from the reports the page posts to its game's `/perf`.
 * Any device runs it by opening the game with `?bench`; this reads it.
 *
 *   bun run bench                    in its own Chrome, on the dev client
 *   bun run bench 6,80,8             round that tile, eight tiles each way
 *   --url https://x.preview.sprawl.nl   on that game instead
 *   --t 0.95                         at this time of day (default noon)
 *   --read bench-k3x9a               a run another device made, as its
 *                                    screen showed it at the end
 *   --runs                           the runs that game has, newest last
 */
import { args, CLIENT, flag, has, launch, word } from "./lib";
import { summarise, type Report } from "../src/engine/bench";

const url = (word("--url") ?? CLIENT).replace(/\/$/, "");
const read = word("--read");
const t = flag("--t", 0.5);
const fetchRuns = async (tab?: string): Promise<Report[]> =>
  (await (await fetch(`${url}/perf${tab ? `?tab=${tab}` : ""}`)).text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

if (has("--runs")) {
  for (const r of await fetchRuns()) console.log(`${r.tab.padEnd(16)} ${r.at}  ${r.gpu}  ${r.agent}`);
  process.exit(0);
}

let tab = read;
if (!tab) {
  tab = `bench-${Date.now()}`;
  const where = args[0] ?? "6,80,15";
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  await page.goto(`${url}/?t=${t}&bench=${where}&tab=${tab}`);
  // Two reports settling and four phases of three, five seconds each.
  for (let n = 0; n < 14; ) {
    await page.waitForTimeout(5000);
    const now = (await fetchRuns(tab)).length;
    if (now === n && now > 0) console.log(`no report in five seconds after ${n}`);
    n = now;
    process.stdout.write(`\r${n}/14 reports`);
  }
  console.log();
  await browser.close();
}

const reports = await fetchRuns(tab);
if (!reports.length) throw new Error(`no reports for ${tab} at ${url}`);
const [first] = reports;
console.log(`${tab}: ${first.canvas.join("×")} at ${first.dpr}x, ${first.gpu}\n${first.agent}`);
const f1 = (v: number) => v.toFixed(1);
for (const s of summarise(reports)) {
  const mine = s.reports;
  const busy = mine.reduce((a, r) => a + (typeof r.profile === "string" ? 0 : r.profile.busyMs), 0) / (mine.length * 5000);
  console.log(
    `${s.phase.padEnd(6)} ${f1(s.fps)} fps, gaps p90 ${f1(s.p90)} max ${f1(s.worst)} ms, over 34 ms ${mine.reduce((a, r) => a + r.gap.over34, 0)}; ` +
      `CPU ${f1(s.cpu)} ms, GPU ${s.gpu === null ? "?" : f1(s.gpu)} ms a frame; ${Math.round(s.draws)} draws; JS busy ${(busy * 100).toFixed(0)}%`,
  );
  const own = new Map<string, number>();
  for (const r of mine) if (typeof r.profile !== "string") for (const [what, ms] of r.profile.own) own.set(what, (own.get(what) ?? 0) + ms);
  const top = [...own].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (top.length) console.log(`       JS: ${top.map(([w, ms]) => `${w} ${ms}`).join(", ")}`);
  const counted = new Map<string, number>();
  for (const r of mine) for (const [k, v] of Object.entries(r.counts ?? {})) counted.set(k, (counted.get(k) ?? 0) + v);
  if (counted.size) console.log(`       counted: ${[...counted].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const errors = new Map<string, number>();
  for (const r of mine) for (const [k, v] of Object.entries(r.errors ?? {})) errors.set(k, (errors.get(k) ?? 0) + v);
  for (const [what, n] of errors) console.log(`       error ×${n}: ${what}`);
  const worst = mine.flatMap((r) => r.long).sort((a, b) => b.ms - a.ms)[0];
  if (worst) console.log(`       longest frame ${worst.ms} ms: ${worst.scripts.slice(0, 3).map((s) => `${s.what} ${s.ms}`).join(", ") || "no script"}`);
}
