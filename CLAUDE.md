# Sprawl

City-building and traffic sim game. Design docs in `sprawl-guide.md`.

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
- **Is it current?** `curl localhost:3001/health` → `built_ago_s` is the age of
  the running binary, `sim_time` should be climbing. A fix that seems not to
  work is a stale binary until that says otherwise; a socket that answers while
  `sim_time` stands still is a dead game loop.
- **Is it fast?** Two signals, and no profiling until one of them fires.
  The server prints `behind: N wakes took M ms` whenever a tick overruns a
  quarter second — if that shows in `.dev/server.log`, the loop is falling
  behind the wall clock and every command lags with it. Every now and then,
  `cargo test --release town -- --ignored --nocapture` runs a day of town
  life and asserts how often residents wake (a storm is ten times the
  budget) and prints simulated days per second, to see whether it drifted.
  When one of those says something is wrong, `bun run profile` attaches to
  the running server (`samply setup` once, first) and opens a flame graph in
  the browser.
- **Generated types:** `cd client && bun run generate`
- **Test world:** `rm server/sprawl.db && SPRAWL_SEED=7 bun run dev`. Seed 7 has
  open land beside the starting roads, forest to build into, and coastline —
  enough to exercise building, tree clearing and demolition. Any fixed seed gives
  the same map back, so a change in behaviour is a change in the code.
  `SPRAWL_SEED=7 cargo test draw_the_land -- --nocapture` prints the middle of
  the map; `cargo test draw_the_town -- --nocapture` prints a grown town.

## Solid 1.x

- Stores: `createStore` from `solid-js/store`, mutate with `produce`
- `<For>` children receive direct values: `{(item, i) => <div>{item.name}</div>}`
- `<Show>` callback children receive accessors: `{(v) => v()}`
- Don't destructure props — breaks reactivity
- Context: `<Ctx.Provider value={val}>{children}</Ctx.Provider>`
- Deferred effects: `createEffect(on(trackFn, applyFn, { defer: true }))`
