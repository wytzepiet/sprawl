import { Mesh, VertexBuffer, VertexData, type StandardMaterial } from "@babylonjs/core";
import type { DrawnPath } from "./drawnPath";
import { GRID_LINE } from "./terrainGeometry";

/**
 * The field: a ribbon a tile wide along the path the tractor is drawn
 * on, curves and all, painted flat like a map's farmland in one tone —
 * earth or green or gold or stubble — with the furrows, thin lanes a
 * shade darker, running lengthwise along the same path, so every field
 * carries the tractor's own curves. One mesh, section after section in
 * the order driven, at one height: the depth test lets an equal depth
 * through, so wherever the path crosses itself the later pass paints
 * over the earlier one, furrows and all, as a later pass does.
 * Between runs it is the farm's last run, whole, in the tone the run
 * left; on a run it is the run in progress in the tone the run leaves,
 * shown as far as the tractor has got, its frontier pulled back each
 * frame to where the tractor is, laid over the field as it was, so the
 * ground turns as the tractor passes. Only over the land and only where
 * the implement is down: never the lot or the lane, and never a tile
 * driven a second time, since the plough is lifted to turn and to
 * cross. A straight tile of it is one quad; a corner is the few the
 * rounded path has.
 */

export type RGB = [number, number, number];
/** A ribbon's lanes: from and to across the path, left to right, and
 *  how much of the tone each is painted in. */
type Lane = { from: number; to: number; shade: number };
/** The ground, then the furrows over it: a quarter tile apart, as wide
 *  as the map's grid lines, one centred on each edge of the tile; the
 *  ground is that half a line wider than the tile each side, so rows
 *  side by side overlap on the line they share and the field's outer
 *  edge carries a full one. */
const FURROW = GRID_LINE;
const FURROW_SHADE = 0.88;
const LANES: Lane[] = [{ from: -0.5 - FURROW / 2, to: 0.5 + FURROW / 2, shade: 1 }, ...[-0.5, -0.25, 0, 0.25, 0.5].map((at) => ({ from: at - FURROW / 2, to: at + FURROW / 2, shade: FURROW_SHADE }))];

export class Strip {
  private mesh: Mesh;
  private positions: Float32Array;
  private colors: Float32Array;
  /** The sections' centres and left-hand normals, as built. */
  private centres: [number, number][] = [];
  private normals: [number, number][] = [];
  /** Sections drawn whole: the frontier is the next. */
  private shown: number;

  constructor(material: StandardMaterial, private drawn: DrawnPath, land: (x: number, y: number) => boolean, private z: number, tone: RGB) {
    const lanes = LANES;
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
    const verts = n * lanes.length * 2;
    this.positions = new Float32Array(verts * 3);
    this.colors = new Float32Array(verts * 4);
    for (let i = 0; i < n; i++) this.section(i, this.centres[i], this.normals[i]);
    const normals: number[] = [], indices: number[] = [];
    for (let i = 0; i < verts; i++) normals.push(0, 0, 1);
    // The implement is down over the land the first time the tractor
    // enters a tile, and up on every later visit — the turns on the
    // headland, a crossing to the far side of the barn, the way home —
    // so nothing is painted but the work.
    const working: boolean[] = [];
    const seen = new Set<string>();
    let tile = "", down = false;
    for (let i = 0; i < n; i++) {
      const x = Math.floor(points[i].x), y = Math.floor(points[i].y);
      const key = `${x},${y}`;
      if (key !== tile) {
        tile = key;
        down = !seen.has(key) && land(x, y);
        seen.add(key);
      }
      working.push(down);
    }
    for (let i = 0; i + 1 < n; i++) {
      const painted = working[i] && working[i + 1];
      for (let l = 0; l < lanes.length; l++) {
        const [l0, r0] = this.vertex(i, l), [l1, r1] = this.vertex(i + 1, l);
        // A segment off the land keeps its place in the index buffer as
        // six of one vertex, nothing drawn, so the count shown still
        // counts segments. Clockwise seen from above, so the face is up.
        if (painted) indices.push(l0, r0, r1, l0, r1, l1);
        else indices.push(l0, l0, l0, l0, l0, l0);
      }
    }
    this.mesh = new Mesh("strip", material.getScene());
    const vd = new VertexData();
    vd.positions = this.positions;
    vd.normals = normals;
    vd.colors = this.colors;
    vd.indices = indices;
    vd.applyToMesh(this.mesh, true);
    this.mesh.material = material;
    this.mesh.isPickable = false;
    this.shown = n - 1;
    this.paint(tone);
  }

  /** The two vertex indices of section `i`, lane `l`: left and right. */
  private vertex(i: number, l: number): [number, number] {
    const v = (i * LANES.length + l) * 2;
    return [v, v + 1];
  }

  private section(i: number, [cx, cy]: [number, number], [nx, ny]: [number, number]): void {
    for (let l = 0; l < LANES.length; l++) {
      const { from, to } = LANES[l];
      const [left, right] = this.vertex(i, l);
      this.positions.set([cx + nx * from, cy + ny * from, this.z], left * 3);
      this.positions.set([cx + nx * to, cy + ny * to, this.z], right * 3);
    }
  }

  /** The whole strip in one tone, the furrows their shade of it. */
  paint([r, g, b]: RGB): void {
    for (let v = 0; v < this.colors.length / 4; v++) {
      const { shade } = LANES[Math.floor(v / 2) % LANES.length];
      this.colors.set([r * shade, g * shade, b * shade, 1], v * 4);
    }
    this.mesh.updateVerticesData(VertexBuffer.ColorKind, this.colors);
  }

  /** Show the strip as far as `dist` along the path. */
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
    this.mesh.subMeshes[0].indexCount = this.shown * LANES.length * 6;
  }

  dispose(): void {
    this.mesh.dispose();
  }
}
