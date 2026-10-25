# The first half hour

Plan, 2026-10-25, to put `plan-goods.md` §The rule of thumb and §The
opening into the game: problems that come to the player, the fix that
unlocks the next thing, and a first sale within a few minutes. For
Wytze to react to; nothing here is built. It sits on the goods work
(pads, packages, the pallet ferry) and changes `missions.md` where they
meet.

## Pacing, as numbers first

The opening is judged by a clock, not by feel alone, so it gets a test
before it changes, the way the season test keeps the town.

`cargo test first_half_hour` plays the opening with the hand's best
moves and asserts the beats, in real minutes of play (a day is twenty):

| Beat | By |
|---|---|
| The first road drawn | 0:30 |
| Goods on the producer's pad | 1:00 |
| The first coins land | 3:00 |
| The first problem the player did not ask for | 5:00 |
| A new kind of building asked for | every 3 to 5 minutes after |
| The first jam | about 15:00 |

It prints each beat's time, so a change to the ferry, a building or a
mission shows what it did to the start. Today's opening, measured the
same way, is the baseline.

**The baseline, 2026-10-25** (`cargo test first_half_hour -- --ignored
--nocapture`, on the test street, whose harbour and street stand already):

| | Today |
|---|---|
| Depot placed and joined | 0:10 |
| Goods on the quay | 0:25 |
| Goods in the depot, houses placed | 1:32 |
| First coins: the opening's reward, settlers home | 3:11 |
| The market: a box bought | 3:21 |
| First letter | 5:58 |
| First coins earned by a sale | 9:47 |
| Anything after that | nothing, to 30:00 |

The first three minutes are close to the beats; the first sale is at
ten, and from then on nothing arrives: no situation opens in the half
hour, since the starter pack keeps every shelf stocked.

## The opening, cut

What the start asks today: build a harbour, build a depot, join them,
fetch the starter pack, build houses, then buy and sell at the market
(`missions.rs` `ROWS`). Five steps of plumbing before anything is made.

The new one:

1. **Place the harbour.** The player chooses where on the coast, and so
   where the town begins: ownership, and no bad luck from a seat the game
   picked. Its hand must say plainly where it fits and why not (the
   2026-10-10 playtest stalled here), and the camera opens on the coast.
2. **Pick a starter**: a sawmill, a farm or a quarry, each where the
   island offers it near the harbour. The dots show where.
3. **Draw the road** from it to the harbour's quay. Its packages start
   piling on its pad.
4. **The first load, sent once.** Packages pile on the pad and the
   town's truck pulses; one tap sends it. It drives your road, the
   packages wait on the quay, and they are paid for as the ferry casts off
   at the world's price: the first coins. From then on the truck runs by
   itself, and says so on its card.

**Automation is earned by outgrowing it, not by stopping tapping.** One
truck cannot keep up for long: the pad fills, its pin's ring fills, and
the fix is a second truck, then a depot nearer the coast, then bulk or
boxes. Who supplies whom stays automatic, the nearest by road (Wytze,
2026-10-25): traffic cannot be told where to go, so the player designs
roads round where it goes. Hand-drawn links between buildings were
weighed and left out.

Goes from the opening: the depot step (the quay is a pad and holds what
lands), the starter pack as a gift (the starter building is the gift),
and the market missions, which open later, when there is something to
trade.

## Problems that come

The situation missions already work this way (`When::Short`, `When::Dry`
in `missions.rs`, sensed on events, never on a scan). Each new problem is
one more `When`, sensed where the server already finds it:

| The problem | Sensed where | The fix it asks for | What the fix brings |
|---|---|---|---|
| The producer wants workers | its jobs unfilled | houses, a road to them | commuters on the haul road |
| The pad is full and you are still tapping | a pad at capacity, the truck idle | a depot and its own lorry | the first lorry that runs on its own |
| Residents are hungry | a meal not found | a farm and a shop | crates, a second chain |
| Cars run dry | already sensed | a gas station | drums to deliver |
| A site waits on timber or stone | already sensed | a sawmill or a quarry | the next chain |
| A junction jams | a vehicle stopped there over a minute | redraw it, on that tile | the road puzzle |
| A letter asks for more than you make | already written (`orders.rs`) | a second producer, a bigger yard | more trips |

The jam is the one that makes this our game: the server already knows a
car that stands for good (`Watch`, in replays). A mission that says
"lorries wait at this junction", with the tile and a follow, turns
traffic into a problem that arrives on its own.

## Shortages are pins

Every shortage speaks the same way (Wytze, 2026-10-25), in two places:

- **Where it bites, a pin with a ring that fills.** Whatever lacks
  something grows a pin with the icon of what it lacks: a worker over a
  sawmill short of hands, a crate over an empty shop, a drum over a dry
  gas station, a bundle over a waiting site, a factory short of its
  input, a car with an empty tank. The ring round it fills while the
  lack lasts, so it starts as a hint and ends urgent, and how full it is
  says how long it has waited. A tap opens the card with its fix. A car
  pins only once it is stranded, not every time it runs low, or the map
  fills with them.
- **In one place, a few meters along the top**: workers (jobs against
  residents, so many short or spare), and a bar for each good the town
  uses up, in hours of stock left. Only goods the town consumes get one,
  so early on there are two or three.

The pin says where, the meter how much, and a mission speaks only when a
ring fills. This replaces the map's other warnings (`game.md`
§Legibility) with one language. Houses stay the player's to place: the
sawmill's worker pin and the workers meter make the shortage plain;
streets the town fills with houses by itself can come later, if placing
them feels like bookkeeping.

## What to decide

- **Pressure that grows by itself** (letters and demand rising over
  time) or only when the player builds. `plan-goods.md` leans to the
  first, gently.
- **The ferry's rhythm in the first half hour.** Coins land as it casts
  off, so its timetable is the opening's heartbeat; the first sailings
  may need to come more often than later ones.

## The order to build it

1. `first_half_hour`, on today's opening, as the baseline.
2. The harbour's placing made plain, and the starter pick.
3. The quay as a pad and the first load sent, on the goods work.
4. The new problems, one `When` at a time, each with a test that it
   opens once at the right moment (`a_site_short_of_stone_asks_for_a_quarry_once`
   is the pattern).
5. Play it, read the beats, tune the ferry and the producers.
