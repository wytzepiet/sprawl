import { decode, encode } from "@msgpack/msgpack";
import type { GameObjectEntry, Hint, ServerMessage, Stroke } from "../generated";

/**
 * The game's own road planner, run here (`server/web/src/plan.rs`, in a
 * worker of its own), on a copy of the map as this client was sent it
 * (its roads, buildings and ground): a drag drawn on it as the game draws
 * it, shown at once as what it laid (`Laid`, the hand's guess), and where
 * it may go on, asked of it rather than of a server a round trip away.
 * Until it has loaded, the game is asked and nothing is guessed.
 */
let worker: Worker | null = null;
let ready = false;
let asked = 0;
const replies = new Map<number, (h: Hint) => void>();
let onLaid: (l: Laid) => void = () => {};

/** What a drag has laid so far on the copy: the road nodes and buildings
 *  it changed or made, and the ids it took away; ids from `fresh` on are
 *  the copy's own, new to the game. */
export interface Laid {
  id: number;
  put: GameObjectEntry[];
  drop: number[];
  fresh: number;
}

/** What the server said, as far as the planner reads it, as the socket
 *  carries it; null if nothing. */
export function forPlanner(msg: ServerMessage): Uint8Array | null {
  if (msg.type === "Update") {
    const ops = msg.data.ops.filter((op) => op.op === "Delete" || (op.op === "Upsert" && (op.data.object.kind === "RoadNode" || op.data.object.kind === "Building")));
    return ops.length ? encode({ type: "Update", data: { ...msg.data, ops, town: null, island: null } }) : null;
  }
  return msg.type === "TerrainChunk" || msg.type === "Welcome" ? encode(msg) : null;
}

/** What the game said, heard by the planner; what it lays, told to `laid`. */
export function hearPlanner(msg: ServerMessage, laid: (l: Laid) => void) {
  onLaid = laid;
  const bytes = forPlanner(msg);
  if (!bytes || typeof Worker === "undefined") return;
  if (!worker) {
    worker = new Worker(new URL("./plannerWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.ready) ready = true;
      else if (data.laid) onLaid(decode(data.laid) as Laid);
      else {
        const msg = decode(data.hint) as ServerMessage | null;
        if (msg?.type === "Hint") replies.get(data.asked)?.(msg.data);
        replies.delete(data.asked);
      }
    };
  }
  worker.postMessage({ hear: bytes }, [bytes.buffer]);
}

/** A drag of road drawn on the copy; what it laid comes to `hearPlanner`'s `laid`. */
export function planDraw(stroke: Stroke) {
  if (ready && worker) worker.postMessage({ draw: encode(stroke) });
}

/** Where a drag of road may go on, as the game would answer, told to
 *  `reply`; false while the planner loads. */
export function planReach(stroke: Stroke, reply: (h: Hint) => void): boolean {
  if (!ready || !worker) return false;
  replies.set(++asked, reply);
  worker.postMessage({ asked, reach: encode(stroke) });
  return true;
}
