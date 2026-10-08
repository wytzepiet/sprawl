import { createTexture2DFromPixels, updateTexture2DFromPixels, type EngineContext, type Texture2D } from "@babylonjs/lite";
import { retire } from "./geometry";
import { toHalf } from "./kerbLines";

/** Slots to a row of the texture; it gains rows as shapes come. */
const COLS = 16;

/**
 * Shapes drawn on squares: each baked once, the first time it is met, into
 * a slot of one shared texture of half floats, two to a texel, read
 * smoothly. A square drawn says which slot is its shape, so every square of
 * a kind is one draw (`roads.ts`, `ground.ts`). When it gains rows its
 * texture is a new one, and `regrown` is told, so what reads it is bound
 * to the new one.
 */
export class Atlas {
  private slots = new Map<string, number>();
  private rows = 0;
  private data = new Uint16Array(0);
  private stale = false;
  texture: Texture2D;

  /** `side`: a slot's side, in texels. A texture from the start, empty: a
   *  material binds it before any shape is baked. */
  constructor(
    private engine: EngineContext,
    readonly side: number,
    private regrown: () => void,
  ) {
    this.grow();
    this.texture = this.make();
  }

  private make() {
    return createTexture2DFromPixels(this.engine, this.data, COLS * this.side, this.rows * this.side, { format: "rg16float", minFilter: "linear", magFilter: "linear" });
  }

  /** Slots across the texture, and down. */
  get grid(): [number, number] {
    return [COLS, this.rows];
  }

  /** The slot of the shape under `key`; if it is new, `bake` gives its
   *  two channels, a row of `side` at a time, from its low corner. */
  slotOf(key: string, bake: () => [Float32Array, Float32Array]): number {
    const known = this.slots.get(key);
    if (known !== undefined) return known;
    const slot = this.slots.size;
    if (slot >= this.rows * COLS) this.grow();
    const [first, second] = bake();
    const [col, row, side] = [slot % COLS, Math.floor(slot / COLS), this.side];
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        const at = ((row * side + j) * COLS * side + col * side + i) * 2;
        this.data[at] = toHalf(first[j * side + i]);
        this.data[at + 1] = toHalf(second[j * side + i]);
      }
    }
    this.stale = true;
    this.slots.set(key, slot);
    return slot;
  }

  /** The texture, with every shape baked so far. */
  upload(): Texture2D {
    if (!this.stale) return this.texture;
    this.stale = false;
    if (this.texture.height === this.rows * this.side) updateTexture2DFromPixels(this.engine, this.texture, this.data);
    else {
      // Let go once nothing is drawn with it: the rebound draws come a frame or two on.
      retire(this.texture);
      this.texture = this.make();
      this.regrown();
    }
    return this.texture;
  }

  dispose() {
    retire(this.texture);
  }

  private grow() {
    this.rows = Math.max(4, this.rows * 2);
    const data = new Uint16Array(COLS * this.side * this.rows * this.side * 2);
    data.set(this.data);
    this.data = data;
  }
}
