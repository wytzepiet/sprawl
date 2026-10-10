/**
 * The mayor's hand, from a command: what the toolbar does, sent to the
 * running game over its own socket, and what changed said back. So an agent
 * can set up a situation and watch it.
 *
 *   bun run act road 10,4 20,4 20,9     a street through these tiles, stepping
 *                                       as the brush does, diagonals and all
 *       --road | --one-way              a through road, or one way
 *   bun run act build House 12,5        a building painted on this tile; more
 *       12,5 14,5 14,6                  tiles paint on through them, stepping
 *                                       as the brush does: one building as far
 *                                       as a kind that grows is painted
 *   bun run act demolish 12,5 14,5      whatever stands on the tiles, through
 *   bun run act speed 0                 sim steps per tick; 0 pauses
 *   bun run act run 2                   two hours on at full speed, then the
 *       --to 0.83                       speed it had; or on to this time of
 *                                       day (0 midnight, 0.5 noon)
 *   bun run act watch 2 5,84            two hours on at full speed, every trip
 *                                       round that tile recorded to
 *                                       .dev/paths.json, and every bend tighter
 *                                       than a car turns counted
 *   bun run act time                    the clock, as now and time of day
 *   bun run act reset                   a new world
 *   bun run act - < steps.txt           one command a line; # comments
 *
 * Tiles are the game's own (x, y), as `bun run plan --live` numbers them;
 * on the map +x is to the left and +y up. Each command answers with what it
 * made and took away, and a command that changed nothing says so, since
 * the server refuses quietly (the build's gate, the purse, a tile already
 * taken; refusals of buildings are in `.dev/server.log`). The game is the
 * one `bun run dev` runs, or SPRAWL_PORT's.
 */
import { decode, encode } from "@msgpack/msgpack";
import { part, radii, TIGHTEST, trace, type Recorded } from "./paths";

const PORT = Number(process.env.SPRAWL_PORT ?? 4801);
/** The server's chunk, in tiles (`CHUNK_SIZE` in `protocol.rs`). */
const CHUNK = 32;
/** Quiet this long and the server has said all it will about a command;
 *  silent this long, and it will say nothing. */
const SETTLE_MS = 400;
const WAIT_MS = 5000;
/** The server's top speed (`MAX_SPEED` in `game_loop`). */
const FULL = 50;

type Pt = [number, number];
type Entry = { id: number; object: { kind: string; data: any }; position: { x: number; y: number } | null };
type Op = { op: "Upsert"; data: Entry } | { op: "Delete"; data: number };

const lines = process.argv[2] === "-"
  ? (await Bun.stdin.text()).split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean).map((l) => l.split(/\s+/))
  : [process.argv.slice(2)];
const tile = (s: string): Pt => {
  const m = s.match(/^(-?\d+),(-?\d+)$/);
  if (!m) throw new Error(`not a tile: ${s} (want x,y)`);
  return [Number(m[1]), Number(m[2])];
};

// The chunks every tile named lies in, a chunk round, so the server tells
// us of what is built there.
const named = lines.flat().filter((a) => /^-?\d+,-?\d+$/.test(a)).map(tile);
const chunks = named.length ? named : [[0, 0] as Pt];
const ch = (v: number) => Math.floor(v / CHUNK);
const bounds = {
  min_cx: Math.min(...chunks.map((p) => ch(p[0]))) - 1, min_cy: Math.min(...chunks.map((p) => ch(p[1]))) - 1,
  max_cx: Math.max(...chunks.map((p) => ch(p[0]))) + 1, max_cy: Math.max(...chunks.map((p) => ch(p[1]))) + 1,
};

const known = new Map<number, Entry>();
let clock = { now: 0, speed: 1, day_ms: 1 };
let heard = Date.now();
let ops: Op[] = [];
/** Every trip seen, once each. */
const trips = new Map<string, Recorded>();
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
ws.binaryType = "arraybuffer";
ws.onmessage = (e) => {
  const msg = decode(new Uint8Array(e.data as ArrayBuffer)) as { type: string; data: any };
  if (msg.type !== "Update") return;
  clock = msg.data.clock;
  if (msg.data.ops.length) (heard = Date.now()), ops.push(...msg.data.ops);
  for (const op of msg.data.ops as Op[]) {
    const trip = op.op === "Upsert" && op.data.object.kind === "Car" && op.data.object.data.trip;
    if (!trip) continue;
    const t: Recorded = { car: (op as any).data.id, role: (op as any).data.object.data.role, route: trip.route_positions, from_lot: trip.from_lot, to_lot: trip.to_lot, backing: trip.backing };
    trips.set(`${t.car}:${JSON.stringify(t.route)}`, t);
  }
};
await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = () => fail(new Error(`no game on port ${PORT}: bun run dev`)))));
const send = (type: string, data?: unknown) => ws.send(encode(data === undefined ? { type } : { type, data }));
/** What the server said about a command: its first word, then whatever
 *  follows until it is quiet; or nothing, if it says nothing for a while. */
async function settled() {
  const asked = Date.now();
  do await Bun.sleep(100);
  while (heard < asked ? Date.now() - asked < WAIT_MS : Date.now() - heard < SETTLE_MS);
  const out = ops;
  ops = [];
  return out;
}
/** What a batch of ops made and took away, cars and residents aside. */
function changes(batch: Op[]): string[] {
  const made: Entry[] = [], gone: Entry[] = [];
  for (const op of batch) {
    if (op.op === "Upsert") {
      if (!known.has(op.data.id)) made.push(op.data);
      known.set(op.data.id, op.data);
    } else if (known.has(op.data)) {
      gone.push(known.get(op.data)!);
      known.delete(op.data);
    }
  }
  const say = (e: Entry) => {
    const at = e.position ? ` at ${e.position.x},${e.position.y}` : "";
    return e.object.kind === "Building" ? `${e.object.data.kind} #${e.id}${at}` : `${e.object.kind}${at}`;
  };
  const quiet = (e: Entry) => e.object.kind === "Car" || e.object.kind === "Resident";
  const roads = (es: Entry[]) => es.filter((e) => e.object.kind === "RoadNode").length;
  const rest = (es: Entry[]) => es.filter((e) => !quiet(e) && e.object.kind !== "RoadNode").map(say);
  return [
    ...(roads(made) ? [`+ ${roads(made)} road tiles`] : []), ...rest(made).map((s) => `+ ${s}`),
    ...(roads(gone) ? [`- ${roads(gone)} road tiles`] : []), ...rest(gone).map((s) => `- ${s}`),
  ];
}
/** The trips seen, kept for `bun run plan --paths`, and their bends
 *  tighter than a car turns, by where on the trip they are. */
function watched(): string[] {
  const all = [...trips.values()];
  Bun.write(`${import.meta.dir}/../../.dev/paths.json`, JSON.stringify(all));
  const tight = { out: [] as number[], street: [] as number[], in: [] as number[] };
  let worst = { r: Infinity, at: [0, 0], car: 0, part: "" };
  const traced = trace(all);
  all.forEach((t, k) => {
    const pts = traced[k].points;
    radii(pts).forEach((r, i) => {
      if (r >= TIGHTEST) return;
      const where = part(t, pts, i);
      tight[where].push(r);
      if (r < worst.r) worst = { r, at: pts[i], car: t.car, part: where };
    });
  });
  return [
    `${all.length} trips → .dev/paths.json`,
    ...Object.entries(tight).filter(([, rs]) => rs.length).map(([where, rs]) =>
      `${rs.length} points tighter than ${TIGHTEST} ${where === "street" ? "on the street" : `pulling ${where}`}, tightest ${Math.min(...rs).toFixed(2)}`),
    ...(worst.r < Infinity ? [`tightest of all: ${worst.r.toFixed(2)} at ${worst.at.map((v) => v.toFixed(2)).join(",")}, car #${worst.car}, ${worst.part}`] : []),
  ];
}
const timeOfDay = () => (clock.now % clock.day_ms) / clock.day_ms;
const hhmm = (t: number) => `${String(Math.floor(t * 24)).padStart(2, "0")}:${String(Math.floor((t * 1440) % 60)).padStart(2, "0")}`;

send("SetChunks", bounds);
changes(await settled());

/** A drag through these tiles with this in hand, a step at a time as the
 *  brush takes them, straight or diagonal; a road starts from its first
 *  tile, anything else paints or clears it first. */
function stroke(tool: unknown, pts: Pt[]) {
  if (!pts.length) return;
  if (tool !== "Street" && tool !== "OneWay" && tool !== "Road") send("Build", { tool, from: at(pts[0]), to: at(pts[0]) });
  for (let i = 1; i < pts.length; i++) {
    let [x, y] = pts[i - 1];
    const [tx, ty] = pts[i];
    while (x !== tx || y !== ty) {
      const [nx, ny] = [x + Math.sign(tx - x), y + Math.sign(ty - y)];
      send("Build", { tool, from: { x, y }, to: { x: nx, y: ny } });
      [x, y] = [nx, ny];
    }
  }
}
const at = ([x, y]: Pt) => ({ x, y });

/** What a command has to say beyond what it changed. */
let report: string[] = [];
for (const [verb, ...rest] of lines) {
  const flags = rest.filter((a) => a.startsWith("--"));
  const args = rest.filter((a) => !a.startsWith("--"));
  switch (verb) {
    case "road":
      stroke(flags.includes("--road") ? "Road" : flags.includes("--one-way") ? "OneWay" : "Street", args.map(tile));
      break;
    case "build":
      stroke({ Building: args[0] }, args.slice(1).map(tile));
      break;
    case "demolish":
      stroke("Demolish", args.map(tile));
      break;
    case "speed":
      send("SetSpeed", Number(args[0]));
      break;
    case "reset":
      send("ResetWorld");
      break;
    case "time":
      break;
    case "watch":
    case "run": {
      trips.clear();
      // The clock as the server has it: a paused town sends no updates.
      const now = async () => (await (await fetch(`http://localhost:${PORT}/health`)).json()).sim_time as number;
      clock.now = await now();
      const to = flags.includes("--to") ? Number(rest[rest.indexOf("--to") + 1]) : undefined;
      const until = to !== undefined
        ? clock.now + (((to - timeOfDay() + 1) % 1) * clock.day_ms)
        : clock.now + (Number(args[0]) * clock.day_ms) / 24;
      const was = clock.speed;
      send("SetSpeed", FULL);
      while ((clock.now = await now()) < until) await Bun.sleep(200);
      send("SetSpeed", was);
      clock.speed = was;
      if (verb === "watch") report = watched();
      break;
    }
    default:
      throw new Error(`no such command: ${verb}`);
  }
  const said = [...changes(await settled()), ...report];
  report = [];
  console.log(`${[verb, ...rest].join(" ")}  [${hhmm(timeOfDay())}, speed ${clock.speed}]`);
  for (const s of said.length ? said : ["time", "speed", "run", "watch"].includes(verb) ? [] : ["  nothing changed"]) console.log(`  ${s}`);
}
ws.close();
