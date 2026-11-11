/**
 * The eye and its matrices: a camera at a place looking at another, y up,
 * left-handed, depth 0 to 1, column-major; as the fork of Babylon Lite the
 * game was first drawn with had them, number for number.
 */

/** A point that says when it is written. */
export class Spot {
  constructor(public x: number, public y: number, public z: number, private moved: () => void) {}
  set(x: number, y: number, z: number) {
    if (x === this.x && y === this.y && z === this.z) return;
    [this.x, this.y, this.z] = [x, y, z];
    this.moved();
  }
}

export class Camera {
  readonly position: Spot;
  readonly target: Spot;
  fov = 0.8;
  nearPlane = 1;
  farPlane = 10000;
  /** Bumped as it moves. */
  worldMatrixVersion = 0;
  /** Its matrices as last worked out, and for what. */
  _view = new Float32Array(16);
  _viewOf = -1;
  _vp = new Float32Array(16);
  _vpOf = "";
  constructor(position: Point, target: Point) {
    const moved = () => void this.worldMatrixVersion++;
    this.position = new Spot(position.x, position.y, position.z, moved);
    this.target = new Spot(target.x, target.y, target.z, moved);
  }
}
type Point = { x: number; y: number; z: number };

export const createFreeCamera = (position: Point, target: Point) => new Camera(position, target);

/** The world as the camera sees it. The same array each time, written again when the camera has moved. */
export function getViewMatrix(c: Camera): Float32Array {
  const v = c._view;
  if (c._viewOf === c.worldMatrixVersion) return v;
  c._viewOf = c.worldMatrixVersion;
  const [e, t] = [c.position, c.target];
  // Its axes in the world: z the way it looks, x to its right, y up.
  let [zx, zy, zz] = [t.x - e.x, t.y - e.y, t.z - e.z];
  const zl = Math.hypot(zx, zy, zz);
  let [xx, xy, xz] = [1, 0, 0];
  let [yx, yy, yz] = [0, 1, 0];
  let xl = 0;
  if (zl >= 1e-10) {
    [zx, zy, zz] = [zx / zl, zy / zl, zz / zl];
    // Up is y: x is up × z.
    [xx, xy, xz] = [zz, 0, -zx];
    xl = Math.hypot(xx, xy, xz);
  }
  if (xl < 1e-10) [xx, xy, xz, yx, yy, yz, zx, zy, zz] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  else {
    [xx, xy, xz] = [xx / xl, xy / xl, xz / xl];
    [yx, yy, yz] = [zy * xz - zz * xy, zz * xx - zx * xz, zx * xy - zy * xx];
  }
  v.set([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0, -(xx * e.x + xy * e.y + xz * e.z), -(yx * e.x + yy * e.y + yz * e.z), -(zx * e.x + zy * e.y + zz * e.z), 1]);
  return v;
}

/** The world onto the screen, as wide for its height as `aspect`. The same array each time. */
export function getViewProjectionMatrix(c: Camera, aspect: number): Float32Array {
  const of = `${c.worldMatrixVersion},${c.fov},${c.nearPlane},${c.farPlane},${aspect}`;
  if (c._vpOf === of) return c._vp;
  c._vpOf = of;
  const tan = 1 / Math.tan(c.fov * 0.5);
  const range = c.farPlane - c.nearPlane;
  const p = new Float32Array(16);
  [p[0], p[5], p[10], p[11], p[14]] = [tan / aspect, tan, -c.nearPlane / range, 1, (c.farPlane * c.nearPlane) / range];
  const v = getViewMatrix(c);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) c._vp[col * 4 + row] = p[row] * v[col * 4] + p[4 + row] * v[col * 4 + 1] + p[8 + row] * v[col * 4 + 2] + p[12 + row] * v[col * 4 + 3];
  return c._vp;
}

/** A matrix's inverse, or null if it has none. */
export function invertMat4(m: ArrayLike<number>): Float32Array | null {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m as unknown as number[];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-10) return null;
  const d = 1 / det;
  return Float32Array.of(
    (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d, (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d, (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d, (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d, (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d,
  );
}

/** A matrix of a place, a turn (a quaternion) and a size, written at `off`. */
export function composeMat4IntoBuffer(dst: Float32Array | Float64Array, off: number, tx: number, ty: number, tz: number, qx: number, qy: number, qz: number, qw: number, sx: number, sy: number, sz: number) {
  const [xx, yy, zz, xy, xz, yz, wx, wy, wz] = [qx * qx, qy * qy, qz * qz, qx * qy, qx * qz, qy * qz, qw * qx, qw * qy, qw * qz];
  dst.set([(1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0, 2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0, 2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0, tx, ty, tz, 1], off);
}

export interface Ray {
  origin: [number, number, number];
  direction: [number, number, number];
  length: number;
}

/** The line into the world under a pixel, from the near plane to the far. */
export function createPickingRay(x: number, y: number, vp: ArrayLike<number>, width: number, height: number): Ray | null {
  const inv = invertMat4(vp);
  if (!inv) return null;
  const [nx, ny] = [(2 * x) / width - 1, 1 - (2 * y) / height];
  const at = (depth: number): [number, number, number] => {
    const w = inv[3] * nx + inv[7] * ny + inv[11] * depth + inv[15];
    return [(inv[0] * nx + inv[4] * ny + inv[8] * depth + inv[12]) / w, (inv[1] * nx + inv[5] * ny + inv[9] * depth + inv[13]) / w, (inv[2] * nx + inv[6] * ny + inv[10] * depth + inv[14]) / w];
  };
  const [near, far] = [at(1), at(0)];
  const d = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
  const length = Math.hypot(d[0], d[1], d[2]);
  if (length < 1e-10) return null;
  return { origin: near, direction: [d[0] / length, d[1] / length, d[2] / length], length };
}
