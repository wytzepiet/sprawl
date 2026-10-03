# The network: what vehicles touch, built from a few primitives

Status: design, 2026-10-02. Nothing built. Argued from the ferry port of
the same day, which looked wrong and could not work: its yard was drawn
cars in drawn lanes, and the back rows had no way in or out. A road never
fails that way, because a road is not drawn: it is a link, and the
renderer and the simulation both read the same link. This document makes
everything a vehicle touches that kind of thing, so that the cheapest
thing to write is also a thing that looks right and works.

## The rule

Nothing a vehicle drives on, stops at or queues in is drawn by hand. It is
a link or a stop in one network; its look is the renderer's, its
behaviour the simulation's, and a check says whether it works before it
is shown. A facility (a car park, a depot's yard, a ferry port) is a
small template that places links and stops; it never draws.

## The primitives

### Node

A point the network turns at: a tile's middle, as now. Links meet at
nodes; what happens there (a junction, a merge, a bend, an end) follows
from the links that meet, as a junction's shape does today.

### Link

Two nodes, beside or on the diagonal, and its **lanes each way**:

| Lanes | Is |
|---|---|
| 1 and 1 | a street, as today |
| 1 and 0 | a one-way street, as today |
| 2 and 0 | a two-lane one-way road |
| 2 and 2 | a dual road, a median between |
| 4 and 0 | a ferry port's queue |
| 1 and 1, aisle | a car park's aisle |

And its **kind**: street, road, aisle, service, ramp. A kind is a width per
lane, a speed, and what it is painted with (a street white, a road the
map's yellow, an aisle the paving's own colour with bays off it). A link
is as wide as its lanes, so a one-way street is narrower than a two-way
one and a dual road wider, with nothing set by hand.

What lanes give, for nothing more than a number:

- **One-way and multi-lane roads.** One-way exists on the server
  (`RoadNode` keeps outgoing and incoming); lanes generalise it.
- **Merges and splits.** Where four lanes meet one, the four merge; where
  a one-lane link joins a two-lane road going the same way, the road
  takes it in. An on-ramp is a one-lane one-way link into a road's node,
  and its taper is the renderer's. Off-ramps likewise.
- **Roundabouts.** A ring of one-way links.
- **Bridges, later.** A link has a level; links meet only at their own
  level, so an interchange is links at two levels. Not before the rest
  stands.

**Lane wiring is never placed.** At a node, lanes join by rule: straight
on lane to lane, the outside lanes for the turns, merges zipped from the
outside in. A rule the renderer draws and the simulation drives, so the
two cannot disagree.

### Stop

Where a vehicle halts, on a link: a side, a place along it, and a kind.

| Kind | Where | Holds |
|---|---|---|
| kerb bay | along a street, parallel | a car |
| bay | off an aisle, nose in | a car |
| dock | against a building's wall, backed in | a lorry |
| berth | at a quay, stern on | a ship |
| pump | beside a forecourt's lane | a car |

A stop draws its own markings and its vehicle when one is there. It is
`parking.md`'s spot: a node hung off a link, booked by a window. A stop
is reached by its link and nothing else, so whether it can be reached is a
question about the network, which the check answers.

### Area

Ground under the network and the buildings, never drawn: paved where
links, stops and buildings are, as the pavement is today (`look.md`),
its outline the terrain's rounded line. A yard is an area; it is what is
left between the links and stops a template placed.

### Building

As now: tiles and joins, its plan drawn as a road is (`look.md`). New: a
building knows its **faces**, the walls that meet a link or a stop, so a
dock's door, a shop's entrance and a terminal's gate stand where the
network meets the wall.

### Prop

One big thing at a node or a stop: the ferry at its berth, a crane on a
quay, a tank in a tank farm. Big lines only (`look.md`): a prop is a few
boxes, never parts.

## The check

Every network the sandbox shows is checked, and what fails is red:

- **Every stop can be reached from the town's streets and left again**,
  lanes and one-ways obeyed.
- **No one-way link leads nowhere.**
- **A facility has the stops its kind needs** (a depot its docks, a
  supermarket its bays, a ferry port a sailing's queue and a berth).

A template that fails its check is a ghost in red, as a building the
brush cannot place is; nothing that fails is built.

## Facilities as templates

A template reads the tiles painted and what is round them (the street,
the water, the junction) and places links, stops, building tiles and
props. Sketches, to be argued:

- **Car park**: an entry from the street, an aisle loop, bays both sides
  of it. The size is the bays the kind needs.
- **Supermarket**: a car park on its busy side; a service link down its
  quiet side to a dock at the back (as built today by hand, `facts.ts`).
- **Depot**: an aisle across its yard, docks along the hall's wall off
  it, room to turn in the yard's area.
- **Ferry port**: from the street, an entry link to a check-in node;
  from there a queue link of four lanes one way to the ramp node, merging
  onto the ramp; the berth at the ramp, the ferry its prop; an exit link
  of one lane from the ramp back to the street. A sailing's cars fit the
  queue link; more queue back up the entry, onto the town's streets: the
  player's to give a port road enough.
- **Fuel station**: a one-way link through a forecourt, pumps beside it,
  a canopy prop.
- **Container berth**: a quay link along the water, cranes as props over
  it, the stacks an area, a gate link to the street.

## What it costs, and the order

- **Renderer**: `buildRoadGeometry` takes a width per arm and an offset,
  paints lane lines (dashed between lanes one way, solid between ways),
  tapers merges. The rest of a junction's shape is as today.
- **Simulation**: a link with lanes is that many queues; a car keeps its
  lane and changes only at a node, by the wiring rule. Kerb parking and
  stops are `parking.md` step 1 and §5.
- **Order**: the network type and the check in the sandbox; the car park,
  the depot's docks and the supermarket's loading bay re-made as
  templates, deleting their hand-drawn strips in `dressing.ts` (if they
  come out both nicer and correct, the primitives are right); then the
  ferry; then lanes in the game's roads, one-way two-lane first.

## Open

- Nodes off the tile's middle. Four queue lanes in a tile are one link of
  four lanes, not four links; is there anything that needs a node
  between tiles?
- How a template takes the diagonal: a car park on a diagonal street.
- Whether the server keeps a node per tile, or a link per run between
  junctions with its lanes.
