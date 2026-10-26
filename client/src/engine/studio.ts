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

/** A picture's side, in pixels, and the sheet's columns. */
const CELL = 256;
const COLUMNS = 4;
/** Noon: every picture in the one light. */
const NOON = 0.5;
/** The lens: narrow, so a picture is nearly the plan, with a little depth. */
const FOV = 0.35;
/** Frames drawn before the first picture, while what it draws is built. */
const WARM = 10;
/** How far the street runs each way, in tiles: off any picture. */
const STREET = 12;
/** Room round a plot in its picture, in tiles. */
const MARGIN = 0.4;
/** The grass's layer of the land, and a tile of it with grass all round. */
const GRASS = 2;
const INSIDE = shapeKey({ base: "+", corners: [null, null, null, null], across: Array(8).fill("+"), near: Array(8).fill(null) });

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
 * the building, its lot and its street, on grass. One kind a frame
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
    lawn();
    let first = true;
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
      // What the scene draws first is built over a few frames, and shows
      // nothing until it is.
      for (let n = 0; first && n < WARM; n++) renderFrame(main, 16, [surface]), await idle();
      first = false;
      renderFrame(main, 16, [surface]);
      const [x, y] = [(i % COLUMNS) * CELL, Math.floor(i / COLUMNS) * CELL];
      device.queue.copyExternalImageToTexture({ source: canvas }, { texture: sheet, origin: [x, y], premultipliedAlpha: true }, [CELL, CELL]);
      setTaken((s) => new Set([...s, kind]));
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
    // The plot and the street before it, a little round them.
    const half = Math.max(w, h + 1) / 2 + MARGIN;
    return { at: [x0 + w / 2, (h + 1) / 2] as [number, number], half };
  };

  const timer = setTimeout(() => void shoot(), 4000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** The next moment the browser has nothing better to do. */
const idle = () => new Promise<void>((done) => requestIdleCallback(() => done(), { timeout: 200 }));
