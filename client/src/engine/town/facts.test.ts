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
    const t = town(["======", "=FFF..", "=FFF..", "......"]);
    const f = facts(t);
    expect(f.head(1, 1)).toBe(true);
    expect(f.head(3, 1)).toBe(false);
    expect(f.town.tile(1, 1).storeys).toBe(t.tile(1, 1).storeys + 2);
  });

  test("a depot gives up as much street-side ground as its docks need, the rest is depot", () => {
    const t = town(["......", "======", "DDDD..", "DDDD..", "......"]);
    const f = facts(t);
    // Eight tiles need four docks: two tiles of yard, three docks each.
    const yard = [0, 1, 2, 3].filter((c) => f.yard(c, 2));
    expect(yard.length).toBe(2);
    expect(f.yard(0, 3)).toBeUndefined();
    expect(f.town.tile(yard[0], 2).kind).toBe("paved");
    const { docks } = dress(t, f);
    expect(docks.length).toBe(6);
    expect(docks.every((d) => Math.abs(d.angle + Math.PI / 2) < 1e-9)).toBe(true);
  });

  test("a depot all on the street keeps its hall and has no yard", () => {
    const t = town(["......", "======", "DDDD..", "......"]);
    expect(facts(t).yard(0, 2)).toBeUndefined();
  });

  test("a supermarket's car park takes its busy corner, and fills with cars", () => {
    const t = town(["=.....", "======", "=MMM..", "=MMM..", "=....."]);
    const f = facts(t);
    // Six tiles need eighteen cars: two tiles of car park, from the corner.
    expect(f.yard(1, 2)).toBe("cars");
    expect(f.yard(2, 2)).toBe("cars");
    expect(f.yard(3, 2)).toBeUndefined();
    expect(dress(t, f).cars.length).toBeGreaterThan(8);
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
