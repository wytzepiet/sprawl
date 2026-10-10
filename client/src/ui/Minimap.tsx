import { onCleanup, onMount } from "solid-js";
import { drawFlat, type View } from "../flat/draw";
import { eachEntity, groundOf, me } from "../state/gameObjects";
import { drafts } from "../state/drafts";
import { dayLengthMs, simNow } from "../network/clock";
import { eye } from "../engine/OrthoCamera";
import { useTheme } from "../engine/theme";

/** Its side in CSS pixels; the fewest tiles it shows across, and how many
 *  times the camera's view it shows when that is more; how often it is
 *  drawn again. */
const SIZE = 184;
const SPAN = 96;
const ZOOM_OUT = 3;
const EVERY_MS = 300;

/**
 * The map round the camera, flat (`flat/draw.ts`), in the corner: the
 * island as far as it has been seen, the roads, the buildings, every
 * vehicle a dot, and the camera's view outlined. A click sends the camera
 * there. Its rim is the glass's colour but not the GPU's glass, whose
 * frost would be drawn round a picture that hides it.
 */
export default function Minimap() {
  let canvas!: HTMLCanvasElement;
  const theme = useTheme();
  const sheet = (w: number, h: number) => Object.assign(document.createElement("canvas"), { width: w, height: h });
  const view = (): View => {
    const w = Math.round(SIZE * devicePixelRatio);
    return { x: eye.x, y: eye.y, px: w / Math.max(SPAN, ZOOM_OUT * 2 * Math.max(eye.halfW, eye.halfH)), w, h: w };
  };
  const draw = () => {
    const v = view();
    if (canvas.width !== v.w) canvas.width = canvas.height = v.w;
    const g = canvas.getContext("2d")!;
    drawFlat(g, { entities: eachEntity, drafts: drafts(), me: me(), ground: groundOf, now: simNow(), dayMs: dayLengthMs() }, v, sheet, { labels: false, theme: theme() });
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.strokeStyle = "rgba(255,255,255,0.9)";
    g.lineWidth = 1.5 * devicePixelRatio;
    g.strokeRect(v.w / 2 - eye.halfW * v.px, v.h / 2 - eye.halfH * v.px, 2 * eye.halfW * v.px, 2 * eye.halfH * v.px);
  };
  onMount(() => {
    draw();
    const timer = setInterval(draw, EVERY_MS);
    onCleanup(() => clearInterval(timer));
  });
  const go = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const v = view();
    const [sx, sy] = [((e.clientX - r.left) / r.width) * v.w, ((e.clientY - r.top) / r.height) * v.h];
    eye.go(v.x - (sx - v.w / 2) / v.px, v.y - (sy - v.h / 2) / v.px);
  };
  // Shown and hidden with the UI, not with the map's canvas, which the
  // photographs keep when they hide the UI (`look`, `shots`).
  return (
    <div class="fixed right-6 bottom-7 z-30 rounded-[22px] p-1.5 select-none" style={{ background: "rgb(var(--glass) / 0.9)", "box-shadow": "0 4px 18px rgb(0 0 0 / 0.18)" }}>
      <canvas ref={canvas} class="block cursor-pointer rounded-[16px]" style={{ width: `${SIZE}px`, height: `${SIZE}px`, visibility: "inherit" }} onPointerDown={go} />
    </div>
  );
}
