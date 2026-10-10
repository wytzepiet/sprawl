# The flat view: the game in 2D, and seeing what the server does

Status: direction, 2026-10-10. Nothing built beyond `bun run plan`, which
draws the town grid flat as SVG from the sandbox's code.

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

## Pictures from the cloud

A script, beside `look` and `shots`, that starts a stack (or uses a running
one), opens the client in headless Chromium in the flat view, frames a
tile or a building or a vehicle, and writes PNGs: one, or a strip over
game time (`--frames 8 --every 250`), and a sheet. Its pictures land in
`.dev/` and can be sent to the player. It needs no GPU.

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
