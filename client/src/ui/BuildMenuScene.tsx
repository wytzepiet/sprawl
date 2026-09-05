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
import { shapeFor, BUILDING_COLOR } from "../engine/objects/buildings";
import { BLUEPRINTS } from "../blueprints";
import type { BuildingKind } from "../generated";

/** Tiles from one kind's centre to the next: a plot with land around it. */
export const SLOT = 4;
/** Which tile row the plots stand on, and the first plot's column. */
const ROW = 16;
const FIRST = 2;

/**
 * The build menu's shelf: a piece of map with every placeable kind standing
 * on a plot of it, in a row, seen straight from above as the map is. The
 * ground is a chunk built by the map's own terrain builder — its grid, on
 * white — and the buildings are the map's solids on the map's half-tile,
 * under the map's sky and a noon sun, shadows and all. One canvas, one
 * scene; the pins and labels are laid over it by the menu, a slot per kind.
 */
export default function BuildMenuScene(props: { kinds: BuildingKind[]; onFit: (tilePx: number) => void }) {
  let canvas!: HTMLCanvasElement;

  onMount(() => {
    const engine = new Engine(canvas, true, { adaptToDeviceRatio: true });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(1, 1, 1, 1);

    const n = props.kinds.length;
    // The middle of the row, and the world x at the canvas's left edge.
    // Looking down on the map, east is screen-left — the map's camera has
    // it the same way — so the first slot holds the row's easternmost plot.
    const cx = FIRST + ((n - 1) * SLOT) / 2 + 1;
    const cy = ROW + 1;
    const left = cx + (n * SLOT) / 2;
    const cam = new FreeCamera("shelf_cam", new Vector3(cx, cy, 6), scene);
    cam.upVector = new Vector3(0, 1, 0);
    cam.setTarget(new Vector3(cx, cy, 0));
    cam.mode = Camera.ORTHOGRAPHIC_CAMERA;
    // The row exactly fills the width; the height follows the canvas.
    const fit = () => {
      const w = n * SLOT;
      const h = (w * canvas.clientHeight) / Math.max(1, canvas.clientWidth);
      cam.orthoLeft = -w / 2;
      cam.orthoRight = w / 2;
      cam.orthoTop = h / 2;
      cam.orthoBottom = -h / 2;
      props.onFit(canvas.clientWidth / w);
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
    const radius = (n * SLOT) / 2 + 1;
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
    props.kinds.forEach((kind, i) => {
      const mesh = new Mesh(`shelf_${kind}`, scene);
      const [w, h] = BLUEPRINTS[kind].size;
      const geo = shapeFor(kind, w, h, 0);
      const vd = new VertexData();
      vd.positions = geo.positions;
      vd.indices = geo.indices;
      vd.normals = geo.normals;
      vd.applyToMesh(mesh);
      mesh.material = mat;
      // A tile in from the slot's edge, on the grid, so a plot's centre sits
      // where the menu puts its pin: a tile and a half in for a plot one
      // tile across, two for one two across.
      mesh.position = new Vector3(left - i * SLOT - 1 - w / 2, ROW + h / 2, 0);
      mesh.receiveShadows = true;
      shadows.addShadowCaster(mesh);
    });

    engine.runRenderLoop(() => scene.render());
    const onResize = () => { engine.resize(); fit(); };
    window.addEventListener("resize", onResize);
    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      scene.dispose();
      engine.dispose();
    });
  });

  return <canvas ref={canvas} class="block w-full h-full" />;
}
