import * as Comlink from "comlink";
import {
  buildChunk,
  transferables,
  type ChunkGeometry,
  type TerrainPalette,
  type ZonePalette,
} from "./objects/terrainGeometry";

const api = {
  build(
    tiles: Uint8Array,
    zones: Uint8Array,
    chunkX: number,
    chunkY: number,
    palette: TerrainPalette,
    zonePalette: ZonePalette,
  ): ChunkGeometry | null {
    const geometry = buildChunk(tiles, zones, chunkX, chunkY, palette, zonePalette);
    // Transfer, don't clone — cloning would copy ~280KB per chunk and undo
    // the point of building off-thread.
    return geometry && Comlink.transfer(geometry, transferables(geometry));
  },
};

export type TerrainApi = typeof api;

Comlink.expose(api);
