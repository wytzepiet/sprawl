import * as Comlink from "comlink";
import {
  buildChunk,
  transferables,
  type ChunkGeometry,
  type TerrainPalette,
} from "./objects/terrainGeometry";
import { theme } from "./theme";

const PALETTE: TerrainPalette = {
  Water: theme.water,
  // The sea a shade deeper than a lake.
  Sea: { r: theme.water.r * 0.85, g: theme.water.g * 0.85, b: theme.water.b * 0.9 },
  Beach: theme.beach,
  Grass: theme.land,
  Forest: theme.forest,
  Mountain: theme.mountain,
};

const api = {
  build(
    tiles: Uint8Array,
    heights: Uint8Array,
    chunkX: number,
    chunkY: number,
  ): ChunkGeometry | null {
    const geometry = buildChunk(tiles, heights, chunkX, chunkY, PALETTE);
    // Transfer, don't clone — cloning would copy ~280KB per chunk and undo
    // the point of building off-thread.
    return geometry && Comlink.transfer(geometry, transferables(geometry));
  },
};

export type TerrainApi = typeof api;

Comlink.expose(api);
