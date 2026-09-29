import { describe, expect, test } from "bun:test";
import { parseTown } from "./grid";
import { facts } from "./facts";
import { dress } from "./dressing";
import { CAR, HALF_W } from "../objects/roadGeometry";

const town = (map: string[]) => parseTown(map.join("\n"));

describe("facts and dressing", () => {
  test("open ground closed in by buildings is a courtyard, and a garden", () => {
    const t = town(["=======", "=HHHHH=", "=H...H=", "=HHHHH=", "======="]);
    const f = facts(t);
    expect(f.enclosed(3, 2)).toBe(true);
    expect(dress(t, f).gardens.length).toBe(3);
  });

  test("open ground a street reaches is not", () => {
    const t = town(["=======", "=HH.HH=", "=H...H=", "=HHHHH=", "======="]);
    expect(facts(t).enclosed(3, 2)).toBe(false);
  });

  test("a shed's end nearest the street is its office", () => {
    const t = town(["======", "=DDD..", "=DDD..", "......"]);
    const f = facts(t);
    expect(f.head(1, 1)).toBe(true);
    expect(f.head(3, 1)).toBe(false);
    expect(f.town.tile(1, 1).storeys).toBe(t.tile(1, 1).storeys + 2);
  });

  test("a straight street before homes has trees every third tile, a through road none", () => {
    const street = town(["..........", "==========", "HHHHHHHHHH"]);
    expect(dress(street, facts(street)).trees.length).toBe(6);
    const through = town(["..........", "##########", "HHHHHHHHHH"]);
    expect(dress(through, facts(through)).trees.length).toBe(0);
  });

  test("a street before homes is parked along its kerbs, a through road not", () => {
    const street = town(["HHHHHHHHHH", "==========", "HHHHHHHHHH"]);
    const cars = dress(street, facts(street)).cars;
    expect(cars.length).toBeGreaterThan(4);
    expect(cars.every((c) => Math.abs(c.y - 1.5) - CAR.w / 2 > HALF_W)).toBe(true);
    const through = town(["HHHHHHHHHH", "##########", "HHHHHHHHHH"]);
    expect(dress(through, facts(through)).cars.length).toBe(0);
  });
});
