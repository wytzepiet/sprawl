import * as Comlink from "comlink";
import { drawChunks, type Snapshot } from "./town/layer";

/** The town drawn off the main thread (`town/layer.ts`). */
const api = {
  draw(snapshot: Snapshot) {
    const drawing = drawChunks(snapshot);
    // The kerb texels handed over, not copied: half a megabyte a chunk.
    return Comlink.transfer(drawing, drawing.chunks.flatMap((c) => (c.paving ? [c.paving.half.buffer] : [])));
  },
};

export type TownApi = typeof api;

Comlink.expose(api);
