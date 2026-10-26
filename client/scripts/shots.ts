/**
 * Pictures of the fixture towns, for judging the look without playing.
 *
 *   bun run shots          build the fixtures, photograph each, write the sheet, stop
 *   bun run shots --keep   the same, then leave the stack up at localhost:4810
 *   bun run shots 20-block    only these fixtures, by name
 *   FIXTURES=<dir> bun run shots   the fixtures in that directory alone, so a
 *                             late one is not built past the map's edge
 *
 * A stack of its own beside the game's — server on 4811, client on 4810 — so
 * it never touches the running game or its world. The server builds
 * `server/fixtures/*.txt` fresh (see `server/map/src/fixtures.rs`), at noon and
 * paused; this points the camera at each and writes `.dev/shots/<name>.png`
 * and `.dev/shots/sheet.png`, every fixture on one page.
 */
import { args, has, launch, ROOT, sheet } from "./lib";
import { mkdirSync, rmSync } from "node:fs";

const OUT = `${ROOT}/.dev/shots`;
const SERVER_PORT = 4811;
const CLIENT_PORT = 4810;
/** Tiles of grass shown round a fixture. */
const MARGIN = 3;
/** Long enough for the chunks, the buildings and the ink to arrive; in
 *  software (`lib.ts`) far longer: SETTLE=60000. */
const SETTLE_MS = Number(process.env.SETTLE ?? 2500);
const VIEW = { width: 900, height: 600 };

type Placed = { name: string; title: string; x: number; y: number; w: number; h: number };

const keep = has("--keep");
mkdirSync(OUT, { recursive: true });
rmSync(`${ROOT}/.dev/fixtures.db`, { force: true });

const env = { ...process.env, SPRAWL_PORT: String(SERVER_PORT), SPRAWL_CLIENT_PORT: String(CLIENT_PORT) };
const server = Bun.spawn(["cargo", "run", "-q", "-p", "sprawl-server"], {
  cwd: `${ROOT}/server`,
  env: { ...env, SPRAWL_FIXTURES: process.env.FIXTURES ?? "fixtures", SPRAWL_DB: `${ROOT}/.dev/fixtures.db` },
  stdout: Bun.file(`${ROOT}/.dev/fixtures-server.log`),
  stderr: Bun.file(`${ROOT}/.dev/fixtures-server.log`),
});
const client = Bun.spawn(["bunx", "vite"], {
  cwd: `${ROOT}/client`,
  env,
  stdout: Bun.file(`${ROOT}/.dev/fixtures-client.log`),
  stderr: Bun.file(`${ROOT}/.dev/fixtures-client.log`),
});
const stop = () => {
  server.kill();
  client.kill();
};
process.on("SIGINT", () => (stop(), process.exit(130)));

async function until<T>(what: string, get: () => Promise<T>, seconds = 300): Promise<T> {
  for (let i = 0; i < seconds * 4; i++) {
    try {
      return await get();
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error(`gave up waiting for ${what}; see .dev/fixtures-*.log`);
}

try {
  const fixtures: Placed[] = await until("the fixture server", async () => {
    const r = await fetch(`http://localhost:${SERVER_PORT}/fixtures`);
    const built: Placed[] = r.ok ? await r.json() : [];
    // The socket answers before the game loop has built anything.
    if (built.length === 0) throw new Error();
    return built;
  });
  await until("the client", async () => {
    if (!(await fetch(`http://localhost:${CLIENT_PORT}`)).ok) throw new Error();
  });

  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 2 });
  await page.goto(`http://localhost:${CLIENT_PORT}`);
  await page.waitForFunction(() => "sprawlCamera" in window);
  // The map alone: no toolbar, dials or pins over it.
  await page.addStyleTag({ content: "#root * { visibility: hidden } #root canvas { visibility: visible }" });
  // The first look waits for the socket and the terrain as well.
  await page.evaluate(([x, y]) => (window as any).sprawlCamera.look(x, y, 10), [fixtures[0].x, fixtures[0].y]);
  await page.waitForTimeout(SETTLE_MS * 2);

  const aspect = VIEW.width / VIEW.height;
  const shot = fixtures.filter((f) => !args.length || args.includes(f.name));
  for (const f of shot) {
    // The middle of the fixture: rows run south from y, a tile's middle is
    // half a tile in.
    const cx = f.x + f.w / 2;
    const cy = f.y - f.h / 2 + 1;
    const half = Math.max(f.h / 2, f.w / 2 / aspect) + MARGIN;
    await page.evaluate(([x, y, h]) => (window as any).sprawlCamera.look(x, y, h), [cx, cy, half]);
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: `${OUT}/${f.name}.png` });
  }

  const png = async (name: string) => Buffer.from(await Bun.file(`${OUT}/${name}.png`).arrayBuffer()).toString("base64");
  const cells = await Promise.all(shot.map(async (f) => `<figure><img src="data:image/png;base64,${await png(f.name)}"><figcaption><b>${f.name}</b> ${f.title}</figcaption></figure>`));
  await sheet(await browser.newPage(), cells, 3, `${OUT}/sheet.png`);
  await browser.close();
  console.log(`${shot.length} fixtures → ${OUT}/sheet.png`);
} finally {
  if (keep) console.log(`stack left up: http://localhost:${CLIENT_PORT} (Ctrl-C stops it)`);
  else stop();
}
