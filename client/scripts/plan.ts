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
 *   --paths                            with --live, the trips `bun run act watch`
 *                                      recorded, bends tighter than a car turns red
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

// The colours live in .tsx files beside their components, which Vite
// compiles for Solid; here nothing is rendered, so any JSX runtime will do.
Bun.plugin({
  name: "solid-jsx",
  setup(build) {
    const tsx = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "solid-js/h" } } });
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({ contents: tsx.transformSync(await Bun.file(path).text()), loader: "js" }));
  },
});

const ROOT = resolve(import.meta.dir, "../..");
const OUT = `${ROOT}/.dev/plan`;
/** Pixels to a tile. */
const PX = Number(process.env.PX ?? 24);

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const png = args.includes("--png") && (args.splice(args.indexOf("--png"), 1), true);
const crop = flag("--crop")?.split(",").map(Number) as [number, number, number, number] | undefined;
const at = flag("--at");
const withPaths = args.includes("--paths") && (args.splice(args.indexOf("--paths"), 1), true);
const paths = withPaths ? (await import("./paths")).trace(JSON.parse(readFileSync(`${ROOT}/.dev/paths.json`, "utf8"))) : undefined;
const live = flag("--live")?.split(",");
if (live) {
  const [x, y, r = "20"] = live;
  const port = process.env.SPRAWL_PORT ?? 4801;
  const map = await fetch(`http://localhost:${port}/map?x=${x}&y=${y}&r=${r}`).then((res) => res.text()).catch(() => {
    throw new Error(`no game on port ${port}: bun run dev`);
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
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium" }).catch(() => chromium.launch({ channel: "chrome" }));
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  for (const d of drawn) {
    const svg = readFileSync(d.file, "utf8");
    const [w, h] = svg.match(/width="(\d+)" height="(\d+)"/)!.slice(1).map(Number);
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<body style="margin:0">${svg}</body>`);
    await page.screenshot({ path: d.file.replace(/\.svg$/, ".png") });
  }
  const cells = drawn.map((d) => `<figure>${readFileSync(d.file, "utf8")}<figcaption><b>${d.name}</b> ${d.title}</figcaption></figure>`).join("");
  await page.setViewportSize({ width: 1800, height: 800 });
  await page.setContent(`<style>
    body { margin: 16px; font: 13px system-ui; background: #fff; }
    main { display: grid; grid-template-columns: repeat(${at ? 2 : 3}, 1fr); gap: 16px; align-items: start; }
    figure { margin: 0; } svg { width: 100%; height: auto; display: block; border-radius: 4px; }
    figcaption { padding: 4px 2px; color: #444; }
  </style><main>${cells}</main>`);
  await page.screenshot({ path: `${OUT}/sheet.png`, fullPage: true });
  await browser.close();
  console.log(`${drawn.length} plans → ${OUT}/sheet.png`);
}
