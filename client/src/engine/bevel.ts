import { markMaterialUboDirty, setMeshAttribute, type EngineContext, type MaterialPlugin, type Mesh, type PbrMaterialProps } from "@babylonjs/lite";
import type { MeshGeometry } from "./geometry";

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

/** Faces meeting at less than this many degrees make no crease. */
const MIN_ANGLE = 12;
/** How far in from a crease the round reaches, in tiles. */
export const BEVEL = 0.05;

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * `geo`, every triangle its own three vertices in order, with what the
 * bevel needs: up to three creases it lies by, each the facing across it
 * and each corner's distance from its line. A crease is an edge of its own,
 * or one of a triangle of the same face that touches one of its corners: a
 * face cut into long thin triangles still knows the crease along its edge
 * all the way up to it, not only in the triangles whose edge it is.
 */
export function bevelled(geo: MeshGeometry & { colors?: number[] }): MeshGeometry & { colors?: number[]; across: number[][]; reach: number[]; at: number[] } {
  const p = geo.positions;
  const at = (i: number): V3 => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  const key = (v: V3) => v.map((x) => Math.round(x * 1e4)).join(",");
  const tris: { v: V3[]; n: V3; c: V3; src: number[] }[] = [];
  const edges = new Map<string, number[]>();
  const edgeKey = (a: V3, b: V3) => { const [ka, kb] = [key(a), key(b)]; return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; };
  for (let t = 0; t < geo.indices.length; t += 3) {
    const src = [geo.indices[t], geo.indices[t + 1], geo.indices[t + 2]];
    const v = src.map(at);
    let n = unit(cross(sub(v[1], v[0]), sub(v[2], v[0])));
    if (geo.normals.length && dot(n, [geo.normals[src[0] * 3], geo.normals[src[0] * 3 + 1], geo.normals[src[0] * 3 + 2]]) < 0) n = [-n[0], -n[1], -n[2]];
    const c: V3 = [(v[0][0] + v[1][0] + v[2][0]) / 3, (v[0][1] + v[1][1] + v[2][1]) / 3, (v[0][2] + v[1][2] + v[2][2]) / 3];
    const ti = tris.push({ v, n, c, src }) - 1;
    for (let k = 0; k < 3; k++) {
      const e = edgeKey(v[(k + 1) % 3], v[(k + 2) % 3]);
      edges.set(e, [...(edges.get(e) ?? []), ti]);
    }
  }

  // Every triangle's own creases, and each filed by its two ends.
  interface Crease { a: V3; b: V3; across: V3; line: string }
  const cosMin = Math.cos((MIN_ANGLE * Math.PI) / 180);
  const own = tris.map((tri, ti): Crease[] => {
    const found: Crease[] = [];
    for (let k = 0; k < 3; k++) {
      const [a, b] = [tri.v[(k + 1) % 3], tri.v[(k + 2) % 3]];
      // Across the edge: the one other face, not counting one that faces
      // down — an eave also closes a roof from beneath, and that face is
      // never seen.
      const other = (edges.get(edgeKey(a, b)) ?? []).filter((x) => x !== ti && (tri.n[2] < -0.5 || tris[x].n[2] > -0.5));
      if (other.length !== 1) continue;
      const o = tris[other[0]];
      if (dot(tri.n, o.n) > cosMin) continue;
      // Over, not in: the other face lies below this one's plane.
      const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      if (dot(sub(o.c, mid), tri.n) > -1e-5) continue;
      found.push({ a, b, across: o.n, line: edgeKey(a, b) });
    }
    return found;
  });
  const byCorner = new Map<string, { crease: Crease; tri: number }[]>();
  own.forEach((list, ti) => {
    for (const crease of list) for (const end of [crease.a, crease.b]) byCorner.set(key(end), [...(byCorner.get(key(end)) ?? []), { crease, tri: ti }]);
  });
  /** A point's distance from the line through a and b. */
  const fromLine = (v: V3, a: V3, b: V3) => {
    const e = sub(b, a);
    return Math.hypot(...cross(e, sub(v, a))) / Math.hypot(...e);
  };

  const out = { positions: [] as number[], normals: [] as number[], indices: [] as number[], colors: geo.colors ? ([] as number[]) : undefined, uvs: geo.uvs ? ([] as number[]) : undefined, across: [[], [], []] as number[][], reach: [] as number[], at: [] as number[] };
  tris.forEach((tri, ti) => {
    // Its own creases first, then its face's that touch its corners.
    const mine: Crease[] = [...own[ti]];
    const plane = dot(tri.n, tri.v[0]);
    for (const corner of tri.v) {
      for (const { crease, tri: other } of byCorner.get(key(corner)) ?? []) {
        if (mine.length === 3) break;
        const o = tris[other];
        if (dot(o.n, tri.n) < 0.9999 || Math.abs(dot(tri.n, o.v[0]) - plane) > 1e-5) continue;
        if (!mine.some((m) => m.line === crease.line)) mine.push(crease);
      }
    }
    const across: V3[] = [0, 1, 2].map((j) => mine[j]?.across ?? tri.n);
    const reach: V3 = [0, 1, 2].map((j) => (mine[j] ? 1 : 0)) as V3;
    for (let k = 0; k < 3; k++) {
      const s = tri.src[k];
      out.positions.push(...tri.v[k]);
      // The mesh's own facing, which a rim already turns.
      out.normals.push(...(geo.normals.length ? [geo.normals[s * 3], geo.normals[s * 3 + 1], geo.normals[s * 3 + 2]] : tri.n));
      if (out.uvs) out.uvs.push(geo.uvs![s * 2], geo.uvs![s * 2 + 1]);
      if (out.colors) out.colors.push(geo.colors![s * 4], geo.colors![s * 4 + 1], geo.colors![s * 4 + 2], geo.colors![s * 4 + 3]);
      out.indices.push(ti * 3 + k);
      for (let j = 0; j < 3; j++) out.across[j].push(...across[j]);
      out.reach.push(...reach);
      // Its distance from each crease's line: the shader's `at * reach`.
      for (let j = 0; j < 3; j++) out.at.push(mine[j] ? fromLine(tri.v[k], mine[j].a, mine[j].b) : 0);
    }
  });
  return out;
}

/** Hands a mesh the bevel's data, from `bevelled`: per vertex, the three
 *  facings across, whether each is a crease, and its distance from each. */
export function giveBevel(engine: EngineContext, mesh: Mesh, geo: ReturnType<typeof bevelled>) {
  const n = geo.reach.length / 3;
  const data = new Float32Array(n * 15);
  for (let v = 0; v < n; v++) {
    for (let j = 0; j < 3; j++) data.set(geo.across[j].slice(v * 3, v * 3 + 3), v * 15 + j * 3);
    data.set(geo.reach.slice(v * 3, v * 3 + 3), v * 15 + 9);
    data.set(geo.at.slice(v * 3, v * 3 + 3), v * 15 + 12);
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
export function lacquer<M extends PbrMaterialProps>(mat: M, kind: "car" | "building" | "tree" | "rock", bevel?: Bevel): M {
  const [roughness, round, soft] = LACQUER[kind];
  mat.roughnessFactor = roughness;
  if (bevel && round !== undefined) bevel.width = round;
  if (bevel && soft !== undefined) bevel.soft = soft;
  markMaterialUboDirty(mat);
  return mat;
}
