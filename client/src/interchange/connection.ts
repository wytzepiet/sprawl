import { encode, decode } from "@msgpack/msgpack";
import type { ClientMessage, LevelState, ServerMessage } from "../generated";
import type { Connection } from "../network/connection";
import type { FromWorker, ToWorker } from "./worker";

/** The line to a level running in a worker: what the socket is to the
 *  town, and the level's own buttons beside it. */
export interface LevelConnection extends Connection {
  test(): void;
  finish(): void;
  build(): void;
  /** Our own solve, laid. */
  solve(): void;
}

export function connectLevel(name: string, text: string, onMessage: (msg: ServerMessage) => void, onLevel: (s: LevelState) => void): LevelConnection {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const post = (m: ToWorker) => worker.postMessage(m);
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    if (m.type === "out") for (const bytes of m.msgs) onMessage(decode(bytes) as ServerMessage);
    else onLevel(JSON.parse(m.json) as LevelState);
  };
  post({ type: "open", name, text });
  return {
    send(msg: ClientMessage) {
      post({ type: "msg", bytes: encode(msg) });
      return true;
    },
    close: () => worker.terminate(),
    test: () => post({ type: "test" }),
    finish: () => post({ type: "finish" }),
    build: () => post({ type: "build" }),
    solve: () => post({ type: "solve" }),
  };
}
