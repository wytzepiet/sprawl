import type { Mesh } from "./mesh";

/**
 * Thin instances culled to a view, for the lists drawn once a picture (the
 * G-buffer, the still map): each instance's sphere tested against the
 * view's sides, and those in it packed, with what each carries (its
 * colour, a plugin's own), into buffers of the draw's own, their count
 * into its args. The town's houses are a few buckets of instances
 * town-wide, and a picture sees a fifth of them. On the CPU: a compute
 * dispatch a mesh cost the GPU more, barrier after barrier, than the
 * triangles it saved.
 */

/** How far past its geometry's sphere an instance may be drawn, in tiles:
 *  what the plugins move in the vertex shader (a deck's lift, a tree's
 *  card turned to the sun) stays inside it. */
const MARGIN = 2;

/** A mesh's draw as culled: its args, and for each per-instance buffer the
 *  one drawn in its place, where its data is, and its floats a slot. */
interface Culled {
  args: GPUBuffer;
  out: { buffer: GPUBuffer; name: string; floats: number }[];
}

let scratch = new Float32Array(1024);
const kept = { at: new Uint32Array(256), n: 0 };

export class InstanceCuller {
  private culled = new WeakMap<Mesh, Culled>();

  constructor(private device: GPUDevice) {}

  /** The buffers and args a mesh's draw reads, culled, in place of `buffers`
   *  (named `names`, laid out as `layouts`): made anew, as its draw is
   *  encoded anew. */
  make(mesh: Mesh, names: string[], layouts: GPUVertexBufferLayout[], buffers: GPUBuffer[]): { buffers: GPUBuffer[]; args: GPUBuffer } {
    const device = this.device;
    const old = this.culled.get(mesh);
    if (old) for (const b of [old.args, ...old.out.map((o) => o.buffer)]) b.destroy();
    const args = device.createBuffer({ size: 20, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
    new Uint32Array(args.getMappedRange()).set([mesh._gpu.indexCount, 0, 0, 0, 0]);
    args.unmap();
    const out: Culled["out"] = [];
    const drawn = buffers.map((b, i) => {
      if (layouts[i]!.stepMode !== "instance") return b;
      const buffer = device.createBuffer({ size: b.size, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      out.push({ buffer, name: names[i]!, floats: layouts[i]!.arrayStride / 4 });
      return buffer;
    });
    this.culled.set(mesh, { args, out });
    return { buffers: drawn, args };
  }

  /** The meshes' instances culled to the sides of `vp`'s view. */
  run(vp: ArrayLike<number>, meshes: Iterable<Mesh>) {
    const sides = planes(vp);
    const queue = this.device.queue;
    for (const mesh of meshes) {
      const c = this.culled.get(mesh);
      const ti = mesh.thinInstances;
      if (!c || !ti) continue;
      inside(mesh, sides);
      for (const { buffer, name, floats } of c.out) {
        const from = name === "instances" ? ti.matrices : name === "instanceColors" ? ti.colors : mesh._attributes.get(name);
        if (!from) continue;
        const size = kept.n * floats;
        if (scratch.length < size) scratch = new Float32Array(2 ** Math.ceil(Math.log2(size)));
        for (let k = 0; k < kept.n; k++) {
          const [s, d] = [kept.at[k]! * floats, k * floats];
          for (let w = 0; w < floats; w++) scratch[d + w] = from[s + w]!;
        }
        if (size) queue.writeBuffer(buffer, 0, scratch, 0, size);
      }
      queue.writeBuffer(c.args, 4, new Uint32Array([kept.n]));
    }
  }
}

/** How many of a mesh's thin instances stand in a view (`planes`): what its draw will cost. */
export function seen(mesh: Mesh, sides: Float32Array): number {
  if (!mesh.thinInstances) return 1;
  inside(mesh, sides);
  return kept.n;
}

/** The indices of a mesh's thin instances whose spheres meet a view, into `kept`. */
function inside(mesh: Mesh, sides: Float32Array) {
  const ti = mesh.thinInstances!;
  const [sx, sy, sz, sr] = mesh._gpu.sphere;
  const p = mesh.position;
  const m = ti.matrices;
  if (kept.at.length < ti.count) kept.at = new Uint32Array(2 ** Math.ceil(Math.log2(ti.count)));
  kept.n = 0;
  next: for (let i = 0; i < ti.count; i++) {
    const o = i * 16;
    const x = m[o]! * sx + m[o + 4]! * sy + m[o + 8]! * sz + m[o + 12]! + p.x;
    const y = m[o + 1]! * sx + m[o + 5]! * sy + m[o + 9]! * sz + m[o + 13]! + p.y;
    const z = m[o + 2]! * sx + m[o + 6]! * sy + m[o + 10]! * sz + m[o + 14]! + p.z;
    const scale = Math.sqrt(Math.max(m[o]! ** 2 + m[o + 1]! ** 2 + m[o + 2]! ** 2, m[o + 4]! ** 2 + m[o + 5]! ** 2 + m[o + 6]! ** 2, m[o + 8]! ** 2 + m[o + 9]! ** 2 + m[o + 10]! ** 2));
    const r = sr * scale + MARGIN;
    for (let k = 0; k < 16; k += 4) if (sides[k]! * x + sides[k + 1]! * y + sides[k + 2]! * z + sides[k + 3]! < -r) continue next;
    kept.at[kept.n++] = i;
  }
}

/** A view's four sides, from its matrix (column major), each normalised:
 *  a point is inside where every `n · p + d` is at least 0. Near and far
 *  are left open: what is behind the eye is cut by the sides of a
 *  perspective, and what casts from above the sun's box still falls in it. */
export function planes(vp: ArrayLike<number>): Float32Array {
  const row = (i: number) => [vp[i]!, vp[4 + i]!, vp[8 + i]!, vp[12 + i]!];
  const [x, y, w] = [row(0), row(1), row(3)];
  const out = new Float32Array(16);
  [w.map((v, k) => v + x[k]!), w.map((v, k) => v - x[k]!), w.map((v, k) => v + y[k]!), w.map((v, k) => v - y[k]!)].forEach((p, i) => {
    const len = Math.hypot(p[0]!, p[1]!, p[2]!) || 1;
    out.set(p.map((v) => v / len), i * 4);
  });
  return out;
}
