import { createSignal, onCleanup } from "solid-js";
import type { Scene } from "@babylonjs/core";

export interface SpringOpts {
  stiffness?: number;
  damping?: number;
  precision?: number;
}

export interface Spring2D {
  /** Current spring position as a reactive signal. */
  pos: () => [number, number];
  /** Set the target the spring animates toward. */
  setTarget(x: number, y: number): void;
  /** Snap instantly to a position (resets velocity). */
  snap(x: number, y: number): void;
}

export function createSpring2D(scene: Scene, opts: SpringOpts = {}): Spring2D {
  const stiffness = opts.stiffness ?? 0.3;
  const damping = opts.damping ?? 0.7;
  const precision = opts.precision ?? 0.01;

  let tx = 0, ty = 0;
  let cx = 0, cy = 0;
  let vx = 0, vy = 0;

  const [pos, setPos] = createSignal<[number, number]>([0, 0]);

  const obs = scene.onBeforeRenderObservable.add(() => {
    const dx = tx - cx;
    const dy = ty - cy;

    if (Math.abs(dx) < precision && Math.abs(dy) < precision
      && Math.abs(vx) < precision && Math.abs(vy) < precision) {
      if (cx !== tx || cy !== ty) {
        cx = tx;
        cy = ty;
        setPos([tx, ty]);
      }
      return;
    }

    vx = (vx + dx * stiffness) * damping;
    vy = (vy + dy * stiffness) * damping;
    cx += vx;
    cy += vy;
    setPos([cx, cy]);
  });

  onCleanup(() => scene.onBeforeRenderObservable.remove(obs));

  return {
    pos,
    setTarget(x: number, y: number) {
      tx = x;
      ty = y;
    },
    snap(x: number, y: number) {
      tx = x; ty = y;
      cx = x; cy = y;
      vx = 0; vy = 0;
      setPos([x, y]);
    },
  };
}
