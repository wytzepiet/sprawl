import { Constants, RawTexture, type Scene } from "@babylonjs/core";
import { toHalf } from "./kerbs";

/** Slots to a row of the texture; it gains rows as shapes come. */
const COLS = 16;

/**
 * Shapes drawn on squares: each baked once, the first time it is met, into
 * a slot of one shared texture of half floats, two to a texel, read
 * smoothly. A square drawn says which slot is its shape, so every square of
 * a kind is one draw (`roads.ts`, `ground.ts`).
 */
export class Atlas {
  private slots = new Map<string, number>();
  private rows = 0;
  private data = new Uint16Array(0);
  private stale = false;
  texture: RawTexture | null = null;

  /** `side`: a slot's side, in texels. */
  constructor(
    private scene: Scene,
    readonly side: number,
  ) {}

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
  upload(): RawTexture | null {
    if (!this.stale) return this.texture;
    this.stale = false;
    const [w, h] = [COLS * this.side, this.rows * this.side];
    if (this.texture && this.texture.getSize().height === h) this.texture.update(this.data);
    else {
      this.texture?.dispose();
      this.texture = new RawTexture(this.data, w, h, Constants.TEXTUREFORMAT_RG, this.scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT);
      this.texture.wrapU = this.texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    }
    return this.texture;
  }

  dispose() {
    this.texture?.dispose();
  }

  private grow() {
    this.rows = Math.max(4, this.rows * 2);
    const data = new Uint16Array(COLS * this.side * this.rows * this.side * 2);
    data.set(this.data);
    this.data = data;
  }
}
