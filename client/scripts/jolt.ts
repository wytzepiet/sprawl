/**
 * Jolts: every vehicle round a tile sampled as the client places it
 * (`motion.ts`), fifty times a second of wall time, and every jump, snap
 * and instant change of direction counted.
 *
 *   bun run jolt 6,80,12 20     twenty seconds round (6, 80), twelve tiles each way
 *
 * A jump is a step faster than anything drives (3 tiles a second); a snap
 * a turn of more than a fifth of a radian in one step; a flip a change of
 * direction with no stop between (moving both sides of it); a lurch a
 * change of speed harder than 2 tiles a second squared. Each is said with
 * the clock and the place. The game is the one `bun run dev` runs, or
 * SPRAWL_PORT's.
 */
import { decode, encode } from "@msgpack/msgpack";
import "./tsx";
import type { GameObjectEntry, Operation, ServerMessage } from "../src/generated";

const { moment } = await import("../src/engine/objects/motion");
const PORT = Number(process.env.SPRAWL_PORT ?? 4801);
const [x, y, r = 12] = (process.argv[2] ?? "0,0").split(",").map(Number);
const seconds = Number(process.argv[3] ?? 20);
const entities = new Map<number, GameObjectEntry>();
let clock = { now: 0, speed: 0, heard: 0 };
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
ws.binaryType = "arraybuffer";
ws.onmessage = (e) => {
  const msg = decode(new Uint8Array(e.data as ArrayBuffer)) as ServerMessage;
  if (msg.type !== "Update") return;
  clock = { ...msg.data.clock, heard: Date.now() };
  for (const op of msg.data.ops as Operation[]) op.op === "Upsert" ? entities.set(op.data.id, op.data) : entities.delete(op.data);
};
await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = () => fail(new Error(`no game on port ${PORT}`)))));
const ch = (v: number) => Math.floor(v / 32);
ws.send(encode({ type: "SetChunks", data: { min_cx: ch(x - r) - 1, min_cy: ch(y - r) - 1, max_cx: ch(x + r) + 1, max_cy: ch(y + r) + 1 } }));
await Bun.sleep(500);

const now = () => clock.now + (Date.now() - clock.heard) * clock.speed;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const last = new Map<number, { t: number; x: number; y: number; h: number; v: number }>();
const tally = new Map<number, { role: string; jump: number; snap: number; flip: number; lurch: number; said: string[] }>();
// Polled every 20 ms of wall time, each poll sampled every 10 ms of the
// game's since the last, so the sleep's jitter is no jolt.
let polled = now();
for (const end = Date.now() + seconds * 1000; Date.now() < end; await Bun.sleep(20)) {
  const until = now();
  for (let t = polled + 10; t <= until; t += 10, polled = t) sample(t);
}
function sample(t: number) {
  for (const [id, e] of entities) {
    if (e.object.kind !== "Car") continue;
    const car = e.object.data;
    if (car.role === "Ferry") continue;
    const m = moment(id, car, t);
    if (!m) continue;
    const [px, py] = m.body.at;
    if (Math.abs(px - x) > r || Math.abs(py - y) > r) continue;
    const p = last.get(id);
    const k = tally.get(id) ?? { role: car.role, jump: 0, snap: 0, flip: 0, lurch: 0, said: [] };
    tally.set(id, k);
    if (!p || t <= p.t) {
      last.set(id, { t, x: px, y: py, h: m.body.heading, v: 0 });
      continue;
    }
    const dt = (t - p.t) / 1000;
    const [dx, dy] = [px - p.x, py - p.y];
    // Signed: along the body's heading, forward positive.
    const v = (dx * Math.cos(m.body.heading) + dy * Math.sin(m.body.heading)) / dt;
    const say = (what: string) => k.said.length < 8 && k.said.push(`${what} at ${Math.round(t)} (${px.toFixed(2)},${py.toFixed(2)})`);
    if (Math.hypot(dx, dy) / dt > 3) k.jump++, say(`jump ${Math.hypot(dx, dy).toFixed(2)}`);
    const dh = Math.abs(wrap(m.body.heading - p.h));
    if (dh > 0.2) k.snap++, say(`snap ${dh.toFixed(2)}`);
    if (Math.sign(v) !== Math.sign(p.v) && Math.abs(v) > 0.04 && Math.abs(p.v) > 0.04) k.flip++, say(`flip ${p.v.toFixed(2)}→${v.toFixed(2)}`);
    if (Math.abs(v - p.v) / dt > 2 && p.v !== 0) k.lurch++, say(`lurch ${p.v.toFixed(2)}→${v.toFixed(2)}`);
    last.set(id, { t, x: px, y: py, h: m.body.heading, v });
  }
}
ws.close();
for (const [id, k] of tally) console.log(`${k.role} ${id}: ${k.jump} jumps, ${k.snap} snaps, ${k.flip} flips, ${k.lurch} lurches${k.said.length ? "\n    " + k.said.join("\n    ") : ""}`);
