/**
 * How the scene's light, unbounded, is brought into what a screen can show:
 * AgX, Troy Sobotka's, as film takes light, in Benjamin Wrensch's fit, with
 * a richer punchy look. Laid into every material where Lite's own curve would
 * go, after the exposure and before the colour is put into gamma.
 *
 * The light is leant a little toward grey, so a saturated light (a red sun)
 * never rests on one channel; put into stops; drawn through film's S-curve,
 * a soft toe and a long shoulder, so a bright colour passes on toward white
 * rather than to yellow or magenta; then given more contrast and colour, the
 * punchy look; and leant back.
 */
/** The curve, `toneMap`, with its look: this much more colour, and contrast. */
const agx = (colour: number, contrast: number) => `const toneIn = mat3x3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772, 0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104);
const toneOut = mat3x3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417, -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
fn toneMap(c0: vec3f) -> vec3f {
var c = (clamp(log2(max(toneIn * c0, vec3f(1e-10))), vec3f(-12.47393), vec3f(4.026069)) + 12.47393) / 16.5;
let c2 = c * c;
let c4 = c2 * c2;
c = 15.5 * c4 * c2 - 40.14 * c4 * c + 31.96 * c4 - 6.868 * c2 * c + 0.4298 * c2 + 0.1191 * c - 0.00232;
c = pow(max(c, vec3f(0.)), vec3f(${contrast}));
let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
c = luma + ${colour} * (c - luma);
return pow(max(toneOut * c, vec3f(0.)), vec3f(2.2));
}`;

/** How much contrast the curve is given. */
export const CONTRAST = 1.35;

/** How much more colour, and how much of the S. */
const POP = { colour: "1.15", contrast: "0.2" };

/**
 * Khronos' PBR Neutral (Emmett Lalish's): what is lit no brighter than white
 * is left as it is, so a surface in full sun shows the colour it was painted,
 * not a film's take on it; only what passes white is drawn in toward it, and
 * paled as it goes. AgX's toe and its contrast had pressed every middle tone
 * down, and a white wall at noon came out a beige grey: the town read murky.
 */
const neutral = `fn neutral(c0: vec3f) -> vec3f {
let low = min(c0.r, min(c0.g, c0.b));
var c = c0 - select(0.04, low - 6.25 * low * low, low < 0.08);
let peak = max(c.r, max(c.g, c.b));
if (peak < 0.76) { return c; }
let top = 1. - 0.0576 / (peak - 0.52);
c *= top / peak;
return mix(c, vec3f(top), 1. - 1. / (0.15 * (peak - top) + 1.));
}
/** And then made to pop, as a toy town under a bright sky: as the eye sees
 *  it, more colour, its grey kept, and a gentle S round the middle. */
fn toneMap(c0: vec3f) -> vec3f {
var c = pow(clamp(neutral(c0), vec3f(0.), vec3f(1.)), vec3f(1. / 2.2));
let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
c = clamp(luma + ${POP.colour} * (c - luma), vec3f(0.), vec3f(1.));
c = mix(c, c * c * (3. - 2. * c), ${POP.contrast});
return pow(c, vec3f(2.2));
}`;

/** `?light=old`, for now: the town as it was lit before, to set beside. */
export const OLD_LIGHT = typeof location !== "undefined" && new URLSearchParams(location.search).get("light") === "old";

/** The town's tone mapping, set on the scene (`DayNightCycle.tsx`); the
 *  exposure, the eye's, applied first. */
export const TONE = {
  id: OLD_LIGHT ? "agx-rich" : "neutral",
  helpersWGSL: OLD_LIGHT ? agx(1.7, CONTRAST) : neutral,
  callWGSL: "color = toneMap(color * scene.vImageInfos.x);",
};
