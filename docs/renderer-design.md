# Our own renderer: design (v1)

Status: overnight build, 2026-11-09, branch `claude/project-thread-d7r17m`. Read with
`docs/renderer-contract.md` (what the client asks of Lite, exactly) and
`docs/renderer-ideas.md` (research).

## Goal

The same town, the same look, at a fraction of the main-thread CPU, with a
handful of pipelines, so a phone runs cool. Behind `?renderer=new`; Lite stays
the default until Wytze says otherwise.

## Shape: a drop-in with our own insides

The client keeps calling the functions it calls today. A switch module
`client/src/engine/gpu.ts` re-exports, per symbol, either Lite's or ours:

```ts
import * as lite from "@babylonjs/lite";
import * as own from "../render";
export const NEW = new URLSearchParams(location.search).get("renderer") === "new";
export const createEngine = NEW ? own.createEngine : lite.createEngine;
...
export type { Mesh, ... } from "@babylonjs/lite";   // ours conform structurally
```

Every `from "@babylonjs/lite"` in client/src becomes `from "./gpu"` (or the
right relative path). Pure maths is NOT reimplemented: `createFreeCamera`,
`getViewProjectionMatrix`, `invertMat4`, `composeMat4IntoBuffer`,
`createPickingRay`, `getCameraPosition`, `attachFreeControl`, `wgsl` stay Lite's
in both modes (no GPU in them; bit-identical matrices for free).

Our renderer lives in `client/src/render/` and imports nothing from Lite except
that maths. It owns, internally, what `still.ts` does from outside today: under
`?renderer=new`, `still.ts`'s `createStill` returns a thin object that forwards
`sun()`/`headlights()` to the renderer and its `frame()` just calls
`renderFrame`; `live(mesh)`/`isStill` stay as they are and the renderer reads
`isStill` (exported from still.ts) to sort meshes.

## The frame

Kept, per scene, in our renderer:

| Layer | What | When drawn |
| --- | --- | --- |
| G-buffer (picture eye, 1.24x screen) | still meshes only; MRT: `albedo` rgba8unorm (rgb albedo linear, a = lit weight), `normal` rgba8unorm (N*0.5+0.5, a = roughness), `extra` rgba8unorm (rgb emissive in a compressed range, a = metallic), depth32float (reverse-Z) | on content change, on view change past the margin, on zoom; never for the sun |
| Lit picture (same size) | rgba16float, linear HDR: sun (static shadow map, PCF as Lite), sky (9 SH coefficients + a specular term from the small sky cube for metallic/shiny pixels), emissive; lamps (static) added as screen boxes, additive | after every G-buffer draw, and whenever the sun/sky has moved enough (relight, default every 1 s, cross-fading shadows between the previous and next static map over the interval) |
| Static shadow map | depth32float 2d-array (1 layer), still casters only, fitted to the client's bounds (`setShadowGeneratorBounds`) | when the sun moved past `refitAngle`, bounds changed, or a still caster changed |
| Car shadow map | depth32float, live casters only, same light matrix | every frame any live caster moved |
| Composite (every frame, to the swapchain) | reproject the lit picture to the current eye (today's `find()`, 3 steps into the picture's depth), subtract the sun share where the car map shadows and the static map does not (exact: the sun term is recomputed from the G-buffer in linear light), add headlights as light volumes over the G-buffer, tone map (AgX + gamma + contrast, as Lite) once, write `frag_depth` | every frame |
| Live meshes | forward PBR with the same surface hooks, both shadow maps, a short light list (lamps + headlights in view, in one storage buffer), tone mapped in the shader exactly as Lite does | every frame |
| Outline | object mask for the held/picked ghosts + edge pass (as outline.ts does today, but ours) | only while something is held |

No MSAA (the picture is drawn at 1.24x and the composite filters it; a
supersampled picture is a knob: `?pictureScale=`). The swapchain is cleared by
the composite.

## Materials: the plugins stay, the lighting leaves them

`createPbrMaterial({ plugins, roughnessFactor, metallicFactor, doubleSided })`
plus the plugin interface as in the contract §5.2. Shaders are composed from
three templates, by pass:

- `gbuffer`: VR, VW, VB, HF, SV, AT, AC (MF if present), then NI run twice in
  separate `{}` blocks, once with `color = vec3f(0)` and once with
  `color = vec3f(1)`: NI is affine in `color` for every plugin we have
  (FLAT sets it, glows add to it), so `lit = c1 - c0` (stored as one weight,
  the mean) and `emissive = c0`. Writes masked as Lite (`alpha > 0.4`, else
  discard). BC is ignored (only the outline paint uses it).
- `shadow`: VR, VW, VB, HF, SV, AT, then return. A `PASS` constant
  (`const PASS_SHADOW = true;`) is defined; peaks.ts' `viewProjection[2][3] == 0`
  test must still work, so the shadow pass's `scene.viewProjection` is the
  light's orthographic matrix.
- `forward`: every hook, Lite's lighting (GGX/Smith/Schlick, the clustered
  falloff of contract §7), SH + specular cube IBL, both shadow maps, tone map,
  BC. Used for live meshes and for the studio.

Scope rules from contract §5.3 hold: one `main`, hooks in priority order,
uniform control flow, our own post-hook locals prefixed `_r_`. `input.vColor`
is multiplied into baseColor/alpha before AT, as Lite does (a later step may
drop that, contract §12.7).

Bind groups: group 0 = frame/scene (UBO with the WGSL `scene.*` fields the
plugins read: `viewProjection`, `vEyePosition`, `vImageInfos`, plus ours),
group 1 = material (UBO with `roughnessFactor`, `metallicFactor`,
`reflectance`, plugin fields in declaration order, then plugin textures and
samplers), group 2 = mesh (UBO `world`), group 3 = pass resources (shadow maps,
light list, G-buffer for the composite). Pipelines are keyed by
`pass + plugin signature (code text) + vertex layout + doubleSided + target formats`,
cached for the engine, built with `createRenderPipelineAsync` (a mesh is drawn
from the frame its pipeline is ready; `whenReady()` resolves then).

## Meshes, instances, draws

- A mesh owns its vertex/index buffers (a shared arena is a later step), a mesh
  UBO and a bind group made once. Thin instances are a per-mesh instance vertex
  buffer of mat4 (+ optional colour), grown by doubling; `setThinInstanceCount`
  uploads `[0, count)` (as Lite) until the client tells us ranges.
- Each pass keeps a render bundle per (scene, pass), re-encoded only when its
  draw list changed (a mesh added, removed, shown, hidden, re-materialled, or a
  bind group rebuilt). Nothing is O(meshes) per frame: uniform writes happen on
  dirty flags only, and the frame encodes ~6 passes, each one bundle replay or
  one full-screen draw.
- Visibility from the client's culler (`setMeshVisible`) only edits the draw list
  of the passes that mesh is in.

## Lights

`createClusteredLightContainer` and its point/spot lights are kept as plain
objects; each frame (or when marked dirty) the lights with intensity > 0 are
packed into one storage buffer. No clustering: lamps (point lights) are drawn
as screen boxes into the lit picture at relight; headlights (spot lights) as
screen boxes in the composite (as `stillBeams` does today); forward meshes loop
over the buffer with a range test (cars are small; water may need a cap).

## What the client loses under ?renderer=new

`still.ts`'s own drawing (its shaders and tasks), the geometry task, the
private reads, `setShadowStaticOnly`/`getCsmStaticTexture` (stubbed), MSAA.

## How it is judged

1. Looks: `bun run shots` and `look` with and without `&renderer=new`, side by
   side; the same within the noise of a still frame.
2. Speed: the RunPod bench (`bench.yml`, `where` with `&renderer=new`) for JS ms
   per frame and per redraw, draws, pipelines, GPU ms; Chrome CPU-throttled runs
   for phone-like JS; the Pixel 8 power run for the final word.
3. Pipelines created: count after the first minute (target: under 40, then 0
   new).

## Appendix: the seam between the shader composer and the engine

Two files own the split; everything else in `client/src/render/` uses them.

`client/src/render/compose.ts` (the composer; pure, no GPU calls):

```ts
export type Pass = "gbuffer" | "shadow" | "forward";
export interface VertexLayout {        // what the mesh has, decides attributes
  uv: boolean; colors: boolean;        // positions + normals always
  instances: boolean;                  // thin instances: mat4 at 4 vec4 locations
  instanceColors: boolean;
  pluginBuffers: { buffer: string; perInstance: boolean; attributes: { name: string; type: string }[] }[];
}
export interface Composed {
  key: string;                         // cache key: pass + plugin code + layout + flags
  code: string;                        // one WGSL module, entry points vs / fs
  vertexBuffers: GPUVertexBufferLayout[];  // order: position, normal, [uv], [color], [instance mat4 (+color)], plugin buffers in order of first use
  bufferOrder: string[];               // names matching vertexBuffers: "position","normal","uv","color","instances","instanceColors", plugin buffer names
  materialUbo: { size: number; offsets: Map<string, number> };  // bytes; roughnessFactor, metallicFactor, reflectance, materialAlpha, then plugin ubo fields (std140-ish WGSL uniform layout)
  materialTextures: { texture: string; sampler: string; kind: "float" | "depth" | "unfilterable-float"; samplerType: "filtering" | "non-filtering" | "comparison" }[];  // group 1 bindings 1.. in this order: tex, sampler, tex, sampler…
  doubleSided: boolean;
}
export function compose(material: OwnPbrMaterial, pass: Pass, layout: VertexLayout): Composed;
export const SCENE_WGSL: string;       // group 0 binding 0 struct Scene { … } read as scene.*; see below
```

Bind groups every composed shader declares:
- group 0: `@binding(0) var<uniform> scene: Scene;` with at least
  `viewProjection: mat4x4f, view: mat4x4f, vEyePosition: vec4f, vImageInfos: vec4f`
  (exposure, contrast, 0, 1), `sunDir: vec4f` (towards the light, xyz), `sunColor: vec4f`
  (linear rgb * intensity), `sh: array<vec4f, 9>` (irradiance SH as Lite computes it),
  `time: vec4f`, `screen: vec4f`. Pass-specific extras go after these.
- group 1: `@binding(0) var<uniform> material: Material;` then plugin textures/samplers.
- group 2: `@binding(0) var<uniform> mesh: Mesh;` with `world: mat4x4f`.
- group 3 (forward only): shadow maps (`shadowStatic`, `shadowLive`:
  `texture_depth_2d_array`, `sampler_comparison`), `shadowMatrix` in scene,
  light list `var<storage, read> lights: array<Light>` + count, sky cube
  `texture_cube<f32>` + sampler.

G-buffer fragment outputs: `@location(0) albedo`, `@location(1) normal`,
`@location(2) extra` as in the frame table. Shadow fragment: no colour output
(depth only; it may `discard`). Forward: `@location(0)` colour, tone mapped.

`client/src/render/engine.ts` and friends (the engine) implement the Lite-shaped
API from the contract, build pipelines from `Composed`, and run the frame.
