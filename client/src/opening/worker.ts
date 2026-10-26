/// <reference lib="webworker" />
/**
 * A new town, run in a Web Worker: the game's own simulation compiled to
 * wasm (`server/web`), ticked as the server's loop ticks it, a step of ten
 * milliseconds; what it says goes back as the socket's bytes would.
 */
import init, { Town } from "../wasm/sprawl_web.js";

export type ToWorker = { type: "open"; seed: number } | { type: "msg"; bytes: Uint8Array };

let town: Town | null = null;

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === "msg") return town?.send(m.bytes);
  await init();
  town = new Town(m.seed);
  setInterval(() => {
    town!.tick();
    const msgs = town!.drain() as Uint8Array[];
    if (msgs.length) (self as unknown as DedicatedWorkerGlobalScope).postMessage(msgs);
  }, 10);
};
