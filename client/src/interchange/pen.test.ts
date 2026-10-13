import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decode, encode } from "@msgpack/msgpack";
import init, { Web } from "../wasm/sprawl_web.js";
import { hand, type Hand } from "../engine/may";
import type { ClientMessage, GameObjectEntry, GridCoord, RoadNode, ServerMessage, Tool } from "../generated";
import { Pen } from "./pen";

/**
 * Drags played through the pen (`pen.ts`) against the game itself, the
 * sim compiled to wasm (`cd client && bun run wasm` after changing the
 * server), as the level's worker runs it: each step sent, the world heard
 * back before the next. After every drag the roads are checked for what
 * may never be (`broken`); each case then for what it should have made.
 */

beforeAll(async () => {
  await init({ module_or_path: readFileSync(new URL("../wasm/sprawl_web_bg.wasm", import.meta.url)) });
});

/** Open grass, a gate on its west edge so it is a level. Its rows run
 *  down from y 0 to -20; a case's tiles are written down the page, y
 *  for -y. */
const FIELD = ["# Field", "@gate 1 both", ...Array.from({ length: 21 }, (_, r) => (r === 10 ? "1" : ".") + ".".repeat(20))].join("\n");

type Entry = GameObjectEntry & { object: { kind: "RoadNode"; data: RoadNode } };

class Table {
  web = new Web("field", FIELD);
  entities = new Map<number, GameObjectEntry>();
  world!: Hand;
  tool: Tool = "OneWay";
  pen = 0;
  bounds: { x0: number; y0: number; x1: number; y1: number };
  hand = new Pen({
    world: () => this.world,
    tool: () => this.tool,
    want: () => this.pen * 2,
    priority: () => false,
    inside: (t) => t.x >= this.bounds.x0 && t.x <= this.bounds.x1 && t.y >= this.bounds.y0 && t.y <= this.bounds.y1,
    ground: () => "Grass",
    send: (msg) => this.send(msg),
    lift: (levels) => (this.pen = levels),
  });

  constructor() {
    const s = JSON.parse(this.web.state());
    this.bounds = { x0: s.min_x, y0: s.min_y, x1: s.max_x, y1: s.max_y };
    // What a client is sent is what it looks at, as the camera asks.
    this.web.send(encode({ type: "SetChunks", data: { min_cx: -4, min_cy: -4, max_cx: 4, max_cy: 4 } }));
    this.hear();
  }

  send(msg: ClientMessage) {
    this.web.send(encode(msg));
    this.hear();
  }

  hear() {
    this.web.tick();
    for (const bytes of this.web.drain() as Uint8Array[]) {
      const msg = decode(bytes) as ServerMessage;
      if (msg.type !== "Update") continue;
      for (const op of msg.data.ops) {
        if (op.op === "Upsert") this.entities.set(op.data.id, op.data);
        else this.entities.delete(op.data);
      }
    }
    this.world = hand((f) => this.entities.forEach(f), () => "Grass");
  }

  /** A drag through these tiles, corner to corner, a step at a time; how
   *  many steps were left when one was refused, as the pointer would go
   *  on and the road not. */
  drag(tool: Tool, ...corners: [number, number][]): number {
    this.tool = tool;
    const [x0, y0] = corners[0];
    this.hand.press({ x: x0, y: -y0 }, x0 + 0.5, -y0 + 0.5);
    const steps: GridCoord[] = [];
    let [x, y] = [x0, y0];
    for (const [cx, cy] of corners.slice(1)) {
      while (x !== cx || y !== cy) {
        [x, y] = [x + Math.sign(cx - x), y + Math.sign(cy - y)];
        steps.push({ x, y: -y });
      }
    }
    const taken = steps.findIndex((s) => !this.hand.step(s));
    this.hand.release();
    return taken < 0 ? 0 : steps.length - taken;
  }

  roads(): Entry[] {
    return [...this.entities.values()].filter((e): e is Entry => e.object.kind === "RoadNode" && !!e.position);
  }

  /** The roads on a tile: side and links, as `x,y:side>outs<ins`. */
  on(x: number, y: number): { side: [number, number]; h: number; n: RoadNode; id: number }[] {
    return this.roads().filter((e) => e.position!.x === x && e.position!.y === -y).map((e) => ({ side: e.object.data.side as [number, number], h: e.object.data.height, n: e.object.data, id: e.id }));
  }

  /** What may never be, said; none, nothing. */
  broken(): string[] {
    const out: string[] = [];
    const roads = this.roads();
    if (!roads.some((e) => e.object.data.laid)) out.push("no road laid at all");
    const byId = new Map(roads.map((e) => [e.id, e]));
    const at = (id: number) => byId.get(id)?.position as GridCoord | undefined;
    const tiles = new Map<string, Entry[]>();
    for (const e of roads) {
      const k = `${e.position!.x},${e.position!.y}`;
      (tiles.get(k) ?? tiles.set(k, []).get(k)!).push(e);
    }
    for (const [k, here] of tiles) {
      const places = here.map((e) => `${e.object.data.height}:${e.object.data.side}`);
      if (new Set(places).size !== places.length) out.push(`${k}: two roads in one place ${places}`);
      for (const h of new Set(here.map((e) => e.object.data.height))) {
        const level = here.filter((e) => e.object.data.height === h);
        const sides = level.filter((e) => e.object.data.side[0] || e.object.data.side[1]);
        if (sides.length && sides.length !== level.length) out.push(`${k}@${h}: a road in the middle beside one on a side`);
        if (sides.length === 1) out.push(`${k}@${h}: a road on a side with none beside it`);
        if (sides.length === 2 && (sides[0].object.data.side[0] !== -sides[1].object.data.side[0] || sides[0].object.data.side[1] !== -sides[1].object.data.side[1])) out.push(`${k}@${h}: two roads on sides not opposite ${sides.map((e) => e.object.data.side)}`);
        if (sides.length > 2) out.push(`${k}@${h}: ${sides.length} roads on sides`);
      }
    }
    for (const e of roads) {
      const n = e.object.data;
      const p = e.position!;
      const arms = [...new Set([...n.outgoing, ...n.incoming])];
      for (const o of arms) {
        const q = at(o);
        if (!q) out.push(`${p.x},${p.y}: a link to nothing`);
        else if (Math.abs(q.x - p.x) > 1 || Math.abs(q.y - p.y) > 1 || (q.x === p.x && q.y === p.y)) out.push(`${p.x},${p.y}: a link to ${q.x},${q.y}`);
      }
      // A road through a tile runs through it: in by one way, out by
      // another, unless it ends there.
      const ins = arms.filter((o) => byId.get(o)?.object.data.outgoing.includes(e.id));
      const outs = n.outgoing;
      if (arms.length >= 2 && (!ins.length || !outs.length) && n.laid) out.push(`${p.x},${p.y}${n.side.join() !== "0,0" ? `(${n.side})` : ""}: ${ins.length ? "nowhere to go" : "no way in"}`);
      // A road on a side is its run beside the other, and one road joining
      // it at most (`World::may_lay_at`).
      if ((n.side[0] || n.side[1]) && arms.length > 3) out.push(`${p.x},${p.y}(${n.side}): a road on a side with ${arms.length} arms`);
    }
    // Two links over one tile corner, crossing at one level.
    const links = roads.flatMap((e) => e.object.data.outgoing.map((o) => [e, byId.get(o)!] as const)).filter(([, b]) => b);
    for (const [a, b] of links) {
      const [p, q] = [a.position!, b.position!];
      if (p.x === q.x || p.y === q.y) continue;
      const crossing = links.find(([c, d]) => {
        const [r, s] = [c.position!, d.position!];
        const corner = (r.x === p.x && r.y === q.y && s.x === q.x && s.y === p.y) || (s.x === p.x && s.y === q.y && r.x === q.x && r.y === p.y);
        const twice = a.object.data.height + b.object.data.height;
        return corner && Math.abs(c.object.data.height + d.object.data.height - twice) < 4;
      });
      if (crossing) out.push(`${p.x},${p.y}-${q.x},${q.y}: crosses a link over the same corner`);
    }
    return [...new Set(out)];
  }
}

const sideOf = (t: Table, x: number, y: number) => t.on(x, y).map((r) => r.side.join()).sort();

describe("one-ways side by side", () => {
  test("opposing one-ways down the same tiles go side by side", () => {
    const t = new Table();
    expect(t.drag("OneWay", [2, 5], [10, 5])).toBe(0);
    expect(t.drag("OneWay", [10, 5], [2, 5])).toBe(0);
    expect(t.broken()).toEqual([]);
    for (let x = 3; x <= 9; x++) expect(sideOf(t, x, 5)).toEqual(["0,-1", "0,1"]);
  });

  test("a pair round a bend", () => {
    const t = new Table();
    expect(t.drag("OneWay", [3, 2], [3, 8], [9, 8])).toBe(0);
    expect(t.drag("OneWay", [9, 8], [3, 8], [3, 2])).toBe(0);
    expect(t.broken()).toEqual([]);
    expect(t.on(3, 8)).toHaveLength(2);
  });

  test("a pair drawn on: the drag starts at one's end and goes on", () => {
    const t = new Table();
    t.drag("OneWay", [2, 5], [8, 5]);
    t.drag("OneWay", [8, 5], [2, 5]);
    expect(t.drag("OneWay", [8, 5], [12, 5])).toBe(0);
    expect(t.broken()).toEqual([]);
  });

  test("against a one-way met from the side: beside it", () => {
    const t = new Table();
    t.drag("OneWay", [12, 5], [2, 5]);
    expect(t.drag("OneWay", [5, 9], [5, 5], [9, 5])).toBe(0);
    expect(t.broken()).toEqual([]);
    for (let x = 5; x <= 9; x++) expect(t.on(x, 5)).toHaveLength(2);
  });

  test("with a one-way met from the side: joined", () => {
    const t = new Table();
    t.drag("OneWay", [12, 5], [2, 5]);
    expect(t.drag("OneWay", [8, 9], [8, 5], [5, 5])).toBe(0);
    expect(t.broken()).toEqual([]);
    for (let x = 2; x <= 12; x++) expect(t.on(x, 5)).toHaveLength(1);
  });

  test("a diagonal over a pair's bend", () => {
    const t = new Table();
    t.drag("OneWay", [5, 2], [5, 8], [11, 8]);
    t.drag("OneWay", [11, 8], [5, 8], [5, 2]);
    t.drag("OneWay", [2, 11], [8, 5]);
    expect(t.broken()).toEqual([]);
  });

  test("a diagonal over a one-way's bend", () => {
    const t = new Table();
    t.drag("OneWay", [5, 2], [5, 8], [11, 8]);
    t.drag("OneWay", [2, 11], [8, 5]);
    expect(t.broken()).toEqual([]);
  });

  test("two opposing one-ways into a two-way", () => {
    const t = new Table();
    t.drag("Street", [6, 16], [6, 10]);
    t.drag("OneWay", [6, 10], [6, 3]);
    t.drag("OneWay", [6, 3], [6, 10]);
    expect(t.broken()).toEqual([]);
  });

  test("a third one-way down a pair", () => {
    const t = new Table();
    t.drag("OneWay", [2, 5], [10, 5]);
    t.drag("OneWay", [10, 5], [2, 5]);
    t.drag("OneWay", [2, 5], [10, 5]);
    expect(t.broken()).toEqual([]);
  });

  test("across a pair, a two-way and a one-way stop at it: right in, right out", () => {
    const t = new Table();
    t.drag("OneWay", [2, 5], [12, 5]);
    t.drag("OneWay", [12, 5], [2, 5]);
    t.drag("Street", [5, 1], [5, 9]);
    t.drag("OneWay", [9, 1], [9, 9]);
    expect(t.broken()).toEqual([]);
    for (const x of [5, 9]) for (let y = 6; y <= 9; y++) expect(t.on(x, y)).toHaveLength(0);
  });

  test("one of a pair taken up: the other back to the middle", () => {
    const t = new Table();
    t.drag("OneWay", [2, 5], [10, 5]);
    t.drag("OneWay", [10, 5], [2, 5]);
    t.drag("Demolish", [2, 5], [10, 5]);
    expect(t.broken()).toEqual([]);
  });

  test("a one-way that turns back on itself", () => {
    const t = new Table();
    t.drag("OneWay", [2, 5], [10, 5], [10, 6], [2, 6]);
    t.drag("OneWay", [4, 3], [4, 5], [8, 5]);
    expect(t.broken()).toEqual([]);
  });

  test("a one-way back down its own tiles in one drag", () => {
    const t = new Table();
    t.drag("OneWay", [2, 5], [10, 5], [2, 5]);
    expect(t.broken()).toEqual([]);
  });

  test("along a pair, a one-way the way one of them runs: it follows it", () => {
    const t = new Table();
    t.drag("OneWay", [2, 5], [10, 5]);
    t.drag("OneWay", [10, 5], [2, 5]);
    t.drag("OneWay", [2, 5], [10, 5]);
    expect(t.broken()).toEqual([]);
    for (let x = 3; x <= 9; x++) expect(t.on(x, 5)).toHaveLength(2);
  });

  test("along a pair, a two-way", () => {
    const t = new Table();
    t.drag("OneWay", [2, 5], [10, 5]);
    t.drag("OneWay", [10, 5], [2, 5]);
    t.drag("Street", [2, 5], [10, 5]);
    expect(t.broken()).toEqual([]);
  });

  test("started on a one-way's middle, against it: beside it from there", () => {
    const t = new Table();
    t.drag("OneWay", [2, 5], [12, 5]);
    expect(t.drag("OneWay", [8, 5], [4, 5])).toBe(0);
    expect(t.broken()).toEqual([]);
    for (let x = 4; x <= 8; x++) expect(t.on(x, 5)).toHaveLength(2);
  });

  test("a pair down a diagonal", () => {
    const t = new Table();
    t.drag("OneWay", [2, 2], [9, 9]);
    t.drag("OneWay", [9, 9], [2, 2]);
    expect(t.broken()).toEqual([]);
    for (let k = 3; k <= 8; k++) expect(t.on(k, k)).toHaveLength(2);
  });

  test("a pair down a diagonal and round a bend", () => {
    const t = new Table();
    t.drag("OneWay", [2, 2], [6, 6], [12, 6]);
    t.drag("OneWay", [12, 6], [6, 6], [2, 2]);
    expect(t.broken()).toEqual([]);
  });

  test("a pair's other one drawn on", () => {
    const t = new Table();
    t.drag("OneWay", [2, 5], [8, 5]);
    t.drag("OneWay", [8, 5], [2, 5]);
    t.drag("OneWay", [12, 5], [8, 5]);
    expect(t.broken()).toEqual([]);
  });

  test("into a pair from the side, ending there; out of it from the side", () => {
    const t = new Table();
    t.drag("OneWay", [2, 5], [12, 5]);
    t.drag("OneWay", [12, 5], [2, 5]);
    t.drag("OneWay", [5, 9], [5, 5]);
    t.drag("OneWay", [9, 5], [9, 9]);
    t.drag("OneWay", [7, 1], [7, 5]);
    expect(t.broken()).toEqual([]);
  });

  test("a pair, one tile of one taken up", () => {
    const t = new Table();
    t.drag("OneWay", [2, 5], [10, 5]);
    t.drag("OneWay", [10, 5], [2, 5]);
    t.drag("Demolish", [6, 5], [6, 5]);
    expect(t.broken()).toEqual([]);
  });

  test("a pair drawn and undone", () => {
    const t = new Table();
    t.drag("OneWay", [2, 5], [10, 5]);
    t.drag("OneWay", [10, 5], [2, 5]);
    t.web.send(encode({ type: "Undo" }));
    t.hear();
    expect(t.broken()).toEqual([]);
    for (let x = 3; x <= 9; x++) expect(t.on(x, 5)).toHaveLength(1);
  });

  test("a pair over a pair, a level up", () => {
    const t = new Table();
    t.drag("OneWay", [2, 8], [14, 8]);
    t.drag("OneWay", [14, 8], [2, 8]);
    t.pen = 1;
    t.drag("OneWay", [8, 2], [8, 14]);
    t.drag("OneWay", [8, 14], [8, 2]);
    expect(t.broken()).toEqual([]);
  });

  test("a one-way across a one-way's bend, and a diagonal across its corner", () => {
    const t = new Table();
    t.drag("OneWay", [5, 2], [5, 8], [11, 8]);
    t.drag("OneWay", [2, 8], [8, 8]);
    t.drag("OneWay", [2, 12], [9, 5]);
    expect(t.broken()).toEqual([]);
  });

  test("zigzags beside a one-way", () => {
    const t = new Table();
    t.drag("OneWay", [14, 5], [2, 5]);
    t.drag("OneWay", [3, 6], [4, 5], [6, 5], [7, 4], [8, 5], [11, 5], [12, 6]);
    expect(t.broken()).toEqual([]);
  });

  test("on into a one-way's end, its way: joined, not beside it", () => {
    const t = new Table();
    t.drag("OneWay", [10, 5], [14, 5]);
    expect(t.drag("OneWay", [4, 5], [10, 5])).toBe(0);
    expect(t.broken()).toEqual([]);
    for (let x = 4; x <= 14; x++) expect(t.on(x, 5)).toHaveLength(1);
  });

  test("on into a one-way's end, against it: beside it", () => {
    const t = new Table();
    t.drag("OneWay", [14, 5], [10, 5]);
    expect(t.drag("OneWay", [4, 5], [12, 5])).toBe(0);
    expect(t.broken()).toEqual([]);
  });

  test("the pen raised mid-drag: the tile it is on climbs, and on, a level up", () => {
    const t = new Table();
    t.tool = "Street";
    t.hand.press({ x: 2, y: -5 }, 2.5, -4.5);
    for (let x = 3; x <= 5; x++) t.hand.step({ x, y: -5 });
    t.hand.climb(1)!();
    for (let x = 6; x <= 9; x++) t.hand.step({ x, y: -5 });
    t.hand.release();
    expect(t.broken()).toEqual([]);
    expect([2, 3, 4, 5, 6, 7].map((x) => t.on(x, 5)[0]?.h)).toEqual([0, 0, 0, 1, 2, 2]);
  });

  test("raised after it is let go: the drag's end is the slope", () => {
    const t = new Table();
    t.drag("Street", [2, 5], [8, 5]);
    t.hand.climb(1)!();
    expect(t.broken()).toEqual([]);
    expect([6, 7, 8].map((x) => t.on(x, 5)[0]?.h)).toEqual([0, 0, 1]);
  });

  test("a street onto a street at 45 degrees, and a one-way", () => {
    const t = new Table();
    t.drag("Street", [2, 5], [12, 5]);
    t.drag("Street", [2, 1], [6, 5]);
    t.drag("OneWay", [12, 1], [8, 5]);
    expect(t.broken()).toEqual([]);
    expect(t.on(5, 4)).toHaveLength(1);
    expect(t.on(9, 4)).toHaveLength(1);
  });
});
