import { expect, test } from "bun:test";
import { changed, isEmpty, nowhere, see } from "./patch";
import type { Mesh } from "./mesh";

/** A unit cube drawn at each of `at`, as roads.ts draws its tiles: a matrix and a slot each. */
function tiles(at: [number, number][], capacity = 8) {
  const matrices = new Float32Array(capacity * 16);
  const slots = new Float32Array(capacity);
  at.forEach(([x, y], i) => matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1], i * 16));
  const mesh = {
    material: { plugins: [{ getAttributes: () => [{ name: "roadSlot", perInstance: true }, { name: "bevelAt", buffer: "bevel" }] }] },
    _local: [0, 0, 0, 1, 1, 1],
    _reshaped: 0,
    _written: 0,
    // A share of slot an instance, and the bevel's 15 floats a vertex, as roads.ts gives them.
    _attributes: new Map([["roadSlot", slots], ["bevel", new Float32Array(4 * 15)]]),
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
  // The second taken away, the last moved to its slot: where the second was, and the first
  // still changed; the last shows what it showed, where it showed it.
  t.matrices.copyWithin(16, 32, 48);
  t.set(2);
  area = nowhere();
  changed(was, t.mesh, area);
  expect(area).toEqual([0, 0, 0, 6, 1, 1]);
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

test("a per-vertex attribute given anew is a new shape", () => {
  const t = tiles([[0, 0]]);
  const was = see(t.mesh);
  (t.mesh as unknown as { _attributes: Map<string, Float32Array> })._attributes.set("bevel", new Float32Array(4 * 15));
  expect(changed(was, t.mesh, nowhere())).toBe(false);
});

test("a mesh standing somewhere (a region's trees) is seen where it stands, not where its instances say alone", () => {
  const t = tiles([[1, 2], [5, 2]]);
  (t.mesh.position as { x: number; y: number }).x = 64;
  (t.mesh.position as { x: number; y: number }).y = -64;
  const was = see(t.mesh);
  expect(was.box).toEqual([65, -62, 0, 70, -61, 1]);
  t.set(1);
  const area = nowhere();
  expect(changed(was, t.mesh, area)).toBe(true);
  expect(area).toEqual([69, -62, 0, 70, -61, 1]);
});

test("some taken out of the middle move the rest along, and only they are drawn again", () => {
  const t = tiles([[0, 0], [2, 0], [4, 0], [6, 0], [8, 0]]);
  const was = see(t.mesh);
  t.matrices.copyWithin(16, 48, 80);
  t.set(3);
  const area = nowhere();
  expect(changed(was, t.mesh, area)).toBe(true);
  expect(area).toEqual([2, 0, 0, 5, 1, 1]);
});
