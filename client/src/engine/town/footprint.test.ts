import { describe, expect, test } from "bun:test";
import { parseTown, townOf } from "./grid";
import { footprints } from "./footprint";

const plans = (map: string[]) => footprints(parseTown(map.join("\n")), () => false);

describe("a building's plan is one exact polygon", () => {
  test("a row stepping on the diagonal is one building", () => {
    const masses = plans(["=H...", ".=H..", "..=H.", "...=."]);
    expect(masses.length).toBe(1);
    expect(masses[0].polygons.length).toBe(1);
  });

  test("a straight row is one plain bar, cut back from its street", () => {
    const [row] = plans(["......", ".HHHH.", "======"]);
    expect(row.polygons.length).toBe(1);
    expect(row.polygons[0][0].length).toBe(4);
  });

  test("a diagonal row is a clean band as thick as a straight row", () => {
    const [diag] = plans([".H....", "..H...", "...H..", "....H.", "......"]);
    const ring = diag.polygons[0][0];
    expect(ring.length).toBe(4);
    const across = (ring: [number, number][]) => {
      const d = ring.map(([x, y]) => (x - y) / Math.SQRT2);
      return Math.max(...d) - Math.min(...d);
    };
    const [straight] = plans(["......", ".HHHH.", "......"]);
    const ys = straight.polygons[0][0].map(([, y]) => y);
    expect(across(ring)).toBeCloseTo(Math.max(...ys) - Math.min(...ys), 3);
  });

  test("tiles not joined stand apart, however close", () => {
    const t = parseTown(["......", ".HHH..", "......"].join("\n"));
    const apart = townOf([0, 1, 2].map((r) => [0, 1, 2, 3, 4, 5].map((c) => t.tile(c, r))), () => false, [], () => false);
    expect(footprints(apart, () => false).length).toBe(3);
  });
});
