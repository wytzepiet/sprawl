# Goods you can see, and what the game is

Direction, 2026-10-24, from an evening's talk with Wytze about why the
start feels slow and what the game is for. Goods you can see, pads and
handling and the ferry's pallets are built (§Built, at the end); the
rest is direction. Where it meets `game.md`, `shipping.md` and
`trade.md`, this is the newer word.

## What the game is

**An industry tycoon whose puzzle is the roads.** The roads came first:
the game began from Mini Motorways, and drawing them is still the main
thing a player does. Industry is the reason the cars are there and the
fantasy that keeps a player building: chains that are believable and
orderly, a next building always in reach. The town is the workforce and
the life on screen. The market is a lever for later, not the start.

Mini Motorways is where the road-drawing comes from, not the target.
Persistent servers, chains, trade and other players make this a game of
its own: closer to Mini Motorways meeting Transport Tycoon.

**Not islands only.** Islands stay, but a world may also have larger
land where towns are joined by road. The harbour is a door, not the only
one.

## The rule of thumb

**Don't ask the player for initiative. Problems arise, the player fixes
them, the fix unlocks something new, and the new thing makes the next
problem.** Pressure comes to the player; a game that waits for the player
to want something is a game that stalls.

A mechanic earns its place by making a better road problem or a
believable chain to build; not strictly, but those come first.

## The opening, sketched

Not agreed in detail; the shape is.

1. A buyer is already on the map (a harbour, or on land a road to a
   neighbouring town) and a starter producer stands or is placed: a
   sawmill, a farm or a quarry.
2. The first act is a road between them. Goods pile up at the producer,
   a lorry carries them, and coins land within a couple of minutes.
3. The producer wants workers: houses ask for a road. The commute and
   the lorries share a junction, and the first jam is the first real
   puzzle.
4. Residents want food or fuel: the next chain is offered, with new
   trips across the roads already drawn.

The manual phase is a truck the player directs by tapping (the goods,
then where they go), driving on the player's own roads, so a bad
junction is felt while hauling. There is no avatar to steer. The first
lorry that runs on its own is the moment the player stops tapping.

Persistent shared servers mean a newcomer may arrive at night. Night is
made readable and short, not avoided.

## The camera

**One camera, no switch.** Wytze leans toward the tilted view, a little
from the side (`OrthoCamera.tsx`, `TILT`, 25° today): it shows height,
which the goods, mountains, overpasses and container stacks need, and
night feels cosier in it; shadows alone proved a poor cue for height. It
is being tried in play (F8) before the flat camera is deleted. The view
never turns, so things need to look right from the front and sides only.

If the tilt stays: mountains and coast cliffs become real meshes with
walls, the cliff texture on them, instead of flat planes with cliffs
painted on; faces turned from the camera are drawn short so they hide
little. Loading and culling follow the tilted view's real footprint.

## Goods you can see

**Every good is an item you can recognise, and one item is one unit you
trade.** Timber is a bundle of logs, crates a crate, stone a pallet of
blocks, steel a stack of beams, grain and gravel a big bag (a tonne
sack, open at the top so its contents show), fuel drums on a pallet.

- **An item's height is fixed.** A bundle is always three logs high, so
  how much there is is how many stand on the ground, which reads from
  any camera. More room is a bigger yard, never a taller pile.
- **The package is the unit wherever goods move or are traded**:
  lorries, ships, depots, the market and its prices count bundles, bags
  and drums, in whole numbers.
- **A package is opened only where it is used.** A gas station takes
  drums and fills its own tank from them; a car takes a tenth of a drum
  from the tank and never touches one. A shop opens a crate. A site uses
  its bundles whole. Fractions live inside buildings, as shelves do
  today (`Stock { level, cap }`).
- **Packaging vanishes when used.** No one returns an empty drum or
  bag. What carries goods (vehicles, containers) is real and comes back.

A sketch of a yard of each, in Three.js rather than the game's renderer,
with the tilt on a slider: https://claude.ai/artifact/NQH6ps2HhDuufEx8pEpS6t.

## Pads and handling

**Every place goods sit is a pad of slots you can see**: the quay, a
producer's output, a depot's yard, a shop's back yard, a gas station.
**Every move between a pad and a vehicle takes time per package.** That
handling time is the one new thing the server simulates; the forklifts
and cranes doing it are the client's animation of it, never vehicles
the sim routes.

- A full pad is seen: a sawmill buried in bundles is a chain nobody
  collects from.
- A lorry carries a few packages. Handling time makes queues at busy
  pads, and the queue is the problem the upgrades below solve.
- Open: is one forklift a pad the building's capacity, so a second
  lorry waits its turn and a second forklift is an upgrade? Leaning yes.

## Depots

**Open yards, no roof.** Every good sits outside where it can be seen;
it is a game. A depot is where the town's two networks meet (below).

## Packed, then bulk or boxed

Everything starts packed: one kind of lorry carries all of it, one
forklift handles all of it, which is fewer rules than today's three
vehicle classes from the first minute. It is how small islands are
really supplied: cement and feed in bags and big bags, fuel in drums.

Packed always works, everywhere. What follows is only ever faster:

- **Containers** for anything packed: a box holds ten packages of one
  good, only ever full. Stuffing and stripping it is handling, once, at
  each end; every move between is one lift. Containers are anonymous,
  as real ones are: ordinary closed boxes, each painted in its good's
  colour as the ferry's boxes are today.
- **Bulk terminals** for the one or two goods a town is big in: a tank
  farm and tankers, a silo and tippers, later the town's own berth for a
  tanker or a bulker. A good in bulk is a heap or a tank's level, its
  unit still a drum's or a bag's worth, so the market does not change.

So goods are seen early, anonymous in the middle, and seen again at the
end, bigger: a log ship piled with logs, a tanker low in the water. The
empire is the goods you can see from across the map.

## The harbour

**The ferry carries pallets on its deck**, not towed trailers. A
forklift unloads them onto the quay's pad, and the town's lorries load
there like anywhere else: no trailers, no empties, no hitching. This
replaces the tug and the trailer park (`shipping.md` §The ferry harbour).

The harbour's ladder: a forklift off the deck, a quay crane, a ro-ro
ramp where whole trailers roll off, the container terminal, then a berth
for a tanker or a bulker.

## Containers, start to end

1. The ship berths at the terminal; a crane lifts the box ashore.
2. It waits in the terminal's yard, a pad, until a lorry comes; a full
   yard asks for more lorries or a better road.
3. A lorry with a skeletal chassis takes it to a depot.
4. At the depot's dock a forklift strips it on the chassis, packages
   into the yard, and may stuff it with exports.
5. It goes back to the terminal's yard, full or empty, for the next ship.

Only depots open containers; a depot beside a factory does what a
factory's own dock would. Later, perhaps: dropping the chassis instead
of waiting, and side-loaders (a trailer that lifts its own box) for a
town without a crane.

**Two networks follow**: the trunk, boxes between the terminal and the
depots on roads, later by train; and the local, packages from depots to
shops, stations, sites and small producers on streets. Where a depot
stands decides where the heavy traffic ends.

## Open

- The camera, after a few days of play in the tilt.
- One forklift a pad as a building's capacity.
- How pressure grows: letters and demand rising by themselves (leaning)
  or only when the player expands.
- Each building's problem: what makes it needed and what it makes
  needed in turn, written as a table over the roster, before building
  out more kinds.

## Built

2026-10-25, in three steps, and what was decided on the way.

1. **The server's model.** A package is the unit everything is carried,
   counted and traded in (`Good::per_package`): a crate of food is 25
   units, a pallet of drums 10, a bundle of timber 4, a pallet of stone
   4. A lorry carries five on a flatbed that never comes off
   (`haul::LOAD`), a van three. A depot's, a maker's and a buyer's pad
   is its stock, delivered in whole packages and opened only where it is
   used; the quay's is the packages standing on it (`Building::pad`, 48).
   A lift is `HANDLE_MS` a package (`world/pads.rs`), and a vehicle
   stands until its forklift is done (`Car::due`). The market's depth is
   200 packages, and its prices, the letters and the deals count
   packages.
2. **The items.** Each good is an item of fixed height
   (`engine/objects/goods.ts`): three logs high strapped, an open crate
   of greens, two layers of blocks on a pallet, four red drums on a
   pallet. They stand on pads laid out from the building's own tiles
   (`pads.ts`): a depot's four bays in the open, where its hall stood
   (no roof, no canopies); a maker's down the free side of its lane,
   crates four high; a shop's, a gas station's and a site's along the
   front. A lorry's and a van's packages are on their flatbeds. A
   building's forklifts are drawn from its `lifts`: in to a package,
   across, set down, back.
3. **The ferry.** Its deck carries sixty pallets, four to a bay, and
   settlers' cars in the bays with none. The harbour's three forklifts
   lift what came for the town onto the quay's pad, beside the lane on
   the side its docks are not, and what goes out back onto the deck,
   only what is aboard before it sails. The tug, its trailers and the
   trailer park are gone.

Decided on the way, open to change:

- **One forklift a building, the harbour's three** (`Blueprint::forklifts`):
  a second lorry waits its turn. More forklifts are the upgrade.
- **The server changes its counts as a run starts**, and the client
  shows them moving one by one over the run (`progress` in `pads.ts`);
  so a panel reads a package as arrived a little before the forklift
  sets it down.
- **The server says how many a run lifts, not which deck places**; the
  client takes them from the land end's emptied places and the sea
  end's filled ones, as `work_deck` does (`deckSeen` in `motion.ts`).
- **A shop's or a site's forklift comes out only for a lift**; a yard's
  stands in it.
- **The road's stone is opened at the depot**, the one place a road
  draws on.

