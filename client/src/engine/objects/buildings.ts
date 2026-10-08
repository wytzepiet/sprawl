import type { MeshGeometry } from "../geometry";

/** A box `w` by `h` by `d`, its middle at the origin: a car, a lorry, a quay. */
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
  // Each face a fan round its middle, so each of its triangles owns one
  // edge whole and the bevel rounds it to a mitre at the corners, as a
  // real rounded box's are; split corner to corner, the two halves round
  // their edges unevenly across the split.
  for (let face = 0; face < 6; face++) {
    const b = face * 4;
    const c = positions.length / 3;
    for (let k = 0; k < 3; k++) positions.push((positions[b * 3 + k] + positions[(b + 1) * 3 + k] + positions[(b + 2) * 3 + k] + positions[(b + 3) * 3 + k]) / 4);
    normals.push(normals[b * 3], normals[b * 3 + 1], normals[b * 3 + 2]);
    // Same (0,2,1) winding as buildingGeometry and the road fans -- outward
    // faces front-facing under Babylon's left-handed default, so back-face
    // culling works without any per-material orientation override.
    for (let i = 0; i < 4; i++) indices.push(c, b + ((i + 1) % 4), b + i);
  }
  return { positions, indices, normals };
}
