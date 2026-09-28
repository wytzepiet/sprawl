import { createSignal, For, onCleanup, onMount } from "solid-js";
import { Color3, Mesh, MeshBuilder, StandardMaterial, VertexData, type Scene } from "@babylonjs/core";
import Canvas, { useEngine } from "../engine/Canvas";
import { OrthoCamera } from "../engine/OrthoCamera";
import DayNightLights, { DayNightProvider, useDayNight } from "../engine/DayNightCycle";
import { ThemeProvider, useTheme, type Theme } from "../engine/theme";
import { OfflineGame } from "../state/gameObjects";
import { syncClock } from "../network/clock";
import { BLUEPRINTS } from "../blueprints";
import { buildRoadGeometry, BORDER_HALF_W, BORDER_Z, HALF_W, ROAD_Z, type ArmInfo } from "../engine/objects/roadGeometry";
import type { MeshGeometry } from "../engine/Mesh";
import { parseTown, tileOf, townOf, type Tile, type Town } from "../engine/town/grid";
import { massMesh } from "../engine/town/mass";

/**
 * A town with no server: the fixtures, or a grid painted by hand, drawn the
 * way the game draws them, so the look can be worked on alone. At noon, and
 * still.
 *
 *   /sandbox?f=<fixture>      open a fixture
 *
 * Click a tile to paint it with the brush; the brushes are on the bar, and
 * on the keys beside them. "Copy" puts the map on the clipboard as a
 * fixture's text.
 */
const FIXTURES: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob<string>("../../../server/fixtures/*.txt", { query: "?raw", import: "default", eager: true })).map(
    ([path, text]) => [path.split("/").pop()!.replace(/\.txt$/, ""), text],
  ),
);

const BRUSHES: { key: string; ch: string; label: string }[] = [
  { key: "1", ch: "H", label: "House" }, { key: "2", ch: "A", label: "Flats" }, { key: "3", ch: "S", label: "Shop" },
  { key: "4", ch: "O", label: "Office" }, { key: "5", ch: "W", label: "Workshop" }, { key: "6", ch: "=", label: "Street" },
  { key: "7", ch: "#", label: "Road" }, { key: "8", ch: "~", label: "Water" }, { key: "9", ch: "T", label: "Wood" },
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

  function paint(c: number, r: number) {
    const t = tiles[r]?.[c];
    if (!t) return;
    const ch = brush();
    if (ch === "+" || ch === "-") {
      if (t.storeys > 0) t.storeys = Math.max(1, t.storeys + (ch === "+" ? 1 : -1));
    } else {
      tiles[r][c] = tileOf(ch);
      through[r][c] = ch === "#";
      rows[r] = rows[r].slice(0, c).padEnd(c, ".") + ch + rows[r].slice(c + 1);
    }
    draw();
  }

  // A click, not a drag: the camera pans on a drag.
  let down: [number, number] | null = null;
  const onDown = (e: PointerEvent) => (down = [e.clientX, e.clientY]);
  const onUp = (e: PointerEvent) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
    const hit = scene.pick(scene.pointerX, scene.pointerY, (m) => m.name === "ground");
    if (hit?.pickedPoint) paint(Math.floor(-hit.pickedPoint.x), Math.floor(-hit.pickedPoint.y));
  };
  const onKey = (e: KeyboardEvent) => {
    const b = BRUSHES.find((b) => b.key === e.key);
    if (b) setBrush(b.ch);
  };
  onMount(() => {
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    // The camera is ready a frame after the canvas.
    requestAnimationFrame(() => load(name()));
  });
  onCleanup(() => {
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointerup", onUp);
    window.removeEventListener("keydown", onKey);
    for (const m of drawn) m.dispose();
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
          <button style={button(brush() === b.ch)} onClick={() => setBrush(b.ch)}>
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

/** Everything a town is drawn with: the ground, water and woods, the
 *  roads, and the buildings. */
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

  // Water a step down, so the ink finds its edge; woods a shade darker.
  const quads = (kind: string, z: number) => {
    const g: MeshGeometry = { positions: [], normals: [], indices: [] };
    for (let r = 0; r < town.h; r++) {
      for (let c = 0; c < town.w; c++) {
        if (town.tile(c, r).kind !== kind) continue;
        const b = g.positions.length / 3;
        for (const [dx, dy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) g.positions.push(-(c + dx), -(r + dy), z), g.normals.push(0, 0, 1);
        g.indices.push(b, b + 2, b + 1, b, b + 3, b + 2);
      }
    }
    return g;
  };
  add("water", quads("water", -0.08), theme.water);
  add("wood", quads("wood", 0.004), theme.forest);

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

  add("mass", massMesh(town, (k) => {
    const c = Color3.FromHexString(BLUEPRINTS[k].color);
    return [c.r, c.g, c.b];
  }), Color3.White());
  return meshes;
}

