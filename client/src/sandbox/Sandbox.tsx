import { createSignal, For, onCleanup, onMount } from "solid-js";
import { Color3, Mesh, MeshBuilder, StandardMaterial, Vector3, VertexData, type Scene } from "@babylonjs/core";
import Canvas, { useEngine } from "../engine/Canvas";
import { OrthoCamera } from "../engine/OrthoCamera";
import DayNightLights, { DayNightProvider, useDayNight } from "../engine/DayNightCycle";
import { ThemeProvider, useTheme, type Theme } from "../engine/theme";
import { OfflineGame } from "../state/gameObjects";
import { syncClock } from "../network/clock";
import { BLUEPRINTS } from "../blueprints";
import { buildRoadGeometry, BORDER_HALF_W, BORDER_Z, HALF_W, ROAD_Z, type ArmInfo } from "../engine/objects/roadGeometry";
import type { MeshGeometry } from "../engine/Mesh";
import { isBuilt, LETTERS, parseTown, tileOf, townOf, type Tile, type Town } from "../engine/town/grid";
import { complete, paintable, PROGRAMS, touching, type Cell } from "../engine/town/brush";
import type { BuildingKind } from "../generated";
import { formOf } from "../engine/town/mass";
import { townMesh as mesh } from "../engine/town/roof";

/**
 * A town with no server: the fixtures, or a grid painted by hand, drawn the
 * way the game draws them, so the look can be worked on alone. At noon, and
 * still.
 *
 *   /sandbox?f=<fixture>      open a fixture
 *
 * Paint with the left button, pan with the right. A building's brush
 * paints strokes that are completed to a working building as they are
 * painted (`engine/town/brush.ts`): the ghost is what letting go builds, and
 * the lit tiles are where it can grow. The brushes are on the bar, and on
 * the keys beside them. "Copy" puts the map on the clipboard as a
 * fixture's text.
 */
const FIXTURES: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob<string>("../../../server/fixtures/*.txt", { query: "?raw", import: "default", eager: true })).map(
    ([path, text]) => [path.split("/").pop()!.replace(/\.txt$/, ""), text],
  ),
);

const BRUSHES: { key: string; ch: string; label: string }[] = [
  { key: "1", ch: "H", label: "House" }, { key: "2", ch: "A", label: "Flats" }, { key: "3", ch: "S", label: "Shop" },
  { key: "4", ch: "O", label: "Office" }, { key: "5", ch: "F", label: "Factory" }, { key: "d", ch: "D", label: "Depot" }, { key: "m", ch: "M", label: "Supermarket" },
  { key: "6", ch: "=", label: "Street" }, { key: "7", ch: "#", label: "Road" }, { key: "p", ch: ":", label: "Paved" },
  { key: "8", ch: "~", label: "Water" }, { key: "9", ch: "T", label: "Wood" },
  { key: "0", ch: ".", label: "Clear" }, { key: "+", ch: "+", label: "Taller" }, { key: "-", ch: "-", label: "Lower" },
];

export default function Sandbox() {
  syncClock(60_000, 0, 120_000);
  return (
    <ThemeProvider>
      <DayNightProvider>
        <OfflineGame>
          <Canvas>
            <OrthoCamera />
            <DayNightLights>
              <Board />
            </DayNightLights>
          </Canvas>
        </OfflineGame>
      </DayNightProvider>
    </ThemeProvider>
  );
}

function Board() {
  const { scene, canvas } = useEngine();
  const { shadowGenerator } = useDayNight();
  const theme = useTheme();
  const params = new URLSearchParams(location.search);
  const [name, setName] = createSignal(params.get("f") ?? Object.keys(FIXTURES)[0]);
  const [brush, setBrush] = createSignal("H");

  let rows: string[] = [];
  let tiles: Tile[][] = [];
  let through: boolean[][] = [];
  let drawn: Mesh[] = [];

  const town = (): Town => townOf(tiles, (c, r) => !!through[r]?.[c]);

  function load(fixture: string) {
    const t = parseTown(FIXTURES[fixture] ?? "");
    rows = t.rows;
    tiles = Array.from({ length: t.h }, (_, r) => Array.from({ length: t.w }, (_, c) => t.tile(c, r)));
    through = Array.from({ length: t.h }, (_, r) => Array.from({ length: t.w }, (_, c) => t.through(c, r)));
    draw();
    const cam = (window as unknown as { sprawlCamera?: { look(x: number, y: number, half: number): void } }).sprawlCamera;
    const aspect = canvas.width / canvas.height || 1.5;
    cam?.look(-t.w / 2, -t.h / 2, Math.max(t.h / 2, t.w / 2 / aspect) + 2);
  }

  function draw() {
    for (const m of drawn) m.dispose();
    drawn = build(scene, town(), theme());
    for (const m of drawn) {
      m.receiveShadows = true;
      if (m.name === "mass") shadowGenerator()?.addShadowCaster(m);
    }
  }

  // Painting. A brush of a building kind paints strokes: what is painted is
  // completed, as it is painted, to the smallest working building holding
  // it, shown as a ghost, and the tiles it may take next are lit. Letting
  // go builds it. Any other brush paints each tile it passes. The left
  // button is the brush's; the right one still pans.
  let stroke: Cell[] = [];
  /** The building a stroke grows, if it began beside one of its kind. */
  let base: Cell[] = [];
  const whole = () => [...base, ...stroke];
  let stroking = false;
  let hover: Cell | null = null;
  let overlay: Mesh[] = [];
  const program = () => PROGRAMS[LETTERS[brush()]];
  const has = (cells: Cell[], [c, r]: Cell) => cells.some(([x, y]) => x === c && y === r);

  /** Each stroke is a building of its own, unless it grows one. */
  let ids = 0;
  const idOf = () => (base.length ? tiles[base[0][1]][base[0][0]].id : undefined) ?? ++ids;

  function set(c: number, r: number, ch: string, id?: number) {
    if (!tiles[r]?.[c]) return;
    tiles[r][c] = { ...tileOf(ch), id };
    through[r][c] = ch === "#";
    rows[r] = rows[r].slice(0, c).padEnd(c, ".") + ch + rows[r].slice(c + 1);
  }

  /** What a stroke would build, and the tiles it could take next. */
  function plan() {
    const p = program();
    if (!p) return { ghost: null, next: [] as Cell[] };
    const t = town();
    const kind = LETTERS[brush()];
    const seed = (cell: Cell) => (stroke.length ? whole() : touching(t, kind, cell));
    const ghost = complete(t, p, stroke.length ? whole() : hover && paintable(t, p, ...hover) ? [...seed(hover), hover] : []);
    const next: Cell[] = [];
    for (let r = 0; r < t.h; r++) {
      for (let c = 0; c < t.w; c++) {
        if (has(stroke, [c, r]) || !paintable(t, p, c, r)) continue;
        if (complete(t, p, [...seed([c, r]), [c, r]])) next.push([c, r]);
      }
    }
    return { ghost, next };
  }

  function drawOverlay() {
    for (const m of overlay) m.dispose();
    overlay = [];
    const { ghost, next } = plan();
    const t = town();
    const lit = quadsAt(next, 0.012);
    if (lit.indices.length) overlay.push(translucent(scene, "next", lit, Color3.White(), 0.35));
    if (ghost) {
      const grown = stroke.length ? base : touching(t, LETTERS[brush()], hover ?? ghost[0]);
      const id = grown.length ? tiles[grown[0][1]][grown[0][0]].id : -1;
      const shown = townOf(tiles.map((row, r) => row.map((tile, c) => (has(ghost, [c, r]) ? { ...tileOf(brush()), id } : tile))), (c, r) => t.through(c, r));
      const geo = mesh(shown, colourOf, new Set(ghost.map(([c, r]) => `${c},${r}`)));
      if (geo.indices.length) overlay.push(translucent(scene, "ghost", geo, Color3.White(), 0.75));
    } else if (hover && program()) {
      overlay.push(translucent(scene, "nope", quadsAt([hover], 0.014), new Color3(0.85, 0.25, 0.2), 0.5));
    }
  }

  const tileAt = (e: PointerEvent): Cell | null => {
    const hit = scene.pick(e.offsetX, e.offsetY, (m) => m.name === "ground");
    return hit?.pickedPoint ? [Math.floor(-hit.pickedPoint.x), Math.floor(-hit.pickedPoint.y)] : null;
  };

  function touch(cell: Cell) {
    const [c, r] = cell;
    const p = program();
    if (p) {
      if (has(stroke, cell) || !paintable(town(), p, c, r) || !complete(town(), p, [...whole(), cell])) return;
      stroke = [...stroke, cell];
      return drawOverlay();
    }
    const t = tiles[r]?.[c];
    if (!t) return;
    const ch = brush();
    if (ch === "+" || ch === "-") {
      if (t.storeys > 0) t.storeys = Math.max(1, t.storeys + (ch === "+" ? 1 : -1));
    } else set(c, r, ch);
    draw();
  }

  const onDown = (e: PointerEvent) => {
    if (e.target !== canvas || e.button !== 0) return;
    // The brush's, not the camera's: it would pan on the drag.
    e.stopPropagation();
    stroking = true;
    stroke = [];
    const cell = tileAt(e);
    base = cell && program() ? touching(town(), LETTERS[brush()], cell) : [];
    if (cell) touch(cell);
  };
  const onMove = (e: PointerEvent) => {
    const cell = tileAt(e);
    if (!cell || (hover && hover[0] === cell[0] && hover[1] === cell[1])) return;
    hover = cell;
    if (stroking) touch(cell);
    else if (program()) drawOverlay();
  };
  const onUp = () => {
    if (!stroking) return;
    stroking = false;
    const p = program();
    const built = p && stroke.length && complete(town(), p, whole());
    const id = idOf();
    stroke = [];
    base = [];
    if (built) for (const [c, r] of built) set(c, r, brush(), id);
    draw();
    drawOverlay();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "g") {
      showGrid = !showGrid;
      const grid = scene.getMeshByName("grid");
      if (grid) grid.isVisible = showGrid;
      return;
    }
    const b = BRUSHES.find((b) => b.key === e.key);
    if (b) setBrush(b.ch), drawOverlay();
  };
  onMount(() => {
    window.addEventListener("pointerdown", onDown, { capture: true });
    canvas.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    // The camera is ready a frame after the canvas.
    requestAnimationFrame(() => load(name()));
  });
  onCleanup(() => {
    window.removeEventListener("pointerdown", onDown, { capture: true });
    canvas.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("keydown", onKey);
    for (const m of [...drawn, ...overlay]) m.dispose();
  });

  const bar = "position:fixed;left:12px;top:12px;display:flex;gap:6px;flex-wrap:wrap;font:13px system-ui;z-index:10";
  const button = (on: boolean) =>
    `padding:4px 8px;border-radius:6px;border:1px solid #0002;background:${on ? "#222" : "#fffe"};color:${on ? "#fff" : "#222"};cursor:pointer`;
  return (
    <div style={bar}>
      <select style={button(false)} value={name()} onChange={(e) => (setName(e.currentTarget.value), load(e.currentTarget.value))}>
        <For each={Object.keys(FIXTURES)}>{(f) => <option value={f}>{f}</option>}</For>
      </select>
      <For each={BRUSHES}>
        {(b) => (
          <button style={button(brush() === b.ch)} onClick={() => (setBrush(b.ch), drawOverlay())}>
            {b.label} <small style="opacity:.5">{b.key}</small>
          </button>
        )}
      </For>
      <button style={button(false)} onClick={() => navigator.clipboard.writeText(`# ${name()}, painted\n${rows.join("\n")}\n`)}>
        Copy
      </button>
    </div>
  );
}

const colourOf = (k: BuildingKind): [number, number, number] => {
  const c = Color3.FromHexString(BLUEPRINTS[k].color);
  return [c.r, c.g, c.b];
};

/** Flat squares on some tiles, a little over the ground. */
function quadsAt(cells: Cell[], z: number): MeshGeometry {
  const g: MeshGeometry = { positions: [], normals: [], indices: [] };
  for (const [c, r] of cells) {
    const b = g.positions.length / 3;
    for (const [dx, dy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) g.positions.push(-(c + dx), -(r + dy), z), g.normals.push(0, 0, 1);
    g.indices.push(b, b + 2, b + 1, b, b + 3, b + 2);
  }
  return g;
}

/** A see-through mesh, for what is not built yet. */
function translucent(scene: Scene, name: string, geo: MeshGeometry & { colors?: number[] }, colour: Color3, alpha: number): Mesh {
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  Object.assign(vd, { positions: geo.positions, indices: geo.indices, normals: geo.normals, colors: geo.colors ?? null });
  vd.applyToMesh(mesh);
  const mat = new StandardMaterial(`${name}_mat`, scene);
  mat.diffuseColor = colour;
  mat.specularColor = Color3.Black();
  mat.alpha = alpha;
  mesh.material = mat;
  return mesh;
}

/** Everything a town is drawn with: the ground, water and woods, the
 *  roads, and the buildings. */
/** Just over the roads, under every building. */
const GRID_Z = 0.03;
let showGrid = true;

function build(scene: Scene, town: Town, theme: Theme): Mesh[] {
  const meshes: Mesh[] = [];
  const add = (name: string, geo: MeshGeometry & { colors?: number[] }, colour: Color3) => {
    if (!geo.indices.length) return;
    const mesh = new Mesh(name, scene);
    const vd = new VertexData();
    Object.assign(vd, { positions: geo.positions, indices: geo.indices, normals: geo.normals, colors: geo.colors ?? null });
    vd.applyToMesh(mesh);
    const mat = new StandardMaterial(`${name}_mat`, scene);
    mat.diffuseColor = colour;
    mat.specularColor = Color3.Black();
    mesh.material = mat;
    meshes.push(mesh);
  };

  // The ground: a sheet under it all to take the shadows and the clicks.
  const ground = MeshBuilder.CreateGround("ground", { width: town.w + 40, height: town.h + 40 }, scene);
  ground.rotation.x = Math.PI / 2;
  ground.position.set(-town.w / 2, -town.h / 2, 0);
  const gm = new StandardMaterial("ground_mat", scene);
  gm.diffuseColor = new Color3(theme.land.r, theme.land.g, theme.land.b);
  gm.specularColor = Color3.Black();
  ground.material = gm;
  meshes.push(ground);

  // Water, woods a shade darker, and
  // paving, a car park's or under a building whose form leaves a yard.
  const quads = (on: (t: Tile) => boolean, z: number) => {
    const g: MeshGeometry = { positions: [], normals: [], indices: [] };
    for (let r = 0; r < town.h; r++) {
      for (let c = 0; c < town.w; c++) {
        if (!on(town.tile(c, r))) continue;
        const b = g.positions.length / 3;
        for (const [dx, dy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) g.positions.push(-(c + dx), -(r + dy), z), g.normals.push(0, 0, 1);
        g.indices.push(b, b + 2, b + 1, b, b + 3, b + 2);
      }
    }
    return g;
  };
  add("water", quads((t) => t.kind === "water", 0.002), theme.water);
  add("wood", quads((t) => t.kind === "wood", 0.004), theme.forest);
  add("paved", quads((t) => t.kind === "paved" || (isBuilt(t) && formOf(t).yard === "paved"), 0.006), theme.paved);

  // Roads, as the game lays them: each tile's arms to the tiles it is joined to.
  const roads = { street: [[], []] as MeshGeometry[][], through: [[], []] as MeshGeometry[][] };
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (town.tile(c, r).kind !== "road") continue;
      const arms: ArmInfo[] = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if ((dc || dr) && town.linked(c, r, c + dc, r + dr)) {
            const a = Math.atan2(-dr, -dc);
            arms.push({ angle: a < 0 ? a + 2 * Math.PI : a, flow: "twoway" });
          }
        }
      }
      const into = roads[town.through(c, r) ? "through" : "street"];
      for (const [k, geo] of [buildRoadGeometry(arms, BORDER_HALF_W, BORDER_Z), buildRoadGeometry(arms, HALF_W, ROAD_Z)].entries()) {
        if (!geo) continue;
        const p = geo.positions.slice();
        for (let i = 0; i < p.length; i += 3) (p[i] -= c + 0.5), (p[i + 1] -= r + 0.5);
        into[k].push({ ...geo, positions: p });
      }
    }
  }
  const merge = (gs: MeshGeometry[]): MeshGeometry => {
    const out: MeshGeometry = { positions: [], normals: [], indices: [] };
    for (const g of gs) {
      const b = out.positions.length / 3;
      out.positions.push(...g.positions);
      out.normals.push(...g.normals);
      out.indices.push(...g.indices.map((i) => i + b));
    }
    return out;
  };
  add("street_kerb", merge(roads.street[0]), theme.roadBorder);
  add("street", merge(roads.street[1]), theme.road);
  add("through_kerb", merge(roads.through[0]), theme.highwayBorder);
  add("through", merge(roads.through[1]), theme.highway);

  add("mass", mesh(town, colourOf), Color3.White());

  // The tiles' grid, faint, over the ground and under the buildings: `g`
  // hides it.
  const lines: Vector3[][] = [];
  for (let c = 0; c <= town.w; c++) lines.push([new Vector3(-c, 0, GRID_Z), new Vector3(-c, -town.h, GRID_Z)]);
  for (let r = 0; r <= town.h; r++) lines.push([new Vector3(0, -r, GRID_Z), new Vector3(-town.w, -r, GRID_Z)]);
  const grid = MeshBuilder.CreateLineSystem("grid", { lines }, scene);
  grid.color = Color3.Black();
  grid.alpha = 0.18;
  grid.isPickable = false;
  grid.metadata = { inked: false };
  grid.isVisible = showGrid;
  meshes.push(grid);
  return meshes;
}

