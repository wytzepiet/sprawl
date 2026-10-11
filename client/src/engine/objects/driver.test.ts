import { expect, test } from "bun:test";
import { CAR_RIG, driveTrip, LORRY_RIG, type Drive, type Pt } from "./driver";

/** A drive sampled finely from end to end: the most any body moves, and
 *  turns, from one sample to the next. */
function jolts(d: Drive, ds = 0.005) {
  let [move, turn] = [0, 0];
  let prev = d.at(0);
  for (let s = ds; s <= d.length; s += ds) {
    const p = d.at(s);
    for (const [a, b] of [[prev.body, p.body], [prev.trailer, p.trailer]] as const) {
      if (!a || !b) continue;
      move = Math.max(move, Math.hypot(b.x - a.x, b.y - a.y) / ds);
      turn = Math.max(turn, Math.abs(Math.atan2(Math.sin(b.heading - a.heading), Math.cos(b.heading - a.heading))) / ds);
    }
    prev = p;
  }
  return { move, turn };
}

// A yard: in from the street along the lane, past the dock's mouth to the
// stop beyond it, and backed round into the dock, which faces the lane.
const lane: Pt[] = [[0, 0.5], [1, 0.5], [2, 0.5], [2.95, 0.5], [2, 0.5], [2, 1.6]];
const dock = { at: [2, 1.6] as Pt, heading: -Math.PI / 2 };

test("backing a lorry into a dock: no jump, no snap, and it ends where it stands", () => {
  // The server's distance at the cusp a little off the drawn one: the
  // part is fitted to it.
  const d = driveTrip({ route_positions: lane, from_lot: 0, to_lot: 5, backing: [[3, 5]], cusps: [3.0], total_route_length: 5.1, stands: dock }, LORRY_RIG)!;
  expect(d.length).toBeCloseTo(5.1, 6);
  const { move, turn } = jolts(d);
  // No body moves much faster than the point the server moves, nor
  // turns tighter than about a third of a tile.
  expect(move).toBeLessThan(2.5);
  expect(turn).toBeLessThan(6);
  const end = d.at(d.length);
  expect(Math.hypot(end.body.x - dock.at[0], end.body.y - dock.at[1])).toBeLessThan(1e-6);
  expect(Math.cos(end.body.heading - dock.heading)).toBeCloseTo(1, 6);
  // Its box straight behind it, in the dock.
  expect(Math.cos(end.trailer!.heading - dock.heading)).toBeCloseTo(1, 6);
  // At the cusp it is where the server has it: at the stop point.
  const cusp = d.at(3.0).body;
  expect(Math.hypot(cusp.x - 2.95, cusp.y - 0.5)).toBeLessThan(0.15);
});

test("a car leaves from where it stood, though its route points elsewhere", () => {
  const leaves = { at: [0, 0] as Pt, heading: 0.3 };
  const d = driveTrip({ route_positions: [[0, 0], [0, -1], [1, -1]], from_lot: 1, to_lot: 0, backing: [[0, 1]], leaves }, CAR_RIG)!;
  const start = d.at(0).body;
  expect(Math.hypot(start.x, start.y)).toBeLessThan(1e-9);
  expect(start.heading).toBeCloseTo(0.3, 9);
  const { move, turn } = jolts(d);
  expect(move).toBeLessThan(2.5);
  expect(turn).toBeLessThan(6);
});
