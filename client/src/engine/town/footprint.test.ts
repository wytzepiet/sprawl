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

  test("a solid block is a ring round a courtyard", () => {
    const [block] = plans(["..........", ".========.", ".=HHHHHH=.", ".=HHHHHH=.", ".=HHHHHH=.", ".=HHHHHH=.", ".========.", ".........."]);
    expect(block.polygons.length).toBe(1);
    expect(block.polygons[0].length).toBe(2); // an outline and one hole
  });
});
