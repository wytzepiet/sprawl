import { createSignal } from "solid-js";
import {
  createFreeCamera,
  createSceneContext,
  createSurface,
  enableMaterialPlugins,
  registerSceneWithShadowSupport,
  renderFrame,
  setMeshVisible,
  type EngineContext as Engine,
} from "@babylonjs/lite";
import { daylight } from "./DayNightCycle";
import { TILT } from "./Camera";
import { TownLayer } from "./TownLayer";
import { GroundTiles } from "./ground";
import { theme } from "./theme";
import { LAYERS, shapeKey } from "./objects/terrainGeometry";
import { SOLID } from "./objects/look";
import { BLUEPRINTS, KINDS, plot } from "../blueprints";
import type { EngineContext } from "./Canvas";
import type { Culler } from "./cull";
import type { Building, BuildingKind, GameObjectEntry, RoadNode } from "../generated";

/** A picture's side, in pixels. */
const CELL = 256;
/** Noon: every picture in the one light. */
const NOON = 0.5;
/** The lens: narrow, so a picture is nearly the plan, with a little depth. */
const FOV = 0.35;
/** How far the street runs each way, in tiles: off any picture. */
const STREET = 12;
/** Room round a plot in its picture, in tiles: as far as the street. */
const MARGIN = 0.9;
/** The grass's layer of the land, and a tile of it with grass all round. */
const GRASS = 2;
const INSIDE = shapeKey({ base: "+", corners: [null, null, null, null], across: Array(8).fill("+"), near: Array(8).fill(null) });

const [taken, setTaken] = createSignal<Partial<Record<BuildingKind, string>>>({});

/** A kind's picture, once it is taken: where the page finds it. */
export const photo = (kind: BuildingKind) => taken()[kind];

/**
 * The build menu's pictures, taken by the game itself: a scene of its own
 * on a canvas off the page, lit as the town at noon (`daylight`), where
 * the town grid draws each kind in turn on a street of its own, as the
 * town would (`TownLayer`), and a frame of it kept as a picture for the
 * menu (`ui/Build.tsx`). Nothing round it: the picture is
 * the building, its lot and its street, on grass. One kind a frame
 * of spare time, once, after the town has come in.
 */
export function createStudio(main: Engine) {
  const canvas = new OffscreenCanvas(CELL, CELL);
  const surface = createSurface(main, canvas, { alphaMode: "premultiplied" });
  const scene = createSceneContext(surface);
  scene.clearColor = { r: 0, g: 0, b: 0, a: 0 };
  enableMaterialPlugins(scene);
  const camera = createFreeCamera({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0 });
  camera.fov = FOV;
  camera.nearPlane = 1;
  camera.farPlane = 400;
  scene.camera = camera;
  const lit = daylight(main, scene, 1024);

  // The kind in front of the lens: a building and the street before it.
  let entries: GameObjectEntry[] = [];
  const before = new Set<() => void>();
  // Everything in the frame is drawn: nothing to cull.
  const cull = { keep: () => {}, want: (mesh: Parameters<typeof setMeshVisible>[0], wanted: boolean) => setMeshVisible(mesh, wanted), forget: () => {} } as unknown as Culler;
  const ctx = {
    engine: main,
    scene,
    canvas: canvas as unknown as HTMLCanvasElement,
    beforeRender: (fn: () => void) => (before.add(fn), () => void before.delete(fn)),
    afterRender: () => () => {},
    cull,
    prepare: () => {},
    registered: () => true,
  } as unknown as EngineContext;

  let town: TownLayer | null = null;
  let stopped = false;

  const shoot = async () => {
    // A harbour is its piers on the sea, which the town grid does not
    // draw: it keeps its icon. A kind taken once, on a page before, is kept.
    const kinds = KINDS.filter((kind) => !BLUEPRINTS[kind].quay && !taken()[kind]);
    if (!kinds.length) return;
    await registerSceneWithShadowSupport(scene);
    town = new TownLayer(ctx, lit.casters, (f) => entries.forEach(f), () => "Grass", () => SOLID);
    lawn();
    // The first picture is taken twice: what the scene draws, its light
    // and sky, is still being built the first time.
    for (const [n, kind] of [kinds[0], ...kinds].entries()) {
      if (stopped) return;
      const { at, half } = stage(kind);
      // Asked to draw, then drawn: the chunks come in a frame at a time.
      while (!town.settled && !stopped) await idle();
      const [cx, cy] = at;
      // Leaning back as the game's camera does (`Camera.tsx`).
      const d = half / Math.tan(FOV / 2);
      camera.position.set(cx, cy - d * Math.sin(TILT), d * Math.cos(TILT));
      camera.target.set(cx, cy, 0);
      for (const fn of before) fn();
      lit.at(NOON, cx, cy, half * 2);
      // The shadow pass waits for a new set of casters to load, and a
      // frame drawn before it is all in shade.
      while (lit.shadows._preloadPending && !stopped) await idle();
      renderFrame(main, 16, [surface]);
      if (n === 0) continue;
      // Kept as the frame stands, before the next is drawn over it.
      const url = URL.createObjectURL(await canvas.convertToBlob());
      setTaken((t) => ({ ...t, [kind]: url }));
      await idle();
    }
    town.dispose();
  };

  // The street, the same for every kind and longer than any picture is
  // wide, so it runs off both sides; and the grass under it all.
  const street = Array.from({ length: 2 * STREET + 1 }, (_, k) => 100 + k);
  const node = (k: number): RoadNode => {
    const by = [street[k - 1], street[k + 1]].filter((n) => n !== undefined);
    return { outgoing: by, incoming: by, joined: true, road: [], laid: true, height: 0, light: null, wide: [], side: [0, 0] };
  };
  const road = street.map((id, k): GameObjectEntry => ({ id, position: { x: k - STREET, y: 0 }, object: { kind: "RoadNode", data: node(k) } }));
  const lawn = () => {
    const ground = new GroundTiles(main, scene, ctx.beforeRender, cull);
    ground.paint([theme.beach, theme.rock, theme.land, theme.forest]);
    const side = 2 * STREET;
    const at = new Float32Array(side * side * 2).map((_, k) => (k % 2 ? Math.floor(k / 2 / side) : (k / 2) % side) - STREET);
    ground.set("studio", [0, 0], LAYERS.map((_, l) => (l === GRASS ? { at, shapes: Array(side * side).fill(INSIDE) } : { at: new Float32Array(), shapes: [] })));
    for (const e of road) town!.touch(e.position!.x, e.position!.y);
  };

  /** A kind set on the street, facing it, the street south of it: where
   *  to look, and how far round, the plot filling the picture. */
  const stage = (kind: BuildingKind) => {
    const old = entries;
    const [w, h] = plot(kind, 0).size;
    const x0 = -Math.floor(w / 2);
    const tiles = Array.from({ length: w * h }, (_, k) => ({ x: x0 + (k % w), y: 1 + Math.floor(k / w) }));
    const front = { x: 0, y: 1 };
    const building: Building = {
      kind, tiles, facing: 0, stocks: {}, site: null, pad: [], outgoing: [], lifts: [], lorries: 0, land: [], ruts: [],
      door: { tile: front, street: { x: 0, y: 0 } },
    };
    entries = [{ id: 1, position: tiles[0], object: { kind: "Building", data: building } }, ...road];
    for (const e of old.slice(0, 1).concat(entries.slice(0, 1))) for (const t of (e.object.data as Building).tiles) town!.touch(t.x, t.y);
    // The plot as near the middle as the street along the bottom lets
    // it, a little round it.
    const half = Math.max(w, h) / 2 + MARGIN;
    return { at: [x0 + w / 2, half - 0.1] as [number, number], half };
  };

  const timer = setTimeout(() => void shoot(), 4000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** The next moment the browser has nothing better to do. */
const idle = () => new Promise<void>((done) => requestIdleCallback(() => done(), { timeout: 200 }));
