import type { MeshGeometry } from "../Mesh";
import { builder, gabled, ring, roundedRect, ROOF, WALL, type Outline } from "../objects/buildings";
import type { Role, Shape } from "./svg";

/**
 * A drawing raised into solids, one role at a time, since a role is one
 * colour and so one bucket.
 *
 * The drawing is top-down on the screen and the world is not: the screen's
 * right is the world's -x and its down the world's -y, so a point comes
 * across turned half round about the tile's middle. A mirrored piece is
 * flipped left to right first.
 *
 * What each role becomes:
 * - `roof`: walls, then a roof. A rect gets a gable along its long side, so
 *   rects laid end to end are one ridge; any other outline, a hip to its
 *   middle.
 * - `wall`: straight up to its height and flat on top.
 * - `tree`, `lamp`: a round post, a crown or a light.
 * - `garden`, `pavement`, `water`, `marking`: flat, at their own height over
 *   the ground, so the ink finds their edge.
 */
const FLAT: Partial<Record<Role, number>> = { water: 0.005, garden: 0.01, pavement: 0.02, marking: 0.033 };
const TALL: Partial<Record<Role, number>> = { roof: WALL.house, wall: WALL.house, tree: 0.4, lamp: 0.45 };

export const SOLID_ROLES = new Set<Role>(["roof", "wall", "tree", "lamp"]);

export function raise(shapes: Shape[], role: Role, mirror: boolean): MeshGeometry {
  const b = builder();
  const out: MeshGeometry = { positions: [], normals: [], indices: [] };
  const at = (x: number, y: number): [number, number] => [(mirror ? 1 - x : x) - 0.5, y - 0.5].map((v) => -v) as [number, number];
  const outline = (s: Shape): Outline => {
    switch (s.kind) {
      case "rect": {
        const [cx, cy] = at(s.x + s.w / 2, s.y + s.d / 2);
        return roundedRect(s.w, s.d, s.r, s.r ? 5 : 0).map(([x, y]) => [cx + x, cy + y]);
      }
      case "circle": return ring(role === "lamp" ? 6 : 8, s.r, ...at(s.x, s.y));
      case "polygon": return anticlockwise(s.points.map(([x, y]) => at(x, y)));
    }
  };
  for (const s of shapes) {
    if (s.role !== role) continue;
    const flat = FLAT[role];
    const h = s.h ?? TALL[role]!;
    if (flat !== undefined) b.cap(outline(s), flat);
    else if (role === "roof" && s.kind === "rect") {
      const [cx, cy] = at(s.x + s.w / 2, s.y + s.d / 2);
      append(out, gabled(s.w, s.d, h, ROOF.house, s.r), cx, cy);
    } else if (role === "roof") hip(b, outline(s), h, ROOF.house);
    else {
      const o = outline(s);
      b.sides(o, 0, h);
      b.cap(o, h);
    }
  }
  append(out, b.done(), 0, 0);
  return out;
}

/** Walls round a convex outline to `wall`, then a roof from every eave up to
 *  a point over its middle. */
function hip(b: ReturnType<typeof builder>, o: Outline, wall: number, roof: number) {
  b.sides(o, 0, wall);
  const [mx, my] = o.reduce(([sx, sy], [x, y]) => [sx + x / o.length, sy + y / o.length], [0, 0]);
  for (let i = 0; i < o.length; i++) {
    const [p, q] = [o[i], o[(i + 1) % o.length]];
    const u = [q[0] - p[0], q[1] - p[1], 0];
    const v = [mx - p[0], my - p[1], roof];
    const n: [number, number, number] = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n);
    b.tri([p[0], p[1], wall], [q[0], q[1], wall], [mx, my, wall + roof], [n[0] / len, n[1] / len, n[2] / len]);
  }
}

/** The builder's sides face out only round an anticlockwise outline, and a
 *  drawing may go either way; a mirror turns it round besides. */
function anticlockwise(o: Outline): Outline {
  const area = o.reduce((a, [x, y], i) => a + x * o[(i + 1) % o.length][1] - o[(i + 1) % o.length][0] * y, 0);
  return area < 0 ? [...o].reverse() : o;
}

function append(to: MeshGeometry, g: MeshGeometry, dx: number, dy: number) {
  const base = to.positions.length / 3;
  for (let i = 0; i < g.positions.length; i += 3) to.positions.push(g.positions[i] + dx, g.positions[i + 1] + dy, g.positions[i + 2]);
  to.normals.push(...g.normals);
  to.indices.push(...g.indices.map((i) => i + base));
}
