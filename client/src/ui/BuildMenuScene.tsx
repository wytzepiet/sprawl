import { onCleanup, onMount } from "solid-js";
import {
  Engine,
  Scene,
  FreeCamera,
  Vector3,
  Camera,
  Color4,
  Color3,
  Mesh,
  VertexData,
  StandardMaterial,
  HemisphericLight,
  DirectionalLight,
  ShadowGenerator,
} from "@babylonjs/core";
import { createBorderTexture } from "../engine/TerrainChunks";
import { buildChunk, CHUNK_STRIDE, type TerrainPalette } from "../engine/objects/terrainGeometry";
import { shapeFor, BUILDING_COLOR, SLAB } from "../engine/objects/buildings";
import { ASPHALT, KERB } from "../engine/objects/BuildingObject";
import { frameOf, markingGeometry, runSlabGeometry, yardGeometry } from "../engine/objects/lots";
import { createOutline } from "../engine/outline";
import { BLUEPRINTS, plot } from "../blueprints";
import type { BuildingKind } from "../generated";

/** Which tile row the plots stand on, and the first plot's column. */
const ROW = 16;
const FIRST = 2;

/** Each kind's slot on the shelf: as wide as its plot and a tile beside
 *  it, so the row is as long as what stands on it. In tiles from the
 *  row's start, and the row's whole width. */
export function slots(kinds: BuildingKind[]): { start: number[]; width: number[]; total: number } {
  const width = kinds.map((k) => plot(k, 2).size[0] + 1);
  const start: number[] = [];
  let at = 0;
  for (const w of width) {
    start.push(at);
    at += w;
  }
  return { start, width, total: at + 1 };
}

/**
 * The build menu's shelf: a piece of map with every placeable kind standing
 * on a plot of it, in a row, seen straight from above as the map is. The
 * ground is a chunk built by the map's own terrain builder — its grid, on
 * white — and the buildings are the map's solids on the map's half-tile,
 * under the map's sky and a noon sun, shadows and all. One canvas, one
 * scene; the pins and labels are laid over it by the menu, a slot per kind.
 */
export default function BuildMenuScene(props: { kinds: BuildingKind[]; hovered: BuildingKind | null; onFit: (tilePx: number) => void }) {
  let canvas!: HTMLCanvasElement;

  onMount(() => {
    const engine = new Engine(canvas, true, { adaptToDeviceRatio: true });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(1, 1, 1, 1);

    const row = slots(props.kinds);
    // The middle of the row, and the world x at the canvas's left edge.
    // Looking down on the map, east is screen-left — the map's camera has
    // it the same way — so the first slot holds the row's easternmost plot.
    const cx = FIRST + row.total / 2;
    // Centred on the deepest plot, lot and all, so nothing hangs off the
    // bottom of the shelf.
    const deepest = Math.max(...props.kinds.map((k) => plot(k, 2).size[1]));
    const cy = ROW + deepest / 2;
    const left = cx + row.total / 2;
    const cam = new FreeCamera("shelf_cam", new Vector3(cx, cy, 6), scene);
    cam.upVector = new Vector3(0, 1, 0);
    cam.setTarget(new Vector3(cx, cy, 0));
    cam.mode = Camera.ORTHOGRAPHIC_CAMERA;
    // As large as the shelf allows with the whole row and the deepest plot
    // in view, a tile of ground around them.
    const fit = () => {
      const px = Math.min(canvas.clientWidth / row.total, canvas.clientHeight / (deepest + 1));
      const w = canvas.clientWidth / px;
      const h = canvas.clientHeight / px;
      cam.orthoLeft = -w / 2;
      cam.orthoRight = w / 2;
      cam.orthoTop = h / 2;
      cam.orthoBottom = -h / 2;
      props.onFit(px);
    };
    fit();

    // The map's own sky and a late-morning sun from the top left, so a
    // shadow falls down and to the left of what throws it.
    const sky = new HemisphericLight("shelf_sky", new Vector3(0, 0, 1), scene);
    sky.intensity = 0.65;
    const sun = new DirectionalLight("shelf_sun", new Vector3(-0.45, -0.4, -1).normalize(), scene);
    sun.intensity = 0.4;
    // The shadow frustum, set the way the map sets its own: a box around
    // the row, looked at from up-sun, rather than one Babylon guesses.
    const radius = row.total / 2 + 1;
    sun.position = new Vector3(cx, cy, 0).subtract(sun.direction.scale(radius));
    sun.shadowMinZ = 0;
    sun.shadowMaxZ = radius * 2;
    sun.orthoLeft = -radius;
    sun.orthoRight = radius;
    sun.orthoTop = radius;
    sun.orthoBottom = -radius;
    sun.forceProjectionMatrixCompute();
    const shadows = new ShadowGenerator(1024, sun);
    shadows.usePercentageCloserFiltering = true;
    shadows.filteringQuality = ShadowGenerator.QUALITY_LOW;
    shadows.bias = 0.001;
    shadows.normalBias = 0.02;

    // One chunk of grass, in white: the map's ground and its grid.
    const white = { r: 1, g: 1, b: 1 };
    const palette: TerrainPalette = { Water: white, Beach: white, Grass: white, Forest: white, Mountain: white };
    const tiles = new Uint8Array(CHUNK_STRIDE * CHUNK_STRIDE).fill(2); // Grass
    const chunk = buildChunk(tiles, 0, 0, palette)!;
    const ground = new Mesh("shelf_ground", scene);
    const gv = new VertexData();
    gv.positions = chunk.ground.positions;
    gv.indices = chunk.ground.indices;
    gv.normals = chunk.ground.normals;
    if (chunk.ground.uvs) gv.uvs = chunk.ground.uvs;
    if (chunk.ground.colors) gv.colors = chunk.ground.colors;
    gv.applyToMesh(ground);
    ground.hasVertexAlpha = false;
    const groundMat = new StandardMaterial("shelf_ground_mat", scene);
    groundMat.specularColor = Color3.Black();
    // A tile is bigger here than on the map, so the line is drawn finer.
    groundMat.diffuseTexture = createBorderTexture(scene, 1);
    ground.material = groundMat;
    ground.receiveShadows = true;

    const mat = new StandardMaterial("shelf_building", scene);
    mat.diffuseColor = Color3.FromHexString(BUILDING_COLOR);
    mat.specularColor = Color3.Black();
    const flat = (name: string, color: Color3) => {
      const m = new StandardMaterial(name, scene);
      m.diffuseColor = color;
      m.specularColor = Color3.Black();
      return m;
    };
    const asphalt = flat("shelf_asphalt", ASPHALT);
    const kerb = flat("shelf_kerb", KERB);
    const solid = (name: string, geo: { positions: number[]; indices: number[]; normals: number[] }, material: StandardMaterial) => {
      const mesh = new Mesh(name, scene);
      const vd = new VertexData();
      vd.positions = geo.positions;
      vd.indices = geo.indices;
      vd.normals = geo.normals;
      vd.applyToMesh(mesh);
      mesh.material = material;
      mesh.receiveShadows = true;
      return mesh;
    };
    const solids = new Map<BuildingKind, Mesh>();
    props.kinds.forEach((kind, i) => {
      const lie = plot(kind, 2);
      const [w, h] = lie.size;
      const [[, by], [bw, bh]] = lie.building;
      // A tile in from the slot's edge, on the grid, where the menu puts
      // its pin.
      const x0 = left - row.start[i] - 1 - w;
      const building = solid(`shelf_${kind}`, shapeFor(kind, bw, bh, 0), mat);
      building.position = new Vector3(x0 + w / 2, ROW + by + bh / 2, 0);
      shadows.addShadowCaster(building);
      solids.set(kind, building);
      // The plot as it lands on the map: the lot in front of the building,
      // facing south the way the shelf does, slab and kerb and what is
      // painted on it — so what you drag is what you get.
      if (lie.lot) {
        const [[lx, ly], [lw, ld]] = lie.lot;
        const { rot, origin } = frameOf(2, { x: x0 + lx, y: ROW + ly, w: lw, h: ld });
        const put = (name: string, geo: { positions: number[]; indices: number[]; normals: number[] }, material: StandardMaterial, z: number) => {
          const m = solid(name, geo, material);
          m.position = new Vector3(origin[0], origin[1], z);
          m.rotation.z = rot;
        };
        put(`shelf_${kind}_kerb`, runSlabGeometry(lw, h, true), kerb, SLAB.kerbZ);
        put(`shelf_${kind}_slab`, runSlabGeometry(lw, h, false), asphalt, SLAB.z);
        put(`shelf_${kind}_marks`, BLUEPRINTS[kind].yard ? yardGeometry(lw, ld) : markingGeometry(lw), kerb, 0);
      }
    });

    // The same outline the map gives what the pointer is over.
    const outline = createOutline(scene, engine, cam);
    scene.onBeforeRenderObservable.add(() => {
      const h = props.hovered && solids.get(props.hovered);
      outline.show([], h ? [h] : []);
    });
    engine.runRenderLoop(() => scene.render());
    const onResize = () => { engine.resize(); fit(); };
    window.addEventListener("resize", onResize);
    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      outline.dispose();
      scene.dispose();
      engine.dispose();
    });
  });

  return <canvas ref={canvas} class="block w-full h-full" />;
}
