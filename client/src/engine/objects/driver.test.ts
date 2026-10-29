import { expect, test } from "bun:test";
import { CAR_RIG, driveTrip, LORRY_RIG, type Drive } from "./driver";
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
    for (const [a, b] of [[prev.body, p.body], [prev.trailer, p.trailer]] as const) {
      if (!a || !b) continue;
      move = Math.max(move, Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1]) / ds);
      turn = Math.max(turn, Math.abs(Math.atan2(Math.sin(b.heading - a.heading), Math.cos(b.heading - a.heading))) / ds);
    }
    prev = p;
  }
  return { move, turn };
}

// A yard: in from the street along the lane, past the dock's mouth to the
// stop beyond it, and backed round into the dock, which faces the lane.
const lane: P[] = [[0, 0.5], [1, 0.5], [2, 0.5], [2.95, 0.5], [2, 0.5], [2, 1.6]];
const dock = { at: [2, 1.6] as P, heading: -Math.PI / 2 };

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
  expect(Math.hypot(end.body.at[0] - dock.at[0], end.body.at[1] - dock.at[1])).toBeLessThan(1e-6);
  expect(Math.cos(end.body.heading - dock.heading)).toBeCloseTo(1, 6);
  // Its box straight behind it, in the dock.
  expect(Math.cos(end.trailer!.heading - dock.heading)).toBeCloseTo(1, 6);
  // At the cusp it is where the server has it: at the stop point.
  const cusp = d.at(3.0).body;
  expect(Math.hypot(cusp.at[0] - 2.95, cusp.at[1] - 0.5)).toBeLessThan(0.15);
});

test("a car leaves from where it stood, though its route points elsewhere", () => {
  const leaves = { at: [0, 0] as P, heading: 0.3 };
  const d = driveTrip({ route_positions: [[0, 0], [0, -1], [1, -1]], from_lot: 1, to_lot: 0, backing: [[0, 1]], leaves }, CAR_RIG)!;
  const start = d.at(0).body;
  expect(Math.hypot(start.at[0], start.at[1])).toBeLessThan(1e-9);
  expect(start.heading).toBeCloseTo(0.3, 9);
  const { move, turn } = jolts(d);
  expect(move).toBeLessThan(2.5);
  expect(turn).toBeLessThan(6);
});

/** How much a drive turns, all told. */
function turning(d: Drive) {
  let [all, prev] = [0, d.at(0).body.heading];
  for (let s = 0.01; s <= d.length; s += 0.01) {
    const h = d.at(s).body.heading;
    all += Math.abs(Math.atan2(Math.sin(h - prev), Math.cos(h - prev)));
    prev = h;
  }
  return all;
}

test("a lorry leaving a yard by a hairpin at its door drives it, not a loop", () => {
  // A depot's yard as the server lays it (`World::build_yard`): out of a
  // dock, along the lane to the door, a few hand widths past the lane's
  // first node, out onto the street and away back along it. Steered on
  // the route as drawn, its corner at the door too tight for any lock,
  // the lorry overshot and came round: four radians of turning for a
  // way that turns three at most.
  const out = { route_positions: [[10.85, 2.56], [10.85, 1.5], [10.55, 1.5], [10.5, 1.5], [10.5, 0.5], [11.5, 0.5], [12.5, 0.5], [13.5, 0.5]] as P[], from_lot: 4, to_lot: 0, backing: [] as [number, number][], leaves: { at: [10.85, 2.56] as P, heading: -Math.PI / 2 } };
  const d = driveTrip(out, LORRY_RIG)!;
  expect(turning(d)).toBeLessThan(3.2);
  expect(jolts(d).move).toBeLessThan(2.5);
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
    let [travel, stray, box] = [0, 0, 0];
    let prev = d.at(0);
    for (let s = 0.01; s <= d.length; s += 0.01) {
      const p = d.at(s);
      const step = Math.hypot(p.body.at[0] - prev.body.at[0], p.body.at[1] - prev.body.at[1]);
      travel += step;
      stray = Math.max(stray, off(p.body.at));
      if (p.trailer && prev.trailer) box = Math.max(box, Math.hypot(p.trailer.at[0] - prev.trailer.at[0], p.trailer.at[1] - prev.trailer.at[1]));
      // A hundredth of a tile on, the body never more than two and a half.
      expect(step).toBeLessThan(0.025);
      prev = p;
    }
    // Never a jump of its box; never further from its way than a little
    // over a lane; never further driven than the way is long, and a bit
    // for the nose swinging out of its corners:
    // a driver who lost the way and went round a loop would be all three.
    expect(box).toBeLessThan(0.04);
    expect(stray).toBeLessThan(0.35);
    expect(travel).toBeLessThan(1.15 * d.length + 0.15);
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

/** The most a vehicle's rear axle moves sideways, of how far it moves,
 *  over any hundredth of a tile: wheels roll, they do not slide. */
function slide(d: Drive, axle: number) {
  const at = (s: number) => {
    const b = d.at(s).body;
    return { x: b.at[0] - Math.cos(b.heading) * axle, y: b.at[1] - Math.sin(b.heading) * axle, h: b.heading };
  };
  let [worst, prev] = [0, at(0)];
  for (let s = 0.01; s <= d.length; s += 0.01) {
    const p = at(s);
    const [dx, dy, h] = [p.x - prev.x, p.y - prev.y, (p.h + prev.h) / 2];
    const [side, on] = [Math.abs(-Math.sin(h) * dx + Math.cos(h) * dy), Math.abs(Math.cos(h) * dx + Math.sin(h) * dy)];
    if (side + on > 0.003) worst = Math.max(worst, side / (side + on));
    prev = p;
  }
  return worst;
}

test("into a drive, a kerb bay, and out of one, the wheels roll and never slide", () => {
  // Off the street into a house's drive, nose first; round into a square
  // bay at the kerb; and backed out of one, round into the lane the way it
  // is going: as the server lays them (`kerb_bays`).
  const drive = { route_positions: [[4.5, 0.5], [3.5, 0.5], [2.5, 0.5], [1.5, 0.5], [0.5, 0.5], [0.61, 1.03]] as P[], from_lot: 0, to_lot: 1, backing: [] as [number, number][], stands: { at: [0.61, 1.03] as P, heading: Math.PI / 2 } };
  const bay = { route_positions: [[61.5, 0.5], [62.5, 0.5], [63.5, 0.5], [63.3, 0.4], [63.775, 0.46], [63.94, 0.625], [64, 0.85], [64, 0.87]] as P[], from_lot: 0, to_lot: 5, backing: [] as [number, number][], stands: { at: [64, 0.87] as P, heading: Math.PI / 2 } };
  const out = { route_positions: [[11.635, 0.87], [11.575, 0.825], [11.41, 0.66], [11.185, 0.6], [12.5, 0.5], [13.5, 0.5], [14.5, 0.5], [15.5, 0.5]] as P[], from_lot: 4, to_lot: 0, backing: [[0, 3]] as [number, number][], leaves: { at: [11.635, 0.87] as P, heading: Math.PI / 2 } };
  for (const t of [drive, bay, out]) {
    const d = driveTrip(t, CAR_RIG)!;
    expect(slide(d, CAR_RIG.axle)).toBeLessThan(0.1);
    expect(jolts(d).move).toBeLessThan(2.5);
    const stands = "stands" in t && t.stands;
    if (stands) {
      const at = d.at(d.length).body;
      expect(Math.hypot(at.at[0] - stands.at[0], at.at[1] - stands.at[1])).toBeLessThan(1e-6);
    }
  }
});
