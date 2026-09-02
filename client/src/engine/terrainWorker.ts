import * as Comlink from "comlink";
import {
  buildChunk,
  transferables,
  type ChunkGeometry,
  type TerrainPalette,
} from "./objects/terrainGeometry";

const api = {
  build(
    tiles: Uint8Array,
    chunkX: number,
    chunkY: number,
    palette: TerrainPalette,
  ): ChunkGeometry | null {
    const geometry = buildChunk(tiles, chunkX, chunkY, palette);
    // Transfer, don't clone — cloning would copy ~280KB per chunk and undo
    // the point of building off-thread.
    return geometry && Comlink.transfer(geometry, transferables(geometry));
  },
};

export type TerrainApi = typeof api;

Comlink.expose(api);
