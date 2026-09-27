import { Color3, Vector3, type Scene } from "@babylonjs/core";
import type { InstancePool } from "../InstancePool";
import { shapeFor, SLAB, PLOT_MARGIN, variantOf, facingOf, boxGeometry } from "./buildings";
import { BLUEPRINTS, FACINGS, plot } from "../../blueprints";
import { frameOf, markingGeometry, runOf, runSlabGeometry, yardGeometry } from "./lots";
import { Strip, type RGB } from "./strip";
import { drawnPath } from "./drawnPath";
import { lay } from "../pieces";
import { plotPiece, type Ground } from "../pieces/rules";
import type { Look } from "./look";
import type { Theme } from "../theme";
import { simNow } from "../../network/clock";
import type { Building, GameObjectEntry } from "../../generated";
import type { Job } from "../../generated/Job";
import type { Tile } from "../../generated/Tile";
import { parts } from "../../state/selection";

/** The slab is white like a street, with the street's kerb round it, and
 *  the dividers between spots are painted in the kerb's colour. */
export const ASPHALT = Color3.FromHexString("#F8F6F0");
export const KERB = Color3.FromHexString("#E6E2D6");

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
const rgb = (c: Color3): RGB => [c.r, c.g, c.b];
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
      const mix = (a: Color3, b: Color3, t: number): RGB => [a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t];
      return k < 0.6 ? mix(theme.earth, theme.growing, k / 0.6) : mix(theme.growing, theme.ripe, (k - 0.6) / 0.4);
    }
    default: return null;
  }
}
/** The field along a path over the land, in a tone. */
export const field = (pool: InstancePool, drawn: NonNullable<ReturnType<typeof drawnPath>>, land: Set<string>, z: number, tone: RGB) =>
  new Strip(pool.material("field", Color3.White()), drawn, (x, y) => land.has(`${x},${y}`), z, tone);

export function mountBuilding(
  entry: GameObjectEntry,
  pool: InstancePool,
  scene: Scene,
  theme: Theme,
  ground: Ground,
  look: Look,
): () => void {
  const data = entry.object.data as Building;
  const pos = entry.position;
  const color = look.tint(Color3.FromHexString(BLUEPRINTS[data.kind].color));
  const lie = plot(data.kind, data.facing);
  const [[bx, by], [w, h]] = lie.building;
  // Size and height are part of the key: a shape is built for the plot it
  // stands on and the height it was given, rather than stretched to either, so
  // each is a solid of its own.
  const variant = variantOf(data.kind, entry.id);
  const poolKey = `building_${data.kind}_${w}x${h}_${variant}${look.key}`;

  // One bucket per kind, which the pool key already gave us — so each kind
  // brings its own solid at no cost. Height is the instance's own, so a street
  // of houses is not a row of identical blocks.
  //
  // Lit, and taking shadows as well as throwing them: an unlit building is one
  // flat colour whatever shape it is, so the two faces of a roof would never
  // separate, and a tower would cast onto the ground but not onto its
  // neighbours.
  // Placed and turned, never scaled. Scaling one axis of an instance skews its
  // normals, and a building lit by skewed normals shades as though it were a
  // different shape than it is.
  const placed: { key: string; id: number }[] = [];
  if (data.kind === "House" && pos) {
    // A house's look is its situation's: alone, in a terrace, on a corner.
    placed.push(...lay(pool, theme, [plotPiece(ground, pos.x, pos.y)], `_House${look.key}`, Color3.FromHexString(BLUEPRINTS.House.color), look.tint));
    parts.set(entry.id, placed.slice());
  } else {
    const shape = shapeFor(data.kind, w, h, variant);
    pool.ensureBucket(poolKey, shape, color, look.castShadow, true);
    placed.push({
      key: poolKey,
      id: pool.addInstance(
        poolKey,
        pos ? [pos.x + bx + w / 2, pos.y + by + h / 2, 0] : undefined,
        [0, 0, facingOf(entry.id, w, h)],
      ),
    });
    parts.set(entry.id, [placed[0]]);
  }

  // Its lot: a slab with a kerb, and the dividers between its spots, or a
  // depot's docks.
  const run = lie.lot && pos ? runOf(entry) : null;
  if (run) {
    const { rot, origin } = frameOf(data.facing, run.rect);
    const put = (key: string, geo: () => Parameters<typeof pool.ensureBucket>[1], tint: Color3, at: [number, number], z: number, lit: boolean) => {
      pool.ensureBucket(key, geo(), look.tint(tint), false, lit);
      const c = Math.cos(rot), s = Math.sin(rot);
      placed.push({ key, id: pool.addInstance(key, [origin[0] + at[0] * c - at[1] * s, origin[1] + at[0] * s + at[1] * c, z], [0, 0, rot]) });
    };
    put(`run_kerb_${run.w}x${run.depth}${look.key}`, () => runSlabGeometry(run.w, run.depth, true), KERB, [0, 0], SLAB.kerbZ, true);
    put(`run_${run.w}x${run.depth}${look.key}`, () => runSlabGeometry(run.w, run.depth, false), ASPHALT, [0, 0], SLAB.z, true);
    if (run.yard !== null) {
      const wall = run.yard;
      put(`yard_${run.w}x${wall}${look.key}`, () => yardGeometry(run.w, wall), KERB, [0, 0], 0, true);
    } else {
      put(`marks_${run.w}${look.key}`, () => markingGeometry(run.w), KERB, [0, 0], 0, true);
    }
  }

  // A port's quay: a pier at the land's height, the building's width,
  // standing out one tile over the water along its back wall, where the
  // ship lies when it is home. The water is half a unit under the land.
  if (BLUEPRINTS[data.kind].quay && pos) {
    const [dx, dy] = FACINGS[data.facing % 4];
    const alongX = dx === 0;
    // From the back wall, which stands the plot's margin in from the
    // tile's edge, out over the water.
    const out = (QUAY.deck - PLOT_MARGIN) / 2 - PLOT_MARGIN / 2;
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
  const drawn = data.ruts.length > 1 ? drawnPath(data.ruts.map(({ x, y }) => new Vector3(x + 0.5, y + 0.5, 0)), 0, 0, 0) : null;
  const tone = fieldTone(theme, data.land);
  const strip = drawn && tone ? field(pool, drawn, new Set(data.land.map((t) => `${t.at.x},${t.at.y}`)), FIELD_Z, tone) : null;
  let painted = performance.now();
  const observer = strip && data.land.some((t) => t.stage === "Sown" && simNow() - t.since < RIPEN)
    ? scene.onBeforeRenderObservable.add(() => {
        if (performance.now() - painted < 500) return;
        painted = performance.now();
        strip.paint(fieldTone(theme, data.land)!);
      })
    : null;

  return () => {
    for (const { key, id } of placed) pool.removeInstance(key, id);
    if (observer) scene.onBeforeRenderObservable.remove(observer);
    strip?.dispose();
    parts.delete(entry.id);
  };
}
