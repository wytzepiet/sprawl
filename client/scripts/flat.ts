/**
 * The running game drawn flat (`src/flat/draw.ts`): every vehicle where the
 * server's clock has it, placed by the client's own code, the ferry's deck
 * and the park box by box, a site's progress, ids beside things. Under a
 * second, with no browser and no GPU: for seeing what the server does.
 * `bun run look` is for light and material.
 *
 *   bun run flat 6,80          the game round tile (6, 80), twelve tiles each way
 *   bun run flat 6,80,30       thirty tiles each way
 *   --px 24                    pixels to a tile (32)
 *   --frames 8 --every 500     eight pictures half a second of wall time
 *                              apart, and a strip of them
 *   --follow 37                the view kept on vehicle 37
 *   --name harbour             .dev/flat/harbour.png (flat.png)
 *   PLAYER=4242                that player's draft blue, the rest grey
 *                              (`act`'s hand is 4242)
 *
 * It listens as a client does, over the game's socket, to the same
 * messages, so it draws what a player's screen would. Tiles are the
 * game's own, as `bun run act` takes them. The game is the one `bun run
 * dev` runs, or SPRAWL_PORT's.
 */
import { decode, encode } from "@msgpack/msgpack";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import "./tsx";
import type { Draft, GameObjectEntry, Operation, ServerMessage, TerrainChunk } from "../src/generated";

const t0 = performance.now();
const { drawFlat } = await import("../src/flat/draw");
const { moment } = await import("../src/engine/objects/motion");
const { CHUNK_SIZE } = await import("../src/engine/objects/terrainGeometry");

const PORT = Number(process.env.SPRAWL_PORT ?? 4801);
const OUT = `${resolve(import.meta.dir, "../..")}/.dev/flat`;
const args = process.argv.slice(2);
const flag = (name: string, or: string) => {
  const i = args.indexOf(name);
  return i < 0 ? or : args.splice(i, 2)[1];
};
const px = Number(flag("--px", "32"));
const frames = Number(flag("--frames", "1"));
const every = Number(flag("--every", "500"));
const follow = Number(flag("--follow", "NaN"));
const name = flag("--name", "flat");
const [x, y, r = 12] = (args[0] ?? "0,0").split(",").map(Number);

// What the server has said, as the client keeps it.
const entities = new Map<number, GameObjectEntry>();
const chunks = new Map<string, Uint8Array>();
let clock = { now: 0, speed: 0, day_ms: 1, heard: 0 };
/** Every player's draft; PLAYER's drawn as ours, the rest grey. */
let drafts: Draft[] = [];
let updates = 0;
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
ws.binaryType = "arraybuffer";
ws.onmessage = (e) => {
  const msg = decode(new Uint8Array(e.data as ArrayBuffer)) as ServerMessage;
  if (msg.type === "TerrainChunk") {
    const c = msg.data as TerrainChunk;
    chunks.set(`${c.coord.cx},${c.coord.cy}`, c.tiles);
  }
  if (msg.type !== "Update") return;
  clock = { ...msg.data.clock, heard: Date.now() };
  drafts = msg.data.drafts ?? [];
  for (const op of msg.data.ops as Operation[]) op.op === "Upsert" ? entities.set(op.data.id, op.data) : entities.delete(op.data);
  if (msg.data.ops.length) updates++;
};
await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = () => fail(new Error(`no game on port ${PORT}: bun run dev`)))));

// Everything a view of the place sees, and a chunk round it: what a vehicle
// followed may drive into.
const pad = frames > 1 && follow ? 2 : 1;
const ch = (v: number) => Math.floor(v / CHUNK_SIZE);
const bounds = { min_cx: ch(x - r) - pad, min_cy: ch(y - r) - pad, max_cx: ch(x + r) + pad, max_cy: ch(y + r) + pad };
ws.send(encode({ type: "SetChunks", data: bounds }));
// The server answers on its next tick: the chunks, then what stands on them.
for (const until = Date.now() + 5000; !updates && Date.now() < until; ) await Bun.sleep(10);
await Bun.sleep(30);

const now = () => clock.now + (Date.now() - clock.heard) * clock.speed;
const sheet = (w: number, h: number) => createCanvas(w, h) as unknown as ReturnType<Parameters<typeof drawFlat>[3]>;
const side = Math.round((2 * r + 1) * px);
mkdirSync(OUT, { recursive: true });
const shots: Canvas[] = [];
for (let n = 0; n < frames; n++) {
  const at = now();
  // A vehicle followed is the view's middle, wherever it has got to.
  const car = entities.get(follow);
  const m = car?.object.kind === "Car" ? moment(follow, car.object.data, at, entities.get(car.object.data.owner)?.position) : null;
  const [vx, vy] = m ? m.body.at : [x + 0.5, y + 0.5];
  const canvas = createCanvas(side, side);
  const t = performance.now();
  drawFlat(canvas.getContext("2d") as unknown as CanvasRenderingContext2D, { entities: (each) => entities.forEach(each), drafts, me: process.env.PLAYER ? Number(process.env.PLAYER) : undefined, ground: (cx, cy) => chunks.get(`${cx},${cy}`), now: at, dayMs: clock.day_ms }, { x: vx, y: vy, px, w: side, h: side }, sheet);
  const file = `${OUT}/${name}${frames > 1 ? `-${n}` : ""}.png`;
  await Bun.write(file, await canvas.encode("png"));
  console.log(`${file}  ${entities.size} things, drawn in ${Math.round(performance.now() - t)} ms${n ? "" : `, ${Math.round(performance.now() - t0)} ms in all`}`);
  shots.push(canvas);
  if (n + 1 < frames) await Bun.sleep(every);
}
ws.close();

if (frames > 1) {
  // Side by side, four to a row, each at half size.
  const [cols, s] = [Math.min(frames, 4), Math.round(side / 2)];
  const strip = createCanvas(cols * s + (cols - 1) * 2, Math.ceil(frames / cols) * (s + 2) - 2);
  const g = strip.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, strip.width, strip.height);
  shots.forEach((c, n) => g.drawImage(c, (n % cols) * (s + 2), Math.floor(n / cols) * (s + 2), s, s));
  await Bun.write(`${OUT}/${name}-strip.png`, await strip.encode("png"));
  console.log(`${frames} frames → ${OUT}/${name}-strip.png`);
}
