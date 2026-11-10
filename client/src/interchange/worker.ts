/// <reference lib="webworker" />
/**
 * A level, run in a Web Worker: the game's own simulation compiled to wasm
 * (`server/web`), ticked as the server ticks it, a step of ten
 * milliseconds. What it says goes back as the socket's bytes would; the
 * level's state as JSON, a few times a second and whenever it changes.
 */
import init, { Web } from "../wasm/sprawl_web.js";

export type ToWorker =
  | { type: "open"; name: string; text: string; layout: string | null }
  | { type: "msg"; bytes: Uint8Array }
  | { type: "test" }
  | { type: "finish" }
  | { type: "build" }
  | { type: "solve" }
  | { type: "flag"; tile: [number, number] | null }
  | { type: "note"; note: string }
  | { type: "replay" };

export type FromWorker =
  | { type: "out"; msgs: Uint8Array[] }
  | { type: "level"; json: string }
  | { type: "layout"; json: string }
  | { type: "replay"; json: string };

let web: Web | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let lastState = "";
let lastLayout = "";
let ticks = 0;

// A promise that fails here is thrown, so the page's `onerror` hears it.
self.addEventListener("unhandledrejection", (e) => {
  throw e.reason;
});

const post = (m: FromWorker) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

function flush(force = false) {
  if (!web) return;
  const msgs = web.drain() as Uint8Array[];
  if (msgs.length) post({ type: "out", msgs });
  // The level's state as often as the eye wants it, and at once when its
  // phase or cost moves.
  if (force || ++ticks % 6 === 0) {
    const json = web.state();
    if (json !== lastState) post({ type: "level", json }), (lastState = json);
  }
  // What the player has built, to keep, whenever it changes.
  if (force || ticks % 30 === 0) {
    const json = web.layout();
    if (json !== lastLayout) post({ type: "layout", json }), (lastLayout = json);
  }
}

// Each message after the one before: what comes while the game loads (the
// bench's `RunTo`) waits for it rather than being dropped.
let queue = Promise.resolve();
self.onmessage = (e: MessageEvent<ToWorker>) => void (queue = queue.then(() => handle(e.data)));

async function handle(m: ToWorker) {
  if (m.type === "open") {
    await init();
    web = new Web(m.name, m.text);
    if (m.layout) web.load(m.layout);
    lastLayout = web.layout();
    flush(true);
    clearInterval(timer);
    timer = setInterval(() => {
      web!.tick();
      flush();
    }, 10);
    return;
  }
  if (!web) return;
  if (m.type === "msg") web.send(m.bytes);
  else if (m.type === "test") web.test();
  else if (m.type === "finish") web.finish();
  else if (m.type === "build") web.build();
  else if (m.type === "solve") web.solve();
  else if (m.type === "flag") web.flag(m.tile?.[0], m.tile?.[1], "");
  else if (m.type === "note") web.note(m.note);
  else if (m.type === "replay") return post({ type: "replay", json: web.replay() });
  if (m.type !== "msg") flush(true);
}
