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
  change (the sun never): as the view leaves the picture's margin; or, for
  a still change, the frame after it unless the town is still drawing its
  paving (`holdPicture`, `TownLayer.settled`), then once it is, or 250 ms
  at most. A change is drawn again where it is, in the picture shown, in
  one frame (`patch.ts`): each mesh's box, and each instance's matrix and
  attributes, are kept as it goes into the picture, and what differs since
  is a box in the world; its rect of the picture is emptied and every mesh seen over it
  drawn again there, scissored. A change that cannot be told by place (a
  new material, a new shape, a colour texture, the night) or covers over
  35% of the picture draws the whole picture into a second G-buffer, a
  share of its meshes a frame over six frames (three while the view moves,
  three for a change; `?spread=`), shown once whole. A whole picture close
  in on 30-metro costs 6-8.5 ms of a 3070's time, the still map 1-2 of it
  (gpu-42808667842; timed a mesh a pass, `?split=1`, the shares read
  leaves 5, walls 5, pavement 7, hedges 5, but every pass loads and stores
  the whole G-buffer, so their sum is several times the real cost). Relight into rgba16float on each picture shown or still
  map draw and every `?relight=` ms (1000),
  composite (still.ts's `find`, car shadows exact in linear, the still map
  and the surface read only where the live map shades, headlights, tone map
  once, `frag_depth`) and the live meshes forward in the same pass.
- Lamps and headlights are binned by 64-pixel screen tile each frame (and
  the lamps by the picture's tile at each relight): a pixel loops over its
  tile's lights, not all of them (`binsAt` in compose.ts, `binner` in
  frame.ts).
- Draws: recorded straight into each pass every frame, `drawIndexed` with
  the instance count read then. No render bundles, indirect draws or GPU
  culling: on an iPhone (Safari) those held a frame at 1.5-2.5 s; without
  them it ran 56-60 fps at 1.4-2 ms of JS (2026-11-10). A mesh's draw is
  made again only when its version is bumped or the pass's shared groups
  are new; a mesh with no instances is not drawn.
- `engine.stats` (and the bench's `own.*`): pipelines, encodes, encodeMs,
  gbuffer, gbufferMs, relights, relightMs, stillShadows, liveShadows,
  frames, frameMs, picture.moved/changed/forced; and the GPU's time by what
  a frame drew, `gpu.<plain|relight|shadow|picture>` (frames timed),
  `…Ms` and `…Slow` (over 16 ms).
- still.ts under `?renderer=new`: `createStill` returns `ownStill`; `stale()`
  marks our picture due; each of our pictures bumps `redraws`.

## Measured on a desktop card (RunPod, 30-metro at 65,-46,14, CPU 4× throttled)

- A whole G-buffer costs 6-8.5 ms of the GPU (gpu-42808667842). Drawn a mesh
  a pass it read ~30 (`?probe`, since removed, and `?split=1`; each pass
  loads and stores the whole G-buffer, so read the shares, not the sum: the 36 house meshes ~0.5 ms each, ~18 in
  all, their instances town-wide; pavement 6, hedges 4, ground 2, road
  lines 1.5; the still map ~5 in all). A frame with a whole picture in it
  was 40–60 ms; one without, 1–1.7 ms; a relight 3, a still map 10–14 with
  what else came in that frame. Hence the spread.
- Loading: a still change waited 100 ms, so while a town streamed in (a
  change every frame) every frame slower than that drew a picture, made
  slower by it: 2–7 fps for a minute. With the change drawn once things are
  quiet or once a second, the town is in after ~55 s, as with Lite
  (gpu-42737950480 against gpu-42734853840).
- After both, and the weighted spread (gpu-42746470444, with the client
  JS work merged): the town in at ~25 s and 59–60 fps from then; every
  phase 59–60 fps by day and night but zoom (~50, Lite's 47–50); frames
  over 34 ms 0–3 per 5 s; a picture's frames ~10 ms of the GPU, a few
  over 16. Against Lite (gpu-42734850087): frame JS 3.4 against 6.8 ms
  still, GPU 1.2 against 1.1, 19–25 draws against 194.
- That probe timed each mesh in a pass of its own: a pass's own cost
  (~0.05 ms) times a hundred pavement chunks was most of "pavement 6".
  `?probe` now times each kind in one pass, each list whole, the list
  reversed and an empty pass (`own.probe.<g|s>.<kind>`, us a probe). With
  the thin instances culled to the picture's view and to the sun's box
  (`cull.ts`, a compute pass before the list; gpu-42756517489,
  gpu-42765780376): a whole picture 4.9–5.9 ms (houses 3.4–4.2, ground
  0.6, hedges 0.35, pavement 0.33, roads 0.2, the rest under 0.1 each),
  the still map 2.7–3.4 (houses 2.5–3.2). Drawn in reverse order the
  picture costs 2% more: overdraw is not where it goes.
- But a frame with a share of a picture in it still costs the GPU 10–13
  ms (`own.gpu.picture`), as before the culling, and one with the still
  map 10–11, against 1–2 for a plain frame: the draws in them are a few
  ms, so most of such a frame is something else, fixed a frame (6 frames
  a picture or 3 cost the same each). Culling on the CPU instead of in
  dispatches changed nothing there (and cost 10 ms of JS a picture at 4×
  throttle), so it is not the dispatches. Not yet found; next to look at:
  the G-buffer pass's load/store of 3 targets and depth, the depth
  textures' layout changes between being drawn and sampled, and the
  GPU's clock as an idle card meets a burst.
- Hitches seen with ours in one run (frames over 34 ms, ~20 per 5 s, with
  the main thread and the GPU idle: long animation frames with no script)
  were not there in the next (2–4 per 5 s, as Lite's): they follow the
  machine, not the renderer.

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

- Tried and dropped (2026-11-10, same city and route): no alpha test and no
  fade discard in the G-buffer (`gpu-42808673272`), and what stands up drawn
  before what lies flat (`gpu-42809305983`). Neither drew a picture faster:
  against the still map's own time on the same pod, both came out 10-40%
  slower, and pods differ by twice that between runs, so a gain under ~2×
  does not show on one run each.
