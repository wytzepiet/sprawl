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
import type { GameObjectEntry, RoadNode } from "../../generated";

/** Red, for road that reaches nothing: an island no car will ever come down. */
const CUT_OFF = new Color3(0.85, 0.25, 0.2);
const cutOff = (c: Color3) => Color3.Lerp(c, CUT_OFF, 0.55);
/** Darker, for a road: a through route nothing fronts onto. */
const asRoad = (c: Color3) => c.scale(0.72);

// --- Connection detection ---

function getConnectionArms(
  entry: GameObjectEntry,
  getEntity: (id: number) => GameObjectEntry | undefined,
): ArmInfo[] {
  if (entry.object.kind !== "RoadNode" || !entry.position) return [];
  const { x, y } = entry.position;
  const { outgoing, incoming } = entry.object.data;
  const arms: ArmInfo[] = [];

  for (const nId of outgoing) {
    const neighbor = getEntity(nId);
    if (!neighbor?.position) continue;
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
    if (!neighbor?.position) continue;
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
): (() => void) | null {
  const instances: { key: string; id: number }[] = [];
  const pos: [number, number, number] | undefined =
    entry.position ? [entry.position.x + 0.5, entry.position.y + 0.5, 0] : undefined;

  const arrowColor = new Color3(
    Math.min(1, theme.road.r + 0.25),
    Math.min(1, theme.road.g + 0.25),
    Math.min(1, theme.road.b + 0.25),
  );

  const arms = getConnectionArms(entry, getEntity);
  // An island is drawn in its own buckets: one material each, so the red is
  // a colour, not a per-instance attribute.
  const { joined, road } = entry.object.data as RoadNode;
  const key = armsKey(arms) + (joined ? "" : "_cut") + (road ? "_road" : "");
  const tint = (c: Color3) => {
    const t = joined ? c : cutOff(c);
    return road ? asRoad(t) : t;
  };

  const borderGeo = buildRoadGeometry(arms, BORDER_HALF_W, BORDER_Z);
  if (borderGeo) {
    const bk = `road_border_${key}`;
    pool.ensureBucket(bk, borderGeo, tint(theme.roadBorder), false, true);
    instances.push({ key: bk, id: pool.addInstance(bk, pos) });
  }

  const roadGeo = buildRoadGeometry(arms, HALF_W, ROAD_Z);
  if (roadGeo) {
    const rk = `road_${key}`;
    pool.ensureBucket(rk, roadGeo, tint(theme.road), false, true);
    instances.push({ key: rk, id: pool.addInstance(rk, pos) });
  }

  for (const arm of arms) {
    if (arm.flow !== "out") continue;
    const chevronGeo = buildChevronGeometry(arm.angle);
    const ck = `chevron_${arm.angle}`;
    pool.ensureBucket(ck, chevronGeo, arrowColor, false, false);
    instances.push({ key: ck, id: pool.addInstance(ck, pos) });
  }

  // Null, not an empty cleanup: a node whose neighbours have not arrived yet
  // resolves no arms and draws nothing. Reporting that as a successful mount
  // would record it as done and it would never be drawn again.
  if (instances.length === 0) return null;

  return () => {
    for (const { key, id } of instances) pool.removeInstance(key, id);
  };
}
