import { createCubeEnvironment, updateCubeEnvironment, type CubeEnvironment, type SceneContext } from "@babylonjs/lite";
import { add, lerp, scale, type Rgb } from "./rgb";

/**
 * The sky as PBR's environment: what every surface is lit by from all round
 * where the sun is not, and what a glossy one reflects. A small cube drawn
 * from the day's own palette, redrawn as the light moves: the sky's colour
 * overhead; along the horizon the glow on the sun's side and the belt on
 * the far one, which at dusk part into gold and rose; and below the
 * horizon the land, dim, lit by both.
 *
 * World up is +Z. Each face's texels run along the axes Babylon reads a cube
 * by (its `_FileFaces`, which Lite's `createCubeEnvironment` takes), so the
 * light worked out for diffuse and the picture sampled for reflections agree.
 */
const SIZE = 16;

/** Of the sky's and the sun's light, how much the land below sends back. */
const LAND = 0.18;

type V3 = readonly [number, number, number];
const FACES: [V3, V3, V3][] = [
  [[1, 0, 0], [0, 0, -1], [0, -1, 0]],
  [[-1, 0, 0], [0, 0, 1], [0, -1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, 0, 1], [1, 0, 0], [0, -1, 0]],
  [[0, 0, -1], [-1, 0, 0], [0, -1, 0]],
];

/** Linear light, as PBR takes it (`linearLight`). */
export interface SkyLight {
  /** Overhead. */
  zenith: Rgb;
  /** Along the horizon toward the sun, and away from it. */
  glow: Rgb;
  belt: Rgb;
  /** The sun's own light, for what the land sends back. */
  sun: Rgb;
  /** Level, toward where the sun is or last was: x and y, unit length. */
  sunward: readonly [number, number];
}

/** The sky, drawn as `light` gives it, made the scene's environment: before
 *  the scene is registered, as Lite builds its shaders for what it has then. */
export function skyEnvironment(scene: SceneContext, light: SkyLight) {
  const faces = FACES.map(() => new Float32Array(SIZE * SIZE * 4));
  const paint = ({ zenith, glow, belt, sun, sunward }: SkyLight) => {
    const land = scale(add(zenith, sun), LAND);
    for (let f = 0; f < 6; f++) {
      const [n, ax, ay] = FACES[f];
      const data = faces[f];
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const u = ((x + 0.5) / SIZE) * 2 - 1;
          const v = ((y + 0.5) / SIZE) * 2 - 1;
          const dx = n[0] + ax[0] * u + ay[0] * v;
          const dy = n[1] + ax[1] * u + ay[1] * v;
          const dz = n[2] + ax[2] * u + ay[2] * v;
          const len = Math.hypot(dx, dy, dz);
          let c: Rgb;
          if (dz < 0) {
            c = land;
          } else {
            // Round the horizon from the sun's side to the far one, then
            // up to the zenith, which the horizon's colours give way to quickly.
            const level = Math.hypot(dx, dy) || 1;
            const facing = (dx * sunward[0] + dy * sunward[1]) / level;
            const horizon = lerp(belt, glow, Math.pow((facing + 1) / 2, 3));
            c = lerp(horizon, zenith, Math.pow(dz / len, 0.6));
          }
          data.set([c.r, c.g, c.b, 1], (y * SIZE + x) * 4);
        }
      }
    }
  };
  paint(light);
  const environment: CubeEnvironment = createCubeEnvironment(scene, faces, { size: SIZE });
  return {
    draw(light: SkyLight) {
      paint(light);
      updateCubeEnvironment(environment, faces);
    },
  };
}
