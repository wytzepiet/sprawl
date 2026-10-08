import type { EngineContext } from "../Canvas";
import { hex, lerp, type Rgb } from "../rgb";
import type { InstancePool } from "../InstancePool";
import { boxGeometry } from "./buildings";
import { BLUEPRINTS, FACINGS, lie } from "../../blueprints";
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
 *  the land, and how far down to the water it stands. */
const QUAY = { deck: 0.7, top: 0.03, height: 0.53 };
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
 * grid does not draw: a port's quay out over the water, and a farm's field.
 * The building itself is the town grid's (`TownLayer`).
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

  // A port's quay: a pier at the land's height, the building's width,
  // standing out one tile over the water along its back wall, where the
  // ship lies when it is home. The water is half a unit under the land.
  if (BLUEPRINTS[data.kind].quay && data.tiles.length) {
    const xs = data.tiles.map((t) => t.x), ys = data.tiles.map((t) => t.y);
    const pos = { x: Math.min(...xs), y: Math.min(...ys) };
    const [[bx, by], [w, h]] = lie(data.kind, data.facing, [Math.max(...xs) - pos.x + 1, Math.max(...ys) - pos.y + 1]).building;
    const [dx, dy] = FACINGS[data.facing % 4];
    const alongX = dx === 0;
    const out = QUAY.deck / 2;
    const centre: [number, number] = alongX
      ? [pos.x + bx + w / 2, (dy < 0 ? pos.y + by + h : pos.y + by) - dy * out]
      : [(dx < 0 ? pos.x + bx + w : pos.x + bx) - dx * out, pos.y + by + h / 2];
    const key = `quay_${alongX ? w : h}${look.key}`;
    pool.ensureBucket(key, boxGeometry(alongX ? w : h, QUAY.deck, QUAY.height), look.tint(KERB), look.castShadow, true);
    placed.push({ key, id: pool.addInstance(key, [centre[0], centre[1], QUAY.top - QUAY.height / 2], [0, 0, alongX ? 0 : Math.PI / 2]) });
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
    stop?.();
    strip?.dispose();
  };
}
