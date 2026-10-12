/// <reference lib="webworker" />
/**
 * A level, run in a Web Worker: the game's own simulation compiled to wasm
 * (`server/web`), ticked as the server ticks it, a step of ten
 * milliseconds. What it says goes back as the socket's bytes would; the
 * level's state as JSON, a few times a second and whenever it changes.
 */
import init, { Web } from "../wasm/sprawl_web.js";

export type ToWorker =
  | { type: "open"; name: string; text: string }
  | { type: "msg"; bytes: Uint8Array }
  | { type: "test" }
  | { type: "finish" }
  | { type: "build" };

export type FromWorker = { type: "out"; msgs: Uint8Array[] } | { type: "level"; json: string };

let web: Web | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let lastState = "";
let ticks = 0;

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
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === "open") {
    await init();
    web = new Web(m.name, m.text);
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
  if (m.type !== "msg") flush(true);
};
