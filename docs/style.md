# Style: how Sprawl looks, feels and works, and how to judge a new thing

Status: guide, 2026-10-02. Short on purpose. Read before building anything
that is seen. `look.md` is how the town is drawn; `network.md` is what
vehicles touch; this is how to tell whether a new thing is good, and the
verdicts so far.

## What it is for

So that "build me a ferry terminal" comes back decent the first time, and
the mayor's time goes on taste, not on things this page already settles.
It serves the game, not the other way round: the test is always the game
itself, looked at and played. A rule here that makes a worse game is
changed; a check that stops catching real failures is deleted. Keep it
short.

## The feel

A little model of a town on a map, not a real town. Mini Motorways' calm
(its palette, its light, its clean shapes) with what is Sprawl's own:
pitched roofs on homes, joined rows and perimeter blocks, cars at the kerb,
the ink line. European blocks and American suburbs both have a place
(strokes make rows or detached houses).

## The verdicts

Each a rule, why, and when it was given. New verdicts go here.

- **Big lines only.** Nothing smaller than about a tenth of a tile reads at
  the game's zoom. Plant rooms, chimneys and rooflights were tried and
  were noise (2026-09-30).
- **Primitives, not drawings.** A road looks right because it is a link the
  renderer draws, not a shape. A thing drawn by hand looks cheap and can
  be impossible: the ferry's yard (below). Build new things from the
  primitives (`network.md`, the town grid in `look.md`); if the primitive
  is missing, make the primitive.
- **It has to work, not just look like it.** Anything a vehicle touches can
  be reached and left (2026-10-02).
- **Simple and robust over special cases.** When a rule needs exceptions,
  the rule is wrong (the corner rules of 2026-09-27 to 29, replaced by
  joins).
- **Spacing is the same straight and diagonal.** A diagonal row is as thick
  as a straight one and stands as far from its street.
- **Kinds are like terrain types.** A building joins only its own kind;
  the player's stroke says what is one building (joins).
- **Corners.** A building's outside corners are rounded a little from
  above, its roof stays sharp; inside corners stay sharp.
- **Roofs.** Pitched on homes, shops and restaurants, no higher than a
  one-tile row's ridge; flat on sheds, depots and big boxes, as they look
  from above; the office tower capped (a darker roof, a lighter slab on
  it). Nothing on roofs.
- **Colour.** Each kind its own full colour (Mini Motorways), pale plots
  and pavement a shade under the road's white, the trees' dark teal the one
  dark note on the ground. White buildings and pale washes were tried and
  lost what tells kinds apart (2026-09-29).
- **Light.** The sky's light blue and the sun's warm, so shadows are tinted,
  not grey. A Dutch summer's day (sun up 05:20 to 22:00, noon at 0.8 of
  overhead), long golden hours, the setting sun a deep orange red; the
  sun's light fades with it, so lit roofs and their shadows go together.
  Tried and dropped: an afterglow after sunset (muddy), soft shadows that
  harden at contact (too slow).
- **Roads.** Asphalt alone, 0.4 wide; the pavement is the kerb. A car 0.15
  wide in a 0.2 lane, with room at the edge and between two passing.
  Parked cars wholly off the road.
- **Parking belongs to streets; yards are only as big as what they serve,**
  at the end that suits them: a depot's lorries at its quiet end, a
  supermarket's car park on its busy corner, deliveries round the back.
- **Look at real places first.** Every new kind starts from a handful of
  real ones (below); the supermarket's service bay and the ferry's layout
  came from them.

## Three layers of checking

| Layer | For | Who judges | How |
|---|---|---|---|
| Physics | turning, parking, speeds, swept paths | the agent | numbers on logged paths, a plotted trace |
| Real world | layouts, sizes, counts | the agent | measures over real examples, photos beside the result |
| Taste | colour, proportion, big lines, the feel | the mayor | the canon, blind comparisons, the verdicts above |

Physics, as constants (none checked in code yet): a car turns no tighter
than about 0.45 of a tile (5.5 m, a tile being 12 m), eases into a turn
rather than snapping to an arc, and slows before a bend; a lorry with a
trailer sweeps wider than its tractor. Cars in parking lots today turn far
too sharp: the first thing for a check to catch.

## Research: real places, any country

- **Maps, everywhere**: OpenStreetMap. In a cloud session the Overpass
  server `bun run osm` uses may be unreachable (2026-09-30); the main API
  answers: `https://api.openstreetmap.org/api/0.6/map.json?bbox=W,S,E,N`
  (keep the box under a few hundred metres). Find places with
  `https://nominatim.openstreetmap.org/search?q=…&format=json` (send a
  User-Agent, one request a second).
- **Aerial photos**, where open: the Netherlands, PDOK
  (`https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=Actueel_orthoHR&STYLES=&CRS=EPSG:4326&BBOX=S,W,N,E&WIDTH=900&HEIGHT=900&FORMAT=image/jpeg`);
  the United States, USGS NAIP
  (`https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage?bbox=W,S,E,N&bboxSR=4326&imageSR=3857&size=600,600&format=jpg&f=image`).
  Elsewhere, the map alone.
- **How**: four to six examples, from more than one country where the
  thing differs; the map and the photo of each side by side; write down
  what they share before designing.

## The canon

Things the mayor has said look good and work, kept as fixtures with their
photographs. An agent may propose an entry; only the mayor's yes puts it
in. Now and then a fresh agent rebuilds an entry from the guides alone, in
a copy where it is removed; if the mayor cannot tell the two apart, the
guides carry it, and if they can, the guides are what changes. Kept small,
and run when the guides change, not as a pipeline.

Proposed, waiting for the mayor's yes:

- Building plans: rows, blocks, diagonals (`12-diagonal`, `15-city`).
- Roads, pavement and kerb parking (`15-city`).
- The palette and the golden hour (`utrecht-lombok`, `?t=0.83`).
- A depot's yard and docks (`14-business`).
- A supermarket's car park and service bay (`14-business`).

## The counter-example: the ferry port

`16-ferry` is kept as what not to do. It looks wrong and cannot work: its
yard is drawn (strips and cars in a square), so its back rows have no way
in or out, and the real ones (Den Helder from the air) queue on a wide road
of many lanes curving down to the berth, not in a square. It is rebuilt on
`network.md`'s primitives: an entry link, a queue link of four lanes one
way merging onto the ramp, an exit link, the berth and its ferry.

## Next: making the work autonomous

The order for the sessions after this one:

0. **Tools to see and touch the game**, first, because everything after
   leans on them. What exists reads snapshots: `/health`, `/town`,
   `/inspect/{id}`, the `/debug/…` routes, `bun run shots` of the
   fixtures, the town and season tests. Missing:
   - **Acting**: place a road or a building, set the speed, move the
     clock on the running game, from a command, as the mayor's hand does,
     so an agent can set up a situation and watch it.
   - **Looking anywhere**: one shot command for the game and the sandbox
     that takes a place, a zoom, a time of day and a crop, and scripted
     brush strokes for the sandbox. (Written by hand all through
     2026-09-28 to 10-02 and lost with each container: commit them.)
   - **Seeing motion**: vehicles' paths logged and plotted, and a short
     sequence of frames, for what a still cannot show (cars turning too
     sharp); the physics check reads the same paths.
   - **A plan view**: the town grid and the network drawn flat as SVG,
     no light, no 3D: instant and exact, and comparable between two
     versions. In a cloud session a sandbox photograph takes twenty
     seconds to a minute; most layout questions need only the plan.
   - **Asking why**: what is at a tile, what it is joined to, why a stop
     is red.
1. **A research tool**: one command that takes a place, anywhere, and
   lays its map and photo side by side, as was done by hand for the
   supermarkets and ferries.
2. **A project skill for new things** (`.claude/skills/`): research,
   design in primitives, check, look at it (two zooms, noon and golden
   hour), fix, and only then show, with the references beside it.
3. **The network primitives** (`network.md`), in the sandbox: links with
   lanes, stops, the reachability check; the car park, docks and service
   lane re-made on them.
4. **Cars that turn and park naturally**, with the physics check.
5. **The canon**, once the mayor has said yes to its entries.
