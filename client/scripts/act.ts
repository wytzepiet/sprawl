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
 *   bun run act demolish 12,5 14,5      a tap takes the road on a tile; more
 *                                       tiles, the road a drag through them
 *                                       cuts
 *   bun run act raze 12,5               the building on that tile taken down
 *                                       whole
 *   bun run act lorry 79                another lorry for depot #79
 *   bun run act research Farm           the labs set to learning the farm;
 *                                       alone, what is open and being learned
 *   bun run act undo                    the hand's last road laid or taken up,
 *                                       taken back (the interchange's Z)
 *   bun run act speed 0                 sim steps per tick; 0 pauses
 *   bun run act buy Timber 2            two bundles of timber from the market, on
 *       sell Crates                     the next ferry; or a crate of food sold
 *   bun run act order buy Fuel 3 0.9    three pallets of fuel bought once its
 *                                       price (a unit) falls to 0.9; `sell`,
 *                                       once it rises to it
 *   bun run act cancel 57               order 57 taken back
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
 * made and took away, and a command that changed nothing says so: a
 * building refused and an undo say why, a road step refused is in
 * `.dev/server.log`. The game is the
 * one `bun run dev` runs, or SPRAWL_PORT's. The hand is a player of its
 * own, PLAYER (the browser's is in its localStorage, `sprawl.player`), so
 * its history to undo is its own and outlives the command.
 */
import { PORT, ROOT } from "./lib";
import { connect } from "./game";
import { part, radii, TIGHTEST, trace, type Recorded } from "./paths";
import type { P } from "../src/engine/geometry";
import type { BuildingKind, GameObjectEntry, Good, Operation, Research, Tool } from "../src/generated";

/** Quiet this long and the server has said all it will about a command;
 *  silent this long, and it will say nothing. */
const SETTLE_MS = 400;
const WAIT_MS = 5000;
/** The server's top speed (`MAX_SPEED` in `game_loop`). */
const FULL = 50;


const lines = process.argv[2] === "-"
  ? (await Bun.stdin.text()).split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean).map((l) => l.split(/\s+/))
  : [process.argv.slice(2)];
const tile = (s: string): P => {
  const m = s.match(/^(-?\d+),(-?\d+)$/);
  if (!m) throw new Error(`not a tile: ${s} (want x,y)`);
  return [Number(m[1]), Number(m[2])];
};

const known = new Map<number, GameObjectEntry>();
let heard = Date.now();
let ops: Operation[] = [];
/** Every trip seen, once each. */
const trips = new Map<string, Recorded>();
const PLAYER = process.env.PLAYER ?? "4242";
/** News heard since the last command said what it saw. */
const told: string[] = [];
/** What the town may build and is learning, as the last update had it. */
let learned: Research = { open: [], next: [], at: null, done: 0, of: 0, cost: 0 };
// The chunks every tile named lies in, a chunk round, so the server tells
// us of what is built there.
const named = lines.flat().filter((a) => /^-?\d+,-?\d+$/.test(a)).map(tile);
const game = await connect({
  tiles: named.length ? named : [[0, 0]],
  player: PLAYER,
  hear: (msg) => {
    // The town spending of its own accord, as the news tells a player.
    if (msg.type === "News") for (const n of msg.data) told.push(`news: ${n.text}, ${n.sub}`);
    if (msg.type !== "Update") return;
    learned = msg.data.research ?? learned;
    if (msg.data.ops.length) (heard = Date.now()), ops.push(...msg.data.ops);
    for (const op of msg.data.ops) {
      if (op.op !== "Upsert" || op.data.object.kind !== "Car" || !op.data.object.data.trip) continue;
      const { role, trip } = op.data.object.data;
      const t: Recorded = { car: op.data.id, role, route: trip.route_positions, from_lot: trip.from_lot, to_lot: trip.to_lot, backing: trip.backing, cusps: trip.cusps, total_route_length: trip.total_route_length, leaves: trip.leaves, stands: trip.stands };
      trips.set(`${t.car}:${JSON.stringify(t.route)}`, t);
    }
  },
});
const { clock, send } = game;
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
function changes(batch: Operation[]): string[] {
  const made: GameObjectEntry[] = [], gone: GameObjectEntry[] = [];
  for (const op of batch) {
    if (op.op === "Upsert") {
      if (!known.has(op.data.id)) made.push(op.data);
      known.set(op.data.id, op.data);
    } else if (known.has(op.data)) {
      gone.push(known.get(op.data)!);
      known.delete(op.data);
    }
  }
  const say = (e: GameObjectEntry) => {
    const at = e.position ? ` at ${e.position.x},${e.position.y}` : "";
    return e.object.kind === "Building" ? `${e.object.data.kind} #${e.id}${at}` : `${e.object.kind}${at}`;
  };
  const quiet = (e: GameObjectEntry) => e.object.kind === "Car" || e.object.kind === "Resident";
  const roads = (es: GameObjectEntry[]) => es.filter((e) => e.object.kind === "RoadNode").length;
  const rest = (es: GameObjectEntry[]) => es.filter((e) => !quiet(e) && e.object.kind !== "RoadNode").map(say);
  return [
    ...(roads(made) ? [`+ ${roads(made)} road tiles`] : []), ...rest(made).map((s) => `+ ${s}`),
    ...(roads(gone) ? [`- ${roads(gone)} road tiles`] : []), ...rest(gone).map((s) => `- ${s}`),
  ];
}
/** The trips seen, kept for `bun run plan --paths`, and their bends
 *  tighter than a car turns, by where on the trip they are. */
function watched(): string[] {
  const all = [...trips.values()];
  Bun.write(`${ROOT}/.dev/paths.json`, JSON.stringify(all));
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

changes(await settled());

/** A drag through these tiles with this in hand, straight or diagonal: a
 *  road sent whole, as the brush sends it; the demolisher a step at a
 *  time, its tap, one tile alone, taking the road there. */
function stroke(tool: Tool, pts: P[], road = false) {
  if (pts.length === 1) return send({ type: "Build", data: { tool, from: at(pts[0]), to: at(pts[0]), road } });
  const tiles = [{ at: at(pts[0]), want: 0 }];
  for (let i = 1; i < pts.length; i++) {
    let [x, y] = pts[i - 1];
    const [tx, ty] = pts[i];
    while (x !== tx || y !== ty) {
      [x, y] = [x + Math.sign(tx - x), y + Math.sign(ty - y)];
      if (tool === "Demolish") send({ type: "Build", data: { tool, from: tiles[tiles.length - 1].at, to: { x, y }, road } });
      tiles.push({ at: { x, y }, want: 0 });
    }
  }
  // A road, the drag whole, planned by the game (`draw.rs`).
  if (tool !== "Demolish") send({ type: "Draw", data: { id: Math.floor(Math.random() * 2 ** 30), tool, road, tiles } });
}
const at = ([x, y]: P) => ({ x, y });

/** What a command has to say beyond what it changed. */
let report: string[] = [];
for (const line of lines) {
  const [verb, ...rest] = line;
  const flags = rest.filter((a) => a.startsWith("--"));
  const args = rest.filter((a) => !a.startsWith("--"));
  switch (verb) {
    case "road":
      stroke(flags.includes("--one-way") ? "OneWay" : "Street", args.map(tile), flags.includes("--road"));
      break;
    case "build":
      send({ type: "Place", data: { kind: args[0] as BuildingKind, at: at(tile(args[1])), facing: args[2] === undefined ? null : Number(args[2]) } });
      break;
    case "demolish":
      stroke("Demolish", args.map(tile));
      break;
    case "raze": {
      const [x, y] = tile(args[0]);
      const b = [...known.values()].find((e) => e.object.kind === "Building" && e.object.data.tiles.some((t: { x: number; y: number }) => t.x === x && t.y === y));
      if (b) send({ type: "Raze", data: { building: b.id } });
      else report.push(`nothing stands at ${x},${y}`);
      break;
    }
    case "research":
      if (args[0]) send({ type: "Research", data: { kind: args[0] as BuildingKind } });
      else report = [`open: ${learned.open.join(", ")}`, `next: ${learned.next.join(", ")}, ${learned.cost} researcher-hours each`, learned.at ? `learning ${learned.at}: ${learned.done} of ${learned.of}` : "learning nothing"];
      break;
    case "lorry":
      send({ type: "BuyLorry", data: { depot: Number(args[0]) } });
      break;
    case "undo":
      send({ type: "Undo" });
      break;
    case "speed":
      send({ type: "SetSpeed", data: Number(args[0]) });
      break;
    // The border: the market. The sea's state, and the
    // market's, is at /sea.
    case "buy":
    case "sell":
      send({ type: "Trade", data: { good: args[0] as Good, packages: Number(args[1] ?? 1), out: verb === "sell" } });
      break;
    case "order":
      send({ type: "Order", data: { out: args[0] === "sell", good: args[1] as Good, packages: Number(args[2]), price: Number(args[3]) } });
      break;
    case "cancel":
      send({ type: "Cancel", data: { order: Number(args[0]) } });
      break;
    case "reset":
      send({ type: "ResetWorld" });
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
      send({ type: "SetSpeed", data: FULL });
      while ((clock.now = await now()) < until) await Bun.sleep(200);
      send({ type: "SetSpeed", data: was });
      clock.speed = was;
      if (verb === "watch") report = watched();
      break;
    }
    default:
      throw new Error(`no such command: ${verb}`);
  }
  const said = [...changes(await settled()), ...told.splice(0), ...report];
  report = [];
  console.log(`${[verb, ...rest].join(" ")}  [${hhmm(timeOfDay())}, speed ${clock.speed}]`);
  for (const s of said.length ? said : ["time", "speed", "run", "watch", "buy", "sell", "order", "cancel"].includes(verb) ? [] : ["  nothing changed"]) console.log(`  ${s}`);
}
game.close();
