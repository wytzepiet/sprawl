import { For, Show, createMemo } from "solid-js";
import { Color3 } from "@babylonjs/core";
import Mesh, { type MeshGeometry } from "../Mesh";
import InstancedMesh from "../InstancePool";
import type { KindEntry } from "../GameObject";
import { useTheme } from "../theme";
import { useGame } from "../../state/gameObjects";
import type { GameObjectEntry } from "../../generated";

type Flow = "twoway" | "out" | "in";
type ArmInfo = { angle: number; flow: Flow };
type Point = { x: number; y: number };

const ROAD_WIDTH = 0.4;
const HALF_W = ROAD_WIDTH / 2;
const BORDER_HALF_W = HALF_W + 0.04;
const CURVE_SEGMENTS = 8;
const ROAD_Z = 0.02;
const BORDER_Z = 0.015;
const CHEVRON_Z = 0.03;
const CHEVRON_DEPTH = 0.12;

// --- Geometry helpers ---

function fanGeometry(
  boundary: Point[],
  z: number,
  center?: Point,
): MeshGeometry {
  const c = center ?? { x: 0, y: 0 };
  const n = boundary.length;
  const positions: number[] = [c.x, c.y, z];
  const normals: number[] = [0, 0, 1];
  const indices: number[] = [];

  for (const pt of boundary) {
    positions.push(pt.x, pt.y, z);
    normals.push(0, 0, 1);
  }
  for (let i = 0; i < n; i++) {
    indices.push(0, ((i + 1) % n) + 1, i + 1);
  }

  return { positions, indices, normals };
}

function arcPoints(startAngle: number, endAngle: number, hw: number): Point[] {
  let span = endAngle - startAngle;
  if (span <= 0) span += 2 * Math.PI;
  const numSegs = Math.max(
    2,
    Math.round((span / (Math.PI / 2)) * CURVE_SEGMENTS),
  );
  const pts: Point[] = [];
  for (let j = 0; j <= numSegs; j++) {
    const angle = startAngle + span * (j / numSegs);
    pts.push({ x: hw * Math.cos(angle), y: hw * Math.sin(angle) });
  }
  return pts;
}

function quadBezier(p0: Point, p1: Point, p2: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
  };
}

function edgePoints(a: number, hw: number): { right: Point; left: Point } {
  const armLen = 0.5 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
  const ex = armLen * Math.cos(a);
  const ey = armLen * Math.sin(a);
  const px = -Math.sin(a);
  const py = Math.cos(a);
  return {
    left: { x: ex + hw * px, y: ey + hw * py },
    right: { x: ex - hw * px, y: ey - hw * py },
  };
}

function curveControlPoint(
  aCurr: number,
  aNext: number,
  start: Point,
  end: Point,
  hw: number,
): Point {
  const det = Math.sin(aNext - aCurr);
  if (Math.abs(det) < 1e-6) {
    return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  }
  return {
    x: (hw * (Math.cos(aNext) + Math.cos(aCurr))) / det,
    y: (hw * (Math.sin(aCurr) + Math.sin(aNext))) / det,
  };
}

// --- Gap fill strategies ---

function smoothCurve(
  aCurr: number,
  aNext: number,
  currEdge: { left: Point },
  nextEdge: { right: Point },
  hw: number,
): Point[] {
  let gap = aNext - aCurr;
  if (gap <= 0) gap += 2 * Math.PI;
  const cp = curveControlPoint(aCurr, aNext, currEdge.left, nextEdge.right, hw);
  const numSegs = Math.max(
    2,
    Math.round((gap / (Math.PI / 2)) * CURVE_SEGMENTS),
  );
  const pts: Point[] = [];
  for (let j = 1; j < numSegs; j++) {
    pts.push(quadBezier(currEdge.left, cp, nextEdge.right, j / numSegs));
  }
  return pts;
}

function deadEndCap(aCurr: number, aNext: number, hw: number): Point[] {
  return arcPoints(aCurr + Math.PI / 2, aNext - Math.PI / 2, hw);
}

function sharpCorner(
  aCurr: number,
  aNext: number,
  currLeft: Point,
  nextRight: Point,
): Point[] {
  const d1 = { x: -Math.cos(aCurr), y: -Math.sin(aCurr) };
  const d2 = { x: -Math.cos(aNext), y: -Math.sin(aNext) };
  const det = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(det) < 1e-6) return [];
  const dx = nextRight.x - currLeft.x;
  const dy = nextRight.y - currLeft.y;
  const t = (dx * d2.y - dy * d2.x) / det;
  return [{ x: currLeft.x + t * d1.x, y: currLeft.y + t * d1.y }];
}

// --- Geometry builders ---

function buildRoadGeometry(arms: ArmInfo[], hw: number, z: number): MeshGeometry | null {
  if (arms.length === 0) return null;

  const sorted = [...arms].sort((a, b) => a.angle - b.angle);
  const boundary: Point[] = [];

  if (sorted.length === 1) {
    const a = sorted[0].angle;
    const edge = edgePoints(a, hw);
    boundary.push(edge.right, edge.left);
    boundary.push(...arcPoints(a + Math.PI / 2, a + (3 * Math.PI) / 2, hw));
  } else {
    for (let i = 0; i < sorted.length; i++) {
      const curr = sorted[i];
      const next = sorted[(i + 1) % sorted.length];
      const aCurr = curr.angle;
      const aNext = next.angle;
      const currEdge = edgePoints(aCurr, hw);
      const nextEdge = edgePoints(aNext, hw);

      boundary.push(currEdge.right, currEdge.left);

      let gap = aNext - aCurr;
      if (gap <= 0) gap += 2 * Math.PI;

      const isContinuous =
        (curr.flow === "twoway" && next.flow === "twoway") ||
        (curr.flow !== "twoway" &&
          next.flow !== "twoway" &&
          curr.flow !== next.flow);
      const isDrivable =
        curr.flow === "twoway" ||
        next.flow === "twoway" ||
        curr.flow !== next.flow;

      if (gap > Math.PI && !isContinuous) {
        boundary.push(...deadEndCap(aCurr, aNext, hw));
      } else if (isDrivable) {
        boundary.push(...smoothCurve(aCurr, aNext, currEdge, nextEdge, hw));
      } else {
        boundary.push(
          ...sharpCorner(aCurr, aNext, currEdge.left, nextEdge.right),
        );
      }
    }
  }

  return fanGeometry(boundary, z);
}

interface ChevronData {
  geometry: MeshGeometry;
}

function buildChevronGeometry(a: number): ChevronData {
  const fwd = { x: Math.cos(a), y: Math.sin(a) };
  const side = { x: -Math.sin(a), y: Math.cos(a) };
  const armLen = 0.5 / Math.max(Math.abs(fwd.x), Math.abs(fwd.y));

  const tip = armLen;
  const back = armLen - 2 * CHEVRON_DEPTH;

  const along = (d: number, s: number): Point => ({
    x: d * fwd.x + s * side.x,
    y: d * fwd.y + s * side.y,
  });

  const pts = [along(tip, 0), along(back, HALF_W), along(back, -HALF_W)];
  const cx = (pts[0].x + pts[1].x + pts[2].x) / 3;
  const cy = (pts[0].y + pts[1].y + pts[2].y) / 3;
  return { geometry: fanGeometry(pts, CHEVRON_Z, { x: cx, y: cy }) };
}

// --- Connection detection ---

function getConnectionArms(
  entry: GameObjectEntry,
  objects: Record<string, GameObjectEntry | undefined>,
): ArmInfo[] {
  if (entry.object.kind !== "RoadNode" || !entry.position) return [];
  const { x, y } = entry.position;
  const { outgoing, incoming } = entry.object.data;
  const arms: ArmInfo[] = [];

  for (const nId of outgoing) {
    const neighbor = objects[String(nId)];
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
    const neighbor = objects[String(nId)];
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

// --- Component ---

export default function RoadNode(props: { entry: KindEntry<"RoadNode"> }) {
  const { objects } = useGame();
  const theme = useTheme();

  const arms = createMemo(() => {
    const a = getConnectionArms(props.entry, objects);
    return { arms: a, key: armsKey(a) };
  });

  const roadGeometry = createMemo(() => buildRoadGeometry(arms().arms, HALF_W, ROAD_Z));
  const borderGeometry = createMemo(() => buildRoadGeometry(arms().arms, BORDER_HALF_W, BORDER_Z));

  const chevrons = createMemo(() =>
    arms().arms
      .filter((a) => a.flow === "out")
      .map((arm) => buildChevronGeometry(arm.angle)),
  );

  const arrowColor = createMemo(() => new Color3(
    Math.min(1, theme().road.r + 0.25),
    Math.min(1, theme().road.g + 0.25),
    Math.min(1, theme().road.b + 0.25),
  ));

  const pos = (): [number, number, number] | undefined =>
    props.entry.position
      ? [props.entry.position.x + 0.5, props.entry.position.y + 0.5, 0]
      : undefined;

  return (
    <>
      <Show when={borderGeometry()}>
        {(geo) => (
          <InstancedMesh
            poolKey={`road_border_${arms().key}`}
            geometry={geo()}
            position={pos()}
            color={theme().roadBorder}
            receiveShadow
          />
        )}
      </Show>
      <Show when={roadGeometry()}>
        {(geo) => (
          <InstancedMesh
            poolKey={`road_${arms().key}`}
            geometry={geo()}
            position={pos()}
            color={theme().road}
            receiveShadow
          />
        )}
      </Show>
      <For each={chevrons()}>
        {(chevron) => (
          <Mesh
            name={`chevron_${props.entry.id}`}
            geometry={chevron().geometry}
            position={pos()}
            color={arrowColor()}
          />
        )}
      </For>
    </>
  );
}
