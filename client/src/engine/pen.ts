import { MIDDLE, spot, STEPS, TOP, type Side } from "./tiles";
import type { Area, Build, ClientMessage, GridCoord, Hint, Stand, Stroke, Tool } from "../generated";

/**
 * The hand's drag, apart from the pointer and the page (`RoadBrush.tsx`,
 * `Brush.tsx`), so a drag can be played without either (`pen.test.ts`):
 * what it sends, and what it waits for. Where it may go is the game's to
 * say (`server/src/hint.rs`), by the rules it lays by: before a drag, the
 * tiles in view one may start from (`Ask::Starts`); during one, the steps
 * on from the tile it is on (`Ask::Reach`), asked again at each tile and
 * waited for, a step not yet answered not taken.
 *
 * A drag of road is sent whole as it goes (`Stroke`), and the game plans
 * and lays it (`server/src/draw.rs`). The eraser goes a step at a time,
 * standing where the game says it would. A tap takes, or lights, what
 * stands where it was pressed.
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
const sided = (p: Place) => !!(p.s[0] || p.s[1]);

/** What the pen reads and writes: the roads where it is pressed, the tool
 *  in hand, the pen's height and priority, and the line to the game. */
export interface Desk {
  /** Where each road on a tile stands. */
  roads(t: GridCoord): Place[];
  tool(): Tool | null;
  /** The pen's height, in half-levels. */
  want(): number;
  priority(): boolean;
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
  /** The tiles in view a drag may start from, as the game last said. */
  starts: GridCoord[] = [];
  /** Where on its tile the eraser, or a tap, stands. */
  private place: Place = GROUND;
  private pressed: GridCoord | null = null;
  /** The drag: of road, sent whole, kept after it for ↑ and ↓; the
   *  eraser's, its tiles, and where it stands on the last (`start`). */
  private stroke: Stroke | null = null;
  /** Where the drag would stand a step on, each of `STEPS`, as the game
   *  said; none, not yet said. */
  private ways: (Stand | null)[] | null = null;
  /** What the starts were last asked of. */
  private asked = "";

  constructor(private d: Desk) {}

  /** A drag pressed on a tile, at this point of it. */
  press(t: GridCoord, wx: number, wy: number) {
    this.current = this.pressed = t;
    this.place = this.startAt(t, wx, wy);
    const tool = this.d.tool();
    const on = this.d.roads(t).length > 0;
    const start = { h: this.place.h, side: this.place.s };
    this.stroke =
      tool === null || tool === "Light" ? null
      : tool === "Demolish" ? { id: ++drags, tool, road: false, tiles: [{ at: t, want: 0 }], start }
      : { id: ++drags, tool, road: this.d.priority(), tiles: [{ at: t, want: this.d.want() }], ...(on ? { start } : {}) };
    this.ask();
  }

  /** One step of the drag, on to the next tile: false where it may not
   *  go, or the game has not yet said. */
  step(next: GridCoord): boolean {
    const [cur, s] = [this.current, this.stroke];
    const i = cur ? STEPS.findIndex(([dx, dy]) => cur.x + dx === next.x && cur.y + dy === next.y) : -1;
    const to = i < 0 ? null : this.way(i);
    if (!cur || !s || !to) return false;
    s.tiles.push({ at: next, want: this.d.want() });
    if (s.tool === "Demolish") {
      const q = { h: to.h, s: to.side as Side };
      this.send({ tool: "Demolish", from: cur, to: next, road: false, ...placed(this.place, q) });
      this.place = q;
      s.start = to;
    } else this.d.send({ type: "Draw", data: s });
    this.current = next;
    this.ask();
    return true;
  }

  /** The drag pulled toward a point, heading a way of `STEPS`: on, a step
   *  at a time, while each brings it nearer and may be taken. The tiles
   *  it stepped onto. */
  pull(wx: number, wy: number, heading: number): GridCoord[] {
    const [sx, sy] = STEPS[heading];
    const off = (t: GridCoord) => Math.max(Math.abs(wx - (t.x + 0.5)), Math.abs(wy - (t.y + 0.5)));
    const went: GridCoord[] = [];
    for (let cur = this.current; cur && off(cur) >= 0.6; cur = this.current) {
      const next = { x: cur.x + sx, y: cur.y + sy };
      if (off(next) >= off(cur) || !this.step(next)) break;
      went.push(next);
    }
    return went;
  }

  /** Let go: a tap's eraser or lights where it was pressed. */
  release() {
    const [t, p, place] = [this.d.tool(), this.pressed, this.place];
    if (p && this.current === p && (t === "Demolish" || t === "Light")) this.send({ tool: t, from: p, to: p, road: false, ...placed(place, place) });
    if (this.stroke && (this.stroke.tool === "Demolish" || this.stroke.tiles.length < 2)) this.stroke = null;
    this.pressed = this.current = null;
    this.ways = null;
  }

  /** May the drag go from where it stands that way, a step of `STEPS`. */
  allowed(i: number): boolean {
    return !!this.current && !!this.way(i);
  }

  /** The game's word, if it is for the pen: whether it was. */
  hear(h: Hint): boolean {
    if (h.type === "Reach") {
      const s = this.stroke;
      if (!s || !this.current || h.data.id !== s.id || h.data.len !== s.tiles.length) return false;
      this.ways = h.data.ways;
      return true;
    }
    if (h.type === "Starts" && h.data.hand.type === "Tool") {
      const { tool, road, want } = h.data.hand.data;
      if (startsKey(tool, road, want, h.data.area) !== this.asked) return false;
      this.starts = h.data.tiles;
      return true;
    }
    return false;
  }

  /** Ask which tiles of the view a drag may start from, unless asked
   *  already; `afresh`, again, the world having changed. */
  view(area: Area, afresh = false) {
    const tool = this.d.tool();
    if (tool === null) return void ((this.starts = []), (this.asked = ""));
    const [road, want] = [this.d.priority(), this.d.want()];
    const key = startsKey(tool, road, want, area);
    if (key === this.asked && !afresh) return;
    this.asked = key;
    this.d.send({ type: "Ask", data: { type: "Starts", data: { hand: { type: "Tool", data: { tool, road, want } }, area } } });
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
      if (!s || s.tool === "Demolish") return;
      s.tiles[s.tiles.length - 1].want = want;
      this.d.send({ type: "Draw", data: s });
      if (this.current) this.ask();
    };
  }

  private way(i: number): Stand | null {
    return this.ways?.[i] ?? null;
  }

  /** Where the drag may go on from here: asked, and until said, nowhere. */
  private ask() {
    this.ways = null;
    if (this.stroke && this.current) this.d.send({ type: "Ask", data: { type: "Reach", data: this.stroke } });
  }

  private send(data: Build) {
    this.d.send({ type: "Build", data });
  }

  /** Where a drag pressed here, at this point of the tile, stands: on the
   *  road at the pen's height, or the one there nearest it, the nearer
   *  the pointer of two side by side; or at the pen's height. */
  private startAt(t: GridCoord, wx: number, wy: number): Place {
    const want = this.d.want();
    const on = this.d.roads(t);
    if (!on.length) return { h: want, s: MIDDLE };
    const off = (p: Place) => {
      const [x, y] = spot(t, p.s);
      return Math.abs(p.h - want) * 10 + Math.hypot(x - wx, y - wy);
    };
    return on.sort((a, b) => off(a) - off(b))[0];
  }
}

const startsKey = (tool: Tool, road: boolean, want: number, a: Area) => [tool, road, want, a.x0, a.y0, a.x1, a.y1].join();

/** A step's heights and sides, as `Build` carries them: none where both
 *  ends are on the ground in the middle. */
function placed(p: Place, q: Place): Pick<Build, "up" | "sides"> {
  return { ...(p.h || q.h ? { up: [p.h, q.h] as [number, number] } : {}), ...(sided(p) || sided(q) ? { sides: [p.s, q.s] as [Side, Side] } : {}) };
}
