import { createSignal, For, onCleanup, onMount } from "solid-js";
import { Color3, Mesh, MeshBuilder, StandardMaterial, Vector3, VertexData, type Scene } from "@babylonjs/core";
import Canvas, { useEngine } from "../engine/Canvas";
import { OrthoCamera } from "../engine/OrthoCamera";
import DayNightLights, { DayNightProvider, useDayNight } from "../engine/DayNightCycle";
import { BevelPlugin, bevelled, giveBevel, lacquer } from "../engine/bevel";
import { ThemeProvider, useTheme, type Theme } from "../engine/theme";
import { OfflineGame } from "../state/gameObjects";
import { syncClock } from "../network/clock";
import { BLUEPRINTS } from "../blueprints";
import type { RGB } from "../engine/town/mass";
import { CAB, CAR, TRAILER } from "../engine/objects/roadGeometry";
import type { MeshGeometry } from "../engine/Mesh";
import { LETTERS, parseTown, tileOf, townOf, type Tile, type Town } from "../engine/town/grid";
import { complete, paintable, PROGRAMS, touching, type Cell } from "../engine/town/brush";
import type { BuildingKind, TerrainType } from "../generated";
import { townMesh as mesh } from "../engine/town/roof";
import { defaultJoins } from "../engine/town/footprint";
import { buildChunk, CHUNK_SIZE, CHUNK_SKIRT, CHUNK_STRIDE, TYPE_BY_BYTE, type TerrainPalette } from "../engine/objects/terrainGeometry";
import { FERRY } from "../engine/town/dressing";
import { drawRoads, drawTown, quadsAt, runsOn, treeInstances } from "../engine/town/draw";
import { grove, plant } from "../engine/trees";
import { extentOf, kerbed, kerbField, kerbsOf } from "../engine/kerbs";

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
  { key: "4", ch: "O", label: "Office" }, { key: "5", ch: "F", label: "Factory" }, { key: "d", ch: "D", label: "Depot" }, { key: "m", ch: "M", label: "Supermarket" }, { key: "f", ch: "P", label: "Ferry port" },
  { key: "6", ch: "=", label: "Street" }, { key: "7", ch: "#", label: "Road" }, { key: "p", ch: ":", label: "Paved" },
  { key: "8", ch: "~", label: "Water" }, { key: "9", ch: "T", label: "Wood" },
  { key: "0", ch: ".", label: "Clear" }, { key: "+", ch: "+", label: "Taller" }, { key: "-", ch: "-", label: "Lower" },
];

export default function Sandbox() {
  // Noon, or the time of day `?t=` names (0 midnight, 0.5 noon), stopped.
  syncClock(Number(new URLSearchParams(location.search).get("t") ?? 0.5) * 120_000, 0, 120_000);
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

  /** Which tiles are joined into one building, as the strokes ran; null
   *  until the first stroke, the look joining by kind till then. */
  let joins: Set<string> | null = null;
  const jkey = (c: number, r: number, x: number, y: number) => (c < x || (c === x && r < y) ? `${c},${r}:${x},${y}` : `${x},${y}:${c},${r}`);
  const joinsOf = (set: Set<string>) => (c: number, r: number, x: number, y: number) => set.has(jkey(c, r, x, y));
  const town = (): Town => townOf(tiles, (c, r) => !!through[r]?.[c], [], joins ? joinsOf(joins) : undefined);
  /** The joins the look makes by kind, written down: where strokes begin. */
  function fixed(t: Town): Set<string> {
    const j = defaultJoins(t);
    const out = new Set<string>();
    for (let r = 0; r < t.h; r++) for (let c = 0; c < t.w; c++) for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) if (j(c, r, c + dx, r + dy)) out.add(jkey(c, r, c + dx, r + dy));
    return out;
  }
  /** The joins a stroke makes: each tile to the next it ran on to, beside
   *  or on the diagonal, whether new or already the building's, and the
   *  tiles completion added to their neighbours. A diagonal crosses
   *  anything but a street or another building's diagonal. */
  function strokeJoins(t: Town, cells: Cell[]): Set<string> {
    const out = new Set<string>();
    const joined = t.joins ?? defaultJoins(t);
    const near = (a: Cell, b: Cell) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) === 1;
    const link = (a: Cell, b: Cell) => {
      const [p, q]: Cell[] = [[b[0], a[1]], [a[0], b[1]]];
      const crossed = t.linked(...p, ...q) || ((joined(...p, ...q) || joined(...q, ...p)) && !has(cells, p));
      if (a[0] !== b[0] && a[1] !== b[1] && crossed) return;
      out.add(jkey(a[0], a[1], b[0], b[1]));
    };
    for (let i = 1; i < stroke.length; i++) if (near(stroke[i - 1], stroke[i])) link(stroke[i - 1], stroke[i]);
    for (const a of cells) {
      if (has(stroke, a) || has(base, a)) continue;
      for (const b of cells) if (near(a, b) && (a[0] === b[0] || a[1] === b[1])) link(a, b);
    }
    return out;
  }

  function load(fixture: string) {
    const t = parseTown(FIXTURES[fixture] ?? "");
    rows = t.rows;
    tiles = Array.from({ length: t.h }, (_, r) => Array.from({ length: t.w }, (_, c) => t.tile(c, r)));
    through = Array.from({ length: t.h }, (_, r) => Array.from({ length: t.w }, (_, c) => t.through(c, r)));
    joins = null;
    draw();
    const cam = (window as unknown as { sprawlCamera?: { look(x: number, y: number, half: number): void } }).sprawlCamera;
    const aspect = canvas.width / canvas.height || 1.5;
    cam?.look(-t.w / 2, -t.h / 2, Math.max(t.h / 2, t.w / 2 / aspect) + 2);
  }

  function draw() {
    for (const m of drawn) m.dispose();
    drawn = build(scene, town(), theme(), rows);
    for (const m of drawn) {
      // A tree casts its shadow from body and top; its top takes the others'.
      m.receiveShadows = !m.name.endsWith("tree_bodies");
      if (m.name === "mass" || /tree_(bodies|tops)$/.test(m.name)) shadowGenerator()?.addShadowCaster(m);
    }
  }

  // Painting. A brush of a building kind paints strokes: what is painted is
  // completed, as it is painted, to the smallest working building holding
  // it, shown as a ghost, and the tiles it may take next are lit. Letting
  // go builds it. Any other brush paints each tile it passes. The left
  // button is the brush's; the right one still pans.
  let stroke: Cell[] = [];
  /** The building a stroke grows, if it began on one of its kind. */
  let base: Cell[] = [];
  const whole = () => [...base, ...stroke.filter((c) => !has(base, c))];
  let stroking = false;
  let hover: Cell | null = null;
  let overlay: Mesh[] = [];
  const program = () => PROGRAMS[LETTERS[brush()]];
  const has = (cells: Cell[], [c, r]: Cell) => cells.some(([x, y]) => x === c && y === r);

  function set(c: number, r: number, ch: string) {
    if (!tiles[r]?.[c]) return;
    // What is painted over leaves the building it was part of.
    if (joins) for (const k of [...joins]) if (k.startsWith(`${c},${r}:`) || k.endsWith(`:${c},${r}`)) joins.delete(k);
    tiles[r][c] = tileOf(ch);
    through[r][c] = ch === "#";
    rows[r] = rows[r].slice(0, c).padEnd(c, ".") + ch + rows[r].slice(c + 1);
  }

  /** What a stroke would build, and the tiles it could take next. */
  function plan() {
    const p = program();
    if (!p) return { ghost: null, next: [] as Cell[] };
    const t = town();
    const seed = () => (stroke.length ? whole() : []);
    const ghost = complete(t, p, stroke.length ? whole() : hover && paintable(t, p, ...hover) ? [hover] : []);
    const next: Cell[] = [];
    for (let r = 0; r < t.h; r++) {
      for (let c = 0; c < t.w; c++) {
        if (has(stroke, [c, r]) || !paintable(t, p, c, r)) continue;
        if (complete(t, p, [...seed(), [c, r]])) next.push([c, r]);
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
      const ghostTiles = tiles.map((row, r) => row.map((tile, c) => (has(ghost, [c, r]) ? tileOf(brush()) : tile)));
      const all = joins ?? fixed(t);
      const shown = townOf(ghostTiles, (c, r) => t.through(c, r), [], joinsOf(new Set([...all, ...strokeJoins(t, ghost)])));
      const geo = mesh(shown, colourOf, new Set(ghost.map(([c, r]) => `${c},${r}`)));
      if (geo.indices.length) overlay.push(translucent(scene, "ghost", geo, Color3.White(), 0.75));
    } else if (hover && program()) {
      overlay.push(translucent(scene, "nope", quadsAt([hover], 0.014), new Color3(0.85, 0.25, 0.2), 0.5));
    }
  }

  /** The tile under the pointer; while stroking, only near its middle, so
   *  a drag on the diagonal steps corner to corner and never takes the
   *  tile beside it passes. */
  const tileAt = (e: PointerEvent): Cell | null => {
    const hit = scene.pick(e.offsetX, e.offsetY, (m) => m.name === "ground");
    if (!hit?.pickedPoint) return null;
    const [x, y] = [-hit.pickedPoint.x, -hit.pickedPoint.y];
    const cell: Cell = [Math.floor(x), Math.floor(y)];
    return !stroking || Math.hypot(x - cell[0] - 0.5, y - cell[1] - 0.5) < 0.45 ? cell : null;
  };

  function touch(cell: Cell) {
    const [c, r] = cell;
    const p = program();
    if (p) {
      if (has(stroke, cell)) return;
      // Run on to another building of the kind, and the stroke joins it.
      const kind = LETTERS[brush()];
      if (!has(base, cell) && tiles[r]?.[c]?.kind === kind) base = [...base, ...touching(town(), kind, cell).filter((t) => !has(base, t))];
      if (!has(base, cell) && (!paintable(town(), p, c, r) || !complete(town(), p, [...whole(), cell]))) return;
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
    const cell = tileAt(e);
    stroking = true;
    stroke = [];
    // A stroke begun on a building of its kind grows it; begun anywhere
    // else, it is a building of its own, detached from its neighbours.
    const on = cell && tiles[cell[1]]?.[cell[0]]?.kind === LETTERS[brush()];
    base = on && program() ? touching(town(), LETTERS[brush()], cell) : [];
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
    if (built) {
      const t = town();
      const made = strokeJoins(t, built);
      joins = joins ?? fixed(t);
      for (const [c, r] of built) if (!has(base, [c, r])) set(c, r, brush());
      for (const k of made) joins.add(k);
    }
    stroke = [];
    base = [];
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

const colourOf = (t: Tile): [number, number, number] => {
  const c = Color3.FromHexString(BLUEPRINTS[t.kind as BuildingKind].color);
  return [c.r, c.g, c.b];
};


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
/**
 * The ground as the game draws it, from the fixture's letters: chunk by
 * chunk, each with its skirt, through the builder the terrain worker runs.
 */
function terrain(scene: Scene, town: Town, theme: Theme, rows: string[]): Mesh[] {
  const type = (c: number, r: number): TerrainType => {
    const ch = rows[r]?.[c];
    if (ch === "^") return "Mountain";
    if (ch === "_") return "Beach";
    const t = town.tile(c, r);
    return t.kind === "water" ? "Water" : t.kind === "wood" ? "Forest" : "Grass";
  };
  const palette: TerrainPalette = {
    Water: theme.water, Sea: theme.water, Beach: theme.beach, Grass: theme.land, Forest: theme.forest, Mountain: theme.mountain,
  };
  const out: Mesh[] = [];
  for (let cy = 0; cy * CHUNK_SIZE < town.h; cy++) {
    for (let cx = 0; cx * CHUNK_SIZE < town.w; cx++) {
      const tiles = new Uint8Array(CHUNK_STRIDE * CHUNK_STRIDE);
      for (let iy = 0; iy < CHUNK_STRIDE; iy++) {
        for (let ix = 0; ix < CHUNK_STRIDE; ix++) {
          tiles[iy * CHUNK_STRIDE + ix] = TYPE_BY_BYTE.indexOf(type(cx * CHUNK_SIZE + ix - CHUNK_SKIRT, cy * CHUNK_SIZE + iy - CHUNK_SKIRT));
        }
      }
      const geo = buildChunk(tiles, cx, cy, palette);
      if (!geo) continue;
      for (const [name, g] of [["ground", geo.ground], ["cliffs", geo.cliffs]] as const) {
        if (!g.indices.length) continue;
        const mesh = new Mesh(`terrain_${name}`, scene);
        const vd = new VertexData();
        Object.assign(vd, { positions: g.positions, indices: g.indices, normals: g.normals, colors: g.colors ?? null });
        vd.applyToMesh(mesh);
        // The map runs +x to the screen's left and +y up: turned about.
        mesh.scaling.set(-1, -1, 1);
        mesh.position.set(-cx * CHUNK_SIZE, -cy * CHUNK_SIZE, 0);
        const mat = new StandardMaterial(`terrain_${name}_mat`, scene);
        mat.diffuseColor = name === "cliffs" ? new Color3(0.5, 0.5, 0.5) : Color3.White();
        mat.specularColor = Color3.Black();
        mat.backFaceCulling = false;
        mesh.material = mat;
        mesh.isPickable = false;
        out.push(mesh);
      }
    }
  }
  return out;
}

/** Just over the roads, under every building. */
const GRID_Z = 0.03;
let showGrid = true;

function build(scene: Scene, town: Town, theme: Theme, rows: string[]): Mesh[] {
  const meshes: Mesh[] = [];
  const add = (name: string, plain: MeshGeometry & { colors?: number[] }, colour: Color3) => {
    if (!plain.indices.length) return;
    const geo = bevelled(plain);
    const mesh = new Mesh(name, scene);
    const vd = new VertexData();
    Object.assign(vd, { positions: geo.positions, indices: geo.indices, normals: geo.normals, colors: geo.colors ?? null });
    vd.applyToMesh(mesh);
    const mat = new StandardMaterial(`${name}_mat`, scene);
    mat.diffuseColor = colour;
    mat.specularColor = Color3.Black();
    // Its creases rounded, as the game's town; lacquered as the game's
    // are, asphalt and paving matte.
    giveBevel(mesh, geo);
    new BevelPlugin(mat);
    if (name === "mass") lacquer(mat, "building");
    else if (name === "parked") lacquer(mat, "car");
    mesh.material = mat;
    meshes.push(mesh);
  };

  // The ground: a sheet under it all to take the shadows and the clicks.
  const ground = MeshBuilder.CreateGround("ground", { width: town.w + 40, height: town.h + 40 }, scene);
  ground.rotation.x = Math.PI / 2;
  ground.position.set(-town.w / 2, -town.h / 2, -0.6);
  const gm = new StandardMaterial("ground_mat", scene);
  gm.diffuseColor = new Color3(theme.land.r, theme.land.g, theme.land.b);
  gm.specularColor = Color3.Black();
  ground.material = gm;
  meshes.push(ground);

  // The ground: grass, water, woods and paving, as terrain.
  meshes.push(...terrain(scene, town, theme, rows));

  // The town grid, drawn; and on it what the dressing parks.
  const { pieces, dressing } = drawTown(town, theme, colourOf);
  for (const p of [...drawRoads(town, theme), ...pieces]) {
    add(p.name, p.geo, p.colour ?? Color3.White());
    // A sheet's kerbs rounded from its own kerb texture (`engine/kerbs.ts`):
    // the paving's every edge, a road's where it does not run on.
    const material = meshes[meshes.length - 1].material;
    if (material && p.name === "pavement") kerbed(material, kerbField(scene, kerbsOf(p.geo), extentOf(p.geo)));
    if (material && (p.name === "street" || p.name === "through")) {
      const on = runsOn(p.geo);
      kerbed(material, kerbField(scene, kerbsOf(p.geo, (a, b, out) => !on(a, b, out)), extentOf(p.geo)));
    }
  }
  const { cars, docks, ships } = dressing;
  const trees = grove(scene, "sandbox", undefined);
  const { matrices, colors } = treeInstances(dressing.trees, theme);
  plant(trees, matrices, colors);
  meshes.push(trees.bodies, trees.tops);

  // Parked cars and lorries at the docks, boxes as the game draws them.
  const CAR_COLOURS: RGB[] = [[0.9, 0.25, 0.2], [0.85, 0.85, 0.88], [0.2, 0.22, 0.28], [0.25, 0.4, 0.75], [0.65, 0.65, 0.68], [0.55, 0.15, 0.15], [0.2, 0.5, 0.4], [0.8, 0.65, 0.25]];
  const parked: MeshGeometry & { colors: number[] } = { positions: [], normals: [], indices: [], colors: [] };
  const quad = (pts: [number, number, number][], n: [number, number, number], rgb: RGB) => {
    const b0 = parked.positions.length / 3;
    for (const [x, y, z] of pts) parked.positions.push(-x, -y, z), parked.normals.push(-n[0], -n[1], n[2]), parked.colors.push(rgb[0], rgb[1], rgb[2], 1);
    // One side, the one facing out, as the game's boxes are: so each edge is
    // two faces' and the bevel finds it.
    const p = parked.positions;
    const [ux, uy, uz] = [p[(b0 + 1) * 3] - p[b0 * 3], p[(b0 + 1) * 3 + 1] - p[b0 * 3 + 1], p[(b0 + 1) * 3 + 2] - p[b0 * 3 + 2]];
    const [vx, vy, vz] = [p[(b0 + 2) * 3] - p[b0 * 3], p[(b0 + 2) * 3 + 1] - p[b0 * 3 + 1], p[(b0 + 2) * 3 + 2] - p[b0 * 3 + 2]];
    const out = (uy * vz - uz * vy) * -n[0] + (uz * vx - ux * vz) * -n[1] + (ux * vy - uy * vx) * n[2] > 0;
    // A fan round its middle, as `boxGeometry`'s faces are, wound as its
    // (Babylon's front face is the clockwise one).
    const c = b0 + 4;
    const [mx, my, mz] = [0, 1, 2].map((k) => (p[b0 * 3 + k] + p[(b0 + 1) * 3 + k] + p[(b0 + 2) * 3 + k] + p[(b0 + 3) * 3 + k]) / 4);
    parked.positions.push(mx, my, mz), parked.normals.push(-n[0], -n[1], n[2]), parked.colors.push(rgb[0], rgb[1], rgb[2], 1);
    for (let i = 0; i < 4; i++) parked.indices.push(...(out ? [c, b0 + ((i + 1) % 4), b0 + i] : [c, b0 + i, b0 + ((i + 1) % 4)]));
  };
  /** A box `l` long along `angle`, `w` wide and `h` tall, its middle at (x, y). */
  const box = (x: number, y: number, angle: number, [w, l, h]: number[], rgb: RGB, z0 = 0.03) => {
    const [ca, sa] = [Math.cos(angle), Math.sin(angle)];
    const at = (a: number, b: number): [number, number] => [x + ca * a - sa * b, y + sa * a + ca * b];
    const corners = [at(-l / 2, -w / 2), at(l / 2, -w / 2), at(l / 2, w / 2), at(-l / 2, w / 2)];
    quad(corners.map(([x, y]) => [x, y, z0 + h] as [number, number, number]), [0, 0, 1], rgb);
    for (let i = 0; i < 4; i++) {
      const [p, q] = [corners[i], corners[(i + 1) % 4]];
      const [ex, ey] = [q[0] - p[0], q[1] - p[1]];
      const len = Math.hypot(ex, ey);
      quad([[p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z0 + h], [p[0], p[1], z0 + h]], [ey / len, -ex / len, 0], rgb);
    }
  };
  // A ferry: a white hull, and on it a deckhouse in the port's blue,
  // toward the bow.
  for (const ship of ships) {
    const [ux, uy] = [Math.cos(ship.angle), Math.sin(ship.angle)];
    box(ship.x, ship.y, ship.angle, [FERRY.w, FERRY.l, 0.16], [0.96, 0.96, 0.95], -0.02);
    box(ship.x + ux * 0.4, ship.y + uy * 0.4, ship.angle, [FERRY.w * 0.75, FERRY.l * 0.5, 0.14], [0.17, 0.42, 0.64], 0.14);
  }
  for (const car of cars) box(car.x, car.y, car.angle, [CAR.w, CAR.l, CAR.h], CAR_COLOURS[car.colour]);
  for (const dock of docks) {
    const [ux, uy] = [Math.cos(dock.angle), Math.sin(dock.angle)];
    if (!dock.lorry) continue;
    const trailer = 0.01 + TRAILER.l / 2, cab = 0.01 + TRAILER.l + 0.02 + CAB.l / 2;
    box(dock.x + ux * trailer, dock.y + uy * trailer, dock.angle, [TRAILER.w, TRAILER.l, TRAILER.h], [0.9, 0.9, 0.88]);
    box(dock.x + ux * cab, dock.y + uy * cab, dock.angle, [CAB.w, CAB.l, CAB.h], [0.28, 0.36, 0.58]);
  }
  add("parked", parked, Color3.White());

  // The tiles' grid, faint, over the ground and under the buildings: `g`
  // hides it.
  const lines: Vector3[][] = [];
  for (let c = 0; c <= town.w; c++) lines.push([new Vector3(-c, 0, GRID_Z), new Vector3(-c, -town.h, GRID_Z)]);
  for (let r = 0; r <= town.h; r++) lines.push([new Vector3(0, -r, GRID_Z), new Vector3(-town.w, -r, GRID_Z)]);
  const grid = MeshBuilder.CreateLineSystem("grid", { lines }, scene);
  grid.color = Color3.Black();
  grid.alpha = 0.18;
  grid.isPickable = false;
  grid.isVisible = showGrid;
  meshes.push(grid);
  return meshes;
}

