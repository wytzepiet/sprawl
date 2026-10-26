import "../app.css";
import { encode, decode } from "@msgpack/msgpack";
import Scene from "../engine/Scene";
import type { ServerMessage } from "../generated";
import type { ToWorker } from "./worker";

/**
 * The opening, to play again and again: a new town in the browser, no
 * server, fresh on every load, on the seed in `?seed=` (7 by default, the
 * test world's).
 */
export default function Opening() {
  const seed = Number(new URLSearchParams(location.search).get("seed") ?? 7);
  return (
    <Scene
      connect={(on) => {
        const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
        const post = (m: ToWorker) => worker.postMessage(m);
        worker.onmessage = (e: MessageEvent<Uint8Array[]>) => {
          for (const bytes of e.data) on(decode(bytes) as ServerMessage);
        };
        post({ type: "open", seed });
        return {
          send: (msg) => (post({ type: "msg", bytes: encode(msg) }), true),
          close: () => worker.terminate(),
        };
      }}
    />
  );
}
