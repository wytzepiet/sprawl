import type { InstancePool } from "../InstancePool";
import type { Theme } from "../theme";
import { lay } from ".";
import { block, dress, open, type Ground } from "./rules";

const key = (x: number, y: number) => `${x},${y}`;
const unkey = (k: string) => k.split(",").map(Number) as [number, number];

/**
 * What the tiles that are not buildings wear: a street's trees and lamps, a
 * junction's crossings, a block's garden. Buildings draw their own pieces,
 * since a building is picked, tinted and remounted as one thing.
 *
 * Told which tiles changed, it redraws them. A block's middle is one thing,
 * so touching any tile of a garden redraws the whole of it, and a block
 * found closed is drawn whole.
 */
export class Dressing {
  private drawn = new Map<string, { key: string; id: number }[]>();
  /** Each garden tile's whole block. */
  private gardens = new Map<string, string[]>();

  constructor(
    private pool: InstancePool,
    private theme: () => Theme,
    private ground: Ground,
  ) {}

  redraw(tiles: Set<string>) {
    const queue = new Set(tiles);
    for (const t of tiles) {
      const [x, y] = unkey(t);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const k of this.gardens.get(key(x + dx, y + dy)) ?? []) queue.add(k);
    }
    const blocks = new Map<string, string[] | null>();
    for (const t of queue) {
      const [x, y] = unkey(t);
      if (open(this.ground, x, y) && !blocks.has(t)) {
        const b = block(this.ground, x, y);
        const tiles = b.tiles.map(([bx, by]) => key(bx, by));
        for (const k of tiles) blocks.set(k, b.enclosed ? tiles : null);
        if (b.enclosed) for (const k of tiles) queue.add(k);
      }
      const garden = blocks.get(t) ?? null;
      if (garden) this.gardens.set(t, garden);
      else this.gardens.delete(t);
      this.undraw(t);
      const placed = dress(this.ground, x, y, !!garden);
      if (placed.length) this.drawn.set(t, lay(this.pool, this.theme(), placed));
    }
  }

  /** Forget a square of tiles, as when its chunk leaves. */
  forget(x0: number, y0: number, size: number) {
    for (let y = y0; y < y0 + size; y++) {
      for (let x = x0; x < x0 + size; x++) {
        this.undraw(key(x, y));
        this.gardens.delete(key(x, y));
      }
    }
  }

  private undraw(t: string) {
    for (const { key, id } of this.drawn.get(t) ?? []) this.pool.removeInstance(key, id);
    this.drawn.delete(t);
  }

  dispose() {
    for (const t of [...this.drawn.keys()]) this.undraw(t);
    this.gardens.clear();
  }
}
