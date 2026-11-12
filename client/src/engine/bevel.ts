import { markMaterialUboDirty, setMeshAttribute, type EngineContext, type MaterialPlugin, type Mesh, type PbrMaterial } from "./gpu";
import type { Bevelled } from "./creases";
export { bevelled } from "./creases";

/**
 * Rounded edges, in the shading alone. Every triangle is told which of its
 * three edges are creases that bend over (a ridge, an eave, a kerb's top)
 * and which way the face across each one faces; drawing it, a pixel near
 * such an edge turns its facing toward the halfway between the two faces,
 * all the way at the edge itself. Both faces reach the same halfway there,
 * so the light rolls round the crease as round a real bevel of that
 * radius — its shading and its glint — with no triangle added, and where
 * two creases meet at a corner each simply bends its own way.
 */

/** How far in from a crease the round reaches, in tiles. */
export const BEVEL = 0.05;

/** Hands a mesh the bevel's data, from `bevelled`: per vertex, the three
 *  facings across, whether each is a crease, and its distance from each. */
export function giveBevel(engine: EngineContext, mesh: Mesh, geo: Bevelled) {
  const n = geo.reach.length / 3;
  const data = new Float32Array(n * 15);
  for (let i = 0; i < n * 3; i++) {
    const to = Math.floor(i / 3) * 15 + (i % 3);
    for (let j = 0; j < 3; j++) data[to + j * 3] = geo.across[j][i];
    data[to + 9] = geo.reach[i];
    data[to + 12] = geo.at[i];
  }
  setMeshAttribute(engine, mesh, "bevel", data);
}

const ATTRIBUTES = ["bevelAcross0", "bevelAcross1", "bevelAcross2", "bevelReach", "bevelAt"];
const VARYINGS = ["vBevelAcross0", "vBevelAcross1", "vBevelAcross2", "vBevelReach", "vBevelAt"];

/** How round a material's creases are, in tiles, and its corners and eaves
 *  if softer than the rest. */
export type Bevel = { width: number; soft: number | null };

/** The bevel, on a town material whose meshes carry `giveBevel`'s data. */
export function bevelPlugin(bevel: Bevel = { width: BEVEL, soft: null }): MaterialPlugin {
  return {
    name: "Bevel",
    priority: 200,
    getAttributes: () => ATTRIBUTES.map((name) => ({ name, type: "vec3<f32>" as const, buffer: "bevel" })),
    getVaryings: () => VARYINGS.map((name) => ({ name, type: "vec3f" as const })),
    getUniforms: () => ({
      ubo: [
        { name: "bevelWidth", type: "f32" },
        { name: "bevelSoft", type: "f32" },
      ],
    }),
    writeUbo: (data, offsets) => {
      data[offsets.get("bevelWidth")! / 4] = bevel.width;
      data[offsets.get("bevelSoft")! / 4] = bevel.soft ?? bevel.width;
    },
    getCustomCode: (stage) =>
      stage === "vertex"
        ? {
            CUSTOM_VERTEX_MAIN_END: `let bevelWorld = mat3x3f(finalWorld[0].xyz, finalWorld[1].xyz, finalWorld[2].xyz);
out.vBevelAcross0 = normalize(bevelWorld * bevelAcross0);
out.vBevelAcross1 = normalize(bevelWorld * bevelAcross1);
out.vBevelAcross2 = normalize(bevelWorld * bevelAcross2);
out.vBevelReach = bevelReach;
out.vBevelAt = bevelAt;`,
          }
        : {
            CUSTOM_FRAGMENT_DEFINITIONS: `fn bevelTurn(n: vec3f, face: vec3f, across: vec3f, reach: f32, at: f32, width: f32, soft: f32) -> vec3f {
  if (reach <= 0.) { return n; }
  // A crease rising from a sloping face, a hip or a ridge, rounds as the
  // rest; a corner or an eave as softly as its material says.
  let round = select(soft, width, across.z > 0.05 && face.z > 0.15 && face.z < 0.97);
  if (round <= 0.) { return n; }
  let w = 1. - clamp(at * reach / round, 0., 1.);
  return normalize(mix(n, normalize(face + across), w));
}`,
            CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `let bevelFace = N;
N = bevelTurn(N, bevelFace, input.vBevelAcross0, input.vBevelReach.x, input.vBevelAt.x, material.bevelWidth, material.bevelSoft);
N = bevelTurn(N, bevelFace, input.vBevelAcross1, input.vBevelReach.y, input.vBevelAt.y, material.bevelWidth, material.bevelSoft);
N = bevelTurn(N, bevelFace, input.vBevelAcross2, input.vBevelReach.z, input.vBevelAt.z, material.bevelWidth, material.bevelSoft);`,
          },
  };
}

/** How lacquered each kind of thing is, as its roughness: cars glossy,
 *  buildings and rock a sheen, as fired tile and plaster and worn stone
 *  have, trees duller; and how round its creases are, if not as the rest,
 *  and its corners and eaves: a building's not at all, its edges as cut
 *  (a parapet's coping is narrower than any rounding would be); its hips
 *  still capped (`roofs.ts`), which reads the creases, not the rounding. */
const LACQUER: Record<string, readonly [number, number?, number?]> = {
  car: [0.3],
  building: [0.55, 0, 0],
  tree: [0.72],
  rock: [0.6],
};

/** A material lacquered as its kind is: its roughness, and its bevel's. */
export function lacquer<M extends PbrMaterial>(mat: M, kind: "car" | "building" | "tree" | "rock", bevel?: Bevel): M {
  const [roughness, round, soft] = LACQUER[kind];
  mat.roughnessFactor = roughness;
  if (bevel && round !== undefined) bevel.width = round;
  if (bevel && soft !== undefined) bevel.soft = soft;
  markMaterialUboDirty(mat);
  return mat;
}
