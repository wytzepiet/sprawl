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

  test("a diagonal row beside its street is the same clean band as without the street", () => {
    const beside = plans(["=H....", ".=H...", "..=H..", "...=H.", "......"]);
    const alone = plans([".H....", "..H...", "...H..", "....H.", "......"]);
    expect(beside[0].polygons[0][0]).toEqual(alone[0].polygons[0][0]);
  });
});
