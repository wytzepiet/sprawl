import { createEffect, onCleanup } from "solid-js";
import { createTexture2DFromPixels, setPbrAlphaCutoff, type Texture2D } from "@babylonjs/lite";
import { useEngine } from "./Canvas";
import { useInstancePool } from "./InstancePool";
import { viewExtent } from "./view";
import { storeysOf } from "./town/grid";
import { seat } from "./town/mass";
import { INSET } from "./town/footprint";
import { WHITE } from "./rgb";
import { slab, type P } from "./geometry";
import { pinned, reached } from "../state/gameObjects";
import { subject } from "../state/selection";
import { BLUEPRINTS, standing } from "../blueprints";
import type { Building, BuildingKind, GameObjectEntry } from "../generated";

/**
 * What a building says it is, made in the world, not on the page, lit by
 * the sun as the town is and under the UI's glass like everything else.
 *
 * A place (a shop, a bar, the port) has a sign lying on its roof: its
 * kind's colour and glyph, a slab sized to the building, so it shows as
 * you come in close and is the roof's own when you are far. Homes are the
 * bulk of a town and say nothing.
 *
 * A building no road reaches asks for one, so it has a marker instead,
 * floating over the roof and the same size on the screen at every zoom,
 * ringed red. So does the one whose card is open.
 *
 * Both faces are SVG (the kind's colour, its glyph from the blueprints)
 * drawn into a texture, so the icons stay one source.
 */

/**
 * The marker's outline: a circle of radius 10 at the origin, and a point at
 * (0,18). The two straight edges are the tangents from that point to the
 * circle, so they leave the arc at the same slope it ends on — one shape, not
 * a disc with a triangle stuck under it. Tangent points are at (±r·sinθ,
 * r·cosθ) where cosθ = r/d, which for r=10, d=18 puts them at (±8.315, 5.556).
 */
const OUTLINE = "M-8.315 5.556A10 10 0 1 1 8.315 5.556L0 18Z";
/** Where a building no road reaches is ringed. */
const UNREACHED = "#D9483B";

/** How tall a marker is on the screen, in CSS pixels, at every zoom; how
 *  far it floats above its roof, in tiles. */
const TALL = 32;
const LIFT = 0.35;
/** How much of the flat it lies on a sign covers, across its shorter side:
 *  a small flat (a mansard's, a cap's), or a whole bare roof; how thick a plate is, and paint,
 *  of its width; its corners' rounding, of its width. */
const COVER = 0.6;
const PAINT_COVER = 0.55;
const SLAB = 0.06;
const PAINT = 0.004;
const ROUND = 0.2;
/** Faces' texels: the marker's to a unit of its SVG's 22 × 30 box, the sign's across. */
const MARKER_TEXELS = 10;
const SIGN_TEXELS = 256;
/** Roof paint: an off-white, as roof markings are. */
const PAINT_INK = "#F3EEE2";

/** A building's mark: the marker, a plate, or a sign painted on its roof. */
type Look = "marker" | "plate" | "paint";

/** The marker: the outline, tip at the origin and a unit tall, its head up
 *  the screen (+y), its face the SVG's box, its sides the white of its rim. */
function marker() {
  const [r, d] = [10, 18];
  const tangent = (Math.atan2(5.556, 8.315) * 180) / Math.PI;
  const svg: P[] = [];
  for (let i = 0; i <= 28; i++) {
    // Over the top, the long way round from one tangent point to the other.
    const a = ((tangent - (i / 28) * (180 + 2 * tangent)) * Math.PI) / 180;
    svg.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  svg.push([0, d]);
  const local = ([sx, sy]: P): P => [sx / (r + d), (d - sy) / (r + d)];
  const toSvg = ([x, y]: P): P => [x * (r + d), d - y * (r + d)];
  return slab(svg.map(local), local([0, 0]), 0.1, (p) => { const [sx, sy] = toSvg(p); return [(sx + 11) / 22, (sy + 11) / 30]; }, [0.5, 2 / 30]);
}

/** The sign: a rounded square a unit across, centred, this thick, its
 *  face the whole texture, its sides its colour. */
function sign(thick: number) {
  const ring: P[] = [];
  const h = 0.5 - ROUND;
  for (const [cx, cy, start] of [[h, -h, -90], [h, h, 0], [-h, h, 90], [-h, -h, 180]] as [number, number, number][]) {
    for (let i = 0; i <= 6; i++) {
      const a = ((start + (i / 6) * 90) * Math.PI) / 180;
      ring.push([cx + ROUND * Math.cos(a), cy + ROUND * Math.sin(a)]);
    }
  }
  return slab(ring, [0, 0], thick, ([x, y]) => [x + 0.5, 0.5 - y], [0.04, 0.5]);
}

/** An SVG drawn into texels. */
async function texels(svg: string, w: number, h: number): Promise<Uint8Array> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  return new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
}

/** A marker's face: white, ringed red, the kind's disc and glyph. */
const markerFace = (kind: BuildingKind) => {
  const { color, glyph } = BLUEPRINTS[kind];
  const [w, h] = [22 * MARKER_TEXELS, 30 * MARKER_TEXELS];
  return texels(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="-11 -11 22 30">
<rect x="-11" y="-11" width="22" height="30" fill="#fff"/>
<path d="${OUTLINE}" fill="none" stroke="${UNREACHED}" stroke-width="2.4"/>
<circle r="7.8" fill="${color}"/>
<svg x="-6.5" y="-6.5" width="13" height="13" viewBox="0 0 24 24"><path d="${glyph}" fill="#fff" fill-rule="evenodd"/></svg>
</svg>`, w, h);
};

/** A sign's face: the kind's colour, its glyph in white. */
const signFace = (kind: BuildingKind) => {
  const { color, glyph } = BLUEPRINTS[kind];
  const s = SIGN_TEXELS;
  return texels(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24">
<rect width="24" height="24" fill="${color}"/>
<svg x="5" y="5" width="14" height="14" viewBox="0 0 24 24"><path d="${glyph}" fill="#fff" fill-rule="evenodd"/></svg>
</svg>`, s, s);
};

/** A sign painted on a roof: the glyph alone in white roof paint, which
 *  shows on any roof, as roof markings are; the roof shows through the
 *  rest (the material cuts it, `setPbrAlphaCutoff`). */
const paintFace = (kind: BuildingKind) => {
  const { glyph } = BLUEPRINTS[kind];
  const s = SIGN_TEXELS;
  return texels(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24">
<svg x="2" y="2" width="20" height="20" viewBox="0 0 24 24"><path d="${glyph}" fill="${PAINT_INK}" fill-rule="evenodd"/></svg>
</svg>`, s, s);
};

export default function Pins() {
  const { engine, scene, canvas, beforeRender } = useEngine();
  const pool = useInstancePool();
  const shapes = { marker: marker(), plate: sign(SLAB), paint: sign(PAINT) };
  const faces = new Map<string, Promise<Texture2D>>();
  const faceOf = (look: Look, kind: BuildingKind) => {
    const key = `${look}_${kind}`;
    if (!faces.has(key)) {
      const [w, h] = look === "marker" ? [22 * MARKER_TEXELS, 30 * MARKER_TEXELS] : [SIGN_TEXELS, SIGN_TEXELS];
      const made = look === "marker" ? markerFace(kind) : look === "paint" ? paintFace(kind) : signFace(kind);
      faces.set(key, made.then((data) => createTexture2DFromPixels(engine, data, w, h, { format: "rgba8unorm", mipmaps: true, minFilter: "linear", magFilter: "linear" })));
    }
    return faces.get(key)!;
  };

  /** What is shown for each building: a marker or a sign, in its bucket. */
  const shown = new Map<number, { bucket: string; id: number; look: Look }>();
  /** A marker's size in the world, for its constant size on the screen. */
  let size = 0;

  const sync = () => {
    const keep = new Set<number>();
    for (const e of pinned()) {
      const b = e.object.data as Building;
      const kind = b.kind;
      const where = seat({ kind, storeys: storeysOf(kind) });
      // Homes say nothing, nor a site, nor a harbour, whose ground is all
      // yard and no roof.
      const look: Look | null = !reached(e) || subject() === e.id ? "marker" : BLUEPRINTS[kind].tab === "homes" || b.site || BLUEPRINTS[kind].quay ? null : where.painted ? "paint" : "plate";
      if (!look) continue;
      keep.add(e.id);
      const bucket = `${look}_${kind}`;
      const old = shown.get(e.id);
      if (old?.bucket === bucket) continue;
      if (old && old.id >= 0) pool.removeInstance(old.bucket, old.id);
      const { at: [x, y], size: [w, h] } = standing(b);
      // The flat it lies on: the building stands INSET in from its lot,
      // and its roof's slope or cap's edge further in.
      const flat = Math.min(w, h) - 2 * INSET - 2 * where.inset;
      const [at, scale]: [[number, number, number], number] =
        // Paint fills a small flat, a mansard's or a cap's; on a whole bare
        // roof it keeps to the middle, clear of what is cut from its plan.
        look === "marker" ? [[x, y, where.z + LIFT], size] : [[x, y, where.z], (where.inset > 0 ? COVER : PAINT_COVER) * flat];
      // A bucket waits for its face; the building joins it once that is drawn.
      const entry = { bucket, id: -1, look };
      shown.set(e.id, entry);
      void faceOf(look, kind).then((texture) => {
        if (shown.get(e.id) !== entry) return;
        const made = pool.ensureBucket(bucket, shapes[look], WHITE, false, true, texture);
        // Paint is only where it is painted.
        if (look === "paint") setPbrAlphaCutoff(made.material, 0.5);
        entry.id = pool.addInstance(bucket, at, [0, 0, 0], scale);
      });
    }
    for (const [id, old] of shown) {
      if (keep.has(id)) continue;
      if (old.id >= 0) pool.removeInstance(old.bucket, old.id);
      shown.delete(id);
    }
  };

  // Again when buildings, roads or the open card change.
  createEffect(() => {
    subject();
    sync();
  });

  // Markers the same size on the screen at every zoom.
  onCleanup(
    beforeRender(() => {
      if (!scene.camera) return;
      const s = ((2 * viewExtent(scene, canvas).halfH) / Math.max(1, canvas.clientHeight)) * TALL;
      if (Math.abs(s - size) < size * 0.002) return;
      size = s;
      for (const { bucket, id, look } of shown.values()) if (look === "marker" && id >= 0) pool.updateInstance(bucket, id, undefined, undefined, [s, s, s]);
    }),
  );

  onCleanup(() => {
    for (const { bucket, id } of shown.values()) if (id >= 0) pool.removeInstance(bucket, id);
    shown.clear();
  });
  return null;
}
