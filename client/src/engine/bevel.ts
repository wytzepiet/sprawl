import { Color3, MaterialDefines, MaterialPluginBase, type Material, type Mesh, type StandardMaterial } from "@babylonjs/core";
import type { MeshGeometry } from "./Mesh";

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
 * `geo`, every triangle its own three vertices in order (so a vertex's
 * place in its triangle is its index mod three), with what the bevel
 * needs: for each corner, the facing across the edge opposite it, and that
 * edge's distance from it if it is a crease (0 if not).
 */
export function bevelled(geo: MeshGeometry & { colors?: number[] }): MeshGeometry & { colors?: number[]; across: number[][]; reach: number[] } {
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

  const cosMin = Math.cos((MIN_ANGLE * Math.PI) / 180);
  const out = { positions: [] as number[], normals: [] as number[], indices: [] as number[], colors: geo.colors ? ([] as number[]) : undefined, uvs: geo.uvs ? ([] as number[]) : undefined, across: [[], [], []] as number[][], reach: [] as number[] };
  tris.forEach((tri, ti) => {
    const across: V3[] = [tri.n, tri.n, tri.n];
    const reach: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const [a, b] = [tri.v[(k + 1) % 3], tri.v[(k + 2) % 3]];
      // Across the edge: the one other face, not counting one that faces
      // down — an eave also closes a roof from beneath, and that face is
      // never seen.
      const other = (edges.get(edgeKey(a, b)) ?? []).filter((x) => x !== ti && (tri.n[2] < -0.5 || tris[x].n[2] > -0.5));
      const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      if (other.length !== 1) continue;
      const o = tris[other[0]];
      if (dot(tri.n, o.n) > cosMin) continue;
      // Over, not in: the other face lies below this one's plane.
      if (dot(sub(o.c, mid), tri.n) > -1e-5) continue;
      across[k] = o.n;
      // The corner's distance from the edge across it: where the round is
      // measured from, inside the triangle.
      const e = sub(b, a);
      reach[k] = Math.hypot(...cross(e, sub(tri.v[k], a))) / Math.hypot(...e);
    }
    for (let k = 0; k < 3; k++) {
      const s = tri.src[k];
      out.positions.push(...tri.v[k]);
      // The mesh's own facing, which a rim already turns.
      out.normals.push(...(geo.normals.length ? [geo.normals[s * 3], geo.normals[s * 3 + 1], geo.normals[s * 3 + 2]] : tri.n));
      if (out.uvs) out.uvs.push(geo.uvs![s * 2], geo.uvs![s * 2 + 1]);
      if (out.colors) out.colors.push(geo.colors![s * 4], geo.colors![s * 4 + 1], geo.colors![s * 4 + 2], geo.colors![s * 4 + 3]);
      out.indices.push(ti * 3 + k);
      for (let j = 0; j < 3; j++) out.across[j].push(...across[j]);
    }
    for (let k = 0; k < 3; k++) out.reach.push(...reach);
  });
  return out;
}

/** Hands a mesh the bevel's data, from `bevelled`. */
export function giveBevel(mesh: Mesh, geo: ReturnType<typeof bevelled>) {
  geo.across.forEach((a, j) => mesh.setVerticesData(`bevelAcross${j}`, a, false, 3));
  mesh.setVerticesData("bevelReach", geo.reach, false, 3);
}

class BevelDefines extends MaterialDefines {
  BEVEL = false;
}

const VERTEX_GLSL = {
  CUSTOM_VERTEX_DEFINITIONS: `#ifdef BEVEL
attribute vec3 bevelAcross0; attribute vec3 bevelAcross1; attribute vec3 bevelAcross2; attribute vec3 bevelReach;
varying vec3 vBevelAt; varying vec3 vBevelAcross0; varying vec3 vBevelAcross1; varying vec3 vBevelAcross2; varying vec3 vBevelReach;
#endif`,
  CUSTOM_VERTEX_MAIN_END: `#ifdef BEVEL
float bevelCorner = mod(float(gl_VertexID), 3.);
vBevelAt = bevelCorner == 0. ? vec3(1., 0., 0.) : bevelCorner == 1. ? vec3(0., 1., 0.) : vec3(0., 0., 1.);
mat3 bevelWorld = mat3(finalWorld);
vBevelAcross0 = normalize(bevelWorld * bevelAcross0); vBevelAcross1 = normalize(bevelWorld * bevelAcross1); vBevelAcross2 = normalize(bevelWorld * bevelAcross2);
vBevelReach = bevelReach;
#endif`,
};
const FRAGMENT_GLSL = {
  CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef BEVEL
varying vec3 vBevelAt; varying vec3 vBevelAcross0; varying vec3 vBevelAcross1; varying vec3 vBevelAcross2; varying vec3 vBevelReach;
vec3 bevelTurn(vec3 n, vec3 face, vec3 across, float reach, float at) {
  if (reach <= 0.) return n;
  // A crease rising from a sloping face, a hip or a ridge, rounds as the
  // rest; a corner or an eave as softly as its material says.
  float width = across.z > 0.05 && face.z > 0.15 && face.z < 0.97 ? bevelWidth : bevelSoft;
  float w = 1. - clamp(at * reach / width, 0., 1.);
  return normalize(mix(n, normalize(face + across), w));
}
#endif`,
  CUSTOM_FRAGMENT_BEFORE_LIGHTS: `#ifdef BEVEL
vec3 bevelFace = normalW;
normalW = bevelTurn(normalW, bevelFace, vBevelAcross0, vBevelReach.x, vBevelAt.x);
normalW = bevelTurn(normalW, bevelFace, vBevelAcross1, vBevelReach.y, vBevelAt.y);
normalW = bevelTurn(normalW, bevelFace, vBevelAcross2, vBevelReach.z, vBevelAt.z);
#endif`,
};
const VERTEX_WGSL = {
  CUSTOM_VERTEX_DEFINITIONS: `#ifdef BEVEL
attribute bevelAcross0: vec3f; attribute bevelAcross1: vec3f; attribute bevelAcross2: vec3f; attribute bevelReach: vec3f;
varying vBevelAt: vec3f; varying vBevelAcross0: vec3f; varying vBevelAcross1: vec3f; varying vBevelAcross2: vec3f; varying vBevelReach: vec3f;
#endif`,
  CUSTOM_VERTEX_MAIN_END: `#ifdef BEVEL
var bevelCorner = f32(input.vertexIndex) % 3.;
vertexOutputs.vBevelAt = select(select(vec3f(0., 0., 1.), vec3f(0., 1., 0.), bevelCorner == 1.), vec3f(1., 0., 0.), bevelCorner == 0.);
var bevelWorld = mat3x3f(finalWorld[0].xyz, finalWorld[1].xyz, finalWorld[2].xyz);
vertexOutputs.vBevelAcross0 = normalize(bevelWorld * vertexInputs.bevelAcross0);
vertexOutputs.vBevelAcross1 = normalize(bevelWorld * vertexInputs.bevelAcross1);
vertexOutputs.vBevelAcross2 = normalize(bevelWorld * vertexInputs.bevelAcross2);
vertexOutputs.vBevelReach = vertexInputs.bevelReach;
#endif`,
};
const FRAGMENT_WGSL = {
  CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef BEVEL
varying vBevelAt: vec3f; varying vBevelAcross0: vec3f; varying vBevelAcross1: vec3f; varying vBevelAcross2: vec3f; varying vBevelReach: vec3f;
fn bevelTurn(n: vec3f, face: vec3f, across: vec3f, reach: f32, at: f32) -> vec3f {
  if (reach <= 0.) { return n; }
  // A crease rising from a sloping face, a hip or a ridge, rounds as the
  // rest; a corner or an eave as softly as its material says.
  let width = select(uniforms.bevelSoft, uniforms.bevelWidth, across.z > 0.05 && face.z > 0.15 && face.z < 0.97);
  let w = 1. - clamp(at * reach / width, 0., 1.);
  return normalize(mix(n, normalize(face + across), w));
}
#endif`,
  CUSTOM_FRAGMENT_BEFORE_LIGHTS: `#ifdef BEVEL
let bevelFace = normalW;
normalW = bevelTurn(normalW, bevelFace, fragmentInputs.vBevelAcross0, fragmentInputs.vBevelReach.x, fragmentInputs.vBevelAt.x);
normalW = bevelTurn(normalW, bevelFace, fragmentInputs.vBevelAcross1, fragmentInputs.vBevelReach.y, fragmentInputs.vBevelAt.y);
normalW = bevelTurn(normalW, bevelFace, fragmentInputs.vBevelAcross2, fragmentInputs.vBevelReach.z, fragmentInputs.vBevelAt.z);
#endif`,
};

/** The bevel, on a standard material whose meshes carry `giveBevel`'s data. */
export class BevelPlugin extends MaterialPluginBase {
  width = BEVEL;
  /** How far its corners and eaves round, if softer than the rest. */
  soft: number | null = null;

  constructor(material: Material) {
    super(material, "Bevel", 200, new BevelDefines());
    this._enable(true);
  }

  isCompatible() {
    return true;
  }

  prepareDefines(defines: BevelDefines) {
    defines.BEVEL = true;
  }

  getAttributes(attributes: string[]) {
    attributes.push("bevelAcross0", "bevelAcross1", "bevelAcross2", "bevelReach");
  }

  getUniforms(shaderLanguage = 0) {
    return {
      ubo: [
        { name: "bevelWidth", size: 1, type: "float" },
        { name: "bevelSoft", size: 1, type: "float" },
      ],
      fragment: shaderLanguage === 1 ? "uniform bevelWidth: f32; uniform bevelSoft: f32;" : "uniform float bevelWidth; uniform float bevelSoft;",
    };
  }

  bindForSubMesh(ubo: { updateFloat(name: string, v: number): void }) {
    ubo.updateFloat("bevelWidth", this.width);
    ubo.updateFloat("bevelSoft", this.soft ?? this.width);
  }

  getClassName() {
    return "BevelPlugin";
  }

  getCustomCode(shaderType: string, shaderLanguage = 0) {
    const wgsl = shaderLanguage === 1;
    return shaderType === "vertex" ? (wgsl ? VERTEX_WGSL : VERTEX_GLSL) : wgsl ? FRAGMENT_WGSL : FRAGMENT_GLSL;
  }
}

/** How lacquered each kind of thing is, its glint's strength and its
 *  tightness: cars glossy, buildings and trees a sheen, as fired tile
 *  and plaster have; and how round its creases are, if not as the rest,
 *  and its corners and eaves: a building's hips crisp under their capping
 *  tiles (`roofs.ts`), its square corners softened by the light alone. */
const LACQUER: Record<string, readonly [number, number, number?, number?]> = {
  car: [0.7, 72],
  building: [0.12, 32, 0.015, 0.06],
  tree: [0.07, 40],
  rock: [0.12, 28],
};

/** A material lacquered as its kind is. */
export function lacquer(mat: StandardMaterial, kind: "car" | "building" | "tree" | "rock"): StandardMaterial {
  const [strength, power, round, soft] = LACQUER[kind];
  mat.specularColor = new Color3(strength, strength, strength);
  mat.specularPower = power;
  const bevel = mat.pluginManager?.getPlugin<BevelPlugin>("Bevel");
  if (bevel && round !== undefined) bevel.width = round;
  if (bevel && soft !== undefined) bevel.soft = soft;
  return mat;
}
