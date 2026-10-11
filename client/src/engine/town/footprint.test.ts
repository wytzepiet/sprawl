import { describe, expect, test } from "bun:test";
import { parseTown, townOf } from "./grid";
import { footprints } from "./footprint";

const plans = (map: string[]) => footprints(parseTown(map.join("\n")), () => false);

describe("a building's plan is one exact polygon", () => {
  test("a row stepping on the diagonal is one building", () => {
    const masses = plans(["=S...", ".=S..", "..=S.", "...=."]);
    expect(masses.length).toBe(1);
    expect(masses[0].polygons.length).toBe(1);
  });

  test("a straight row is one plain bar, cut back from its street", () => {
    const [row] = plans(["......", ".SSSS.", "======"]);
    expect(row.polygons.length).toBe(1);
    expect(row.polygons[0][0].length).toBe(4);
  });

  test("a diagonal row is a clean band as thick as a straight row", () => {
    const [diag] = plans([".S....", "..S...", "...S..", "....S.", "......"]);
    const ring = diag.polygons[0][0];
    expect(ring.length).toBe(4);
    const across = (ring: [number, number][]) => {
      const d = ring.map(([x, y]) => (x - y) / Math.SQRT2);
      return Math.max(...d) - Math.min(...d);
    };
    const [straight] = plans(["......", ".SSSS.", "......"]);
    const ys = straight.polygons[0][0].map(([, y]) => y);
    expect(across(ring)).toBeCloseTo(Math.max(...ys) - Math.min(...ys), 3);
  });

  test("a diagonal row two wide is a clean band, no step poking out", () => {
    const [row] = plans(["SS.....", ".SS....", "..SS...", "...SS..", "......."]);
    const ring = row.polygons[0][0];
    // Along its long sides, every corner lies on one of two diagonal lines.
    const d = ring.map(([x, y]) => +(x - y).toFixed(3));
    expect(new Set(d.filter((v) => v === Math.min(...d) || v === Math.max(...d))).size).toBe(2);
    expect(ring.length).toBeLessThanOrEqual(8);
  });

  test("a house alone turns only where a diagonal street runs past its corner", () => {
    // Turned, a corner points along the tile's middle line.
    const turned = (map: string[]) => plans(map)[0].polygons[0][0].some(([x]) => Math.abs(x - 0.5) < 1e-9);
    expect(turned(["=....", "H=...", "..=..", "....."])).toBe(true);
    expect(turned(["=====", "H....", "....."])).toBe(false);
    // Beside a street's bend or dead end, square to the straight part.
    expect(turned(["H....", "===..", "...=.", "....="])).toBe(false);
    expect(turned([".H...", ".=...", "..=..", "...=."])).toBe(false);
  });

  test("houses side by side stand apart, each with walls all round", () => {
    const houses = plans(["......", ".HHH..", "=HH...", "......"]);
    expect(houses.length).toBe(5);
    expect(houses.every((h) => h.polygons.length === 1 && h.polygons[0][0].length === 4)).toBe(true);
  });

  test("two blocks of flats placed side by side are two buildings", () => {
    const flat = (id: number) => ({ kind: "Apartment" as const, storeys: 5, id });
    const open = { kind: "open" as const, storeys: 0 };
    const row = [open, flat(1), flat(1), flat(2), flat(2), open];
    const town = townOf([row.map(() => open), row, row.map(() => open)], () => false);
    expect(footprints(town, () => false).length).toBe(2);
  });

  test("tiles not joined stand apart, however close", () => {
    const t = parseTown(["......", ".SSS..", "......"].join("\n"));
    const apart = townOf([0, 1, 2].map((r) => [0, 1, 2, 3, 4, 5].map((c) => t.tile(c, r))), () => false, [], () => false);
    expect(footprints(apart, () => false).length).toBe(3);
  });
});
