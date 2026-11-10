import type { Place } from "../engine/pen";
import type { GameObjectEntry, GridCoord, RoadNode } from "../generated";
import type { Laid } from "./planner";

/**
 * What the hand did, shown the moment it does it, before the game has
 * said (`gameObjects.tsx` keeps them over what the game said): a drag of
 * road as the game's own planner laid it (`planner.ts`), exactly; a cut
 * of the eraser or a tap of the demolisher, the plainest guess, a link
 * taken away. What the game made of it comes back a round trip later
 * (`ServerMessage::Seen`) and stands in its place. A guess the game never
 * answers is dropped after `STALE_MS`.
 */
export type Guess =
  | { type: "Laid"; laid: Laid }
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
  const take = (list: number[], id: number) => list.splice(0, list.length, ...list.filter((i) => i !== id));
  /** Two nodes no longer linked; one left with no link at all, gone. */
  const part = (a: Node, b: Node) => {
    for (const [x, y] of [[a, b], [b, a]]) for (const l of [x.object.data.outgoing, x.object.data.incoming, x.object.data.road, x.object.data.wide]) take(l, y.id);
    for (const n of [a, b]) n.object.data.outgoing.length || n.object.data.incoming.length ? ground.put(n) : ground.drop(n.id);
  };

  switch (g.type) {
    case "Laid": {
      // The planner's own ids, new to the game, as the guess's: or, where
      // the game has since laid its own node in the same place, as that.
      const ids = new Map<number, number>();
      for (const e of g.laid.put) {
        if (e.id < g.laid.fresh || e.object.kind !== "RoadNode" || !e.position) continue;
        const n = e.object.data;
        ids.set(e.id, nodeIn(e.position, { h: n.height, s: n.side as Place["s"] })?.id ?? fresh());
      }
      const id = (i: number) => ids.get(i) ?? i;
      for (const e of g.laid.put) {
        if (e.object.kind !== "RoadNode") ground.put({ ...e, id: id(e.id) });
        else {
          const n = e.object.data;
          const links = { outgoing: n.outgoing.map(id), incoming: n.incoming.map(id), road: n.road.map(id), wide: n.wide.map(id) };
          ground.put({ ...e, id: id(e.id), object: { kind: "RoadNode", data: { ...n, ...links } } });
        }
      }
      for (const i of g.laid.drop) ground.drop(i);
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
