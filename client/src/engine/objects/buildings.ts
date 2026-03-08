import type { MeshGeometry } from "../Mesh";

export interface BuildingDef {
  id: string;
  label: string;
  color: string;
}

export const BUILDINGS: BuildingDef[] = [
  { id: "car_spawner", label: "Car Spawner", color: "#4a9eff" },
];

export const BUILDING_HEIGHT = 0.6;

const M = 0.05;
const BUILDING_SIZE = 1.0 - 2 * M;

/**
 * Building cube geometry — top face + 4 side walls, no bottom.
 * Top face is lit and visible from above. Sides cast shadows.
 * Origin is at the center of the footprint at z = 0 (bottom).
 */
export function buildingCubeGeometry(): MeshGeometry {
  const hs = BUILDING_SIZE / 2; // half-size in XY
  const h = BUILDING_HEIGHT;

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  function quad(
    p0: [number, number, number],
    p1: [number, number, number],
    p2: [number, number, number],
    p3: [number, number, number],
    n: [number, number, number],
  ) {
    const base = positions.length / 3;
    for (const p of [p0, p1, p2, p3]) {
      positions.push(...p);
      normals.push(...n);
    }
    // Winding: Babylon left-handed expects (0,2,1) order for front-facing toward +Z
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }

  // Top face (z = h, normal up toward camera)
  quad([-hs, -hs, h], [hs, -hs, h], [hs, hs, h], [-hs, hs, h], [0, 0, 1]);

  // Front wall (y = hs)
  quad([-hs, hs, 0], [hs, hs, 0], [hs, hs, h], [-hs, hs, h], [0, 1, 0]);

  // Back wall (y = -hs)
  quad([hs, -hs, 0], [-hs, -hs, 0], [-hs, -hs, h], [hs, -hs, h], [0, -1, 0]);

  // Right wall (x = hs)
  quad([hs, hs, 0], [hs, -hs, 0], [hs, -hs, h], [hs, hs, h], [1, 0, 0]);

  // Left wall (x = -hs)
  quad([-hs, -hs, 0], [-hs, hs, 0], [-hs, hs, h], [-hs, -hs, h], [-1, 0, 0]);

  return { positions, indices, normals };
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
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return { positions, indices, normals };
}
