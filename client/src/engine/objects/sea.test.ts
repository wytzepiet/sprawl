import { expect, test } from "bun:test";
import { behind, deckPose, sailing, shunting } from "./sea";
import type { Sail, Shunt } from "../../generated";

const near = (a: number[], b: number[]) => expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-6);

test("a tug starts where it stood, ends where the server has it, its box behind, and never jumps", () => {
  // Off the deck and into a dock, as `onward` lays it: down the ramp, up
  // the lane past the dock, and backed in, the box leading.
  const deck = { at: [-17.5, 48.13] as [number, number], heading: -Math.PI / 2 };
  const dock = { at: [-18.08, 46.85] as [number, number], heading: 0 };
  const s: Shunt = { path: [deck.at, [-17.5, 48], [-17.5, 46.35], dock.at], started: 0, ends: 9000, backs_from: 2, to: { Park: 1 }, stands: dock };
  const move = shunting(s, deck, true);
  near(move(0).tug.at, deck.at);
  near(move(0).box.at, behind(deck).at);
  const end = move(s.ends);
  near(end.tug.at, dock.at);
  near(end.box.at, behind(dock).at);
  expect(Math.cos(end.tug.heading - dock.heading)).toBeCloseTo(1, 6);
  // Frame to frame: no jump, no snap, for the tug and its box; and it
  // stands still a moment where it changes gear.
  let last = move(0);
  let stood = 0;
  for (let t = 16; t <= s.ends; t += 16) {
    const p = move(t);
    for (const [a, b] of [[last.tug, p.tug], [last.box, p.box]]) {
      expect(Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1])).toBeLessThan(0.05);
      expect(Math.abs(Math.atan2(Math.sin(b.heading - a.heading), Math.cos(b.heading - a.heading)))).toBeLessThan(0.12);
    }
    if (Math.hypot(p.tug.at[0] - last.tug.at[0], p.tug.at[1] - last.tug.at[1]) < 1e-6 && t < s.ends - 500) stood += 16;
    last = p;
  }
  expect(stood).toBeGreaterThan(300);
});

test("a ferry sailing in ends moored at the berth, its land end at the ramp, and deck slots on the hull", () => {
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
