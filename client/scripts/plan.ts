/**
 * The town grid drawn flat, as SVG: no light, no 3D, no browser for the
 * drawing. Instant and exact, and two versions compare as text or side by
 * side. Most layout questions need only this; the sandbox's photographs
 * (`bun run shots --sandbox`) are for light and height.
 *
 *   bun run plan                       every fixture
 *   bun run plan 14-business 16-ferry  these, by name or by path
 *   --crop c0,r0,c1,r1                 only these tiles (c1, r1 not included)
 *   --png                              a picture of each beside the SVG, and a sheet
 *   --live x,y[,r]                     the running game round its tile (x, y),
 *                                      r tiles each way (20), drawn as `live`;
 *                                      numbered in the game's tiles, for `bun run act`
 *   --paths[=car,car]                  with --live, the trips `bun run act watch`
 *                                      recorded (these cars' alone), driven as
 *                                      `driver.ts` steers them: a strobe of each
 *                                      vehicle, bends tighter than a car turns red
 *   --at <git ref>                     the town grid's code as it was at <ref>,
 *                                      drawn beside today's: a before and after
 *                                      (any commit since this script came)
 *
 * Writes `.dev/plan/<name>.svg` (`<name>.<ref>.svg` with `--at`), and with
 * `--png` the same as PNG and `.dev/plan/sheet.png`. Roofs are drawn as
 * their faces' edges, ridges and hips; the grid is labelled every five
 * tiles in the fixture's own columns and rows, so a tile can be named.
 */
import { mkdirSync, readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { $ } from "bun";
import { args, has, launch, PORT, ROOT, sheet, word } from "./lib";
import "./tsx";

const OUT = `${ROOT}/.dev/plan`;
/** Pixels to a tile. */
const PX = Number(process.env.PX ?? 24);

const png = has("--png");
const crop = word("--crop")?.split(",").map(Number) as [number, number, number, number] | undefined;
const at = word("--at");
// `--paths`, or `--paths=12,34` for those cars' trips alone.
const pathsArg = args.find((a) => a.startsWith("--paths"));
if (pathsArg) args.splice(args.indexOf(pathsArg), 1);
const only = pathsArg?.split("=")[1]?.split(",").map(Number);
const paths = pathsArg
  ? (await import("./paths")).trace(JSON.parse(readFileSync(`${ROOT}/.dev/paths.json`, "utf8")).filter((t: { car: number }) => !only || only.includes(t.car)))
  : undefined;
const live = word("--live")?.split(",");
if (live) {
  const [x, y, r = "20"] = live;
  const map = await fetch(`http://localhost:${PORT}/map?x=${x}&y=${y}&r=${r}`).then((res) => res.text()).catch(() => {
    throw new Error(`no game on port ${PORT}: bun run dev`);
  });
  await Bun.write(`${ROOT}/.dev/plan/live.txt`, map);
  args.push(`${ROOT}/.dev/plan/live.txt`);
}
const files = (args.length ? args : readdirSync(`${ROOT}/server/fixtures`).filter((f) => f.endsWith(".txt")).sort()).map((a) =>
  existsSync(a) ? resolve(a) : `${ROOT}/server/fixtures/${a.replace(/\.txt$/, "")}.txt`,
);
mkdirSync(OUT, { recursive: true });

/** The drawing code, today's or as it was at a commit: the town grid
 *  and what it leans on, checked out into a copy beside the real one. */
async function drawer(ref?: string): Promise<typeof import("./planDraw")> {
  if (!ref) return import("./planDraw");
  const copy = `${OUT}/.at-${ref.replace(/\W/g, "_")}`;
  rmSync(copy, { recursive: true, force: true });
  mkdirSync(copy, { recursive: true });
  // The client's code as it was, drawn by today's drawer, with today's
  // packages, found through the copy's own node_modules link.
  await $`git -C ${ROOT} archive ${ref} client/src | tar -x -C ${copy}`.quiet();
  mkdirSync(`${copy}/client/scripts`, { recursive: true });
  await $`cp ${import.meta.dir}/planDraw.ts ${copy}/client/scripts/`.quiet();
  await $`ln -sfn ${ROOT}/client/node_modules ${copy}/client/node_modules`.quiet();
  return import(`${copy}/client/scripts/planDraw.ts`);
}

const versions = [{ draw: await drawer(), suffix: "" }];
if (at) versions.push({ draw: await drawer(at), suffix: `.${at.replace(/\W/g, "_")}` });
const drawn: { name: string; file: string; title: string }[] = [];
for (const path of files) {
  const name = basename(path, ".txt");
  const text = readFileSync(path, "utf8");
  const title = text.split("\n")[0].replace(/^#\s*/, "");
  const t0 = performance.now();
  for (const { draw, suffix } of versions) {
    const file = `${OUT}/${name}${suffix}.svg`;
    await Bun.write(file, draw.planSvg(text, { crop, px: PX, paths }));
    drawn.push({ name: `${name}${suffix}`, file, title });
  }
  console.log(`${name}: ${Math.round(performance.now() - t0)} ms`);
}

if (png) {
  const browser = await launch();
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  for (const d of drawn) {
    const svg = readFileSync(d.file, "utf8");
    const [w, h] = svg.match(/width="(\d+)" height="(\d+)"/)!.slice(1).map(Number);
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<body style="margin:0">${svg}</body>`);
    await page.screenshot({ path: d.file.replace(/\.svg$/, ".png") });
  }
  const cells = drawn.map((d) => `<figure>${readFileSync(d.file, "utf8")}<figcaption><b>${d.name}</b> ${d.title}</figcaption></figure>`);
  await sheet(page, cells, at ? 2 : 3, `${OUT}/sheet.png`);
  await browser.close();
  console.log(`${drawn.length} plans → ${OUT}/sheet.png`);
}
