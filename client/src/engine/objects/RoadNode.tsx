import { Color3 } from "@babylonjs/core";
import type { InstancePool } from "../InstancePool";
import {
  buildChevronGeometry,
  buildRoadGeometry,
  BORDER_HALF_W,
  BORDER_Z,
  CHEVRON_Z,
  HALF_W,
  ROAD_Z,
  type ArmInfo,
  type Flow,
} from "./roadGeometry";
import type { Theme } from "../theme";
import { DOOMED_LOOK, type Look } from "./draftLook";
import type { GameObjectEntry } from "../../generated";

// --- Connection detection ---

/** The two worlds a draft splits the network into. */
type Which = "now" | "after";

function getConnectionArms(
  entry: GameObjectEntry,
  getEntity: (id: number) => GameObjectEntry | undefined,
  which: Which,
): ArmInfo[] {
  if (entry.object.kind !== "RoadNode" || !entry.position) return [];
  const { x, y } = entry.position;
  const { outgoing, incoming } = entry.object.data;
  const arms: ArmInfo[] = [];

  // Demolish a road up to a point and the survivor stops being drawn curved
  // toward the half that is going: that arm is not in the world being drawn.
  const sameWorld = (n: GameObjectEntry) =>
    n.draft?.state === "Removed"
      ? which === "now"
      : n.draft?.state === "Added"
        ? which === "after"
        : true;

  for (const nId of outgoing) {
    const neighbor = getEntity(nId);
    if (!neighbor?.position || !sameWorld(neighbor)) continue;
    const dx = neighbor.position.x - x;
    const dy = neighbor.position.y - y;
    if (dx === 0 && dy === 0) continue;
    const angle = Math.atan2(dy, dx);
    const neighborData =
      neighbor.object.kind === "RoadNode" ? neighbor.object.data : null;
    const isOneWay = neighborData
      ? neighborData.incoming.includes(entry.id)
      : false;
    arms.push({ angle: angle < 0 ? angle + 2 * Math.PI : angle, flow: isOneWay ? "out" : "twoway" });
  }

  for (const nId of incoming) {
    const neighbor = getEntity(nId);
    if (!neighbor?.position || !sameWorld(neighbor)) continue;
    if (outgoing.includes(nId)) continue;
    const dx = neighbor.position.x - x;
    const dy = neighbor.position.y - y;
    if (dx === 0 && dy === 0) continue;
    const angle = Math.atan2(dy, dx);
    arms.push({ angle: angle < 0 ? angle + 2 * Math.PI : angle, flow: "in" });
  }

  return arms;
}

function armsKey(arms: ArmInfo[]): string {
  return arms
    .map((a) => `${a.angle}:${a.flow}`)
    .sort()
    .join(",");
}

// --- Mount function ---

export function mountRoad(
  entry: GameObjectEntry,
  pool: InstancePool,
  theme: Theme,
  getEntity: (id: number) => GameObjectEntry | undefined,
  look: Look,
): (() => void) | null {
  const instances: { key: string; id: number }[] = [];
  const pos: [number, number, number] | undefined =
    entry.position ? [entry.position.x + 0.5, entry.position.y + 0.5, 0] : undefined;

  const arrowColor = new Color3(
    Math.min(1, theme.road.r + 0.25),
    Math.min(1, theme.road.g + 0.25),
    Math.min(1, theme.road.b + 0.25),
  );

  function draw(arms: ArmInfo[], look: Look) {
    const key = armsKey(arms) + look.key;

    const borderGeo = buildRoadGeometry(arms, BORDER_HALF_W, BORDER_Z + look.lift);
    if (borderGeo) {
      const bk = `road_border_${key}`;
      pool.ensureBucket(bk, borderGeo, look.tint(theme.roadBorder), false, true, undefined, look.alpha, look.lift);
      instances.push({ key: bk, id: pool.addInstance(bk, pos) });
    }

    const roadGeo = buildRoadGeometry(arms, HALF_W, ROAD_Z + look.lift);
    if (roadGeo) {
      const rk = `road_${key}`;
      pool.ensureBucket(rk, roadGeo, look.tint(theme.road), false, true, undefined, look.alpha, look.lift);
      instances.push({ key: rk, id: pool.addInstance(rk, pos) });
    }

    for (const arm of arms) {
      if (arm.flow !== "out") continue;
      const chevronGeo = buildChevronGeometry(arm.angle);
      const ck = `chevron_${arm.angle}${look.key}`;
      pool.ensureBucket(ck, chevronGeo, look.tint(arrowColor), false, false, undefined, look.alpha, look.lift);
      instances.push({ key: ck, id: pool.addInstance(ck, pos) });
    }
  }

  const leaving = entry.draft?.state === "Removed";
  draw(getConnectionArms(entry, getEntity, leaving ? "now" : "after"), look);

  // A road still standing beside one being demolished also draws the road as
  // it stands today, underneath itself. Without it the demolished stretch
  // stops dead at the survivor's edge rather than running under it, and the
  // two read as unrelated instead of as one road losing half its length.
  if (!entry.draft) {
    const now = getConnectionArms(entry, getEntity, "now");
    if (armsKey(now) !== armsKey(getConnectionArms(entry, getEntity, "after"))) {
      draw(now, DOOMED_LOOK);
    }
  }

  // Null, not an empty cleanup: a node whose neighbours have not arrived yet
  // resolves no arms and draws nothing. Reporting that as a successful mount
  // would record it as done and it would never be drawn again.
  if (instances.length === 0) return null;

  return () => {
    for (const { key, id } of instances) pool.removeInstance(key, id);
  };
}
