import type { MeshGeometry } from "../Mesh";
import type { BuildingKind } from "../../generated";
import { BLUEPRINTS } from "../../blueprints";

/** Buildings themselves stay neutral — the pin says what one is. */
export const BUILDING_COLOR = "#EFEDE8";

/** Margin from the plot edge, which is what leaves the category tint visible. */
export const PLOT_MARGIN = 0.15;
export const BUILDING_SIZE = 1.0 - 2 * PLOT_MARGIN;

/**
 * The slab a building with a lot stands on: one sheet of asphalt over the
 * whole plot, set in from its edge so the land shows round it, with the
 * street's kerb round that and corners rounded so a diagonal road passing
 * the corner only grazes the kerb. Heights keep it under the road.
 */
export const SLAB = { inset: 0.1, kerb: 0.04, radius: 0.13, z: 0.01, kerbZ: 0.008 };

/**
 * Shapes are built face by face, each with the outward normal it should have.
 *
 * Babylon culls back faces, and which side is "front" depends on the winding of
 * the indices — a rule that is easy to get subtly wrong per face and invisible
 * when you do, because a wrongly wound face is not drawn wrong, it is not drawn
 * at all. So it is enforced here rather than reasoned about at each face: given
 * the normal a face should have, the winding is chosen to match. Any outline
 * works after that — a rectangle, an octagon, an L.
 *
 * Shapes are built to the plot they will stand on rather than to a unit square
 * stretched afterwards. Stretching is cheaper, but it turns a round chimney into
 * an ellipse and makes a wide building's roof bays wider than a narrow one's.
 */
type Vec3 = [number, number, number];
type Point = [number, number];
type Outline = Point[];

/** A rectangle, corner to corner. */
function rect(fw: number, fh: number): Outline {
  const [x, y] = [fw / 2, fh / 2];
  return [
    [-x, -y],
    [x, -y],
    [x, y],
    [-x, y],
  ];
}

/** A regular ring. Eight sides reads as round from above; three is a wedge. */
function ring(sides: number, r: number, cx = 0, cy = 0): Outline {
  return Array.from({ length: sides }, (_, i) => {
    const a = (i / sides) * Math.PI * 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as Point;
  });
}

function builder() {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (u: Vec3, v: Vec3): Vec3 => [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];

  /**
   * One triangle, wound so it faces the way `n` says. Babylon's front face is
   * the one whose vertex cross product runs *against* the outward normal, so
   * that is the test: if it agrees, the triangle is inside out and two of its
   * corners swap.
   */
  const tri = (a: Vec3, b: Vec3, c: Vec3, n: Vec3) => {
    const g = cross(sub(b, a), sub(c, a));
    const [p, q, r] = g[0] * n[0] + g[1] * n[1] + g[2] * n[2] > 0 ? [a, c, b] : [a, b, c];
    const base = positions.length / 3;
    for (const v of [p, q, r]) {
      positions.push(...v);
      normals.push(...n);
    }
    indices.push(base, base + 1, base + 2);
  };

  return {
    tri,
    quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, n: Vec3) {
      tri(a, b, c, n);
      tri(a, c, d, n);
    },
    /** Straight sides from an outline, between two heights. */
    sides(outline: Outline, from: number, to: number) {
      for (let i = 0; i < outline.length; i++) {
        const c = outline[i];
        const x = outline[(i + 1) % outline.length];
        const [dx, dy] = [x[0] - c[0], x[1] - c[1]];
        const len = Math.hypot(dx, dy) || 1;
        this.quad(
          [c[0], c[1], from],
          [x[0], x[1], from],
          [x[0], x[1], to],
          [c[0], c[1], to],
          [dy / len, -dx / len, 0],
        );
      }
    },
    /** A flat lid over an outline, as a fan. */
    cap(outline: Outline, z: number) {
      for (let i = 1; i < outline.length - 1; i++) {
        this.tri(
          [outline[0][0], outline[0][1], z],
          [outline[i][0], outline[i][1], z],
          [outline[i + 1][0], outline[i + 1][1], z],
          [0, 0, 1],
        );
      }
    },
    done: (): MeshGeometry => ({ positions, indices, normals }),
  };
}

/**
 * Every dimension below is absolute, in tiles, and none of them depend on the
 * plot. A chimney is a chimney whether it stands on a small shed or a long one;
 * a roof bay is the same depth either way, and a wide shed simply gets more of
 * them. Only the outline follows the plot.
 */
const WALL = { house: 0.3, factory: 0.34 };
const ROOF = { house: 0.28, factory: 0.24 };
/** Depth of one sawtooth bay, across the roof. Wide enough to read as teeth
 *  from above rather than as corrugation. */
const BAY = 0.4;
/** The chimney: radius, how far its centre sits in from the corner, and how far
 *  it stands above the ridge. */
const STACK = { radius: 0.1, inset: 0.22, rise: 0.55 };

/**
 * A roof needs to know which way its ridge runs and which way it repeats.
 *
 * A house's ridge follows the long side, the way a terrace does. A factory's
 * runs the short way, so the bays step along the length and a long shed gets a
 * whole row of teeth rather than two enormous ones. On a square plot the two
 * agree and the building's own facing settles it instead.
 */
function axes(fw: number, fh: number, ridge: "long" | "short") {
  const flip = ridge === "long" ? fh > fw : fw > fh;
  return {
    /** Length of the ridge, and the width it repeats across. */
    run: flip ? fh : fw,
    across: flip ? fw : fh,
    /** Local (along, across, z) to world. */
    at: (a: number, c: number, z: number): Vec3 => (flip ? [c, a, z] : [a, c, z]),
    /** Local normal to world. */
    n: (a: number, c: number, z: number): Vec3 => (flip ? [c, a, z] : [a, c, z]),
  };
}

/** A rectangle with its corners rounded, corner to corner. */
function roundedRect(fw: number, fh: number, r: number, segments = 5): Outline {
  const [x, y] = [fw / 2 - r, fh / 2 - r];
  const out: Outline = [];
  const corners: [number, number, number][] = [[x, y, 0], [-x, y, Math.PI / 2], [-x, -y, Math.PI], [x, -y, (3 * Math.PI) / 2]];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= segments; i++) {
      const a = a0 + (i / segments) * (Math.PI / 2);
      out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return out;
}

/** The slab under a plot w by h tiles, or its kerb: a flat rounded sheet. */
export function slabGeometry(w: number, h: number, kerb: boolean): MeshGeometry {
  const grow = kerb ? SLAB.kerb : 0;
  const b = builder();
  b.cap(roundedRect(w - 2 * SLAB.inset + 2 * grow, h - 2 * SLAB.inset + 2 * grow, SLAB.radius + grow), 0);
  return b.done();
}

/** Walls straight up from an outline, capped flat. Boxes and towers. */
function prism(outline: Outline, height: number): MeshGeometry {
  const b = builder();
  b.sides(outline, 0, height);
  b.cap(outline, height);
  return b.done();
}

/**
 * Walls to `wall`, then a ridge along the long side at `wall + roof`. What makes
 * a house read as a house from directly above is two lit slopes meeting in a
 * line, so the roof is worth more of the height than it looks.
 */
function gabled(fw: number, fh: number, wall = WALL.house, roof = ROOF.house): MeshGeometry {
  const b = builder();
  const f = axes(fw, fh, "long");
  const [l, w] = [f.run / 2, f.across / 2];
  const peak = wall + roof;
  const slope = Math.hypot(roof, w);
  const up: Point = [roof / slope, w / slope];

  b.sides(rect(fw, fh), 0, wall);
  b.quad(f.at(-l, w, wall), f.at(l, w, wall), f.at(l, 0, peak), f.at(-l, 0, peak), f.n(0, up[0], up[1]));
  b.quad(f.at(-l, -w, wall), f.at(l, -w, wall), f.at(l, 0, peak), f.at(-l, 0, peak), f.n(0, -up[0], up[1]));
  b.tri(f.at(l, -w, wall), f.at(l, w, wall), f.at(l, 0, peak), f.n(1, 0, 0));
  b.tri(f.at(-l, -w, wall), f.at(-l, w, wall), f.at(-l, 0, peak), f.n(-1, 0, 0));
  return b.done();
}

/**
 * A shed roof in repeating bays — the north-light sawtooth every factory built
 * before fluorescent lighting has, and the reason one reads as a factory from
 * above at a glance. Each ridge spans the shed's short way and the bays step
 * along its length, so a long factory shows a row of teeth. The chimney is
 * round, and is what settles it.
 */
function sawtooth(fw: number, fh: number): MeshGeometry {
  const b = builder();
  const [wall, roof] = [WALL.factory, ROOF.factory];
  const f = axes(fw, fh, "short");
  const [l, w] = [f.run / 2, f.across / 2];
  const peak = wall + roof;
  // A longer shed gets more bays, not deeper ones, so every factory has the
  // same pitch and the same rhythm however big its plot.
  const bays = Math.max(2, Math.round(f.across / BAY));
  const step = f.across / bays;
  const slope = Math.hypot(roof, step);

  b.sides(rect(fw, fh), 0, wall);

  for (let i = 0; i < bays; i++) {
    const c0 = -w + i * step;
    const c1 = c0 + step;
    // The lit slope, climbing away from the drop before it.
    b.quad(
      f.at(-l, c0, wall), f.at(l, c0, wall), f.at(l, c1, peak), f.at(-l, c1, peak),
      f.n(0, -roof / slope, step / slope),
    );
    // The glazed face, dropping straight back down.
    b.quad(
      f.at(-l, c1, wall), f.at(l, c1, wall), f.at(l, c1, peak), f.at(-l, c1, peak),
      f.n(0, 1, 0),
    );
    // And the sawtooth profile showing on each end wall.
    b.tri(f.at(l, c0, wall), f.at(l, c1, wall), f.at(l, c1, peak), f.n(1, 0, 0));
    b.tri(f.at(-l, c0, wall), f.at(-l, c1, wall), f.at(-l, c1, peak), f.n(-1, 0, 0));
  }

  // Set in from a corner by a fixed amount, not a fraction, so it sits the same
  // distance from the wall on every factory.
  const [cx, cy] = f.at(-l + STACK.inset, -w + STACK.inset, 0).slice(0, 2) as [number, number];
  const chimney = ring(8, STACK.radius, cx, cy);
  b.sides(chimney, 0, peak + STACK.rise);
  b.cap(chimney, peak + STACK.rise);
  return b.done();
}

/**
 * The heights a kind is built at, in tiles. A tile is twelve metres, so a
 * storey is about a sixth of one.
 *
 * These are a short list rather than a range because height is built into the
 * shape, not applied to it afterwards. Scaling an instance would be cheaper,
 * but scaling only one axis skews the normals — a roof lit as though it were
 * flat — and it would stretch a chimney along with everything else. So a
 * building picks one of these and is built at it.
 */
function build(kind: BuildingKind, fw: number, fh: number, height: number): MeshGeometry {
  switch (BLUEPRINTS[kind].shape) {
    case "gabled":
      return gabled(fw, fh);
    case "sawtooth":
      return sawtooth(fw, fh);
    case "box":
      return prism(rect(fw, fh), height);
  }
}

const shapes = new Map<string, MeshGeometry>();

/** A stable number in [0,1) for a building, so its look never changes. */
function hash(id: number, salt = 0): number {
  const h = Math.imul((id ^ salt) ^ 0x9e3779b9, 0x85ebca6b);
  return ((h >>> 0) % 1024) / 1024;
}

/** Which of its kind's heights this building was built at. */
export function variantOf(kind: BuildingKind, id: number): number {
  const n = BLUEPRINTS[kind].heights.length;
  return Math.min(n - 1, Math.floor(hash(id) * n));
}

/**
 * The solid for a kind, on a plot of this size, at one of its heights. Built
 * once per distinct shape and shared by every building that wants it.
 */
export function shapeFor(kind: BuildingKind, w: number, h: number, variant = 0): MeshGeometry {
  const key = `${kind}_${w}x${h}_${variant}`;
  let shape = shapes.get(key);
  if (!shape) {
    shape = build(kind, w - 2 * PLOT_MARGIN, h - 2 * PLOT_MARGIN, BLUEPRINTS[kind].heights[variant]);
    shapes.set(key, shape);
  }
  return shape;
}

/**
 * Which way a building sits, in radians about Z.
 *
 * Rotation is the one transform an instance may still carry, because it does
 * not distort anything. A square plot can take any quarter turn. An oblong one
 * can only take a half turn — a quarter would lay it across its own plot — but
 * that is still enough to move a chimney to the far corner, which is the
 * difference between a row of factories and the same factory drawn six times.
 */
export function facingOf(id: number, w: number, h: number): number {
  const turns = w === h ? 4 : 2;
  const turn = Math.min(turns - 1, Math.floor(hash(id, 0x5bf0_3635) * turns));
  return (turn * Math.PI * 2) / turns;
}

export function boxGeometry(w: number, h: number, d: number): MeshGeometry {
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const positions = [
    // front (z+)
    -hw, -hh, hd, hw, -hh, hd, hw, hh, hd, -hw, hh, hd,
    // back (z-)
    hw, -hh, -hd, -hw, -hh, -hd, -hw, hh, -hd, hw, hh, -hd,
    // top (y+)
    -hw, hh, hd, hw, hh, hd, hw, hh, -hd, -hw, hh, -hd,
    // bottom (y-)
    -hw, -hh, -hd, hw, -hh, -hd, hw, -hh, hd, -hw, -hh, hd,
    // right (x+)
    hw, -hh, hd, hw, -hh, -hd, hw, hh, -hd, hw, hh, hd,
    // left (x-)
    -hw, -hh, -hd, -hw, -hh, hd, -hw, hh, hd, -hw, hh, -hd,
  ];
  const normals = [
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
    0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0,
    1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
    -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0,
  ];
  const indices: number[] = [];
  for (let face = 0; face < 6; face++) {
    const b = face * 4;
    // Same (0,2,1) winding as buildingGeometry and the road fans -- outward
    // faces front-facing under Babylon's left-handed default, so back-face
    // culling works without any per-material orientation override.
    indices.push(b, b + 2, b + 1, b, b + 3, b + 2);
  }
  return { positions, indices, normals };
}

