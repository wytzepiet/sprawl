# Our own renderer: where it stands

Behind `?renderer=new` (docs/renderer-design.md). `client/src/engine/gpu.ts` picks
ours or Lite's per symbol; ours is `client/src/render/`.

## Works

- The 15-city fixture draws with no GPU validation errors, noon and night, and
  matches Lite's photograph to a mean of 0.2–0.5 of 255 per channel
  (`.dev/renderer-look/pair-*.png`, Lite left; `diff-close.png` is the
  difference ×8). Sun, still shadows, sky (SH + cube + Lite's BRDF table),
  lamps, AgX: all Lite's numbers.
- The frame: static shadow map (still casters, Lite's fit, refit past
  `refitAngle`), live map (live casters, every frame), G-buffer of still meshes
  at 1.24× only when the view or they change (still.ts's triggers; the sun
  never), relight into rgba16float on each G-buffer draw and every
  `?relight=` ms (1000), composite (still.ts's `find`, car shadows exact in
  linear, headlights per pixel from the light list, tone map once,
  `frag_depth`) and the live meshes forward in the same pass.
- Draws replay one render bundle per (scene, pass), re-encoded only when its
  list changes (mesh in/out, shown/hidden, buffer or material new, pipeline
  ready). Instance counts go through `drawIndexedIndirect` args, so a car
  pool's count changes re-encode nothing.
- `engine.stats` (and the bench's `own.*`): pipelines, bundles, bundleMs,
  gbuffer, gbufferMs, relights, relightMs, stillShadows, frames, frameMs,
  picture.moved/changed/forced.
- still.ts under `?renderer=new`: `createStill` returns `ownStill`; `stale()`
  marks our picture due; each of our pictures bumps `redraws`.

## Measured (software GPU, 15-city)

60 pipelines after a minute, none new after; at rest about one bundle
re-encode, one G-buffer draw and one still-shadow draw per frame while
parked cars settle (they are still meshes whose instances change);
steady frame: the composite plus the forward bundle (5–12 draws); a picture
frame 240–640 draws.

## Not done / not checked

- The studio (build menu pictures): written (forward, transparent clear) but
  not seen: neither renderer took a picture in four minutes of software GPU.
- The outline: written (mask task + quad), not seen (the town grid's houses
  are not outlined in either renderer when picked).
- Headlights: compile and run, not seen (no cars at night in the fixture).
- No cross-fade between static maps at refit; no MSAA; `setShadowStaticOnly`,
  `getCsmStaticTexture`, `onCsmReceiverUpdate` are stubs.
- Pipelines 60, the design's target is under 40.
- G-buffer albedo is linear rgba8unorm: dark colours could band; storing it
  as sqrt would cost nothing.
