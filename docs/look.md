# The look: a town that knows what it is next to

Status: direction, 2026-09-28. Built: the palette, the pen, the fixture
sheet, and the piece system, proven on houses, streets, junctions and
open ground (§Pieces, as built). The concepts it was argued from are the pattern
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
   one gets a fixture before it gets a rule.
2. **Concepts**: several deliberately different drawings per situation,
   into the pattern book, with image models (`OPENROUTER_API_KEY`) for
   ideas when there are none, asked for game zoom and top-down.
3. **Verdicts** are the mayor's. Nothing goes into the game unkept.
4. **Pieces**: a kept drawing becomes a piece and a rule; `bun run shots`
   shows it in the game beside the drawing it came from.

## Order

1. Parking belongs to streets (`parking.md`, direction of 2026-09-28): the
   biggest change to the picture, and a deletion.
2. The piece system, every rule kind from the start. Built 2026-09-28
   (§Pieces, as built); the kerb bays wait for step 1.
3. New fixtures and concepts: a diagonal street, a shopping parade, a
   port, an industrial row.
4. The ladders, as the growth loop arrives.
