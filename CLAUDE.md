# Sprawl

City-building and traffic sim game. What the game is lives in `docs/`; start
at `docs/README.md`, then `docs/game.md`. This file is how to work on the code.

## Engineering Philosophy: Distill, Don't Patch

**Every line of code must fight for its existence.**

### Elon's Algorithm — In Order, No Exceptions

1. **Question every requirement.** If you can't name a concrete reason, it shouldn't exist.
2. **Delete.** Not refactor. Not wrap. DELETE. If you're not uncomfortable with how much you're deleting, you're not deleting enough.
3. **Simplify what remains.**
4. **Speed up.** Remove indirection and ceremony.
5. **Automate last.** Never automate a bad process.

### Rules

- Bug? Don't add a guard clause — ask why the code *allows* this bug. Delete what makes it possible.
- Edge case? Ask if the abstraction is wrong. Usually yes.
- New abstraction? Delete an existing one first. Net additions are a red flag.
- Flag/boolean to control behavior → the abstraction is wrong.
- Comment explaining why something confusing is needed → delete the confusing thing.

### The Litmus Test

> "Did I make the codebase smaller and clearer, or just different?"

If it's not clearly *smaller and clearer*, throw it away and try again.

## Structure

- `server/` — Rust (DES, WebSocket, SQLite)
- `client/` — SolidJS 1.x + Babylon.js (Vite)

## Tools

- **Package manager:** bun
- **Dev stack:** `bun run dev` — runs client and server together in a TUI. The
  server rebuilds and restarts on save, so it cannot fall behind its source.
  `./dev.sh --headless` runs the same processes without a TUI, `--stop` stops
  them. Both write to `.dev/<name>.log`.
- **Is it current?** `curl localhost:4801/health` → `built_ago_s` is the age of
  the running binary, `sim_time` should be climbing. A fix that seems not to
  work is a stale binary until that says otherwise; a socket that answers while
  `sim_time` stands still is a dead game loop.
- **Is it fast?** Two signals, and no profiling until one of them fires.
  The server prints `behind: N wakes took M ms` whenever a tick overruns a
  quarter second — if that shows in `.dev/server.log`, the loop is falling
  behind the wall clock and every command lags with it. Every now and then,
  `cargo test town -- --ignored --nocapture` runs a day of town
  life and asserts how often residents wake (a storm is ten times the
  budget) and prints simulated days per second, to see whether it drifted.
- **Does the economy still balance?** `cargo test season -- --ignored
  --nocapture` runs the same town for thirty days and asserts the
  equilibria `docs/economy.md` §11 names that take weeks to show — the
  band and no ringing, no harm, tenure — and prints every building's
  purse and books. A price that runs away or a shop that bleeds shows
  here before it shows in play.
  When one of those says something is wrong, `bun run profile` attaches to
  the running server (`samply setup` once, first) and opens a flame graph in
  the browser.
- **Does it still hold?** `cd server && cargo test && cargo check`, then
  `cd client && bunx tsc --noEmit -p .`. Nothing runs these but you, so run
  them before you push. The suite takes about ten seconds: the test profile
  is optimised (`[profile.test]` in `Cargo.toml`, assertions and overflow
  checks still on) and the town tests skip the ticks nothing is due at. A
  rebuild after an edit costs a few seconds more than a debug one; a day of
  town at opt-level 0 cost a minute. `cargo check` is not redundant: `cargo test` compiles
  the crate with `cfg(test)` on, so a stray `#[cfg(test)]` above something the
  game needs passes the suite and leaves a server that will not build.
- **Does every seed still start?** After touching `terrain.rs` or
  `road_gen.rs`, `cargo test every_seed -- --ignored` seats the starting
  town on the first twenty seeds; `DRAW=1` draws the ones that fail.
- **Does it still look right?** `bun run shots` builds the test towns in
  `server/fixtures/*.txt` (a map in text; the key is in
  `server/src/fixtures.rs`) on a stack of its own, ports 4810/4811, and
  photographs each: `.dev/shots/sheet.png` has them all on one page.
  `--keep` leaves that stack up to look round by hand. Without desktop
  Chrome (a cloud container), `CHROME=/opt/pw-browsers/chromium` draws
  with WebGL in software instead. A new look gets a
  fixture that shows it, so the next change can be seen not to break it.
- **A real place as a fixture:** `bun run osm <name> @<lat>,<lon>,36,28`
  fetches that many tiles of OpenStreetMap round a point into
  `server/fixtures/<name>.txt` (`TITLE="…"` names it). Overpass is shared
  and often busy; the script tries again, `OVERPASS=<mirror url>` asks
  another, and `--query` prints the query for fetching by hand, to pass
  the saved answer instead of the point. What becomes what is at the top
  of `client/scripts/osm.ts`.
- **Generated types:** `cd client && bun run generate`
- **Test world:** `rm server/sprawl.db && SPRAWL_SEED=7 bun run dev`. Seed 7 has
  open land beside the starting roads and forest to build into — enough to
  exercise building, tree clearing and demolition; the sea is seventy tiles
  off to the north-west, and seed 3 starts on the shore. `SPRAWL_ALL=1` opens
  the whole tree and a bottomless purse. Any fixed seed gives
  the same map back, so a change in behaviour is a change in the code.
  `SPRAWL_SEED=7 cargo test draw_the_land -- --nocapture` prints the whole
  map, sixteen tiles to a character.

## Solid 1.x

- Stores: `createStore` from `solid-js/store`, mutate with `produce`
- `<For>` children receive direct values: `{(item, i) => <div>{item.name}</div>}`
- `<Show>` callback children receive accessors: `{(v) => v()}`
- Don't destructure props — breaks reactivity
- Context: `<Ctx.Provider value={val}>{children}</Ctx.Provider>`
- Deferred effects: `createEffect(on(trackFn, applyFn, { defer: true }))`
