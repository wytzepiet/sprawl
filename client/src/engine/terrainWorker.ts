import * as Comlink from "comlink";
import {
  buildChunk,
  buildTrees,
  transferables,
  type ChunkGeometry,
} from "./objects/terrainGeometry";
import { setSlate } from "./slate";
import { theme } from "./theme";

const api = {
  /** The slate the rock's edges break along, as the GPU drew it. */
  slate: setSlate,
  build(
    tiles: Uint8Array,
    heights: Uint8Array,
    chunkX: number,
    chunkY: number,
    cliff: Uint8Array | null,
  ): ChunkGeometry | null {
    const geometry = buildChunk(tiles, heights, chunkX, chunkY, cliff);
    // Transfer, don't clone — cloning would copy ~280KB per chunk and undo
    // the point of building off-thread.
    return geometry && Comlink.transfer(geometry, transferables(geometry));
  },
  /** A chunk's trees, planted round what is built (`buildTrees`). */
  trees(tiles: Uint8Array, built: Uint8Array, chunkX: number, chunkY: number) {
    const sets = buildTrees(tiles, built, chunkX, chunkY, theme);
    return Comlink.transfer(sets, [sets.broad.matrices.buffer, sets.broad.colors.buffer, sets.conifer.matrices.buffer, sets.conifer.colors.buffer]);
  },
};

export type TerrainApi = typeof api;

Comlink.expose(api);
