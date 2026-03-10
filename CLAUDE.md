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
- `client/` — SolidJS 2.0 + Babylon.js (Vite)

## Tools

- **Package manager:** bun
- **Client dev:** `cd client && bun run dev`
- **Generated types:** `cd client && bun run generate`

## Solid 2.0

Docs: https://github.com/solidjs/solid/tree/next/documentation/solid-2.0

Key differences from Solid 1.x:

- `solid-js/web` → `@solidjs/web`, `solid-js/store` → `solid-js`
- `batch()` removed — use `flush()`
- `onMount` → `onSettled`
- `createResource` → async `createMemo` + `<Loading>`
- `createSelector` → `createProjection`
- `Suspense` → `<Loading>`, `ErrorBoundary` → `<Errored>`
- `mergeProps` → `merge`, `splitProps` → `omit`, `unwrap` → `snapshot`
- Stores use draft setters: `setStore(s => { s.user.name = "Alice"; })`
- `<For>` children receive accessors: `{(item, i) => <div>{item()}</div>}`
- Don't destructure props — breaks reactivity
- Effects split into compute + apply (see Solid 2.0 docs)
- Context: no `.Provider` — `<Ctx value={val}>{children}</Ctx>`
