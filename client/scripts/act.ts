/**
 * The mayor's hand, from a command: what the toolbar does, sent to the
 * running game over its own socket, and what changed said back. So an agent
 * can set up a situation and watch it.
 *
 *   bun run act road 10,4 20,4 20,9     a street through these tiles, stepping
 *                                       as the brush does, diagonals and all
 *       --road | --one-way              a through road, or one way
 *   bun run act build House 12,5        a building placed whole round this
 *       build Depot 12,5 0              tile, its front the first way it fits,
 *                                       or this way (0 toward -y, 1 +x, 2 +y,
 *                                       3 -x); a harbour brings its street
 *   bun run act demolish 12,5 14,5      a tap takes what stands on a tile, a
 *                                       building whole; more tiles, the road
 *                                       a drag through them cuts
 *   bun run act undo                    the hand's last action taken back
 *   bun run act speed 0                 sim steps per tick; 0 pauses
 *   bun run act send 18                 depot 18's lorry to the harbour now
 *   bun run act standing 18 on          its standing orders, on or off
 *   bun run act order 18 Timber 2       two boxes of timber from the world
 *   bun run act sell 18 Crates          a box of crates to the world
 *   bun run act rule 18 Stone 20 40     its rule for stone: keep 20, fill to
 *                                       40 (twice the keep if left out)
 *   bun run act run 2                   two hours on at full speed, then the
 *       --to 0.83                       speed it had; or on to this time of
 *                                       day (0 midnight, 0.5 noon)
 *   bun run act watch 2 5,84            two hours on at full speed, every trip
 *                                       round that tile recorded to
 *                                       .dev/paths.json, and every bend tighter
 *                                       than a car turns counted
 *   bun run act time                    the clock, as now and time of day
 *   bun run act missions                the town's missions, each step ticked
 *                                       or not, and what the one at hand says;
 *                                       every command also says the steps it
 *                                       saw done and the missions it saw open
 *   bun run act reset                   a new world
 *   bun run act - < steps.txt           one command a line; # comments
 *
 * Tiles are the game's own (x, y), as `bun run plan --live` numbers them;
 * on the map +x is to the left and +y up. Each command answers with what it
 * made and took away, and a command that changed nothing says so: a
 * building refused and an undo say why, a road step refused is in
 * `.dev/server.log`. The game is the
 * one `bun run dev` runs, or SPRAWL_PORT's. The hand is a player of its
 * own, PLAYER (the browser's is in its localStorage, `sprawl.player`), so
 * its history to undo is its own and outlives the command.
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
const PLAYER = process.env.PLAYER ?? "4242";
/** The town's missions, as the last update had them. */
type Mission = { title: string; finished: number | null; reward: { data: number }; steps: { title: string; text: string; done: boolean; at: number | null }[] };
let missions: Mission[] = [];
/** News heard since the last command said what it saw. */
const told: string[] = [];
const ws = new WebSocket(`ws://localhost:${PORT}/ws?player=${PLAYER}`);
ws.binaryType = "arraybuffer";
ws.onmessage = (e) => {
  const msg = decode(new Uint8Array(e.data as ArrayBuffer)) as { type: string; data: any };
  // The town spending of its own accord, as the news tells a player.
  if (msg.type === "News") for (const n of msg.data) told.push(`news: ${n.text}, ${n.sub}`);
  if (msg.type !== "Update") return;
  clock = msg.data.clock;
  missions = msg.data.missions ?? [];
  if (msg.data.ops.length) (heard = Date.now()), ops.push(...msg.data.ops);
  for (const op of msg.data.ops as Op[]) {
    const trip = op.op === "Upsert" && op.data.object.kind === "Car" && op.data.object.data.trip;
    if (!trip) continue;
    const t: Recorded = { car: (op as any).data.id, role: (op as any).data.object.data.role, route: trip.route_positions, from_lot: trip.from_lot, to_lot: trip.to_lot, backing: trip.backing, cusps: trip.cusps, total_route_length: trip.total_route_length, leaves: trip.leaves, stands: trip.stands };
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
/** What became of the missions over a command: opened, steps done, finished. */
function progress(before: Mission[]): string[] {
  const out: string[] = [];
  for (const m of missions) {
    const was = before.find((b) => b.title === m.title);
    if (!was) out.push(`mission opened: ${m.title}`);
    m.steps.forEach((s, i) => s.done && !was?.steps[i]?.done && out.push(`mission ${m.title}: ${s.title} done`));
    if (m.finished !== null && was?.finished == null) out.push(`mission finished: ${m.title}, +${m.reward.data} coins`);
  }
  return out;
}
/** Every mission, its steps, and what the one at hand says. */
function listed(): string[] {
  return missions.flatMap((m) => {
    const at = m.steps.findIndex((s) => !s.done);
    return [
      `${m.title}${m.finished !== null ? " (finished)" : ""}, +${m.reward.data} coins`,
      ...m.steps.map((s, i) => `  [${s.done ? "x" : " "}] ${s.title}${s.at !== null ? ` (#${s.at})` : ""}${i === at ? `: ${s.text.replace(/\n\n/g, " ")}` : ""}`),
    ];
  });
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

/** A drag through these tiles with this in hand, straight or diagonal: a
 *  road sent whole, as the brush sends it; the demolisher a step at a
 *  time, its tap, one tile alone, taking what stands there. */
function stroke(tool: unknown, pts: Pt[]) {
  if (pts.length === 1) return send("Build", { tool, from: at(pts[0]), to: at(pts[0]) });
  const tiles = [{ at: at(pts[0]), want: 0 }];
  for (let i = 1; i < pts.length; i++) {
    let [x, y] = pts[i - 1];
    const [tx, ty] = pts[i];
    while (x !== tx || y !== ty) {
      [x, y] = [x + Math.sign(tx - x), y + Math.sign(ty - y)];
      if (tool === "Demolish") send("Build", { tool, from: tiles[tiles.length - 1].at, to: { x, y } });
      tiles.push({ at: { x, y }, want: 0 });
    }
  }
  // A road, the drag whole, planned by the game (`draw.rs`).
  if (tool !== "Demolish") send("Draw", { id: Math.floor(Math.random() * 2 ** 30), tool, road: false, tiles });
}
const at = ([x, y]: Pt) => ({ x, y });

/** What a command has to say beyond what it changed. */
let report: string[] = [];
for (const line of lines) {
  const before = missions;
  const [verb, ...rest] = line;
  const flags = rest.filter((a) => a.startsWith("--"));
  const args = rest.filter((a) => !a.startsWith("--"));
  switch (verb) {
    case "road":
      stroke(flags.includes("--road") ? "Road" : flags.includes("--one-way") ? "OneWay" : "Street", args.map(tile));
      break;
    case "build":
      send("Place", { kind: args[0], at: at(tile(args[1])), facing: args[2] === undefined ? null : Number(args[2]) });
      break;
    case "demolish":
      stroke("Demolish", args.map(tile));
      break;
    case "undo":
      send("Undo");
      break;
    case "speed":
      send("SetSpeed", Number(args[0]));
      break;
    // The border: a depot's lorry sent, its standing orders, boxes bought
    // or a box sold. The sea's state is at /sea.
    case "send":
      send("Send", { depot: Number(args[0]) });
      break;
    case "standing":
      send("Standing", { depot: Number(args[0]), on: args[1] !== "off" });
      break;
    case "order":
      send("Order", { depot: Number(args[0]), good: args[1], boxes: Number(args[2] ?? 1) });
      break;
    case "sell":
      send("Sell", { depot: Number(args[0]), good: args[1] });
      break;
    case "rule":
      send("SetRule", { depot: Number(args[0]), good: args[1], rule: { keep: Number(args[2]), fill: Number(args[3] ?? 2 * Number(args[2])), sell: null } });
      break;
    case "reset":
      send("ResetWorld");
      break;
    case "time":
      break;
    case "missions":
      report = listed();
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
  const said = [...changes(await settled()), ...(verb === "missions" ? [] : progress(before)), ...told.splice(0), ...report];
  report = [];
  console.log(`${[verb, ...rest].join(" ")}  [${hhmm(timeOfDay())}, speed ${clock.speed}]`);
  for (const s of said.length ? said : ["time", "speed", "run", "watch", "send", "standing", "order", "sell", "rule", "missions"].includes(verb) ? [] : ["  nothing changed"]) console.log(`  ${s}`);
}
ws.close();
