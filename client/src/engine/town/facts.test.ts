import { describe, expect, test } from "bun:test";
import { parseTown } from "./grid";
import { facts } from "./facts";
import { dress } from "./dressing";
import { surfacesAt } from "./surface";
import { footprints } from "./footprint";
import { CAR, HALF_W } from "../objects/roadGeometry";

const town = (map: string[]) => parseTown(map.join("\n"));

describe("facts and dressing", () => {
  test("a depot's yard is the rows on its street side, as the server lays its lot", () => {
    const t = town(["......", "======", ".DDD..", ".DDD..", ".DDD..", ".DDD..", "......"]);
    const f = facts(t);
    for (const c of [1, 2, 3]) {
      expect([2, 3].every((r) => f.yard(c, r) === "docks")).toBe(true);
      expect([4, 5].some((r) => f.yard(c, r))).toBe(false);
    }
    expect(f.town.tile(2, 2).kind).toBe("paved");
    // Docks either side of the lane in from the gate, the middle of its
    // front, four rows of them, each box's tail out at the yard's side
    // and the way out of it toward the lane; and over each side a canopy.
    const { docks, canopies } = dress(t, f);
    expect(t.door!(2, 2)).toEqual([0, -1]);
    expect(docks.length).toBe(8);
    for (const d of docks) {
      expect(Math.abs(Math.abs(d.x - 2.5) - 1.39)).toBeLessThan(1e-9);
      expect(Math.abs(Math.cos(d.angle) + Math.sign(d.x - 2.5))).toBeLessThan(1e-9);
      expect([3.45, 3.15, 2.85, 2.55].some((y) => Math.abs(d.y - y) < 1e-9)).toBe(true);
    }
    expect(canopies.length).toBe(2);
  });

  test("a depot whose street runs behind it has its yard there", () => {
    const t = town(["......", ".DDD..", ".DDD..", ".DDD..", ".DDD..", "======"]);
    const f = facts(t);
    expect(f.yard(2, 4)).toBe("docks");
    expect(f.yard(2, 1)).toBeUndefined();
  });

  test("a depot short of its plot keeps its hall and has no yard", () => {
    const t = town(["......", "======", "DDDD..", "......"]);
    expect(facts(t).yard(0, 2)).toBeUndefined();
  });

  test("a house a diagonal step from its street has a drive to it on the diagonal", () => {
    const t = town(["=.H..", ".=...", "..=..", "...=."]);
    expect(t.door!(2, 0)).toEqual([-1, 1]);
    expect(surfacesAt(t, 1, 1)[0].ways.some(([dc, dr]) => dc === 1 && dr === -1)).toBe(true);
    // Its cars stand on the drive, between the house and the street.
    const cars = dress(t, facts(t)).cars.filter((c) => c.x > 1.5 && c.x < 3 && c.y > 0 && c.y < 1.5);
    expect(cars.length).toBeGreaterThan(0);
  });

  test("a supermarket is a box, all building, square", () => {
    const t = town(["=.....", "======", "=MM...", "=MM...", "=....."]);
    const f = facts(t);
    expect([1, 2].every((c) => [2, 3].every((r) => !f.yard(c, r)))).toBe(true);
    const [mass] = footprints(f.town);
    expect(mass.polygons.length).toBe(1);
    expect(mass.polygons[0][0].length).toBe(4);
  });


  test("a harbour is open ground all through: a trailer park, no building", () => {
    const t = town(["~~~~~", "~~~~~", ".PPP.", ".PPP.", ".PPP.", "====="]);
    const f = facts(t);
    for (let r = 2; r <= 4; r++) for (let c = 1; c <= 3; c++) expect(f.yard(c, r)).toBe("park");
    expect(f.town.tile(2, 3).kind).toBe("paved");
  });

  test("a straight street before homes has trees every third tile, a through road none", () => {
    const street = town(["..........", "==========", "HHHHHHHHHH"]);
    expect(dress(street, facts(street)).trees.length).toBe(6);
    const through = town(["..........", "##########", "HHHHHHHHHH"]);
    expect(dress(through, facts(through)).trees.length).toBe(0);
  });

  test("a street is parked where the game parks: along the kerb before flats, nose in before shops, before homes not", () => {
    const street = town(["AAAAAAAAAA", "==========", "SSSSSSSSSS", "..........", "=========="]);
    const cars = dress(street, facts(street)).cars;
    const along = cars.filter((c) => c.y < 1.5), nosed = cars.filter((c) => c.y > 1.5);
    expect(along.length).toBeGreaterThan(4);
    expect(along.every((c) => Math.abs(c.y - 1.5) - CAR.w / 2 > HALF_W && Math.abs(Math.sin(c.angle)) < 1e-9)).toBe(true);
    expect(nosed.length).toBeGreaterThan(4);
    expect(nosed.every((c) => Math.abs(c.y - 1.87) < 1e-9 && Math.abs(c.angle - Math.PI / 2) < 1e-9)).toBe(true);
    const homes = town(["HHHHHHHHHH", "==========", "HHHHHHHHHH"]);
    expect(dress(homes, facts(homes)).cars.every((c) => Math.abs(c.y - 1.5) > 0.5)).toBe(true);
    const through = town(["AAAAAAAAAA", "##########", "SSSSSSSSSS"]);
    expect(dress(through, facts(through)).cars.length).toBe(0);
  });
});
