/**
 * The client's copy of the server's types, made over. ts-rs writes each
 * `#[ts(export)]` on a full `cargo test` (`server/.cargo/config.toml`), but
 * never deletes, so this clears the folder first, runs the suite, and lists
 * what it wrote in `index.ts`.
 */
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "../src/generated");
const types = () => readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "index.ts");

for (const f of types()) rmSync(join(dir, f));
const run = Bun.spawnSync(["cargo", "test"], { cwd: join(import.meta.dir, "../../server"), stdio: ["inherit", "inherit", "inherit"] });
writeFileSync(
  join(dir, "index.ts"),
  "// Written by `bun run generate`.\n" + types().sort().map((f) => `export type * from "./${f.slice(0, -3)}";\n`).join(""),
);
process.exit(run.exitCode);
