import { expect, test } from "bun:test";
import { distances } from "./edt";

test("a cell's distance is to the nearest cell outside the shape", () => {
  // A 5 by 5 square in a 7 by 7 grid: its middle is three cells from the
  // grass round it, its edge one.
  const [w, h] = [7, 7];
  const inside = new Uint8Array(w * h).map((_, i) => (i % w > 0 && i % w < 6 && Math.floor(i / w) > 0 && Math.floor(i / w) < 6 ? 1 : 0));
  const d = distances(inside, w, h);
  expect(d[3 * w + 3]).toBe(3);
  expect(d[1 * w + 3]).toBe(1);
  expect(d[0]).toBe(0);
  expect(d[2 * w + 2]).toBeCloseTo(2);
});
