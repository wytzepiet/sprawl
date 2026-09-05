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
import { shapeFor, boxGeometry, BUILDING_COLOR } from "../engine/objects/buildings";
import type { BuildingKind } from "../generated";

/** World units from one kind's centre to the next. */
export const SLOT = 1.6;

/**
 * The build menu's shelf: one little world with every placeable kind
 * standing in a row on white ground, seen straight from above as the map
 * is, lit by the same sky and a noon sun, shadows and all. One canvas, one
 * scene — not a thumbnail each — and the pins and labels are laid over it
 * by the menu, one slot per kind.
 */
export default function BuildMenuScene(props: { kinds: BuildingKind[] }) {
  let canvas!: HTMLCanvasElement;

  onMount(() => {
    const engine = new Engine(canvas, true, { adaptToDeviceRatio: true });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(1, 1, 1, 1);

    const n = props.kinds.length;
    const mid = ((n - 1) * SLOT) / 2;
    const cam = new FreeCamera("shelf_cam", new Vector3(mid, 0, 6), scene);
    cam.upVector = new Vector3(0, 1, 0);
    cam.setTarget(new Vector3(mid, 0, 0));
    cam.mode = Camera.ORTHOGRAPHIC_CAMERA;
    // The row exactly fills the width, about the camera in the middle of
    // it; the height follows the canvas.
    const fit = () => {
      const w = n * SLOT;
      const h = (w * canvas.clientHeight) / Math.max(1, canvas.clientWidth);
      cam.orthoLeft = -w / 2;
      cam.orthoRight = w / 2;
      cam.orthoTop = h / 2;
      cam.orthoBottom = -h / 2;
    };
    fit();

    const sky = new HemisphericLight("shelf_sky", new Vector3(0, 0, 1), scene);
    // The map's own sky and noon sun, so a shadow falls here as it does there.
    sky.intensity = 0.65;
    const sun = new DirectionalLight("shelf_sun", new Vector3(0, -0.4, -1).normalize(), scene);
    sun.intensity = 0.4;
    // The shadow frustum, set the way the map sets its own: a box around
    // the row, looked at from up-sun, rather than one Babylon guesses.
    const radius = (n * SLOT) / 2 + 1;
    sun.position = new Vector3(mid, 0, 0).subtract(sun.direction.scale(radius));
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

    // A slab, built like the buildings are, so it faces the same way up.
    const ground = new Mesh("shelf_ground", scene);
    const slab = boxGeometry(n * SLOT + 4, 6, 0.02);
    const gv = new VertexData();
    gv.positions = slab.positions;
    gv.indices = slab.indices;
    gv.normals = slab.normals;
    gv.applyToMesh(ground);
    ground.position = new Vector3(mid, 0, -0.01);
    const groundMat = new StandardMaterial("shelf_ground_mat", scene);
    groundMat.diffuseColor = Color3.White();
    groundMat.specularColor = Color3.Black();
    ground.material = groundMat;
    ground.receiveShadows = true;

    const mat = new StandardMaterial("shelf_building", scene);
    mat.diffuseColor = Color3.FromHexString(BUILDING_COLOR);
    mat.specularColor = Color3.Black();
    props.kinds.forEach((kind, i) => {
      const mesh = new Mesh(`shelf_${kind}`, scene);
      const geo = shapeFor(kind, 1, 1, 0);
      const vd = new VertexData();
      vd.positions = geo.positions;
      vd.indices = geo.indices;
      vd.normals = geo.normals;
      vd.applyToMesh(mesh);
      mesh.material = mat;
      // A little above the middle, so the shadow it throws stays clear of
      // the label under it.
      mesh.position = new Vector3(i * SLOT, 0.18, 0);
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
