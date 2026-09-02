import { Color3 } from "@babylonjs/core";
import type { InstancePool } from "../InstancePool";
import { shapeFor, BUILDING_COLOR, variantOf, facingOf } from "./buildings";
import type { Look } from "./draftLook";
import type { Building, GameObjectEntry } from "../../generated";

export function mountBuilding(
  entry: GameObjectEntry,
  pool: InstancePool,
  look: Look,
): () => void {
  const data = entry.object.data as Building;
  const pos = entry.position;
  const color = look.tint(Color3.FromHexString(BUILDING_COLOR));
  // Size and height are part of the key: a shape is built for the plot it
  // stands on and the height it was given, rather than stretched to either, so
  // each is a solid of its own.
  const variant = variantOf(data.kind, entry.id);
  const poolKey = `building_${data.kind}_${data.size[0]}x${data.size[1]}_${variant}${look.key}`;
  const [w, h] = data.size;

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
  pool.ensureBucket(poolKey, shape, color, look.castShadow, true, undefined, look.alpha, look.lift);
  const id = pool.addInstance(
    poolKey,
    pos ? [pos.x + w / 2, pos.y + h / 2, 0] : undefined,
    [0, 0, facingOf(entry.id, w, h)],
  );

  return () => pool.removeInstance(poolKey, id);
}
