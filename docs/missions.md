# Missions

Status: built 2026-10-10 for the opening, the trunk and the town's
situation (`server/src/missions.rs`, `client/src/ui/Missions.tsx`).
Orders from other towns and dailies are designed here, not built.

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
   a street between them, the starter pack fetched, houses and their
   settlers (`game.md` §The opening). Then one at a time, each opening
   as the last finishes, three short missions for the core loop: give
   the depot's lorry standing orders, keep stone at the depot by a
   rule, sell a box of crates to the world.
2. **Unlocks.** Each building kind may carry a mission that teaches it,
   opened when the kind is unlocked. Everything is unlocked today (the
   tree is off, `game.md` §The build), so these come from source 3 for
   now: the mission that asks for a quarry is the quarry's teaching
   mission.
3. **The town's situation**, the best teacher. A mission opens when
   something first matters, not merely when it is possible, and only
   after the opening: a site or a shop calls for a good no depot in town
   has any of (stone asks for a quarry, timber for a sawmill, crates for
   a farm); a car is low on fuel with nowhere in town to fill it (a gas
   station). Each opens once, and not at all if the town already has
   what it asks for.
4. **Orders from other towns** (next, not built): a step is "these boxes
   delivered to <town>", rewarded by that town. It is a `Mission` made
   by the order, not a row: its own key (`Key::Order(id)` when it
   comes), a `Goal::Delivered { town, good, boxes }`, its words written
   when the order is placed, and its reward the town's.
5. **Dailies** (later): see below.

## Dailies

Drawn at midnight from templates, the same rows as the situation
missions but with a `When::Daily` and goals that can be done again
("sell two boxes of timber", "fetch every box in the park before the
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
  the panel's `Act` (`Missions.tsx`) for the button, if it has one.
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
`bun run act missions` lists the missions, and every `act` command says
the steps it saw done and the missions it saw open or finish.
