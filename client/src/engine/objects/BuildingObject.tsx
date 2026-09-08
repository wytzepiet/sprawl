import { Color3 } from "@babylonjs/core";
import type { InstancePool } from "../InstancePool";
import { shapeFor, BUILDING_COLOR, SLAB, variantOf, facingOf } from "./buildings";
import { plot } from "../../blueprints";
import { emptyPlotGeometry, frameOf, markingGeometry, runOf, runSlabGeometry, yardGeometry } from "./lots";
import type { Look } from "./look";
import type { Building, GameObjectEntry } from "../../generated";
import { parts } from "../../state/selection";

/** The slab is white like a street, with the street's kerb round it, and
 *  the dividers between spots are painted in the kerb's colour. */
const ASPHALT = Color3.FromHexString("#FFFFFF");
const KERB = Color3.FromHexString("#DFE1E1");

export function mountBuilding(
  entry: GameObjectEntry,
  pool: InstancePool,
  look: Look,
): () => void {
  const data = entry.object.data as Building;
  const pos = entry.position;
  const color = look.tint(Color3.FromHexString(BUILDING_COLOR));
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
  const shape = shapeFor(data.kind, w, h, variant);
  pool.ensureBucket(poolKey, shape, color, look.castShadow, true);
  const placed: { key: string; id: number }[] = [];
  placed.push({
    key: poolKey,
    id: pool.addInstance(
      poolKey,
      pos ? [pos.x + bx + w / 2, pos.y + by + h / 2, 0] : undefined,
      [0, 0, facingOf(entry.id, w, h)],
    ),
  });
  parts.set(entry.id, [placed[0]]);

  // A lot is the run of lot tiles this one touches along the street, with
  // the free tiles it spills over: one slab under every plot on it, the
  // dividers between its spots, and a dashed footprint on each empty plot
  // where the next building can land. Drawn once, by the run's first
  // building; the others redraw whenever the run changes.
  const run = lie.lot && pos ? runOf(entry) : null;
  if (run?.first) {
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
      for (const u of run.empties) put(`empty_${run.depth}${look.key}`, () => emptyPlotGeometry(run.depth), KERB, [u, 0], 0, true);
    }
  }

  return () => {
    for (const { key, id } of placed) pool.removeInstance(key, id);
    parts.delete(entry.id);
  };
}
