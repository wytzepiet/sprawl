import { expect, test } from "bun:test";
import { CAR_RIG, curve, driveTrip, LORRY_RIG, type Drive } from "./driver";
import type { Manoeuvre } from "../../generated";
import type { P } from "../geometry";
import { drawnPath } from "./drawnPath";
import { LANE_OFFSET } from "./roadGeometry";

/** A drive sampled finely from end to end: the most any body moves, and
 *  turns, from one sample to the next. */
function jolts(d: Drive, ds = 0.005) {
  let [move, turn] = [0, 0];
  let prev = d.at(0);
  for (let s = ds; s <= d.length; s += ds) {
    const p = d.at(s);
    const [a, b] = [prev.body, p.body];
    move = Math.max(move, Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1]) / ds);
    turn = Math.max(turn, Math.abs(Math.atan2(Math.sin(b.heading - a.heading), Math.cos(b.heading - a.heading))) / ds);
    prev = p;
  }
  return { move, turn };
}

test("a manoeuvre's curve runs from pose to pose, leaving and arriving the way it moves", () => {
  // Backed from the lane round into a dock: moving -x at first, +y at last.
  const m: Manoeuvre = { edge: 1, from: { at: [5.5, 0.4], heading: 0 }, to: { at: [5, 1.0], heading: -Math.PI / 2 }, back: true };
  const c = curve(m);
  expect(c[0]).toEqual(m.from.at);
  expect(Math.hypot(c[c.length - 1][0] - 5, c[c.length - 1][1] - 1.0)).toBeLessThan(1e-9);
  const way = (a: P, b: P) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  expect(Math.cos(way(c[0], c[1]) - Math.PI)).toBeGreaterThan(0.99);
  expect(Math.cos(way(c[c.length - 2], c[c.length - 1]) - Math.PI / 2)).toBeGreaterThan(0.99);
});

test("a truck backed into its dock ends where it stands, facing out, with no jump", () => {
  const stands = { at: [5, 1.0] as P, heading: -Math.PI / 2 };
  const m: Manoeuvre = { edge: 1, from: { at: [5.5, 0.4], heading: 0 }, to: stands, back: true };
  const t = { route_positions: [[2, 0.4], m.from.at, stands.at] as P[], from_lot: 0, to_lot: 2, backing: [[1, 2]] as [number, number][], manoeuvres: [m] };
  const d = driveTrip(t, LORRY_RIG)!;
  const end = d.at(d.length).body;
  expect(Math.hypot(end.at[0] - stands.at[0], end.at[1] - stands.at[1])).toBeLessThan(1e-9);
  expect(Math.cos(end.heading - stands.heading)).toBeGreaterThan(0.99);
  // At the change of gear it faces the way it drove, and backs off the same way.
  const cusp = 3.5;
  expect(Math.cos(d.at(cusp - 0.01).body.heading)).toBeGreaterThan(0.99);
  expect(Math.cos(d.at(cusp + 0.01).body.heading)).toBeGreaterThan(0.99);
  const { move, turn } = jolts(d);
  expect(move).toBeLessThan(2.5);
  expect(turn).toBeLessThan(12);
});

test("whatever the way, a vehicle keeps to it: near it, as far as it, and never a jump", () => {
  // Ways at random, a few hundred, made as the server makes them: lot
  // nodes at either end, where they are, at any angle, from a hand's
  // width apart to a tile (a yard's lane meeting its door, a drive, a kerb
  // bay's swing); streets between, a tile a step, square or diagonal, on
  // their lane. So tight corners, hairpins through a door, and U-turns
  // round a block. Cars, lorries, and cars backing out.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  for (let n = 0; n < 300; n++) {
    let [x, y, h] = [0, 0, Math.floor(rand() * 8) * (Math.PI / 4)];
    const route: P[] = [[x, y]];
    const [fromLot, toLot] = [Math.floor(rand() * 4), Math.floor(rand() * 4)];
    const streets = 2 + Math.floor(rand() * 6);
    const lorry = rand() < 0.5;
    // A car backing out of its drive backs one edge, and drives off
    // forward the way its nose points, or round to one side of it.
    const backsOut = !lorry && rand() < 0.3 ? 1 : 0;
    for (let k = 0; k < fromLot + streets + toLot; k++) {
      const lot = k < fromLot || k >= fromLot + streets;
      if (k === 1 && backsOut) h += Math.PI + pick([Math.PI / 2, -Math.PI / 2, Math.PI / 4, -Math.PI / 4]);
      else if (k > 0) h += lot ? pick([0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) : pick([0, 0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]);
      const l = lot ? pick([0.05, 0.3, 0.5, 1]) : h % (Math.PI / 2) ? Math.SQRT2 : 1;
      [x, y] = [x + Math.cos(h) * l, y + Math.sin(h) * l];
      route.push([x, y]);
    }
    const len = route.length;
    const t = { route_positions: route, from_lot: Math.max(fromLot, backsOut), to_lot: toLot, backing: backsOut ? ([[0, 1]] as [number, number][]) : [] };
    const d = driveTrip(t, lorry ? LORRY_RIG : CAR_RIG);
    if (!d) continue;
    // The way as it is drawn, each part on its own.
    const drawn: P[] = [];
    for (const [i, j] of backsOut ? [[0, 1], [1, len - 1]] : [[0, len - 1]]) {
      const p = drawnPath(route.slice(i, j + 1), LANE_OFFSET, Math.max(t.from_lot - i, i > 0 ? 1 : 0), Math.max(j + 1 - (len - toLot), j < len - 1 ? 1 : 0));
      if (p) drawn.push(...p.points);
    }
    const off = (q: P) => {
      let best = Infinity;
      for (let i = 1; i < drawn.length; i++) {
        const [a, b] = [drawn[i - 1], drawn[i]];
        const [ex, ey] = [b[0] - a[0], b[1] - a[1]];
        const u = Math.max(0, Math.min(1, ((q[0] - a[0]) * ex + (q[1] - a[1]) * ey) / (ex * ex + ey * ey || 1)));
        best = Math.min(best, Math.hypot(q[0] - a[0] - ex * u, q[1] - a[1] - ey * u));
      }
      return best;
    };
    let [travel, stray] = [0, 0];
    let prev = d.at(0);
    for (let s = 0.01; s <= d.length; s += 0.01) {
      const p = d.at(s);
      const step = Math.hypot(p.body.at[0] - prev.body.at[0], p.body.at[1] - prev.body.at[1]);
      travel += step;
      stray = Math.max(stray, off(p.body.at));
      // A hundredth of a tile on, the body never more than two and a half.
      expect(step).toBeLessThan(0.025);
      prev = p;
    }
    // On its way, always, and driven no further than it is long.
    expect(stray).toBeLessThan(1e-6);
    expect(travel).toBeLessThan(d.length + 1e-6);
  }
});

test("a car changing lanes steers across, round no corner, and no jump", () => {
  const road: [number, number][] = Array.from({ length: 11 }, (_, k) => [k, 0.5]);
  const t = { route_positions: road, from_lot: 0, to_lot: 0, backing: [] as [number, number][] };
  const [right, left] = [Array(11).fill(0.11), Array(11).fill(-0.11)];
  const d = driveTrip(t, CAR_RIG, left, { lanes: right, along: 3, over: 1.5 })!;
  const y = (s: number) => d.at(s).body.at[1];
  // In the lane it left before it, in the lane it took after.
  expect(y(2.5)).toBeCloseTo(0.5 + 0.11, 2);
  expect(y(7)).toBeCloseTo(0.5 - 0.11, 2);
  // Across by turning: headed off the road's way while it crosses.
  const turned = Math.max(...Array.from({ length: 30 }, (_, k) => Math.abs(Math.sin(d.at(3 + k * 0.05).body.heading))));
  expect(turned).toBeGreaterThan(0.05);
  // And smoothly: never more than a step's worth sideways between steps.
  for (let s = 2; s < 6; s += 0.02) expect(Math.abs(y(s + 0.02) - y(s))).toBeLessThan(0.02);
});

