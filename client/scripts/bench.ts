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
 *   --town 15-city                   on that test town (`server/fixtures`),
 *                                    run in the tab, not the server's world
 *   --params lag                     more of the page's query
 *   --read bench-k3x9a               a run another device made, as its
 *                                    screen showed it at the end
 *   --runs                           the runs that game has, newest last
 *   --compare <tabA> <tabB>          two runs side by side, phase by phase,
 *                                    and B over A (two `bench.yml` runs)
 */
import { args, CLIENT, flag, has, launch, word } from "./lib";
import { costLines, PHASES, summarise, type Report } from "../src/engine/bench";
import type { CostReport } from "../src/engine/cost";

const at = args.indexOf("--compare");
const compare = at < 0 ? null : args.splice(at, 3).slice(1);
const url = (word("--url") ?? CLIENT).replace(/\/$/, "");
const read = word("--read");
const town = word("--town");
const t = flag("--t", 0.5);
const params = word("--params");
const fetchRuns = async (tab?: string): Promise<Report[]> =>
  (await (await fetch(`${url}/perf${tab ? `?tab=${tab}` : ""}`)).text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

if (compare) {
  const [a, b] = await Promise.all(compare.map(async (tab) => {
    const reports = (await fetchRuns(tab)).filter((r) => !r.phase.endsWith("cost"));
    if (!reports.length) throw new Error(`no reports for ${tab} at ${url}`);
    const r = reports[0];
    console.log(`${tab}: ${r.canvas.join("×")} at ${r.dpr}x, ${r.gpu}`);
    return summarise(reports);
  }));
  // A phase's numbers: per frame, per second, or per redraw, from its reports' counts.
  const numbers = (s: ReturnType<typeof summarise>[number] | undefined) => {
    if (!s) return new Map<string, number | null>();
    const seconds = s.reports.reduce((t, r) => t + r.seconds, 0);
    const sum = (k: string) => s.reports.reduce((t, r) => t + (r.counts?.[k] ?? 0), 0);
    const per = (k: string, by: number) => (by ? sum(k) / by : null);
    // Runs from before the GPU was counted say nothing of it, rather than nought.
    const gpu = (v: number | null) => (s.reports.some((r) => r.counts?.["gpu.pipelinesTotal"] !== undefined) ? v : null);
    const own = [...new Set(s.reports.flatMap((r) => Object.keys(r.counts ?? {}).filter((k) => k.startsWith("own."))))].sort();
    return new Map<string, number | null>([
      ["fps", s.fps],
      ["frame JS ms", per("frame.jsMs", sum("frame.count"))],
      ["CPU ms", s.cpu],
      ["GPU ms", s.gpu],
      ["draws", s.draws],
      ["redraws /s", per("still.redraws", seconds)],
      ["redraw JS ms", per("still.redrawCpuMs", sum("still.redraws"))],
      ...own.map((k) => [`${k} /s`, per(k, seconds)] as [string, number | null]),
      ["pipelines", gpu(sum("gpu.pipelines"))],
      ["pipelines, all", gpu(Math.max(0, ...s.reports.map((r) => r.counts?.["gpu.pipelinesTotal"] ?? 0)))],
      ["bind groups", gpu(sum("gpu.bindGroups"))],
      ["buffers", gpu(sum("gpu.buffers"))],
      ["textures", gpu(sum("gpu.textures"))],
      ["submits /s", gpu(per("gpu.submits", seconds))],
      ["KB written /s", gpu(per("gpu.writeBytes", seconds * 1024))],
    ]);
  };
  const num = (v: number | null | undefined) => (v === null || v === undefined ? "?" : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)).padStart(10);
  console.log(`\n${"".padEnd(18)}${"A".padStart(10)}${"B".padStart(10)}${"B/A".padStart(10)}`);
  for (const phase of [...new Set([...a, ...b].map((s) => s.phase))]) {
    const [na, nb] = [numbers(a.find((s) => s.phase === phase)), numbers(b.find((s) => s.phase === phase))];
    console.log(phase);
    for (const k of new Set([...na.keys(), ...nb.keys()])) {
      const [va, vb] = [na.get(k), nb.get(k)];
      console.log(`  ${k.padEnd(16)}${num(va)}${num(vb)}${num(va && vb !== null && vb !== undefined ? vb / va : null)}`);
    }
  }
  process.exit(0);
}

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
  await page.goto(`${url}/?t=${t}&bench=${where}&tab=${tab}${town ? `&town=${town}` : ""}${params ? `&${params}` : ""}`);
  // A report every five seconds, a phase each.
  for (let n = 0; n < PHASES.length; ) {
    await page.waitForTimeout(5000);
    const now = (await fetchRuns(tab)).length;
    if (now === n && now > 0) console.log(`no report in five seconds after ${n}`);
    n = now;
    process.stdout.write(`\r${n}/${PHASES.length} reports`);
  }
  console.log();
  await browser.close();
}

const lines = await fetchRuns(tab);
const reports = lines.filter((r) => !r.phase.endsWith("cost"));
if (!reports.length) throw new Error(`no reports for ${tab} at ${url}`);
const [first] = reports;
console.log(`${tab}: ${first.canvas.join("×")} at ${first.dpr}x, ${first.gpu}\n${first.agent}`);
const f1 = (v: number) => v.toFixed(1);
for (const s of summarise(reports)) {
  const mine = s.reports;
  const busy = mine.reduce((a, r) => a + (typeof r.profile === "string" ? 0 : r.profile.busyMs), 0) / (mine.length * 5000);
  console.log(
    `${s.phase.padEnd(8)} ${f1(s.fps)} fps, gaps p90 ${f1(s.p90)} max ${f1(s.worst)} ms, over 34 ms ${mine.reduce((a, r) => a + r.gap.over34, 0)}; ` +
      `CPU ${f1(s.cpu)} ms, GPU ${s.gpu === null ? "?" : f1(s.gpu)} ms a frame; ${Math.round(s.draws)} draws; JS busy ${(busy * 100).toFixed(0)}%`,
  );
  const own = new Map<string, number>();
  for (const r of mine) if (typeof r.profile !== "string") for (const [what, ms] of r.profile.own) own.set(what, (own.get(what) ?? 0) + ms);
  const top = [...own].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (top.length) console.log(`       JS: ${top.map(([w, ms]) => `${w} ${ms}`).join(", ")}`);
  // Where a still redraw's JavaScript went, with what each function called.
  const redraws = mine.flatMap((r) => (typeof r.profile === "string" || !r.profile.redraw ? [] : [r.profile.redraw]));
  const spans = redraws.reduce((a, r) => a + r.spans, 0);
  if (spans && process.env.REDRAW) {
    const inc = new Map<string, number>();
    for (const r of redraws) for (const [what, ms] of r.all) inc.set(what, (inc.get(what) ?? 0) + ms);
    console.log(`       redraws ${spans}, ${f1(redraws.reduce((a, r) => a + r.ms, 0) / spans)} ms each, sampled busy ${f1(redraws.reduce((a, r) => a + r.busyMs, 0) / spans)} ms each; per redraw, with callees:`);
    for (const [what, ms] of [...inc].sort((a, b) => b[1] - a[1]).slice(0, 45)) console.log(`         ${f1(ms / spans).padStart(6)} ms  ${what}`);
  }
  const counted = new Map<string, number>();
  for (const r of mine) for (const [k, v] of Object.entries(r.counts ?? {})) counted.set(k, (counted.get(k) ?? 0) + v);
  if (counted.size) console.log(`       counted: ${[...counted].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const errors = new Map<string, number>();
  for (const r of mine) for (const [k, v] of Object.entries(r.errors ?? {})) errors.set(k, (errors.get(k) ?? 0) + v);
  for (const [what, n] of errors) console.log(`       error ×${n}: ${what}`);
  const worst = mine.flatMap((r) => r.long).sort((a, b) => b.ms - a.ms)[0];
  if (worst) console.log(`       longest frame ${worst.ms} ms: ${worst.scripts.slice(0, 3).map((s) => `${s.what} ${s.ms}`).join(", ") || "no script"}`);
}
for (const [phase, title] of [["cost", "what each kind costs, far out, by day"], ["d-cost", "close in, by day"], ["n-cost", "close in, by night"]]) {
  const cost = (lines.find((r) => r.phase === phase) as unknown as { cost: CostReport } | undefined)?.cost;
  if (cost) console.log(`\n${costLines(cost, title).join("\n")}`);
}
