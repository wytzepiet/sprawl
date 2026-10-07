import { Color3, Constants, CubeMapToSphericalPolynomialTools, RawCubeTexture, Texture, Vector3, type Scene } from "@babylonjs/core";

/**
 * The sky as PBR's environment: what every surface is lit by from all round
 * where the sun is not, and what a glossy one reflects. A small cube drawn
 * from the day's own palette, redrawn as the light moves: the sky's colour
 * overhead; along the horizon the glow on the sun's side and the belt on
 * the far one, which at dusk part into gold and rose; and below the
 * horizon the land, dim, lit by both.
 *
 * World up is +Z. Each face's texels run along the axes Babylon reads a cube
 * by (`CubeMapToSphericalPolynomialTools._FileFaces`), so the light worked out
 * for diffuse and the picture sampled for reflections agree.
 */
const SIZE = 16;

/** Of the sky's and the sun's light, how much the land below sends back. */
const LAND = 0.18;

const FACES: [Vector3, Vector3, Vector3][] = [
  [new Vector3(1, 0, 0), new Vector3(0, 0, -1), new Vector3(0, -1, 0)],
  [new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, -1, 0)],
  [new Vector3(0, 1, 0), new Vector3(1, 0, 0), new Vector3(0, 0, 1)],
  [new Vector3(0, -1, 0), new Vector3(1, 0, 0), new Vector3(0, 0, -1)],
  [new Vector3(0, 0, 1), new Vector3(1, 0, 0), new Vector3(0, -1, 0)],
  [new Vector3(0, 0, -1), new Vector3(-1, 0, 0), new Vector3(0, -1, 0)],
];

/** Linear light, as PBR takes it (`linearLight`). */
export interface SkyLight {
  /** Overhead. */
  zenith: Color3;
  /** Along the horizon toward the sun, and away from it. */
  glow: Color3;
  belt: Color3;
  /** The sun's own light, for what the land sends back. */
  sun: Color3;
  /** Level, toward where the sun is or last was. */
  sunward: Vector3;
}

export function skyEnvironment(scene: Scene) {
  const faces = FACES.map(() => new Float32Array(SIZE * SIZE * 4));
  const cube = new RawCubeTexture(scene, faces, SIZE, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_FLOAT, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  cube.gammaSpace = false;
  scene.environmentTexture = cube;

  const dir = new Vector3();
  return {
    draw({ zenith, glow, belt, sun, sunward }: SkyLight) {
      const land = zenith.add(sun).scale(LAND);
      for (let f = 0; f < 6; f++) {
        const [n, ax, ay] = FACES[f];
        const data = faces[f];
        for (let y = 0; y < SIZE; y++) {
          for (let x = 0; x < SIZE; x++) {
            const u = ((x + 0.5) / SIZE) * 2 - 1;
            const v = ((y + 0.5) / SIZE) * 2 - 1;
            dir.copyFrom(n).addInPlace(ax.scale(u)).addInPlace(ay.scale(v)).normalize();
            let c: Color3;
            if (dir.z < 0) {
              c = land;
            } else {
              // Round the horizon from the sun's side to the far one, then
              // up to the zenith, which the horizon's colours give way to quickly.
              const level = Math.hypot(dir.x, dir.y) || 1;
              const facing = (dir.x * sunward.x + dir.y * sunward.y) / level;
              const horizon = Color3.Lerp(belt, glow, Math.pow((facing + 1) / 2, 3));
              c = Color3.Lerp(horizon, zenith, Math.pow(dir.z, 0.6));
            }
            const i = (y * SIZE + x) * 4;
            data[i] = c.r;
            data[i + 1] = c.g;
            data[i + 2] = c.b;
            data[i + 3] = 1;
          }
        }
      }
      cube.update(faces, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_FLOAT, false);
      cube.sphericalPolynomial = CubeMapToSphericalPolynomialTools.ConvertCubeMapToSphericalPolynomial({
        size: SIZE,
        right: faces[0],
        left: faces[1],
        up: faces[2],
        down: faces[3],
        front: faces[4],
        back: faces[5],
        format: Constants.TEXTUREFORMAT_RGBA,
        type: Constants.TEXTURETYPE_FLOAT,
        gammaSpace: false,
      });
    },
    dispose() {
      if (scene.environmentTexture === cube) scene.environmentTexture = null;
      cube.dispose();
    },
  };
}
