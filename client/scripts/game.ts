import { decode, encode } from "@msgpack/msgpack";
import { PORT } from "./lib";
import { CHUNK_SIZE } from "../src/engine/objects/terrainGeometry";
import type { ClientMessage, GameObjectEntry, ServerMessage } from "../src/generated";

/**
 * The running game, heard over its socket as a client hears it: what
 * stands on the chunks round these tiles, `pad` chunks beyond, as the
 * ops leave it; the clock; and every message to `hear` as it comes. What
 * `act`, `flat` and `jolt` share. The game is the one `bun run dev` runs,
 * or SPRAWL_PORT's; `player` is a hand of its own (`act`'s).
 */
export async function connect(o: { tiles: [number, number][]; pad?: number; player?: string; hear?: (msg: ServerMessage) => void }) {
  const entities = new Map<number, GameObjectEntry>();
  const clock = { now: 0, speed: 0, day_ms: 1, heard: 0 };
  const ws = new WebSocket(`ws://localhost:${PORT}/ws${o.player ? `?player=${o.player}` : ""}`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => {
    const msg = decode(new Uint8Array(e.data as ArrayBuffer)) as ServerMessage;
    if (msg.type === "Update") {
      Object.assign(clock, msg.data.clock, { heard: Date.now() });
      for (const op of msg.data.ops) op.op === "Upsert" ? entities.set(op.data.id, op.data) : entities.delete(op.data);
    }
    o.hear?.(msg);
  };
  await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = () => fail(new Error(`no game on port ${PORT}: bun run dev`)))));
  const send = (msg: ClientMessage) => ws.send(encode(msg));
  const pad = o.pad ?? 1;
  const [xs, ys] = [o.tiles.map((p) => Math.floor(p[0] / CHUNK_SIZE)), o.tiles.map((p) => Math.floor(p[1] / CHUNK_SIZE))];
  send({ type: "SetChunks", data: { min_cx: Math.min(...xs) - pad, min_cy: Math.min(...ys) - pad, max_cx: Math.max(...xs) + pad, max_cy: Math.max(...ys) + pad } });
  /** Sim time now, run on from the last update at its speed. */
  const now = () => clock.now + (Date.now() - clock.heard) * clock.speed;
  return { entities, clock, now, send, close: () => ws.close() };
}
