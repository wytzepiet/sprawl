import { createTexture2DFromPixels, updateTexture2DFromPixels, type EngineContext, type Texture2D } from "./gpu";
import { retire } from "./geometry";
import { CHUNK_SIZE } from "./objects/terrainGeometry";
import { VERGE_DENSITY, VERGE_IN, VERGE_OUT } from "./kerbLines";

/**
 * The grass stands a little higher than what is laid in it, roads and
 * paving, and rounds down to them at its verge (`ground.ts`), its foot
 * in the shade on them (`roads.ts`, `kerbs.ts`). For the grass to know
 * where its verge is, each chunk of the land has a texture of how far
 * each point lies from the nearest road or paving: worked out here, on
 * the CPU, when one of them changes, from the distances each already
 * keeps of its own outline (its tile's shape, a town chunk's paving),
 * the nearest of them at each texel. Read by the grass, drawn into the
 * still picture with it: nothing a frame.
 */

export { VERGE_IN, VERGE_OUT };
const SIDE = CHUNK_SIZE * VERGE_DENSITY;
const SCALE = 1 / (VERGE_IN + VERGE_OUT);

/** What is laid: its signed distances, inside positive, over a grid of
 *  `w` by `h` texels, `density` to a tile, the first texel's middle at
 *  (x0, y0) in the world. */
export interface Laid {
  data: Float32Array;
  x0: number;
  y0: number;
  density: number;
  w: number;
  h: number;
}

/** A chunk's texture: what is laid anywhere in it, by key. */
interface Chunk {
  texture: Texture2D | null;
  laid: Set<string>;
}

const VERGES = new WeakMap<EngineContext, Verge>();
export const verge = (engine: EngineContext): Verge => VERGES.get(engine) ?? (VERGES.set(engine, new Verge(engine)), VERGES.get(engine)!);

export class Verge {
  private laid = new Map<string, Laid>();
  private chunks = new Map<string, Chunk>();
  /** Each changed chunk, and where in the world it changed. */
  private dirty = new Map<string, number[]>();
  private scheduled = false;
  /** For a chunk with nothing laid in it: as far from everything as kept. */
  readonly far: Texture2D;
  /** Told of a chunk whose texture is new, or changed. */
  private told = new Set<(chunk: string, fresh: boolean, within: number[]) => void>();

  constructor(private engine: EngineContext) {
    this.far = createTexture2DFromPixels(engine, new Uint8Array([255]), 1, 1, { format: "r8unorm" });
  }

  /** A chunk's texture, or `far`. */
  of(chunk: string): Texture2D {
    return this.chunks.get(chunk)?.texture ?? this.far;
  }

  listen(fn: (chunk: string, fresh: boolean, within: number[]) => void): () => void {
    this.told.add(fn);
    return () => void this.told.delete(fn);
  }

  /** Something laid under `key`, in place of what was; `null`, nothing. */
  set(key: string, laid: Laid | null) {
    const was = this.laid.get(key);
    if (was) for (const c of this.chunksOf(was)) this.chunks.get(c)?.laid.delete(key), this.touch(c, was);
    if (laid) {
      this.laid.set(key, laid);
      for (const c of this.chunksOf(laid)) {
        const chunk = this.chunks.get(c) ?? { texture: null, laid: new Set() };
        this.chunks.set(c, chunk);
        chunk.laid.add(key);
        this.touch(c, laid);
      }
    } else this.laid.delete(key);
    if (!this.scheduled) (this.scheduled = true), queueMicrotask(() => this.flush());
  }

  /** A chunk changed where a thing laid lies. */
  private touch(chunk: string, laid: Laid) {
    const [x0, y0, x1, y1] = boxOf(laid);
    const b = this.dirty.get(chunk) ?? [Infinity, Infinity, -Infinity, -Infinity];
    this.dirty.set(chunk, [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)]);
  }

  /** The chunks a thing laid reaches. */
  private chunksOf(laid: Laid): string[] {
    const [x0, y0, x1, y1] = boxOf(laid);
    const [c0, r0, c1, r1] = [x0, y0, x1, y1].map((v) => Math.floor(v / CHUNK_SIZE));
    const out: string[] = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(`${c},${r}`);
    return out;
  }

  /** Every changed chunk's texture made again: at each texel the nearest
   *  of what is laid there, stored as how far into the grass it lies,
   *  from under the road (0) to as far as kept (1). */
  private flush() {
    this.scheduled = false;
    for (const [c, within] of this.dirty) {
      const chunk = this.chunks.get(c);
      if (!chunk) continue;
      if (!chunk.laid.size) {
        if (chunk.texture) retire(chunk.texture);
        this.chunks.delete(c);
        this.tell(c, true, within);
        continue;
      }
      const [cx, cy] = c.split(",").map(Number);
      const [ox, oy] = [cx * CHUNK_SIZE, cy * CHUNK_SIZE];
      // Only the texels where it changed; all of them for a new texture.
      const fresh = !chunk.texture;
      const clip = (v: number) => Math.max(0, Math.min(SIDE, v));
      const [i0, j0, i1, j1] = fresh
        ? [0, 0, SIDE, SIDE]
        : [clip(Math.floor((within[0] - ox) * VERGE_DENSITY)), clip(Math.floor((within[1] - oy) * VERGE_DENSITY)), clip(Math.ceil((within[2] - ox) * VERGE_DENSITY)), clip(Math.ceil((within[3] - oy) * VERGE_DENSITY))];
      const [w, h] = [i1 - i0, j1 - j0];
      if (w <= 0 || h <= 0) continue;
      const region = { ox: ox + i0 / VERGE_DENSITY, oy: oy + j0 / VERGE_DENSITY, w, h };
      const best = new Float32Array(w * h).fill(-VERGE_OUT);
      const [x0, y0, x1, y1] = [region.ox, region.oy, region.ox + w / VERGE_DENSITY, region.oy + h / VERGE_DENSITY];
      for (const key of chunk.laid) {
        const laid = this.laid.get(key)!;
        const b = boxOf(laid);
        if (b[2] >= x0 && b[0] <= x1 && b[3] >= y0 && b[1] <= y1) nearest(laid, region, best);
      }
      const out = new Uint8Array(w * h);
      for (let k = 0; k < out.length; k++) out[k] = Math.round(Math.max(0, Math.min(1, (VERGE_IN - best[k]) * SCALE)) * 255);
      if (chunk.texture) updateTexture2DFromPixels(this.engine, chunk.texture, out, i0, j0, w, h);
      else chunk.texture = createTexture2DFromPixels(this.engine, out, SIDE, SIDE, { format: "r8unorm", minFilter: "linear", magFilter: "linear" });
      this.tell(c, fresh, within);
    }
    this.dirty.clear();
  }

  private tell(chunk: string, fresh: boolean, within: number[]) {
    for (const fn of this.told) fn(chunk, fresh, within);
  }
}

/** Where in the world a thing laid lies, with the grass's reach round it. */
const boxOf = ({ x0, y0, density, w, h }: Laid) => [x0 - VERGE_OUT, y0 - VERGE_OUT, x0 + w / density + VERGE_OUT, y0 + h / density + VERGE_OUT];

/** Into a region of a chunk's texels, `w` by `h` from (ox, oy), the most
 *  inside of what was there and what is laid, read between its own texels. */
function nearest({ data, x0, y0, density, w, h }: Laid, region: { ox: number; oy: number; w: number; h: number }, best: Float32Array) {
  const { ox, oy } = region;
  const i0 = Math.max(0, Math.floor((x0 - ox) * VERGE_DENSITY));
  const j0 = Math.max(0, Math.floor((y0 - oy) * VERGE_DENSITY));
  const i1 = Math.min(region.w - 1, Math.ceil((x0 + (w - 1) / density - ox) * VERGE_DENSITY));
  const j1 = Math.min(region.h - 1, Math.ceil((y0 + (h - 1) / density - oy) * VERGE_DENSITY));
  for (let j = j0; j <= j1; j++) {
    const v = (oy + (j + 0.5) / VERGE_DENSITY - y0) * density;
    if (v < 0 || v > h - 1) continue;
    const vj = Math.min(h - 2, Math.floor(v));
    const fv = v - vj;
    for (let i = i0; i <= i1; i++) {
      const u = (ox + (i + 0.5) / VERGE_DENSITY - x0) * density;
      if (u < 0 || u > w - 1) continue;
      const ui = Math.min(w - 2, Math.floor(u));
      const fu = u - ui;
      const k = vj * w + ui;
      const d = (data[k] * (1 - fu) + data[k + 1] * fu) * (1 - fv) + (data[k + w] * (1 - fu) + data[k + w + 1] * fu) * fv;
      const at = j * region.w + i;
      if (d > best[at]) best[at] = d;
    }
  }
}
