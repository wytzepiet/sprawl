import { encode, decode } from "@msgpack/msgpack";
import type { ClientMessage, Hint, ServerMessage } from "../generated";
import { hearPlanner, planReach } from "../state/planner";

export interface Connection {
  /** False when the socket was not open and the message was dropped. */
  send(msg: ClientMessage): boolean;
  /** Whether this is asked and answered here, not over the line, the
   *  answer told to `reply`: a server is a round trip away, and where a
   *  drag of road may go on is the game's own planner's to say
   *  (`state/planner.ts`). */
  answer?(msg: ClientMessage, reply: (h: Hint) => void): boolean;
  close(): void;
}

export function createConnection(
  url: string,
  onMessage: (msg: ServerMessage) => void,
): Connection {
  let ws: WebSocket | null = null;
  let closed = false;

  function connect() {
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
    };

    ws.onmessage = (ev) => {
      const msg = decode(new Uint8Array(ev.data)) as ServerMessage;
      hearPlanner(msg);
      onMessage(msg);
    };

    ws.onclose = () => {
      if (!closed) {
        setTimeout(connect, 1000);
      }
    };

    ws.onerror = (e) => {
      console.error("[ws] error", e);
    };
  }

  connect();

  return {
    send(msg: ClientMessage) {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(encode(msg));
      return true;
    },
    answer: (msg, reply) => msg.type === "Ask" && msg.data.type === "Reach" && msg.data.data.tool !== "Demolish" && planReach(msg.data.data, reply),
    close() {
      closed = true;
      ws?.close();
    },
  };
}
