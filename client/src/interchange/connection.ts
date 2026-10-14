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
  /** Mark this moment, and the tile pointed at, as something wrong; and
   *  then say what (`server/src/replay.rs`). */
  flag(tile: [number, number] | null): void;
  note(note: string): void;
  /** Everything played since the level opened, to play again, as JSON. */
  replay(): Promise<string>;
}

export function connectLevel(
  name: string,
  text: string,
  layout: string | null,
  onMessage: (msg: ServerMessage) => void,
  onLevel: (s: LevelState) => void,
  onLayout: (json: string) => void,
): LevelConnection {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const post = (m: ToWorker) => worker.postMessage(m);
  let replayed: ((json: string) => void)[] = [];
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    if (m.type === "out") for (const bytes of m.msgs) onMessage(decode(bytes) as ServerMessage);
    else if (m.type === "layout") onLayout(m.json);
    else if (m.type === "replay") {
      const waiting = replayed;
      replayed = [];
      for (const r of waiting) r(m.json);
    }
    else onLevel(JSON.parse(m.json) as LevelState);
  };
  post({ type: "open", name, text, layout });
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
    flag: (tile) => post({ type: "flag", tile }),
    note: (note) => post({ type: "note", note }),
    replay: () => new Promise((r) => (replayed.push(r), post({ type: "replay" }))),
  };
}
