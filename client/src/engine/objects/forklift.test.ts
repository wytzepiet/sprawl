import { expect, test } from "bun:test";
import { forkliftAt, REST_MS, type End, type Yard } from "./forklift";
import { DROP, ends, PICK } from "./pads";
import type { Lift } from "../../generated";
import { HANDLE_MS } from "../../generated/rows";

// A depot's aisle along y = 0, its bay on the aisle's side at y = 0.4
// facing it, and the aisle's end at x = 1.4; a lorry beyond, its flatbed
// along y at x = 2.5, its packages one behind the other.
const bay = (i: number): End => ({ at: [0.4 + 0.1 * (i % 3), 0.4], face: -Math.PI / 2, z: 0.05, inside: true, reach: 0.1 });
const bed = (i: number): End => ({ at: [2.5, -0.2 + 0.09 * i], face: Math.PI, z: 0.09, inside: false, reach: 0.135 });
const yard: Yard = {
  id: 1,
  home: { at: [1.2, 0], heading: Math.PI },
  homeInside: true,
  exits: [[1.4, 0]],
  aisle: [[0, 0], [1.4, 0]],
  ends: (l, j) => (l.onto ? { from: bay(j), to: bed(j) } : { from: bed(l.n - 1 - j), to: bay(j) }),
};
const every = HANDLE_MS;
// Three on, two off straight after, and one more on as it heads home.
const lifts: Lift[] = [
  { car: 2, good: "Timber", n: 3, onto: true, start: 0, every, k: 0 },
  { car: 2, good: "Timber", n: 2, onto: false, start: 3 * every, every, k: 0 },
  { car: 2, good: "Timber", n: 1, onto: true, start: 5 * every + 1500, every, k: 0 },
];

test("a forklift drives its runs: never a jump, a snap, or faster than anything drives", () => {
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  let last = forkliftAt(yard, lifts, -10);
  expect(last.truck).toEqual(yard.home);
  let fastest = 0;
  for (let t = 0; t < ends(lifts[2]) + REST_MS; t += 10) {
    const now = forkliftAt(yard, lifts, t);
    const step = Math.hypot(now.truck.at[0] - last.truck.at[0], now.truck.at[1] - last.truck.at[1]);
    fastest = Math.max(fastest, step / 0.01);
    expect(Math.abs(wrap(now.truck.heading - last.truck.heading))).toBeLessThan(0.1);
    last = now;
  }
  expect(fastest).toBeLessThan(3);
  expect(last.truck).toEqual(yard.home);
});

test("the package is in its forks from where it stood to where it goes, and only then", () => {
  const near = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  for (const l of lifts)
    for (let j = 0; j < l.n; j++) {
      const t0 = l.start + j * every;
      const { from, to } = yard.ends(l, j)!;
      expect(forkliftAt(yard, lifts, t0 + (PICK - 0.01) * every).load).toBeNull();
      expect(near(forkliftAt(yard, lifts, t0 + PICK * every + 1).load!.at.at, from.at)).toBeLessThan(0.01);
      expect(near(forkliftAt(yard, lifts, t0 + DROP * every - 1).load!.at.at, to.at)).toBeLessThan(0.01);
      expect(forkliftAt(yard, lifts, t0 + DROP * every + 1).load).toBeNull();
    }
});

test("it comes to a flatbed from its side and to a bay from its face, never through them", () => {
  for (let t = 0; t < ends(lifts[2]); t += 10) {
    const [x, y] = forkliftAt(yard, lifts, t).truck.at;
    // Its nose never over the flatbed, nor in the bay's row behind its face.
    expect(x + 0.045).toBeLessThan(2.5 - 0.085);
    expect(y).toBeLessThan(0.4 - 0.05);
  }
});
