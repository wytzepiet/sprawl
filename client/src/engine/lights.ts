import {
  addClusteredLightContainer,
  createClusteredLightContainer,
  createClusteredPointLight,
  createClusteredSpotLight,
  markClusteredLightContainerDirty,
  type ClusteredPointLight,
  type ClusteredSpotLight,
  type Mesh,
} from "@babylonjs/lite";
import type { EngineContext } from "./Canvas";
import { groundCover } from "./view";

/**
 * The night's own lights: the street lamps the town puts up (`dressing.ts`)
 * and every moving vehicle's headlights, as Lite's clustered lights. The screen
 * is cut into tiles and each tile told which lights reach it, so a pixel
 * shades only those near it; one slice deep, as the whole map lies on one
 * plane under the camera.
 *
 * Lite bakes how many lights there are when the container is added, so it
 * holds a fixed set of slots, and each frame the lights in view are poured
 * into them: the lamps by a rank of their own when there are more than
 * slots, so a lamp left dark stays dark as the view pans.
 */

/** Lights lit at once, at most: the lamps', and the headlights'. */
const SLOTS = 192;
const BEAMS = 128;
/** The screen's tiles, about as many as this; each a mask of 32 lights a
 *  batch per tile, read by every pixel in it. */
const TILES = 512;

/** A street lamp: warm, the sodium of an old town. A lamp's reflector
 *  spreads its light wide across the street, as a bare bulb at its head
 *  would not: so its light hangs `lift` over the head, where the fall of
 *  a bulb's is as broad as the reflector makes it. */
const LAMP = { colour: [1, 0.62, 0.3] as [number, number, number], intensity: 0.42, range: 2, lift: 0.3 };
/** A vehicle's two headlights: whiter, each thrown ahead in a narrow cone,
 *  `apart` either side of its middle and turned out a little, from inside its
 *  body, so none of it is lit by them, only the road before it. */
const BEAM = { colour: [1, 0.9, 0.75] as [number, number, number], intensity: 1.4, range: 2.2, angle: 0.9, ahead: 0.05, apart: 0.045, toe: 0.08, dip: 0.06 };

/** How far out the view may be zoomed with the lights on, in tiles from its
 *  middle to its far corner; they fade out over the last quarter of it, as
 *  their pools shrink below a few pixels. */
const FARTHEST = 60;

/** Each chunk's lamps (`props.ts`): x, y and z of its head and a rank, four
 *  numbers to a lamp, by the meshes that draw them. */
export const lamps = new Map<Mesh[], Float32Array>();
/** Each moving vehicle's headlight: where it is, its height, its heading. */
const beams = new Map<number, [number, number, number, number]>();
export const beam = (id: number, x: number, y: number, z: number, heading: number) => void beams.set(id, [x, y, z, heading]);
export const unbeam = (id: number) => void beams.delete(id);

/** How on the lights are, 0 by day to 1 by night: what the lamps' heads
 *  glow with (`props.ts`). */
export const night = { on: 0 };

/** The night's lights, set up before the scene is registered; `dark` says
 *  how far toward night it is, 0 to 1. */
export function nightLights(ctx: EngineContext, dark: () => number): () => void {
  const { scene, canvas, beforeRender } = ctx;
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const verticalTiles = Math.max(1, Math.round(Math.sqrt(TILES / aspect)));
  const container = createClusteredLightContainer({ horizontalTiles: Math.max(1, Math.round(verticalTiles * aspect)), verticalTiles, zSlices: 1 });
  const slots: ClusteredPointLight[] = Array.from({ length: SLOTS }, () => createClusteredPointLight(container, { position: [0, 0, 0], diffuse: LAMP.colour, range: LAMP.range, intensity: 0 }));
  const beamSlots: ClusteredSpotLight[] = Array.from({ length: BEAMS }, () => createClusteredSpotLight(container, { position: [0, 0, 0], direction: [1, 0, 0], diffuse: BEAM.colour, range: BEAM.range, angle: BEAM.angle, intensity: 0 }));
  addClusteredLightContainer(scene, container);

  const near: number[] = [];
  let [lit, beamed] = [0, 0];
  const stop = beforeRender(() => {
    const d = dark();
    night.on = d;
    const { cx, cy, radius } = groundCover(scene, canvas);
    const k = d * Math.min(1, Math.max(0, (FARTHEST - radius) / (FARTHEST / 4)));
    let [n, b] = [0, 0];
    if (k > 0) {
      const reach = radius + LAMP.range;
      for (const [x, y, z, heading] of beams.values()) {
        if (b === BEAMS) break;
        if (Math.abs(x - cx) > reach || Math.abs(y - cy) > reach) continue;
        const [fx, fy] = [Math.cos(heading), Math.sin(heading)];
        for (const side of [-1, 1]) {
          const [sx, sy] = [-fy * side, fx * side];
          const slot = beamSlots[b++];
          slot.position[0] = x + fx * BEAM.ahead + sx * BEAM.apart, slot.position[1] = y + fy * BEAM.ahead + sy * BEAM.apart, slot.position[2] = z;
          slot.direction[0] = fx + sx * BEAM.toe, slot.direction[1] = fy + sy * BEAM.toe, slot.direction[2] = -BEAM.dip;
          slot.intensity = BEAM.intensity * k;
        }
      }
      // The lamps in view; if more than the slots, those ranked first.
      near.length = 0;
      for (const heads of lamps.values()) {
        for (let i = 0; i < heads.length; i += 4) {
          if (Math.abs(heads[i] - cx) <= reach && Math.abs(heads[i + 1] - cy) <= reach) near.push(heads[i], heads[i + 1], heads[i + 2], heads[i + 3]);
        }
      }
      let cut = Infinity;
      if (near.length / 4 > SLOTS) cut = near.filter((_, i) => i % 4 === 3).sort((p, q) => p - q)[SLOTS - 1];
      for (let i = 0; i < near.length && n < SLOTS; i += 4) {
        if (near[i + 3] > cut) continue;
        const slot = slots[n++];
        slot.position[0] = near[i], slot.position[1] = near[i + 1], slot.position[2] = near[i + 2] + LAMP.lift;
        slot.intensity = LAMP.intensity * k;
      }
    }
    for (let i = n; i < lit; i++) slots[i].intensity = 0;
    for (let i = b; i < beamed; i++) beamSlots[i].intensity = 0;
    if (n || b || lit || beamed) markClusteredLightContainerDirty(container);
    [lit, beamed] = [n, b];
  });
  return stop;
}
