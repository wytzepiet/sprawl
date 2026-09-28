import { describe, expect, test } from "bun:test";
import { parseTown } from "./grid";
import { complete, paintable, PROGRAMS, touching, type Cell } from "./brush";

const depot = PROGRAMS.Warehouse!;
const house = PROGRAMS.House!;
const sorted = (cells: Cell[] | null) => cells?.map(([c, r]) => `${c},${r}`).sort();

describe("a painted stroke is completed to a working building", () => {
  // A street along row 0 and down column 0.
  const town = parseTown([
    "==========",
    "=.........",
    "=.........",
    "=.........",
    "=.........",
  ].join("\n"));

  test("one tile becomes the smallest depot, fronting the street", () => {
    const cells = complete(town, depot, [[4, 1]])!;
    expect(cells.length).toBe(6);
    // Three along the street in row 1, two deep.
    expect(cells.filter(([, r]) => r === 1).length).toBe(3);
  });

  test("painting away from the street turns it", () => {
    // A stroke down the column beside the western street: the depot turns
    // to lie along that street instead.
    const cells = complete(town, depot, [[1, 2], [1, 3], [1, 4]])!;
    expect(cells.length).toBe(6);
    expect(cells.every(([c]) => c <= 2)).toBe(true);
  });

  test("a stroke bigger than the smallest depot is kept whole, bump and all", () => {
    const stroke: Cell[] = [[3, 1], [4, 1], [5, 1], [3, 2], [4, 2], [5, 2], [6, 2]];
    expect(sorted(complete(town, depot, stroke))).toEqual(sorted(stroke));
  });

  test("a house goes on the frontage only", () => {
    expect(paintable(town, house, 4, 1)).toBe(true);
    expect(paintable(town, house, 4, 3)).toBe(false);
    expect(sorted(complete(town, house, [[4, 1]]))).toEqual(["4,1"]);
  });

  test("painting beside a depot grows it, a one-wide bump out of its back too", () => {
    const built = parseTown(["==========", "...DDD....", "...DDD....", ".........."].join("\n"));
    const grown = touching(built, "Warehouse", [4, 3]);
    expect(grown.length).toBe(6);
    expect(sorted(complete(built, depot, [...grown, [4, 3]]))?.length).toBe(7);
  });

  test("where no depot fits, there is none", () => {
    const tight = parseTown(["=====", "=.T..", "=T..."].join("\n"));
    expect(complete(tight, depot, [[3, 1]])).toBeNull();
  });
});
