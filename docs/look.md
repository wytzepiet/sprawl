# The look: a town that knows what it is next to

Status: direction, 2026-09-28. Built: the palette, the pen, the fixture
sheet, the piece system in the game (§Pieces, as built), and in the
sandbox the town grid that replaces it (§The town grid). The concepts it was argued from are the pattern
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
- **The corner cut on the diagonal**, a house or a block turned to face
  the junction.
- **A garden in the middle of the block.**

It gives every street a face and hides nothing behind it, which is what a
game about streets wants.

## How it is made: rules, not buildings

A building's look is decided by what it is next to, the way Townscaper's
pieces are. Every kind has three relationships, and the rules are written
against those, not against the kind:

1. **Its frontage**: how it meets the street.
2. **Its neighbours**: what happens where it touches another.
3. **Its success**: what it grows into when it does well.

Roads and open ground are decided the same way: a street by what fronts
it, a junction by the streets that meet it, an empty tile by what
surrounds it. The rules are of four kinds:

| Rule | Matched on | For |
|---|---|---|
| **Plot** | the tile grid round a plot | terraces, quays, corners |
| **Path** | a road's drawn line, at any angle or curve | kerb bays, lamps, street trees, pavements |
| **Node** | a junction | roundabout islands, verges, crossings |
| **Free** | an open tile and what closes it in | block middles, pocket greens, later a car park or a square |

Most open ground stays grass. A free rule answers only a situation that
asks for something: the middle of a block, a single gap in a row.

The corner cut on the diagonal is a plot rule, not a node rule: the
building on the corner draws itself (it is picked, tinted and remounted
as one thing), so its rule reads the two streets beside it rather than a
junction reaching into its tile.

Path and node rules follow the road's geometry, so a diagonal or a curve
costs nothing. Where a diagonal road cuts past square plots it leaves
triangles between kerb and plot; those are the Avinguda Diagonal's gift,
not a problem: pocket greens, wedge gardens, fronts cut at 45°.

**A piece is data.** A plot, path or node rule names a situation and
the piece that answers it, and the piece is an SVG drawn top-down in the
situation's frame, each shape carrying its role and height (`roof`,
`wall`, `pavement`, `garden`, `tree`, `water`). The client reads the SVG
and raises it; colours come from the theme by role. Adding a variation is
a pattern and a drawing, never mesh code. Pieces are drawn around what
the simulation owns (the road, where cars park) and never over it.

### The town grid: the look decided corner by corner

The piece system names situations one at a time, and a town has more
situations than anyone will draw: the real places (`bun run osm`) came
out as streets and houses and nothing between. Townscaper's answer is the
dual grid, and it is this one's now (`client/src/engine/town/`):

- **The town is a grid of tiles**, each one kind (a building's kind, or
  road, water, wood, open ground) and some storeys, and the road links
  between tiles. Nothing about lots, driveways, facings or who owns what:
  those are the simulation's, and the look reads none of them.
- **A built tile is four quarters**, and a quarter is shaped by the three
  tiles at its corner: the two beside it and the one on the diagonal.
  Built beside it, it runs on wall to wall; a road, it stops at the
  pavement; open ground, it leaves a garden's depth. Built on both sides
  and open on the diagonal, the corner is a courtyard's inside corner.
  Road on both sides, the corner is cut on the diagonal to the junction.
- **Which way a road runs is part of the corner.** Two road tiles beside
  a quarter, joined to each other, are one street running across the
  corner on the diagonal, and the corner is cut deep, clear of it; not
  joined, they are two streets meeting beyond it, and the cut is a
  chamfer. The tiles alone cannot tell these apart; the links can.
- **Diagonals are the terrain's rule.** Open ground with buildings on
  both sides of a corner has that corner filled on the diagonal, and the
  buildings' faces run straight across it; the outer corner of a step,
  with the row going on beyond both its sides, is cut on the same line.
  So a row stepping along a diagonal street is a straight front, the back
  of it too, and a courtyard's inside corners are cut at forty-five
  degrees, as the terrain turns a staircase of water tiles into a shore.
- **Each kind has a form**: how it meets the street and its neighbours,
  a row of a table (`FORMS` in `town/mass.ts`). Homes and high-street
  shops are one family, joined wall to wall at the pavement, gardens
  behind. Offices keep a forecourt; sheds stand apart behind a paved yard;
  a big box stands behind its car park. Only the street side is kept
  open, where the docks and the parking go; elsewhere buildings stand
  close, a narrow alley between two, and where their backs are ragged the
  space between them is what is left over. So an industrial estate is
  sheds packed side by side and never a terrace of factories into houses.
  Seen in the real places: Lage Weide (industry), Zuidas (offices), the ArenA Boulevard
  (big boxes).
- **A building is only so deep** from the edge of its block (a tile for
  homes and shops, more for offices, as deep as it likes for a shed): the
  rest is the block's inside, a courtyard. So a solid block is a ring of
  houses round a garden however it was painted or mapped (13-block).
- **A row of houses is one roof, with a rhythm**, as a 1920s Utrecht street
  is: one colour, one height, a ridge along the street, the row stood back
  behind a strip of front garden, and now and then (every sixth) a house
  stepping forward to the pavement under a gable of its own with its point
  on the front. The gable is a height the roof is raised to, so the valleys
  where it meets the main roof fall out. Only on a straight street: on one
  stepping on the diagonal the road beside a house is a step, not its
  front, and the row there is a plain band along the street, as deep as a
  straight row's, running on into the corners of the steps the street
  leaves and across half of each open tile behind it (12-diagonal).
- **A shed is a business park's** (14-business, Lage Weide): its office
  at its street end, the whole end across, a couple of storeys over the
  hall and lighter, and rooflights across the hall's roof the short way.
  Both are found from the building's tiles, its long way and the end with
  most street round it; a workshop of a tile or three is a hall alone.
- **A building is what was painted as one.** Two sheds painted side by
  side stay two sheds, each on its yard; painting beside one grows that
  one. Houses and shops are the exception: a street's run on into a row
  whoever built them. A factory beside a depot is two buildings. A fixture
  has no record of what was painted as one, so there a kind's touching
  tiles are one building.
- **Streets are kept clear by distance**, from the middle line of every
  street at whatever angle it runs, not by which side a road tile is on:
  a diagonal street gets a front parallel to it.
- **The roof is the distance in from the outline**, so a row gets a
  ridge, its end a hip and an L a valley, and nothing is told which way
  to run. A quarter is a few straight lines, so the outline is traced
  from samples of their largest signed distance, a metre apart.
  Different heights join wall to wall and keep their own roofs.
- **Every layout is covered**: a quarter has some thirty cases, not the
  thousands a tile has with eight neighbours, so there is nothing to
  draw per situation, only the rules of a quarter to tune.
- **Buildings are painted**, a tile at a time as roads are drawn, with a
  brush per kind (`town/brush.ts`). Each kind has a program: the smallest
  rectangle it works in, fronting a street along its long side, and how far
  from a street it may reach (a house: one tile, the frontage only; a depot:
  three by two, and back six). A stroke is completed as it is painted to the
  smallest working building holding it, shown as a ghost: one tile becomes a
  whole depot, painting sideways turns it, painting on makes it bigger, a
  bump and all. Only tiles it can take are lit, so nothing invalid is ever
  painted. Letting go builds it. Size will be capacity: a longer frontage
  more docks, a bigger farm more fields.
- **The sandbox** (`/sandbox` on the dev client) draws any fixture with
  no server, and paints: a brush per kind, taller and lower, and "Copy"
  to take the map away as a fixture. `bun run shots --sandbox` photographs
  every fixture this way in seconds.

What it does not do yet: heights come from
the kind alone; the ground between buildings is bare; and it is in the
sandbox, not the game. Next, in the sandbox: gardens and yards on the
open ground a block closes in, shop fronts and awnings on the quarters
that face a street, heights that vary with the street, and a
variation pass (chimneys, dormers, trees) chosen per corner. Then into
the game: parking to the kerb, driveways and lots deleted, a building
the tiles it covers, and the piece system below deleted with them.

### Pieces, as built

- **Where.** Drawings are `client/src/engine/pieces/drawings/*.svg`, one
  file a piece, named by the file. The rules are the four tables in
  `pieces/rules.ts`, each a list of situations and the pieces that answer
  them; the first that holds wins, and a list of several pieces picks one
  by the tile, the same one every time.
- **The frame.** A hundred units a tile, the tile 0 to 100, and `down` is
  what the piece answers: the street for a plot, the frontage for a
  street (which runs across the middle), the arm for a junction. A rule
  asks about `down`, `up`, `left` and `right` in that frame, and every
  rule is tried mirrored too, so one drawing serves both hands.
- **Roles.** A shape's class is its role, and `data-h` its height.
  `roof` is walls and a roof: a rect gets a gable along its long side, so
  rects laid end to end are one ridge; any other outline, a hip. `wall`
  is a flat-topped block, `tree` and `lamp` round posts; `garden`,
  `pavement`, `water` and `marking` lie flat, each at its own height, so
  the ink finds their edge. Colours come from the theme by role; a
  building's roof and walls are its kind's.
- **Who draws.** A building draws its plot piece itself. Everything else
  is the dressing (`pieces/dressing.ts`), which redraws the tiles round
  whatever a batch changed. A block's middle is one thing: touching any
  of it redraws all of it.
- **A house's frame** is the first side a street is on. A house has no
  lot, so its facing is whichever reached a street first and is no
  guide.
- **What exists.** Plot: a house, a terrace and its ends, the corner, the
  corner that ends a terrace. Path: a street tree every other tile before
  homes, a lamp before shops; a through road stays bare. Node: a zebra
  across every street arm of a junction. Free: a block's middle (open
  grass closed in by buildings and streets, forty tiles at most) is lawn
  and a few trees; a single gap in a row of houses is a pocket green.
  Kerb bays wait for parking to belong to streets.

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
  corner turns", "the middle is a garden".

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
4. **Pieces**: a kept drawing becomes a piece and a rule; `bun run shots`
   shows it in the game beside the drawing it came from.

## Patterns to borrow

Christopher Alexander's *A Pattern Language* (1977) is a pattern book
for towns written the way these rules are: each pattern a situation and
what answers it. Its patterns are candidates for concepts, not verdicts;
the ones that read at game zoom, by the rule kind that would carry them:

| Pattern | Rule | In Sprawl |
|---|---|---|
| 38 Row Houses | plot | the terrace, built |
| 122 Building Fronts | plot | a front that follows the street's line, bent or not |
| 89 Corner Grocery | plot | a shop is drawn to the corner; the corner house becomes one |
| 115 Courtyards Which Live | plot | apartments round a court that opens to the street |
| 106 Positive Outdoor Space | free | a block's middle closed on all sides, built |
| 60 Accessible Green, 67 Common Land | free | a green every few blocks, shared by the backs round it |
| 61 Small Public Squares | free, node | where streets and shops meet, an open paved square |
| 171 Tree Places | path, free | trees where people stop: a junction, a square, a gap |
| 100 Pedestrian Street | path | shops on both sides and slow traffic: wide pavement, no kerb |
| 52 Network of Paths and Cars | path | the woonerf: a street homes share with cars |
| 97 Shielded Parking | free | a car park behind a row, not in front of it |
| 53 Main Gateways | node | where a road enters a district, something marks it |

## Order

1. Parking belongs to streets (`parking.md`, direction of 2026-09-28): the
   biggest change to the picture, and a deletion.
2. The piece system, every rule kind from the start. Built 2026-09-28
   (§Pieces, as built); the kerb bays wait for step 1. Superseded the same
   day by the town grid (§The town grid), which goes into the game with
   step 1 and takes the piece system's place.
3. New fixtures and concepts: a diagonal street, a shopping parade, a
   port, an industrial row.
4. The ladders, as the growth loop arrives.
