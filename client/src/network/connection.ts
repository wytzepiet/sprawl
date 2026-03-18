import { encode, decode } from "@msgpack/msgpack";
import type { ClientMessage, ServerMessage } from "../generated";
import { trackMessage } from "../ui/DebugOverlay";

let clockOffset = 0;
const SMOOTH = 0.2;

export function getClockOffset(): number {
  return clockOffset;
}

export function updateClockOffset(serverTime: number) {
  const sample = Date.now() - serverTime;
  clockOffset = clockOffset === 0 ? sample : clockOffset + SMOOTH * (sample - clockOffset);
}

export interface Connection {
  send(msg: ClientMessage): void;
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
      setTimeout(() => {
        trackMessage(msg);
        onMessage(msg);
      }, 20);
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
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(encode(msg));
      }
    },
    close() {
      closed = true;
      ws?.close();
    },
  };
}
