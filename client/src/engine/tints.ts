import { createTexture2DFromPixels, updateTexture2DFromPixels, type EngineContext, type MaterialPlugin, type Texture2D } from "@babylonjs/lite";
import type { RGB } from "./town/mass";

/** Slots a row of the texture, and its rows: room for this many buildings
 *  ever coloured, a texture bound once and never replaced. */
const ROW = 256;
const ROWS = 64;

/**
 * Each building's colour as it looks now, a texel a building, read by the
 * town's masses as they are drawn: their vertices carry not a colour but
 * the shade each surface takes of its building's (`Paint`: × a + b) and
 * which building it is. A building that only changes how it looks, its
 * shelves bare or stocked, is one texel written, not a town drawn again.
 */
export class Tints {
  private slots = new Map<number, number>();
  private data = new Uint8Array(ROW * ROWS * 4);
  private stale = false;
  readonly texture: Texture2D;

  constructor(private engine: EngineContext) {
    this.texture = createTexture2DFromPixels(engine, this.data, ROW, ROWS);
  }

  /** Whether a building has a slot yet. */
  has(id: number): boolean {
    return this.slots.has(id);
  }

  /** A building's slot, its colour set to this. */
  set(id: number, [r, g, b]: RGB): number {
    let slot = this.slots.get(id);
    if (slot === undefined) {
      slot = Math.min(this.slots.size, ROW * ROWS - 1);
      this.slots.set(id, slot);
    }
    const texel = [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), 255];
    if (texel.some((v, i) => this.data[slot * 4 + i] !== v)) {
      this.data.set(texel, slot * 4);
      this.stale = true;
    }
    return slot;
  }

  /** Every colour set so far, uploaded; before each frame. */
  upload() {
    if (!this.stale) return;
    this.stale = false;
    updateTexture2DFromPixels(this.engine, this.texture, this.data);
  }
}

// The vertex colour, as the masses carry it: the shade's a and b, and the
// slot. Turned into the building's colour × a + b.

/** A material whose meshes' vertices carry shades and slots (`Tints`). */
export function tintPlugin(tints: Tints): MaterialPlugin {
  return {
    name: "Tint",
    priority: 220,
    getSamplers: () => [{ texture: "tints", sampler: "tintsSampler" }],
    bindTextures: (out) => out.push({ texture: tints.texture }),
    getCustomCode: (stage) =>
      stage === "fragment"
        ? {
            CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `let tintSlot = floor(input.vColor.b + 0.5);
let tintAt = (vec2f(tintSlot - ${ROW}. * floor(tintSlot / ${ROW}.), floor(tintSlot / ${ROW}.)) + 0.5) / vec2f(textureDimensions(tints, 0));
baseColor = textureSampleLevel(tints, tintsSampler, tintAt, 0.).rgb * input.vColor.r + input.vColor.g;
alpha = 1.0;`,
          }
        : null,
  };
}
