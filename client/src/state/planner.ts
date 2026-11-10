import { decode, encode } from "@msgpack/msgpack";
import type { Hint, ServerMessage, Stroke } from "../generated";

/**
 * The game's own road planner, run here (`server/web/src/plan.rs`, in a
 * worker of its own): where a drag may go on is the same code the server
 * answers with, asked of a copy of the map as this client was sent it,
 * with no round trip to the server. It hears what the server says (its
 * roads, buildings and ground); until it has loaded, the server is asked.
 */
let worker: Worker | null = null;
let ready = false;
let asked = 0;
const replies = new Map<number, (h: Hint) => void>();

/** What the server said, as far as the planner reads it, as the socket
 *  carries it; null if nothing. */
export function forPlanner(msg: ServerMessage): Uint8Array | null {
  if (msg.type === "Update") {
    const ops = msg.data.ops.filter((op) => op.op === "Delete" || (op.op === "Upsert" && (op.data.object.kind === "RoadNode" || op.data.object.kind === "Building")));
    return ops.length ? encode({ type: "Update", data: { ...msg.data, ops, town: null, island: null } }) : null;
  }
  return msg.type === "TerrainChunk" || msg.type === "Welcome" ? encode(msg) : null;
}

/** What the server said, heard by the planner. */
export function hearPlanner(msg: ServerMessage) {
  const bytes = forPlanner(msg);
  if (!bytes || typeof Worker === "undefined") return;
  if (!worker) {
    worker = new Worker(new URL("./plannerWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.ready) ready = true;
      else {
        const msg = decode(data.hint) as ServerMessage | null;
        if (msg?.type === "Hint") replies.get(data.asked)?.(msg.data);
        replies.delete(data.asked);
      }
    };
  }
  worker.postMessage({ hear: bytes }, [bytes.buffer]);
}

/** Where a drag of road may go on, as the server would answer, told to
 *  `reply`; false while the planner loads. */
export function planReach(stroke: Stroke, reply: (h: Hint) => void): boolean {
  if (!ready || !worker) return false;
  replies.set(++asked, reply);
  worker.postMessage({ asked, reach: encode(stroke) });
  return true;
}
