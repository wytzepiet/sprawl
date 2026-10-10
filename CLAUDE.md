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
- `client/` — SolidJS 1.x + Babylon Lite (Vite), WebGPU only. Lite is our
  fork, read from its source beside this repo: clone
  `github.com/wytzepiet/Babylon-Lite` (branch `sprawl`) to `../Babylon-Lite`
  and `pnpm install` there. After changing its API, build the types the client
  checks against: `tsc -p . --emitDeclarationOnly --declarationMap false
  --outDir build/types --composite false --incremental false` in
  `packages/babylon-lite`. What the fork adds, and why, is in its commits.

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
  budget) and prints simulated days per second, to see whether it drifted;
  and it times a house, a shop, their demolition and a road in a town and
  in one twice the size, and asserts the bigger town costs about the same.
  A build costs what it changed: `World::settle` reads only the buildings
  marked `unsettled`, and `resettle`, the whole world, runs at startup.
- **Does the town still keep?** `cargo test season -- --ignored
  --nocapture` runs the same town for thirty days and asserts that its
  shelves stay stocked and its residents fed: no shelf and no tank empty
  two midnights running, a day's meals eaten every day, and coins left at
  the end. It prints each day's hours worked, eaten out and filled up,
  GDP by building, and coins across the border. Its town's only door is a
  harbour: everything it buys comes by ferry and its depot's lorry, and
  the farm's crates go out the same way. `SEA=1` adds each midnight's
  border: the park, the deck, the lorries and the yards. A chain that
  stops delivering shows here before it shows in play.
- **The opening, end to end:** `cargo test the_opening` plays it: the
  starter pack lands, the tapped lorry fetches, a house waits for its
  timber, its settlers come on the next ferry, a box sold is paid for.
  In a running game, `curl localhost:4801/sea` is the border as the server
  has it, and `bun run act send|standing|order|sell` work it by hand.
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
  `road_gen.rs`, `cargo test every_seed -- --ignored` checks the first
  twenty seeds are islands in one ocean and seats their starting towns;
  `DRAW=1` draws the ones that fail. It also finds ships' ways from the
  home coast to the edge and to every island, and times them (50 ms
  budget).
- **Does the sea work?** `cargo test scenario -- --nocapture` runs the
  scenarios in `server/scenarios/*.txt` (a map in text, harbours, demand,
  `expect` lines; the key is at the top of `server/src/shipping/sim.rs`)
  headless for days in under a second each, with the game's own routing,
  timetable and company rule (`server/src/shipping/`), and prints a page
  a day and a row of metrics: delivered, transit, lateness against the
  quoted ETA, transfers, missed, berth waits, empties, coins, a hash.
  `SCENARIO=two` runs one; `SVG=1` draws each into `.dev/scenarios/`.
  Change the network's rules here first, against the numbers
  (docs/plan-sea.md §The harness comes first).
- **Does it still look right?** `bun run shots` builds the test towns in
  `server/fixtures/*.txt` (a map in text; the key is in
  `server/src/fixtures.rs`) on a stack of its own, ports 4810/4811, and
  photographs each: `.dev/shots/sheet.png` has them all on one page.
  `--keep` leaves that stack up to look round by hand. The renderer is
  WebGPU only; in a cloud container Playwright's Chromium draws it in
  software (SwiftShader), slowly but truly: a frame a second, a `look`
  in about twenty-five seconds. A shot that comes out all in shade is a
  shadow pass that never ran: Lite skips it while a new caster set
  loads, so a mesh added and dropped every frame keeps it skipped. A new look gets a
  fixture that shows it, so the next change can be seen not to break it.
- **The plan:** `bun run plan [fixture…]` draws the town grid flat as SVG
  in `.dev/plan/`, from the sandbox's own code, in well under a second a
  fixture: no light, no 3D, no browser. `--png` adds pictures and a sheet,
  `--crop c0,r0,c1,r1` a part (`PX=80` for a closer look), `--at <ref>`
  the same drawn from the code at another commit beside today's,
  `--live x,y[,r]` the running game round a tile (from `/map`), numbered
  in the game's own tiles and drawn as the town grid will draw it. Most
  layout questions need only this; photographs are for light and height.
- **The mayor's hand:** `bun run act road 7,78 7,85 0,85`, `build House
  5,86` (more tiles paint on through them, as the brush drags),
  `demolish 5,86`, `speed 0`, `run 2` (hours, or `--to 0.83` of a
  day), `reset`; `bun run act - < steps` reads one a line. Each says what
  it made and took away; a tile refused is in `.dev/server.log`. Each of
  `road`, `build` and `demolish` is drafted and committed at once;
  `draft road …` leaves it a draft and says its bill, and `commit`,
  `undo`, `discard` work the draft (`game.md` §Drafts). To set up a situation and watch it:
  `watch 2 5,80` (or `--to 0.45`) runs the clock and records every trip
  round that tile to `.dev/paths.json`, as the client draws them, and
  counts the bends tighter than a car turns (style.md's 0.45), as the
  client drives them (`client/src/engine/objects/driver.ts`); `bun run
  plan --live 6,79,6 --paths` draws them, a strobe of each vehicle, those
  bends red, and `--paths=<car,car>` those cars' trips alone.
- **Where is everything, now?** `bun run flat 6,80` draws the running
  game flat round a tile (`,30` thirty tiles each way, twelve by
  default) into `.dev/flat/flat.png` in a fifth of a second, no browser
  and no GPU: every vehicle placed by the 3D client's own code
  (`motion.ts`), what is on the ferry's deck and in the park, box by box
  in its good's colour, a site's timber, ids beside things, the grid in
  the game's tiles, a legend with the clock and the ferry's state.
  `--frames 8 --every 500` a run of them and a strip, `--follow <id>` a
  vehicle kept in the middle, `--px` the scale, `--name`. Reach for this
  first after a change to what moves; `look` is for light and material.
  The drawing (`client/src/flat/draw.ts`) is the minimap's too.
- **A photograph of the game:** `bun run look 6,80,4` (a tile, and how
  many tiles each way), `--frames 8 --every 250` a short run of them
  and a strip, in `.dev/look/`; in a cloud container, as for `shots`.
- **What a frame costs, by kind:** `bun run cost 6,80,15` (a tile and how
  many tiles each way up and down, `--t 0.95` a time of day) hides each kind
  of mesh in view in turn (a mesh's name with its chunk taken out:
  `ground_`, `chunk_tree_tops`, `inst_…`), then keeps it out of the shadow
  map, then the shadow map and the other lights as a whole, and prints what
  each saved a frame, with its meshes, instances, triangles and draw calls,
  in `.dev/cost/`. Under a minute; agrees with itself to a tenth of a ms.
  The frame is the GPU's when it is well over the CPU's.
- **The look alone:** `/sandbox?f=<fixture>` on the dev client draws a
  fixture with no server, through the town grid (`client/src/engine/town/`,
  `docs/look.md`), and paints it by hand. `bun run shots --sandbox` is the
  sheet from it, in seconds.
- **Building something that is seen:** read `docs/style.md` first: the
  verdicts so far, how to check a new thing, and where to find real
  examples. In a cloud session Overpass may not answer; the main
  OpenStreetMap API and the open aerial photos (PDOK for the Netherlands,
  USGS NAIP for the US) do, with the URLs in `style.md`.
- **A real place as a fixture:** `bun run osm <name> @<lat>,<lon>,36,28`
  fetches that many tiles of OpenStreetMap round a point into
  `server/fixtures/<name>.txt` (`TITLE="…"` names it). Overpass is shared
  and often busy; the script tries again, `OVERPASS=<mirror url>` asks
  another, and `--query` prints the query for fetching by hand, to pass
  the saved answer instead of the point; `bun run osm <name>` alone makes
  it again from the answer kept in `.dev/osm/`. What becomes what is at
  the top of `client/scripts/osm.ts`.
- **Generated types:** `cd client && bun run generate`
- **Test world:** `rm server/sprawl.db && SPRAWL_SEED=7 bun run dev`. Seed 7 has
  open land beside the starting roads and forest to build into — enough to
  exercise building, tree clearing and demolition; every seed's origin is
  forty tiles in from its island's coast. `SPRAWL_ALL=1` opens
  the whole tree and a bottomless treasury. Any fixed seed gives
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
