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
import { SOLID } from "./objects/look";
import { BLUEPRINTS, KINDS, plot } from "../blueprints";
import type { EngineContext } from "./Canvas";
import type { Culler } from "./cull";
import type { Building, BuildingKind, GameObjectEntry, RoadNode } from "../generated";

/** A picture's side, in pixels, and the sheet's columns. */
const CELL = 256;
const COLUMNS = 4;
/** Noon: every picture in the one light. */
const NOON = 0.5;
/** The lens: narrow, so a picture is nearly the plan, with a little depth. */
const FOV = 0.35;

const [taken, setTaken] = createSignal<ReadonlySet<BuildingKind>>(new Set());

/** A kind's picture in the sheet, its corners 0–1, once it is taken. */
export function photo(kind: BuildingKind): [number, number, number, number] | undefined {
  if (!taken().has(kind)) return undefined;
  const i = KINDS.indexOf(kind);
  const rows = Math.ceil(KINDS.length / COLUMNS);
  const [x, y] = [i % COLUMNS, Math.floor(i / COLUMNS)];
  return [x / COLUMNS, y / rows, (x + 1) / COLUMNS, (y + 1) / rows];
}

/**
 * The build menu's pictures, taken by the game itself: a scene of its own
 * on a canvas off the page, lit as the town at noon (`daylight`), where
 * the town grid draws each kind in turn on a street of its own, as the
 * town would (`TownLayer`), and a frame of it is copied into a sheet the
 * menu cuts them from (`ui/Build.tsx`). Nothing round it: the picture is
 * the building, its lot and its street, on the black. One kind a frame
 * of spare time, once, after the town has come in.
 */
export function createStudio(main: Engine, show: (sheet: GPUTexture) => void) {
  const device = main._device;
  const rows = Math.ceil(KINDS.length / COLUMNS);
  const sheet = device.createTexture({ size: [CELL * COLUMNS, CELL * rows], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
  show(sheet);

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
    await registerSceneWithShadowSupport(scene);
    town = new TownLayer(ctx, lit.casters, (f) => entries.forEach(f), () => "Grass", () => SOLID);
    for (const [i, kind] of KINDS.entries()) {
      if (stopped) return;
      // A harbour is its piers on the sea, which the town grid does not
      // draw: it keeps its icon.
      if (BLUEPRINTS[kind].quay) continue;
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
      const [x, y] = [(i % COLUMNS) * CELL, Math.floor(i / COLUMNS) * CELL];
      device.queue.copyExternalImageToTexture({ source: canvas }, { texture: sheet, origin: [x, y], premultipliedAlpha: true }, [CELL, CELL]);
      setTaken((s) => new Set([...s, kind]));
      await idle();
    }
    town.dispose();
  };

  /** A kind set on its street, facing it, the street south of it. Where
   *  to look, and how far round. */
  const stage = (kind: BuildingKind) => {
    const old = entries;
    const [w, h] = plot(kind, 0).size;
    const [x0, y0] = [0, 1];
    const tiles = Array.from({ length: w * h }, (_, k) => ({ x: x0 + (k % w), y: y0 + Math.floor(k / w) }));
    const front = { x: x0 + Math.floor(w / 2), y: y0 };
    const building: Building = {
      kind, tiles, facing: 0, stocks: {}, site: null, pad: [], outgoing: [], lifts: [], lorries: 0, land: [], ruts: [],
      door: { tile: front, street: { x: front.x, y: y0 - 1 } },
    };
    const street = Array.from({ length: w + 2 }, (_, k) => 100 + k);
    const node = (k: number): RoadNode => ({
      outgoing: [street[k - 1], street[k + 1]].filter((n) => n !== undefined), incoming: [street[k - 1], street[k + 1]].filter((n) => n !== undefined),
      joined: true, road: [], laid: true, height: 0, light: null, wide: [], side: [0, 0],
    });
    entries = [
      { id: 1, position: tiles[0], object: { kind: "Building", data: building } },
      ...street.map((id, k): GameObjectEntry => ({ id, position: { x: x0 - 1 + k, y: y0 - 1 }, object: { kind: "RoadNode", data: node(k) } })),
    ];
    for (const e of [...old, ...entries]) {
      const at = e.object.kind === "Building" ? (e.object.data as Building).tiles : [e.position!];
      for (const t of at) town!.touch(t.x, t.y);
    }
    // The plot and its street, a little round them.
    const half = Math.max(w + 2, h + 1) / 2 + 0.25;
    return { at: [x0 + w / 2, y0 - 1 + (h + 1) / 2] as [number, number], half };
  };

  const timer = setTimeout(() => void shoot(), 4000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** The next moment the browser has nothing better to do. */
const idle = () => new Promise<void>((done) => requestIdleCallback(() => done(), { timeout: 200 }));
