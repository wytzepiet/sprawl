# The flat view: the game in 2D, and seeing what the server does

Status: direction, 2026-10-10; built the same day: the drawing, `bun run
flat` and the minimap (§Built). Headless Chromium runs WebGPU in software
(SwiftShader), so a cloud session can photograph the real game, but at
twenty-odd seconds a picture: `bun run look` is kept for light and
material, and the flat view answers where things are in a fifth of a
second. The far zoom and the low-end mode stand.

## Why

The game is drawn by Babylon Lite on WebGPU, and a cloud session has no
WebGPU: it can prove the server's tests hold, but not that a harbour looks
like a harbour or that a lorry backs up to the right box. A flat view,
drawn on an ordinary 2D canvas, runs in any browser, headless Chrome
included. It does four jobs:

1. **Seeing in the cloud.** A run, or an agent, takes pictures of the live
   game in the flat view at every step, and compares them with what it
   meant to build. The player can look at them from a phone.
2. **The minimap**, in a corner, always.
3. **The far zoom.** Zoomed out past the town, the 3D view hands over to
   the flat one: the island, its towns, the ships on the lanes.
4. **A low-end mode** for a device without WebGPU.

## What it draws

The same state the 3D view draws, from the same messages, by the same
rules, flat:

- **Terrain** a colour a tile: sea, lake, beach, grass, forest, mountain;
  the coast crisp.
- **Roads and streets** as lines of their width, one-way with a tick,
  junctions as they are.
- **Buildings** as their footprints in their kind's colour, the lot and
  yard lighter, an icon at the door; a site as its outline, filling as it
  goes up; a draft blue and translucent, a demolition marked red.
- **Vehicles** as small oriented shapes, by role: cars, lorries with or
  without a box, tankers, tippers, tractors, the tug; ships as hulls their
  length in tiles, with what is on their deck drawn on it.
- **Boxes** in yards and on decks, stacked, a colour per good; empties
  hollow.
- **Fields** by stage, lanes at sea faintly by their use, and pins for
  shipments on their way.

The rule for everything new: **a kind of thing draws itself in both views.**
A building, a vehicle, a box that has no flat drawing is not finished.

## Built

- **One drawing**, `client/src/flat/draw.ts`: the entities as the client
  holds them, the ground as the server's chunks, and the clock, onto any
  2D canvas: the browser's, or `@napi-rs/canvas`'s in a script. No
  Babylon, no Solid. The ground is a picture a chunk, a pixel a tile,
  made once and drawn scaled and crisp, so the whole island costs as
  little as a street. Roads as lines of their width, a one-way's arrow,
  an island network red; buildings their tiles in their kind's colour,
  outlined; a site an outline filled from the bottom as its timber
  comes, and labelled with how much; a farm's land by stage; a
  harbour's park, each dock and its box.
- **Vehicles where the 3D view has them.** Their poses come from
  `engine/objects/motion.ts`, which `CarObject.tsx` places its meshes by
  too: a trip driven as `driver.ts` steers it, a run, the ferry's voyage,
  the tug's shunt, the deck's slots, a lorry's box straight behind it
  when parked. The flat view takes the server's distance as it is; the
  3D one eases a change of pedal in over half a second, the one
  difference. Each role its shape and livery: cars in their colour, a
  lorry's cab and box, a van, a tractor, the tug, the ferry's hull with
  its fifteen slots and what is on them. Boxes by their good's colour
  (`GOODS`), empties hollow. The 3D boxes are coloured by `sea.ts`'s own
  table, which does not yet agree (crates red there, green here).
- **`bun run flat x,y[,r]`** (`client/scripts/flat.ts`): listens on the
  game's socket as a client does, so it draws what a player would see,
  and writes `.dev/flat/<name>.png`, labelled: kinds and ids of
  buildings, ids of vehicles, the grid numbered in the game's tiles,
  and a legend with the clock and each ferry's state. `--frames 8
  --every 500` a run of them and a strip; `--follow <id>` keeps a
  vehicle in the middle; `--px` the scale. About 150 ms a picture in all
  on the opening's harbour, the drawing 40 to 100 ms of it.
- **The minimap** (`ui/Minimap.tsx`), in the bottom right, on the glass:
  the drawing round the camera, three times its view or ninety-six tiles,
  every vehicle a dot, the view outlined, drawn again three times a
  second, 1 ms a drawing. A click sends the camera there. Its rim is the
  glass's colour, not the GPU's glass, whose frost would be spent round a
  picture that hides it. The ground of every chunk ever
  heard of is kept (`groundOf`), so the island fills in as it is seen.

Not yet: drafts and demolitions (drawn where the buildings are, in
`drawFlat`'s building loop, once the server sends them), lanes at sea,
shipments' pins, the far zoom (the drawing already scales to the island),
the low-end mode.

## Seeing what the server does

Pictures show where things are; the server should also say why. What
exists: `/inspect/<id>` (a card: a building, a resident, a vehicle), `/town`,
`/map`, the mayor's hand (`bun run act`), `watch` and the paths it records.
What a run will want, and may add:

- **A shipment's story:** every step of a load from order to shelf, with
  the times planned and taken.
- **A ship's day:** its voyages, its berths, its blocks and waits.
- **A trace of a tick:** what woke, what it decided, in order, for one
  entity or a tile's neighbourhood.
- **Assertions over a scenario:** a fixture, a script of the hand's
  actions, a run of the clock, and checks on what happened, as the town
  and season tests do, so a behaviour seen once is kept.

Tools that make the game easier to see and to check are always welcome;
they are how an agent works without a screen.
