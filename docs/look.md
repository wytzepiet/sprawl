# The look: a town that knows what it is next to

Status: direction, 2026-09-28. Built: the palette, the pen, the fixture
sheet, and in the sandbox the town grid (§The town grid), which goes into
the game with parking. The concepts it was argued from are the pattern
book (https://claude.ai/artifact/XUGqKzMYVtypqraRp9R8tE), where every
drawing carries the verdict it was given.

## The problem

Every building draws itself alone: a box on its tile, a stub of driveway
to the street, a slab of lot with its own kerb. A town of them is a
scatter of loose parts, and the parts are what the eye sees. Joining
houses by hand in the mesh code (2026-09-27) made it worse, not better:
one idea, written straight into geometry, judged by whoever wrote it.

## The direction: the perimeter block

Barcelona's Eixample crossed with a Dutch street. Buildings line the
street and face it; cars line the kerb; the middle of a block, where the
backs meet, is green. Three things were kept from the pattern book and
they are the same form:

- **Parking along the kerb** (fileparkeren), not on driveways and lots.
- **Rows that follow the street**, straight or diagonal.
- **A garden in the middle of the block.**

It gives every street a face and hides nothing behind it, which is what a
game about streets wants.

## How it is made: rules, not buildings

A building's look is decided by what it is next to, the way Townscaper's
pieces are, and the same holds for open ground: nothing is drawn per
situation. The town is a grid; a pre-pass works out the few facts a tile
cannot see from its neighbours (which building it is part of, a shed's
office end, and to come, a courtyard closed in by buildings); and then
every tile's look is a function of its neighbourhood and those facts. The
terrain is drawn the same way already. A first try drew situations one
at a time from SVG pieces, and was deleted: a town has more situations
than anyone will draw.

### The town grid: the look decided corner by corner

The code is `client/src/engine/town/`:

- **The town is a grid of tiles**, each one kind (a building's kind, or
  road, water, wood, open ground) and some storeys, and the road links
  between tiles. Nothing about lots, driveways, facings or who owns what:
  those are the simulation's, and the look reads none of them.
- **A building is its tiles' squares, drawn as the terrain draws a
  shore** (`town/footprint.ts`), each tile decided by its 3×3 alone. Tiles
  join into one building if they are one kind (and, for sheds, offices and
  boxes, painted as one); houses run on into rows whoever built them. A
  step's corner is cut (neither tile beside it the building, and the
  building going on along the diagonal past one of them); every inside
  corner, between two steps or in an L, is filled, as the terrain fills
  its inside corners, so every cut has its fill. Two tiles a street runs
  between, across their shared corner, are no neighbours to any rule: a
  building cut off by a road does not count. Cuts and
  fills lie half a tile either side of a diagonal row's middle. Then the
  outline is drawn in by one width. Outside corners stay square. This is
  the simplest version, kept as the base: exceptions to it (keeping an
  L's inside square, straightening whole outlines) each broke something
  else. A courtyard's corners are cut at forty-five degrees.
- **Roofs are exact** (`town/roof.ts`): every wall raises a roof face
  climbing in from it, and the roof over a point is the lowest face there,
  flat beyond its reach, so ridges, hips and valleys fall where faces meet.
  A house's roof climbs no higher than a one-tile row's ridge, so deeper
  buildings are flat on top at that height.
- **A shed is a business park's** (14-business, Lage Weide): its office
  at its street end, the whole end across, a couple of storeys over the
  hall and lighter, found from the building's tiles, its long way and the
  end with most street round it; a workshop of a tile or three is a hall
  alone.
- **Facts, then looks** (`town/facts.ts`): a pre-pass works out what a
  tile cannot see from its neighbours, once for the whole town: a shed's
  office end, and a courtyard, open ground that no street and no map edge
  reaches. Everything drawn is a function of a tile, its neighbours and
  these facts.
- **The free ground is dressed** (`town/dressing.ts`) by the same rule. A
  courtyard is a lawn with a tree on most tiles; paved ground closed in
  stays a square. A straight street before homes, shops or open ground has
  a tree on its verge every third tile; through roads, junctions, bends,
  diagonals and industrial streets stay bare. Where a tree stands comes
  from the tile's place alone, so a town is always dressed the same.
- **Buildings are painted**, a tile at a time as roads are drawn, with a
  brush per kind (`town/brush.ts`). Each kind has a program: the smallest
  rectangle it works in, fronting a street along its long side, and how far
  from a street it may reach (a house: one tile, the frontage only; a depot:
  three by two, and back six). A stroke is completed as it is painted to the
  smallest working building holding it, shown as a ghost: one tile becomes a
  whole depot, painting sideways turns it, painting on makes it bigger, a
  bump and all. Only tiles it can take are lit, so nothing invalid is ever
  painted. Letting go builds it. Painting beside a building grows that one.
- **The sandbox** (`/sandbox` on the dev client) draws any fixture with
  no server, over a faint grid of its tiles (`g` hides it), and paints: a
  brush per kind, taller and lower, and "Copy" to take the map away as a
  fixture. `bun run shots --sandbox` photographs every fixture this way in
  seconds.
- **Tried and dropped**, so they are not tried again blind: plans sampled
  as distance fields (wobble, clipped corners); front gardens, courtyards
  by depth, gables and dormers built on distances (they broke on diagonals
  and at street ends); street clearance cut from the road's drawn shape
  (curved and notched corners); a straight-skeleton library for roofs
  (failed on real plans); plans on a fine grid by marching squares (clean
  diagonals, but nicked corners and slower, for no gain).

What it does not do yet: heights come from the kind alone; the dressing
is gardens and street trees only; and it is in the sandbox, not the game.
Next: more dressing (kerb parking, front yards, lamps before shops); then
into the game on the terrain's chunks and worker, with the facts
that change play (a depot's docks, an airport's gates) worked out on the
server.

## The ladders

What each kind becomes as it does well, and with its neighbours:

- **Homes**: a house, a pair, a terrace, then storeys along the block
  edge until they are flats. Emergent, not a separate build: the player
  places homes and the neighbourhood's supply decides the form. Waits for
  the growth loop.
- **Shops**: a parade with one awning, a market square where shops face
  one space, a shopping centre with one car park where many share. A
  restaurant puts tables out in the evening.
- **Ports**: quays join into one waterfront, warehouses behind become a
  dock district, cranes come with throughput, containers stack as the
  shelf fills.
- **Industry**: sheds in rows with shared yards, stock piled where it is
  seen.
- **Streets**: take their character from what fronts them. Homes: trees,
  bays, quiet. Shops: wide pavement, lamps, awnings, crossings. Industry:
  wide, bare, loading bays. Nobody places street furniture. Lamps are the
  one that matters most: the night lights them.

## Rules for the drawings

What the pattern book and the image models taught:

- **Nothing smaller than reads at the game's zoom.** The image models'
  detail (bins, washing lines, cobbles) is noise at a car's size.
- **Cars shape the street more than buildings do.** Two cars on every
  driveway cluttered every concept; the calm ones parked at the kerb.
- **One idea per rule.** A rule does one thing a player would name: "the
  row follows the street", "the middle is a garden".

## The loop

1. **Situations** are fixture towns (`server/fixtures/*.txt`); each new
   one gets a fixture before it gets a rule. Drawn by hand for one idea
   (`01-terrace`), or taken from a real place (`bun run osm`, see
   `CLAUDE.md`), which brings the situations nobody thinks to draw: the
   odd angle, the leftover wedge, the street that bends. The real ones
   are chosen for difference, one of each kind of place: terraces
   (Lombok, Levenshulme), a turned grid (the Eixample), canals (the
   Jordaan), a tangle (the Marais), lanes (Kichijoji), a woonerf town
   (Houten), a village (Castle Combe), a cliff (Oia).
2. **Concepts**: several deliberately different drawings per situation,
   into the pattern book, with image models (`OPENROUTER_API_KEY`) for
   ideas when there are none, asked for game zoom and top-down.
3. **Verdicts** are the mayor's. Nothing goes into the game unkept.
4. **Rules**: a kept drawing becomes a rule of the town grid; the sandbox
   shows it on every fixture.

## Patterns to borrow

Christopher Alexander's *A Pattern Language* (1977) is a pattern book
for towns written the way these rules are: each pattern a situation and
what answers it. Its patterns are candidates for concepts, not verdicts;
the ones that read at game zoom, by what the rule would read (a
building's tiles, a street, a junction, or a free tile):

| Pattern | Rule | In Sprawl |
|---|---|---|
| 38 Row Houses | plot | the row, built |
| 122 Building Fronts | plot | a front that follows the street's line, bent or not |
| 89 Corner Grocery | plot | a shop is drawn to the corner; the corner house becomes one |
| 115 Courtyards Which Live | plot | apartments round a court that opens to the street |
| 106 Positive Outdoor Space | free | a block's middle closed on all sides |
| 60 Accessible Green, 67 Common Land | free | a green every few blocks, shared by the backs round it |
| 61 Small Public Squares | free, node | where streets and shops meet, an open paved square |
| 171 Tree Places | path, free | trees where people stop: a junction, a square, a gap |
| 100 Pedestrian Street | path | shops on both sides and slow traffic: wide pavement, no kerb |
| 52 Network of Paths and Cars | path | the woonerf: a street homes share with cars |
| 97 Shielded Parking | free | a car park behind a row, not in front of it |
| 53 Main Gateways | node | where a road enters a district, something marks it |

## Order

1. Parking belongs to streets (`parking.md`, direction of 2026-09-28): the
   biggest change to the picture, and a deletion. The town grid goes into
   the game with it.
2. More dressing: kerb parking with step 1, front yards, lamps before shops.
3. New fixtures and concepts: a shopping parade, a port, an industrial
   row, an airport.
4. The ladders, as the growth loop arrives.
