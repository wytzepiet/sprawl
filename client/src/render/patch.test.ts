import { expect, test } from "bun:test";
import { changed, isEmpty, nowhere, see } from "./patch";
import type { Mesh } from "./mesh";

/** A unit cube drawn at each of `at`, as roads.ts draws its tiles: a matrix and a slot each. */
function tiles(at: [number, number][], capacity = 8) {
  const matrices = new Float32Array(capacity * 16);
  const slots = new Float32Array(capacity);
  at.forEach(([x, y], i) => matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1], i * 16));
  const mesh = {
    material: {},
    _local: [0, 0, 0, 1, 1, 1],
    _reshaped: 0,
    _written: 0,
    _attributes: new Map([["roadSlot", slots]]),
    position: { x: 0, y: 0, z: 0 },
    thinInstances: { matrices, count: at.length, colors: null },
  };
  return { mesh: mesh as unknown as Mesh, matrices, slots, set: (n: number) => (mesh.thinInstances.count = n) };
}

test("a tile laid is drawn again where it is, and nowhere else", () => {
  const t = tiles([[0, 0], [5, 0]]);
  const was = see(t.mesh);
  expect(was.box).toEqual([0, 0, 0, 6, 1, 1]);
  t.matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 9, 9, 0, 1], 2 * 16);
  t.set(3);
  const area = nowhere();
  expect(changed(was, t.mesh, area)).toBe(true);
  expect(area).toEqual([9, 9, 0, 10, 10, 1]);
});

test("a tile's shape changed, or one taken and the last moved to its place", () => {
  const t = tiles([[0, 0], [5, 0], [9, 9]]);
  const was = see(t.mesh);
  t.slots[0] = 4;
  let area = nowhere();
  changed(was, t.mesh, area);
  expect(area).toEqual([0, 0, 0, 1, 1, 1]);
  // The second taken away, the last moved to its place: both places, and the first still changed.
  t.matrices.copyWithin(16, 32, 48);
  t.set(2);
  area = nowhere();
  changed(was, t.mesh, area);
  expect(area).toEqual([0, 0, 0, 10, 10, 1]);
});

test("nothing changed is nothing", () => {
  const t = tiles([[0, 0]]);
  const area = nowhere();
  expect(changed(see(t.mesh), t.mesh, area)).toBe(true);
  expect(isEmpty(area)).toBe(true);
});

test("a new material cannot be told by place", () => {
  const t = tiles([[0, 0]]);
  const was = see(t.mesh);
  (t.mesh as unknown as { material: unknown }).material = {};
  expect(changed(was, t.mesh, nowhere())).toBe(false);
});
