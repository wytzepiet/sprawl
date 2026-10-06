import { MaterialDefines, MaterialPluginBase, type Material } from "@babylonjs/core";

/**
 * Roofs tiled, as the light finds them: on every face that slopes, courses
 * of tiles across the slope, each course lapping over the one below so its
 * lower edge stands proud and catches the light, and the tiles in a course
 * set off by joints, staggered course to course. Along the hips and the
 * ridge, where a face meets the next over a crease that rises (the bevel's,
 * `bevel.ts`), a row of half-round capping tiles, each lapping the next.
 * The slope is read off the face itself, so the courses run across however
 * it is turned. Walls and flat roofs are left alone, and only the facing
 * is touched, never the colour. Further out than a tile is a few pixels it
 * fades, so it does not shimmer.
 */

/** A course's depth down the slope, a tile's width along it, in tiles; how
 *  far a course's lap tilts it; how far in from a tile's side its joint
 *  rounds, and how steeply. */
const COURSE = 0.055;
const WIDTH = 0.07;
const LAP = 0.5;
const JOINT = 0.008;
const JOINT_DEPTH = 0.5;
/** The capping: how far either side of the crease it reaches, how long a
 *  capping tile is, and how far each laps the next. */
const CAP = 0.022;
const CAP_LENGTH = 0.06;
const CAP_LAP = 0.4;
/** A face is a roof's if it slopes between these, its facing's height. */
const [STEEPEST, FLATTEST] = [0.15, 0.97];

const n = (x: number) => x.toFixed(4);

class RoofDefines extends MaterialDefines {
  ROOF = false;
}

const GLSL = {
  CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef BEVEL
// The rising crease nearest, of a face's three: which way across it, and
// how far.
vec4 roofCrease(vec4 best, vec3 across, float reach, float at) {
  if (reach <= 0. || across.z < 0.05) return best;
  float d = at * reach;
  return d < best.w ? vec4(across, d) : best;
}
#endif`,
  CUSTOM_FRAGMENT_BEFORE_LIGHTS: `vec3 roofP = vPositionW;
vec3 roofFace = normalize(cross(dFdx(roofP), dFdy(roofP)));
roofFace *= roofFace.z >= 0. ? 1. : -1.;
float roofUp = roofFace.z;
vec2 roofDown = normalize(roofFace.xy + vec2(1e-6, 0.));
vec2 roofAcross = vec2(-roofDown.y, roofDown.x);
float roofCourses = dot(roofP.xy, roofDown) / max(roofUp, 0.05) / ${n(COURSE)};
float roofCourse = floor(roofCourses);
float roofAlong = dot(roofP.xy, roofAcross) / ${n(WIDTH)} + 0.5 * mod(roofCourse, 2.);
float roofNear = 1. - smoothstep(0.2, 0.4, max(fwidth(roofCourses), fwidth(roofAlong)));
#ifdef BEVEL
vec4 roofRidge = vec4(0., 0., 1., 9.);
roofRidge = roofCrease(roofRidge, vBevelAcross0, vBevelReach.x, vBevelAt.x);
roofRidge = roofCrease(roofRidge, vBevelAcross1, vBevelReach.y, vBevelAt.y);
roofRidge = roofCrease(roofRidge, vBevelAcross2, vBevelReach.z, vBevelAt.z);
vec3 roofOver = normalize(roofRidge.xyz);
vec3 roofRun = normalize(cross(roofFace, roofOver) + vec3(1e-6, 0., 0.));
float roofCaps = dot(roofP, roofRun) / ${n(CAP_LENGTH)};
float roofCapNear = 1. - smoothstep(0.2, 0.4, fwidth(roofCaps));
#endif
if (roofUp > ${n(STEEPEST)} && roofUp < ${n(FLATTEST)}) {
  float roofIn = fract(roofAlong);
  float roofLap = (fract(roofCourses) - 0.5) * ${n(LAP)};
  float roofSide = min(roofIn, 1. - roofIn) * ${n(WIDTH)};
  float roofJoint = sign(roofIn - 0.5) * max(0., 1. - roofSide / ${n(JOINT)}) * ${n(JOINT_DEPTH)};
  vec3 roofTiled = normalize(normalW + vec3(roofDown * roofLap + roofAcross * roofJoint, 0.) * roofNear);
#ifdef BEVEL
  if (roofRidge.w < ${n(CAP)}) {
    float roofS = roofRidge.w / ${n(CAP)};
    vec3 roofCap = normalize(mix(normalize(roofFace + roofOver * 0.6), normalize(roofFace - roofOver * 1.3), roofS * roofS));
    roofCap = normalize(roofCap + roofRun * (fract(roofCaps) - 0.5) * ${n(CAP_LAP)} * roofCapNear);
    roofTiled = normalize(mix(roofTiled, roofCap, roofNear));
  }
#endif
  normalW = roofTiled;
}`,
};

const WGSL = {
  CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef BEVEL
fn roofCrease(best: vec4f, across: vec3f, reach: f32, at: f32) -> vec4f {
  if (reach <= 0. || across.z < 0.05) { return best; }
  let d = at * reach;
  return select(best, vec4f(across, d), d < best.w);
}
#endif`,
  CUSTOM_FRAGMENT_BEFORE_LIGHTS: `// Everything its slopes are read from worked out for every pixel, outside
// any branch: WGSL reads slopes only where every pixel reads them.
let roofP = fragmentInputs.vPositionW;
var roofFace = normalize(cross(dpdx(roofP), dpdy(roofP)));
roofFace *= select(-1., 1., roofFace.z >= 0.);
let roofUp = roofFace.z;
let roofDown = normalize(roofFace.xy + vec2f(1e-6, 0.));
let roofAcross = vec2f(-roofDown.y, roofDown.x);
let roofCourses = dot(roofP.xy, roofDown) / max(roofUp, 0.05) / ${n(COURSE)};
let roofCourse = floor(roofCourses);
let roofAlong = dot(roofP.xy, roofAcross) / ${n(WIDTH)} + 0.5 * (roofCourse - 2. * floor(roofCourse / 2.));
let roofNear = 1. - smoothstep(0.2, 0.4, max(fwidth(roofCourses), fwidth(roofAlong)));
#ifdef BEVEL
var roofRidge = vec4f(0., 0., 1., 9.);
roofRidge = roofCrease(roofRidge, fragmentInputs.vBevelAcross0, fragmentInputs.vBevelReach.x, fragmentInputs.vBevelAt.x);
roofRidge = roofCrease(roofRidge, fragmentInputs.vBevelAcross1, fragmentInputs.vBevelReach.y, fragmentInputs.vBevelAt.y);
roofRidge = roofCrease(roofRidge, fragmentInputs.vBevelAcross2, fragmentInputs.vBevelReach.z, fragmentInputs.vBevelAt.z);
let roofOver = normalize(roofRidge.xyz);
let roofRun = normalize(cross(roofFace, roofOver) + vec3f(1e-6, 0., 0.));
let roofCaps = dot(roofP, roofRun) / ${n(CAP_LENGTH)};
let roofCapNear = 1. - smoothstep(0.2, 0.4, fwidth(roofCaps));
#endif
if (roofUp > ${n(STEEPEST)} && roofUp < ${n(FLATTEST)}) {
  let roofIn = fract(roofAlong);
  let roofLap = (fract(roofCourses) - 0.5) * ${n(LAP)};
  let roofSide = min(roofIn, 1. - roofIn) * ${n(WIDTH)};
  let roofJoint = sign(roofIn - 0.5) * max(0., 1. - roofSide / ${n(JOINT)}) * ${n(JOINT_DEPTH)};
  var roofTiled = normalize(normalW + vec3f(roofDown * roofLap + roofAcross * roofJoint, 0.) * roofNear);
#ifdef BEVEL
  if (roofRidge.w < ${n(CAP)}) {
    let roofS = roofRidge.w / ${n(CAP)};
    var roofCap = normalize(mix(normalize(roofFace + roofOver * 0.6), normalize(roofFace - roofOver * 1.3), roofS * roofS));
    roofCap = normalize(roofCap + roofRun * (fract(roofCaps) - 0.5) * ${n(CAP_LAP)} * roofCapNear);
    roofTiled = normalize(mix(roofTiled, roofCap, roofNear));
  }
#endif
  normalW = roofTiled;
}`,
};

/** A building material's roofs, tiled. */
class RoofPlugin extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "Roof", 230, new RoofDefines());
    this._enable(true);
  }

  isCompatible() {
    return true;
  }

  prepareDefines(defines: RoofDefines) {
    defines.ROOF = true;
  }

  getClassName() {
    return "RoofPlugin";
  }

  getCustomCode(shaderType: string, shaderLanguage = 0) {
    if (shaderType === "vertex") return null;
    return shaderLanguage === 1 ? WGSL : GLSL;
  }
}

/** A building material, its roofs tiled, once. */
export function tiled(material: Material) {
  if (!material.pluginManager?.getPlugin("Roof")) new RoofPlugin(material);
}
