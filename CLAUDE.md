# Sprawl

A multiplayer persistent city-building and traffic simulation game. See `sprawl-guide.md` for full design docs.

## Philosophy

This project is early-stage — nowhere near production. Prefer deleting and rewriting over patching broken code. Bad code multiplies faster than good code; eradicate it when you see it. Don't be precious about existing implementations — if something is fundamentally wrong, throw it out and rebuild. AI-assisted coding makes rewrites cheap, so optimize for correctness and clarity over preserving sunk cost.

## Project Structure

- `server/` — Rust game server (DES, WebSocket, SQLite)
- `client/` — SolidJS 2.0 + Babylon.js client (Vite SPA)
- `client-old/` — Legacy Solid 1.x client (deprecated)

## Tools

- **Package manager:** bun (not npm/yarn/pnpm)
- **Client dev:** `cd client && bun run dev`
- **Generated types:** `cd client && bun run generate` (runs ts-rs via cargo test)

## Solid 2.0 (beta)

Full docs: https://github.com/solidjs/solid/tree/next/documentation/solid-2.0

### Breaking changes that will bite you

**Imports moved:**
- `solid-js/web` -> `@solidjs/web`
- `solid-js/store` -> `solid-js` (stores, snapshot, storePath all from `solid-js`)

**Batching:** Setters don't immediately update reads. Values flush on next microtask or via `flush()`. `batch()` is removed.

**Effects are split** into compute (reactive tracking) and apply (side effects). Cleanup is returned from apply:

```js
createEffect(
  () => name(),           // compute: reactive reads only
  (value) => {            // apply: side effects, runs after flush
    el().title = value;
    return () => { /* cleanup */ };
  }
);
```

**Stores** use draft-first setters (produce-style). Path-style `setStore(key, value)` is gone — use `storePath()` for compat:

```js
setStore(s => { s.user.name = "Alice"; });
```

**Derived forms** — `createSignal(fn)`, `createStore(fn)`, and `createProjection(fn)` create reactive derived state:

```js
// createProjection: mutable derived store (replaces createSelector)
const selected = createProjection((draft) => {
  const id = selectedId();
  draft[id] = true;
  if (draft._prev != null) delete draft[draft._prev];
  draft._prev = id;
}, {});
```

**Context** — no `.Provider`: `<Ctx value={val}>{children}</Ctx>`

**Control flow** — `<For>` children receive **accessors** (call them!): `{(item, i) => <Row item={item()} index={i()} />}`

**Don't destructure props** — breaks reactivity. Use `props.x` not `{ x }`.

**Top-level reactive reads** in component body warn. Read in JSX, `createMemo`, or `createEffect`. Use `untrack()` for intentional one-time reads.

### Renamed / removed APIs

| Removed | Replacement |
|---------|-------------|
| `batch` | `flush()` |
| `onMount` | `onSettled` |
| `onError` / `catchError` | `<Errored>` / effect `error` callback |
| `createResource` | async `createMemo` + `<Loading>` |
| `createComputed` | split `createEffect`, `createSignal(fn)`, or `createMemo` |
| `createSelector` | `createProjection` / `createStore(fn)` |
| `mergeProps` | `merge` (`undefined` overrides, not skips) |
| `splitProps` | `omit` |
| `unwrap` | `snapshot` |
| `Index` | `<For keyed={false}>` |
| `Suspense` | `<Loading>` |
| `ErrorBoundary` | `<Errored>` |
| `classList` | `class` with object/array |
| `use:` directives | `ref={directive(opts)}` |
| `startTransition` / `useTransition` | built-in transitions + `isPending` / `Loading` |
| `createMutable` | `@solidjs/signals` |
