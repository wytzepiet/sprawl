import { describe, expect, test } from "bun:test";
import { block, dress, plotPiece, type Ground } from "./rules";
import { FACINGS } from "../../blueprints";

/**
 * A map drawn as the fixtures are: one character a tile, the top row north,
 * and the grid as the server lays it (a column's x runs the other way, a
 * row's y goes down as it goes south). `H` a house facing its street, `S` a
 * shop, `=` a street, `#` a through road, `~` water, `.` grass.
 */
function ground(rows: string[]): Ground & { at(col: number, row: number): [number, number] } {
  const w = rows[0].length;
  const at = (col: number, row: number): [number, number] => [w - 1 - col, -row];
  const char = (x: number, y: number) => rows[-y]?.[w - 1 - x];
  const isRoad = (x: number, y: number) => char(x, y) === "=" || char(x, y) === "#";
  const g: Ground = {
    building(x, y) {
      const c = char(x, y);
      if (c !== "H" && c !== "S") return undefined;
      // A house without a lot is given the first facing that reaches a
      // street, whichever side it is on: the server's is no guide.
      return { kind: c === "H" ? "House" : "Shop", facing: 0, size: [1, 1] };
    },
    road(x, y) {
      if (!isRoad(x, y)) return undefined;
      const arms = FACINGS.filter(([dx, dy]) => isRoad(x + dx, y + dy));
      return { arms, through: char(x, y) === "#" };
    },
    terrain: (x, y) => (char(x, y) === undefined ? undefined : char(x, y) === "~" ? "Water" : "Grass"),
  };
  return { ...g, at };
}

const piece = (g: ReturnType<typeof ground>, col: number, row: number) => {
  const [x, y] = g.at(col, row);
  return plotPiece(g, x, y).piece;
};

describe("plot rules", () => {
  test("a row of houses on a street is a terrace with two ends", () => {
    const g = ground([".HHH.H.", "======="]);
    expect([1, 2, 3, 5].map((c) => piece(g, c, 0))).toEqual(["terrace-end", "terrace", "terrace-end", "house"]);
  });

  test("houses back to back across a lane are two rows, not one", () => {
    const g = ground(["=====", ".HHH.", ".HHH.", "====="]);
    expect([1, 2, 3].map((c) => piece(g, c, 1))).toEqual(["terrace-end", "terrace", "terrace-end"]);
  });

  test("a column of houses on a street joins the same way", () => {
    const g = ground(["....", ".=H.", ".=H.", ".=H.", "...."]);
    expect([1, 2, 3].map((r) => piece(g, 2, r))).toEqual(["terrace-end", "terrace", "terrace-end"]);
  });

  test("the house inside a corner turns to it", () => {
    const g = ground(["......", ".=====", ".=H...", ".=....", ".=...."]);
    expect(piece(g, 2, 2)).toBe("corner");
  });

  test("a corner house at the end of a row joins it", () => {
    const g = ground(["......", ".=====", ".=H...", ".=H...", ".=...."]);
    expect([2, 3].map((r) => piece(g, 2, r))).toEqual(["corner-terrace", "terrace-end"]);
  });
});

describe("free rules", () => {
  test("the middle of a ring of houses is a garden, open country is not", () => {
    const g = ground([".......", ".=====.", ".=HHH=.", ".=H.H=.", ".=HHH=.", ".=====.", "......."]);
    const [x, y] = g.at(3, 3);
    expect(block(g, x, y).enclosed).toBe(true);
    const [ox, oy] = g.at(0, 0);
    expect(block(g, ox, oy).enclosed).toBe(false);
  });

  test("a single gap in a row of houses is a pocket green", () => {
    const g = ground(["......", ".HH.H.", "======"]);
    const [x, y] = g.at(3, 1);
    expect(dress(g, x, y, false).map((p) => p.piece)).toEqual(["pocket"]);
  });
});

describe("path and node rules", () => {
  test("a street fronted by homes has a tree every other tile, a through road none", () => {
    const g = ground(["HHHHHH", "======", "......", "HHHHHH", "######"]);
    const trees = (row: number) => [0, 1, 2, 3, 4, 5].flatMap((c) => dress(g, ...g.at(c, row), false)).length;
    expect(trees(1)).toBe(2);
    expect(trees(4)).toBe(0);
  });

  test("a junction has a crossing on each street arm, not across the through road", () => {
    const g = ground(["..=..", "#####", "..=.."]);
    expect(dress(g, ...g.at(2, 1), false).map((p) => p.piece)).toEqual(["crossing", "crossing"]);
  });
});
