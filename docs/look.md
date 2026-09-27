# The look: a town that knows what it is next to

Status: direction, 2026-09-28. Nothing built beyond the palette, the pen
and the fixture sheet. The concepts it was argued from are the pattern
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

The rules are of three kinds:

| Rule | Matched on | For |
|---|---|---|
| **Plot** | the tile grid round a plot | terraces, block middles, quays, corners |
| **Path** | a road's drawn line, at any angle or curve | kerb bays, lamps, street trees, pavements |
| **Node** | a junction | chamfered corners, roundabout islands, verges, crossings |

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
2. The piece system, all three rule kinds from the start, proven on one of
   each: a terrace fronting kerb bays (plot), bays and lamps along a
   street (path), a chamfered corner (node).
3. New fixtures and concepts: a diagonal street, a shopping parade, a
   port, an industrial row.
4. The ladders, as the growth loop arrives.
