import type { EngineContext } from "../Canvas";
import { hex, lerp, type Rgb } from "../rgb";
import type { InstancePool } from "../InstancePool";
import { boxGeometry } from "./buildings";
import { BLUEPRINTS, FACINGS, standing } from "../../blueprints";
import { KERB_Z } from "../town/draw";
import { INSET } from "../town/footprint";
import { eaves } from "../town/mass";
import { storeysOf } from "../town/grid";
import { keepField } from "./field";
import { shownTimeOfDay } from "../DayNightCycle";
import { placeShape } from "./CarObject";
import { FORKLIFT, FORKS, itemOf, ITEMS } from "./goods";
import { DEPOT } from "./depot";
import { SHOP } from "./shop";
import { HOUSES } from "./house";
import { FARM } from "./farm";
import { QUARRY } from "./quarry";
import { BARN_DOOR, SAWMILL } from "./sawmill";
import { glow, glowing, placing } from "./finishes";
import type { Built } from "./kit";
import { clearProps, placeProps } from "../props";
import { PROP_FLOATS } from "../town/layer";
import { PROP_KINDS } from "../town/roof";
import { stand } from "../trees";
import { atPad, DROP, ends, packagesOf, padOf, PICK, placeIn, progress, setLifts, type Bay } from "./pads";
import { carried, deckSeen, slotOn } from "./motion";
import { getEntity } from "../../state/gameObjects";
import { simNow } from "../../network/clock";
import { HANDLE_MS } from "../../generated/rows";
import type { Look } from "./look";
import type { Theme } from "../theme";
import type { Building, Car, GameObjectEntry, Lift, Pose } from "../../generated";

/** A building drawn whole from the kit (`kit.ts`), by its kind: its
 *  buckets' name, its model and which way round. A house is one of a few
 *  by its id, as if at random, so a street of them is mixed; a house and
 *  a farm every other one the other way round; a sawmill's wing
 *  and a quarry's hut on the gate's side. */
function wholeOf(kind: Building["kind"], id: number, gate: 1 | -1): [string, Built, 1 | -1] | null {
  const odd = id % 2 ? 1 : -1;
  if (kind === "House") {
    const k = (Math.imul(id, 0x9e3779b1) >>> 7) % HOUSES.length;
    return [`house${k}`, HOUSES[k], odd];
  }
  // A shop's door at the end its lunch table stands, its goods before its window.
  if (kind === "Shop") return ["shop", SHOP, -1];
  if (kind === "Depot") return ["depot", DEPOT, 1];
  if (kind === "Farm") return ["farm", FARM, odd];
  if (kind === "Sawmill") return ["sawmill", SAWMILL, gate];
  if (kind === "Quarry") return ["quarry", QUARRY, gate];
  return null;
}
/** Each model's finishes placed, made once. */
const placings = new Map<string, ReturnType<typeof placing>>();
const placed_ = (key: string, it: Built) => placings.get(key) ?? (placings.set(key, placing(key, it)), placings.get(key)!);

/** Each engine's glass told the night, once a frame, from the first
 *  model with windows on (`finishes.ts`). */
const told = new WeakSet<EngineContext>();
const lights = (ctx: EngineContext) => void (told.has(ctx) || (told.add(ctx), ctx.beforeRender(glow)));

/** The ferry's berth, out from the quay's edge (`town/draw.ts`): the link
 *  span over its land end, the dolphins it lies between, this far either
 *  side of its middle, out along it, and how far down they stand into the
 *  water (0.7 under the land). */
const SPAN = { across: 0.5, out: 0.36 };
const DOLPHINS = { across: 0.6, out: [0.95, 2.45], foot: -0.8 };
/** A site's walls going up: how thick. */
const WALL = 0.05;
/** The link span's steel, its gantry's towers and beam, the dolphins'
 *  concrete, their fenders and the bollards' iron, the walkway's boards;
 *  a site's slab and scaffolding, timber and stone. */
const STEEL = hex("#6B7078");
const TOWER = hex("#E9E6DF");
const CONCRETE = hex("#B9B4AA");
const IRON = hex("#2E3238");
const BOARDS = hex("#8C7A64");
const SLAB = hex("#BDB2A0");
const SCAFFOLD = hex("#9AA3AD");
const FLOOR = hex("#9E9A92");
const CRANE = hex("#E9B530");
/** A shop's lunch table and its parasol. */
const PARASOL = hex("#F1EADB");
const WHITE_RGB = hex("#FFFFFF");
/** How many packages of what it makes each building had when last
 *  mounted: one more is one just made. */
const seen = new Map<number, number>();
/** Heights in steps of a hundredth, so a site's buckets are few. */
const round = (h: number) => Math.max(0.01, Math.round(h * 100) / 100);
/**
 * What a building lays on the ground past its own walls, which the town
 * grid does not draw: a harbour's quay out over the water, a farm's
 * field, and a site going up. The building itself, once
 * it stands, is the town grid's (`TownLayer`).
 */
export function mountBuilding(
  entry: GameObjectEntry,
  pool: InstancePool,
  ctx: EngineContext,
  theme: Theme,
  look: Look,
): () => void {
  const data = entry.object.data as Building;
  const placed: { key: string; id: number }[] = [];

  /** A box `w` across, `l` out and `h` high, painted, in a frame round
   *  (x, y) whose out is (ox, oy): `across` and `out` from it, its base
   *  at `z`. */
  const { at: [mx, my], size: [bw, bh] } = standing(data);
  const [dx, dy] = FACINGS[data.facing % 4];
  const put = (name: string, [w, l, h]: number[], colour: Rgb, [x, y]: number[], [ox, oy]: number[], across: number, out: number, z: number) => {
    const key = `${name}_${w}_${l}_${h}${look.key}`;
    pool.ensureBucket(key, boxGeometry(w, l, h), look.tint(colour), true, true);
    const one = { key, id: pool.addInstance(key, [x - oy * across + ox * out, y + ox * across + oy * out, z + h / 2], [0, 0, Math.atan2(oy, ox) - Math.PI / 2]) };
    placed.push(one);
    return one;
  };

  // A harbour's berth, behind the middle of its back, where its paving
  // meets the water as a quay: a link span from the quay's edge down onto
  // the ferry's land end, under a gantry on two towers that lifts it; two
  // dolphins either side of the ferry, out along it, that it lies between,
  // a walkway out to those on one side; bollards along the quay. In a
  // corner on the quay, the terminal: the harbour master's and the
  // ticket office.
  if (BLUEPRINTS[data.kind].quay) {
    const out = [-dx, -dy];
    const deep = dx === 0 ? bh : bw;
    const wide = dx === 0 ? bw : bh;
    const edge = [mx + out[0] * deep / 2, my + out[1] * deep / 2];
    const at = (name: string, size: number[], colour: Rgb, across: number, o: number, z: number) => put(name, size, colour, edge, out, across, o, z);
    at("span", [SPAN.across, SPAN.out, 0.03], STEEL, 0, SPAN.out / 2, KERB_Z - 0.03);
    for (const s of [-1, 1]) at("spanRail", [0.03, SPAN.out, 0.04], TOWER, s * (SPAN.across / 2 - 0.015), SPAN.out / 2, KERB_Z);
    const towers = DOLPHINS.across;
    for (const s of [-1, 1]) at("tower", [0.08, 0.08, 0.55 - DOLPHINS.foot], TOWER, s * towers, SPAN.out - 0.04, DOLPHINS.foot);
    at("beam", [2 * towers + 0.08, 0.07, 0.06], hex(BLUEPRINTS[data.kind].color), 0, SPAN.out - 0.04, 0.5);
    for (const s of [-1, 1]) {
      for (const o of DOLPHINS.out) {
        at("dolphin", [0.16, 0.16, KERB_Z + 0.02 - DOLPHINS.foot], CONCRETE, s * DOLPHINS.across, o, DOLPHINS.foot);
        at("fender", [0.03, 0.14, 0.12], IRON, s * (DOLPHINS.across - 0.095), o, -0.1);
        at("bollard", [0.05, 0.05, 0.05], IRON, s * DOLPHINS.across, o, KERB_Z + 0.02);
      }
    }
    at("walk", [0.1, DOLPHINS.out[1] - 0.08, 0.025], BOARDS, DOLPHINS.across, DOLPHINS.out[1] / 2 - 0.04, KERB_Z - 0.005);
    for (let a = -wide / 2 + 0.2; a < wide / 2 - 0.1; a += 0.42) if (Math.abs(a) > SPAN.across / 2 + 0.1 && Math.abs(a - DOLPHINS.across) > 0.12) at("bollard", [0.05, 0.05, 0.05], IRON, a, -0.07, KERB_Z);
    at("terminal", [0.36, 0.26, 0.17], hex(BLUEPRINTS[data.kind].material), -(wide / 2 - 0.32), -0.18, KERB_Z);
    at("roof", [0.4, 0.3, 0.025], TOWER, -(wide / 2 - 0.32), -0.18, KERB_Z + 0.17);
  }

  // A model's plot's middle (`kit.ts`).
  const xs = data.tiles.map((t) => t.x), ys = data.tiles.map((t) => t.y);
  const middle: [number, number] = [(Math.min(...xs) + Math.max(...xs) + 1) / 2, (Math.min(...ys) + Math.max(...ys) + 1) / 2];
  /** Which way a model on its plot is turned: its +x the gate's side,
   *  across the way it faces. */
  const gate: 1 | -1 = !data.door || (data.door.tile.x + 0.5 - middle[0]) * dy - (data.door.tile.y + 0.5 - middle[1]) * dx >= 0 ? 1 : -1;

  // Its model, whole, on its plot (`kit.ts`); the town grid leaves it.
  const whole = data.site ? null : wholeOf(data.kind, entry.id, gate);
  const built = whole && (() => {
    const [key, it, side] = whole;
    const finishes = placed_(key, it)(ctx.engine, side).map((finish) => {
      const one = placeShape(pool, finish, { at: middle, heading: Math.atan2(dy, dx) }, KERB_Z - 0.012);
      if (finish.glass) glowing(pool.finish(finish.key)!.material), lights(ctx);
      return one;
    });
    // Its lamps and its smoke, the town's props, where it has them.
    const onMap = ([x, y]: number[]): [number, number] => [middle[0] + dx * y + dy * x * side, middle[1] + dy * y - dx * x * side];
    const props = new Float32Array(it.props.length * PROP_FLOATS);
    it.props.forEach((p, k) => {
      const [x, y] = onMap(p.at), [tx, ty] = onMap(p.to ?? p.at);
      props.set([PROP_KINDS.indexOf(p.kind), x - middle[0], y - middle[1], KERB_Z - 0.012 + p.at[2], p.size, p.high, tx - middle[0], ty - middle[1]], k * PROP_FLOATS);
    });
    const meshes = placeProps(ctx, `whole_${entry.id}`, props, middle, [middle[0] - 3, middle[1] - 3, middle[0] + 3, middle[1] + 3], pool.casters);
    const trees = it.trees.length ? stand(ctx, `whole_${entry.id}`, it.trees.map(([x, y, scale], k) => ({ at: onMap([x, y]), scale, shade: k % 3 })), theme, pool.casters) : () => {};
    return () => {
      for (const one of finishes) one.remove();
      clearProps(ctx, meshes, pool.casters);
      trees();
    };
  })();
  // A sawmill's barn door, its forklift's way out toward the street.
  const mill = data.kind === "Sawmill" && !data.site
    ? { door: { at: [middle[0] + dx * BARN_DOOR[1] + dy * BARN_DOOR[0] * gate, middle[1] + dy * BARN_DOOR[1] - dx * BARN_DOOR[0] * gate], heading: Math.atan2(dy, dx) } as Pose }
    : null;

  // A shop's front: at the far end from its crates, through lunch, a
  // table out under a parasol.
  const lunch = data.kind === "Shop" && !data.site
    ? (() => {
        const w = dx === 0 ? bw : bh, d = dx === 0 ? bh : bw;
        const [a, o] = [w / 2 - 0.1, d / 2 - INSET / 2];
        const at = (name: string, size: number[], colour: Rgb, across: number, z: number) => put(name, size, colour, [mx, my], [dx, dy], across, o, z);
        let out: ReturnType<typeof put>[] = [];
        return ctx.beforeRender(() => {
          const t = shownTimeOfDay() * 24;
          const open = t >= 11.5 && t < 14;
          if (open && !out.length) out = [at("tableLeg", [0.008, 0.008, 0.15], IRON, a, KERB_Z), at("tableTop", [0.06, 0.06, 0.006], PARASOL, a, KERB_Z + 0.05), at("parasol", [0.12, 0.12, 0.012], PARASOL, a, KERB_Z + 0.145)];
          if (!open && out.length) {
            for (const one of out) pool.removeInstance(one.key, one.id), placed.splice(placed.indexOf(one), 1);
            out = [];
          }
        });
      })()
    : () => {};

  // A site going up: its slab, the walls rising on it as its materials
  // come in, in its colour still pale, scaffolding round them a little
  // higher, its materials at the front as they come (`pads.ts`), and over
  // it all a tower crane in builders' yellow, the sign of a
  // site anywhere.
  if (data.site) {
    const materials = Object.values(data.site);
    const sum = (f: (s: { level: number; cap: number }) => number) => materials.reduce((a, s) => a + (s ? f(s) : 0), 0);
    const done = sum((s) => s.cap) > 0 ? Math.min(1, sum((s) => s.level) / sum((s) => s.cap)) : 0;
    const full = eaves({ kind: data.kind, storeys: storeysOf(data.kind) });
    const high = full * done;
    const [w, d] = dx === 0 ? [bw, bh] : [bh, bw];
    const frame = (name: string, size: number[], colour: Rgb, a: number, o: number, z: number) => put(name, size, colour, [mx, my], [dx, dy], a, o, z);
    frame("slab", [w - 0.2, d - 0.2, 0.025], SLAB, 0, 0, KERB_Z);
    // The walls, and inside them, a little down, the floor being laid.
    const [ww, wd] = [w - 2 * INSET, d - 2 * INSET];
    const wall = lerp(hex(BLUEPRINTS[data.kind].material), WHITE_RGB, 0.35);
    if (high > 0.01) {
      for (const o of [-1, 1]) frame("wall", [ww, WALL, round(high)], wall, 0, o * (wd - WALL) / 2, KERB_Z + 0.025);
      for (const a of [-1, 1]) frame("wall", [WALL, wd - 2 * WALL, round(high)], wall, a * (ww - WALL) / 2, 0, KERB_Z + 0.025);
      frame("floor", [ww - 2 * WALL, wd - 2 * WALL, round(high)], FLOOR, 0, 0, KERB_Z + 0.025 - 0.02);
    }
    const top = round(high + 0.07);
    // The scaffolding: a pole at each corner, a little out from the walls,
    // and a walk of boards round them at the top.
    const [sa, so] = [ww / 2 + 0.07, wd / 2 + 0.07];
    for (const [a, o] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) frame("pole", [0.03, 0.03, top], SCAFFOLD, a * sa, o * so, KERB_Z + 0.025);
    for (const o of [-1, 1]) frame("boards", [2 * sa + 0.06, 0.06, 0.02], SCAFFOLD, 0, o * so, KERB_Z + top);
    for (const a of [-1, 1]) frame("boards", [0.06, 2 * so - 0.06, 0.02], SCAFFOLD, a * sa, 0, KERB_Z + top);
    // The crane at a back corner, its jib across the site over the walls.
    const [ca, co] = [-(ww / 2 - 0.1), -(wd / 2 - 0.1)];
    const mast = round(full + 0.25);
    frame("mast", [0.05, 0.05, mast], CRANE, ca, co, KERB_Z + 0.025);
    frame("jib", [Math.max(0.6, ww), 0.04, 0.035], CRANE, ca + Math.max(0.6, ww) / 2 - 0.15, co, KERB_Z + 0.025 + mast);
    frame("weight", [0.09, 0.08, 0.05], STEEL, ca - 0.12, co, KERB_Z + 0.025 + mast - 0.02);
  }

  // Its pad: each good's packages in their bay, as many as it holds less
  // what a forklift has yet to set down, and more what it has yet to take
  // away; and its forklifts, at home, or across between the pad and a
  // vehicle with a package in their forks, one lift at a time.
  setLifts(entry.id, data.lifts);
  const pad = padOf(data);
  // A bundle the mill has made since it was last seen: carried out of the
  // barn door to its place on the pad, a lift's while, its forklift's.
  const made = BLUEPRINTS[data.kind].makes;
  const count = made ? packagesOf(data, made) : 0;
  const fresh = mill && made && count > (seen.get(entry.id) ?? count) && !data.lifts.some((l) => !l.onto && l.good === made && ends(l) > simNow());
  if (made) seen.set(entry.id, count);
  const arrival = fresh ? { start: simNow(), good: made! } : null;
  /** How far the arrival is, 0 to 1, or null when it is over. */
  const arriving = (now: number) => (arrival && now < arrival.start + HANDLE_MS ? (now - arrival.start) / HANDLE_MS : null);
  const base = pad?.yard ? KERB_Z - 0.012 : KERB_Z;
  const stood = (pad?.bays ?? []).map(() => [] as { remove(): void }[]);
  const lay = (now: number) =>
    pad?.bays.forEach((bay, b) => {
      const a = arriving(now);
      const want = packagesOf(data, bay.good) + data.lifts.filter((l) => l.good === bay.good).reduce((n, l) => n + atPad(l, now), 0) - (a !== null && a < DROP && arrival!.good === bay.good ? 1 : 0);
      const have = stood[b];
      while (have.length > Math.max(0, want)) have.pop()!.remove();
      while (have.length < want) {
        const [at, up] = placeIn(bay, have.length);
        have.push(placeShape(pool, itemOf(bay.good, false), at, base + up * ITEMS[bay.good].h));
      }
    });
  lay(simNow());
  const working = pad && (arrival || data.lifts.some((l) => ends(l) > simNow()));
  // A yard's forklifts stand in it; a shop's or a site's come out to a lift.
  const forks = (pad && (pad.yard || working) ? pad.homes : []).map((home) => ({ home, truck: placeShape(pool, FORKLIFT, home, base), load: null as { remove(): void; move(p: Pose, lift?: number): void } | null }));
  const stop = working
    ? ctx.beforeRender(() => {
        const now = simNow();
        lay(now);
        forks.forEach((f, k) => {
          const l = data.lifts.find((l) => l.k === k && l.start <= now && ends(l) > now);
          const bay = pad && pad.bays.find((b) => b.good === (l?.good ?? arrival?.good));
          const a = arriving(now);
          const at = l && bay ? lifting(l, bay, now) : k === 0 && a !== null && bay && mill ? carry(mill.door, placeIn(bay, count - 1)[0], a, bay) : null;
          f.truck.move(at ? at.truck : f.home);
          if (at?.load && !f.load) f.load = placeShape(pool, itemOf(l?.good ?? arrival!.good, true), at.load, base);
          if (!at?.load && f.load) (f.load.remove(), (f.load = null));
          if (at?.load) f.load!.move(at.load, 0.02);
        });
      })
    : () => {};
  /** Where a forklift is in a lift, and the package in its forks if one
   *  is: in to it, across, set down, and back, between its place on the
   *  pad and its place on the vehicle. */
  const lifting = (l: Lift, bay: Bay | undefined, now: number): { truck: Pose; load: Pose | null } | null => {
    const e = getEntity(l.car);
    if (!bay || e?.object.kind !== "Car") return null;
    const car = e.object.data as Car;
    const p = progress(l, now);
    // The package's place at either end: the next free, or the last
    // taken, of what is seen there now.
    const onPad = placeIn(bay, packagesOf(data, l.good) + atPad(l, now))[0];
    const aboard = carried(car).length;
    const i = car.role === "Ferry" ? deckSeen(l.car, car, now).at.get(l) : l.onto ? aboard - l.n + p.on : aboard + l.n - p.off;
    const onCar = i === undefined ? undefined : slotOn(l.car, car, now, i)?.at;
    if (!onCar) return null;
    const [from, to] = l.onto ? [onPad, onCar] : [onCar, onPad];
    return carry(from, to, (now - l.start) / l.every % 1, bay);
  };
  /** A forklift `t` of the way through one lift from one place to another:
   *  in to the package, across with it, set down, and back. */
  const carry = ({ at: from }: Pose, { at: to }: Pose, t: number, bay: Bay): { truck: Pose; load: Pose | null } => {
    const heading = Math.atan2(to[1] - from[1], to[0] - from[0]);
    const back = (q: [number, number]): Pose => ({ at: [q[0] - Math.cos(heading) * FORKS, q[1] - Math.sin(heading) * FORKS], heading });
    const mix = (k: number): [number, number] => [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];
    if (t < PICK) return { truck: back(from), load: null };
    if (t < DROP) {
      const k = (t - PICK) / (DROP - PICK);
      return { truck: back(mix(k)), load: { at: mix(k), heading: bay.slots[0].heading } };
    }
    return { truck: back(mix(1 - (t - DROP) / (1 - DROP))), load: null };
  };

  // A farm's field: its land, worked as its tractor last left it, or as
  // it is working it now.
  const field = data.land.length ? keepField(ctx, pool.casters, entry.id, data.land, data.ruts, theme) : null;

  return () => {
    stop();
    lunch();
    for (const { key, id } of placed) pool.removeInstance(key, id);
    for (const it of [...stood.flat(), ...forks.flatMap((f) => [f.truck, f.load])]) it?.remove();
    field?.();
    built?.();
  };
}
