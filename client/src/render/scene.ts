import type { Engine, Surface } from "./engine";
import type { CubeEnvironment } from "./env";
import type { Mesh } from "./mesh";
import type { Frame } from "./frame";

/** A direction or place the client sets in place, as Lite's ObservableVec3. */
export class Vec3 {
  constructor(
    public x: number,
    public y: number,
    public z: number,
  ) {}
  set(x: number, y: number, z: number) {
    [this.x, this.y, this.z] = [x, y, z];
    return this;
  }
}

export interface DirectionalLight {
  lightType: "directional";
  direction: Vec3;
  diffuse: [number, number, number];
  specular: [number, number, number];
  intensity: number;
  shadowGenerator?: ShadowGenerator;
}

export function createDirectionalLight(direction: [number, number, number], intensity = 1): DirectionalLight {
  return { lightType: "directional", direction: new Vec3(...direction), diffuse: [1, 1, 1], specular: [1, 1, 1], intensity };
}

export function setLightDiffuseColor(light: { diffuse: [number, number, number] }, c: number | readonly number[], g?: number, b?: number): void {
  light.diffuse = typeof c === "number" ? [c, g!, b!] : [c[0]!, c[1]!, c[2]!];
}

/** Lamps and headlights: plain objects, packed into one buffer as the frame needs them. */
export interface ClusteredPointLight {
  position: number[];
  diffuse: number[];
  range: number;
  intensity: number;
}
export interface ClusteredSpotLight extends ClusteredPointLight {
  direction: number[];
  angle: number;
}
export interface ClusteredLightContainer {
  points: ClusteredPointLight[];
  spots: ClusteredSpotLight[];
  /** Bumped when the client says the lights moved. */
  version: number;
}

export const createClusteredLightContainer = (_opts?: unknown): ClusteredLightContainer => ({ points: [], spots: [], version: 0 });
export function createClusteredPointLight(c: ClusteredLightContainer, o: { position: number[]; diffuse: number[]; range: number; intensity: number }): ClusteredPointLight {
  const light = { position: [...o.position], diffuse: [...o.diffuse], range: o.range, intensity: o.intensity };
  c.points.push(light);
  return light;
}
export function createClusteredSpotLight(c: ClusteredLightContainer, o: { position: number[]; direction: number[]; diffuse: number[]; range: number; angle: number; intensity: number }): ClusteredSpotLight {
  const light = { position: [...o.position], direction: [...o.direction], diffuse: [...o.diffuse], range: o.range, angle: o.angle, intensity: o.intensity };
  c.spots.push(light);
  return light;
}
export const addClusteredLightContainer = (scene: Scene, c: ClusteredLightContainer) => void (scene._container = c);
export const markClusteredLightContainerDirty = (c: ClusteredLightContainer) => void c.version++;

/**
 * The sun's shadows: a still map of what stands still, drawn when the sun
 * has turned `refitAngle`, its box moved or a still caster changed, and a
 * live map of what moves, drawn every frame something does (`frame.ts`).
 */
export interface ShadowGenerator {
  _light: DirectionalLight;
  mapSize: number;
  bias: number;
  casters: Set<Mesh>;
  bounds: number[] | null;
  enabled: boolean;
  refitAngle: number;
  /** Bumped by the client's changes: the caster list, the box, on or off. */
  version: number;
  _scene: Scene | null;
  _runtimeEnabledState: { enabled: boolean };
  _shadowTaskState: { _casterMeshes: Mesh[] };
  readonly _preloadPending: boolean;
}

export function createCsmDirectionalShadowGenerator(engine: Engine, light: DirectionalLight, cfg: { mapSize?: number; bias?: number } = {}): ShadowGenerator {
  const gen: ShadowGenerator = {
    _light: light,
    mapSize: cfg.mapSize ?? 1024,
    bias: cfg.bias ?? 0.00005,
    casters: new Set(),
    bounds: null,
    enabled: true,
    refitAngle: 0,
    version: 0,
    _scene: null,
    _runtimeEnabledState: { enabled: true },
    _shadowTaskState: { _casterMeshes: [] },
    get _preloadPending() {
      return engine._building > 0;
    },
  };
  light.shadowGenerator = gen;
  return gen;
}

export function setShadowTaskCasterMeshes(gen: ShadowGenerator, meshes: readonly Mesh[]): void {
  gen.casters = new Set(meshes);
  gen._shadowTaskState._casterMeshes = [...meshes];
  gen.version++;
  gen._scene?._castersChanged();
}

export function setShadowGeneratorBounds(gen: ShadowGenerator, min: readonly number[] | null, max?: readonly number[]): void {
  const b = min && max ? [...min, ...max] : null;
  if (b && gen.bounds && b.every((v, i) => v === gen.bounds![i])) return;
  gen.bounds = b;
  gen.version++;
}

export function setShadowGeneratorEnabled(gen: ShadowGenerator, on: boolean): void {
  if (gen.enabled === on) return;
  gen.enabled = gen._runtimeEnabledState.enabled = on;
  gen.version++;
}

export async function enableCsmStaticCache(_engine: Engine, gen: ShadowGenerator, opts: { refitAngle: number }): Promise<void> {
  gen.refitAngle = opts.refitAngle;
}

/** The still picture is ours (`frame.ts`): Lite's split of the maps stays inside. */
export const setShadowStaticOnly = (_gen: ShadowGenerator, _on: boolean) => true;
export const getCsmStaticTexture = (_gen: ShadowGenerator) => null;
export const onCsmReceiverUpdate = (_gen: ShadowGenerator, _cb: (data: Float32Array) => void) => () => {};

export interface ImageProcessing {
  toneMappingEnabled: boolean;
  toneMapping?: unknown;
  exposure: number;
  contrast: number;
}

export interface Scene {
  engine: Engine;
  surface: Surface;
  clearColor: { r: number; g: number; b: number; a: number };
  camera: any;
  meshes: Mesh[];
  lights: DirectionalLight[];
  imageProcessing: ImageProcessing;
  _renderableVersion: number;
  readonly _renderables: { mesh: Mesh }[];
  _env: CubeEnvironment | null;
  _container: ClusteredLightContainer | null;
  /** What it is drawn by, made at its first frame. */
  _frame: Frame | null;
  /** Which meshes stand still, when the still picture is ours; otherwise every mesh is drawn forward each frame. */
  _isStill: ((mesh: Mesh) => boolean) | null;
  /** Told when the still picture has been drawn. */
  _pictured: (why: string) => void;
  _meshChanged(mesh: Mesh, drawn: boolean, casting?: boolean): void;
  _castersChanged(): void;
}

export function createSceneContext(target: Engine | Surface): Scene {
  const surface = "surfaces" in target ? target.surfaces[0]! : target;
  const scene: Scene = {
    engine: surface.engine,
    surface,
    clearColor: { r: 0, g: 0, b: 0, a: 1 },
    camera: null,
    meshes: [],
    lights: [],
    imageProcessing: { toneMappingEnabled: false, exposure: 1, contrast: 1 },
    _renderableVersion: 0,
    get _renderables() {
      return scene._frame?.drawn() ?? [];
    },
    _env: null,
    _container: null,
    _frame: null,
    _isStill: null,
    _pictured: () => {},
    _meshChanged: (mesh, drawn, casting) => scene._frame?.meshChanged(mesh, drawn, casting),
    _castersChanged: () => scene._frame?.castersChanged(),
  };
  surface._scenes.push(scene);
  return scene;
}

export function addToScene(scene: Scene, thing: Mesh | DirectionalLight): void {
  if ("lightType" in thing) {
    scene.lights.push(thing);
    if (thing.shadowGenerator) thing.shadowGenerator._scene = scene;
    return;
  }
  if (thing._scenes.has(scene)) return;
  scene.meshes.push(thing);
  thing._scenes.add(scene);
  scene._renderableVersion++;
  scene._meshChanged(thing, true);
}

export function removeFromScene(scene: Scene, mesh: Mesh): void {
  if (!mesh._scenes.delete(scene)) return;
  const i = scene.meshes.indexOf(mesh);
  if (i >= 0) scene.meshes.splice(i, 1);
  scene._renderableVersion++;
  scene._meshChanged(mesh, true);
}

/** Plugins and their vertex data are always on; shadows too. */
export const enableMaterialPlugins = (_scene: Scene) => {};
export const enablePbrMaterialPluginVertexData = () => {};
export const registerSceneWithShadowSupport = async (_scene: Scene) => {};
