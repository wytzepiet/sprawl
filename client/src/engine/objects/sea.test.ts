import { expect, test } from "bun:test";
import { deckPose, sailing, shunting } from "./sea";
import type { Sail } from "../../generated";

const near = (a: number[], b: number[]) => expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-6);

test("a tug ends where the server has it, its box on the slot, and backs facing away from where it goes", () => {
  // Off the deck and into a dock, as `onward` lays it: forward all the way.
  const s = { path: [[-17.5, 48.13], [-17.5, 48], [-17.5, 47.5], [-18.15, 47.322], [-18.15, 46.502]] as [number, number][], started: 0, ends: 4269, backs_from: Number.MAX_SAFE_INTEGER, to: { Park: 1 } };
  const end = shunting(s)(s.ends);
  near(end.tug.at, [-18.15, 46.502]);
  near(end.box.at, [-18.15, 46.822]);
  expect(end.tug.heading).toBeCloseTo(-Math.PI / 2);
  // To a deck slot, backing from the apron: it faces the land as it goes to sea.
  const b = { path: [[-16.7, 47.5], [-17.5, 47.5], [-17.5, 48], [-17.5, 48.13]] as [number, number][], started: 0, ends: 3500, backs_from: 1, to: { Deck: 1 } };
  const mid = shunting(b)(800);
  expect(Math.sin(mid.tug.heading)).toBeLessThan(0);
  // Never a snap: the facing turns by little between one frame and the next.
  let last = shunting(b)(0).tug.heading;
  for (let t = 16; t <= b.ends; t += 16) {
    const h = shunting(b)(t).tug.heading;
    expect(Math.abs(Math.atan2(Math.sin(h - last), Math.cos(h - last)))).toBeLessThan(0.2);
    last = h;
  }
});

test("a ferry sailing in ends moored at the berth, its land end at the ramp, and deck slots on the hull", () => {
  // In from the edge, round a corner, and straight up to the berth.
  const sail: Sail = { path: [[-30, 53.5], [-17.5, 53.5], [-17.5, 49.6]], started: 0, ends: 40_000, ease: [false, true] };
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
  const out: Sail = { path: [[-17.5, 49.6], [-17.5, 160]], started: 0, ends: 40_000, ease: [true, false] };
  expect(Math.sin(sailing(out)(20_000).heading)).toBeCloseTo(-1);
});
