import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseTown, type Town } from "./grid";
import { facts } from "./facts";
import { dress } from "./dressing";
import { asphalt } from "./surface";
import { CAR } from "../objects/roadGeometry";
import type { Polygon } from "./footprint";

const town = (map: string[]) => parseTown(map.join("\n"));
const fixture = (name: string) => parseTown(readFileSync(`${import.meta.dir}/../../../../server/fixtures/${name}.txt`, "utf8"));

const within = ([x, y]: number[], ring: number[][]) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};
/** Is a point on the town's asphalt, any tile's? */
function onAsphalt(t: Town) {
  const { street, through } = asphalt(t);
  const polys: Polygon[] = [...street, ...through];
  return (p: number[]) => polys.some(([outer, ...holes]) => within(p, outer) && !holes.some((h) => within(p, h)));
}

describe("asphalt and pavement", () => {
  test("every car the town parks stands on asphalt, wheels and all", () => {
    for (const name of ["06-shops", "17-driveways", "12-diagonal", "24-yards"]) {
      const t = fixture(name);
      const on = onAsphalt(t);
      const cars = dress(t, facts(t)).cars;
      expect(cars.length).toBeGreaterThan(0);
      for (const c of cars) {
        // The wheels: a little in from the car's corners.
        const [ux, uy] = [Math.cos(c.angle), Math.sin(c.angle)];
        for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const [l, w] = [a * (CAR.l / 2 - 0.05), b * (CAR.w / 2 - 0.02)];
          expect([name, on([c.x + ux * l - uy * w, c.y + uy * l + ux * w])]).toEqual([name, true]);
        }
      }
    }
  });

  test("a yard is asphalt, a strip of pavement between it and its street, its gate across it", () => {
    const t = town(["......", "======", ".DDD..", ".DDD..", ".DDD..", ".DDD..", "......"]);
    const on = onAsphalt(t);
    // The yard, to the hall's wall, where the docks are.
    expect(on([2.5, 2.5])).toBe(true);
    expect(on([2.5, 4.1])).toBe(true);
    // The sidewalk before it, but for its gate.
    const gate = t.door!(1, 2) ? 1 : t.door!(2, 2) ? 2 : 3;
    expect(t.door!(gate, 2)).toEqual([0, -1]);
    for (const c of [1, 2, 3]) expect(on([c + 0.5, 1.9])).toBe(c === gate);
    // Its lorries stand on it.
    const { docks } = dress(t, facts(t));
    expect(docks.length).toBe(9);
    expect(docks.every((d) => [0.05, 0.6].every((out) => on([d.x + Math.cos(d.angle) * out, d.y + Math.sin(d.angle) * out])))).toBe(true);
  });

  test("a harbour is asphalt through, its trailer park and apron, a quay of pavement at the water", () => {
    const t = town(["~~~~~", "~~~~~", ".PPP.", ".PPP.", ".PPP.", "====="]);
    const on = onAsphalt(t);
    for (const [x, y] of [[2.5, 2.5], [1.5, 3.5], [3.5, 4.5]]) expect(on([x, y])).toBe(true);
    expect(on([2.5, 2.05])).toBe(false);
  });
});
