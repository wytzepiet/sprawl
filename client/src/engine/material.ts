import { createPbrMaterial, markMaterialUboDirty, type MaterialPlugin, type PbrMaterialProps, type Texture2D } from "@babylonjs/lite";
import { WHITE, type Rgb } from "./rgb";

/**
 * The town's material: PBR, lit by the sun and by the sky round it
 * (`sky.ts`), its colour and its shape written by plugins, pixel by pixel.
 *
 * Before the lights (CUSTOM_FRAGMENT_UPDATE_DIFFUSE) a plugin writes, in
 * the material's own words:
 * - `baseColor`, the colour as an eye sees it: the mesh's own (its
 *   vertices', its texture's), which the material's tint multiplies;
 * - `N`, which way the surface faces;
 * - `townShine`, 0 to 1, how far the surface is glossed from its own
 *   roughness toward a polish: a grain of sand, a worn stone, wet slate.
 *
 * Closed after them: the colour tinted and made linear, as PBR wants its
 * albedo, and the shine laid on the roughness.
 */
const GLOSS = 0.12;

const OPEN: MaterialPlugin = {
  name: "TownOpen",
  priority: -1e6,
  getCustomCode: (stage) => (stage === "fragment" ? { CUSTOM_FRAGMENT_MAIN_BEGIN: "var townShine: f32 = 0.0;" } : null),
};

/** Tall things fade where they stand between the eye and the hand: within
 *  this many tiles of the line from the ground under the pointer up toward
 *  the camera, above this height, in tiles, at most this much, dithered
 *  pixel by pixel. */
const FADE_REACH = 2.5;
const FADE_ABOVE = 0.25;
const FADE_MOST = 0.75;
const fade = { x: 0, y: 0, r: 0, leanX: 0, leanY: 0 };
const towns = new Set<WeakRef<TownMaterial>>();

/** Fade what stands between `eye` and the ground under the hand; `null`,
 *  nothing. */
export function setFade(hand: { x: number; y: number } | null, eye: { x: number; y: number; z: number }) {
  const next = hand ? { x: hand.x, y: hand.y, r: FADE_REACH, leanX: (eye.x - hand.x) / eye.z, leanY: (eye.y - hand.y) / eye.z } : { ...fade, r: 0 };
  if ((Object.keys(next) as (keyof typeof fade)[]).every((k) => next[k] === fade[k])) return;
  Object.assign(fade, next);
  for (const ref of towns) {
    const m = ref.deref();
    if (m) markMaterialUboDirty(m);
    else towns.delete(ref);
  }
}

/** A town material's tint, its own: one shader for them all, a uniform each;
 *  and the fade round the hand, the same for all. */
function close(tint: { value: Rgb }): MaterialPlugin {
  return {
    name: "TownClose",
    priority: 1e6,
    getUniforms: () => ({ ubo: [{ name: "townTint", type: "vec4<f32>" }, { name: "townFade", type: "vec4<f32>" }, { name: "townFadeR", type: "f32" }] }),
    writeUbo: (data, offsets) => {
      data.set([tint.value.r, tint.value.g, tint.value.b, 1], offsets.get("townTint")! / 4);
      data.set([fade.x, fade.y, fade.leanX, fade.leanY], offsets.get("townFade")! / 4);
      data[offsets.get("townFadeR")! / 4] = fade.r;
    },
    getCustomCode: (stage) =>
      stage === "fragment"
        ? {
            CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `let townOff = input.worldPos.xy - material.townFade.xy - material.townFade.zw * input.worldPos.z;
let townFaded = (1. - smoothstep(material.townFadeR * 0.6, material.townFadeR + 1e-4, length(townOff))) * step(${FADE_ABOVE.toFixed(3)}, input.worldPos.z) * ${FADE_MOST.toFixed(3)};
if (townFaded > fract(52.9829189 * fract(dot(input.clipPos.xy, vec2f(0.06711056, 0.00583715))))) { discard; }
baseColor = pow(max(baseColor * material.townTint.rgb, vec3f(0.0)), vec3f(2.2));
roughness = mix(roughness, ${GLOSS.toFixed(3)}, townShine);`,
          }
        : null,
  };
}

export type TownMaterial = PbrMaterialProps & { readonly town: { value: Rgb } };

/** A material of the town's, made of these plugins, as rough as this when
 *  nothing glosses it: 1 chalk, 0 a mirror; its colours, if a texture's, as
 *  an eye sees them. */
export function townMaterial(plugins: MaterialPlugin[] = [], roughness = 0.9, texture?: Texture2D): TownMaterial {
  const town = { value: WHITE };
  const material = createPbrMaterial({
    metallicFactor: 0,
    roughnessFactor: roughness,
    ...(texture ? { baseColorTexture: texture } : {}),
    plugins: [OPEN, ...plugins, close(town)],
  });
  const made = Object.assign(material, { town });
  towns.add(new WeakRef(made));
  return made;
}

/** Tint a town material: its colour multiplies whatever its plugins paint. */
export function setTint(material: TownMaterial, colour: Rgb) {
  material.town.value = colour;
  markMaterialUboDirty(material);
}

/** Unlit: a flat colour, the tint's, brought onto the screen as the lit
 *  world's light is (exposure and tone map), the sun and sky left out. For
 *  a chevron, a marker: things painted on the map rather than standing in it. */
export const FLAT: MaterialPlugin = {
  name: "Flat",
  priority: 1e6,
  getCustomCode: (stage) => (stage === "fragment" ? { CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: "color = baseColor;" } : null),
};

/** Cast, never seen: drawn into the sun's shadow map, where only a
 *  material's cut runs, and dropped wherever it would be drawn on screen. */
export const CAST_ONLY: MaterialPlugin = {
  name: "CastOnly",
  priority: 1e6,
  getCustomCode: (stage) => (stage === "fragment" ? { CUSTOM_FRAGMENT_UPDATE_DIFFUSE: "discard;" } : null),
};
