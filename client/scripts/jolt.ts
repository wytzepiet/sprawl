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
 * change of speed harder than 3 tiles a second squared. Each is said with
 * the clock and the place. The game is the one `bun run dev` runs, or
 * SPRAWL_PORT's.
 */
import { connect } from "./game";
import "./tsx";

const { moment } = await import("../src/engine/objects/motion");
const [x, y, r = 12] = (process.argv[2] ?? "0,0").split(",").map(Number);
const seconds = Number(process.argv[3] ?? 20);
const { entities, now, close } = await connect({ tiles: [[x - r, y - r], [x + r, y + r]] });
await Bun.sleep(500);

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
    if (Math.abs(v - p.v) / dt > 3 && p.v !== 0) k.lurch++, say(`lurch ${p.v.toFixed(2)}→${v.toFixed(2)}`);
    last.set(id, { t, x: px, y: py, h: m.body.heading, v });
  }
}
close();
for (const [id, k] of tally) console.log(`${k.role} ${id}: ${k.jump} jumps, ${k.snap} snaps, ${k.flip} flips, ${k.lurch} lurches${k.said.length ? "\n    " + k.said.join("\n    ") : ""}`);
