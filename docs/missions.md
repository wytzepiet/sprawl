# Missions

Status: built 2026-10-10 for the opening, the trunk and the town's
situation (`server/src/missions.rs`, `client/src/ui/Feed.tsx`);
orders from the towns beyond the edge built 2026-10-12
(`server/src/orders.rs`, §Orders). Dailies are designed here, not built.

## What a mission is

A mission is a few **steps** and a **reward**. A step is a fact about the
town that the server reads off the world (a harbour stands, a depot's
street is joined to it, something is on a depot's shelf, settlers are
in), a line that says what it asks, a paragraph or two on how, and,
where one helps, a button that does it: the site card's pattern, what
is short and the tap that fixes it. When the last step is done the
mission is finished and pays its reward: coins now, landing at the
harbour like trade and dripping into the purse; XP once the level means
something (`Reward` is an enum for that).

There is one shape for every source of missions, and one panel. The
server decides everything: when a mission opens, when a step is done,
when it pays. The client only shows what it is sent. A guide that
decided its own beats from what one browser tab had seen is what the
playtest of 2026-10-10 found stuck at "4 of 5" over a street of lived-in
houses; that bug class is gone because nothing on the client can tick a
step.

A step, once done, stays done: the opening's harbour step does not
untick if the harbour is pulled down. Steps are read in any order, so a
depot drawn on the harbour's street ticks the depot and the street
together.

## Sources

1. **The trunk.** The opening, opened with the town: a harbour, a depot,
   a street between them, a sawmill (the town's first stands at once,
   a lorry's load in its yard), a bundle of its timber sold, the starter
   pack fetched, houses for its hands and their settlers
   (`plan-opening.md`). Then the market: a pallet of fuel bought.
2. **Kinds.** Each building kind may carry a mission that teaches it.
   Nothing is locked (`game.md` §The build), so it opens from source 3:
   the mission that asks for a quarry is the quarry's teaching mission.
3. **The town's situation**, the best teacher. A mission opens when
   something first matters, not merely when it is possible, and only
   after the opening: a site or a shop calls for a good no depot in town
   has any of (stone asks for a quarry, timber for a sawmill, crates for
   a farm); a car is low on fuel with nowhere in town to fill it (a gas
   station). Each opens once, and not at all if the town already has
   what it asks for.
4. **Orders from the towns beyond the edge**: a letter from a mayor,
   by ferry, asking for boxes of a good. It is a `Mission` made by the
   letter, not a row: its key `Key::Order(id)`, one step
   `Goal::Delivered { good, units, sailed }`, its words written when the
   letter is, its mayor in `from`, its day in `due`, and its reward
   `Reward::Order { coins, standing }`. §Orders.
5. **Dailies** (later): see below.

## Orders

Four mayors write, each a person with a town beyond one edge of the map,
the goods they want, a price over the world's, and a voice: Old Tam of
Saltmere (west, fishing: a box of crates or fuel, the first to trust
you), Mira of Northgate (north, mining: timber for pit props, curt),
Bess of Fernhollow (south, farming: stone and timber for barns,
cheerful), and Lord Aldra of Port Aldra (east, a big city: four boxes
at a time, the best price, and silent until the town stands well, at
3, with someone else). The table is `WHO` in `orders.rs`.

**A letter comes by ferry.** As a ferry berths (`orders::post`), what is
overdue lapses, and a letter may come: after the opening, at most three
open, one a third of a day at most, a mayor with an order open not
writing another. Each is a line of news pinned to the harbour. It
reads as the mayor: "Mira, mayor of Northgate: We're short of timber
before winter. Can you send 2 boxes?", the boxes, the coins, the day
it is wanted by (two of the town's days on), and "Northgate · north,
beyond the sea".

**What they ask.** Only what the town can send (`orders::sourceable`):
a good a maker in town makes and the depots hold two boxes of. Every
third letter reaches one
step further, for a good a kind of building the town has not built
would make (crates for a farm, stone for a quarry): the tutorial after
the tutorial, a nudge and never a path. A town that makes nothing
gets only those, so the first letter after the opening is Tam's, for
the crates a farm would make. Nothing else: no letter beats one that
must lapse. Fuel has no maker, so nobody asks for it. The world sells everything, dearly, so nothing asked is
impossible.

**Filled physically.** While an order wants more, its mayor is a
partner for a slot going out, at the letter's price: the letter is a
card in the feed, the boxes it wants, and a tap on its envelope
books them all. The box carries
the order's number as its shipment's, is loaded by a depot's lorry,
waits on the quay, shows its town's crest there, and sails with the
ferry to the edge. As the ferry casts off, the mayor pays for it, a
lump of coins at the harbour as any export lands (`orders::sailed`); the
last box ticks the step, and standing rises.

Why the ferry, and not a ship toward each town: every harbour's line
already sails to the map's edge, and the world beyond it is where the
towns are. A box for Northgate leaves the map exactly as a box for the
world does, so nothing new is built or drawn, and the card says so:
"sails with the ferry to the edge". Direction is the town's character
and its pin, not a route; a ship toward the north edge is a line the
shipping company might run later, and orders would ride it unchanged.

**Paid a box at a time**, at the mayor's price: units × the world's
price × the mayor's price level (Tam 1.25, Mira and Bess 1.5, Aldra 2)
× (1 + a tenth a point of standing), against the world's 0.9. So a box
is never lost to an order given up on; what sailed was paid for.

**Standing** is read off the orders, never kept: where the mayor
started (Tam 1, the others 0), a point for each filled, half one off
for each that lapsed, between 0 and 5. It buys bigger letters (half a
box more a point), better prices, and a warmer voice from 2. An order
lapses when a ferry berths after its day: the mayor gives up (news),
standing falls, and boxes still marked for it sail for the world.

**Faces.** A mayor carries a plain description (`looks`), and one
function draws them (`client/src/flat/crest.ts`): for now the town's
crest, its initials on a disc of its colour, on the panel, on the pin
at the edge of the minimap and the flat view in its direction, and on
a package on the quay marked for it. A portrait replaces it there
(`shelved.md` §Faces).

The panel shows the town's own missions first, then the orders by
mayor: crest, name, town and direction, standing as pips, and each
order with its boxes, coins and, at hand, the letter, how many have
gone, when it is wanted, and the button. Tests: the `orders_` and
`port_aldra_` tests and `an_order_filled_pays_coins_and_standing_once`
in `game_loop`; the season fills them by hand at each midnight
(§Checking).

## Dailies

Drawn at midnight from templates, the same rows as the situation
missions but with a `When::Daily` and goals that can be done again
("sell two boxes of timber", "fetch every package on the quay before the
ferry sails"). Rules:

- At most three wait at once; a midnight with three waiting draws none.
- No streaks and no penalty for leaving one: a daily not done is simply
  still there, or replaced by a fresh draw once it is a few days old.
- A daily asks only for what the town can already do: its goals are
  checked against the kinds standing before it is drawn, as a situation
  mission is checked against what is already done.
- The reward is the same shape as any mission's.

A daily's key carries the day it was drawn, so "opens once" still holds.

## How it runs

`World::missions` holds the list, open and finished; it is saved, a row
each in the `missions` table, and comes back as it was after a restart.
Every state update carries the open missions and those finished in the
last three hours of the town's day, so the panel can tick the last step
and show the reward.

Nothing is read per tick. `missions::check` reads every open mission's
steps only when something happened that could have done one: a build
settled, a command from a player, a settler's first trip off the ferry
(all `Missions::stir`), or a box unloaded or coins in, which are lumps
and need no hook. A situation is sensed where the server already finds
it: a call `calls::dispatch` could not answer, and a resident's verdict
on their tank in `resident.rs`. `sense` costs a look down the rows until
its mission has opened.

## Adding one

- **A mission whose goals and trigger exist:** one row in `ROWS`
  (`missions.rs`): its key, `When`, title, steps (goal, line, how) and
  reward. Add the key to `Key`.
- **A new goal:** a variant of `Goal`, a line in `met` saying when it is
  true, a line in `at` if its button acts on a building, and a case in
  the card's `Act` (`ui/Feed.tsx`) for the button, if it has one.
- **A new situation:** a variant of `When`, and a call to
  `missions::sense` where the server finds it, on an event, never on a
  scan of its own. If what makes it real is narrower than the event
  (a call unanswered only because a van is busy is not "short"), say so
  in `sense`.
- A test that it fires once, at the right moment, and not before
  (`a_site_short_of_stone_asks_for_a_quarry_once` is the pattern).

## Checking

`the_opening_from_the_harbour` asserts the opening's steps tick one by
one as the town does them, the reward, and the trunk walked to its end.
`bun run act missions` lists the mayors and how they stand, then the
missions, and every `act` command says the steps it saw done and the
missions it saw open, finish or lapse.

The season (`cargo test season -- --ignored --nocapture`) reads the
letters at each midnight and sells from the depot a box for each box an
order still wants, keeping one back for the sites, and prints what was
asked, filled and lapsed, by mayor, and what the orders paid. On
2026-10-12: 36 letters, 15 filled and 18 lapsed (a town building flats
every day spares little timber or stone, which is the nudge to build a
second sawmill); 2,057 coins paid, 1,027 of them over what the world
would have paid; the treasury 3,119 at the end against 2,650 without
orders, the rest of the difference being timber and stone sold and
bought back.
