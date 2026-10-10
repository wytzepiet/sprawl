import type { EngineContext } from "../Canvas";
import { hex, lerp, type Rgb } from "../rgb";
import type { InstancePool } from "../InstancePool";
import { boxGeometry } from "./buildings";
import { BLUEPRINTS, FACINGS, standing } from "../../blueprints";
import { placeBox } from "./CarObject";
import { KERB_Z } from "../town/draw";
import { INSET } from "../town/footprint";
import { eaves } from "../town/mass";
import { storeysOf } from "../town/grid";
import { Strip, type RGB } from "./strip";
import { drawnPath } from "./drawnPath";
import type { Look } from "./look";
import type { Theme } from "../theme";
import { simNow } from "../../network/clock";
import type { Building, GameObjectEntry } from "../../generated";
import type { Job } from "../../generated/Job";
import type { Tile } from "../../generated/Tile";

/** A quay's stone, the kerb's colour. */
const KERB = hex("#E6E2D6");

/** A farm's field is the ground the tractor last drove, a strip a tile
 *  wide along its path, painted flat like a map's farmland in one tone
 *  for the stage the last run left it in — earth, growing, ripe,
 *  stubble — with the furrows along the tractor's path in a shade
 *  darker, lit as the roads and the lots are, and no grid over it. A run paints the
 *  stage it leaves behind the tractor, over the field as it was. */
export const FIELD_Z = 0.008;
/** A quay: how far out over the water it reaches, its deck's height over
 *  the land, and how far down to the water it stands; and the gap between
 *  its two piers the ferry berths in, a little over its beam. */
const QUAY = { deck: 0.7, top: 0.03, height: 0.53 };
const SLIP = 1;
/** A site's walls going up: how thick. */
const WALL = 0.05;
/** The link span's steel, a site's slab and scaffolding, and timber. */
const SPAN = hex("#6B7078");
const SLAB = hex("#BDB2A0");
const SCAFFOLD = hex("#9AA3AD");
const FLOOR = hex("#9E9A92");
const TIMBER = hex("#9E6B40");
const CRANE = hex("#E9B530");
const WHITE_RGB = hex("#FFFFFF");
/** Heights in steps of a hundredth, so a site's buckets are few. */
const round = (h: number) => Math.max(0.01, Math.round(h * 100) / 100);
/** How long a sown crop takes to ripen, as the server has it. */
const RIPEN = 600_000;
const rgb = (c: Rgb): RGB => [c.r, c.g, c.b];
/** The tone a job leaves behind the tractor: the plough turns the
 *  ground to earth, the harvest leaves stubble, and the seed leaves the
 *  earth as it found it — the green comes with the clock. */
export const leaves = (theme: Theme, job: Job): RGB | null => (job === "Plough" ? rgb(theme.earth) : job === "Harvest" ? rgb(theme.stubble) : null);
/** The field's tone between runs: the stage the last run left it in,
 *  which mid-run is the stage of the tiles not yet reached — the ones
 *  longest unchanged — since the run paints the new stage itself. A sown
 *  field grows as one, by the clock from the last tile sown: earth
 *  greening over the first part of the half day, green turning gold
 *  over the rest, ripe when the server counts it ripe too. */
export function fieldTone(theme: Theme, land: Tile[]): RGB | null {
  const oldest = land.reduce<Tile | null>((a, t) => (a === null || t.since < a.since ? t : a), null);
  switch (oldest?.stage) {
    case "Ploughed": return rgb(theme.earth);
    case "Cut": return rgb(theme.stubble);
    case "Sown": {
      const since = Math.max(...land.filter((t) => t.stage === "Sown").map((t) => t.since));
      const k = Math.min(1, Math.max(0, (simNow() - since) / RIPEN));
      const mix = (a: Rgb, b: Rgb, t: number): RGB => rgb(lerp(a, b, t));
      return k < 0.6 ? mix(theme.earth, theme.growing, k / 0.6) : mix(theme.growing, theme.ripe, (k - 0.6) / 0.4);
    }
    default: return null;
  }
}
/** The field along a path over the land, in a tone. */
export const field = (ctx: EngineContext, drawn: NonNullable<ReturnType<typeof drawnPath>>, land: Set<string>, z: number, tone: RGB) =>
  new Strip(ctx, drawn, (x, y) => land.has(`${x},${y}`), z, tone);

/**
 * What a building lays on the ground past its own walls, which the town
 * grid does not draw: a harbour's quay out over the water and the boxes in
 * its park, a farm's field, and a site going up. The building itself, once
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
  const boxes: { remove(): void }[] = [];

  /** A box `w` across, `l` out and `h` high, painted, in a frame round
   *  (x, y) whose out is (ox, oy): `across` and `out` from it, its base
   *  at `z`. */
  const { at: [mx, my], size: [bw, bh] } = standing(data);
  const [dx, dy] = FACINGS[data.facing % 4];
  const put = (name: string, [w, l, h]: number[], colour: Rgb, [x, y]: number[], [ox, oy]: number[], across: number, out: number, z: number) => {
    const key = `${name}_${w}_${l}_${h}${look.key}`;
    pool.ensureBucket(key, boxGeometry(w, l, h), look.tint(colour), look.castShadow, true);
    placed.push({ key, id: pool.addInstance(key, [x - oy * across + ox * out, y + ox * across + oy * out, z + h / 2], [0, 0, Math.atan2(oy, ox) - Math.PI / 2]) });
  };

  // A harbour on its quay: the ramp at the middle of its back, where the
  // ferry's land end lies, a link span down to its deck, and either side
  // of the ferry's berth a pier out over the water, the land's height,
  // the water half a unit under it; on one, the terminal. And in its park
  // the boxes standing in their slots.
  if (BLUEPRINTS[data.kind].quay) {
    const out = [-dx, -dy];
    const wide = dx === 0 ? bw : bh;
    const ramp = [mx + out[0] * (dx === 0 ? bh : bw) / 2, my + out[1] * (dx === 0 ? bh : bw) / 2];
    const pier = (wide - SLIP) / 2;
    for (const side of [-1, 1]) put("quay", [pier, QUAY.deck, QUAY.height], KERB, ramp, out, side * (SLIP + pier) / 2, QUAY.deck / 2, QUAY.top - QUAY.height);
    put("span", [0.55, 0.3, 0.025], SPAN, ramp, out, 0, 0.1, 0.005);
    put("terminal", [pier - 0.3, 0.42, 0.2], hex(BLUEPRINTS[data.kind].material), ramp, out, (SLIP + pier) / 2, 0.33, QUAY.top);
    put("roof", [pier - 0.26, 0.46, 0.03], hex("#E8E4DA"), ramp, out, (SLIP + pier) / 2, 0.33, QUAY.top + 0.2);
    for (const { pose, trailer } of data.park) if (trailer) boxes.push(placeBox(pool, trailer, pose, KERB_Z));
  }

  // A site going up: its slab, the walls rising on it as the timber comes
  // in, in its colour still pale, scaffolding round them a little higher,
  // the timber stacked at the front, and over it all a tower crane in
  // builders' yellow, the sign of a site anywhere.
  if (data.site) {
    const done = data.site.cap > 0 ? Math.min(1, data.site.level / data.site.cap) : 0;
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
    if (done > 0) frame("timber", [Math.min(0.5, w - 0.5), 0.1, round(0.02 + 0.08 * done)], TIMBER, 0, d / 2 - 0.15, KERB_Z + 0.025);
    // The crane at a back corner, its jib across the site over the walls.
    const [ca, co] = [-(ww / 2 - 0.1), -(wd / 2 - 0.1)];
    const mast = round(full + 0.25);
    frame("mast", [0.05, 0.05, mast], CRANE, ca, co, KERB_Z + 0.025);
    frame("jib", [Math.max(0.6, ww), 0.04, 0.035], CRANE, ca + Math.max(0.6, ww) / 2 - 0.15, co, KERB_Z + 0.025 + mast);
    frame("weight", [0.09, 0.08, 0.05], SPAN, ca - 0.12, co, KERB_Z + 0.025 + mast - 0.02);
  }

  // A farm's field: the ground its tractor last drove over, along the
  // path it drove, in the tone the last run left. Every run works the
  // same ground, so the last run's path is the field. Repainted now and
  // then while the crop ripens, so it is seen to turn.
  const drawn = data.ruts.length > 1 ? drawnPath(data.ruts.map(({ x, y }) => ({ x: x + 0.5, y: y + 0.5 })), 0, 0, 0) : null;
  const tone = fieldTone(theme, data.land);
  const strip = drawn && tone ? field(ctx, drawn, new Set(data.land.map((t) => `${t.at.x},${t.at.y}`)), FIELD_Z, tone) : null;
  let painted = performance.now();
  const stop = strip && data.land.some((t) => t.stage === "Sown" && simNow() - t.since < RIPEN)
    ? ctx.beforeRender(() => {
        if (performance.now() - painted < 500) return;
        painted = performance.now();
        strip.paint(fieldTone(theme, data.land)!);
      })
    : null;

  return () => {
    for (const { key, id } of placed) pool.removeInstance(key, id);
    for (const box of boxes) box.remove();
    stop?.();
    strip?.dispose();
  };
}
