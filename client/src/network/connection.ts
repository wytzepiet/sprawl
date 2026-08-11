import { encode, decode } from "@msgpack/msgpack";
import type { ClientMessage, ServerMessage } from "../generated";
import { trackMessage } from "../ui/DebugOverlay";

export interface Connection {
  /** False when the socket was not open and the message was dropped. */
  send(msg: ClientMessage): boolean;
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
      trackMessage(msg);
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
    close() {
      closed = true;
      ws?.close();
    },
  };
}
