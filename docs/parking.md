# Parking: drives, yards and kerb bays

Status: built, as `server/map/src/lots.rs` says at its top. A house
parks on its drive, a depot, a farm or a harbour keeps a yard, and
everything else parks at the kerb before it. Not built: car parks where
the kerb runs out (§8). The specification this grew from, of 2026-09-06
(the ring lot, lots fusing along a frontage and spilling past their
building, the aisle car park, the test lot, the build order), last stood
whole at `53a9ca6`. Follows `residents.md` (how a trip is chosen);
`game.md` §People says parked cars sit in the building's spots, and this
is how.

## 1. The idea

1. **A lot is road.** Its nodes have positions of their own, off the
   grid, joined by edges cars drive like any other, hung off the street
   node the building's door opens onto (`Building::door`). The queues,
   the following and the giving way of the street work in the lot.
2. **A spot is a node.** A trip ends in a spot and starts from one; the
   server knows who stands where because that is where the trip ended,
   and the client draws trips and never invents a spot. Nothing about a
   lot is streamed: a parked car carries its pose, a moving one its route.
3. **Reverse is a gear on a stretch of the route** (§6).
4. **A reservation is a window on a spot** (§5).

A car that finds no place stops at the door, unseen.

## 2. The drive

A house parks its two cars on its drive, side by side: a car drives in
nose first from the street and backs out onto it. The drive is the
lot's, not a road: from the door's street node to the house's tile,
drawn as road and gone with it (`SPOT_OUT`, `LANE`, and `DRIVE_OUT`,
`DRIVE_LANE` in the client's `dressing.ts`). The driveway as a kind of
road went 2026-10-04.

## 3. Docks

A maker's front has its docks notched into the wall at its gate
(`dock_bays`): a box truck goes on past its dock along the street,
stops, and backs into it in one curve, its tail to the loading door and
its nose on the pavement; it pulls out forward, either way along the
street. One lorry moves at a front at a time: one turning in or pulling
out holds the front's door (`World::stretch`). With every dock taken,
the lorry's trip waits and tries again.

## 4. Kerb bays

Everything else parks at the kerb before it (`kerb_bays`), on streets,
not through roads. Flats park along the kerb (`KERB`, `ALONG_PITCH`);
everything else nose in, square to the street, its tail at the road's
edge (`SQUARE`, `SQUARE_PITCH`: a car and a door's swing), both within
the building's walls (`WALL_INSET`). A building takes as many bays as its
long side holds: on its door's side first, then on the sides with a
street all along them, the fullest first. So it is placed only where a
street runs all along one of its sides (`World::fit`: "No street along a
whole side, for its parking"). A bay is the building's it fronts, so bays
share out with no rule; the client paves the same (`town/surface.ts`).

A car turns into a square bay nose first, from the lane beside it or
from across the road, in one curve, and backs out onto either lane in
another; its booking says which way it came and which it leaves by
(`Window::side`, `Window::exit`). Staff park in
bays too, and what the bays do not hold stops at the door. A visitor's
tap at a kind without vehicles seats seven at once (`blueprint::seats`).

## 5. Reservations

A spot holds windows, `(from, to, car)`, sorted. A trip books one when
it starts, from its free-flow ETA, the earliest it could be there, to
the visit's planned leave and `SLACK`: a spot clear for the whole
window, near the door but loosely, each free spot's distance stretched
by a draw per visit, so a building's cars bunch in front of it without
filling like a queue. A car standing in a spot holds it until it goes,
and a resident who stays restates `to` (`restate`). A spot found still
taken on arrival is squeezed to the door, and counted. `/debug/lot/{id}`
reads any lot, its windows and its counts (`refused`, `squeezed`). No
window survives a save; every resident re-plans on load. The berth of a
harbour is queued for the same way (`shipping.md`).

## 6. Changes of gear

A trip carries the stretches of its route driven backwards
(`Trip::backing`), and where each change of gear falls (`Trip::cusps`):
a vehicle stops on the node where its gear changes, stands `CUSP_MS`,
and pulls away the other way, and a trip ends with a stop on its last
node, not an arrival at speed. Backing is a walking pace
(`REVERSE_SPEED`).

Every leg between the street and a place to stand is one curve, a cubic
Bézier from pose to pose (`model::Manoeuvre`), the same for every place
of a kind and never searched for, so every place has every way. The
client pins each vehicle to its way (`driver.ts`): its middle on it,
pointing along it, nothing steered. Until 2026-11-06 the server planned
each manoeuvre as a driver's moves, kept clear of what stood round it,
and the client steered a lead axle along the route; that made realistic
turns and a steady trickle of loops, slides and places with no way in.

## 7. Giving way at a lot

**A driveway is a junction** (`car/driveway.rs`), with the same
controller as any other (`IntersectionManager`), known by the street
node beside the place (`Map::driveway`), and it splits no route: each
car says its way through it as a track, as it does at a junction. One
turning in says its way from the street node it turns off after to
where it will stand; one pulling out, from where it stands to the street
node it joins at; and while anyone turns there, everyone driving by
says theirs, along its lane from half a tile before the node to the
next. The street has priority: one pulling out is a side road and waits
for a gap where it stands, and after `EXIT_PATIENCE` (twelve seconds)
takes its turn as anyone does; one turning in goes in the order it
comes. Whoever is held up stops just short of where its way first
meets the way of the one it waits for (`IntersectionRegistry::held_at`),
not at a line. When one first comes to turn there, the driveway lets
nobody through for a second (`WARM`) while whoever is coming by is
woken to say when they will be there. A car pulling out joins the
street's queues once it may go, ahead of whoever is still coming
(`join_run`). Out and back in at one driveway is one way through it.
A driveway is never one with the junction beside it: a car waits at it
for its own gap, not for the next junction to let it through.

## 8. Where the kerb runs out

Direction, 2026-09-28, not built. **Car parks and garages are placed
buildings**: a surface car park, later a multi-storey, for the flats
that outrun their kerb and the shop whose visitors do. Laid as aisles,
not a ring (a ring one tile deep turns at 0.2, and a car turns no
tighter than 0.45): one-way aisles with bays at 60° both sides, in at
one end and out at the other, about seven cars a tile; drawn at the
game's scale in `sketches/car-park*` at `53a9ca6`. With it, a trip ends
at the nearest free spot within reach of the door, the rest of the way
time on the trip; a full kerb makes cars cruise, and the answer is a car
park round the corner. Open: how far "within reach" is, whether a
resident prefers the bay by their own door, and how cruising picks the
next street.

## 9. Gridlock between drives

**Found 2026-09-10, curbed 2026-09-11.** With the offices' cars on the
street the season town's one street locked up on its third day and
stayed locked. Two driveway junctions two tiles apart each held a car
whose tail was still in the box because the car ahead stood at the other
junction's stop line, a tile on; one waited to turn across the first
box, the other was queued behind a car pulling out of a lot that
conflicted with the second box's holder. Every car in a box had entered
it without room to leave.

What curbs it is what a driver does: **a claim held by a car that is
not moving lapses after ten seconds** (`intersection::PATIENCE`), at the
line or with its tail in the box, and the car queues again at the back;
a car that has lost passage at a junction holds nothing beyond it, and a
car that has left one holds nothing there. No claim can then outlive
whatever is blocking it, so no cycle of claims can hold. The cost is
honesty for a second at a time: a car turns through a box where
another's tail still stands. The gauge is lapses, printed by `season`;
a climb in it is the street model asking for the rest.

The rest is the box junction, no entry without a clear exit. As a
grant-time check of room on the road beyond, it cleared the cycle above,
but it needs the edge queues in physical order, and a re-planned trip, a
car pulling out into a lane and the order cars happen to wake all put a
car behind one that registered later, which the reservation turns into
a new deadlock. So: queues ordered by position first, then the box rule.
Of that, giving way at driveways and joining a queue where a car
stands are built (§7).

**Found 2026-10-28:** two cars coming out of lots at one street node
stand level in the street's queues, both at the node, and level measured
along each one's own route came out whichever way the rounding fell, a
different way on each edge. A van out of the depot's yard and a car
pulling out at its gate each stood ahead of the other on the next two
edges and waited for each other for good, and the season's street locked
behind them on its twenty-sixth day. Level at one node, the one with fewer
of its lot's nodes still to pass stands ahead, then the nearer the next,
then the earlier id (`behind`): not the distance to the street, which
each route measures its own way, so a lorry a node back in the yard
came out nearer than a car at its gate (day thirteen, the same day).
