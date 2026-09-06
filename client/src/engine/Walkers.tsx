import { createSignal, onCleanup, onMount } from "solid-js";
import { Color3 } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import { useInstancePool } from "./InstancePool";
import { eachEntity, getEntity } from "../state/gameObjects";
import { boxGeometry } from "./objects/buildings";
import { HALF_W } from "./objects/roadGeometry";
import type { RoadNode } from "../generated";

/**
 * A look at pedestrians, and nothing more: a few hundred walkers wandering
 * the sidewalks of whatever streets are loaded, client-only, with no idea
 * where they are going. Press P to see them. This exists to answer one
 * question — what does a person look like on this map — and goes once it
 * has.
 */
const COUNT = 300;
/** Tiles per second: a brisk walk on twelve-metre tiles. */
const SPEED = 0.12;
/** How far from the middle of the road a sidewalk runs. */
const SIDEWALK = HALF_W + 0.07;
const PALETTE = [
  new Color3(0.9, 0.25, 0.2),
  new Color3(0.2, 0.22, 0.28),
  new Color3(0.25, 0.4, 0.75),
  new Color3(0.55, 0.15, 0.15),
  new Color3(0.2, 0.5, 0.4),
  new Color3(0.8, 0.65, 0.25),
  new Color3(0.95, 0.85, 0.75),
  new Color3(0.4, 0.28, 0.2),
];
const WALKER = boxGeometry(0.09, 0.09, 0.16);

type Walker = { from: number; to: number; t: number; side: 1 | -1; bucket: string; id: number };

const [on, setOn] = createSignal(false);

export default function Walkers() {
  const { scene } = useEngine();
  const pool = useInstancePool();
  let walkers: Walker[] = [];

  const posOf = (id: number) => getEntity(id)?.position;
  const street = (id: number) => {
    const e = getEntity(id);
    return e?.object.kind === "RoadNode" && !(e.object.data as RoadNode).road ? (e.object.data as RoadNode) : null;
  };
  const nextFrom = (node: number, back: number): number | null => {
    const n = street(node);
    if (!n) return null;
    const arms = [...n.outgoing, ...n.incoming].filter((a) => street(a) && posOf(a));
    const onward = arms.filter((a) => a !== back);
    const pick = onward.length ? onward : arms;
    return pick.length ? pick[Math.floor(Math.random() * pick.length)] : null;
  };

  const spawn = () => {
    const nodes: number[] = [];
    eachEntity((e) => { if (e.object.kind === "RoadNode" && !e.object.data.road && e.position) nodes.push(e.id); });
    for (let i = 0; i < COUNT && nodes.length; i++) {
      const from = nodes[Math.floor(Math.random() * nodes.length)];
      const to = nextFrom(from, -1);
      if (to === null) continue;
      const c = Math.floor(Math.random() * PALETTE.length);
      const bucket = `walker${c}`;
      pool.ensureBucket(bucket, WALKER, PALETTE[c], true, true);
      walkers.push({ from, to, t: Math.random(), side: Math.random() < 0.5 ? 1 : -1, bucket, id: pool.addInstance(bucket, [0, 0, -10]) });
    }
  };
  const clear = () => {
    for (const w of walkers) pool.removeInstance(w.bucket, w.id);
    walkers = [];
  };

  let last = performance.now();
  const step = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!on()) return;
    for (const w of walkers) {
      const a = posOf(w.from), b = posOf(w.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      w.t += (SPEED * dt) / len;
      if (w.t >= 1) {
        const next = nextFrom(w.to, w.from);
        if (next === null) { w.t = 1; continue; }
        w.from = w.to; w.to = next; w.t = 0;
        continue;
      }
      // Along the edge, offset to one side: the sidewalk.
      const nx = (-dy / len) * SIDEWALK * w.side, ny = (dx / len) * SIDEWALK * w.side;
      pool.updateInstance(w.bucket, w.id, [a.x + 0.5 + dx * w.t + nx, a.y + 0.5 + dy * w.t + ny, 0.08], [0, 0, 0]);
    }
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "p") return;
      setOn((v) => !v);
      if (on()) spawn(); else clear();
    };
    window.addEventListener("keydown", onKey);
    const obs = scene.onBeforeRenderObservable.add(step);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      scene.onBeforeRenderObservable.remove(obs);
      clear();
    });
  });

  return <></>;
}
