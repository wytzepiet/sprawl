import { onCleanup } from "solid-js";
import { useEngine } from "./Canvas";
import { projector } from "./view";
import { underGlass } from "./glass";
import { ghost } from "../state/guide";
import { held } from "../ui/buildMode";

/** The dashes' ink, and their run along the street, in tiles a second. */
const INK = "rgba(255,255,255,0.92)";
const EDGE = "rgba(20,30,40,0.35)";
const RUN = 0.6;

/**
 * The street the guide's ghost needs, dashed on the ground from the
 * town's street to its door, marching toward the ghost: drawn flat over
 * the scene, as the hand's dots are, while the hand is empty or holds a
 * street to draw it with.
 */
export default function Dashes() {
  const { scene, canvas, afterRender } = useEngine();
  const el = document.createElement("canvas");
  el.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none";
  document.body.appendChild(el);
  const ctx = el.getContext("2d")!;
  const start = performance.now();
  const stop = afterRender(() => {
    const dpr = window.devicePixelRatio || 1;
    const [w, h] = [Math.round(innerWidth * dpr), Math.round(innerHeight * dpr)];
    if (el.width !== w || el.height !== h) [el.width, el.height] = [w, h];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const road = ghost()?.road ?? [];
    if (road.length < 2 || held()) return;
    const project = projector(scene, canvas);
    const pts = road.map((t) => project.at(t.x + 0.5, t.y + 0.5));
    const tile = Math.hypot(pts[1].sx - pts[0].sx, pts[1].sy - pts[0].sy);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash([tile * 0.35, tile * 0.3]);
    ctx.lineDashOffset = -(((performance.now() - start) / 1000) * RUN * tile);
    for (const [ink, width] of [[EDGE, 0.2], [INK, 0.12]] as const) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(2, tile * width);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.sx, p.sy) : ctx.moveTo(p.sx, p.sy)));
      ctx.stroke();
    }
    underGlass(ctx);
  });
  onCleanup(() => (stop(), el.remove()));
  return null;
}
