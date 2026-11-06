import { describe, expect, test } from "bun:test";
import { parseTown, townOf } from "./grid";
import { footprints } from "./footprint";

const plans = (map: string[]) => footprints(parseTown(map.join("\n")));

describe("a building's plan is one exact polygon", () => {
  test("a straight row is one plain bar, cut back from its street", () => {
    const [row] = plans(["......", ".SSSS.", "======"]);
    expect(row.polygons.length).toBe(1);
    expect(row.polygons[0][0].length).toBe(4);
  });

  test("a house alone stands square, whatever runs past its corner", () => {
    // Turned, a corner would point along the tile's middle line.
    const turned = (map: string[]) => plans(map)[0].polygons[0][0].some(([x]) => Math.abs(x - 0.5) < 1e-9);
    expect(turned(["=....", "H=...", "..=..", "....."])).toBe(false);
    expect(turned(["=====", "H....", "....."])).toBe(false);
  });

  test("houses side by side stand apart, each with walls all round", () => {
    const houses = plans(["......", ".HHH..", "=HH...", "......"]);
    expect(houses.length).toBe(5);
    expect(houses.every((h) => h.polygons.length === 1 && h.polygons[0][0].length === 4)).toBe(true);
  });

  test("two shops placed side by side are two buildings", () => {
    const flat = (id: number) => ({ kind: "Shop" as const, storeys: 2, id });
    const open = { kind: "open" as const, storeys: 0 };
    const row = [open, flat(1), flat(1), flat(2), flat(2), open];
    const town = townOf([row.map(() => open), row, row.map(() => open)], () => false);
    expect(footprints(town).length).toBe(2);
  });

  test("tiles not joined stand apart, however close", () => {
    const t = parseTown(["......", ".SSS..", "......"].join("\n"));
    const apart = townOf([0, 1, 2].map((r) => [0, 1, 2, 3, 4, 5].map((c) => t.tile(c, r))), () => false, [], () => false);
    expect(footprints(apart).length).toBe(3);
  });
});
