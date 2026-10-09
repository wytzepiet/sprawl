import type { MaterialPlugin } from "@babylonjs/lite";

/**
 * Roofs tiled, as the light finds them: on every face that slopes, courses
 * of tiles across the slope, each course lapping over the one below so its
 * lower edge stands proud and catches the light, and the tiles in a course
 * set off by joints, staggered course to course. Along the hips and the
 * ridge, where a face meets the next over a crease that rises (the bevel's,
 * `bevel.ts`), a row of half-round capping tiles, each lapping the next.
 * The slope is read off the face itself, so the courses run across however
 * it is turned. Walls and flat roofs are left alone, but for the capping
 * along the edge where a slope meets a flat top; and only the facing
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

/** A building material's roofs, tiled: on the bevel's meshes (`bevel.ts`),
 *  whose creases it reads for the hips and the ridge. */
export const ROOF: MaterialPlugin = {
  name: "Roof",
  priority: 230,
  getCustomCode: (stage) =>
    stage === "fragment"
      ? {
          CUSTOM_FRAGMENT_DEFINITIONS: `fn roofCrease(best: vec4f, face: vec3f, across: vec3f, reach: f32, at: f32) -> vec4f {
  // Capped where the face across faces up a little (a hip, a ridge, a
  // flat behind), or is a wall falling away uphill of this slope (the
  // top edge of a mansard, its flat sunk behind it); never at the eaves,
  // where the wall falls away below.
  if (reach <= 0. || (across.z < 0.05 && dot(across.xy, face.xy) >= 0.)) { return best; }
  let d = at * reach;
  return select(best, vec4f(across, d), d < best.w);
}`,
          CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `// Everything its slopes are read from worked out for every pixel, outside
// any branch: WGSL reads slopes only where every pixel reads them.
let roofP = input.worldPos;
var roofFace = normalize(cross(dpdx(roofP), dpdy(roofP)));
roofFace *= select(-1., 1., roofFace.z >= 0.);
let roofUp = roofFace.z;
let roofDown = normalize(roofFace.xy + vec2f(1e-6, 0.));
let roofAcross = vec2f(-roofDown.y, roofDown.x);
let roofCourses = dot(roofP.xy, roofDown) / max(roofUp, 0.05) / ${n(COURSE)};
let roofCourse = floor(roofCourses);
let roofAlong = dot(roofP.xy, roofAcross) / ${n(WIDTH)} + 0.5 * (roofCourse - 2. * floor(roofCourse / 2.));
let roofNear = 1. - smoothstep(0.2, 0.4, max(fwidth(roofCourses), fwidth(roofAlong)));
var roofRidge = vec4f(0., 0., 1., 9.);
roofRidge = roofCrease(roofRidge, roofFace, input.vBevelAcross0, input.vBevelReach.x, input.vBevelAt.x);
roofRidge = roofCrease(roofRidge, roofFace, input.vBevelAcross1, input.vBevelReach.y, input.vBevelAt.y);
roofRidge = roofCrease(roofRidge, roofFace, input.vBevelAcross2, input.vBevelReach.z, input.vBevelAt.z);
let roofOver = normalize(roofRidge.xyz);
let roofRun = normalize(cross(roofFace, roofOver) + vec3f(1e-6, 0., 0.));
let roofCaps = dot(roofP, roofRun) / ${n(CAP_LENGTH)};
let roofCapNear = 1. - smoothstep(0.2, 0.4, fwidth(roofCaps));
let roofSloped = roofUp > ${n(STEEPEST)} && roofUp < ${n(FLATTEST)};
// A flat roof behind a slope stays flat up to its capping: the bevel
// does not round it over toward the slope.
if (roofUp >= ${n(FLATTEST)} && roofRidge.w < 9.) { N = roofFace; }
// A flat roof behind a slope (a mansard's) is capped along that edge too,
// the capping's other half: no tiles of its own.
if (roofSloped || (roofUp >= ${n(FLATTEST)} && roofRidge.w < ${n(CAP)})) {
  let roofIn = fract(roofAlong);
  let roofLap = (fract(roofCourses) - 0.5) * ${n(LAP)};
  let roofSide = min(roofIn, 1. - roofIn) * ${n(WIDTH)};
  let roofJoint = sign(roofIn - 0.5) * max(0., 1. - roofSide / ${n(JOINT)}) * ${n(JOINT_DEPTH)};
  var roofTiled = select(N, normalize(N + vec3f(roofDown * roofLap + roofAcross * roofJoint, 0.) * roofNear), roofSloped);
  if (roofRidge.w < ${n(CAP)}) {
    let roofS = roofRidge.w / ${n(CAP)};
    var roofCap = normalize(mix(normalize(roofFace + roofOver * 0.6), normalize(roofFace - roofOver * 1.3), roofS * roofS));
    roofCap = normalize(roofCap + roofRun * (fract(roofCaps) - 0.5) * ${n(CAP_LAP)} * roofCapNear);
    roofTiled = normalize(mix(roofTiled, roofCap, roofNear));
  }
  N = roofTiled;
}`,
        }
      : null,
};
