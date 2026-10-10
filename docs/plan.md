# The plan: from here to a game you can play

Status: the brief for the next build, 2026-10-10. Written for a long,
autonomous run, and for whoever picks it up after.

## The game, in a paragraph

Sprawl is a city builder where everything that happens is a vehicle you
can watch. You build a town on an island's coast; the world beyond the sea
sells you what you lack, slowly and dear, and buys what you make, cheaply.
Inside your town nothing has a price: shops fill from the nearest depot,
people eat and work and drive, and a building is built from materials a
lorry brings. Across the border every trade is yours: you order, the
shipping company's ships bring it, your lorries carry it home, and
everything that dispatches itself was once something you did by hand. The
fun is watching it work: the ferry in, the tug towing trailers off, a
lorry backing up to a box, a crane lifting containers onto the stacks, a
road you drew carrying the traffic you meant it to, and the moment the
first lorry with standing orders does the job you used to tap for. Then
other players' towns on other islands, a sea of ships between them, and a
port that grows into a hub.

Read `game.md`, `trade.md`, `shipping.md` and `buildings.md` for the whole
of it; `look.md` and `style.md` for how it looks.

## The mandate

This run has the authority to build the game as it sees best. The
documents are the vision and the reasoning behind it, argued at length and
mostly liked, but they are not law. Where a document's mechanism turns
out wrong in the code, clumsy in play, or simply worse than something you
can see, do the better thing, and change the document to say what you did
and why. No compromise is owed to a sentence because it was written down
first; it is owed to the game.

What is not up for trade is the feel: everything happens as a vehicle you
can watch; nothing on a card you could not see on the map; the player's
decisions are at the border and on the map, never in a menu of sliders;
automation is earned and seen. And `CLAUDE.md`'s way of working is the
player's own taste: delete rather than wrap, every line fights for its
existence, smaller and clearer.

Tools are welcome. If a system would make the game easier to see, to test,
to understand from a cloud container (the flat view of `canvas.md`, a
shipment's story, a scenario runner, better inspection), build it. Tests
that assert old design are rewritten, not obeyed.

## Where things stand

- Milestone 0 is done (`roadmap.md`): no prices inside a town, the nearest
  seller with stock, people stay in their town, coins only at the border,
  the level as GDP.
- The ferry harbour is the only door (`shipping.md` §Built): a ferry on a
  timetable, a tug, a trailer park, boxes hauled by depots' lorries, the
  starter pack, top-up rules, exports paid as the ferry sails. The edge,
  the generated roads, the fog and the port's world ship are gone.
- Goods are split from needs: crates, fuel, timber. Buildings cost timber,
  not coins, and stand as sites until a van has brought it.
- The skill tree is switched off: everything unlocked, its screen gone.
- The terrain is islands in one ocean, a fifth of the map land.
- The client renders with Babylon Lite on WebGPU only, and a cloud
  container can run it: headless Chromium draws WebGPU in software
  (SwiftShader), so `look` and `shots` photograph the real game
  (`canvas.md`).

## The work

The order is a suggestion; dependencies are real. Each piece is playable
on its own, and is done when it is tested, seen (in the flat view's
pictures, at least), and its documents say what was built.

1. **The flat view** (`canvas.md`): the game drawn on a 2D canvas from the
   same state, a script that photographs it headless, and the minimap.
   Set aside for now: the cloud sees the real game (see above), which was
   its first reason; the minimap and the far zoom remain its case.
2. **Terrain** (`game.md` §The island and the door): mostly sea, several
   islands, one connected ocean, a coast with room for a harbour and a
   starting town on each; checked on twenty seeds.
3. **The tree off** (`game.md` §The build): everything unlocked, its
   screen hidden, the level still counted.
4. **The ferry harbour as the only door** (`shipping.md` §Harbours): the
   edge, the generated roads and the fog go; the ferry on a timetable, its
   deck as what fits; settlers drive off; the tug; the trailer park; the
   town's lorries hitch boxes; empties ride back, filled with exports.
5. **Drafts** (`game.md` §Drafts): placing and demolishing as drafts,
   reserved, drawn blue and red, with the bill; commit, undo, discard.
6. **Goods and materials** (`buildings.md`): goods split from needs; the
   general depot; sites that wait for their materials and go up as lorries
   bring them; building costs as rows, timber first; the first depot's
   top-up rule; the stalled site that offers its fix; roads drawing
   materials from stock once there are any. *Built 2026-10-10:* costs are
   rows (`Blueprint::materials`), stone the second material; a site waits
   for every row and its card offers the fix; roads draw stone from the
   nearest depots, the rest express from the world (`trade.md` §Building
   materials). Left: demolition giving back, and asphalt.
7. **The world as a trader** (`trade.md`): ordering by hand at the harbour,
   top-up rules on depots booking the ferry, the pending shipments as a
   list and pins, the coins landing as the boxes do.
8. **The starter pack and the tapped lorry**: the opening's four beats from
   nothing (`game.md` §The opening), and standing orders for the lorry.
9. **Chains** (`buildings.md`): sawmill and quarry built; mine, cement works,
   steelworks, refinery, the specialist depots; the office and the
   factory go once the chains give the town its work.
10. **The container port and the network** (`shipping.md`): the Exchange,
    container ships, lines between harbours, the planner with transfers,
    hubs and dues, charters for tankers and bulkers; ships routed over the
    sea with lanes and blocks. Planned in stages in `plan-sea.md`, which
    cuts the Exchange, charters and dues from this item and says why.
11. **The new tree**, designed from the roster, with a look of its own.

Further than that is `roadmap.md`: roads that are roads, other players,
power, services, the advisor.

## How it is checked

- `cd server && cargo test && cargo check`, `cargo test town -- --ignored`,
  `cargo test season -- --ignored`, `cargo test every_seed -- --ignored`,
  and `cd client && bunx tsc --noEmit -p .`, as `CLAUDE.md` says. Change
  them as the design changes; never skip them.
- The season test asserts the town keeps its shelves stocked and its
  people fed. It should grow with the game: a town built from the opening,
  supplied by sea, building with materials, running for a month.
- Pictures from the flat view for everything seen, kept with the work, so
  the player can look at what was built without a desktop.
- The client's one known type error (`copySource` in `Canvas.tsx`, an
  option the pushed Lite fork lacks) is the fork's to fix; leave it or fix
  it in the fork.

## What to report

At the end, and at any natural stop: what was built, what was decided
along the way and why, what surprised you, what you would do next, and
what the player should look at first. Commit in small steps that each
leave the game working, with the reason in the message.
