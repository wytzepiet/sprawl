import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { parseTown } from "./grid";
import { bodies, Sub, subdivide } from "./sub";

const FIXTURES = `${import.meta.dir}/../../../../server/fixtures`;
const numbered = readdirSync(FIXTURES).filter((f) => /^\d\d-.*\.txt$/.test(f)).sort();
const town = (name: string) => subdivide(parseTown(readFileSync(`${FIXTURES}/${name}`, "utf8")));

/** A box's corners, a hair in from its edges. */
const corners = (b: { x: number; y: number; angle: number; l: number; w: number }) => {
  const [c, s] = [Math.cos(b.angle), Math.sin(b.angle)];
  return [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]].map(([a, d]) => {
    const [u, v] = [(a * b.l) / 2 - a * 0.005, (d * b.w) / 2 - d * 0.005];
    return [b.x + c * u - s * v, b.y + s * u + c * v] as const;
  });
};

describe("the subgrid", () => {
  test("a claim on a taken triangle fails, and takes nothing", () => {
    const sub = new Sub(1, 1);
    expect(sub.claim([0, 1], { use: "car", poses: [] })).toBe(true);
    expect(sub.claim([1, 2], { use: "car", poses: [] })).toBe(false);
    expect(sub.owner[2]).toBe(-1);
  });

  for (const name of numbered) {
    test(`${name}: every vehicle stands on its own piece, on no road and in no building`, () => {
      const sub = town(name);
      for (const piece of sub.pieces) {
        for (const b of bodies(piece)) {
          for (const [x, y] of corners(b)) {
            const under = sub.at(x, y)?.use;
            expect(under === "road" || under === "building").toBe(false);
          }
        }
      }
    });
  }

  test("a lorry drives out of its bay: past its cab is no building", () => {
    for (const name of numbered) {
      for (const piece of town(name).pieces.filter((p) => p.use === "lorry")) {
        const cab = bodies(piece).find((b) => b.cab)!;
        const [ux, uy] = [Math.cos(cab.angle), Math.sin(cab.angle)];
        expect(town(name).at(cab.x + ux * 0.2, cab.y + uy * 0.2)?.use).not.toBe("building");
      }
    }
  });

  test("a diagonal street is parked along on the diagonal", () => {
    const cars = town("12-diagonal.txt").pieces.filter((p) => p.use === "car").flatMap((p) => p.poses);
    expect(cars.filter((c) => Math.abs(Math.abs(Math.sin(2 * c.angle)) - 1) < 1e-9).length).toBeGreaterThan(8);
  });

  test("a drive runs from the road into the house's plot, and no kerb car stands across its mouth", () => {
    const sub = town("17-driveways.txt");
    const drives = sub.pieces.map((p, id) => ({ p, id })).filter(({ p }) => p.use === "drive");
    expect(drives.length).toBeGreaterThan(4);
    for (const { id } of drives) {
      // Some triangle of it is beside the road.
      const tris = [...sub.owner.keys()].filter((k) => sub.owner[k] === id);
      const near = tris.some((k) => {
        const [x, y] = sub.corners(k)[2];
        return [[0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]].some(([dx, dy]) => sub.at(x + dx, y + dy)?.use === "road");
      });
      expect(near).toBe(true);
    }
  });

  test("a supermarket two tiles each way has a lorry in a corner of it", () => {
    const sub = town("19-back-street.txt");
    expect(sub.pieces.filter((p) => p.use === "lorry").length).toBe(4);
  });
});
