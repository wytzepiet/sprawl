import { edge, MIDDLE, mayAt, mayStart, nodeIn, nodesOn, sidesBeside, spot, STEPS, TOP, type Hand, type Side } from "../engine/may";
import type { Build, ClientMessage, GridCoord, Stroke, TerrainType, Tool } from "../generated";

/**
 * What the road brush decides, apart from the pointer and the page
 * (`RoadBrush.tsx`), so a drag can be played without either
 * (`pen.test.ts`). A drag of road is sent whole as it goes, a tile on
 * each time (`Stroke`), and the game plans it (`server/src/draw.rs`):
 * heights, sides, what it joins. The pen says only where it may go next,
 * a hint for the dots and for the drag to wait at (`reach`), the game's
 * word final. The eraser goes a step at a time, and a tap takes the tile.
 *
 * A drag starts on the road on the tile pressed nearest the pointer and
 * the pen's height, or at the pen's height. Each tile carries the pen's
 * height as the drag reached it: changed (↑ ↓), the drag's last tile
 * becomes the slope to it if it may, else the next, and on, a slope a
 * level, to the height. After the drag, the same: its end the slope.
 */

/** Where on a tile a drag stands: how high, in half-levels, and on which
 *  side (`RoadNode::height`, `RoadNode::side`). */
export type Place = { h: number; s: Side };
export const GROUND: Place = { h: 0, s: MIDDLE };
export const sided = (p: Place) => !!(p.s[0] || p.s[1]);

/** What the pen reads and writes: the world as last heard, the tool in
 *  hand, the pen's height and priority, the level's map, and the line to
 *  the game. */
export interface Desk {
  world(): Hand | null;
  tool(): Tool | null;
  /** The pen's height, in half-levels. */
  want(): number;
  priority(): boolean;
  inside(t: GridCoord): boolean;
  ground(x: number, y: number): TerrainType | undefined;
  send(msg: ClientMessage): void;
  /** The pen set to this many levels up. */
  lift(levels: number): void;
}

/** Which drag is which (`Stroke::id`): from anywhere, so a page loaded
 *  again does not take up the drags of the one before. */
let drags = Math.floor(Math.random() * 2 ** 30);

export class Pen {
  /** The tile the drag stands on. */
  current: GridCoord | null = null;
  /** Where on it it was pressed; the eraser's, where on it it stands. */
  private place: Place = GROUND;
  private pressed: GridCoord | null = null;
  /** The drag of road, or the last: what ↑ and ↓ make a slope the end of. */
  private stroke: Stroke | null = null;

  constructor(private d: Desk) {}

  private get world() {
    return this.d.world();
  }

  /** A drag pressed on a tile, at this point of it. */
  press(t: GridCoord, wx: number, wy: number) {
    this.current = this.pressed = t;
    this.place = this.startAt(t, wx, wy);
    const tool = this.d.tool();
    const on = !!this.world && nodesOn(this.world, t).length > 0;
    this.stroke = tool === "Street" || tool === "OneWay" || tool === "Wide" ? { id: ++drags, tool, road: this.d.priority(), tiles: [{ at: t, want: this.d.want() }], ...(on ? { start: { h: this.place.h, side: this.place.s } } : {}) } : null;
  }

  /** One step of the drag, on to the next tile; false where it may not go. */
  step(next: GridCoord): boolean {
    const [t, cur] = [this.d.tool(), this.current];
    if (!cur || t === null || !this.reach(cur, next)) return false;
    if (t === "Demolish") {
      const q = this.cut(cur, this.place, next)!;
      this.send({ tool: t, from: cur, to: next, road: false, ...placed(this.place, q) });
      this.place = q;
    } else if (this.stroke) {
      this.stroke.tiles.push({ at: next, want: this.d.want() });
      this.d.send({ type: "Draw", data: this.stroke });
    }
    this.current = next;
    return true;
  }

  /** Let go: a tap's eraser or lights where it was pressed. */
  release() {
    const [t, p, w] = [this.d.tool(), this.pressed, this.world];
    if (p && this.current === p && w) {
      const place = this.place;
      if (t === "Demolish" && !(this.fixed(p) && !place.h && !sided(place))) this.send({ tool: t, from: p, to: p, road: false, ...placed(place, place) });
      if (t === "Light" && mayAt(w, "Light", p, place.h, p, place.h, false, [place.s, place.s])) this.send({ tool: t, from: p, to: p, road: false, ...placed(place, place) });
    }
    if (this.stroke && this.stroke.tiles.length < 2) this.stroke = null;
    this.pressed = this.current = null;
  }

  /** May the drag go from where it stands that way, a step of `STEPS`. */
  allowed(i: number): boolean {
    const at = this.current;
    return !!at && this.reach(at, { x: at.x + STEPS[i][0], y: at.y + STEPS[i][1] });
  }

  /** May a drag start here. */
  mayStartHere(at: GridCoord): boolean {
    const [w, t] = [this.world, this.d.tool()];
    if (!w || t === null) return false;
    if (t === "Light") return nodesOn(w, at).some(([h, n]) => mayAt(w, t, at, h, at, h, false, [n.node.side ?? MIDDLE, n.node.side ?? MIDDLE]));
    if (this.d.want() > 0 && t !== "Demolish") return this.d.inside(at);
    if (!(mayStart(w, t, at, this.d.priority()) || nodesOn(w, at).length > 0)) return false;
    return t === "Demolish" ? !this.fixed(at) || STEPS.some(([dx, dy]) => this.cut(at, GROUND, { x: at.x + dx, y: at.y + dy }) !== null) : this.d.inside(at);
  }

  /** What ↑ (1) or ↓ (-1) does: the pen a level up or down, and the end of
   *  the drag, or the last, the slope to it where it may be; none at the
   *  top or the bottom. */
  climb(by: 1 | -1): (() => void) | null {
    const want = this.d.want() + 2 * by;
    if (want < 0 || want > TOP) return null;
    return () => {
      this.d.lift(want / 2);
      const s = this.stroke;
      if (!s) return;
      s.tiles[s.tiles.length - 1].want = want;
      this.d.send({ type: "Draw", data: s });
    };
  }

  private send(data: Build) {
    this.d.send({ type: "Build", data });
  }

  /** One of the level's own roads: a gate's. */
  private fixed(t: GridCoord) {
    return this.world?.roads.get(`${t.x},${t.y}`)?.node.laid === false;
  }

  /** Where a drag pressed here, at this point of the tile, stands: on the
   *  road at the pen's height, or the one there nearest it, the nearer
   *  the pointer of two side by side; or at the pen's height. */
  private startAt(t: GridCoord, wx: number, wy: number): Place {
    const want = this.d.want();
    const on = this.world ? nodesOn(this.world, t) : [];
    if (!on.length) return { h: want, s: MIDDLE };
    const off = ([, n]: (typeof on)[number]) => {
      const [x, y] = spot(t, n.node.side ?? MIDDLE);
      return Math.abs(n.node.height - want) * 10 + Math.hypot(x - wx, y - wy);
    };
    const [, n] = on.sort((a, b) => off(a) - off(b))[0];
    return { h: n.node.height, s: n.node.side ?? MIDDLE };
  }

  /** May a step go from `at` to `to`, as far as the hand can tell: the
   *  eraser, if there is road between them to cut; a road, if some way of
   *  standing on the two tiles may be laid, or there is road along it. */
  private reach(at: GridCoord, to: GridCoord): boolean {
    const [w, t] = [this.world, this.d.tool()];
    if (!w || t === null || t === "Light") return false;
    if (t === "Demolish") return this.cut(at, this.place, to) !== null;
    if (!this.d.inside(at) || !this.d.inside(to)) return false;
    const here: Place[] = [...nodesOn(w, at).map(([h, n]) => ({ h, s: n.node.side ?? MIDDLE })), { h: this.d.want(), s: MIDDLE }];
    const heights = (h: number) => [h - 1, h, h + 1].filter((g) => g >= 0 && g <= TOP);
    const there = (h: number): Place[] => [...nodesOn(w, to).map(([g, n]) => ({ h: g, s: n.node.side ?? MIDDLE })), ...heights(h).flatMap((g) => [MIDDLE, ...sidesBeside(w, to, g)].map((s) => ({ h: g, s })))];
    return here.some((p) =>
      there(p.h).some((q) => {
        const [a, b] = [nodeIn(w, at, p.h, p.s), nodeIn(w, to, q.h, q.s)];
        return (a && b && (edge(a, b) || edge(b, a))) || mayAt(w, t, at, p.h, to, q.h, this.d.priority(), [p.s, q.s]);
      }),
    );
  }

  /** Where the eraser's step from `at` (on `p`) to `to` takes up road: the
   *  road there joined to it nearest its height; none, none. */
  private cut(at: GridCoord, p: Place, to: GridCoord): Place | null {
    const w = this.world;
    if (!w) return null;
    const ground = (q: Place) => !p.h && !q.h && !sided(p) && !sided(q);
    const ok = nodesOn(w, to)
      .map(([g, n]): Place => ({ h: g, s: n.node.side ?? MIDDLE }))
      .filter((q) => mayAt(w, "Demolish", at, p.h, to, q.h, false, [p.s, q.s]) && !(this.fixed(at) && this.fixed(to) && ground(q)));
    return ok.length ? ok.sort((a, b) => Math.abs(a.h - p.h) - Math.abs(b.h - p.h))[0] : null;
  }
}

/** A step's heights and sides, as `Build` carries them: none where both
 *  ends are on the ground in the middle. */
function placed(p: Place, q: Place): Pick<Build, "up" | "sides"> {
  return { ...(p.h || q.h ? { up: [p.h, q.h] as [number, number] } : {}), ...(sided(p) || sided(q) ? { sides: [p.s, q.s] as [Side, Side] } : {}) };
}
