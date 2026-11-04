import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseTown, type Town } from "./grid";
import { facts } from "./facts";
import { dress } from "./dressing";
import { asphalt, pavement } from "./surface";
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
  test("a house a diagonal step off a street is on its sidewalk; two streets keep the grass between them", () => {
    // Two diagonal streets side by side, laid apart, each joined only
    // along itself; a house a diagonal step off one: two sidewalks, the
    // house on the one, none of it holed.
    const t = town(["..........", ".=.=......", "..=.=.....", "...=.=....", "....=.=...", ".....=.=..", "......=.=.", ".....H....", ".........."]);
    const along = (c0: number, r0: number, c1: number, r1: number) => c1 - c0 === r1 - r0 && Math.abs(c1 - c0) === 1;
    const apart = { ...t, linked: (c0: number, r0: number, c1: number, r1: number) => t.linked(c0, r0, c1, r1) && along(c0, r0, c1, r1) };
    const paved = pavement(apart);
    expect(paved.length).toBe(2);
    expect(paved.every((p) => p.length === 1)).toBe(true);
  });

  test("a building's corner by a street stays square", () => {
    const t = town(["......", ".====.", ".=SS..", ".=SS..", "......"]);
    const paved = pavement(t);
    // Its far corner, beside nothing paved, is square: the pavement
    // reaches the tile's corner but for the kerb's rounding.
    const on = (p: number[]) => paved.some(([o]) => within(p, o));
    expect(on([3.95, 3.95])).toBe(true);
    expect(on([4.05, 4.05])).toBe(false);
  });

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

});
