# Our own renderer: where it stands

Behind `?renderer=new` (docs/renderer-design.md). `client/src/engine/gpu.ts` picks
ours or Lite's per symbol; ours is `client/src/render/`.

## Works

- The 15-city fixture draws with no GPU validation errors, noon and night, and
  matches Lite's photograph to a mean of 0.2–0.5 of 255 per channel
  (`.dev/renderer-look/pair-*.png`, Lite left; `diff-close.png` is the
  difference ×8). Sun, still shadows, sky (SH + cube + Lite's BRDF table),
  lamps, AgX: all Lite's numbers.
- The frame: static shadow map (still casters, Lite's fit; drawn at once
  when the sun turns past `refitAngle`, and with the next picture when a
  still caster changed), live map (live casters, in a frame one of them
  changed), G-buffer of still meshes at 1.24× only when the view or they
  change (still.ts's triggers; the sun never), relight into rgba16float on
  each G-buffer or still map draw and every `?relight=` ms (1000),
  composite (still.ts's `find`, car shadows exact in linear, the still map
  and the surface read only where the live map shades, headlights, tone map
  once, `frag_depth`) and the live meshes forward in the same pass.
- Lamps and headlights are binned by 64-pixel screen tile each frame (and
  the lamps by the picture's tile at each relight): a pixel loops over its
  tile's lights, not all of them (`binsAt` in compose.ts, `binner` in
  frame.ts).
- Draws: a render bundle per mesh per pass, encoded again only when the
  mesh's version is bumped (`_remade`: a buffer or material new) or the
  pass's shared groups are new; a list gathers its bundles again, encoding
  nothing, when only what is drawn changed (in/out, shown/hidden, emptied
  or filled). A mesh with no instances is not drawn. Instance counts go
  through `drawIndexedIndirect` args, so a car pool's count changes
  re-encode nothing.
- `engine.stats` (and the bench's `own.*`): pipelines, bundles, bundleMs,
  gbuffer, gbufferMs, relights, relightMs, stillShadows, liveShadows,
  frames, frameMs, picture.moved/changed/forced.
- still.ts under `?renderer=new`: `createStill` returns `ownStill`; `stale()`
  marks our picture due; each of our pictures bumps `redraws`.

## Measured (software GPU, 30-metro at 65,-46,14)

The town's middle is at y = -46 (its rows run south from 0): `?bench=65,46`
looks at empty ground. Draws in a frame without a picture: 24 (forward 14:
cars by colour, forklifts, water chunks, a hand-off twin; live shadow 9;
the composite), against 184 before empty meshes were left out and Lite's
34. A picture frame adds the G-buffer (~360) and, if due, the still map
(~220). 60 pipelines (gbuffer 24, forward 24, shadow 12), none new after
the first minute. A pan's bundle encodes are new meshes only, ~0.1 ms
each, against ~4 ms for a whole list before.

## Not done / not checked

- The studio (build menu pictures): written (forward, transparent clear) but
  not seen: neither renderer took a picture in four minutes of software GPU.
- The outline: written (mask task + quad), not seen (the town grid's houses
  are not outlined in either renderer when picked).
- Headlights: compile and run; binned by tile, checked against brute force
  (every point in a light's reach lands in a tile that lists it), not
  compared with Lite's at the same moment (the town grows between photographs).
- No cross-fade between static maps at refit; no MSAA; `setShadowStaticOnly`,
  `getCsmStaticTexture`, `onCsmReceiverUpdate` are stubs.
- Pipelines 60, the design's target is under 40: the forward 24 are mostly
  still materials drawn by their hand-off twins; fewer needs shaders shared
  across plugin sets.
- G-buffer albedo is linear rgba8unorm: dark colours could band; storing it
  as sqrt would cost nothing.
