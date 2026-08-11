import type { MeshGeometry } from "../Mesh";
import type { BuildingKind, Category } from "../../generated";

/**
 * Zone palette. The three sit 120 degrees apart in hue *and* step in lightness,
 * so they stay apart in greyscale and for red-green colour deficiency, where
 * clay and ochre would otherwise both read as "warm".
 *
 * Green is unavailable (the land is green) and pale blue reads as water, which
 * is why this is not the usual green/blue/yellow.
 */
export const CATEGORY_COLOR: Record<Category, string> = {
  Residential: "#F0A58C",
  Commercial: "#7B87DC",
  Industrial: "#C9922B",
};

export const KIND_CATEGORY: Record<BuildingKind, Category> = {
  House: "Residential",
  Apartment: "Residential",
  Shop: "Commercial",
  Office: "Commercial",
  Workshop: "Industrial",
  Factory: "Industrial",
};

export interface BuildingDef {
  id: BuildingKind;
  label: string;
  color: string;
}

export const BUILDINGS: BuildingDef[] = (
  [
    ["House", "House"],
    ["Shop", "Shop"],
    ["Workshop", "Workshop"],
  ] as [BuildingKind, string][]
).map(([id, label]) => ({ id, label, color: CATEGORY_COLOR[KIND_CATEGORY[id]] }));

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
    // Same (0,2,1) winding as buildingGeometry and the road fans -- outward
    // faces front-facing under Babylon's left-handed default, so back-face
    // culling works without any per-material orientation override.
    indices.push(b, b + 2, b + 1, b, b + 3, b + 2);
  }
  return { positions, indices, normals };
}
