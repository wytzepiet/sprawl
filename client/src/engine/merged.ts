import { addToScene, NEW, setThinInstanceColors, setThinInstances, type Mesh } from "./gpu";
import type { EngineContext } from "./Canvas";
import type { Casters } from "./DayNightCycle";
import { drop, meshOf, type MeshGeometry } from "./geometry";
import { live, stale } from "./still";

/**
 * Things of one shape and one material from many chunks, drawn as one mesh
 * a region: every tree, every lamp's pole, arm and head. A mesh is a draw,
 * and a draw, not its triangles, is what a small thing costs: on a real GPU
 * a hundred chunks' trees cost two milliseconds a frame drawn a chunk at a
 * time, where their vertices cost next to nothing. A chunk adds its
 * instances, in its own frame, and takes them away; the region's mesh holds
 * them all, shown while the view meets the region (`cull.ts`).
 */

/** A region's side, in tiles: two terrain chunks. A view far out over a
 *  big town meets a dozen or two; a chunk that comes or goes lays its
 *  region's instances out again, a forest's few thousand at most. */
const REGION = 64;

/** Some chunk's instances in a pile: 16 floats of matrix each, moved into
 *  the region's frame, and 4 of colour each, if the shape takes colours. */
export interface Part {
  pile: Pile;
  matrices: Float32Array;
  colors: Float32Array | null;
  shown: boolean;
  /** Where its chunk lies in the region: the pile lays its parts out in this order. */
  order: number;
}

interface Pile {
  mesh: Mesh;
  parts: Set<Part>;
  dirty: boolean;
  casts: boolean;
  casting: boolean;
  colored: boolean;
}

export interface Kind {
  /** The mesh's name, before its region. */
  name: string;
  geo: MeshGeometry;
  material: Mesh["material"];
  cast: boolean;
  receive: boolean;
  colored: boolean;
  /** Whether it moves on its own, a fan turning: drawn every frame over
   *  the still town, not into it (`still.ts`). */
  moves?: boolean;
}

const all = new WeakMap<EngineContext, Merged>();
/** The engine's one set of piles, made the first time it is asked for. */
export const merged = (ctx: EngineContext, casters: Casters | undefined) => {
  let m = all.get(ctx);
  if (!m) all.set(ctx, (m = new Merged(ctx)));
  m.casters ??= casters;
  return m;
};

class Merged {
  private piles = new Map<string, Pile>();
  private stale = new Set<Pile>();

  casters: Casters | undefined;

  constructor(private ctx: EngineContext) {
    ctx.beforeRender(() => this.flush());
  }

  /** A chunk's instances of a kind, its matrices in its frame at `at`. */
  add(kind: Kind, [ox, oy]: [number, number], matrices: Float32Array, colors: Float32Array | null = null): Part {
    const [rx, ry] = [Math.floor(ox / REGION), Math.floor(oy / REGION)];
    const pile = this.pile(kind, rx, ry);
    const own = matrices.slice();
    const [dx, dy] = [ox - rx * REGION, oy - ry * REGION];
    for (let i = 0; i < own.length; i += 16) (own[i + 12] += dx), (own[i + 13] += dy);
    const part: Part = { pile, matrices: own, colors: kind.colored ? colors : null, shown: true, order: dy * REGION + dx };
    pile.parts.add(part);
    this.touch(pile);
    return part;
  }

  remove(part: Part) {
    if (part.pile.parts.delete(part)) this.touch(part.pile);
  }

  /** A part drawn or not, whatever the view: under a building held, or
   *  detail let go far out. */
  show(part: Part, shown: boolean) {
    if (part.shown === shown) return;
    part.shown = shown;
    this.touch(part.pile);
  }

  private touch(pile: Pile) {
    pile.dirty = true;
    this.stale.add(pile);
  }

  private pile(kind: Kind, rx: number, ry: number): Pile {
    const key = `${kind.name}_${rx},${ry}`;
    let pile = this.piles.get(key);
    if (pile) return pile;
    const mesh = meshOf(this.ctx.engine, key, kind.geo);
    mesh.material = kind.material;
    mesh.receiveShadows = kind.receive;
    mesh.position.x = rx * REGION;
    mesh.position.y = ry * REGION;
    setThinInstances(mesh, new Float32Array(16), 0);
    if (kind.colored) setThinInstanceColors(mesh, new Float32Array(4));
    this.ctx.cull.keep(mesh, [rx * REGION - 2, ry * REGION - 2, (rx + 1) * REGION + 2, (ry + 1) * REGION + 2]);
    if (kind.moves) live(mesh);
    addToScene(this.ctx.scene, mesh);
    pile = { mesh, parts: new Set(), dirty: false, casts: kind.cast, casting: false, colored: kind.colored };
    this.piles.set(key, pile);
    return pile;
  }

  /** Each pile changed since the last frame, its instances laid end to end
   *  again: once a frame, however many chunks came and went in it. */
  private flush() {
    // Our renderer is told by the piles' meshes themselves, and patches round what moved.
    if (this.stale.size && !NEW) stale();
    for (const pile of this.stale) {
      // In the chunks' order, not as they came: a chunk's trees planted
      // again keep their place among the rest, so the picture is drawn
      // again where they stand and not the region over (`render/patch.ts`).
      const shown = [...pile.parts].filter((p) => p.shown).sort((a, b) => a.order - b.order);
      const count = shown.reduce((n, p) => n + p.matrices.length / 16, 0);
      const matrices = new Float32Array(Math.max(1, count) * 16);
      const colors = pile.colored ? new Float32Array(Math.max(1, count) * 4) : null;
      let at = 0;
      for (const p of shown) {
        matrices.set(p.matrices, at * 16);
        if (colors && p.colors) colors.set(p.colors, at * 4);
        at += p.matrices.length / 16;
      }
      setThinInstances(pile.mesh, matrices, count);
      if (colors) setThinInstanceColors(pile.mesh, colors);
      this.ctx.cull.want(pile.mesh, count > 0);
      const cast = pile.casts && count > 0;
      if (cast !== pile.casting) {
        if (cast) this.casters?.add(pile.mesh);
        else this.casters?.remove(pile.mesh);
        pile.casting = cast;
      }
      pile.dirty = false;
    }
    this.stale.clear();
  }

  dispose() {
    for (const pile of this.piles.values()) {
      this.casters?.remove(pile.mesh);
      this.ctx.cull.forget(pile.mesh);
      drop(this.ctx.scene, pile.mesh);
    }
    this.piles.clear();
  }
}
