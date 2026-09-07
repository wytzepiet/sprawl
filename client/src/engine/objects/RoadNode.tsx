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
import type { Building, GameObjectEntry, RoadNode } from "../../generated";
import { buildingAt } from "../../state/gameObjects";
import { inLot } from "../../blueprints";

/** Red, for road that reaches nothing: an island no car will ever come down. */
const CUT_OFF = new Color3(0.85, 0.25, 0.2);
const cutOff = (c: Color3) => Color3.Lerp(c, CUT_OFF, 0.55);
/** How far a road's yellow sits above the white junction under it: above
 *  the street's surface, below the chevrons. */
const HIGHWAY_LIFT = 0.006;

// --- Connection detection ---

/** An arm, and whether the neighbour it runs to is a road rather than a street. */
type Arm = ArmInfo & { road: boolean };

function getConnectionArms(
  entry: GameObjectEntry,
  getEntity: (id: number) => GameObjectEntry | undefined,
): Arm[] {
  if (entry.object.kind !== "RoadNode" || !entry.position) return [];
  const { x, y } = entry.position;
  const { outgoing, incoming } = entry.object.data;
  const arms: Arm[] = [];

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
    arms.push({ angle: angle < 0 ? angle + 2 * Math.PI : angle, flow: isOneWay ? "out" : "twoway", road: !!neighborData?.road });
  }

  for (const nId of incoming) {
    const neighbor = getEntity(nId);
    if (!neighbor?.position) continue;
    if (outgoing.includes(nId)) continue;
    const dx = neighbor.position.x - x;
    const dy = neighbor.position.y - y;
    if (dx === 0 && dy === 0) continue;
    const angle = Math.atan2(dy, dx);
    arms.push({ angle: angle < 0 ? angle + 2 * Math.PI : angle, flow: "in", road: neighbor.object.kind === "RoadNode" && neighbor.object.data.road });
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
  // A driveway on a lot tile is the lot's to draw: its stub joins the ring,
  // and a road drawn to the tile's centre would run through the island.
  if (entry.position) {
    const b = buildingAt(entry.position.x, entry.position.y);
    if (b?.position && inLot((b.object.data as Building).kind, (b.object.data as Building).facing, b.position, entry.position.x, entry.position.y)) {
      return () => {};
    }
  }

  const arrowColor = new Color3(
    Math.min(1, theme.road.r + 0.25),
    Math.min(1, theme.road.g + 0.25),
    Math.min(1, theme.road.b + 0.25),
  );

  const arms = getConnectionArms(entry, getEntity);
  // An island is drawn in its own buckets: one material each, so the red is
  // a colour, not a per-instance attribute.
  const { joined, road } = entry.object.data as RoadNode;
  const paint = (c: Color3) => (joined ? c : cutOff(c));

  // A surface of the given arms: kerb, then road, lifted by z.
  const lay = (name: string, of: ArmInfo[], border: Color3, surface: Color3, z: number, edge: number) => {
    const key = armsKey(of) + (joined ? "" : "_cut");
    const borderGeo = buildRoadGeometry(of, edge, BORDER_Z + z);
    if (borderGeo) {
      const bk = `${name}_border_${key}`;
      pool.ensureBucket(bk, borderGeo, paint(border), false, true);
      instances.push({ key: bk, id: pool.addInstance(bk, pos) });
    }
    const roadGeo = buildRoadGeometry(of, HALF_W, ROAD_Z + z);
    if (roadGeo) {
      const rk = `${name}_${key}`;
      pool.ensureBucket(rk, roadGeo, paint(surface), false, true);
      instances.push({ key: rk, id: pool.addInstance(rk, pos) });
    }
  };

  // A street is white. A road is the map's yellow, and reads as one
  // continuous piece: where a street joins it, the whole junction is laid
  // in white underneath — the street curving onto the road — and the road's
  // own arms in yellow over it, kerb and all.
  const main = road ? arms.filter((a) => a.road) : arms;
  if (main.length < arms.length) lay("road", arms, theme.roadBorder, theme.road, 0, BORDER_HALF_W);
  if (road) lay("highway", main, theme.highwayBorder, theme.highway, HIGHWAY_LIFT, BORDER_HALF_W);
  else lay("road", arms, theme.roadBorder, theme.road, 0, BORDER_HALF_W);

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
