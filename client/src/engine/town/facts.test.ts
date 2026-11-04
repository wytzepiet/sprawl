import { describe, expect, test } from "bun:test";
import { parseTown } from "./grid";
import { facts } from "./facts";
import { dress } from "./dressing";
import { surfacesAt } from "./surface";

const town = (map: string[]) => parseTown(map.join("\n"));

describe("facts and dressing", () => {
  test("a house a diagonal step from its street has a drive to it on the diagonal", () => {
    const t = town(["=.H..", ".=...", "..=..", "...=."]);
    expect(t.door!(2, 0)).toEqual([-1, 1]);
    expect(surfacesAt(t, 1, 1)[0].ways.some(([dc, dr]) => dc === 1 && dr === -1)).toBe(true);
    // Its cars stand on the drive, between the house and the street.
    const cars = dress(t, facts(t)).cars.filter((c) => c.x > 1.5 && c.x < 3 && c.y > 0 && c.y < 1.5);
    expect(cars.length).toBeGreaterThan(0);
  });


  test("a straight street before homes has trees every third tile, a through road none", () => {
    const street = town(["..........", "==========", "HHHHHHHHHH"]);
    expect(dress(street, facts(street)).trees.length).toBe(6);
    const through = town(["..........", "##########", "HHHHHHHHHH"]);
    expect(dress(through, facts(through)).trees.length).toBe(0);
  });

});
