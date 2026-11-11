# Renderer contract: what the client asks of Lite

This is what a replacement renderer (`?renderer=new`) must do to stand in for
`@babylonjs/lite` (our fork, `../Babylon-Lite/packages/babylon-lite/src`).
It covers exactly the parts of Lite the client uses today. Paths are relative
to `client/src/engine/` unless they start with `lite:`, which means the Lite
source tree. Line numbers are as of this writing. Each section ends with
**Drop?** notes, and §12 collects them.

The surface the client uses:
- About 76 runtime functions, one enum (`GeometryTextureType`), 15 types, and
  one deep import (`_vis` from `@babylonjs/lite/src/engine/engine`).
- About 30 MaterialPlugins built from 10 hook points.
- 3 ShaderMaterials: `still`, `stillBeams`, `outline`.
- About 15 private fields read or written.

---

## 0. Conventions the client depends on

| Convention | Value | Who relies on it |
|---|---|---|
| Handedness | Left-handed matrices (Babylon). `getViewProjectionMatrix` returns a column-major `Float32Array(16)`. | still.ts `aim()`, Camera.tsx picking |
| Depth | **Reverse-Z**. Near maps to depth 1, far to 0, and the clear value is 0. `createPickingRay` unprojects ndc z=1 for the near point and z=0 for the far point. still.ts treats depth `0` as "nothing drawn" (`textureLoad(stillDepth, texel, 0)`). | still.ts WGSL, Camera.tsx:308-314 |
| Up axes | The world's up is **+Z** (the ground is the xy plane). The camera's up vector is +Y (`Vec3Up`). The camera looks down at a tilt, so it never reaches the up-vector singularity. | everything |
| Shadow map | `depth32float`, `2d-array` (one layer per cascade; the client uses 1 cascade). Standard (not reversed) depth, compare `"less"`, so the comparison returns 1 where lit. Orthographic light projection. | still.ts shadow sampling, peaks.ts |
| Shadow-pass detection in WGSL | In the shadow pass the bound `scene.viewProjection` is orthographic, so `scene.viewProjection[2][3] == 0`. peaks.ts:252 branches on this. | peaks.ts VW |
| Colour space | Textures are **not** sRGB-decoded. `baseColor` holds "as the eye sees" values until TownClose's `pow(...,2.2)` (§5.6). The output is `pow(1/2.2)` after tone mapping, into a non-sRGB swapchain (`surface.format`, bgra8unorm or rgba8unorm). | material.ts, every plugin |
| renderOrder | Default 100, or 150 if transparent. Lower draws first. The client uses: roads 90 (roads.ts), ground 120, field `LAYER_ORDER.field`, still quad `-Number.MAX_VALUE`, beam cones `-Number.MAX_VALUE/2`, outline quad `Number.MAX_VALUE`. | draw order and decals |
| Determinism of build | Creating a mesh, material or plugin is **asynchronous**: the pipeline compiles off-frame, and a mesh appears one or more frames after `addToScene`. ground.ts reads `_renderables` (ground.ts:384-395) to keep the old chunk until the new one is drawn. | §11 |

---

## 1. Engine, surface, scene

### Signatures

```ts
createEngine(canvas: HTMLCanvasElement, opts: { maxDevicePixelRatio: number; msaaSamples: 1 | 4 }): Promise<EngineContext>
disposeEngine(engine): void
resizeEngine(engine): void                         // resizes each surface's swapchain/depth/MSAA targets from its canvas client size × DPR
enableSurfaceResizeObserver(surface): void
createSurface(engine, canvas: OffscreenCanvas, opts: { alphaMode: "premultiplied" }): Surface   // studio.ts:54
createSceneContext(engineOrSurface): SceneContext  // studio passes a Surface
renderFrame(engine, deltaMs: number, surfaces: Surface[]): void   // one command encoder, one submit
waitForGpuIdle(engine): Promise<void>              // device.queue.onSubmittedWorkDone()
addToScene(scene, meshOrLight): void
removeFromScene(scene, mesh): void
registerSceneWithShadowSupport(scene): Promise<void>
isGpuTimingSupported(engine): boolean
setGpuTimingEnabled(engine, on: boolean): void
```

### Shapes the client reads or writes

```ts
EngineContext {
  surfaces: Surface[];          // [0] is the main canvas
  drawCallCount: number;        // read: PerfReport.tsx:217, cost.ts:69
  gpuFrameTimeMs: number;       // read: Canvas.tsx adaptive DPR (GPU_MS = 12), PerfReport.tsx:126
  _device: GPUDevice;           // PRIVATE, read: PerfReport.tsx:92 (adapter info / limits)
}
Surface { canvas; format: GPUTextureFormat; maxDevicePixelRatio: number /* written every frame */; engine }
SceneContext {
  clearColor: {r,g,b,a};        // written: Canvas.tsx, DayNightCycle.tsx at(), dots.ts:283, studio (transparent)
  camera: FreeCamera;           // read: Canvas.tsx (worldMatrixVersion, fov)
  meshes: Mesh[];               // read: still.ts layers getter, PerfReport.tsx:217, cost.ts
  lights: Light[];              // read: trees.ts (find the one with shadowGenerator)
  imageProcessing: { toneMappingEnabled: boolean; toneMapping: ToneMapping; exposure: number; contrast?: number };
  _renderableVersion: number;   // PRIVATE, read: still.ts holding()
  _renderables: Map<Mesh, …>;   // PRIVATE, read: ground.ts:384-395, cost.ts:93
}
```

### Boot order (Canvas.tsx:151-200) and why it matters

1. `createEngine(el, { maxDevicePixelRatio: 2, msaaSamples: devicePixelRatio < 2 ? 4 : 1 })`
2. `enableSurfaceResizeObserver(engine.surfaces[0])`
3. `scene = createSceneContext(engine)`, then set `scene.clearColor = {…, a: 1}`
4. `enableMaterialPlugins(scene)`, `enablePbrMaterialPluginVertexData()`, `await enablePixelTextureMipmaps()`. These are opt-in bundle loaders and must run before any plugin material is built.
5. The client builds the world: lights, daylight, terrain, town, `createStill`, `createOutline`. Each `prepare(promise)` is collected.
6. `await` the collected promises, then `await registerSceneWithShadowSupport(scene)`. After this the scene renders with CSM and clustered lights.
7. `createStudio(engine, …)`
8. The client runs its own rAF loop (Lite's render loop is not used). Per frame:
   - `surface.maxDevicePixelRatio = dpr`
   - `resizeEngine(engine)`
   - the before hooks (camera, day/night, cars, …)
   - `cull.update()`
   - `still.frame(now, () => renderFrame(engine, delta, [engine.surfaces[0]]))`
   - the after hooks
9. On teardown: `disposeEngine(engine)`.

Adaptive DPR reads `engine.gpuFrameTimeMs` when `isGpuTimingSupported`, and frame gaps otherwise. Camera movement is detected through `scene.camera.worldMatrixVersion` and `fov`. Dev handles: `window.sprawlLite = { engine, scene, cull, hideUi }` and `window.sprawlCost` (cost.ts).

**Drop?** A new renderer can make steps 4 and 6 implicit, with one `init()` that loads everything. Shadow support and plugins are always on in this game.

---

## 2. Camera, math, picking

```ts
createFreeCamera(name, position: Vec3, scene?): FreeCamera
attachFreeControl(camera, canvas)          // Camera.tsx; the client drives the camera itself, and this only binds inputs Lite needs (keep it a no-op-able call)
getCameraPosition(camera): Vec3            // reads worldMatrix[12..14]
getViewProjectionMatrix(camera, aspect: number): Float32Array   // still.ts aim(); Camera.tsx
invertMat4(m: Float32Array, out?: Float32Array): Float32Array
composeMat4IntoBuffer(dst: Float32Array, off: number, tx,ty,tz, qx,qy,qz,qw, sx,sy,sz): void  // column-major TRS
createPickingRay(scene | camera, x, y, …): { origin: Vec3; direction: Vec3 }   // Camera.tsx:308-314, Brush.tsx:53
```

```ts
FreeCamera {
  position: ObservableVec3;    // .set(x,y,z), .x/.y/.z writes bump the world matrix
  target: ObservableVec3;      // same
  fov: number;                 // vertical, radians, default 0.8; studio uses 0.35
  nearPlane: number; farPlane: number;
  worldMatrix: Float32Array;   // read
  worldMatrixVersion: number;  // read, bumps whenever position, target or fov change
}
```

Call sites:
- Camera.tsx:93-97, 113-114, 190, 308-314, 343
- view.ts:25, 30
- still.ts:389-393 (`eye` is a second FreeCamera whose position, target, near and far are copied from the main camera)

Each frame still.ts sets `eye.fov` from `picture.rt._height / canvas.height` so the margin is covered (§9.3). Any matrix produced must match Lite's within float error: the still picture is reprojected with these matrices, and a mismatch shows as swimming.

**Drop?** The `eye` camera, together with `aim()`, exists only to render a larger frustum. A renderer that renders with an overscan parameter could drop it.

---

## 3. Meshes, thin instances, attributes

### Creation and updates

```ts
createMeshFromData(engine, name: string, positions: Float32Array, normals: Float32Array,
                   indices: Uint32Array, uvs?: Float32Array, uvs2?: Float32Array,
                   tangents?: Float32Array, colors?: Float32Array /* rgba per vertex */): Mesh
updateMeshPositions(engine, mesh, positions: Float32Array, vertexOffset = 0, count?: number): void  // field.ts:283
setMeshAttribute(engine, mesh, bufferName: string, data: Float32Array): void
   // the data of a plugin attribute buffer (§5.3). Grows the GPU buffer if it is too small, AND BUMPS `_vis` WHEN IT GROWS.
setMeshVisible(mesh, visible: boolean): void   // subtree; bumps `_vis` only on an actual change
disposeMeshGpu(engine, mesh): void
markMeshRenderableDirty(mesh): void            // forces a rebuild of the bind groups/pipeline (atlas.ts, after the atlas texture object is replaced)
```

### Mesh fields the client uses

```ts
Mesh {
  name: string;                    // cost.ts groups by name with the chunk stripped (ground_, chunk_tree_tops, inst_…)
  material: PbrMaterial | ShaderMaterial;
  position: { x, y, z };           // merged.ts region offsets; field.ts:290 STIR HACK (below)
  receiveShadows: boolean;         // field.ts:262, InstancePool, ground
  renderOrder: number;
  visible: boolean;                // read: cost.ts:177
  thinInstances?: { matrices: Float32Array; count: number };  // read: Highlight.tsx:38, cost.ts:177
  _gpu: { indexCount: number };    // PRIVATE read: cost.ts:177
}
```

Note the **stir hack**, field.ts:290: `crop.position.z = crop.position.z ? 0 : 1e-6`. It nudges the mesh so its world matrix changes, which forces the static shadow cache (§8) to redraw. A renderer with an explicit "this caster changed" call drops it.

### Thin instances

```ts
setThinInstances(mesh, matrices: Float32Array /* 16 per instance, column-major */, capacity: number): void
setThinInstanceCount(mesh, count: number): void   // RE-UPLOADS matrices[0, count) from the same array
setThinInstanceColors(mesh, colors: Float32Array /* rgba per instance */): void   // merged.ts
flushThinInstances(mesh): void                    // Highlight.tsx
```

How the client uses them:
- merged.ts:108-115, 136-137, InstancePool.tsx:57, 135-137, 269, 272, and Highlight.tsx:27, 38 call `setThinInstances` once with a capacity.
- The client then **keeps writing into the same Float32Array** and calls `setThinInstanceCount(n)` to publish it. The renderer must keep that array as the CPU source.
- Highlight's ghost meshes are **not added to the scene**. They are drawn only through `addMeshToTask` on the outline task (§9.4).

Shader semantics:
- In VW, `finalWorld = mesh.world * mat4(world0, world1, world2, world3)`.
- Instance colour is applied in AT: `baseColor *= vInstanceColor.rgb; alpha *= vInstanceColor.a`.
- Vertex colour is applied in the baseColor decode, **before** AT: `baseColor *= input.vColor.rgb; alpha *= input.vColor.a`.

### `_vis`, the visibility epoch

```ts
import { _vis } from "@babylonjs/lite/src/engine/engine";   // still.ts
```

This is a live-binding module counter. It bumps on any `setMeshVisible` change and on any `setMeshAttribute` growth. still.ts uses `` `${scene._renderableVersion},${_vis}` `` as a "the static scene changed" key that triggers a redraw of the still picture (§9.3).

**Drop?** A public `scene.contentVersion` replaces both private reads.

---

## 4. Textures

```ts
createTexture2DFromPixels(engine, data: Uint8Array | Uint16Array | Float32Array, w, h, opts?: {
  format?: GPUTextureFormat;          // default rgba8unorm; the client also uses rg16float (peaks), r8/rgba8 atlases
  mipmaps?: boolean;                  // needs enablePixelTextureMipmaps() first
  minFilter?, magFilter?: GPUFilterMode;     // default "nearest"
  addressModeU?, addressModeV?: GPUAddressMode;  // default clamp-to-edge
  srgb?: boolean;                     // unused by the client
}): Texture2D
updateTexture2DFromPixels(engine, tex, data, x = 0, y = 0, w?, h?): void   // regenerates mips if it has any
releaseTexture(engine, tex): void
enablePixelTextureMipmaps(): Promise<void>
Texture2D { texture: GPUTexture; view: GPUTextureView; sampler: GPUSampler; width: number; height: number; _sampleType?: GPUTextureSampleType }
```

The client also builds `Texture2D` literals by hand from geometry-task outputs (still.ts:511-515) and reads `texture.height` (atlas.ts:71). The sampler travels with the texture: plugin sampler pairs bind `tex.sampler`, and a ShaderMaterial comparison sampler uses the texture's own sampler (§6).

Call sites:
- field.ts:348 (the cuts, nearest), 394, 466
- ground.ts:443-450
- TerrainChunks.ts:248-257
- peaks.ts:172
- atlas.ts:37
- tints.ts:24
- water.ts
- finishes.ts:119
- bakeCache.ts:57-58

---

## 5. PBR material and MaterialPlugins

### 5.1 Material

```ts
createPbrMaterial(props: PbrMaterialProps): PbrMaterial
PbrMaterialProps { metallicFactor?: number; roughnessFactor?: number; baseColorTexture?: Texture2D;
                   plugins?: MaterialPlugin[]; doubleSided?: boolean; … }
enableMaterialPlugins(scene): void          // Canvas.tsx and studio.ts, once per scene
enablePbrMaterialPluginVertexData(): void   // global; enables getAttributes / varyings / VR/VW/VB
markMaterialUboDirty(material): void        // bumps _uboVersion; the renderer calls writeUbo() again before the next draw
```

Fields the client writes after creation:
- `roughnessFactor`: lacquer in bevel.ts, then `markMaterialUboDirty`.
- `metallicFactor = 1`: Steel in props.ts.
- `doubleSided = true`: the peaks material, the tree body.

Defaults the shader relies on:
- `material.reflectance` 0.04
- `material.materialAlpha` 1
- `environmentIntensity` 1
- `directIntensity` 1

`townMaterial(plugins, roughness = 0.9, texture?)` (material.ts:84-89) is the one constructor everything goes through:

```ts
createPbrMaterial({ metallicFactor: 0, roughnessFactor: roughness, baseColorTexture: texture, plugins: [OPEN, ...plugins, close(town)] })
```

`texture` is never passed in practice. Materials are cached per engine and **shared across the main scene and the studio scene**, as with trees and props. A material must therefore be renderable in two scenes with different lights and shadow generators.

### 5.2 The MaterialPlugin interface (lite:material/plugin/material-plugin.ts)

```ts
interface MaterialPlugin {
  readonly name: string;                 // part of the pipeline cache key
  priority?: number;                     // default 500; lower runs first; stable sort
  isEnabled?: boolean;
  defines?: Record<string, boolean | number>;
  getCustomCode?(stage: "vertex" | "fragment"): Partial<Record<MaterialPluginPoint, string>> | null;
  getUniforms?(): { ubo?: { name: string; type: string; visibility?: "vertex" | "fragment" | "vertex-fragment" }[] };
  getAttributes?(): { name: string; type: "f32" | "vec2<f32>" | "vec3<f32>" | "vec4<f32>"; perInstance?: boolean; buffer?: string }[];
  getVaryings?(): { name: string; type: "f32" | "vec2f" | "vec3f" | "vec4f" | "vec2<f32>" | … }[];
  getSamplers?(): { texture: string; sampler: string; depthTexture?: boolean;
                    samplerType?: "sampler" | "sampler_non_filtering"; visibility?: … }[];
  writeUbo?(data: Float32Array, offsetsInBytes: ReadonlyMap<string, number>): void;   // index = offset / 4
  bindTextures?(out: { texture: Texture2D }[]): void;   // same order as getSamplers; called when the bind group is (re)built
  getActiveTextures?(out: Texture2D[]): void;
}
```

How the parts are wired:
- **UBO fields** are appended to the material UBO and read in WGSL as `material.<name>`. `writeUbo` runs on creation and again after each `markMaterialUboDirty`. The tree card's `treeSun` is marked dirty every frame and has `visibility: "vertex"`.
- **Attributes** become `@location` inputs, readable by name in vertex code. Attributes that share a `buffer` are interleaved in declaration order, and the data comes from `setMeshAttribute(engine, mesh, buffer, data)`. A `perInstance` attribute steps per thin instance.
- **Varyings** are added to `VertexOutput`/`FragmentInput`. Vertex code writes `out.<name>`; fragment code reads `input.<name>`.
- **Samplers** are declared as `var <texture>: texture_2d<f32>` (or `texture_depth_2d`) and `var <sampler>: sampler`.

### 5.3 Hook points: where they sit, and in which pass they run

The fragment template (lite:material/pbr/pbr-template.ts:472-530) runs in this order. Each row shows the locals in scope at that point.

| Key | BJS name | Position (what is in scope) | Forward (colour) | Shadow / depth-only | G-buffer (`stillLayers`) |
|---|---|---|---|---|---|
| HF | `CUSTOM_FRAGMENT_DEFINITIONS` | Module scope, before `main`. For helper `fn`s. | yes | yes | yes |
| SV | `CUSTOM_FRAGMENT_MAIN_BEGIN` | The first statement of `main`. Only `input`, `scene`, `material`, `mesh` and the samplers exist. `frontFacing` exists if doubleSided. | yes | **yes** | yes |
| AT | `CUSTOM_FRAGMENT_UPDATE_ALPHA` | After `baseColorSample`, `var baseColor`, `var alpha` (vertex colour already applied), `orm`, `var occlusion`, `var roughness`, `var metallic`, `var emissive`. Thin-instance colour is applied here first. | yes | **yes, and it is the last code: the template is `/*AT*/ return;`** | yes |
| AC | `CUSTOM_FRAGMENT_UPDATE_DIFFUSE` | After the normal block: `var N_geom`, `var N` (with the doubleSided flip). Before `V`. | yes | **no** | yes |
| MF | `CUSTOM_FRAGMENT_BEFORE_LIGHTS` | After `V`, `NdotV`, `colorF0`, `colorF90`, `surfaceAlbedo`. | yes (unused by the client) | no | yes |
| AI/NI | `CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION` | After `var color = directDiffuse + directSpecular + emissive` and IBL (AI). Before fog and tone mapping. | yes | no | colour not written |
| BC | `CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR` | After tone map, gamma, clamp and contrast. Before `return vec4(color, alpha * material.materialAlpha)`. | yes | no | colour not written |
| VR | `CUSTOM_VERTEX_MAIN_BEGIN` | Start of the vertex `main`; `var out` exists. | yes | yes | yes |
| VW | `CUSTOM_VERTEX_UPDATE_WORLDPOS` | After `var finalWorld = mesh.world` (and the thin-instance multiply). Before `worldPos4`. | yes | yes | yes |
| VB | `CUSTOM_VERTEX_MAIN_END` | After `out.worldPos`, `out.clipPos = scene.viewProjection * worldPos4`, `out.worldNormal`, `out.uv`, `out.vColor`. Just before `return out`. | yes | yes | yes |

Rules a new renderer must keep, or deliberately replace:

1. **One function scope.**
   - All fragment hooks paste into one `main`, in priority order (stable sort, default 500).
   - Locals declared in an earlier hook are read in later ones. Examples: `townShine` (OPEN, SV, -1e6); `crownTex` and `crownTurn` (trees AT → AC); `kerbBand` (kerbs AC, read by paving AC, priority 210 → 220); field locals from AT to AC.
   - The renderer's own code after the hooks must not reuse names that plugins declare. Some of the plugin locals: water's `shore rock foam wave phase lace fuzz slate ripple fields seaward climb cover crest`, kerbs' `kerbBand`, trees' `crownTex crownTurn`, field's strip locals.
   - A new renderer should prefix its own post-hook locals (e.g. `_r_`) or end the hooks' scope before them.
2. **Uniform control flow.** Hooks sit at the top level of `main`, and plugins call `textureSample`, `dpdx`/`dpdy`/`fwidth` and `textureSampleGrad` there. Nothing above them may branch. **`discard` is used in SV, AT and AC**. `discard` keeps derivatives valid in WGSL (demote-to-helper), so keep that.
3. **The shadow pass stops after AT.**
   - Only VR, VW, VB, HF, SV and AT run there.
   - Consequences the client relies on:
     - CAST_ONLY (`AC: discard;`) gives meshes that cast shadows but are never seen (the tree body).
     - Cut-outs in SV and AT (crown, card, cliff, field, roads) shape the shadow.
     - Varyings plus `input.worldPos` and `input.worldNormal` must exist in the shadow pass's fragment input.
   - peaks.ts VW detects the shadow pass through `scene.viewProjection[2][3] == 0.` (ortho) and pushes vertical faces back.
4. **The G-buffer pass** (the geometry task) runs the full shader with every hook, then writes:
   - `ALBEDO = surfaceAlbedo`
   - `WORLD_NORMAL = N*0.5+0.5` (rgba8unorm)
   - `REFLECTIVITY = vec4(colorF0, 1 - roughness)`

   Every write is masked by `select(0, 1, alpha > 0.4)`, which is why tints.ts:51 sets `alpha = 1.0`, and the masses' vColor.a (the window flag) must not leak into alpha. still.ts needs exactly these three.
5. **Vertex colour carries data, not colour.** On the town masses (TownLayer.ts):
   - `vColor = (shade a, shade b, tint slot, window flag)`.
   - The template multiplies it into baseColor and alpha before AT.
   - The tint plugin (tints.ts, AC 220) **overwrites** baseColor from the `tints` texture and sets `alpha = 1`.
   - WINDOWS (TownLayer.ts:94, NI) reads `1. - input.vColor.a`.
   - The car finish reads `input.vColor.r < 0.7` as "glazed".

   A new renderer must either keep `input.vColor` raw and the multiply, or (better) give the plugins a raw `input.vColor` and not multiply (§12).

### 5.4 WGSL names the plugins can see

**Fragment, read and/or written:**
```
baseColor: vec3f (var)     alpha: f32 (var)        roughness: f32 (var)    metallic: f32 (var)
N: vec3f (var)             N_geom: vec3f           color: vec3f (var, from NI on)
occlusion, emissive, V, NdotV, colorF0, colorF90, surfaceAlbedo  (in scope, not used by the client)
frontFacing: bool          (doubleSided materials only)
townShine: f32             (declared by OPEN in SV; read by TownClose's AC)
input.worldPos  input.worldNormal  input.uv  input.clipPos (.xy = pixel, for dither)  input.vColor
input.v<plugin varying>    e.g. vGroundGrass vGroundAt vGroundSlot vGroundLook vGroundX vGroundY,
                           vPeakAt, vWaterAt, vKerbAt, vBevel*, vCrown vCrownTurn vCrownCell,
                           vPropMid vPropBroad vPropFacing, field strip varyings
scene.vEyePosition (.xyz)  scene.viewProjection  scene.vImageInfos (.x exposure, .y contrast)
material.<plugin ubo field>  material.roughnessFactor  material.metallicFactor
<plugin texture> / <plugin sampler> pairs
discard
```

**Vertex:**
```
position: vec3f  normal: vec3f  uv  (attribute inputs by name)
<plugin attribute> by name, e.g. groundSlot groundLook groundGrass roadSlot roadLift roadClimb
                   bevelAcross0 bevelAcross1 bevelAcross2 bevelReach bevelAt stripA stripB stripTex
finalWorld: mat4x4f (var; VW may replace it wholesale — tree cards do)
mesh.world  scene.viewProjection  material.<ubo field with vertex visibility>  (treeSun)
out.worldPos (written in VB by roads, which then recompute)  out.clipPos = scene.viewProjection*vec4f(out.worldPos,1.)
out.<plugin varying>
```

### 5.5 The plugins, by file

| File:line | Plugin (priority) | Hooks | Notes |
|---|---|---|---|
| material.ts:47 | OPEN (-1e6) | SV `var townShine: f32 = 0.0;` | |
| material.ts:98 | TownClose (1e6) | AC | ubo `townTint vec4`. Ends with `baseColor = pow(max(baseColor*material.townTint.rgb,vec3(0)),vec3(2.2)); roughness = mix(roughness, 0.12, townShine);`. |
| material.ts:107 | FLAT | NI `color = baseColor;` | unlit |
| material.ts | CAST_ONLY | AC `discard;` | cast only, never seen (relies on rule 3) |
| ground.ts:151 | ground (210) | VB, SV, AC | attrs `groundSlot groundLook groundGrass` (`vec4 perInstance`, buffer `"ground"`); 6 samplers; ubo `groundGrid vec2`, `groundTime f32`. SV uses textureSample/Level/Grad, dpdx and discard. AC writes `townShine`, `baseColor`, `roughness`, `N`. Thin instances with identity-scale matrices; renderOrder 120. |
| peaks.ts:172,252 | Basalt, LandCliff | VW, VB, AT, AC | `peakHeights` rg16float via `textureLoad`; sampler `slate`; ubo `peakCorner`. VW pushes vertical faces back in the shadow pass only. doubleSided. |
| water.ts:308,323 | water | AC | varying `vWaterAt`, ubo `waterTime`. Writes N, baseColor, roughness; many locals. |
| roads.ts:224-250 | road | VB, SV, AC | `roadSlot f32 perInstance` (own buffer); `roadLift`, `roadClimb vec4 perInstance` in buffer `"roadLifts"`. VB rewrites `out.worldPos.z` and `out.clipPos`. Reads `material.townTint`. renderOrder 90. Thin-instance capacity grows. |
| kerbs.ts:26 | kerb (210) | VB, AC | varying `vKerbAt`; ubo `kerbOrigin kerbSize kerbTexel vec2`. Declares `kerbBand`. |
| paving.ts | paving (220) | SV, AC | reads `kerbBand` when kerbed |
| bevel.ts:127,198-201 | bevel (200) | HF, VB, AC | 5 vec3 attrs, buffer `"bevel"`; varyings `vBevel*`; ubo `bevelWidth bevelSoft`. AC rewrites N. |
| tints.ts:24,51 | tints (220) | AC | `textureSampleLevel(tints…)` (nearest); `alpha = 1.0` |
| roofs.ts | roof (230) | HF, AC | dpdx/dpdy/fwidth of `input.worldPos` and the bevel varyings |
| TownLayer.ts:88-95 | WINDOWS (230) | NI | ubo `windowGlow` |
| trees.ts:252-256 | Crown (200), Card (200) | VB, VW, AT, AC | The card ubo `treeSun` (vertex) is updated every frame from `scene.lights.find(l => l.shadowGenerator).direction`. The body is `[card, CAST_ONLY]`, doubleSided. |
| props.ts:67,192,217 | LampHead, card plugins | NI, VB, AC | ubo `lampGlow`, `propTurn`; varyings `vPropMid vPropBroad vPropFacing` |
| objects/finishes.ts:107,119 | coats (900), GLASS | AC, NI | `metallic = 1.`, `input.uv`, dpdx/fwidth. PAVING wraps paving SV in `if (input.uv.x < 0.) { discard; }`. |
| field.ts:262-295 | field (210) | VB, AT, AC | `stripA stripB vec4` buffer `"strip"`, `stripTex f32`; 3 samplers; 6 vec4 ubo fields |
| objects/CarObject | finish (900) | AC | `roughness`, glazed from `input.vColor.r < 0.7` |
| outline.ts | paint (1e6) | BC `color = vec3f(r,g,b); alpha = 1.0;` | (§9.4) |

**Drop?** The plugin system is the bulk of the contract. A deferred renderer can keep the hooks as the "surface function" (SV/AT/AC produce baseColor, N, roughness, metallic, alpha, emissive), drop NI/BC (glow becomes emissive), and lose the lighting code entirely from the plugin shaders.

### 5.6 Tone mapping and output, as the forward path does them

```wgsl
// AI: IBL (env cube irradiance from SH + prefiltered specular) × environmentIntensity
// NI: plugin code
color = toneMap(color * scene.vImageInfos.x);              // TONE.callWGSL, toneMap.ts (AgX "agx-rich", agx(1.7, 1.35))
color = pow(color, vec3(1/2.2)); color = clamp(color, 0, 1);
let hc = color*color*(3-2*color);
if (scene.vImageInfos.y < 1) { color = mix(vec3(.5), color, y); } else { color = mix(color, hc, y-1); }
// BC: plugin code
return vec4(color, alpha * material.materialAlpha);
```

```ts
ToneMapping { id: string; helpersWGSL: string; callWGSL: string }   // toneMap.ts
scene.imageProcessing = { toneMappingEnabled: true, toneMapping: TONE, exposure: 2.7 }  // DayNightCycle.tsx
```

`scene.vImageInfos` = `(exposure, contrast, lodGenerationScale, toneMappingEnabled)`. still.ts carries `exposure` into its own shader as `sky.w`, and must invert this exact curve to recover linear light (`unshown`/`shown`).

---

## 6. ShaderMaterial

```ts
createShaderMaterial(engine, {
  name, vertex: string, fragment: string,                 // WGSL; entry points mainVertex / mainFragment
  attributes: string[],                                    // ["position"] → struct VertexInput { @location(0) position: vec3f }
  uniforms: { name: string; type: "f32" | "vec2" | "vec4" | "mat4" }[],
  samplers: (string | { name: string; sampleType?: "float" | "depth" | "unfilterable-float";
                        viewDimension?: "2d" | "2d-array"; comparison?: boolean })[],
  storageBuffers?: { name: string; type: string }[],       // var<storage, read>
  backFaceCulling?: boolean, depthWrite?: boolean, depthCompare?: GPUCompareFunction,
  needAlphaBlending?: boolean, blendMode?: "additive" | …,
}): ShaderMaterial
setShaderUniform(mat, name, value: number | Float32Array | number[]): void
setShaderTexture(mat, name, tex: Texture2D): void
createStorageBuffer(engine, bytes | data): StorageBuffer
updateStorageBuffer(engine, buf, data: Float32Array): void
setShaderStorageBuffer(mat, name, buf): void
wgsl`…`   // a tagged template that only minifies and passes through; used everywhere WGSL is written
```

The prelude the client's WGSL assumes:
- `SCENE_UBO_WGSL` is prepended, so `scene.*` is in scope.
- `@group(1) @binding(0) shaderSystem`.
- `@group(1) @binding(1) var<uniform> shaderUniforms: struct { … in declared order }`, read as `shaderUniforms.screen` and so on.
- Each sampler `x` declares `var x: texture_2d<f32>` (or `texture_depth_2d`, or `texture_depth_2d_array` for depth with `2d-array`) and `var xSampler: sampler` (or `sampler_comparison`). A comparison sampler uses the texture's own sampler.
- `@builtin(vertex_index)` is used (stillBeams) and `@builtin(frag_depth)` is written (still).

The three materials:

| Name | File | Uniforms | Samplers / storage | State |
|---|---|---|---|---|
| `still` | still.ts:543-561 | `screen vec2`; `seen seenInverse stillView stillInverse mat4`; `sky sunDir sunColor vec4`; `shadowMatrix mat4`; `shadowInfo vec4` | `still` (float), `stillDepth` (depth), `albedo`, `facing`, `shine`, `shadowNow` and `shadowStill` `{viewDimension:"2d-array", comparison:true}` | no culling, depthWrite, `depthCompare:"always"`, writes `frag_depth` |
| `stillBeams` | still.ts:570-584 | the same view uniforms plus `sky` | `picture`; storage `beams: array<vec4<f32>>` (12 floats a beam: pos, range, diffuse*k, cos(angle/2), dir) | depthWrite false, always, alpha blend **additive**; positions all zero, the vertex places them from `vertex_index` |
| `outline` | outline.ts:92-135 | `width f32` | `samplers: ["mask"]` | alpha blend, no culling, depthWrite false, always |

ShaderMaterials are put on meshes made with `createMeshFromData` and added to the scene like any mesh. They draw in renderOrder among the PBR meshes.

---

## 7. Lights, clustered lights, environment

### Directional light (the sun)

```ts
createDirectionalLight(dir: Vec3, intensity = 1): DirectionalLight
DirectionalLight { direction: ObservableVec3 /* .set() */; diffuse; specular: [r,g,b]; intensity; shadowGenerator?: ShadowGenerator }
setLightDiffuseColor(light, r, g, b): void
```

DayNightCycle.tsx:339-348 sets `.specular = [0,0,0]` and then sets it each `at()`. There is one sun per scene; the studio makes its own through `daylight(main, scene, 1024)`.

### Clustered point and spot lights (lights.ts)

```ts
createClusteredLightContainer({ horizontalTiles, verticalTiles, zSlices: 1 }): ClusteredLightContainer   // about 2048 tiles
createClusteredPointLight(c, { position, diffuse, range: 2, intensity: 0 }): ClusteredPointLight     // 192 of them
createClusteredSpotLight(c, { position, direction, diffuse, angle: 0.9, range: 2.2, intensity }): ClusteredSpotLight  // 128 of them
addClusteredLightContainer(scene, c): void   // the light count is FIXED from here on
markClusteredLightContainerDirty(c): void    // after mutating .position, .direction, .intensity in place
```

lights.ts:72-75, 99-101, 116-122 use fixed slot pools. A slot that is not in use has `intensity = 0`. Each frame:
- `position[i]`, `direction[i]` and `intensity` are mutated in place.
- `markClusteredLightContainerDirty` is called.
- still.ts `hold()` zeroes the headlights (the spots) around the picture render, then marks the container dirty again.

The maths, which must be matched:
```
rangeAtt  = 1/d² · saturate(1 − (d²/r²)²)²
spot      = saturate((cosθ − cos(angle/2)) / (1 − cos(angle/2)))²
radiance  = rgb · intensity · rangeAtt · material.directIntensity
BRDF      = GGX D, Smith G, Schlick F (the same as still.ts `lightOn`)
```
The lights live in a texture, `clusteredLights`.

### Environment (sky.ts:79, 83)

```ts
createCubeEnvironment(engine, { size: 16, faces: [ +X, −X, +Y, −Y, +Z, −Z ] /* RGBA pixel arrays */ }): CubeEnvironment
updateCubeEnvironment(engine, env, faces): void   // every 1/1024 of a day; re-derives SH and the prefiltered mips
```

The environment gives diffuse irradiance through spherical harmonics (`scene.vSphericalL00…L22`) and specular from the prefiltered cube. `envRotationY` is in the scene UBO, but the client does not rotate it.

---

## 8. Shadows: CSM and the static cache

```ts
createCsmDirectionalShadowGenerator(engine, sun, { mapSize, numCascades: 1, bias: 0.001, cascadeBlendPercentage: 0 }): ShadowGenerator
setShadowTaskCasterMeshes(gen, meshes: Mesh[]): void       // the explicit caster list; DayNightCycle at() when it changes, field.ts
setShadowGeneratorBounds(gen, min: [x,y,z], max: [x,y,z]): void   // [bx−h, by−h, −1] … [bx+h, by+h, h]
setShadowGeneratorEnabled(gen, on): void                   // off: darkness written as 1 in the receiver UBO, and onCsmReceiverUpdate fires again
enableCsmStaticCache(engine, gen, { refitAngle: 0.008, still: (mesh) => boolean }): Promise<void>
setShadowStaticOnly(gen, on: boolean): boolean   // still.ts; returns whether the static map was drawn
getCsmReceiverTexture(gen): Texture2D            // the live map, 2d-array depth
getCsmStaticTexture(gen): Texture2D | undefined  // the cache of static casters
onCsmReceiverUpdate(gen, (data: Float32Array /* 80 floats */) => void): void
```

The receiver UBO layout read by still.ts:
- `data[0..16)` is cascade 0's matrix.
- `data[72..76)` is `(darkness, mapSize, 1/mapSize, frustumEdgeFalloff)`.
- still.ts copies `shadowMatrix = data[0..16]` and `shadowInfo = [?, data[73], data[74], data[72]]`, a reordering (still.ts:627-630).

Private fields the client touches:
- `gen._runtimeEnabledState?.enabled !== false` (still.ts `shade()`, cost.ts:108)
- `gen._shadowTaskState._casterMeshes` (cost.ts:110)
- `gen._preloadPending` (studio.ts:88; it waits until caster pipelines are built)

Mapsize is 512 to 2048 (main) and 1024 (studio). The bounds are refit when the sun moves more than `refitAngle`. The static cache redraws only when a static caster changes: its world matrix or its visibility. This is what field.ts's stir hack exploits.

**Drop?**
- A deferred renderer that owns the still picture (§9.3) can own static/dynamic shadow separation internally. That would retire `setShadowStaticOnly`, `getCsmStaticTexture`, `onCsmReceiverUpdate`, the 80-float layout, and the private reads.
- Explicit caster lists could become a per-mesh `castsShadow` flag.

---

## 9. Frame graph, render tasks, render targets

### 9.1 API

```ts
getFrameGraph(scene): { _tasks: RenderTask[] }       // PRIVATE _tasks: still.ts finds name === "scene"
createRenderTask(scene, cfg: RenderTaskConfig): RenderTask
addTaskAtStart(scene, task): void   // inserts AFTER the "shadow" task
addMeshToTask(task, mesh, { material?: Material }): void   // draw this mesh in this task with an override material
removeMeshFromTask(task, mesh): void
createSurfaceRenderTargetTexture(engine, { lbl, format, dFormat: "depth24plus", samples: 1,
     size: Surface | { surface, scale } }, ext?: typeof withSampledDepthTexture): { rt, texture: Texture2D, depthTexture?: Texture2D }
withSampledDepthTexture       // extension: the depth attachment is also sampleable
onRenderTargetTextureResize(rtt, cb: () => void): void   // called after the surface resize reallocates it; rebind textures here
createGeometryRendererTask(scene, cfg): GeometryRendererTask
GeometryTextureType.{ ALBEDO, WORLD_NORMAL, REFLECTIVITY }
```

```ts
RenderTaskConfig {
  name: string; rt?: RenderTarget; rst?: ResolveTarget; depth?;
  clrColor?: {r,g,b,a};            // default scene.clearColor
  clr?: boolean;                    // default true
  depthClear?: number; sharedRt?: boolean;
  cam?: Camera;                     // default scene.camera
  cs?: boolean;                     // custom meshes only: draw only addMeshToTask meshes
  autoMirror?: boolean;             // default true: draw every scene renderable
  keep?: (m: Mesh) => boolean;      // filter on the auto-mirrored renderables
}
RenderTask { name; enabled: boolean; executionEnabled: boolean; _config: RenderTaskConfig; record(...) }
```

The tasks as built, in order: `[shadow, outline, stillLayers, still, scene]`. still was added first, then layers, then outline, each with `addTaskAtStart`. The automatic `scene` task is `{ name: "scene", rt: surface target, rst: msaa ? surface.scRT : undefined, depth }`.

### 9.2 Geometry renderer task (`stillLayers`, still.ts:415-452)

```ts
createGeometryRendererTask(scene, {
  name: "stillLayers", camera: eye, size: /* = the picture rt */,
  depthTexture: picture.rt,           // shares the still picture's depth (load, not clear)
  get meshes() { return scene.meshes.filter(m => !lives.has(m)) },   // a GETTER, re-read every record
  textureDescriptions: [{ type: ALBEDO }, { type: WORLD_NORMAL, format: "rgba8unorm" }, { type: REFLECTIVITY }],
})
```

What still.ts does with it:
- `executionEnabled = false` normally.
- **`layers.record` is monkey-patched** to call `bindLayers()` after recording, because the outputs are (re)created lazily.
- Outputs `geometryAlbedoTexture`, `geometryWorldNormalTexture` and `geometryReflectivityTexture` are read through PRIVATE `_colorView`, `_colorTexture`, `_width` and `_height`, and rewrapped as `Texture2D { texture, view, sampler, width, height }` for `setShaderTexture(still, "albedo" | "facing" | "shine", …)`.
- The G-buffer contents are given in §5.3, rule 4.

### 9.3 The still picture (still.ts), the most demanding consumer

Its purpose: render the static scene once into an oversized target (scale `1 + 2*MARGIN`, MARGIN 0.12), then each frame:
- draw it as a full-screen quad with `frag_depth`, reprojected from `stillView` to `seen` and relit by headlights and moving shadows;
- draw only the live meshes (cars and so on) over it.

The pieces:
- `picture = createSurfaceRenderTargetTexture(engine, { lbl: "still", format: surface.format, dFormat: "depth24plus", samples: 1, size: { surface, scale } }, withSampledDepthTexture)` (still.ts:347-360)
- `stillTask = createRenderTask({ name: "still", rt: picture.rt, cam: eye, keep: m => !lives.has(m) })`, `enabled = false`
- `main = getFrameGraph(scene)._tasks.find(t => t.name === "scene")`; then `main._config.keep = m => lives.has(m)` (PRIVATE write)
- The quad mesh (`live`, renderOrder `-MAX_VALUE`) uses the `still` ShaderMaterial. The cone mesh (`-MAX_VALUE/2`) uses `stillBeams`.
- `holding()` = `` `${scene._renderableVersion},${_vis}` `` plus the camera's drift from the last aim and the sun's movement. These decide whether a redraw is due.

When a redraw is due, `frame(now, render)` does:
```
aim();                             // copy the camera into eye, widen fov, getViewProjectionMatrix + invertMat4 → stillView/stillInverse
hold();                            // headlight intensities → 0, mark the container dirty
stillTask.enabled = true; layers.executionEnabled = true; main.enabled = false;
setShadowStaticOnly(shadows, true);
render();                          // renderFrame: shadow (static casters) → layers → still
restore();                         // the flags back; drawn = setShadowStaticOnly(shadows, false)
shade();                           // shadowNow = getCsmReceiverTexture, shadowStill = getCsmStaticTexture ?? now, sky.w = exposure
render();                          // the normal frame: shadow (all) → scene (live meshes + quad + cones)
```

The timing contract:
- Toggling `enabled`/`executionEnabled` between two `renderFrame` calls in the same rAF takes effect immediately.
- `keep` is re-evaluated at record time.
- The `meshes` getter is re-read.
- The static-only shadow map is drawn and kept.

**Drop?** All of still.ts is a deferred renderer written from outside. A renderer with a G-buffer and deferred lighting of its own would turn it into:
- one "static content cached, reproject while the camera drifts" feature,
- or, simpler, no cache at all if the deferred frame is cheap enough.

That retires the eye camera, the two tasks, the keep hacks, the monkey-patch, the private texture reads, the tone inversion, the two shaders and the beam storage buffer.

### 9.4 The outline (outline.ts:92-135)

- `mask = createSurfaceRenderTargetTexture(engine, { lbl: "outline", format: "rgba8unorm", dFormat: "depth24plus", samples: 1, size: engine.surfaces[0] })`
- `task = createRenderTask({ name: "outline", rt: mask.rt, clrColor: {0,0,0,0}, cs: true, autoMirror: false })`, added with `addTaskAtStart`. `executionEnabled` is set to whether anything is held.
- Each held ghost (Highlight.tsx: thin-instanced meshes, not in the scene) gets `addMeshToTask(task, mesh, { material: paints[kind] })`, where `paints[kind]` is the mesh's own kind of PBR material plus the `paint` plugin (BC, priority 1e6: `color = vec3f(r,g,b); alpha = 1.0;`). Removal uses `removeMeshFromTask`.
- A full-screen quad (`outline` ShaderMaterial, renderOrder `MAX_VALUE`) is in the scene, toggled with `setMeshVisible(quad, active)`, and edge-detects `mask` with `width`.
- `onRenderTargetTextureResize(mask, () => setShaderTexture(outlineMat, "mask", mask.texture))`.

**Drop?** An "ID/stencil mask" is a natural output of a renderer with its own passes. A per-mesh `outline: rgb | null` would replace the task, the paint materials and the resize rebinding.

---

## 10. The studio (studio.ts)

The studio renders a building model offscreen for UI thumbnails and for the bake cache:
```ts
surface = createSurface(main, new OffscreenCanvas(256, 256), { alphaMode: "premultiplied" });  // :54
scene = createSceneContext(surface); scene.clearColor = { r: 0, g: 0, b: 0, a: 0 };
enableMaterialPlugins(scene);
camera = createFreeCamera(...); fov 0.35, near 1, far 400
lit = daylight(main, scene, 1024);                 // its own sun, CSM and sky
await registerSceneWithShadowSupport(scene);
// … the town layer and ground meshes, made with the SAME engine-cached materials as the main scene …
while (lit.shadows._preloadPending) await idle(); // PRIVATE
renderFrame(main, 16, [surface]);                  // the first shot is taken TWICE: the first renders a scene still building
const blob = await canvas.convertToBlob();
```

The contract:
- A second scene and surface on the same device, rendered on demand, sharing materials and textures with the main scene.
- A transparent clear with premultiplied alpha.
- The output is readable from the OffscreenCanvas.

bakeCache.ts:57-58 caches the results as textures.

**Drop?** A `renderOnce(scene, camera, size): Promise<ImageBitmap>` that waits for its own pipelines would retire `_preloadPending`, the double shot, and the separate surface.

---

## 11. Timing, bench and private reads

| What | Where | Use |
|---|---|---|
| `engine.gpuFrameTimeMs` | Canvas.tsx, PerfReport.tsx:126 | adaptive DPR and bench |
| `isGpuTimingSupported`, `setGpuTimingEnabled` | PerfReport.tsx:114-115, Canvas.tsx | timestamp queries |
| `engine.drawCallCount` | PerfReport.tsx:218, cost.ts:69 | |
| `engine._device` | PerfReport.tsx:92 | adapter info |
| `scene._renderables` | ground.ts:384-395, cost.ts:93 | "is it built yet" and the count |
| `scene._renderableVersion`, `_vis` | still.ts | content key |
| `task._config.keep`, `frameGraph._tasks` | still.ts | |
| `layers.record` (patched), `_colorView/_colorTexture/_width/_height` | still.ts | |
| `rt._width/_height` | still.ts `aim()` | |
| `gen._runtimeEnabledState`, `gen._shadowTaskState._casterMeshes`, `gen._preloadPending` | still.ts, cost.ts:108-110, studio.ts | |
| `mesh._gpu.indexCount`, `mesh.thinInstances?.count` | cost.ts:177-181 | triangle counts |

cost.ts (the `bun run cost` and `?bench` cost table) works as follows:
- It hides each mesh kind with `setMeshVisible`.
- It removes the kind from casters with `setShadowTaskCasterMeshes`.
- It toggles the shadow generator and the light container.
- It measures with `waitForGpuIdle` and the GPU timer.

The new renderer needs equivalents: per-kind visibility, per-kind casting, a stats object `{ draws, triangles, instances }`, and GPU ms.

`waitForGpuIdle(engine)` is used by cost.ts:80-84 and studio between measurements.

---

## 12. Drop candidates: what a new renderer makes unnecessary

The things to keep, as their semantics: meshes with thin instances and attribute buffers; textures; PBR surface plugins (SV/AT/AC); the sun, CSM and clustered lights; tone mapping; the outline; the studio; and stats. The rest is scaffolding around Lite's shape.

1. **The still subsystem (still.ts, 648 lines).** It is a deferred lighting pass and a static cache built from outside the renderer. A renderer with deferred lighting owns the G-buffer, headlights and the shadow split. This retires:
   - `createGeometryRendererTask`, the eye camera, `addTaskAtStart` for still, `keep`, the `layers.record` patch, the private texture reads;
   - `withSampledDepthTexture`, `setShadowStaticOnly`, `getCsmStaticTexture`, `onCsmReceiverUpdate` and the 80-float layout;
   - the headlight `hold()` and the `unshown`/`shown` tone inversion.
2. **The content key** (`_renderableVersion` + `_vis`) becomes a public `scene.contentVersion`, or disappears with item 1.
3. **Async build visibility** (`_renderables` in ground.ts and cost.ts, `_preloadPending`, studio's double first shot). The fix is a `whenReady(mesh|scene): Promise`, or synchronous pipeline creation from a small set of prebuilt pipelines. Few pipelines makes this nearly free.
4. **Opt-in loaders and ordering:**
   - `enableMaterialPlugins`, `enablePbrMaterialPluginVertexData`, `enablePixelTextureMipmaps` and `registerSceneWithShadowSupport` become implicit.
   - The `prepare` collection before registration goes away.
5. **The stir hack** (field.ts:290) becomes an explicit `markCasterDirty(mesh)` or automatic dirtying on `updateMeshPositions`.
6. **Thin-instance two-step** (`setThinInstances(capacity)` then `setThinInstanceCount`, `flushThinInstances`) becomes one `setInstances(mesh, array, count)` over the shared buffer.
7. **vColor as data.** The template multiplies vColor into baseColor and alpha, and the plugins then undo it (tints sets `alpha = 1`, overwrites baseColor). Give plugins raw per-vertex data and do not multiply.
8. **Shadow-pass detection by matrix** (`viewProjection[2][3] == 0`, peaks.ts:252) becomes a defined `pass` constant visible to hooks.
9. **NI and BC hooks** (glow, FLAT, paint) become an emissive output and an unlit flag. The outline paint goes away with item 11.
10. **Fixed light slot pools** (320 lights at intensity 0) become add and remove at any time. That needs a light buffer that can grow, which is natural with big shared buffers.
11. **The outline task, paint materials, `addMeshToTask`/`removeMeshFromTask`, and `onRenderTargetTextureResize`** become a per-mesh outline colour drawn into a renderer-owned mask.
12. **Atlas regrow → `markMeshRenderableDirty`** goes away with bindless-style texture arrays, or bind groups that re-resolve `Texture2D` by reference each frame.
13. **Unused surface:** `baseColorTexture` (never passed), `srgb`, MF/AI hooks, `envRotationY`, fog, and the `sunLight.specular` write (always `[0,0,0]`; just do not do sun specular, or make it a constant).
14. **Client-side culling** (cull.ts:30, 63 toggles visibility because Lite culls nothing). A renderer that culls on the GPU from shared buffers removes it, along with the `_vis` churn it causes.
15. **Cost meter private reads** (cost.ts) become a public `stats()` and per-kind toggles.

The things not to drop, because they are the game's look:
- the AgX curve, `pow(1/2.2)` and the contrast;
- the GGX clustered falloff;
- CSM darkness and softness;
- the shared-scope hook semantics: cut-outs in the shadow pass, and CAST_ONLY.

Those must match to the bit before `?renderer=new` can be compared side by side with `bun run shots`.
