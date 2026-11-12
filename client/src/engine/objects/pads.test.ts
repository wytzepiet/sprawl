import { expect, test } from "bun:test";
import { atPad, onVehicle, padOf, placeIn, progress } from "./pads";
import type { Building, Good, Lift } from "../../generated";

test("a run's packages leave one end as they are taken up and reach the other as they are set down", () => {
  // Three off a lorry onto the pad, a second and a half each: the server
  // has already counted them on the pad.
  const l: Lift = { car: 1, good: "Logs", n: 3, onto: false, start: 1000, every: 1500, k: 0 };
  expect(progress(l, 1000)).toEqual({ off: 0, on: 0, carry: null });
  expect([onVehicle(l, 1000), atPad(l, 1000)]).toEqual([3, -3]);
  // The first in the forks: off the bed, not yet on the pad.
  const carrying = 1000 + 1500 * 0.6;
  expect(progress(l, carrying).carry).toBeCloseTo((0.6 - 0.45) / 0.45);
  expect([onVehicle(l, carrying), atPad(l, carrying)]).toEqual([2, -3]);
  // Set down, and by the end all three where the server has them.
  expect([onVehicle(l, 1000 + 1500 * 0.95), atPad(l, 1000 + 1500 * 0.95)]).toEqual([2, -2]);
  expect([onVehicle(l, 5500), atPad(l, 5500)].map(Math.abs)).toEqual([0, 0]);
});

test("a shop that keeps more goods than its wall has places has a place for each", () => {
  // The shop that froze a town: three goods, and room along its wall for fewer.
  const shop = {"kind": "Shop", "tiles": [{"x": 0, "y": 24}, {"x": 0, "y": 25}], "facing": 3, "stocks": {"Fish": {"level": 0.0, "cap": 30.0}, "Planks": {"level": 3.0, "cap": 19.0}, "Bread": {"level": 0.0, "cap": 6.0}}, "lifts": [], "home": null, "crew": [], "present": 0, "work": 0.0, "land": [], "ruts": [], "door": {"tile": {"x": 0, "y": 25}, "street": {"x": -1, "y": 25}}, "fire": null} as Building;
  for (const more of [[], ["Bricks", "Furniture", "Glass", "Clothes"]] as Good[][]) {
    for (const good of more) shop.stocks[good] = { level: 1, cap: 6 };
    const { bays } = padOf(shop);
    expect(bays.map((b) => b.good)).toEqual(Object.keys(shop.stocks) as Good[]);
    for (const bay of bays) expect(placeIn(bay, 0)[0]).toBeDefined();
  }
});
