# A renderer of our own: ideas, grounded

What could make Sprawl cheap on a phone, if we drew it ourselves instead
of through Lite. Research notes for deciding what to build and measure;
nothing here is built yet. The game's renderer today is `client/src/engine/still.ts`
(the still picture), `Canvas.tsx` (the loop), `lights.ts`, `InstancePool.tsx`,
`objects/motion.ts` (where a vehicle stands).

## The situation, in numbers

- **Camera:** 20° vertical FOV, 25° tilt (`Camera.tsx`). It is near
  orthographic: across the view, depth changes by a small fraction of the
  distance, so 2D reprojection is almost exact.
- **Phone canvas:** `DEVICE_RATIO` 1.3 on phones. A Pixel 8 viewport of
  412×915 CSS px → about 536×1190 = **0.64 MP**. The picture is 1.24²
  = 1.54× that, about **0.98 MP**.
- **Picture targets** (`still.ts:347–370`): colour in `surface.format`
  (bgra8, already tone-mapped and gamma-encoded), `depth24plus`, plus
  albedo, `rgba8unorm` normal and reflectivity. That is about 20 B/px,
  or about **20 MB written per redraw** before overdraw.
- **Per frame:** one fullscreen quad. It reads colour and depth through
  `find()` (3 dependent depth taps), writes colour and `frag_depth`, then
  draws beam boxes and the live meshes. That is about 8–12 B/px read and
  8 B/px written, about **10 MB a frame** (200 MB/s at 20 fps, 600 MB/s at
  60). LPDDR5-class DRAM costs tens of pJ/byte (an order of magnitude, not
  a measurement), so this is **tens of mW at most**. Bandwidth is not
  what heats the phone; the CPU is.
- **Redraws:** `EVERY_MS = 500`, so the whole still scene is re-encoded
  and re-rasterised **twice a second just for the sun**. A sun that turns
  360° in 20 min moves 0.15°/s, 0.075° per redraw. A 10 m wall's shadow
  tip moves about 2.6 cm/s. That is sub-pixel for many seconds at any
  zoom we allow.
- **Frame rates:** `STILL_FPS` is 20 on phones and `MOVING_FPS` 60.
  Every rest frame still runs `before.run()`, `cull.update()`, uniform
  `Array.from(vp)` ×3 (allocations), `pack()` for headlights, light
  pouring and Lite's scene walk.
- **Already instrumented:** the counters `still.redrawCpuMs`,
  `frame.renderCpuMs`, `still.slowAfterRedraw`, and `?bench&power`
  (Pixel energy by rail through Perfetto, commit 272d410/4461be1). Every
  experiment below should report through these.

Rule of thumb from the industry:
[30 fps vs 60 fps is about 1.6 W vs 2.8 W system power in mobile games](https://dev.to/gameoptim/mobile-game-power-optimization-why-30-fps-vs-60-fps-can-double-energy-usage-real-data-breakdown-110n).
That article budgets CPU at about 1 W (3 cores) against about 0.4 W GPU and
≤0.5 W bandwidth. Work per frame times frames per second is the bill; the
CPU share is the largest.

---

## 1. Cached and deferred designs

### 1a. Deferred lighting over the cached G-buffer (relight, don't re-rasterise)
- **What:** split the picture into *what is there* (albedo, normal, shine,
  depth, AO, emissive or material id), drawn only on view or content change,
  and *how it is lit* (sun, sky, shadow), applied from the G-buffer in a
  fullscreen pass.
- **Why it fits:** we already write the G-buffer (`GeometryTextureType.ALBEDO`,
  `WORLD_NORMAL`, `REFLECTIVITY`) and `lightOn()` already lights from it for
  headlights and car shadows. The sun is the only reason for `EVERY_MS`.
  The 35–40 procedural looks all end in albedo, normal and shine, so they
  survive the split, as long as no look bakes lighting into colour (check
  that emissive windows, painted AO and the "sky tint" stay G-buffer terms).
- **Two variants:**
  1. *Relight into the picture:* on a sun tick (every 2–5 s), one
     fullscreen pass G-buffer → picture colour. It costs no draw calls,
     one pass, about 1 MP. The per-frame composite stays as it is.
  2. *Light every frame in the composite:* the composite pass does sun,
     shadow, sky and headlights per pixel from the G-buffer. The `unshown()`
     14-step bisection hack goes away, and car shadows and headlights become
     exact, because nothing is undone through the tone curve. GPU cost goes
     up a bit: about 4 G-buffer reads per pixel plus a shadow tap, roughly
     0.5–1 ms on a G715 at 0.64 MP (an estimate).
- **Expected win:** about 2 full scene encodes a second removed at rest.
  If `still.redrawCpuMs` is ~10–30 ms on a Pixel, that is **2–6% of a core
  continuously**, and it removes the periodic hitch (`still.slowAfterRedraw`).
- **Risk:** shading that depends on the view vector (specular) shifts slightly
  during reprojection; that is acceptable, and variant 2 fixes it anyway.
  The static shadow map still has to follow the sun (§4).
- **Measure:** `still.redraws` by reason (`still.sun` → 0), `?bench&power`
  "as played at rest" rail energy before and after.
- **Sources:**
  [Arm, deferred shading on mobile](https://developer.arm.com/community/arm-community-blogs/b/mobile-graphics-and-gaming-blog/posts/deferred-shading-on-mobile)
  (the bandwidth accounting is in BU, with 128 bits/px of tile storage).

### 1b. Visibility buffer
- **What:** pass 1 writes `(instanceId, triId)` in RG32Uint and depth;
  pass 2 refetches the triangle, rebuilds its attributes and runs the
  material.
- **Why not here:** its win is shading each pixel once under heavy overdraw
  and many small triangles. We rasterise the town a few times a minute, so
  overdraw is already paid only on redraw. Our materials are 35–40
  *procedural* WGSL looks, and a vis-buffer resolve would need either one
  über-shader with divergent branches (bad on Mali, whose warps are 16 wide)
  or a material-classified tile pass in compute. WGSL has no portable
  `primitive_index`: [the cinevva spike](https://app.cinevva.com/blog/2026-05-06-open-world-browser-part-21-visibility-buffer)
  had to un-index geometry (3× vertices) to carry it flat. It was only ~25%
  faster than forward at 50k instances on an M-series Mac, and *slower*
  at 200k because of random instance-buffer reads.
- **Verdict:** skip. The G-buffer is the right decoupling for a picture
  drawn rarely.

### 1c. The picture in linear HDR, tone-mapped once
- **What:** keep the still colour in `rgba16float` (8 B/px) or
  `rg11b10ufloat` (4 B/px, renderable with the `rg11b10ufloat-renderable`
  feature), *linear*, and apply exposure, the tone curve and gamma once, in
  the composite. Today the picture is tone-mapped and gamma-encoded, and
  `still.ts` undoes the curve with a fitted polynomial and bisection
  (`unshownOne`) to subtract car shadows and add headlights.
- **Fit:** `rg11b10ufloat-renderable` is
  [99.8% on Android](https://web3dsurvey.com/webgpu/features/rg11b10ufloat-renderable/platform/Android)
  (only Adreno 5xx lacks it) and [100% of iOS reports](https://web3dsurvey.com/webgpu/features/rg11b10ufloat-renderable/platform/iOS).
  It is the same 32 bpp as bgra8, so bandwidth does not change; it has no
  alpha (we don't need one).
- **Win:** correctness (no tint from going back through the curve channel
  by channel, as the comment admits), and it deletes `poly`, `unshownOne`
  and `unshown`. Exposure changes over the day become free, with no redraw.
  CPU: none. GPU: small saving where shadows are lost; tone mapping per
  pixel per frame costs about 20 ALU, trivially.
- **Risk:** 11/11/10-bit floats band in dark night gradients; that may need
  dither in the composite. Fallback: `rgba16float` at 2× the bytes.
- **Measure:** a `look` before and after for the night and dusk fixtures;
  `cost` on the composite.

### 1d. Reprojection while panning vs a world-anchored tiled picture
- **Today:** the picture is drawn 12% past each edge from a perspective eye,
  slid each frame (`find()` marches 3 times through the depth), and redrawn
  when the view nears the edge (`EDGE` 0.95) or zooms past `ZOOMED` 1.25, at
  most every 50 ms. A fast pan therefore re-encodes the whole scene up to
  20×/s, which is the most expensive thing we do.
- **Alternative: an orthographic, world-anchored clipmap.** Render the still
  layer with an *oblique orthographic* projection along the camera's fixed
  direction (tilt 25°, constant yaw). Panning becomes a pure 2D shift for
  every height, so the picture can be a **toroidal ring buffer**
  (`(world.xy mod size)` addressing): a pan of N pixels redraws only an
  N-pixel strip, with scissor and its own view-projection, culled to that
  strip's world rectangle. The composite turns ortho into perspective
  through depth, as `find()` already does. With a 20° lens the
  perspective-vs-ortho difference is only a few pixels at the screen edge
  for a tall building.
  - Zoom: keep 2–3 levels (a clipmap) at 2× steps and blend, or redraw on
    zoom stop. Zoom is rarer than pan.
  - Precedent: clipmapped terrain and virtual textures, and
    [Insomniac's CSM scrolling](https://advances.realtimerendering.com/s2012/insomniac/Acton-CSM_Scrolling(Siggraph2012).pdf),
    the same idea applied to shadow maps.
- **Expected win:** pan redraw cost falls from "whole scene" to "strip"
  (for a 10 px/frame pan, about 1% of the area, with the draw count cut by
  culling). Pans keep 60 fps on phones with no `slowAfterRedraw`.
- **Risk:** medium-high. It needs our own culling by world rectangle and
  draws that can be scissored. Specular and parallax are those of an ortho
  eye, so the near/far feel changes a little at the screen edges. The
  shadow map must also be world-anchored (it already is, more or less).
- **Measure:** `still.moved` count and `still.redrawCpuMs` during the bench's
  "panning" phase; jank (frame time p95) during a fling.

### 1e. Depth-based reprojection errors at building edges
- **The errors:** (a) *disocclusion*: a wall or ground the old eye could not
  see; (b) *foreground fattening*: depth discontinuities sampled nearest
  give halos; (c) thin things (lamp posts, fences) lose pixels.
- **Hiding them, cheapest first:**
  1. Keep the margin and redraw on stop, as we do. Errors only live during
     motion, when the eye forgives them.
  2. In `find()`, when the 3 iterations don't converge (|h_k − h_{k−1}| >
     ε), take the *farther* sample. The background fills holes rather than
     stretching the roof.
  3. Dilate the depth by one texel toward max (a "min-max depth" mip) and
     test against both, so the cut falls on the silhouette.
  4. Because the camera is near ortho with a fixed yaw, the error is
     one-sided (always on the side the pan moves away from). A
     one-directional search of 2–4 texels for the background depth is
     enough.
  5. A clipmap (1d) removes most of it, since ortho has no parallax
     during pans.
- **Measure:** `bun run look --frames 8 --every 50` during a scripted pan, a
  diff against a fresh redraw at the same view; count pixels with ΔE > 10.

---

## 2. Mobile GPU realities (Mali Immortalis-G715 in the Pixel 8, Apple A17 Pro)

- **Tile-based:** both GPUs bin geometry, then shade tile by tile in on-chip
  memory. DRAM traffic comes only from *loads* at pass start and *stores*
  at pass end. Arm's accounting:
  [a classic G-buffer costs ~10 BU against ~1 BU if fused in one pass](https://developer.arm.com/community/arm-community-blogs/b/mobile-graphics-and-gaming-blog/posts/deferred-shading-on-mobile),
  and on-chip storage is 128 bits/px for local storage (Mali). WebGPU has no
  subpasses, framebuffer fetch or pixel local storage, so **we cannot fuse
  G-buffer and lighting**. That is fine for us: we pay the 10 BU only per
  redraw, not per frame.
- **Load/store ops:** in WebGPU, `loadOp: "clear"` costs nothing on a TBDR
  and `"load"` reads the whole target. `storeOp: "discard"` skips the write.
  [Apple: DontCare/Clear cost nothing, Load and Store cost bandwidth](https://developer.apple.com/library/archive/documentation/3DDrawing/Conceptual/MTLBestPracticesGuide/LoadandStoreActions.html).
  Per frame for us:
  - the main pass: colour `clear` (the quad covers it), depth `clear`, and
    depth `storeOp: "discard"` *unless something later reads it* (the
    outline mask? check `outline.ts`). Audit what Lite sets; it commonly
    stores depth.
  - the picture redraw: the G-buffer must be stored (we read it later),
    and its depth must be stored (`find()` reads it).
- **Memoryless/transient:** WebGPU 1.0 has none. Chrome has an
  [Intent to Ship for `GPUTextureUsage.TRANSIENT_ATTACHMENT`](https://groups.google.com/a/chromium.org/g/blink-dev/c/nejekzLzk74)
  (dev trial from M146, all six Blink platforms incl. Android; WebKit
  "closed without a position", though Apple approved the spec PR).
  Until then: use `storeOp: "discard"` on MSAA colour, the depth of the live
  pass and any scratch. Drivers then skip the write, though the allocation
  stays. Feature-detect `"TRANSIENT_ATTACHMENT" in GPUTextureUsage` and use
  it for the main pass depth.
- **Depth formats:** `depth24plus` is D24 or D32F behind the scenes;
  `depth16unorm` halves the bytes and is plenty for a 20° lens at our depth
  range (when the near plane is pushed out). With
  [reverse-Z](https://developer.nvidia.com/content/depth-precision-visualized)
  and `depth32float`, precision is best; on TBDR the depth that stays on chip
  is free, so prefer precision for the *picture* depth (it is stored and
  sampled by `find()`) and `depth16unorm` or transient for the per-frame
  pass.
- **frag_depth:** writing `@builtin(frag_depth)` turns off early-Z/HSR for
  that draw. Our composite quad is drawn first, so that costs nothing.
  Never let a *live* mesh or a dome crown in the per-frame pass write
  frag_depth; in the cached redraw it is fine.
- **MSAA:** 4× on TBDR resolves in tile and is nearly free in bandwidth
  *if* the multisampled attachment is discarded. It still costs fragment
  work on edges and memory for the attachment. Today phones (DPR ≥ 2) get 1×
  (`Canvas.tsx:151`). For the still picture, consider 4× on the redraw only
  (rare) and none per frame. Live vehicles are small, and an analytic edge
  AA in their shader (from the vehicle's box SDF) is cheaper.
- **What makes phones hot:** in order, (1) CPU cores kept awake: the
  JS main thread, the GPU process's command decoding (Dawn in Chrome, the
  WebKit GPU process in Safari), the compositor; (2) frame rate itself
  (every vsync wakes CPU, GPU and compositor and costs a present); (3) DRAM
  traffic; (4) GPU ALU. The Tensor G3 is on Samsung 4LPP and is
  [weak but about as efficient per frame as rivals](https://m.gsmarena.com/google_pixel_8s_tensor_g3_gpu_tests_show_weak_performance_but_decent_efficiency-news-60199.php),
  and it [throttles hard under sustained load](https://www.notebookcheck.net/First-Pixel-8-and-Pixel-8-Pro-3D-Mark-stress-test-results-surface-paint-a-potentially-ugly-picture-for-Tensor-G3.757268.0.html).
  We want to stay well below the throttling knee, not to run fast and then
  slow down.
- **Frame pacing:**
  - rAF fires at the display rate (Pixel 8 120 Hz LTPO, iPhone 15 Pro
    ProMotion 120 Hz, both with dynamic refresh). **Returning from rAF
    without submitting a frame lets the display drop its rate**, and Chrome
    has an experiment that
    [halves rAF after 4 frames with no pixel change](https://groups.google.com/a/chromium.org/g/blink-dev/c/xodJxrzjv30).
    Code must not assume rAF deltas are steady (`judge()` already filters).
  - [iOS Low Power Mode caps rAF at 30 fps](https://motion.dev/magazine/when-browsers-throttle-requestanimationframe).
  - Today `Canvas.tsx` skips rAF ticks by time (`1000/fps * 0.75`). A
    20 fps target on a 120 Hz display gives an uneven 6/6/6 vsync pattern;
    choose fps values that divide 120 and 60 (20, 30, 60, or 15). 20 is
    fine on 60 and 120 Hz, but jittery on 90 Hz panels, which other
    Android phones have.
  - **No present when nothing changed** costs zero GPU, zero compositor
    and only rAF wakeups. The best frame is the one not drawn (§8).
- **Measure:** `?bench&power` rails (CPU big/mid/little, GPU, DRAM) are the
  ground truth. On RunPod, measure *CPU ms per frame* and *draw counts*,
  which travel across hardware, with Chrome's
  `Emulation.setCPUThrottlingRate` (4–6×) as a stand-in for a phone. GPU ms
  on an RTX card says nothing about TBDR bandwidth.

---

## 3. WebGPU CPU overhead, minimised

Ordered by what matters for us. Per-frame cost in WebGPU is JS work, plus
the IPC to the GPU process, plus Dawn/WebKit validation and encoding.

1. **Render bundles for everything that repeats.** [Toji: bundles move
   validation and encoding to creation time; vary data through buffers
   between executions; use indirect draws to keep dynamic counts inside a
   bundle](https://toji.dev/webgpu-best-practices/render-bundles). (A copy
   is at [this proxy](https://https-toji_dev.proxy.bugsmash.io/webgpu-best-practices/render-bundles).)
   For us:
   - **the still redraw:** a bundle per chunk (or per material), rebuilt
     only when that chunk's contents change. A redraw is then
     `executeBundles([...])` plus a uniform write. That turns
     `still.redrawCpuMs` from "walk the scene" into microseconds of JS.
   - **the live layer:** one bundle: composite quad, beams, every vehicle
     kind as one instanced draw each, water, fans. Instance counts live in
     an indirect buffer the CPU (or compute) writes.
   - Limits: no viewport/scissor/stencil-ref changes inside a bundle, no
     nested bundles, state resets around them.
   - Precedent: [toji/webgpu-bundle-culling](https://relatedrepos.com/gh/toji/webgpu-bundle-culling).
2. **Few pipelines, one layout.** Bind groups by frequency: `@group(0)`
   per frame (view, sun, time), `@group(1)` per material kind (rarely
   changes), `@group(2)` per draw → replace with **storage buffers indexed
   by `instance_index`**, so most draws need no per-draw bind group at
   all. 35–40 looks means 35–40 pipelines for the G-buffer pass, plus about
   5 for the live layer. Sort by pipeline once, when the bundle is built.
3. **One big vertex/index buffer** (a mega-buffer with sub-allocation),
   draws addressed by `firstIndex`/`baseVertex`/`firstInstance`. Fewer
   `setVertexBuffer` calls; it makes merged chunks and indirect draws
   trivial. (`firstInstance` in indirect draws needs `indirect-first-instance`;
   check `adapter.features`. Otherwise put the base in a storage buffer.)
4. **drawIndirect / multi-draw:** `drawIndexedIndirect` is core and works
   everywhere. **Multi-draw-indirect is not shippable:** in Chrome it was
   still behind "Unsafe WebGPU" in [Nov 2025](https://groups.google.com/g/webgl-dev-list/c/7Y1oZGaLYTw)
   (`chromium-experimental-multi-draw-indirect`), and Safari has none.
   Design for N indirect draws inside a bundle, which gets most of the
   win.
5. **Dynamic uniform offsets** (`hasDynamicOffset`) for anything per draw
   that is not in a storage buffer: one buffer, one bind group, offsets in
   `setBindGroup(…, [offset])`. Mind the 256-byte alignment
   (`minUniformBufferOffsetAlignment`).
   **Immediates** (push constants, `var<immediate>`, `setImmediateData`)
   have a [Chrome Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/8LdEcW1CkNo),
   with WebKit and Gecko positive. Feature-detect and use them for a
   per-draw index once available.
6. **No per-frame allocation.** `still.ts` builds `Array.from(vp)` three
   times a frame and `[w, h]` arrays; Lite's `setShaderUniform` likely
   copies. Keep one `Float32Array` per frame block, write it in place, one
   `queue.writeBuffer` per frame. The GC on phones is a real source of
   jank and CPU time.
7. **writeBuffer vs mapped staging:** `writeBuffer` is the fast path in
   both Chrome and Safari (the browser does its own staging). `mapAsync`
   rings help only for multi-MB uploads; ours are KBs (vehicle routes
   change rarely, §7). Chrome is prototyping
   [`mapSync()` in workers](https://developer.chrome.com/blog/new-in-webgpu-145?hl=en).
8. **One command buffer per frame, one submit.** WebKit engineers recommend
   it: [Safari doesn't coalesce command buffers, and several in flight have
   stalled iOS](https://bugs.webkit.org/show_bug.cgi?id=311598). Fold the
   shadow pass, the redraw and the frame into one encoder.
9. **Pipeline creation:** Metal compiles at `createRenderPipeline`, which
   can take tens of ms per pipeline on an iPhone on first sight. Use
   `createRenderPipelineAsync` for all ~45 at load (or behind the loading
   screen), cache by `(WGSL hash, layout, format)`, and create each
   `GPUShaderModule` once. Never create a pipeline on first draw in play.
   The only reliable mitigation is to never miss the cache in play.
10. **Avoid the scene graph.** Thin instances already skip it
    (`InstancePool.tsx`). Our own renderer would hold flat arrays: what to
    draw is a list of bundles and an instance buffer, nothing walked per
    frame.
- **Expected win:** per-frame JS for rendering from several ms (Lite's
  walk + uniforms + lights) to **< 0.3 ms**; a redraw from tens of ms to
  < 1 ms of JS (the GPU still does the work).
- **Risk:** this is the "own renderer" itself. Lite's clustered lights,
  CSM and frame graph go with it; we keep only what we use.
- **Measure:** `frame.renderCpuMs`, `still.redrawCpuMs`; in Chrome
  `chrome://tracing` with the `gpu` category for the GPU process's share
  (Dawn's decode is CPU too).
- **Others' numbers:** a three.js user measured
  [WebGPURenderer 2× slower on CPU than WebGLRenderer on scenes with many meshes](https://discourse.threejs.org/t/webgpurenderer-2x-slower-cpu-and-5-10x-slower-first-frame-than-webglrenderer-on-many-mesh-scenes-r183-same-on-both-backends/91904).
  A general engine's per-object overhead is the problem, not WebGPU.

---

## 4. Shadows for a still scene under a slow sun

- **Today:** Lite's CSM with a static layer (`setShadowStaticOnly`) and a
  "now" layer; `sunLost()` compares them with 4 taps per pixel per frame.
- **A. Cached static map, refreshed every N s, two maps cross-faded.**
  Render the static casters into map B while A is shown, over a few frames
  if needed (time-sliced, as
  [Cyberpunk does for distant shadows, refreshed every few seconds](https://history.siggraph.org/wp-content/uploads/2022/06/2021-Talks-Dybisz_Shadows-Optimizations-in-Cyberpunk-2077.pdf)),
  then blend `mix(shadowA, shadowB, t)` over 1–2 s in the relight
  (§1a). With 2.6 cm/s of edge movement, N = 10–20 s with a 2 s fade is
  invisible. Static shadow cost goes from "every redraw" to once per 15 s,
  amortised to almost nothing.
  The map should be **world-anchored and texel-snapped** (so a pan does
  not shimmer), covering the whole town at a fixed texel/m: the town is
  small and the view near top-down, so one 2048² or 4096² map at
  ~10–20 cm/texel covers it. No cascades are needed with a 20° lens:
  depth range is tiny.
  [Sundial](https://discourse.threejs.org/t/sundial-paged-virtual-sun-shadows-for-three-js-webgpurenderer-mit-on-npm/94912.md)
  (virtual paged sun shadows for three.js WebGPU) shows the cache and
  re-draw-only-moving-casters pattern: moving 40 casters cost 0.05 ms vs
  0.37 ms to redraw all.
- **B. Cars' shadows without a shadow map.** A vehicle is a box. From
  above, its shadow is the box's footprint swept along the sun direction:
  an oriented quad (a "blob" with a soft SDF edge) on the ground, drawn in
  the live layer, multiplying the composite. No shadow pass, no `sunLost()`
  per pixel, no second depth map. It looks the same top-down; it only
  fails on a car beside a wall (its shadow should climb the wall). That is
  rare and small.
  - Middle ground: a small (512²) dynamic map *only round live
    vehicles*, rendered at the live rate.
- **C. Heightmap/horizon shadows:** the town is a height field from above
  (buildings are extruded footprints, trees are domes). A per-texel horizon
  angle in 8 or 16 directions, baked on content change, gives the sun
  shadow by one lookup and interpolation for any sun angle. That makes
  sun movement free forever. Risk: overhangs (awnings, bridges) are lost,
  and it needs a height bake (we have one, `bakeWorker.ts`). Worth an
  experiment for the *ground* only, with the shadow map kept for walls.
- **D. Screen-space contact shadows** (a short ray-march in depth toward
  the sun), [Bend Studio's version is public](https://www.bendstudio.com/blog/inside-bend-screen-space-shadows/).
  Done once per redraw on the cached depth, it adds small-scale contact
  (kerbs, fences, props) that the map misses. It goes in the relight pass,
  free per frame.
- **What looks good top-down:** crisp, slightly soft long shadows at
  morning and evening; little detail at noon. A fixed PCF kernel
  (4–9 taps) in the relight, which runs every few seconds, can afford
  16–32 taps or PCSS for free.
- **Measure:** `cost` with shadows off/on; `still.sun` count; a `look` strip
  over 60 game-seconds at dusk for popping.

---

## 5. Many small lights

- **Today:** Lite's clustered lights (`lights.ts`: 192 slots, 128 beams,
  tiles of 32-light masks), poured every frame from the CPU, plus our own
  beam boxes in the composite (`BEAM_VERTEX`).
- **Street lamps are still → bake them into the picture's lighting.** In
  the relight (§1a) or the redraw, accumulate every lamp in view into the
  linear picture (as light volumes: a disk or sphere per lamp, additive,
  depth-tested against the picture's depth, reading the G-buffer). They
  then cost nothing per frame and no CPU pouring.
  Lamps come on at dusk: that is one more relight, with a fade.
- **Headlights move:** keep them as screen-space cone volumes drawn over
  the composite (what `still.ts` does), but **feed them from the GPU vehicle
  buffer** (§7): the vertex shader of the beam reads the vehicle's pose from
  the same route evaluation and needs no CPU `pack()`. With ≤ 300 vehicles,
  each a box of ~20–60 px on screen, additive volumes are cheaper than any
  tiled culling. Tiled/clustered culling in compute pays off at
  thousands of lights or big overlaps, not here.
- **Win:** removes per-frame light upload and the clustered pass from every
  material; per-frame CPU for lights → 0.
- **Risk:** live meshes (cars) won't be lit by lamps unless the live
  shader reads a cheap "lamp light" term: sample the baked lamp
  irradiance at the car's ground position (store it in a channel of the
  picture or a low-res lamp-light texture). Plenty for 5 m cars.
- **Measure:** night phase of `?bench&power`; `cost --t 0.95`.

---

## 6. Ambient occlusion, once per redraw

- **What:** GTAO ([Jimenez et al.](https://www.activision.com/cdn/research/Practical_Real_Time_Strategies_for_Accurate_Indirect_Occlusion_NEW%20VERSION_COLOR.pdf);
  [XeGTAO](https://github.com/GameTechDev/XeGTAO), MIT: prefilter depth
  mips → main → denoise; High is 18 spp at ~0.56 ms 1080p on an RTX 2060
  and ~2.4 ms on an Intel iGPU; bent normals +25%). Computed on the cached
  depth and normals when the picture is redrawn, stored in a G-buffer
  channel (the reflectivity alpha or a new R8), applied to sky/ambient in
  the relight. **Per frame: zero.** On a phone, 3–10 ms once per redraw at
  1 MP, or half that at half resolution, is affordable when redraws are
  rare (but not 20×/s during a pan: drop AO during motion, recompute on
  stop, or do strips with the clipmap).
- **Why the heightmap bake failed, and how to avoid it here:** the crowns
  are flat cards with a painted dome and the rock edges are painted in the
  shader. A geometric AO sees flat cards (no occlusion under them, a hard
  ring round them) and smooth rock (no crevices). Screen-space AO sees
  *whatever the depth buffer says*, so:
  - **Tree crowns:** in the redraw, the crown shader writes
    `@builtin(frag_depth)` = the dome's depth (card depth − h·sqrt(1 −
    r²) in view space, h the crown's height), and its normal = the dome's
    normal into the G-buffer. GTAO then sees a dome: soft occlusion at the
    foot of the crown onto the ground, none on top. frag_depth costs early-Z
    only in the redraw; fine. Also write the dome into the **shadow map**
    the same way, and crown shadows round off for free.
  - **Painted rock edges:** have the rock shader also output a *bumped*
    depth offset and normal from the same noise it paints with (it already
    computes the normal to shade). GTAO then darkens the cracks it paints.
    If depth offsets are too noisy, let the material write an AO term of
    its own (a "cavity" channel), multiplied with GTAO, which is what
    authored materials do with an AO map.
  - **Scale:** for a stylised town, the radius should be ~1–3 m world
    (doorsteps, kerbs, under eaves, foot of walls and trees), with a
    falloff, and strength ≤ 0.6 so the pastel stays clean.
- **Alternative (no screen space):** a world-space AO from the height
  field at the town's tile grid, multiplied with the screen-space term for
  large-scale darkening between tall buildings. Optional.
- **Precedents in WebGPU:** [luma.gl's GTAO pass](https://luma.gl/docs/api-reference/shadertools/shader-passes/gtao),
  three.js `GTAONode`.
- **Measure:** a `look` sheet of every fixture with AO off/on; GPU ms of the
  redraw in `cost`; Wytze's eye.

---

## 7. GPU-driven vehicles

- **What:** the server already tells the client *the route and the
  schedule* (a trip: parts, `Manoeuvre` Béziers, distance vs time,
  `driver.ts`), and `motion.ts` evaluates it on the CPU each frame for
  every vehicle, then composes matrices and uploads them
  (`composeMat4IntoBuffer`). Move that evaluation to WGSL:
  - **Route buffer** (storage, append-only, compacted occasionally): each
    route as polylines or cubic Bézier parts with an arc-length table
    (8–16 samples a part), lane offset and a gear/direction flag.
  - **Vehicle record** (~32–48 B): route offset, part count, `t0`, a speed
    profile (piecewise: accelerate, cruise, brake, as the server's sim
    plans it, or the server's distance-vs-time knots), rig (`reach`), kind,
    colour.
  - **Vertex shader** (or a compute pass writing poses once a frame to
    serve the car, its shadow, its beams and picking): find the part by
    distance (binary search on a few knots), evaluate position, and point
    along the chord between the points `reach` behind and ahead (exactly
    the rig `driver.ts` uses).
  - The CPU writes a record **only when a trip changes** (start, re-route,
    a stop the server announces): a few per second in a town of hundreds.
- **Fit:** the motion model is deterministic and already "pinned to the
  route" (`driver.ts`: "nothing is steered"), so it is pure: (route,
  time) → pose. The ferry, forklifts and goods on decks follow the same
  pattern (pose = f(schedule, t)).
- **Win:** per-frame CPU for vehicles from O(vehicles) JS (pose eval,
  matrix compose, buffer write: probably 1–3 ms on a phone with 300 cars,
  measure it) to **~0**. This is likely the largest per-frame JS item once
  the renderer is ours.
- **Risk:** two copies of the motion math (TS for the flat view `flat/`,
  picking and tests; WGSL for drawing). Keep the TS as the oracle and test
  WGSL against it on the CPU (evaluate the same records through
  `motion.test.ts` data and compare to a readback). The server's
  speed changes mid-trip need a record update (fine, that is the "only
  on change"). f32 time precision: send `t − t_epoch` with a frequently
  rebased epoch.
- **Precedents:** GPU crowd rendering in
  [GPU Gems 3 ch. 2 (instanced crowds)](https://developer.nvidia.com/gpugems/GPUGems3/gpugems3_ch02.html),
  [luma.gl GPU-animated crowds](https://luma.gl/docs/api-reference/gltf/gltf-crowd-usage),
  and deck.gl's TripsLayer (vehicle trails from timestamped paths in the
  vertex shader, a widely used traffic-viz pattern). Cities: Skylines-style
  games simulate on the CPU and only *draw* instanced, which is the part
  we keep on the server.
- **Measure:** `frame.renderCpuMs` plus a new `motion.cpuMs` counter;
  `bun run jolt` on the WGSL path vs the TS path (they must agree).

---

## 8. Near-zero cost at rest

1. **Don't present when nothing visible changed.** Decide per rAF: did the
   view, the picture, any live thing on screen, water or a fan change since
   the last presented frame? If not, return before `getCurrentTexture()`.
   Then there is no GPU work, no present and no compositor frame; the
   display may drop its refresh rate. Something nearly always moves, so
   combine it with:
2. **Per-layer rates.** Vehicles at 20–30 fps; water at 10 fps (its waves are
   slow; [WebKit: don't touch the canvas when content isn't changing](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/));
   fans at 10–15 fps; at full zoom-out, cars at 15 fps. Frame rate =
   max(rates of things *on screen*). A town in the night with no cars in
   view runs at 10 fps or 0.
3. **Deferred water.** Water is a flat plane. Instead of a live mesh, mark
   water pixels in the G-buffer (a material id) and shade them in the
   composite from the `waves` texture and time. That removes a mesh and its
   draw; it needs no per-frame CPU; water then costs only the pixels showing
   it. The shore foam etc. stays in the picture.
4. **Dirty regions via scissor.** When only a few cars move on a mostly
   still screen at rest, redraw the composite + live layer *only in
   rectangles round them* (scissored, with the swap chain preserved). But
   WebGPU canvases don't promise their old contents (`getCurrentTexture`
   is a fresh texture; there is no `preserveDrawingBuffer`), so this
   needs an offscreen colour target copied or blitted to the canvas each
   frame, and the blit costs about what it saves at 0.64 MP. **Not worth
   it on phones**; the per-layer rate is the better lever.
5. **Lower-resolution live layer:** cars at 0.5× composited cost a second
   target and a blend; at 0.64 MP the composite is already cheap. Instead,
   lower `DEVICE_RATIO` itself when the battery is low
   (`navigator.getBattery` where available, not on iOS) and keep 1.3 when
   fine.
6. **Temporal upsampling:** for us the picture *is* a temporal cache; TAA/FSR
   style upscaling adds a history buffer and per-frame work for little. Skip.
7. **Fewer DOM layers over the canvas:** every DOM element animating over
   the canvas forces the compositor to blend; Solid UI updating text every
   frame (clock, coins) causes style, layout and paint each time. Throttle
   HUD text to 1–4 Hz; keep the canvas `alphaMode: "opaque"`.
8. **Idle the sim's client side.** `work()` runs every frame with a share of
   the clock (`Canvas.tsx`). At rest, batch the server's updates to a few Hz
   when nothing on screen depends on them (they are only the GPU records of
   §7).

---

## Small WebGPU renderers worth stealing from

- **[webgpu/webgpu-samples](https://github.com/webgpu/webgpu-samples):**
  the deferred rendering sample (G-buffer + light pass, no framework),
  render bundles, `drawIndirect`, compute culling. The canonical minimal
  code.
- **Toji (Brandon Jones):** [render bundle best practices](https://toji.dev/webgpu-best-practices/render-bundles),
  `webgpu-bundle-culling` (bundles + compute culling + indirect), and his
  best-practices pages on bind groups and buffer uploads. His bind group
  pattern (frame, material, object) is the one to copy.
- **PlayCanvas engine (WebGPU backend):** a uniform ring buffer with dynamic
  offsets, a shader/pipeline cache keyed by hash; mature on mobile Safari.
- **wgpu / Bevy:** the render graph as a flat list of nodes with explicit
  attachments and load/store per pass; transient attachments in wgpu
  (which Firefox uses).
- **three.js WebGPURenderer:** a cautionary tale for CPU per object
  ([the discourse thread](https://discourse.threejs.org/t/webgpurenderer-2x-slower-cpu-and-5-10x-slower-first-frame-than-webglrenderer-on-many-mesh-scenes-r183-same-on-both-backends/91904));
  also its node-based GTAO and [Sundial](https://discourse.threejs.org/t/sundial-paged-virtual-sun-shadows-for-three-js-webgpurenderer-mit-on-npm/94912.md).
- **luma.gl v9:** a [G-buffer helper](https://luma.gl/next/docs/api-reference/experimental/g-buffer)
  and a [GTAO pass](https://luma.gl/docs/api-reference/shadertools/shader-passes/gtao)
  in plain WebGPU.
- **Pattern to copy for Sprawl:** no frame graph object at all. Write three
  functions, `redrawPicture(region)`, `relight()` and `frame()`, each one
  render pass with hard-coded attachments and ops, all in one encoder and
  one submit. A graph earns its keep at 20 passes; we have 3–4.

## Pitfalls, Safari/iOS 26 and Chrome Android, late 2026

- **Safari:**
  - WebGPU is on by default from iOS/iPadOS/macOS 26
    ([summary](https://app.cinevva.com/news/2025-09-15-safari-webgpu)).
    Test on Safari specifically: the Metal backend behaves differently.
  - [Canvas flicker with instanced vertex buffers](https://bugs.webkit.org/show_bug.cgi?id=301627),
    fixed in 26.4: require ≥ 26.4 or avoid per-instance *vertex* buffers
    (storage buffers instead, which §3 does anyway).
  - [The GPU process leaked an id per command encoder until jetsam](https://bugs.webkit.org/show_bug.cgi?id=303203),
    fixed (Dec 2025), with a TextureView path fixed later. Lesson: few
    encoders, long-lived views; watch memory in long sessions.
  - [Several command buffers in flight stalled on iOS](https://bugs.webkit.org/show_bug.cgi?id=311598):
    one command buffer a frame.
  - [Canvas-to-texture uploads were slow](https://bugs.webkit.org/show_bug.cgi?id=294602),
    fixed Sept 2026: avoid `copyExternalImageToTexture` from 2D canvases
    per frame (the build-menu pictures?).
  - Memory pressure kills the tab with no `device.lost` and
    [Safari can loop reloading](https://bugs.webkit.org/show_bug.cgi?id=300782).
    Keep GPU memory modest: our picture targets, ~20 MB at 1 MP, are fine;
    big shadow maps (4096² depth32 = 64 MB) are not, so use 2048² or
    `depth16unorm`.
  - Pipeline compiles are slow on first use (Metal), so warm them up.
  - Low Power Mode caps rAF at 30.
  - No `requestIdleCallback` (already met: commit 236badf).
- **Chrome Android:**
  - Dawn on Vulkan (Mali, Adreno). Driver differences show in
    `textureSampleCompare` and in `frag_depth` precision.
  - Experimental rAF halving on unchanged frames.
  - Multi-draw-indirect behind a flag.
  - Transient attachments and immediates in rollout (feature-detect both).
  - `timestamp-query` is often unavailable or quantised on Android (Canvas
    already falls back to long tasks).
  - Chrome 122 in Test Lab is old: features present in current Chrome may
    be missing there, so every feature needs a fallback.
  - The 90 Hz panels on other Androids make 20 fps judder; prefer 30 there.

---

## Ranked: the 10 most likely to make Sprawl cheaper on a phone

CPU/GPU wins are rough estimates for a Pixel 8 at rest in a mid-sized town,
to be replaced by measurements. Each has a one-line experiment for
`?bench&power` (rails) and the counters already in `still.ts`/`Canvas.tsx`.

1. **Don't draw or present a frame when nothing on screen changed, and
   give each layer its own rate** (cars 20–30, water and fans 10, nothing
   moving → 0).
   CPU −30–60% at rest; GPU −30–60%.
   *Experiment:* gate `renderFrame` on a "something visible moved" bit
   (camera, picture, live instances in the frustum, water at 10 Hz) and
   compare rail energy in "as played at rest" vs today.
2. **Light the picture from its G-buffer instead of redrawing it for the
   sun** (delete `EVERY_MS`; relight every 2–5 s; re-rasterise only on view
   or content change).
   CPU −2 redraws/s, about −3–6% of a core, and no periodic hitch; GPU
   −1–3% (one fullscreen pass instead of the scene).
   *Experiment:* set `EVERY_MS` to 10 s and compare `still.redrawCpuMs`·s⁻¹
   and rail energy at rest; that is the upper bound before writing the
   relight pass.
3. **Vehicles placed on the GPU from route records**, with the CPU writing
   only on trip change; beams and shadows read the same poses.
   CPU −1–3 ms a frame at 300 vehicles (the largest per-frame JS item);
   GPU ±0.
   *Experiment:* time `motion.ts` + matrix compose + upload per frame
   (`perfSpan`) in a 15-city bench; that is the saving.
4. **Our own thin frame:** render bundles for the redraw (per chunk) and
   the live layer, storage-buffer instances, one preallocated uniform
   block, one encoder, one submit, no scene walk.
   CPU: frame JS from several ms to <0.3 ms, redraw JS from tens of ms
   to <1 ms; GPU ±0.
   *Experiment:* a standalone page drawing the 15-city fixture's still
   meshes from one bundle; compare `frame.renderCpuMs` with Lite on RunPod
   with 6× CPU throttling.
5. **Car shadows as oriented footprint quads, and a world-anchored static
   sun map refreshed every 15 s with a cross-fade** (no per-frame shadow
   pass, no `sunLost()` 8 taps).
   CPU: no shadow pass encoded per frame (about −0.5–1 ms); GPU −10–25%
   per frame.
   *Experiment:* `cost` with the "now" shadow layer off vs on, and a rest
   run with `setShadowStaticOnly(true)` held.
6. **A linear HDR picture (`rg11b10ufloat`), tone-mapped once in the
   composite**: deletes `unshown()`'s bisection and makes the sun, exposure
   and lamps relightable.
   CPU 0; GPU −2–5% (no bisection under car shadows), the same bandwidth.
   *Experiment:* switch the picture format and move `toneMap` into
   `SHOWN`; check `cost` on the composite and a `look` at dusk.
7. **Bake the street lamps into the picture's lighting; headlights only as
   additive cones fed from the GPU vehicle buffer** (drop clustered lights
   from every material).
   CPU −0.3–1 ms a frame at night (no pouring); GPU −5–15% at night.
   *Experiment:* the night phase of `?bench&power` with `SLOTS = 0` (lamps
   off) vs today, as an upper bound.
8. **A world-anchored orthographic clipmap picture with strip redraws
   while panning.**
   CPU: pan redraws from whole scene to strips (−80–95% of redraw JS while
   panning); GPU similar during pans.
   *Experiment:* log `still.moved` redraws and their ms in the bench's pan
   phase; that is the budget this removes.
9. **Deferred water**: a water id in the G-buffer, shaded in the
   composite at 10 Hz; no live water mesh.
   CPU −1 draw and its uniforms; GPU −3–10% where the sea is in view.
   *Experiment:* `cost` hiding the water meshes (their share of a frame)
   with the sea in view.
10. **Warm all ~45 pipelines with `createRenderPipelineAsync` at load,
    cached by WGSL hash; keep `storeOp: "discard"` on per-frame depth and
    MSAA (and `TRANSIENT_ATTACHMENT` where it exists).**
    CPU: no first-use stalls (tens of ms on Safari) and one less allocation;
    GPU −1–3% bandwidth.
    *Experiment:* count pipeline creations after the first minute
    (should be 0) and log Lite's depth `storeOp`; set it to discard and
    compare DRAM rail energy.

**Free quality, not cost:** GTAO once per redraw on the cached depth and
normals, with tree crowns writing their dome through `frag_depth` (and dome
normals) and rock shaders writing the depth and normal they paint, is
affordable once redraws are rare (items 2 and 8). Per frame it costs nothing.
