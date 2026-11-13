import type { EngineContext } from "../Canvas";
import { hex, type Rgb } from "../rgb";
import type { InstancePool } from "../InstancePool";
import { boxGeometry } from "./buildings";
import { BLUEPRINTS, FACINGS, standing } from "../../blueprints";
import { INSET } from "../town/footprint";
import { keepField } from "./field";
import { shownTimeOfDay } from "../DayNightCycle";
import { placeShape } from "./CarObject";
import { FORKLIFT, itemOf, ITEMS } from "./goods";
import { glow, glowing, placing } from "./finishes";
import { modelOf } from "./models";
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
 *  model's name (`modelsWorker.ts`), which way round, and where its front
 *  wall stands in it (y), set on its plot's front edge.
 *  A house is one of a few by its id, as if at random, so a street of
 *  them is mixed, every other one the other way round. Anything else
 *  with its gate on its +x, where its loading bay is cut. */
const HOUSES = 9;
const WHOLE: Partial<Record<Building["kind"], [string, number]>> = {
  Shop: ["shopHall", -0.5], Fishery: ["fishery", -0.5], Farm: ["farm", -0.5], SheepFarm: ["sheepFarm", -0.5], Tailor: ["tailor", -0.5], Woodcutter: ["woodcutter", -0.5],
  ClayPit: ["clayPit", -0.5], SandPit: ["sandPit", -0.5], Bakery: ["bakery", -0.5], FireStation: ["bakery", -0.5],
  // Two rows deep.
  Sawmill: ["sawmill", 0], Brickworks: ["brickworks", 0], Glassworks: ["glassworks", 0], Workshop: ["workshop", 0],
};
function wholeOf(kind: Building["kind"], id: number, gate: 1 | -1): [string, 1 | -1, number] | null {
  if (kind === "House") return [`house${(Math.imul(id, 0x9e3779b1) >>> 7) % HOUSES}`, id % 2 ? 1 : -1, 0.5];
  const w = WHOLE[kind];
  return w ? [w[0], gate, w[1]] : null;
}

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
  // The gate is the middle tile of the front, or of two the one on the
  // gate's side, the model's +x.
  const docks = data.door ? BLUEPRINTS[data.kind].docks : 0;
  const plain = wholeOf(data.kind, entry.id, gate);
  const across = dx === 0 ? Math.max(...xs) - Math.min(...xs) + 1 : Math.max(...ys) - Math.min(...ys) + 1;
  const at = across % 2 === 0 ? 0.5 : 0;
  // Its front wall on its plot's front edge, the pavement before it.
  const deep = dx === 0 ? Math.max(...ys) - Math.min(...ys) + 1 : Math.max(...xs) - Math.min(...xs) + 1;
  const out = plain ? deep / 2 - plain[2] : 0;
  const o: [number, number] = [middle[0] + dx * out, middle[1] + dy * out];
  // Made in a worker: it stands when it comes, unless let go by then.
  const built = plain && keepWhole(entry.id, JSON.stringify([plain[0], docks, at, plain[1], o, dx, dy]), theme, () => {
    const [name, side, wall] = plain;
    let drop: (() => void) | null = () => {};
    void modelOf({ name, notch: docks ? [at, docks * DOCK_PITCH / 2, wall] : null, side }).then((it) => {
      if (!drop) return;
      const finishes = placing(ctx.engine, docks ? `${name}_bay${docks}_${at}` : name, it).map((finish) => {
        const one = placeShape(pool, { ...finish, moves: false }, { at: o, heading: Math.atan2(dy, dx) }, 0);
        if (finish.glass) glowing(pool.finish(finish.key)!.material), lights(ctx);
        return one;
      });
      // Its lamps and its smoke, the town's props, where it has them.
      const onMap = ([x, y]: number[]): [number, number] => [o[0] + dx * y + dy * x * side, o[1] + dy * y - dx * x * side];
      const props = new Float32Array(it.props.length * PROP_FLOATS);
      it.props.forEach((p, k) => {
        const [x, y] = onMap(p.at), [tx, ty] = onMap(p.to ?? p.at);
        props.set([PROP_KINDS.indexOf(p.kind), x - o[0], y - o[1], p.at[2], p.size, p.high, tx - o[0], ty - o[1]], k * PROP_FLOATS);
      });
      const meshes = placeProps(ctx, props, [o[0], o[1]], pool.casters);
      const trees = it.trees.length ? stand(ctx, it.trees.map(([x, y, scale], k) => ({ at: onMap([x, y]), scale, shade: k % 3 })), theme, pool.casters) : () => {};
      drop = () => {
        for (const one of finishes) one.remove();
        clearProps(ctx, meshes, pool.casters);
        trees();
      };
    });
    return () => {
      drop?.();
      drop = null;
    };
  });
  // A shop's front: at the far end from its crates, through lunch, a
  // table out under a parasol.
  const lunch = data.kind === "Shop"
    ? (() => {
        const w = dx === 0 ? bw : bh, d = dx === 0 ? bh : bw;
        const [a, o] = [gate * (w / 2 - 0.1), d / 2 - INSET / 2];
        const at = (name: string, size: number[], colour: Rgb, across: number, z: number) => put(name, size, colour, [mx, my], [dx, dy], across, o, z);
        let out: ReturnType<typeof put>[] = [];
        return ctx.beforeRender(() => {
          const t = shownTimeOfDay() * 24;
          const open = t >= 11.5 && t < 14;
          if (open && !out.length) out = [at("tableLeg", [0.008, 0.008, 0.15], IRON, a, 0), at("tableTop", [0.06, 0.06, 0.006], PARASOL, a, 0.05), at("parasol", [0.12, 0.12, 0.012], PARASOL, a, 0.145)];
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
  const stood = (pad?.bays ?? []).map(() => [] as { remove(): void }[]);
  const lay = (now: number) =>
    pad?.bays.forEach((bay, b) => {
      const want = packagesOf(data, bay.good) + runs.filter((l) => l.good === bay.good).reduce((n, l) => n + atPad(l, now), 0);
      const have = stood[b];
      while (have.length > Math.max(0, want)) have.pop()!.remove();
      while (have.length < want) {
        const [at, up] = placeIn(bay, have.length);
        have.push(placeShape(pool, itemOf(bay.good, false), at, up * ITEMS[bay.good].h));
      }
    });
  lay(simNow());
  const working = pad && runs.some((l) => ends(l) + REST_MS > simNow());
  // A front's forklifts stand by its docks; a site's come out to a lift.
  const forks = (pad && (pad.docked || working) ? yardsOf(entry.id, data, pad, runs, slotOf) : []).map((f) => ({ ...f, truck: placeShape(pool, FORKLIFT, f.yard.home, 0), load: null as { remove(): void; move(p: Pose, lift?: number): void } | null }));
  const stop = working
    ? ctx.beforeRender(() => {
        const now = simNow();
        lay(now);
        for (const f of forks) {
          const at = forkliftAt(f.yard, f.mine, now);
          f.truck.move(at.truck);
          const good = at.load && f.mine.find((l) => l.start <= now && ends(l) > now)?.good;
          if (good && !f.load) f.load = placeShape(pool, itemOf(good, true), at.load!.at, 0);
          if (!at.load && f.load) (f.load.remove(), (f.load = null));
          if (at.load) f.load!.move(at.load.at, at.load.z);
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
