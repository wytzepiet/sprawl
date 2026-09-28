import { describe, expect, test } from "bun:test";
import { parseTown } from "./grid";
import { outside } from "./mass";

/** Is the point (x, y) inside the building on tile (c, r)? */
const built = (map: string[], c: number, r: number, x: number, y: number) => outside(parseTown(map.join("\n")), c, r, x, y) < 0;

describe("a quarter is shaped by the tiles at its corner", () => {
  test("houses in a row run on wall to wall, and stand back from the street", () => {
    const map = ["....", ".HH.", "===="];
    expect(built(map, 1, 1, 1.99, 1.5)).toBe(true); // up to the neighbour
    expect(built(map, 1, 1, 1.02, 1.5)).toBe(false); // a garden's depth from the open end
    expect(built(map, 1, 1, 1.5, 1.95)).toBe(true); // close to the street
    expect(built(map, 1, 1, 1.5, 1.05)).toBe(false); // but not the back
  });

  test("a courtyard's corner is cut from the building round it", () => {
    const map = ["HHH", "H.H", "HHH"];
    expect(built(map, 0, 0, 0.98, 0.5)).toBe(true);
    expect(built(map, 0, 0, 0.95, 0.95)).toBe(false); // the courtyard's inside corner
  });

  test("a street corner is cut on the diagonal", () => {
    const map = ["...", "=H.", "==."];
    expect(built(map, 1, 1, 1.03, 1.97)).toBe(false);
    expect(built(map, 1, 1, 1.2, 1.8)).toBe(true);
  });

  test("a street running across the corner cuts deeper, clear of the road", () => {
    // The street steps on the diagonal from (0,1) to (1,2): it crosses the
    // house's south-west corner, where a street turning a corner would not.
    const crossed = ["...", "=H.", ".=."];
    const turning = ["...", "=H.", "==."];
    expect(built(crossed, 1, 1, 1.2, 1.8)).toBe(false);
    expect(built(turning, 1, 1, 1.2, 1.8)).toBe(true);
    expect(built(crossed, 1, 1, 1.45, 1.55)).toBe(true);
  });
});
