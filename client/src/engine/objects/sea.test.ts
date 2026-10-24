import { expect, test } from "bun:test";
import { deckPose, sailing } from "./sea";
import type { Sail } from "../../generated";

const near = (a: number[], b: number[]) => expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-6);

test("a ferry sailing in ends moored at the berth, its land end at the ramp, and deck bays on the hull", () => {
  // In from the edge, round a corner, and straight up to the berth.
  const sail: Sail = { path: [[-30, 53.5], [-17.5, 53.5], [-17.5, 49.6]], started: 0, ends: 40_000, ease: [false, true], astern: false };
  const at = sailing(sail)(sail.ends);
  near(at.at, [-17.5, 49.6]);
  expect(Math.sin(at.heading)).toBeCloseTo(-1);
  near(deckPose(at, 0).at, [-17.77, 48.45]);
  // Still in the last moment, and never a snap of the facing.
  const at50 = sailing(sail)(sail.ends - 50).at;
  expect(Math.hypot(at50[0] + 17.5, at50[1] - 49.6)).toBeLessThan(0.001);
  let last = sailing(sail)(0).heading;
  for (let t = 16; t <= sail.ends; t += 16) {
    const h = sailing(sail)(t).heading;
    expect(Math.abs(Math.atan2(Math.sin(h - last), Math.cos(h - last)))).toBeLessThan(0.2);
    last = h;
  }
  // Going out it backs away, its land end toward the berth.
  const out: Sail = { path: [[-17.5, 49.6], [-17.5, 160]], started: 0, ends: 40_000, ease: [true, false], astern: true };
  expect(Math.sin(sailing(out)(20_000).heading)).toBeCloseTo(-1);
});
