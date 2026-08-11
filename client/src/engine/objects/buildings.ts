import type { MeshGeometry } from "../Mesh";
import type { BuildingKind, Category } from "../../generated";

/**
 * Zone palette.
 *
 * These have to survive being laid over the terrain rather than beside it, so
 * each is picked to separate from the tile it will most often sit on: the land
 * is a very light yellow-green (#D5F2A4), so residential goes mid-value and
 * cooler; water is a light cyan (#85D7FA), so commercial goes deeper and more
 * indigo; the beaches are near-cream, so industrial leans on saturation.
 */
export const CATEGORY_COLOR: Record<Category, string> = {
  Residential: "#6FBF73",
  Commercial: "#5B8DD9",
  Industrial: "#E8933F",
};

/** Wire order for the per-tile zone byte; 0 is unzoned. */
export const ZONE_BYTE: Record<Category, number> = {
  Residential: 1,
  Commercial: 2,
  Industrial: 3,
};

export const ZONE_PALETTE: ({ r: number; g: number; b: number } | null)[] = [null];

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

/** Buildings themselves stay neutral — the plot carries the category. */
export const BUILDING_COLOR = "#EFEDE8";

export const BUILDING_HEIGHT = 0.6;

/** Margin from the plot edge, which is what leaves the category tint visible. */
export const PLOT_MARGIN = 0.15;
export const BUILDING_SIZE = 1.0 - 2 * PLOT_MARGIN;

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

// Fill the zone palette from the category colours, in ZONE_BYTE order.
for (const [category, byte] of Object.entries(ZONE_BYTE) as [Category, number][]) {
  const hex = CATEGORY_COLOR[category];
  ZONE_PALETTE[byte] = {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  };
}
