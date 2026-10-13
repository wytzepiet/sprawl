import { bendOf, edge, MIDDLE, mayAt, mayStart, nodeAtH, nodeIn, nodesOn, sidesBeside, spot, STEPS, TOP, toward, unlinked, type Hand, type Side } from "../engine/may";
import type { Build, GridCoord, TerrainType, Tool } from "../generated";

/**
 * What the road brush decides, apart from the pointer and the page
 * (`RoadBrush.tsx`), so a drag can be played without either
 * (`pen.test.ts`). A drag lays the road in hand a step at a time; with the
 * eraser, it pulls up what it crosses, and a tap takes the tile. Only on
 * the level's map, and never its own roads: the gates.
 *
 * The pen has a height (`want`, in half-levels). A drag starts on the road
 * at the pen's height on the tile pressed, or the one there nearest it;
 * each step goes on at its height, or, short of the pen's, climbs toward
 * it: the tile after a change of height is the slope. A step onto a road
 * already there at a height it may join takes that one.
 *
 * A one-way drawn along a one-way's tiles goes beside it, side by side,
 * on the side of the road it came from, else on the right (`decks.rs`).
 * Drawn along a road on a side, a drag keeps to it; drawn onto it from its
 * own side, it joins it there. A drag pressed where two roads share a
 * tile starts on the one nearer the pointer. A one-way stepping onto a
 * one-way in the middle of its tile joins it, for now: if its next step
 * goes on against that one, the step is laid again beside it.
 *
 * A change of the pen's height (↑ ↓) turns the end of the road last laid
 * into the slope to the new height, where it may be one: the road ends
 * there, nothing else joins it, it came to it on the level, and the tile
 * has room for a slope. Where it may not be, the pen alone changes, and
 * the next tile drawn is the slope. Raised by more than a level, the road
 * climbs on, a slope a level one after another, one eased climb.
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
  send(step: Build): void;
  /** The pen set to this many levels up. */
  lift(levels: number): void;
}

type Step = { from: GridCoord; pf: Place; to: GridCoord; pt: Place; on: boolean };

export class Pen {
  /** The tile the drag stands on, and where on it. */
  current: GridCoord | null = null;
  place: Place = GROUND;
  /** The tile the drag came to `current` from. */
  private came: GridCoord | null = null;
  private pressed: GridCoord | null = null;
  /** The last step of road laid: its end is what a change of height makes
   *  a slope. */
  private last: Step | null = null;
  /** A one-way's step onto a one-way it joined in the middle of its tile,
   *  laid for now: its next step says whether it stays, or goes beside. */
  private joined: Step | null = null;

  constructor(private d: Desk) {}

  private get world() {
    return this.d.world();
  }

  /** A drag pressed on a tile, at this point of it. */
  press(t: GridCoord, wx: number, wy: number) {
    this.current = this.pressed = t;
    this.place = this.startAt(t, wx, wy);
    this.came = null;
    this.joined = null;
  }

  /** One step of the drag, on to the next tile; false where it may not go. */
  step(next: GridCoord): boolean {
    const t = this.d.tool();
    const cur = this.current;
    if (!cur || t === null) return false;
    // The step laid for now, joined: beside the one-way it met, where the
    // drag goes on against it.
    if (this.joined) {
      const q = this.besideFor(t, this.joined, next);
      if (q) {
        const j = this.joined;
        this.send("Demolish", j.from, j.pf, j.to, j.pt, false, true);
        this.lay(t, j.from, j.pf, j.to, q, j.on);
        this.place = q;
      }
      this.joined = null;
    }
    const q = this.stepTo(cur, this.place, next);
    if (q === null) return false;
    if (this.came === null) this.place = this.splitAt(t, cur, this.place, next, q) ?? this.place;
    if (this.holds(t, next, q)) this.joined = { from: cur, pf: this.place, to: next, pt: q, on: this.came !== null };
    this.lay(t, cur, this.place, next, q, this.came !== null);
    this.came = cur;
    this.current = next;
    this.place = q;
    return true;
  }

  /** Let go: a tap's eraser or lights where it was pressed. */
  release() {
    const [t, p, w] = [this.d.tool(), this.pressed, this.world];
    if (p && this.current === p && w) {
      const place = this.place;
      if (t === "Demolish" && !(this.fixed(p) && !place.h && !sided(place))) this.lay(t, p, place, p, place, false);
      if (t === "Light" && mayAt(w, "Light", p, place.h, p, place.h, false, [place.s, place.s])) this.lay(t, p, place, p, place, false);
    }
    this.pressed = this.current = this.came = this.joined = null;
  }

  /** May the drag go from where it stands that way, a step of `STEPS`. */
  allowed(i: number): boolean {
    const at = this.current;
    return !!at && this.stepTo(at, this.place, { x: at.x + STEPS[i][0], y: at.y + STEPS[i][1] }) !== null;
  }

  /** May a drag start here. */
  mayStartHere(at: GridCoord): boolean {
    const [w, t] = [this.world, this.d.tool()];
    if (!w || t === null) return false;
    if (t === "Light") return nodesOn(w, at).some(([h, n]) => mayAt(w, t, at, h, at, h, false, [n.node.side ?? MIDDLE, n.node.side ?? MIDDLE]));
    if (this.d.want() > 0 && t !== "Demolish") return this.d.inside(at);
    if (!(mayStart(w, t, at, this.d.priority()) || nodesOn(w, at).length > 0)) return false;
    return t === "Demolish" ? !this.fixed(at) || STEPS.some(([dx, dy]) => this.allowedStep(t, at, GROUND, { x: at.x + dx, y: at.y + dy }, GROUND)) : this.d.inside(at);
  }

  /** What ↑ (1) or ↓ (-1) does to the road: the end of the road last laid
   *  made the slope there, where it may be one; none, where not, and the
   *  pen alone moves. */
  climb(by: 1 | -1): (() => void) | null {
    const w = this.world;
    const linked = !!w && !!this.last && !!nodeIn(w, this.last.to, this.last.pt.h, this.last.pt.s);
    const h = linked ? this.slopeTo(by) : null;
    return h === null ? null : () => this.makeSlope(by, h);
  }

  private send(tool: Tool, from: GridCoord, pf: Place, to: GridCoord, pt: Place, road: boolean, on: boolean) {
    this.d.send({
      tool, from, to, road, on,
      ...(pf.h || pt.h ? { up: [pf.h, pt.h] as [number, number] } : {}),
      ...(sided(pf) || sided(pt) ? { sides: [pf.s, pt.s] as [Side, Side] } : {}),
    });
  }

  /** A step sent; `on`, carrying on the drag's last, so the tile they
   *  share is one it passes through, turning there only as it went
   *  (`World::drawn`). */
  private lay(t: Tool, from: GridCoord, pf: Place, to: GridCoord, pt: Place, on: boolean) {
    this.send(t, from, pf, to, pt, this.d.priority(), on);
    if (t !== "Demolish" && t !== "Light" && (from.x !== to.x || from.y !== to.y)) this.last = { from, pf, to, pt, on };
  }

  /** One of the level's own roads: a gate's. */
  private fixed(t: GridCoord) {
    return this.world?.roads.get(`${t.x},${t.y}`)?.node.laid === false;
  }

  /** The height the end of the last road laid would take as the slope a
   *  level up (1) or down (-1), if it may be one: a road in the middle of
   *  its tile, as a slope has the tile to itself. */
  private slopeTo(by: 1 | -1): number | null {
    const [w, last] = [this.world, this.last];
    if (!w || !last || sided(last.pf) || sided(last.pt)) return null;
    const { from, pf: { h: hf }, to, pt: { h: ht } } = last;
    const [f, t] = [nodeAtH(w, from, hf), nodeAtH(w, to, ht)];
    if (!f || !t || !t.node.laid || hf !== ht || ht % 2) return null;
    const arms = new Set([...t.node.outgoing, ...t.node.incoming]);
    if (arms.size !== 1 || !arms.has(f.id)) return null;
    const h = ht + by;
    if (h < 1 || h > TOP - 1 || !this.d.inside(to)) return null;
    if (w.occupied.has(`${to.x},${to.y}`) || this.d.ground(to.x, to.y) === "Mountain") return null;
    // Room for it among the tile's other roads (`World::room_at`).
    return nodesOn(w, to).every(([g, n]) => n.id === t.id || Math.abs(g - h) >= 2 + (g % 2) + (h % 2)) ? h : null;
  }

  /** The end of the last road laid made the slope at height h: taken up
   *  and laid again, as it ran, with what it had; and the pen at the
   *  level it leads to. */
  private makeSlope(by: 1 | -1, h: number) {
    const w = this.world!;
    const { from, pf, to, pt, on } = this.last!;
    const [f, t] = [nodeAtH(w, from, pf.h)!, nodeAtH(w, to, pt.h)!];
    const road = f.node.road && t.node.road;
    const [out, back] = [edge(f, t), edge(t, f)];
    const wide = f.node.wide.includes(t.id) || t.node.wide.includes(f.id);
    const up: Place = { h, s: MIDDLE };
    this.send("Demolish", from, pf, to, pt, false, true);
    if (out && back) this.send("Street", from, pf, to, up, road, on);
    else if (out) this.send(wide ? "Wide" : "OneWay", from, pf, to, up, road, on);
    else this.send(wide ? "Wide" : "OneWay", to, up, from, pf, road, false);
    this.last = { from, pf, to, pt: up, on };
    if (this.current && this.current.x === to.x && this.current.y === to.y) this.place = up;
    this.d.lift((h + by) / 2);
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

  /** The sides a step from `at` (on `p`) to `to` at height `h` may take,
   *  the likeliest first: along a road already there, that road; on along
   *  the side it is on; onto a road on a side from that road's own side;
   *  beside a one-way there, along it, on the side the drag came from,
   *  else on the right; else the middle. A side is a tile's way across
   *  the road through it, straight on or round a bend. */
  private sidesFor(w: Hand, at: GridCoord, p: Place, to: GridCoord, h: number): Side[] {
    const d: [number, number] = [to.x - at.x, to.y - at.y];
    const right: Side = [-d[1], d[0]];
    const back: [number, number] = [at.x - to.x, at.y - to.y];
    const there = nodesOn(w, to).filter(([g, n]) => g === h && sided({ h: g, s: n.node.side ?? MIDDLE })).map(([, n]) => n.node.side!);
    const m = nodeAtH(w, to, h);
    const fromNode = nodeIn(w, at, p.h, p.s);
    // Beside a one-way in the middle, only along it and against it: come
    // in across it, the drag joins it, unless it goes on against it
    // (`joined`); going its way, the drag runs on into it.
    const along = (s: Side) => bendOf(w, to, h, s)?.some(([x, y]) => x === back[0] && y === back[1]) ?? toward(back, s) === 0;
    const against = !!m && [...m.node.outgoing, ...m.node.incoming].some((id) => {
      const o = w.at.get(id);
      const n = o && nodesOn(w, o).find(([, x]) => x.id === id)?.[1];
      if (!o || !n) return false;
      const [ox, oy] = [o.x - to.x, o.y - to.y];
      // Out toward where the drag comes from, or in from where it goes.
      return (edge(m, n) && toward(back, [ox, oy]) > 0) || (edge(n, m) && toward(d, [ox, oy]) > 0);
    });
    const beside = there.length ? there : m && against && !(fromNode && edge(fromNode, m)) ? sidesBeside(w, to, h).filter(along) : [];
    const came = this.came ? ([this.came.x - at.x, this.came.y - at.y] as [number, number]) : null;
    const rank = (s: Side) => (sided(p) ? -toward(p.s, s) : there.length && toward(back, s) > 0 ? -1 : came && toward(came, s) ? -toward(came, s) : -toward(right, s));
    const follow = fromNode ? nodesOn(w, to).filter(([g, n]) => g === h && (edge(fromNode, n) || edge(n, fromNode))).map(([, n]) => n.node.side ?? MIDDLE) : [];
    return [...follow, ...[...beside].sort((a, b) => rank(a) - rank(b)), MIDDLE];
  }

  /** Where a drag starting on a one-way in the middle of its tile and
   *  stepping off it beside the next tile's stands: beside it here too,
   *  on the side it goes on, so the two roads end side by side. */
  private splitAt(t: Tool, at: GridCoord, p: Place, to: GridCoord, q: Place): Place | null {
    if (sided(p) || !sided(q)) return null;
    const s = sidesBeside(this.world!, at, p.h).find((c) => toward(c, q.s) > 0);
    return s && this.allowedStep(t, at, { h: p.h, s }, to, q) ? { h: p.h, s } : null;
  }

  /** Does a step to `to` (standing at `q`) join a one-way in the middle
   *  of its tile that a one-way might have gone beside instead. */
  private holds(t: Tool, to: GridCoord, q: Place): boolean {
    const n = t === "OneWay" && !sided(q) ? nodeIn(this.world!, to, q.h, q.s) : undefined;
    return !!n && [...n.node.outgoing, ...n.node.incoming].some((id) => n.node.outgoing.includes(id) !== n.node.incoming.includes(id)) && sidesBeside(this.world!, to, q.h).length > 0;
  }

  /** Where on the joined step's tile the drag stands, going on to `to`
   *  against the one-way there: beside it, on the right of the way it
   *  goes; none, where it goes on with it, or may not go beside. Weighed
   *  as the world was before the step joined it. */
  private besideFor(t: Tool, j: Step, to: GridCoord): Place | null {
    const w0 = this.world!;
    const [a, n0] = [nodeIn(w0, j.from, j.pf.h, j.pf.s), nodeIn(w0, j.to, j.pt.h, j.pt.s)];
    if (!n0) return null;
    const w = a ? unlinked(w0, a.id, n0.id) : w0;
    const n = nodeIn(w, j.to, j.pt.h, j.pt.s)!;
    if (!nodesOn(w, to).some(([, o]) => edge(o, n))) return null;
    const right: Side = [-(to.y - j.to.y), to.x - j.to.x];
    for (const s of sidesBeside(w, j.to, j.pt.h).sort((x, y) => toward(right, y) - toward(right, x))) {
      const q: Place = { h: j.pt.h, s };
      if (this.allowedStep(t, j.from, j.pf, j.to, q, w)) return q;
    }
    return null;
  }

  /** Where a step from `at` (on `p`) to `to` would stand: the road there
   *  it may join, at the height it goes on at or climbs to and the side
   *  `sidesFor` gives; null where it may not go. The eraser takes
   *  whatever road joins them. */
  private stepTo(at: GridCoord, p: Place, to: GridCoord): Place | null {
    const [w, t] = [this.world, this.d.tool()];
    if (!w || t === null || t === "Light") return null;
    const want = this.d.want();
    const there = nodesOn(w, to).map(([g, n]): Place => ({ h: g, s: n.node.side ?? MIDDLE }));
    if (t === "Demolish") {
      const ok = there.filter((q) => mayAt(w, t, at, p.h, to, q.h, false, [p.s, q.s]));
      return ok.length ? ok.sort((a, b) => Math.abs(a.h - p.h) - Math.abs(b.h - p.h))[0] : null;
    }
    // Toward the pen's height: from a level, a slope; from a slope, the
    // next slope on while a level or more is left to climb, else the level.
    const by = Math.sign(want - p.h);
    const plan = p.h === want ? want : p.h % 2 && Math.abs(want - p.h) > 1 ? p.h + 2 * by : p.h + by;
    const heights = [plan, ...[...new Set(there.map((q) => q.h))].filter((g) => Math.abs(g - p.h) <= 1 && g !== plan).sort((a, b) => Math.abs(a - want) - Math.abs(b - want))];
    for (const h of heights) for (const s of this.sidesFor(w, at, p, to, h)) if (this.allowedStep(t, at, p, to, { h, s })) return { h, s };
    return null;
  }

  /** The level's rule over the world's: the server's (`Level::allows`). */
  private allowedStep(t: Tool, from: GridCoord, pf: Place, to: GridCoord, pt: Place, w = this.world): boolean {
    if (!w) return false;
    const ground = !pf.h && !pt.h && !sided(pf) && !sided(pt);
    if (t === "Demolish") return (from.x === to.x && from.y === to.y ? !(this.fixed(to) && ground) : !(this.fixed(from) && this.fixed(to) && ground)) && mayAt(w, t, from, pf.h, to, pt.h, false, [pf.s, pt.s]);
    // Along a road already there, the way it runs: the drag passes, and
    // turns as it goes (`World::drawn`).
    const [a, b] = [nodeIn(w, from, pf.h, pf.s), nodeIn(w, to, pt.h, pt.s)];
    if (a && b && (edge(a, b) || (t === "Street" && edge(b, a)))) return true;
    return this.d.inside(from) && this.d.inside(to) && mayAt(w, t, from, pf.h, to, pt.h, this.d.priority(), [pf.s, pt.s]);
  }
}
