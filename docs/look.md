# The look: a town that knows what it is next to

Status: direction, 2026-09-28; the town grid's state as of 2026-10-02.
Built: the palette, the pen, the fixture sheet, and in the sandbox the
town grid (§The town grid), which goes into the game with parking. How to
judge a new thing, and every verdict so far, is `style.md`. The concepts it was argued from are the pattern
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
- **A building is drawn as a road is** (`town/footprint.ts`): its tiles
  and the joins between them, as the brush stroke ran (`Town.joins`), and
  its plan one thick line through them: a square of the building's width
  on each tile (unless it is joined only on the diagonal; where the tile
  steps on the diagonal, its corner there is cut on the band's edge, so a
  row two wide is one clean band too), a band of that
  width along each join, beside or diagonal, so a diagonal row is as thick
  as a straight one, a house standing alone turned a quarter over where a
  diagonal street runs past its corner (not beside a bend or dead end), and the square between four tiles
  joined all round,
  so a block is solid. Tiles not joined stand apart: a stroke along a
  street is one row, separate clicks are detached houses, and a stroke
  that turns is an L where one that steps is a diagonal band, with nothing
  guessed; a stroke over a building's own tiles joins them as it runs,
  so a drag across an inside corner fills it on the diagonal, and one
  run on to another building of its kind joins the two. A town with no strokes (a fixture, a real place) is joined by
  kind, beside, and on the diagonal unless the block is solid there or a
  street runs between. This replaced corner rules that had to guess, from
  the tiles alone, a staircase from an L. Not yet: a diagonal row's
  distance from a diagonal street, which the corner rules kept.
- **Roofs are exact** (`town/roof.ts`): every wall raises a roof face
  climbing in from it, and the roof over a point is the lowest face there,
  flat beyond its reach, so ridges, hips and valleys fall where faces meet.
  A house's roof climbs no higher than a one-tile row's ridge, so deeper
  buildings are flat on top at that height. Then the outside corners are rounded
  off from above, roof and all, so the roof stays sharp and the walls rise
  to meet it. An office tower is capped instead, the way a model
  town's towers are: a flat roof a shade darker, and on it a slab a shade
  lighter, drawn in from the edge. Tried and dropped (2026-09-30): the cap
  on every flat roof, and quirks on roofs (plant rooms, chimneys,
  rooflights), too small for the map: big lines only.
- **A shed is a business park's** (14-business, Lage Weide): its office
  at its street end, the whole end across, a couple of storeys over the
  hall and lighter, found from the building's tiles, its long way and the
  end with most street round it; a workshop of a tile or three is a hall
  alone.
- **Facts, then looks** (`town/facts.ts`): a pre-pass works out what a
  tile cannot see from its neighbours, once for the whole town: a shed's
  office end; a courtyard, open ground that no street and no map edge
  reaches; and a yard, where a kind keeps one (`mass.ts`): as much of the
  building's own ground as the yard must hold, street tiles in one run
  from its quiet end or its busy one. A depot's is at the quiet end, a
  dock for every two tiles, its office at the busy end; a supermarket's
  car park is on the busy corner, three cars to a tile of shop. The rest
  is building. A supermarket two tiles deep and wide also takes its
  deliveries at the back, as real ones do (six Dutch ones from
  OpenStreetMap, 2026-09-30): a lane cut from its quieter side, front to
  back, and at its end a bump on the back wall, the loading bay, with a
  lorry backed up to it. Neither takes a tile: the lane is cut from the
  building, the bump stands in the margins behind it. Everything drawn is a function of a tile, its neighbours and
  these facts.
- **The free ground is dressed** (`town/dressing.ts`) by the same rule. A
  courtyard is a lawn with a tree on most tiles; paved ground closed in
  stays a square. A straight street before homes, shops or open ground has
  a tree on its verge every third tile; through roads, junctions, bends,
  diagonals and industrial streets stay bare. A street before homes and
  shops is parked along both kerbs (fileparkeren), straight or diagonal,
  wholly off the road in a parking lane with its bays marked, in the strip
  the rows' setback leaves, clear of junctions, bends, ends
  and trees, with a gap here and there. Drawn only, for now: the cars the
  simulation parks come with `parking.md` step 1. A depot's yard has lorry
  bays along the hall wall across from its street, three to a tile, a door
  behind each and lorries backed up to most; a car park has an aisle
  along its street between two rows of bays, ten cars to a tile, most
  taken. One brush paints the building, and its yard comes with it.
  A house with open ground beside it, on a side it is joined to nothing
  on, has a driveway down that side, from the road's edge to its back
  wall, a car or two on it nose in, and no kerb bay across its mouth: a
  house alone, a semi, the ends of a row. The middle of a row, and a
  house with buildings on both sides, park at the kerb. Built beside,
  the drive goes. So a suburb has driveways and a terrace parks in the
  street, by the neighbours alone (`17-driveways`, 2026-10-02). The
  road, the drives and the service lanes are one asphalt (`asphalt` in
  `dressing.ts`), its corners rounded in and out, so a drive reads as
  the road carried on; a kerb's parking lane stands apart beside it, its
  ends rounded (2026-10-02, the mayor: the kerb is not the road). The pavement is
  ground: every road, building and yard makes paved ground, shaped by the
  buildings' own rule run on it at full size (the terrain's corners in
  straight lines, a diagonal as far out as a straight edge, so a diagonal
  street is as wide as a straight one), then every corner rounded as the
  terrain rounds a shore (`soften`). So a town is paved house to house,
  and the grass left between blocks has soft edges. Where a tree stands comes
  from the tile's place alone, so a town is always dressed the same.
- **Buildings are painted**, a tile at a time as roads are drawn, with a
  brush per kind (`town/brush.ts`). Each kind has a program: the smallest
  rectangle it works in, fronting a street along its long side, and how far
  from a street it may reach (a house: one tile, the frontage only; a depot:
  three by two, and back six). A stroke is completed as it is painted to the
  smallest working building holding it, shown as a ghost: one tile becomes a
  whole depot, painting sideways turns it, painting on makes it bigger, a
  bump and all. Only tiles it can take are lit, so nothing invalid is ever
  painted. Letting go builds it. A stroke begun on a building grows that
  one.
- **The sandbox** (`/sandbox` on the dev client) draws any fixture with
  no server, at any time of day (`?t=`, 0 midnight, 0.5 noon), over a
  faint grid of its tiles (`g` hides it), and paints: a brush per kind,
  taller and lower, and "Copy" to take the map away as a fixture. `bun run
  shots --sandbox` photographs every fixture this way in seconds.
- **A ferry port** (16-ferry, after Den Helder, Harlingen, Hoek van Holland
  and Harwich in OpenStreetMap, 2026-10-02) lays out as they do: down one
  side, the side whose end reaches a street, its exit road, from the ramp
  at the quay back to the street, so the cars come off before the queue
  goes on; beside it the marshalling yard, by the same yard rule from the
  water back, as many tiles of queue lanes as one sailing fills (forty
  cars, eight to a tile), the cars thinning from the front of the queue to
  the back; and the terminal in the far corner. The ferry is moored stern
  on to the ramp, drawn bigger than true so it reads beside the yard. More
  than a sailing's cars queue back onto the approach road: the player's
  to give a port road enough. A look of the sandbox's for now: `P` is a
  port there and grass to the server, until the game says which berths a
  port has. **Not right, and kept as the counter-example** (`style.md`):
  its yard is drawn, so its back rows cannot be reached, and a real queue
  is a wide road of many lanes, not a square. It is rebuilt on
  `network.md`.
- **Not yet: a finer grid under the ground.** Three by three to a tile,
  a sub-cell fits a car, a bay row and aisle and bay row make a tile, and
  lanes, bays, bumps and alleys would be labels on sub-cells. Weighed on
  2026-09-30 and left for now: nothing yet needs ground shared across
  buildings, and a grid squares off diagonals. Worth trying when back
  alleys, a port's quay or a yard across a block need it: for the ground
  between buildings, never for the buildings' own shapes.
- **Tried and dropped**, so they are not tried again blind: plans sampled
  as distance fields (wobble, clipped corners); front gardens, courtyards
  by depth, gables and dormers built on distances (they broke on diagonals
  and at street ends); street clearance cut from the road's drawn shape
  (curved and notched corners); a straight-skeleton library for roofs
  (failed on real plans); plans on a fine grid by marching squares (clean
  diagonals, but nicked corners and slower, for no gain).

What it does not do yet: heights come from the kind alone; the yards'
lanes, bays and docks are drawn by hand in `dressing.ts`, not yet the
links and stops of `network.md`; and it is in the sandbox, not the game.
Next (`style.md` §Next): the network primitives, the yards re-made on
them, cars that turn naturally; then into the game on the terrain's chunks
and worker, with the facts that change play (a depot's docks, an
airport's gates) worked out on the server.

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
