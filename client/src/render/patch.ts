import type { Mesh } from "./mesh";

/**
 * What changed in the still picture since it was drawn, as a box in the
 * world: so a road laid or a house built is drawn again where it stands,
 * in one frame, not the whole town over several (`frame.ts`).
 *
 * As each mesh goes into the picture, what it showed is kept (`see`): its
 * box, and for one drawn many times over, each instance's matrix and its
 * share of each attribute; kept until the mesh is touched again
 * (`Mesh._touched`), so a picture looks again only at what changed. Against that, `changed` finds the instances that
 * moved, came, went or show something else, and grows a box round where
 * they were and where they are.
 */

/** x0 y0 z0 x1 y1 z1. */
export type Box = number[];
export const nowhere = (): Box => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
export const isEmpty = (b: Box) => b[0]! > b[3]!;
export function grow(b: Box, o: Box) {
  for (let k = 0; k < 3; k++) {
    if (o[k]! < b[k]!) b[k] = o[k]!;
    if (o[k + 3]! > b[k + 3]!) b[k + 3] = o[k + 3]!;
  }
}

/** What a mesh showed as it went into the picture. */
export interface Seen {
  /** The mesh's `_touched` as it was looked at: the same, it shows the same. */
  touched: number;
  box: Box;
  material: unknown;
  reshaped: number;
  written: number;
  position: [number, number, number];
  /** Its per-vertex attributes as given: one given anew is a new shape. */
  vertex: Map<string, Float32Array>;
  /** Drawn many times over: each instance's matrix, and its share of each attribute and colour. */
  matrices: Float64Array | null;
  count: number;
  shares: Map<string, { data: Float32Array; stride: number }>;
}

/** The local box `l` through instance `i`'s matrix (column-major), moved by its mesh's place `p`, into `out`. */
function instanceBox(l: Box, m: ArrayLike<number>, i: number, p: ArrayLike<number>, out: Box) {
  const o = i * 16;
  const c = [(l[0]! + l[3]!) / 2, (l[1]! + l[4]!) / 2, (l[2]! + l[5]!) / 2];
  const e = [(l[3]! - l[0]!) / 2, (l[4]! - l[1]!) / 2, (l[5]! - l[2]!) / 2];
  for (let r = 0; r < 3; r++) {
    const centre = m[o + r]! * c[0]! + m[o + 4 + r]! * c[1]! + m[o + 8 + r]! * c[2]! + m[o + 12 + r]!;
    const reach = Math.abs(m[o + r]!) * e[0]! + Math.abs(m[o + 4 + r]!) * e[1]! + Math.abs(m[o + 8 + r]!) * e[2]!;
    out[r] = centre - reach + p[r]!;
    out[r + 3] = centre + reach + p[r]!;
  }
  return out;
}

/** The attributes a mesh's material reads an instance at a time. */
function perInstance(mesh: Mesh): Set<string> {
  const plugins = (mesh.material as { plugins?: { getAttributes?: () => { name: string; buffer?: string; perInstance?: boolean }[] }[] } | null)?.plugins ?? [];
  return new Set(plugins.flatMap((p) => (p.getAttributes?.() ?? []).filter((a) => a.perInstance).map((a) => a.buffer ?? a.name)));
}

/** Each per-instance array of a mesh drawn many times over, and how many
 *  floats an instance has of it; null if one is not a whole share each. */
function sharesOf(mesh: Mesh): Map<string, { data: Float32Array; stride: number }> | null {
  const ti = mesh.thinInstances!;
  const capacity = Math.max(1, Math.floor(ti.matrices.length / 16));
  const out = new Map<string, { data: Float32Array; stride: number }>();
  const each = perInstance(mesh);
  for (const [name, data] of [...[...mesh._attributes].filter(([n]) => each.has(n)), ...(ti.colors ? [["colors", ti.colors] as const] : [])]) {
    const stride = data.length / capacity;
    if (!Number.isInteger(stride) || stride <= 0) return null;
    out.set(name, { data, stride });
  }
  return out;
}

export function see(mesh: Mesh): Seen {
  const l = mesh._local;
  const p = mesh.position;
  const ti = mesh.thinInstances;
  const box = nowhere();
  let matrices: Float64Array | null = null;
  const shares = new Map<string, { data: Float32Array; stride: number }>();
  if (ti) {
    matrices = Float64Array.from(ti.matrices.subarray(0, ti.count * 16));
    const b = nowhere();
    for (let i = 0; i < ti.count; i++) grow(box, instanceBox(l, matrices, i, [p.x, p.y, p.z], b));
    for (const [name, { data, stride }] of sharesOf(mesh) ?? []) shares.set(name, { data: data.slice(0, ti.count * stride), stride });
  } else if (!isEmpty(l)) {
    for (let k = 0; k < 3; k++) [box[k], box[k + 3]] = [l[k]! + [p.x, p.y, p.z][k]!, l[k + 3]! + [p.x, p.y, p.z][k]!];
  }
  const each = ti ? perInstance(mesh) : new Set<string>();
  const vertex = new Map([...mesh._attributes].filter(([n]) => !each.has(n)));
  return { touched: mesh._touched, box, material: mesh.material, reshaped: mesh._reshaped, written: mesh._written, position: [p.x, p.y, p.z], vertex, matrices, count: ti?.count ?? 0, shares };
}

/** Grows `out` round what changed in `mesh` since `was`; false if that cannot be told by place (its material or shape is new). */
export function changed(was: Seen, mesh: Mesh, out: Box): boolean {
  if (mesh.material !== was.material || mesh._reshaped !== was.reshaped) return false;
  const ti = mesh.thinInstances;
  if (!ti !== !was.matrices) return false;
  if ([...was.vertex].some(([n, d]) => mesh._attributes.get(n) !== d)) return false;
  if (!ti) {
    const p = mesh.position;
    if (p.x === was.position[0] && p.y === was.position[1] && p.z === was.position[2] && mesh._written === was.written) return true;
    grow(out, was.box);
    grow(out, see(mesh).box);
    return true;
  }
  const now = sharesOf(mesh);
  const at = [mesh.position.x, mesh.position.y, mesh.position.z];
  if (!now || at.some((v, k) => v !== was.position[k])) return false;
  const l = mesh._local;
  const b = nowhere();
  for (const [name, { stride }] of now) if (was.shares.get(name)?.stride !== stride) return false;
  /** Whether what was instance `i` shows the same as what is now instance `j`. */
  const same = (i: number, j: number) => {
    for (let k = 0; k < 16; k++) if (ti.matrices[j * 16 + k] !== was.matrices![i * 16 + k]) return false;
    for (const [name, { data, stride }] of now) {
      const old = was.shares.get(name)!.data;
      for (let k = 0; k < stride; k++) if (data[j * stride + k] !== old[i * stride + k]) return false;
    }
    return true;
  };
  // The same at the front and at the back are passed over. Of the rest,
  // what shows the same shows it in whichever slot: only what is shown no
  // longer, or newly, changed; in whatever order the others are now kept.
  const least = Math.min(was.count, ti.count);
  let [front, back] = [0, 0];
  while (front < least && same(front, front)) front++;
  while (back < least - front && same(was.count - 1 - back, ti.count - 1 - back)) back++;
  const names = [...now.keys()];
  const key = (matrices: ArrayLike<number> & { subarray(a: number, b: number): { join(): string } }, share: (n: string) => Float32Array, i: number) =>
    matrices.subarray(i * 16, i * 16 + 16).join() + names.map((n) => `|${share(n).subarray(i * now.get(n)!.stride, (i + 1) * now.get(n)!.stride).join()}`).join("");
  const left = new Map<string, number[]>();
  for (let i = front; i < was.count - back; i++) {
    const k = key(was.matrices!, (n) => was.shares.get(n)!.data, i);
    left.get(k)?.push(i) ?? left.set(k, [i]);
  }
  for (let j = front; j < ti.count - back; j++) {
    if (left.get(key(ti.matrices, (n) => now.get(n)!.data, j))?.pop() === undefined) grow(out, instanceBox(l, ti.matrices, j, at, b));
  }
  for (const gone of left.values()) for (const i of gone) grow(out, instanceBox(l, was.matrices!, i, at, b));
  return true;
}
