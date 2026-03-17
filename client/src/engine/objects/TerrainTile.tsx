import { For, createMemo } from "solid-js";
import { Color3, RawTexture } from "@babylonjs/core";
import InstancedMesh from "../InstancePool";
import { useEngine } from "../Canvas";
import type { KindEntry } from "../GameObject";

import { useTheme, type Theme } from "../theme";
import { useGame } from "../../state/gameObjects";
import type { TerrainType } from "../../generated";
import type { MeshGeometry } from "../Mesh";

const ELEVATION: Record<TerrainType, number> = {
  Water: -0.5,
  Water2: -0.5,
  Water3: -0.5,
  Beach: 0,
  Grass: 0,
  Forest: 0,
  Mountain: 2.0,
};

// Seeded PRNG (xorshift32)
function seed(x: number, y: number): number {
  let s = (x * 374761393 + y * 668265263 + 1013904223) | 0;
  s = ((s ^ (s >>> 13)) * 1274126177) | 0;
  return s;
}
function nextRand(s: number): [number, number] {
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  return [s, (s >>> 0) / 4294967296];
}

const TREE_SEGMENTS = 12;

function buildCylinderGeo(radius: number, height: number): MeshGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  // Side wall
  for (let i = 0; i <= TREE_SEGMENTS; i++) {
    const a = (i / TREE_SEGMENTS) * Math.PI * 2;
    const cx = Math.cos(a), cy = Math.sin(a);
    // bottom
    positions.push(cx * radius, cy * radius, 0);
    normals.push(cx, cy, 0);
    // top
    positions.push(cx * radius, cy * radius, height);
    normals.push(cx, cy, 0);
  }
  for (let i = 0; i < TREE_SEGMENTS; i++) {
    const b = i * 2;
    indices.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  }

  // Top cap
  const topCenter = positions.length / 3;
  positions.push(0, 0, height);
  normals.push(0, 0, 1);
  for (let i = 0; i <= TREE_SEGMENTS; i++) {
    const a = (i / TREE_SEGMENTS) * Math.PI * 2;
    positions.push(Math.cos(a) * radius, Math.sin(a) * radius, height);
    normals.push(0, 0, 1);
  }
  for (let i = 0; i < TREE_SEGMENTS; i++) {
    indices.push(topCenter, topCenter + i + 1, topCenter + i + 2);
  }

  return { positions, indices, normals };
}

const TREE_TRUNK = buildCylinderGeo(1, 1);
interface TreeInfo {
  x: number;
  y: number;
  scale: number;
}

const GRID = 3; // 3x3 jittered grid = 9 trees
const CELL = 1 / GRID;

function treesForTile(tx: number, ty: number): TreeInfo[] {
  let s = seed(tx, ty);
  const trees: TreeInfo[] = [];
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      let v: number;
      [s, v] = nextRand(s);
      const x = (gx + v) * CELL;
      [s, v] = nextRand(s);
      const y = (gy + v) * CELL;
      [s, v] = nextRand(s);
      const scale = 0.5 + v * 1;
      trees.push({ x, y, scale });
    }
  }
  return trees;
}

const TEX_SIZE = 32;
const BORDER = 1;

function createBorderTexture(scene: any): RawTexture {
  const data = new Uint8Array(TEX_SIZE * TEX_SIZE * 3);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const i = (y * TEX_SIZE + x) * 3;
      const edge =
        x < BORDER ||
        x >= TEX_SIZE - BORDER ||
        y < BORDER ||
        y >= TEX_SIZE - BORDER;
      const v = edge ? 230 : 255; // border darkens to ~90%
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
  }
  return RawTexture.CreateRGBTexture(
    data,
    TEX_SIZE,
    TEX_SIZE,
    scene,
    false,
    false,
  );
}

const FULL_SQUARE: MeshGeometry = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  indices: [0, 1, 2, 0, 2, 3],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
};

const S = 0.5;
const N = 6; // curve segments

const CORNER_DEFS = [
  {
    cv: [0, 0],
    p0h: [S, 0],
    p0f: [1, 0],
    p3h: [0, S],
    p3f: [0, 1],
    tanA: [-1, 0],
    tanB: [0, 1],
  }, // BL
  {
    cv: [1, 0],
    p0h: [1, S],
    p0f: [1, 1],
    p3h: [S, 0],
    p3f: [0, 0],
    tanA: [0, -1],
    tanB: [-1, 0],
  }, // BR
  {
    cv: [1, 1],
    p0h: [1 - S, 1],
    p0f: [0, 1],
    p3h: [1, 1 - S],
    p3f: [1, 0],
    tanA: [1, 0],
    tanB: [0, -1],
  }, // TR
  {
    cv: [0, 1],
    p0h: [0, 1 - S],
    p0f: [0, 0],
    p3h: [S, 1],
    p3f: [1, 1],
    tanA: [0, 1],
    tanB: [1, 0],
  }, // TL
];

function cubicBezier(
  p0: number[],
  c1: number[],
  c2: number[],
  p3: number[],
  t: number,
): [number, number] {
  const u = 1 - t;
  return [
    u * u * u * p0[0] +
      3 * u * u * t * c1[0] +
      3 * u * t * t * c2[0] +
      t * t * t * p3[0],
    u * u * u * p0[1] +
      3 * u * u * t * c1[1] +
      3 * u * t * t * c2[1] +
      t * t * t * p3[1],
  ];
}

// Returns curve points from p0 (edge A) to p3 (edge B) for a corner overlay.
// Straight line (2 points) when both edges continue; bezier (N+1 points) otherwise.
function getCornerCurvePoints(
  defIdx: number,
  variant: number,
): [number, number][] {
  const def = CORNER_DEFS[defIdx];
  const aContinues = !!(variant & 1);
  const bContinues = !!(variant & 2);
  const aExtends = !!(variant & 4) && !aContinues;
  const bExtends = !!(variant & 8) && !bContinues;

  const p0 = aExtends ? def.p0f : def.p0h;
  const p3 = bExtends ? def.p3f : def.p3h;

  if (aContinues && bContinues) {
    return [p0 as [number, number], p3 as [number, number]];
  }

  const armA = Math.hypot(p0[0] - def.cv[0], p0[1] - def.cv[1]);
  const armB = Math.hypot(p3[0] - def.cv[0], p3[1] - def.cv[1]);
  const kA = armA * 0.55;
  const kB = armB * 0.55;

  const dx = def.p3h[0] - def.p0h[0];
  const dy = def.p3h[1] - def.p0h[1];
  const len = Math.hypot(dx, dy);
  const diagX = dx / len;
  const diagY = dy / len;

  const c1 = aContinues
    ? [p0[0] + kA * diagX, p0[1] + kA * diagY]
    : [p0[0] + kA * def.tanA[0], p0[1] + kA * def.tanA[1]];
  const c2 = bContinues
    ? [p3[0] - kB * diagX, p3[1] - kB * diagY]
    : [p3[0] - kB * def.tanB[0], p3[1] - kB * def.tanB[1]];

  const points: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    points.push(cubicBezier(p0, c1, c2, p3, i / N));
  }
  return points;
}

function buildCornerGeo(defIdx: number, variant: number): MeshGeometry {
  const def = CORNER_DEFS[defIdx];
  const pts = getCornerCurvePoints(defIdx, variant);

  const positions: number[] = [def.cv[0], def.cv[1], 0];
  const normals: number[] = [0, 0, 1];
  const uvs: number[] = [def.cv[0], def.cv[1]];
  const indices: number[] = [];

  for (const [px, py] of pts) {
    positions.push(px, py, 0);
    normals.push(0, 0, 1);
    uvs.push(px, py);
  }

  for (let i = 0; i < pts.length - 1; i++) {
    indices.push(0, i + 1, i + 2);
  }

  return { positions, indices, normals, uvs };
}

// Precompute: CORNER_GEOS[cornerIndex][variant] — 16 variants per corner
const CORNER_GEOS: MeshGeometry[][] = CORNER_DEFS.map((_, i) => {
  const geos: MeshGeometry[] = [];
  for (let v = 0; v < 16; v++) geos.push(buildCornerGeo(i, v));
  return geos;
});

// Base mesh with corners cut out where elevation differs.
// Fan-triangulated from center (0.5, 0.5).
function buildCutoutBaseGeo(
  cutouts: { index: number; variant: number }[],
): MeshGeometry {
  const cutoutMap = new Map(cutouts.map((c) => [c.index, c.variant]));
  const cornerVerts: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];

  // Walk boundary CCW: BL → BR → TR → TL
  const boundary: [number, number][] = [];
  for (let ci = 0; ci < 4; ci++) {
    if (cutoutMap.has(ci)) {
      const pts = getCornerCurvePoints(ci, cutoutMap.get(ci)!);
      // Reverse: boundary CCW traverses from edge B (p3) to edge A (p0)
      for (let i = pts.length - 1; i >= 0; i--) {
        boundary.push(pts[i]);
      }
    } else {
      boundary.push(cornerVerts[ci]);
    }
  }

  const positions: number[] = [0.5, 0.5, 0];
  const normals: number[] = [0, 0, 1];
  const uvs: number[] = [0.5, 0.5];
  const indices: number[] = [];

  for (const [bx, by] of boundary) {
    positions.push(bx, by, 0);
    normals.push(0, 0, 1);
    uvs.push(bx, by);
  }

  const n = boundary.length;
  for (let i = 0; i < n; i++) {
    indices.push(0, i + 1, ((i + 1) % n) + 1);
  }

  return { positions, indices, normals, uvs };
}

// Edge cliff wall along a straight tile edge.
// Edges: 0=bottom, 1=right, 2=top, 3=left.
const EDGE_ENDPOINTS: [[number, number], [number, number]][] = [
  [
    [0, 0],
    [1, 0],
  ], // bottom
  [
    [1, 0],
    [1, 1],
  ], // right
  [
    [1, 1],
    [0, 1],
  ], // top
  [
    [0, 1],
    [0, 0],
  ], // left
];
const EDGE_NORMALS: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

function buildEdgeCliffGeo(edgeIdx: number, height: number): MeshGeometry {
  const [[x0, y0], [x1, y1]] = EDGE_ENDPOINTS[edgeIdx];
  const [nx, ny] = EDGE_NORMALS[edgeIdx];
  return {
    positions: [x0, y0, 0, x1, y1, 0, x1, y1, height, x0, y0, height],
    normals: [nx, ny, 0, nx, ny, 0, nx, ny, 0, nx, ny, 0],
    indices: [0, 2, 1, 0, 3, 2],
  };
}

// Vertical quad strip along the bezier curve between two elevation levels.
// Geometry in local space: Z from 0 to height. Position at lowerZ.
function buildCliffGeo(
  defIdx: number,
  variant: number,
  height: number,
): MeshGeometry {
  const def = CORNER_DEFS[defIdx];
  const pts = getCornerCurvePoints(defIdx, variant);

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];

    // Normal perpendicular to curve tangent, pointing away from corner vertex
    const tx = x1 - x0;
    const ty = y1 - y0;
    const mx = (x0 + x1) / 2 - def.cv[0];
    const my = (y0 + y1) / 2 - def.cv[1];
    let nx = -ty,
      ny = tx;
    if (nx * mx + ny * my < 0) {
      nx = ty;
      ny = -tx;
    }
    const len = Math.hypot(nx, ny);
    nx /= len;
    ny /= len;

    const base = positions.length / 3;
    positions.push(x0, y0, 0, x1, y1, 0, x1, y1, height, x0, y0, height);
    normals.push(nx, ny, 0, nx, ny, 0, nx, ny, 0, nx, ny, 0);
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }

  return { positions, indices, normals };
}

export function terrainColor(type: TerrainType, theme: Theme): Color3 {
  switch (type) {
    case "Water":
      return theme.water;
    case "Water2":
      return theme.water2;
    case "Water3":
      return theme.water3;
    case "Beach":
      return theme.beach;
    case "Grass":
      return new Color3(theme.land.r, theme.land.g, theme.land.b);
    case "Forest":
      return theme.forest;
    case "Mountain":
      return theme.mountain;
  }
}

let borderTex: RawTexture | undefined;

const EDGE_DIRS: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export default function TerrainTile(props: { entry: KindEntry<"Terrain"> }) {
  const { scene } = useEngine();
  const theme = useTheme();
  const { getObjectsAt } = useGame();
  if (!borderTex) borderTex = createBorderTexture(scene);

  const pos = () => props.entry.position!;
  const baseElev = () => ELEVATION[props.entry.object.data.terrain_type];

  const activeCorners = createMemo(() => {
    const d = props.entry.object.data;
    return d.corners
      .map((c, i) => {
        if (!c) return null;
        let variant = (d.corner_mask >> (i * 2)) & 3;
        if (!(variant & 1) && !d.corners[(i + 1) % 4]) variant |= 4;
        if (!(variant & 2) && !d.corners[(i + 3) % 4]) variant |= 8;
        const cornerElev = ELEVATION[c];
        return {
          index: i,
          type: c,
          variant,
          sameElev: cornerElev === baseElev(),
          cornerElev,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
  });

  const sameElev = createMemo(() => activeCorners().filter((c) => c.sameElev));
  const diffElev = createMemo(() => activeCorners().filter((c) => !c.sameElev));

  // Edge i touches corners i and (i+1)%4
  const edgeCliffs = createMemo(() => {
    const p = pos();
    const be = baseElev();
    const de = diffElev();
    const diffSet = new Set(de.map((c) => c.index));
    const result: { edgeIdx: number; height: number }[] = [];
    for (let i = 0; i < 4; i++) {
      if (diffSet.has(i) || diffSet.has((i + 1) % 4)) continue;
      const [dx, dy] = EDGE_DIRS[i];
      const neighbors = getObjectsAt(p.x + dx, p.y + dy);
      const terrain = neighbors.find((n) => n.object.kind === "Terrain");
      if (!terrain) continue;
      const neighborElev =
        ELEVATION[
          (terrain.object.data as { terrain_type: TerrainType }).terrain_type
        ];
      if (neighborElev >= be) continue;
      result.push({ edgeIdx: i, height: be - neighborElev });
    }
    return result;
  });

  const baseGeo = createMemo(() =>
    diffElev().length === 0 ? FULL_SQUARE : buildCutoutBaseGeo(diffElev()),
  );

  const basePoolKey = createMemo(() => {
    const tt = props.entry.object.data.terrain_type;
    const de = diffElev();
    return de.length === 0
      ? `terrain_${tt}`
      : `terrain_${tt}_c${de.map((c) => `${c.index}v${c.variant}`).join("_")}`;
  });

  return (
    <>
      <InstancedMesh
        poolKey={basePoolKey()}
        geometry={baseGeo()}
        position={[pos().x, pos().y, baseElev()]}
        color={terrainColor(props.entry.object.data.terrain_type, theme())}
        texture={baseElev() === 0 ? borderTex : undefined}
        receiveShadow
      />
      {props.entry.object.data.terrain_type === "Forest" && (
        <For each={treesForTile(pos().x, pos().y)}>
          {(tree) => {
            const s = () => tree.scale;
            const visible = () => !getObjectsAt(pos().x, pos().y).some((o) => o.object.kind === "RoadNode");
            return (
              <InstancedMesh
                poolKey="tree_trunk"
                geometry={TREE_TRUNK}
                position={[pos().x + tree.x, pos().y + tree.y, 0]}
                scale={[s() * 0.35, s() * 0.35, s()]}
                color={terrainColor("Forest", theme()).scale(0.7)}
                enabled={visible()}
                castShadow
                receiveShadow
              />
            );
          }}
        </For>
      )}
      <For each={sameElev()}>
        {(corner) => {
          const buildable = () => ELEVATION[corner.type] === 0;
          return (
            <InstancedMesh
              poolKey={`corner_${corner.index}_${corner.type}_${corner.variant}${buildable() ? "_b" : ""}`}
              geometry={CORNER_GEOS[corner.index][corner.variant]}
              position={[pos().x, pos().y, baseElev() + 0.01]}
              color={terrainColor(corner.type, theme())}
              texture={buildable() ? borderTex : undefined}
              receiveShadow
            />
          );
        }}
      </For>
      <For each={diffElev()}>
        {(corner) => {
          const be = () => baseElev();
          const upperZ = () => Math.max(be(), corner.cornerElev);
          const lowerZ = () => Math.min(be(), corner.cornerElev);
          const height = () => upperZ() - lowerZ();
          const higherType = () =>
            corner.cornerElev > be()
              ? corner.type
              : props.entry.object.data.terrain_type;
          const cliffColor = () =>
            terrainColor(higherType(), theme()).scale(0.7);
          return (
            <>
              <InstancedMesh
                poolKey={`corner_${corner.index}_${corner.type}_${corner.variant}${corner.cornerElev === 0 ? "_b" : ""}`}
                geometry={CORNER_GEOS[corner.index][corner.variant]}
                position={[pos().x, pos().y, corner.cornerElev]}
                color={terrainColor(corner.type, theme())}
                texture={corner.cornerElev === 0 ? borderTex : undefined}
                receiveShadow
              />
              <InstancedMesh
                poolKey={`cliff_${corner.index}_${corner.variant}_${height()}_${higherType()}`}
                geometry={buildCliffGeo(
                  corner.index,
                  corner.variant,
                  height(),
                )}
                position={[pos().x, pos().y, lowerZ()]}
                color={cliffColor()}
                castShadow
              />
            </>
          );
        }}
      </For>
      <For each={edgeCliffs()}>
        {(edge) => {
          const cliffColor = () =>
            terrainColor(props.entry.object.data.terrain_type, theme()).scale(
              0.7,
            );
          return (
            <InstancedMesh
              poolKey={`edge_cliff_${edge.edgeIdx}_${edge.height}_${props.entry.object.data.terrain_type}`}
              geometry={buildEdgeCliffGeo(edge.edgeIdx, edge.height)}
              position={[pos().x, pos().y, baseElev() - edge.height]}
              color={cliffColor()}
              castShadow
            />
          );
        }}
      </For>
    </>
  );
}
