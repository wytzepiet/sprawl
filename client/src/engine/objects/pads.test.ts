import { expect, test } from "bun:test";
import { atPad, onVehicle, progress } from "./pads";
import type { Lift } from "../../generated";

test("a run's packages leave one end as they are taken up and reach the other as they are set down", () => {
  // Three off a lorry onto the pad, a second and a half each: the server
  // has already counted them on the pad.
  const l: Lift = { car: 1, good: "Timber", n: 3, onto: false, start: 1000, every: 1500, k: 0 };
  expect(progress(l, 1000)).toEqual({ off: 0, on: 0, carry: null });
  expect([onVehicle(l, 1000), atPad(l, 1000)]).toEqual([3, -3]);
  // The first in the forks: off the bed, not yet on the pad.
  const carrying = 1000 + 1500 * 0.4;
  expect(progress(l, carrying).carry).toBeCloseTo((0.4 - 0.2) / 0.45);
  expect([onVehicle(l, carrying), atPad(l, carrying)]).toEqual([2, -3]);
  // Set down, and by the end all three where the server has them.
  expect([onVehicle(l, 1000 + 1500 * 0.7), atPad(l, 1000 + 1500 * 0.7)]).toEqual([2, -2]);
  expect([onVehicle(l, 5500), atPad(l, 5500)].map(Math.abs)).toEqual([0, 0]);
});
