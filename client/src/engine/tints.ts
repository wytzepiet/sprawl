import { Constants, MaterialDefines, MaterialPluginBase, RawTexture, type Material, type Scene } from "@babylonjs/core";
import type { RGB } from "./town/mass";

/** Slots a row of the texture; it gains rows as buildings come. */
const ROW = 256;

/**
 * Each building's colour as it looks now, a texel a building, read by the
 * town's masses as they are drawn: their vertices carry not a colour but
 * the shade each surface takes of its building's (`Paint`: × a + b) and
 * which building it is. A building that only changes how it looks, its
 * shelves bare or stocked, is one texel written, not a town drawn again.
 */
export class Tints {
  private slots = new Map<number, number>();
  private data = new Uint8Array(0);
  private rows = 0;
  private stale = false;
  private texture: RawTexture | null = null;

  constructor(private scene: Scene) {}

  /** Whether a building has a slot yet. */
  has(id: number): boolean {
    return this.slots.has(id);
  }

  /** A building's slot, its colour set to this. */
  set(id: number, [r, g, b]: RGB): number {
    let slot = this.slots.get(id);
    if (slot === undefined) {
      slot = this.slots.size;
      this.slots.set(id, slot);
      if (slot >= this.rows * ROW) this.grow();
    }
    const texel = [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), 255];
    if (texel.some((v, i) => this.data[slot * 4 + i] !== v)) {
      this.data.set(texel, slot * 4);
      this.stale = true;
    }
    return slot;
  }

  /** The texture, with every colour set so far. */
  upload(): RawTexture | null {
    if (!this.stale) return this.texture;
    this.stale = false;
    if (this.texture && this.texture.getSize().height === this.rows) this.texture.update(this.data);
    else {
      this.texture?.dispose();
      this.texture = new RawTexture(this.data, ROW, this.rows, Constants.TEXTUREFORMAT_RGBA, this.scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE);
    }
    return this.texture;
  }

  dispose() {
    this.texture?.dispose();
  }

  private grow() {
    this.rows = Math.max(4, this.rows * 2);
    const data = new Uint8Array(ROW * this.rows * 4);
    data.set(this.data);
    this.data = data;
  }
}

class TintDefines extends MaterialDefines {
  TINT = false;
}

// The vertex colour, as the masses carry it: the shade's a and b, and the
// slot. Turned into the building's colour × a + b.
const GLSL = {
  CUSTOM_FRAGMENT_DEFINITIONS: `uniform sampler2D tints;`,
  CUSTOM_FRAGMENT_BEFORE_LIGHTS: `int tintSlot = int(vColor.b + 0.5);
baseColor.rgb = texelFetch(tints, ivec2(tintSlot % ${ROW}, tintSlot / ${ROW}), 0).rgb * vColor.r + vColor.g;`,
};
const WGSL = {
  CUSTOM_FRAGMENT_DEFINITIONS: `var tintsSampler: sampler; var tints: texture_2d<f32>;`,
  CUSTOM_FRAGMENT_BEFORE_LIGHTS: `let tintSlot = floor(fragmentInputs.vColor.b + 0.5);
let tintAt = (vec2f(tintSlot - ${ROW}. * floor(tintSlot / ${ROW}.), floor(tintSlot / ${ROW}.)) + 0.5) / vec2f(textureDimensions(tints, 0));
baseColor = vec4f(textureSampleLevel(tints, tintsSampler, tintAt, 0.).rgb * fragmentInputs.vColor.r + fragmentInputs.vColor.g, baseColor.a);`,
};

/** A material whose meshes' vertices carry shades and slots (`Tints`). */
export class TintPlugin extends MaterialPluginBase {
  constructor(
    material: Material,
    private tints: Tints,
  ) {
    super(material, "Tint", 220, new TintDefines());
    this._enable(true);
  }

  isCompatible() {
    return true;
  }

  prepareDefines(defines: TintDefines) {
    defines.TINT = true;
  }

  getSamplers(samplers: string[]) {
    samplers.push("tints");
  }

  bindForSubMesh(ubo: { setTexture(n: string, t: RawTexture): void }) {
    const texture = this.tints.upload();
    if (texture) ubo.setTexture("tints", texture);
  }

  getClassName() {
    return "TintPlugin";
  }

  getCustomCode(shaderType: string, shaderLanguage = 0) {
    if (shaderType === "vertex") return null;
    return shaderLanguage === 1 ? WGSL : GLSL;
  }
}
