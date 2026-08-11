import { expect, test } from "bun:test";
import { buildRoadGeometry, HALF_W, type ArmInfo, type Flow } from "./roadGeometry";

const FLOWS: Flow[] = ["twoway", "out", "in"];

/**
 * Triangles wound the wrong way are invisible under back-face culling, so a
 * broken node looks like a missing road rather than a wrong one. Count them.
 */
function invertedTriangles(geo: { positions: number[]; indices: number[] }): number {
  let bad = 0;
  for (let i = 0; i < geo.indices.length; i += 3) {
    const [a, b, c] = [geo.indices[i], geo.indices[i + 1], geo.indices[i + 2]];
    const ax = geo.positions[a * 3], ay = geo.positions[a * 3 + 1];
    const bx = geo.positions[b * 3], by = geo.positions[b * 3 + 1];
    const cx = geo.positions[c * 3], cy = geo.positions[c * 3 + 1];
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 1e-9) bad++;
  }
  return bad;
}

/** Every arm set the grid allows, with every flow assignment. */
function everyConfiguration(): ArmInfo[][] {
  const out: ArmInfo[][] = [];
  for (let mask = 1; mask < 256; mask++) {
    const dirs: number[] = [];
    for (let i = 0; i < 8; i++) if (mask & (1 << i)) dirs.push(i);
    for (let c = 0; c < FLOWS.length ** dirs.length; c++) {
      let n = c;
      out.push(
        dirs.map((d) => {
          const flow = FLOWS[n % FLOWS.length];
          n = Math.floor(n / FLOWS.length);
          return { angle: (d * Math.PI) / 4, flow };
        }),
      );
    }
  }
  return out;
}

test("every node the grid can produce winds one way", () => {
  const broken: string[] = [];
  for (const arms of everyConfiguration()) {
    const geo = buildRoadGeometry(arms, HALF_W, 0.02);
    if (geo && invertedTriangles(geo) > 0) {
      broken.push(arms.map((a) => `${(a.angle * 180) / Math.PI}${a.flow[0]}`).join(","));
    }
  }
  expect(broken).toEqual([]);
});

/**
 * Arms only ever point at the eight grid neighbours, so a road outline never
 * needs to pinch tighter than its own half-width. Dipping below that means the
 * boundary has folded back through the node it is drawn around.
 */
test("no outline folds back through its own node", () => {
  for (const arms of everyConfiguration()) {
    const geo = buildRoadGeometry(arms, HALF_W, 0.02);
    if (!geo) continue;
    // Vertex 0 is the fan centre; the rest are the boundary.
    for (let i = 1; i * 3 < geo.positions.length; i++) {
      const d = Math.hypot(geo.positions[i * 3], geo.positions[i * 3 + 1]);
      expect(d).toBeGreaterThanOrEqual(HALF_W - 1e-9);
    }
  }
});

/**
 * The outside of a turn is where the two outer edges meet. An arc of the road's
 * own half-width never reaches that point and visibly chamfers the corner off,
 * so require the outline to get out past it.
 */
test("the outside of a right-angle turn reaches its corner", () => {
  const arms: ArmInfo[] = [
    { angle: 0, flow: "twoway" },
    { angle: Math.PI / 2, flow: "twoway" },
  ];
  const geo = buildRoadGeometry(arms, HALF_W, 0.02)!;
  let furthest = 0;
  for (let i = 1; i * 3 < geo.positions.length; i++) {
    const x = geo.positions[i * 3], y = geo.positions[i * 3 + 1];
    if (x < 0 && y < 0) furthest = Math.max(furthest, Math.hypot(x, y));
  }
  expect(furthest).toBeCloseTo(Math.hypot(HALF_W, HALF_W), 5);
});
