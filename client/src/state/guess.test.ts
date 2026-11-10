import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { GameProvider, getObjectsAt, guess, setOpsListener } from "./gameObjects";
import { work } from "../engine/budget";
import { MIDDLE } from "../engine/tiles";
import type { ClientMessage, GameObjectEntry, Operation, RoadNode, ServerMessage } from "../generated";

/**
 * The hand's guesses over what the game says (`guess.ts`): shown at once,
 * merged with the game's own roads as they come, and gone, the game's word
 * standing, once it says it did what they guessed; or put back, where it
 * did nothing.
 */

const node = (id: number, x: number, links: number[], joined = true): GameObjectEntry => ({
  id,
  position: { x, y: 0 },
  object: { kind: "RoadNode", data: { outgoing: links, incoming: links, joined, road: [], laid: true, height: 0, light: null, wide: [], side: [0, 0] } },
});
const GROUND = { h: 0, s: MIDDLE };
const outs = (e: GameObjectEntry) => (e.object.data as RoadNode).outgoing;
/** A drag laid by the planner from road 1 at `from` on to a new road at
 *  `to`: the planner's own id for it, 100, new to the game. */
const link = (from: number, to: number) => ({ type: "Laid" as const, laid: { id: 1, put: [node(1, from, [100]), node(100, to, [1])], drop: [], fresh: 100 } });

/** A game on the end of a line that answers when told to. */
function table() {
  let hear: (m: ServerMessage) => void = () => {};
  const line = { send: (_: ClientMessage) => true, close() {} };
  createRoot(() => GameProvider({ connect: (on: typeof hear) => ((hear = on), line), children: null } as never));
  const told: Operation[][] = [];
  setOpsListener((ops) => void told.push(ops));
  const say = (m: ServerMessage) => (hear(m), work(Infinity));
  const update = (ops: Operation[]) => say({ type: "Update", data: { ops, pedals: new Uint8Array(), clock: { now: 0, speed: 0, day_ms: 1 }, town: {} as never, island: { min_cx: 0, min_cy: 0, max_cx: 0, max_cy: 0 } } });
  say({ type: "Welcome", data: 1 });
  update([{ op: "Upsert", data: node(1, 0, []) }]);
  const roads = (x: number) => getObjectsAt(x, 0).filter((e) => e.object.kind === "RoadNode");
  return { line, say, update, roads, told };
}

describe("the hand's guesses", () => {
  test("a step is shown at once, and gives way to the road the game lays", () => {
    const t = table();
    t.line.send({ type: "Undo" });
    guess(link(0, 1));
    const [b] = t.roads(1);
    expect(b.id).toBeLessThan(0);
    expect((b.object.data as RoadNode).joined).toBe(true);
    expect(outs(t.roads(0)[0])).toEqual([b.id]);
    // The game's road lands before it says it is done: one road, the game's.
    t.update([{ op: "Upsert", data: node(1, 0, [10]) }, { op: "Upsert", data: node(10, 1, [1]) }]);
    expect(t.roads(1).map((e) => e.id)).toEqual([10]);
    t.say({ type: "Seen", data: 1 });
    expect(t.roads(1).map((e) => e.id)).toEqual([10]);
    expect(t.roads(0)[0]).toEqual(node(1, 0, [10]));
  });

  test("a step the game did not take is taken back", () => {
    const t = table();
    t.line.send({ type: "Undo" });
    guess(link(0, 1));
    expect(t.roads(1)).toHaveLength(1);
    t.told.length = 0;
    t.say({ type: "Seen", data: 1 });
    expect(t.roads(1)).toHaveLength(0);
    expect(t.roads(0)[0]).toEqual(node(1, 0, []));
    expect(t.told.flat().map((op) => op.op)).toEqual(["Upsert", "Delete"]);
  });

  test("a guess not yet answered stays over what else the game says", () => {
    const t = table();
    t.line.send({ type: "Undo" });
    t.line.send({ type: "Undo" });
    guess(link(0, 1));
    t.say({ type: "Seen", data: 1 });
    t.update([{ op: "Upsert", data: node(1, 0, []) }]);
    expect(t.roads(1)).toHaveLength(1);
    t.say({ type: "Seen", data: 2 });
    expect(t.roads(1)).toHaveLength(0);
  });

  test("a cut and a tap, shown at once", () => {
    const t = table();
    t.update([{ op: "Upsert", data: node(1, 0, [2]) }, { op: "Upsert", data: node(2, 1, [1, 3]) }, { op: "Upsert", data: node(3, 2, [2]) }]);
    t.line.send({ type: "Undo" });
    guess({ type: "Cut", from: { x: 0, y: 0 }, pf: GROUND, to: { x: 1, y: 0 }, pt: GROUND });
    expect(t.roads(0)).toHaveLength(0);
    expect(outs(t.roads(1)[0])).toEqual([3]);
    guess({ type: "Tap", at: { x: 1, y: 0 }, place: GROUND });
    expect([t.roads(0), t.roads(1), t.roads(2)].map((r) => r.length)).toEqual([0, 0, 0]);
    t.say({ type: "Seen", data: 1 });
    expect([t.roads(0), t.roads(1), t.roads(2)].map((r) => r.length)).toEqual([1, 1, 1]);
  });
});
