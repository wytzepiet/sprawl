import * as Comlink from "comlink";
import {
  buildChunk,
  buildTrees,
  transferables,
  type ChunkGeometry,
  type TerrainPalette,
} from "./objects/terrainGeometry";
import { setSlate } from "./slate";
import { theme } from "./theme";

const PALETTE: TerrainPalette = {
  Water: theme.water,
  // The sea a shade deeper than a lake.
  Sea: { r: theme.water.r * 0.85, g: theme.water.g * 0.85, b: theme.water.b * 0.9 },
  Beach: theme.beach,
  Grass: theme.land,
  Clay: theme.clay,
  Forest: theme.forest,
  Mountain: theme.mountain,
};

const api = {
  /** The slate the rock's edges break along, as the GPU drew it. */
  slate: setSlate,
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
  /** A chunk's trees, planted round what is built (`buildTrees`). */
  trees(tiles: Uint8Array, built: Uint8Array, chunkX: number, chunkY: number) {
    const sets = buildTrees(tiles, built, chunkX, chunkY, theme);
    return Comlink.transfer(sets, [sets.broad.matrices.buffer, sets.broad.colors.buffer, sets.conifer.matrices.buffer, sets.conifer.colors.buffer]);
  },
};

export type TerrainApi = typeof api;

Comlink.expose(api);
