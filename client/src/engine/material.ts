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

/** A town material's tint, its own: one shader for them all, a uniform each. */
function close(tint: { value: Rgb }): MaterialPlugin {
  return {
    name: "TownClose",
    priority: 1e6,
    getUniforms: () => ({ ubo: [{ name: "townTint", type: "vec4<f32>" }] }),
    writeUbo: (data, offsets) => data.set([tint.value.r, tint.value.g, tint.value.b, 1], offsets.get("townTint")! / 4),
    getCustomCode: (stage) =>
      stage === "fragment"
        ? {
            CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `baseColor = pow(max(baseColor * material.townTint.rgb, vec3f(0.0)), vec3f(2.2));
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
  return Object.assign(material, { town });
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
