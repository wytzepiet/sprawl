import type { EngineContext } from "../Canvas";
import { hex, type Rgb } from "../rgb";
import type { InstancePool } from "../InstancePool";
import { boxGeometry } from "./buildings";
import { BLUEPRINTS, FACINGS, standing } from "../../blueprints";
import { KERB_Z } from "../town/draw";
import { INSET } from "../town/footprint";
import { keepField } from "./field";
import { shownTimeOfDay } from "../DayNightCycle";
import { placeShape } from "./CarObject";
import { FORKLIFT, itemOf, ITEMS } from "./goods";
import { SHOP_HALL } from "./shop";
import { FISHERY } from "./fishery";
import { HOUSES } from "./house";
import { FARM } from "./farm";
import { CLAY_PIT, SAND_PIT } from "./quarry";
import { SAWMILL, WOODCUTTER } from "./sawmill";
import { BAKERY, CEMENT, MACHINE, STEELWORKS } from "./works";
import { glow, glowing, placing } from "./finishes";
import type { Built } from "./kit";
import { clearProps, placeProps } from "../props";
import { PROP_FLOATS } from "../town/layer";
import { PROP_KINDS } from "../town/roof";
import { stand } from "../trees";
import { atPad, ends, packagesOf, padOf, placeIn, setLifts } from "./pads";
import { forkliftAt, REST_MS, yardsOf } from "./forklift";
import { liftSlot } from "./motion";
import { simNow } from "../../network/clock";
import { getEntity } from "../../state/gameObjects";
import type { Look } from "./look";
import type { Theme } from "../theme";
import type { Building, GameObjectEntry, Lift, Pose } from "../../generated";

/** A building drawn whole from the kit (`kit.ts`), by its kind: its
 *  buckets' name, its model, which way round, and where its front wall
 *  stands in it (y), set on its plot's front edge.
 *  A house is one of a few by its id, as if at random, so a street of
 *  them is mixed; a house and a farm every other one the other way round. */
function wholeOf(kind: Building["kind"], id: number, gate: 1 | -1): [string, Built, 1 | -1, number] | null {
  const odd = id % 2 ? 1 : -1;
  if (kind === "House") {
    const k = (Math.imul(id, 0x9e3779b1) >>> 7) % HOUSES.length;
    return [`house${k}`, HOUSES[k], odd, 0.5];
  }
  // A shop's door at the end its lunch table stands, its goods before its window.
  if (kind === "Shop") return ["shopHall", SHOP_HALL, -1, -0.5];
  if (kind === "Fishery") return ["fishery", FISHERY, gate, -0.5];
  if (kind === "Farm" || kind === "SheepFarm") return ["farm", FARM, odd, -0.5];
  if (kind === "Woodcutter") return ["woodcutter", WOODCUTTER, gate, -0.5];
  if (kind === "ClayPit") return ["clayPit", CLAY_PIT, gate, -0.5];
  if (kind === "SandPit") return ["sandPit", SAND_PIT, gate, -0.5];
  if (kind === "Bakery" || kind === "Tailor") return ["bakery", BAKERY, gate, -0.5];
  // Two rows deep. Until each has its own model, the nearest of the kit's.
  const works: Partial<Record<Building["kind"], [string, Built]>> = { Sawmill: ["sawmill", SAWMILL], Brickworks: ["cement", CEMENT], Glassworks: ["steelworks", STEELWORKS], Workshop: ["machine", MACHINE] };
  const w = works[kind];
  return w ? [w[0], w[1], gate, 0] : null;
}
/** Each model's finishes placed, made once. */
const placings = new Map<string, ReturnType<typeof placing>>();
const placed_ = (key: string, it: Built) => placings.get(key) ?? (placings.set(key, placing(key, it)), placings.get(key)!);

/** Each engine's glass told the night, once a frame, from the first
 *  model with windows on (`finishes.ts`). */
const told = new WeakSet<EngineContext>();
const lights = (ctx: EngineContext) => void (told.has(ctx) || (told.add(ctx), ctx.beforeRender(glow)));

/** Docks side by side at a gate (`DOCK_PITCH` in `lots.rs`). */
const DOCK_PITCH = 0.3;
const IRON = hex("#2E3238");
/** A shop's lunch table and its parasol. */
const PARASOL = hex("#F1EADB");
/** Where a forklift run's package stands on its vehicle, if that is here. */
const slotOf = (l: Lift, j: number) => {
  const e = getEntity(l.car);
  return e?.object.kind === "Car" ? liftSlot(l, e.object.data, j) : null;
};
/**
 * Each building's model, lamps and trees, kept while they would be drawn
 * the same: its record comes again with every crate and every worker, and
 * drawn again each time, its lamps and trees were new meshes and new
 * shadow casters, a stall a few times a minute. Let go, they are dropped
 * once the batch that let them go has passed without taking them up again.
 */
const WHOLES = new Map<number, { was: string; theme: Theme; drop: () => void; held: boolean }>();
function keepWhole(id: number, was: string, theme: Theme, draw: () => () => void): () => void {
  let kept = WHOLES.get(id);
  if (!kept || kept.was !== was || kept.theme !== theme) {
    kept?.drop();
    kept = { was, theme, drop: draw(), held: true };
    WHOLES.set(id, kept);
  }
  const mine = kept;
  mine.held = true;
  return () => {
    mine.held = false;
    queueMicrotask(() => {
      if (mine.held || WHOLES.get(id) !== mine) return;
      mine.drop();
      WHOLES.delete(id);
    });
  };
}
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

  // A model's plot's middle (`kit.ts`).
  const xs = data.tiles.map((t) => t.x), ys = data.tiles.map((t) => t.y);
  const middle: [number, number] = [(Math.min(...xs) + Math.max(...xs) + 1) / 2, (Math.min(...ys) + Math.max(...ys) + 1) / 2];
  /** Which way a model on its plot is turned: its +x the gate's side,
   *  across the way it faces. */
  const gate: 1 | -1 = !data.door || (data.door.tile.x + 0.5 - middle[0]) * dy - (data.door.tile.y + 0.5 - middle[1]) * dx >= 0 ? 1 : -1;

  // Its model, whole, on its plot (`kit.ts`); the town grid leaves it.
  // Its loading bay notched into its front at its gate, a truck's width
  // and a little for each dock (`NOTCH` in `lots.rs`).
  const docks = data.door ? BLUEPRINTS[data.kind].docks : 0;
  const plain = wholeOf(data.kind, entry.id, gate);
  const whole: typeof plain = plain && docks ? [`${plain[0]}_bay${docks}`, plain[1].notched(docks * DOCK_PITCH / 2, plain[3]), plain[2], plain[3]] : plain;
  // Its front wall on its plot's front edge, the pavement before it.
  const deep = dx === 0 ? Math.max(...ys) - Math.min(...ys) + 1 : Math.max(...xs) - Math.min(...xs) + 1;
  const out = whole ? deep / 2 - whole[3] : 0;
  const o: [number, number] = [middle[0] + dx * out, middle[1] + dy * out];
  const built = whole && keepWhole(entry.id, JSON.stringify([whole[0], whole[2], o, dx, dy]), theme, () => {
    const [key, it, side] = whole;
    const finishes = placed_(key, it)(ctx.engine, side).map((finish) => {
      const one = placeShape(pool, finish, { at: o, heading: Math.atan2(dy, dx) }, KERB_Z - 0.012);
      if (finish.glass) glowing(pool.finish(finish.key)!.material), lights(ctx);
      return one;
    });
    // Its lamps and its smoke, the town's props, where it has them.
    const onMap = ([x, y]: number[]): [number, number] => [o[0] + dx * y + dy * x * side, o[1] + dy * y - dx * x * side];
    const props = new Float32Array(it.props.length * PROP_FLOATS);
    it.props.forEach((p, k) => {
      const [x, y] = onMap(p.at), [tx, ty] = onMap(p.to ?? p.at);
      props.set([PROP_KINDS.indexOf(p.kind), x - o[0], y - o[1], KERB_Z - 0.012 + p.at[2], p.size, p.high, tx - o[0], ty - o[1]], k * PROP_FLOATS);
    });
    const meshes = placeProps(ctx, `whole_${entry.id}`, props, o, [o[0] - 3, o[1] - 3, o[0] + 3, o[1] + 3], pool.casters);
    const trees = it.trees.length ? stand(ctx, `whole_${entry.id}`, it.trees.map(([x, y, scale], k) => ({ at: onMap([x, y]), scale, shade: k % 3 })), theme, pool.casters) : () => {};
    return () => {
      for (const one of finishes) one.remove();
      clearProps(ctx, meshes, pool.casters);
      trees();
    };
  });
  // A shop's front: at the far end from its crates, through lunch, a
  // table out under a parasol.
  const lunch = data.kind === "Shop"
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

  // Its pad: each good's packages in their bay, as many as it holds less
  // what a forklift has yet to set down, and more what it has yet to take
  // away; and its forklifts, at home, or across between the pad and a
  // vehicle with a package in their forks, one lift at a time.
  setLifts(entry.id, data.lifts);
  const pad = padOf(data);
  const runs = data.lifts;
  const base = KERB_Z;
  const stood = (pad?.bays ?? []).map(() => [] as { remove(): void }[]);
  const lay = (now: number) =>
    pad?.bays.forEach((bay, b) => {
      const want = packagesOf(data, bay.good) + runs.filter((l) => l.good === bay.good).reduce((n, l) => n + atPad(l, now), 0);
      const have = stood[b];
      while (have.length > Math.max(0, want)) have.pop()!.remove();
      while (have.length < want) {
        const [at, up] = placeIn(bay, have.length);
        have.push(placeShape(pool, itemOf(bay.good, false), at, base + up * ITEMS[bay.good].h));
      }
    });
  lay(simNow());
  const working = pad && runs.some((l) => ends(l) + REST_MS > simNow());
  // A front's forklifts stand by its docks; a site's come out to a lift.
  const forks = (pad && (pad.docked || working) ? yardsOf(entry.id, data, pad, base, runs, slotOf) : []).map((f) => ({ ...f, truck: placeShape(pool, FORKLIFT, f.yard.home, base), load: null as { remove(): void; move(p: Pose, lift?: number): void } | null }));
  const stop = working
    ? ctx.beforeRender(() => {
        const now = simNow();
        lay(now);
        for (const f of forks) {
          const at = forkliftAt(f.yard, f.mine, now);
          f.truck.move(at.truck);
          const good = at.load && f.mine.find((l) => l.start <= now && ends(l) > now)?.good;
          if (good && !f.load) f.load = placeShape(pool, itemOf(good, true), at.load!.at, base);
          if (!at.load && f.load) (f.load.remove(), (f.load = null));
          if (at.load) f.load!.move(at.load.at, at.load.z - base);
        }
      })
    : () => {};
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
