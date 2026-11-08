import type { Place } from "../engine/pen";
import type { GameObjectEntry, GridCoord, RoadNode, Tool } from "../generated";

/**
 * What the hand did, shown the moment it does it, before the game has
 * said (`gameObjects.tsx` keeps them over what the game said): a road
 * laid a step, one cut, a tap of the demolisher. The game lays by rules
 * the client does not know, so this is a guess of the plainest kind, a
 * link from one place to the next; what the game made of the step comes
 * back a round trip later (`ServerMessage::Seen`) and stands in its place,
 * whatever it was. A guess the game never answers is dropped after
 * `STALE_MS`.
 */
export type Guess =
  | { type: "Link"; from: GridCoord; pf: Place; to: GridCoord; pt: Place; tool: Tool; road: boolean }
  | { type: "Cut"; from: GridCoord; pf: Place; to: GridCoord; pt: Place }
  | { type: "Tap"; at: GridCoord; place: Place };

export const STALE_MS = 3000;

type Node = GameObjectEntry & { object: { kind: "RoadNode"; data: RoadNode } };

/** The world as a guess reads and writes it. */
export interface Ground {
  at(t: GridCoord): GameObjectEntry[];
  get(id: number): GameObjectEntry | undefined;
  building(t: GridCoord): GameObjectEntry | undefined;
  put(e: GameObjectEntry): void;
  drop(id: number): void;
}

/** A guess made on the ground; `fresh` names the roads it lays where
 *  none stood, the same each time it is made again. */
export function make(g: Guess, ground: Ground, fresh: () => number) {
  const nodeIn = (t: GridCoord, p: Place) => ground.at(t).find((e): e is Node => e.object.kind === "RoadNode" && e.object.data.height === p.h && e.object.data.side[0] === p.s[0] && e.object.data.side[1] === p.s[1]);
  /** A node to change: a copy, so what the game said is kept as it was. */
  const edit = (e: Node): Node => ({ ...e, object: { kind: "RoadNode", data: { ...e.object.data, outgoing: [...e.object.data.outgoing], incoming: [...e.object.data.incoming], road: [...e.object.data.road], wide: [...e.object.data.wide] } } });
  const laid = (t: GridCoord, p: Place): Node =>
    nodeIn(t, p) ?? { id: fresh(), position: t, object: { kind: "RoadNode", data: { outgoing: [], incoming: [], joined: false, road: [], laid: true, height: p.h, light: null, wide: [], side: p.s } } };
  const add = (list: number[], id: number) => list.includes(id) || list.push(id);
  const take = (list: number[], id: number) => list.splice(0, list.length, ...list.filter((i) => i !== id));
  /** Two nodes no longer linked; one left with no link at all, gone. */
  const part = (a: Node, b: Node) => {
    for (const [x, y] of [[a, b], [b, a]]) for (const l of [x.object.data.outgoing, x.object.data.incoming, x.object.data.road, x.object.data.wide]) take(l, y.id);
    for (const n of [a, b]) n.object.data.outgoing.length || n.object.data.incoming.length ? ground.put(n) : ground.drop(n.id);
  };

  switch (g.type) {
    case "Link": {
      const [a, b] = [edit(laid(g.from, g.pf)), edit(laid(g.to, g.pt))];
      const [na, nb] = [a.object.data, b.object.data];
      add(na.outgoing, b.id);
      add(nb.incoming, a.id);
      if (g.tool === "Street") add(nb.outgoing, a.id), add(na.incoming, b.id);
      if (g.tool === "Wide") add(na.wide, b.id);
      if (g.road) add(na.road, b.id), add(nb.road, a.id);
      else take(na.road, b.id), take(nb.road, a.id);
      na.joined = nb.joined = na.joined || nb.joined;
      ground.put(a);
      ground.put(b);
      return;
    }
    case "Cut": {
      const [a, b] = [nodeIn(g.from, g.pf), nodeIn(g.to, g.pt)];
      if (a && b) part(edit(a), edit(b));
      return;
    }
    case "Tap": {
      const n = nodeIn(g.at, g.place);
      if (!n) {
        const b = g.place.h ? undefined : ground.building(g.at);
        if (b) ground.drop(b.id);
        return;
      }
      for (const id of new Set([...n.object.data.outgoing, ...n.object.data.incoming])) {
        const o = ground.get(id);
        if (o?.object.kind === "RoadNode") part(edit(n), edit(o as Node));
      }
      ground.drop(n.id);
      return;
    }
  }
}
