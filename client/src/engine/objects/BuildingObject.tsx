import { Color3 } from "@babylonjs/core";
import type { InstancePool } from "../InstancePool";
import { shapeFor, slabGeometry, BUILDING_COLOR, SLAB, variantOf, facingOf } from "./buildings";
import { plot } from "../../blueprints";
import { bridgeGeometry, frameOf, markingGeometry, runOf } from "./lots";
import type { Look } from "./look";
import type { Building, GameObjectEntry } from "../../generated";

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

  // A plot with a lot stands on one slab, kerb and all, under building and
  // lot alike, so the two read as one thing.
  if (lie.lot && pos) {
    const [pw, ph] = lie.size;
    const at: [number, number, number] = [pos.x + pw / 2, pos.y + ph / 2, 0];
    for (const [name, kerb, tint, z] of [["kerb", true, KERB, SLAB.kerbZ], ["slab", false, ASPHALT, SLAB.z]] as const) {
      const key = `${name}_${pw}x${ph}${look.key}`;
      pool.ensureBucket(key, slabGeometry(pw, ph, kerb), look.tint(tint), false, true);
      placed.push({ key, id: pool.addInstance(key, [at[0], at[1], z]) });
    }
    // The lot is the run of lot tiles this one touches along the street:
    // the dividers are the run's, drawn once by its first building, and the
    // seam to the next building's slab is bridged so the run is one slab.
    const run = runOf(entry);
    if (run) {
      const { rot, origin } = frameOf(data.facing, run.rect);
      const put = (key: string, geo: () => Parameters<typeof pool.ensureBucket>[1], tint: Color3, z: number, lit: boolean) => {
        pool.ensureBucket(key, geo(), look.tint(tint), false, lit);
        placed.push({ key, id: pool.addInstance(key, [origin[0], origin[1], z], [0, 0, rot]) });
      };
      if (run.first) put(`marks_${run.w}${look.key}`, () => markingGeometry(run.w), KERB, 0, false);
      if (!run.last) {
        const d = Math.min(ph, pw) === 1 ? 1 : (data.facing % 2 === 0 ? ph : pw);
        put(`bridge_kerb_${run.u1}_${d}${look.key}`, () => bridgeGeometry(run.u1, d, true), KERB, SLAB.kerbZ, true);
        put(`bridge_${run.u1}_${d}${look.key}`, () => bridgeGeometry(run.u1, d, false), ASPHALT, SLAB.z, true);
      }
    }
  }

  return () => {
    for (const { key, id } of placed) pool.removeInstance(key, id);
  };
}
