import { addToScene, markMaterialUboDirty, setThinInstances, type MaterialPlugin, type Mesh } from "@babylonjs/lite";
import type { EngineContext } from "./Canvas";
import type { Casters } from "./DayNightCycle";
import type { Area } from "./cull";
import { drop, meshOf, slab, type P } from "./geometry";
import { setTint, townMaterial, type TownMaterial } from "./material";
import { PROP_FLOATS } from "./town/layer";
import { PROP_KINDS } from "./town/roof";
import { shownTimeOfDay } from "./DayNightCycle";
import { lamps, night } from "./lights";

/**
 * What stands on the town's roofs, drawn as props of their own, each part
 * one mesh of instances to a chunk, as its trees are: AC units, vents, a
 * restaurant's extract stack and its duct, a bar's satellite dish, a
 * shop's rooflight.
 * The roof says where (`town/roof.ts`); any roof may have them.
 *
 * Their round parts are cards, flat squares a shader makes round, as a
 * tree's crown is: a vent's cap a dome, lit as one; a dish a bowl; a
 * rooflight a clear dome; an AC unit's fan, its
 * housing's rim rolled over and its blades turning, each unit at a speed
 * and from a start of its own, by where it stands, through the working
 * day and still at night. The turning is the shader's, so a unit stands
 * still for the shadows.
 *
 * And the street lamps the dressing puts up (`town/dressing.ts`): a pole,
 * an arm out over the kerb, and a head that glows at night and is one of
 * the night's lights (`lights.ts`).
 */

/** A shape a unit across, standing a unit high from z = 0. */
const box = (ring: P[]) => slab(ring, [0, 0], 1, () => [0, 0], [0, 0]);
const SQUARE: P[] = [[0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [-0.5, -0.5]];
const ROUND: P[] = Array.from({ length: 8 }, (_, k): P => [0.5 * Math.cos((k / 8) * 2 * Math.PI), 0.5 * Math.sin((k / 8) * 2 * Math.PI)]);
/** A card: a square a unit across, a hair thick, faced up. */
const CARD = slab(SQUARE, [0, 0], 0.002, () => [0, 0], [0, 0]);

/** How rough painted steel is, and galvanised: both a sheen, the bare
 *  metal's harder. */
const PAINTED = 0.32;
const GALVANISED = 0.4;
/** An AC unit's fan, of the unit's side; a vent's stem, of its cap. */
const FAN = 0.74;
const STEM = 0.6;
/** Its blades, and how fast they turn, in turns a second, give or take. */
const BLADES = 5;
/** A grille wire's half-width, of the gap between wires; the metal's roughness. */
const GRILLE = 0.09;
const METAL = 0.28;
const [TURNS, TURNS_SPREAD] = [1.6, 0.8];
/** A street lamp: how tall, its pole's breadth, its arm's, and its head,
 *  long along the arm, broad and deep. */
const LAMP = { high: 0.28, pole: 0.022, arm: 0.012, head: [0.075, 0.036, 0.018] };
/** The head's glow at night, linear, before the eye's exposure: the
 *  lights' own warm colour, bright enough to burn near white. */
const GLOW = [1.6, 1.0, 0.5];

/** A lamp's head: lit as anything is, and glowing as the night comes on. */
const HEAD: MaterialPlugin = {
  name: "LampHead",
  priority: 220,
  getUniforms: () => ({ ubo: [{ name: "lampGlow", type: "f32" }] }),
  writeUbo: (data, offsets) => void (data[offsets.get("lampGlow")! / 4] = night.on),
  getCustomCode: (stage) =>
    stage === "fragment" ? { CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `color += vec3f(${GLOW.map((v) => v.toFixed(3)).join(", ")}) * material.lampGlow;` } : null,
};

/** The fans' turn so far, in turns at the middle speed: run up by the
 *  hour, so a fan slows and stops rather than jumping when it is switched
 *  off. Offices are cooled while they work: on from seven, off at seven,
 *  easing in and out over an hour or so. */
const fans = { turn: 0 };
const running = (t: number) => smooth(0.27, 0.31, t) * (1 - smooth(0.77, 0.81, t));
const smooth = (a: number, b: number, x: number) => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

/** Where on its card a pixel is, out from the middle to its edge at 1:
 *  the card's middle and breadth from its matrix, a varying each. */
const card = (name: string, fragment: string, uniforms = false): MaterialPlugin => ({
  name,
  priority: 220,
  getVaryings: () => [
    { name: "vPropMid", type: "vec3f" },
    { name: "vPropBroad", type: "f32" },
    { name: "vPropFacing", type: "vec2f" },
  ],
  ...(uniforms
    ? {
        getUniforms: () => ({ ubo: [{ name: "propTurn", type: "f32" }] }),
        writeUbo: (data: Float32Array, offsets: Map<string, number>) => void (data[offsets.get("propTurn")! / 4] = fans.turn),
      }
    : {}),
  getCustomCode: (stage) =>
    stage === "vertex"
      ? { CUSTOM_VERTEX_MAIN_END: "out.vPropMid = finalWorld[3].xyz;\nout.vPropBroad = length(finalWorld[0].xyz);\nout.vPropFacing = normalize(finalWorld[0].xy);" }
      : {
          CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `let propAt = (input.worldPos.xy - input.vPropMid.xy) / (0.5 * input.vPropBroad);
let propR = length(propAt);
if (propR > 1.) { discard; }
${fragment}`,
        },
});

/** A works' smoke: puffs from its stack's top, each rising, drifting off
 *  on the wind, growing and gone, one after another; only through the
 *  shift, seven to four, easing in and out. Each puff a card, shaded as a
 *  ball, its place in the stream its matrix's height (`placeProps`). */
const PUFFS = 5;
const smoke = { t: 0, on: 0 };
const shift = (t: number) => smooth(0.28, 0.3, t) * (1 - smooth(0.66, 0.68, t));
const RISE: MaterialPlugin = {
  name: "SmokeRise",
  priority: 210,
  getUniforms: () => ({ ubo: [{ name: "smokeT", type: "f32", visibility: "vertex" }, { name: "smokeOn", type: "f32", visibility: "vertex" }] }),
  writeUbo: (data, offsets) => {
    data[offsets.get("smokeT")! / 4] = smoke.t;
    data[offsets.get("smokeOn")! / 4] = smoke.on;
  },
  getCustomCode: (stage) =>
    stage === "vertex"
      ? {
          CUSTOM_VERTEX_UPDATE_WORLDPOS: `let puffK = length(finalWorld[2].xyz);
let puffSeed = fract(sin(dot(floor(finalWorld[3].xy * 50.), vec2f(12.9898, 78.233))) * 43758.5453);
let puffP = fract(material.smokeT * 0.22 + puffK / ${PUFFS}. + puffSeed);
let puffS = sin(puffP * 3.14159) * (0.5 + puffP) * material.smokeOn + 1e-4;
finalWorld = mat4x4f(finalWorld[0] * puffS, finalWorld[1] * puffS, finalWorld[2] / puffK, finalWorld[3] + vec4f(0.2 * puffP, 0.07 * puffP, 0.45 * puffP, 0.));`,
        }
      : null,
};
const PUFF = card(
  "PropPuff",
  `let puffRise = sqrt(max(1. - propR * propR, 0.));
N = normalize(vec3f(propAt * 0.9, puffRise + 0.1));
baseColor = vec3f(0.9);`,
);

/** A vent's cap: a low dome, lit as round, a shade darker at its lip. */
const VENT_CAP = card(
  "PropVent",
  `let ventRise = sqrt(max(1. - propR * propR, 0.));
N = normalize(vec3f(propAt * 0.85, ventRise + 0.15));
baseColor = vec3f(0.78) * mix(0.85, 1., ventRise);`,
);

/** A satellite dish: a pale bowl, lit as hollow, its rim rolled, and the
 *  head on its arm out in front of it, the way it faces. */
const DISH = card(
  "PropDish",
  `let dishAlong = dot(propAt, input.vPropFacing);
let dishRim = smoothstep(0.86, 0.92, propR);
var dishN = normalize(vec3f(-propAt * 0.55, 1.));
dishN = mix(dishN, normalize(vec3f(propAt / max(propR, 1e-3) * 0.8, 1.)), dishRim);
let dishHead = 1. - smoothstep(0.1, 0.15, length(propAt - input.vPropFacing * 0.42));
let dishArm = (1. - smoothstep(0.025, 0.045, abs(dot(propAt, vec2f(-input.vPropFacing.y, input.vPropFacing.x))))) * step(0., dishAlong) * step(dishAlong, 0.42);
N = normalize(mix(dishN, vec3f(0., 0., 1.), max(dishHead, dishArm)));
baseColor = mix(vec3f(0.84), vec3f(0.22), max(dishHead, dishArm * 0.8));`,
);

/** A rooflight's dome: clear plastic over the dark below, the sky in its
 *  curve and a glint off its top, a pale frame round it. */
const DOME = card(
  "PropDome",
  `let domeRise = sqrt(max(1. - propR * propR, 0.));
let domeFrame = smoothstep(0.84, 0.88, propR);
N = normalize(mix(vec3f(propAt * 0.9, domeRise + 0.1), vec3f(0., 0., 1.), domeFrame));
baseColor = mix(mix(vec3f(0.16, 0.2, 0.24), vec3f(0.55, 0.66, 0.74), pow(1. - domeRise, 2.)), vec3f(0.86), domeFrame);
roughness = mix(0.12, roughness, domeFrame);`,
);

/** An AC unit's fan, shaped by its facing as much as its colour: a rolled
 *  rim round a dark well; the blades turning in it, pitched and curved, so
 *  the light sweeps across them as they go; over them a grille of round
 *  wires, each with its thin line of light; a domed hub. The metal glossy,
 *  the well matte. Each unit its own speed and start, by a hash of where
 *  it stands. */
const FAN_CARD = card(
  "PropFan",
  `let fanSeed = fract(sin(dot(input.vPropMid.xy, vec2f(12.9898, 78.233))) * 43758.5453);
let fanTurn = material.propTurn * ${(2 * Math.PI).toFixed(4)} * (1. + ${(TURNS_SPREAD / TURNS).toFixed(4)} * (fanSeed - 0.5) * 2.) + fanSeed * 6.2832;
let fanA = fract((atan2(propAt.y, propAt.x) + fanTurn) * ${(BLADES / (2 * Math.PI)).toFixed(4)});
let fanOut = propAt / max(propR, 1e-3);
let fanAround = vec2f(-fanOut.y, fanOut.x);
let fanBlade = smoothstep(0., 0.06, fanA) * (1. - smoothstep(0.36, 0.44, fanA)) * smoothstep(0.2, 0.26, propR) * (1. - smoothstep(0.8, 0.84, propR));
let fanHub = 1. - smoothstep(0.18, 0.22, propR);
let fanRim = smoothstep(0.84, 0.88, propR);
// The grille: a round wire at every fifth of the way out.
let fanRing = fract(propR * 5.);
let fanAcross = select(fanRing, fanRing - 1., fanRing > 0.5) / ${GRILLE.toFixed(3)};
let fanWire = (1. - smoothstep(0.7, 1., abs(fanAcross))) * (1. - fanRim) * (1. - fanHub);
var fanN = vec3f(0., 0., 1.);
fanN = mix(fanN, normalize(vec3f(fanAround * (0.7 + 1.2 * (fanA - 0.2)), 1.)), fanBlade);
fanN = mix(fanN, normalize(vec3f(propAt / 0.2 * 0.9, 1.)), fanHub);
fanN = mix(fanN, normalize(vec3f(fanOut * clamp(fanAcross, -1., 1.) * 1.4, 1.)), fanWire);
fanN = mix(fanN, normalize(vec3f(fanOut * clamp((propR - 0.92) / 0.08, -1., 1.) * 0.9, 1.)), fanRim);
N = normalize(fanN);
var fanColour = mix(vec3f(0.05), vec3f(0.5), fanBlade);
fanColour = mix(fanColour, vec3f(0.66), max(fanWire, max(fanHub, fanRim)));
baseColor = fanColour;
roughness = mix(roughness, ${METAL.toFixed(3)}, max(max(fanBlade, fanWire), max(fanHub, fanRim)));`,
  true,
);

interface Kit {
  body: { ac: TownMaterial; vent: TownMaterial; duct: TownMaterial; frame: TownMaterial };
  fan: TownMaterial;
  cap: TownMaterial;
  dish: TownMaterial;
  dome: TownMaterial;
  pole: TownMaterial;
  head: TownMaterial;
  puff: TownMaterial;
}
const KITS = new WeakMap<object, Kit>();

/** The props' materials, one set for the town, and their clock. */
function kitOf(ctx: EngineContext): Kit {
  let kit = KITS.get(ctx.engine);
  if (kit) return kit;
  const shade = (m: TownMaterial, c: { r: number; g: number; b: number }) => (setTint(m, c), m);
  const grey = (m: TownMaterial, v: number) => shade(m, { r: v, g: v, b: v });
  /** Galvanised steel: metal, the sky in it and a hard glint. */
  const steel = (m: TownMaterial) => ((m.metallicFactor = 1), markMaterialUboDirty(m), m);
  kit = {
    body: {
      // Painted steel, glossy; galvanised steel; a frame's painted aluminium.
      ac: grey(townMaterial([], PAINTED), 0.74),
      vent: steel(grey(townMaterial([], GALVANISED), 0.7)),
      duct: steel(grey(townMaterial([], GALVANISED), 0.74)),
      frame: grey(townMaterial([], PAINTED), 0.86),
    },
    fan: townMaterial([FAN_CARD], 0.5),
    cap: steel(townMaterial([VENT_CAP], GALVANISED)),
    dish: townMaterial([DISH], PAINTED),
    dome: townMaterial([DOME], 0.6),
    // A lamp's pole painted a dark green-grey, its head pale.
    pole: shade(townMaterial([], PAINTED), { r: 0.22, g: 0.25, b: 0.24 }),
    head: grey(townMaterial([HEAD], PAINTED), 0.9),
    puff: townMaterial([RISE, PUFF], 1),
  };
  KITS.set(ctx.engine, kit);
  const { fan, head, puff } = kit;
  let last = performance.now();
  let glow = -1;
  ctx.beforeRender(() => {
    const now = performance.now();
    fans.turn = (fans.turn + ((now - last) / 1000) * TURNS * running(shownTimeOfDay())) % 3600;
    smoke.t = (smoke.t + (now - last) / 1000) % 3600;
    last = now;
    markMaterialUboDirty(fan);
    smoke.on = shift(shownTimeOfDay());
    markMaterialUboDirty(puff);
    if (night.on !== glow) markMaterialUboDirty(head), (glow = night.on);
  });
  return kit;
}

/** A chunk's props, placed: the meshes they are drawn with. */
export function placeProps(ctx: EngineContext, name: string, props: Float32Array, [ox, oy]: [number, number], area: Area, casters: Casters | undefined): Mesh[] {
  const count = props.length / PROP_FLOATS;
  if (!count) return [];
  const kit = kitOf(ctx);
  // Each part's instances: a matrix each, scaled to its size, at its spot.
  const part = (geo: ReturnType<typeof box>, material: TownMaterial, cast: boolean) => ({ geo, material, cast, m: [] as number[] });
  const parts = {
    acBody: part(box(SQUARE), kit.body.ac, true),
    acFan: part(CARD, kit.fan, false),
    ventStem: part(box(ROUND), kit.body.vent, true),
    ventCap: part(CARD, kit.cap, false),
    duct: part(box(SQUARE), kit.body.duct, true),
    dishStem: part(box(ROUND), kit.body.vent, true),
    dish: part(CARD, kit.dish, false),
    frame: part(box(SQUARE), kit.body.frame, true),
    dome: part(CARD, kit.dome, false),
    pole: part(box(ROUND), kit.pole, true),
    arm: part(box(SQUARE), kit.pole, true),
    head: part(box(SQUARE), kit.head, true),
    puff: part(CARD, kit.puff, false),
  };
  /** Each lamp's light: its head's place on the map, and a rank. */
  const heads: number[] = [];
  /** A matrix: its x axis (ax, ay), its y axis (bx, by), its height, at a spot. */
  const put = (out: number[], x: number, y: number, z: number, ax: number, ay: number, bx: number, by: number, sz: number) => out.push(ax, ay, 0, 0, bx, by, 0, 0, 0, 0, sz, 0, x, y, z, 1);
  const upright = (out: number[], x: number, y: number, z: number, s: number, sz: number) => put(out, x, y, z, s, 0, 0, s, sz);
  for (let i = 0; i < count; i++) {
    const [code, x, y, z, size, high, tx, ty] = props.subarray(i * PROP_FLOATS, (i + 1) * PROP_FLOATS);
    switch (PROP_KINDS[code]) {
      case "ac":
        upright(parts.acBody.m, x, y, z, size, high);
        upright(parts.acFan.m, x, y, z + high + 0.001, size * FAN, 1);
        break;
      case "vent":
      case "stack":
        upright(parts.ventStem.m, x, y, z, size * STEM, high);
        upright(parts.ventCap.m, x, y, z + high, size, 1);
        break;
      case "duct": {
        // Along the roof from (x, y) to (tx, ty), size broad, high tall.
        const [dx, dy] = [tx - x, ty - y];
        const length = Math.hypot(dx, dy) || 1;
        const [ux, uy] = [dx / length, dy / length];
        put(parts.duct.m, (x + tx) / 2, (y + ty) / 2, z, ux * length, uy * length, -uy * size, ux * size, high);
        break;
      }
      case "dish": {
        // On a short stand, its card turned the way it faces.
        const [dx, dy] = [tx - x, ty - y];
        const l = Math.hypot(dx, dy) || 1;
        upright(parts.dishStem.m, x, y, z, size * 0.25, high);
        put(parts.dish.m, x, y, z + high, (dx / l) * size, (dy / l) * size, (-dy / l) * size, (dx / l) * size, 1);
        break;
      }
      case "smoke":
        for (let k = 1; k <= PUFFS; k++) upright(parts.puff.m, x, y, z, size, k);
        break;
      case "rooflight":
        upright(parts.frame.m, x, y, z, size, high * 0.5);
        upright(parts.dome.m, x, y, z + high * 0.5, size * 0.86, 1);
        break;
      case "lamp": {
        // Up from (x, y), and out along the arm to its head at (tx, ty).
        const [dx, dy] = [tx - x, ty - y];
        const l = Math.hypot(dx, dy) || 1;
        const [ux, uy] = [dx / l, dy / l];
        const top = z + LAMP.high;
        upright(parts.pole.m, x, y, z, LAMP.pole, LAMP.high);
        put(parts.arm.m, (x + tx) / 2, (y + ty) / 2, top - LAMP.arm, ux * l, uy * l, -uy * LAMP.arm, ux * LAMP.arm, LAMP.arm);
        const [hl, hw, hd] = LAMP.head;
        put(parts.head.m, tx, ty, top - hd, ux * hl, uy * hl, -uy * hw, ux * hw, hd);
        const [wx, wy] = [ox + tx, oy + ty];
        heads.push(wx, wy, top - hd - 0.01, rank(wx, wy));
        break;
      }
    }
  }
  const meshes: Mesh[] = [];
  for (const [part, { geo, material, cast, m }] of Object.entries(parts)) {
    if (!m.length) continue;
    const mesh = meshOf(ctx.engine, `${name}_prop_${part}`, geo);
    mesh.material = material;
    mesh.receiveShadows = true;
    mesh.position.x = ox;
    mesh.position.y = oy;
    setThinInstances(mesh, new Float32Array(m), m.length / 16);
    ctx.cull.keep(mesh, area);
    addToScene(ctx.scene, mesh);
    if (cast) casters?.add(mesh);
    meshes.push(mesh);
  }
  if (heads.length) lamps.set(meshes, new Float32Array(heads));
  return meshes;
}

/** A lamp's rank among the lights, the same every time for where it stands. */
function rank(x: number, y: number) {
  let s = (Math.round(x * 100) * 374761393 + Math.round(y * 100) * 668265263) | 0;
  s = Math.imul(s ^ (s >>> 13), 1274126177);
  return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
}

/** A chunk's props gone. */
export function clearProps(ctx: EngineContext, meshes: Mesh[], casters: Casters | undefined) {
  lamps.delete(meshes);
  for (const mesh of meshes) {
    casters?.remove(mesh);
    ctx.cull.forget(mesh);
    drop(ctx.scene, mesh);
  }
}
