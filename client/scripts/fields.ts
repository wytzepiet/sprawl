/**
 * The tractor's runs over the fields in `server/fields/`, measured and
 * drawn (`server/src/world/fields/bench.rs`), and the drawings laid out
 * on one sheet, `.dev/fields/sheet.png`, a field a row, ploughing then
 * harvesting. `bun run fields [name]` draws only the fields whose name has
 * that in it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { launch, ROOT, sheet } from "./lib";

const DIR = resolve(ROOT, ".dev/fields");
const only = process.argv[2];

const test = Bun.spawnSync(["cargo", "test", "-q", "--lib", "sweeps", "--", "--nocapture"], { cwd: resolve(ROOT, "server"), env: { ...process.env, ...(only ? { FIELD: only } : {}) }, stdout: "pipe", stderr: "pipe" });
const out = test.stdout.toString();
process.stdout.write(out.split("\n").filter((l) => !l.startsWith("running") && !l.startsWith("test result") && l.trim() !== "." && l.trim()).join("\n") + "\n");
if (test.exitCode !== 0) process.stdout.write(test.stderr.toString().split("\n").filter((l) => l.includes("panicked") || l.includes(": ")).slice(0, 8).join("\n") + "\n");

const svgs = readdirSync(DIR).filter((f) => f.endsWith(".svg") && (!only || f.includes(only))).sort();
const fields = [...new Set(svgs.map((f) => f.replace(/-(plough|harvest)\.svg$/, "")))];
const cell = (f: string) => `<figure><figcaption>${f.replace(".svg", "")}</figcaption>${readFileSync(resolve(DIR, f), "utf8")}</figure>`;
const browser = await launch();
await sheet(await browser.newPage(), fields.flatMap((f) => [cell(`${f}-plough.svg`), cell(`${f}-harvest.svg`)]), 2, resolve(DIR, "sheet.png"));
await browser.close();
console.log(`sheet → ${resolve(DIR, "sheet.png")}`);
