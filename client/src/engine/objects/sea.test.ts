import { expect, test } from "bun:test";
import { deckPose, sailing, shunting } from "./sea";
import type { Car } from "../../generated";

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
  const path = [{ x: -24, y: 53 }, { x: -18, y: 53 }, { x: -18, y: 52 }, { x: -18, y: 51 }, { x: -18, y: 50 }];
  const steps = path.flatMap((p, i) => (i ? Array.from({ length: Math.abs(p.x - path[i - 1].x) + Math.abs(p.y - path[i - 1].y) }, (_, k) => ({ x: path[i - 1].x + Math.sign(p.x - path[i - 1].x) * (k + 1), y: path[i - 1].y + Math.sign(p.y - path[i - 1].y) * (k + 1) })) : [p]));
  const car = { run: { job: "Sail", path: steps, started: 0, pace: 1200 } } as unknown as Car;
  const at = sailing(car, true)((steps.length - 1) * 1200);
  near(at.at, [-17.5, 49.6]);
  expect(Math.sin(at.heading)).toBeCloseTo(-1);
  near(deckPose(at, 0).at, [-17.77, 48.45]);
});
