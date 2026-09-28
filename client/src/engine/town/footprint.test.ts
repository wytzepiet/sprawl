import { describe, expect, test } from "bun:test";
import { parseTown } from "./grid";
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

  test("a diagonal row beside its street is a clean band, as far from it as a straight row", () => {
    const beside = plans(["=H....", ".=H...", "..=H..", "...=H.", "......"]);
    const alone = plans([".H....", "..H...", "...H..", "....H.", "......"]);
    const ring = beside[0].polygons[0][0];
    expect(ring.length).toBe(alone[0].polygons[0][0].length);
    // The street's middle line is x = y; a straight row's face stands 0.5
    // plus the draw-in from its street's middle.
    const near = Math.min(...ring.map(([x, y]) => (x - y) / Math.SQRT2));
    expect(near).toBeCloseTo(0.7, 1);
    const [straight] = plans(["......", ".HHHH.", "======"]);
    const face = Math.max(...straight.polygons[0][0].map(([, y]) => y));
    expect(2.5 - face).toBeCloseTo(near, 1);
  });
});
