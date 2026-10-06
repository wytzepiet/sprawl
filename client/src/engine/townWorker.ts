import * as Comlink from "comlink";
import { drawChunks, type Snapshot } from "./town/layer";

/** The town drawn off the main thread (`town/layer.ts`). */
const api = {
  draw(snapshot: Snapshot) {
    return drawChunks(snapshot);
  },
};

export type TownApi = typeof api;

Comlink.expose(api);
