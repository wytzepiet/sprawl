import { Color3, Mesh, VertexBuffer, VertexData, type StandardMaterial } from "@babylonjs/core";
import type { InstancePool } from "../InstancePool";
import type { DrawnPath } from "./drawnPath";

/**
 * Tyre marks and the ploughed strip: ribbons along the path the tractor
 * is drawn on, curves and all, so they lie exactly under its wheels. The
 * marks are two faint stripes a wheel apart with nothing between, so
 * where two paths cross all four show; under the plough a strip a tile
 * wide in the field's colour, which is the ground turned brown. There is
 * no field but this: a field is where the plough has been.
 *
 * A ribbon is built whole and shown as far as the tractor has got: the
 * sections behind it as they are, the one ahead pulled back to where it
 * is, so the ribbon ends under the tractor and nothing is laid twice.
 */
export const RUT = Color3.FromHexString("#B49E5C");
export const FIELD = Color3.FromHexString("#C9B26A");
/** Half the track: how far each wheel runs from the path's centre. */
const TRACK = 0.13;
const STRIPE = 0.045;
const RUT_Z = 0.014;
const STRIP_Z = 0.011;

/** A ribbon's lanes: from and to, across the path, left to right. */
type Lanes = [number, number][];
const MARKS: Lanes = [[-TRACK - STRIPE / 2, -TRACK + STRIPE / 2], [TRACK - STRIPE / 2, TRACK + STRIPE / 2]];
const STRIP: Lanes = [[-0.5, 0.5]];

class Ribbon {
  private mesh: Mesh;
  private positions: Float32Array;
  /** The sections' centres and left-hand normals, as built. */
  private centres: [number, number][] = [];
  private normals: [number, number][] = [];
  /** Sections drawn whole: the frontier is the next. */
  private shown: number;

  constructor(material: StandardMaterial, private drawn: DrawnPath, private lanes: Lanes, private z: number) {
    const { points } = drawn;
    const n = points.length;
    for (let i = 0; i < n; i++) {
      let tx = 0, ty = 0;
      for (const [a, b] of [[i - 1, i], [i, i + 1]]) {
        if (a < 0 || b >= n) continue;
        const dx = points[b].x - points[a].x, dy = points[b].y - points[a].y;
        const len = Math.hypot(dx, dy) || 1;
        tx += dx / len; ty += dy / len;
      }
      const len = Math.hypot(tx, ty) || 1;
      this.centres.push([points[i].x, points[i].y]);
      this.normals.push([-ty / len, tx / len]);
    }
    this.positions = new Float32Array(n * lanes.length * 6);
    for (let i = 0; i < n; i++) this.section(i, this.centres[i], this.normals[i]);
    const normals: number[] = [], indices: number[] = [];
    for (let i = 0; i < n * lanes.length * 2; i++) normals.push(0, 0, 1);
    for (let i = 0; i + 1 < n; i++) {
      for (let l = 0; l < lanes.length; l++) {
        const [l0, r0] = this.vertex(i, l), [l1, r1] = this.vertex(i + 1, l);
        // Clockwise seen from above, as the lots' slabs are, so the face
        // is up: the normal runs left, so the quad's turn is the reverse
        // of one laid out along x and y.
        indices.push(l0, r0, r1, l0, r1, l1);
      }
    }
    this.mesh = new Mesh("ruts", material.getScene());
    const vd = new VertexData();
    vd.positions = this.positions;
    vd.normals = normals;
    vd.indices = indices;
    vd.applyToMesh(this.mesh, true);
    this.mesh.material = material;
    this.mesh.isPickable = false;
    this.mesh.receiveShadows = true;
    this.shown = n - 1;
  }

  /** The two vertex indices of section `i`, lane `l`: left and right. */
  private vertex(i: number, l: number): [number, number] {
    const v = (i * this.lanes.length + l) * 2;
    return [v, v + 1];
  }

  private section(i: number, [cx, cy]: [number, number], [nx, ny]: [number, number]): void {
    for (let l = 0; l < this.lanes.length; l++) {
      const [from, to] = this.lanes[l];
      const [left, right] = this.vertex(i, l);
      this.positions.set([cx + nx * from, cy + ny * from, this.z], left * 3);
      this.positions.set([cx + nx * to, cy + ny * to, this.z], right * 3);
    }
  }

  /** Show the ribbon as far as `dist` along the path. */
  reach(dist: number): void {
    const { distances, path, length } = this.drawn;
    const last = distances.length - 1;
    // The sections behind the tractor, whole; the section at its frontier
    // pulled back to where it is; the one that was the frontier before,
    // put back where it belongs.
    let n = Math.min(this.shown, last - 1);
    while (n < last && distances[n + 1] <= dist) n++;
    while (n > 0 && distances[n] > dist) n--;
    this.section(this.shown, this.centres[this.shown], this.normals[this.shown]);
    if (n < last) {
      const p = path.getPointAt(dist / length);
      const t = path.getTangentAt(dist / length);
      const len = Math.hypot(t.x, t.y) || 1;
      this.section(n + 1, [p.x, p.y], [-t.y / len, t.x / len]);
    }
    this.shown = Math.min(n + 1, last);
    this.mesh.updateVerticesData(VertexBuffer.PositionKind, this.positions);
    this.mesh.subMeshes[0].indexCount = this.shown * this.lanes.length * 6;
  }

  dispose(): void {
    this.mesh.dispose();
  }
}

/** The marks along a path, and under the plough the strip too. Whole
 *  until told how far the tractor has got. */
export class Trail {
  private ribbons: Ribbon[];

  constructor(pool: InstancePool, drawn: DrawnPath, strip: boolean) {
    this.ribbons = [new Ribbon(pool.material("rut", RUT), drawn, MARKS, RUT_Z)];
    if (strip) this.ribbons.push(new Ribbon(pool.material("strip", FIELD), drawn, STRIP, STRIP_Z));
  }

  reach(dist: number): void {
    for (const r of this.ribbons) r.reach(dist);
  }

  dispose(): void {
    for (const r of this.ribbons) r.dispose();
  }
}
