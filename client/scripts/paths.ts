/**
 * Vehicles' trips as the client drives them (`driver.ts`), and the
 * physics check that reads them (`docs/style.md`, §Three layers of
 * checking). `bun run act watch` records the trips, `bun run plan --live …
 * --paths` draws them, every bend tighter than a car can turn marked.
 */
import { CAB, CAR, TRAILER } from "../src/engine/objects/roadGeometry";
import { CAR_RIG, driveTrip, LORRY_RIG, type Pose } from "../src/engine/objects/driver";

type Pt = [number, number];

/** A trip as the server sent it: its route's points, in the game's tiles,
 *  how many at either end are in a lot, and the stretches backed down. */
export interface Recorded {
  car: number;
  role: string;
  route: Pt[];
  from_lot: number;
  to_lot: number;
  backing: [number, number][];
}

/** A car turns no tighter than this, in tiles (5.5 m). */
export const TIGHTEST = 0.45;

/** How tightly the path turns at each point between two others: the radius
 *  of the circle through the three, in tiles; straight is Infinity. */
export function radii(points: Pt[]): number[] {
  const out = points.map(() => Infinity);
  for (let i = 1; i + 1 < points.length; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    const [ab, bc, ca] = [Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - b[0], c[1] - b[1]), Math.hypot(a[0] - c[0], a[1] - c[1])];
    const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    if (ab < 1e-6 || bc < 1e-6) continue;
    if (cross > 1e-9) out[i] = (ab * bc * ca) / (2 * cross);
    // Doubled straight back on itself: a turn on the spot.
    else if ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0) out[i] = 0;
  }
  return out;
}

/** Which part of a trip a point is on: pulling out of a lot, the street,
 *  or pulling in. By the node it was drawn from. */
export function part(t: Recorded, points: Pt[], i: number): "out" | "street" | "in" {
  // Nodes and points run in order; the nearest node before the point says.
  const p = points[i];
  let best = 0;
  for (let k = 0; k < t.route.length; k++) {
    if (Math.hypot(t.route[k][0] - p[0], t.route[k][1] - p[1]) < Math.hypot(t.route[best][0] - p[0], t.route[best][1] - p[1])) best = k;
  }
  return best < t.from_lot ? "out" : best >= t.route.length - t.to_lot ? "in" : "street";
}

/** A box on the plan: its corners. */
const box = (p: Pose, l: number, w: number): Pt[] => {
  const [c, n] = [Math.cos(p.heading), Math.sin(p.heading)];
  return [[-l / 2, -w / 2], [l / 2, -w / 2], [l / 2, w / 2], [-l / 2, w / 2]].map(([a, b]): Pt => [p.x + c * a - n * b, p.y + n * a + c * b]);
};

/** Every trip as it is driven (`driver.ts`): the track of its middle,
 *  the points on it tighter than a car turns, and the vehicle every so
 *  often along it, a strobe photograph of the drive. */
export const trace = (trips: Recorded[]) =>
  trips.map((t) => {
    const lorry = t.role === "Truck";
    const d = driveTrip(t.route, t.from_lot, t.to_lot, t.backing, lorry ? LORRY_RIG : CAR_RIG);
    if (!d) return { points: [], tight: [], strobe: [] };
    const points: Pt[] = [], strobe: Pt[][] = [];
    for (let s = 0; s <= d.length; s += 0.02) {
      const { body, trailer } = d.at(s);
      points.push([body.x, body.y]);
      if (Math.round(s / 0.02) % 12 === 0) {
        strobe.push(box(body, lorry ? CAB.l : CAR.l, lorry ? CAB.w : CAR.w));
        if (trailer) strobe.push(box(trailer, TRAILER.l, TRAILER.w));
      }
    }
    const r = radii(points);
    return { points, tight: points.filter((_, i) => r[i] < TIGHTEST), strobe };
  });
