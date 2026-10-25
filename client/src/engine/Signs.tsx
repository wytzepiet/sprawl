import { createEffect, onCleanup } from "solid-js";
import { createTexture2DFromPixels, setPbrAlphaCutoff, type Texture2D } from "@babylonjs/lite";
import { useEngine } from "./Canvas";
import { useInstancePool } from "./InstancePool";
import { storeysOf } from "./town/grid";
import { seat } from "./town/mass";
import { INSET } from "./town/footprint";
import { WHITE } from "./rgb";
import { slab, type P } from "./geometry";
import { signed } from "../state/gameObjects";
import { BLUEPRINTS, standing } from "../blueprints";
import type { Building, BuildingKind } from "../generated";

/**
 * What a building says it is, made in the world, not on the page, lit by
 * the sun as the town is and under the UI's glass like everything else.
 *
 * A place (a shop, a bar, the port) has a sign lying on its roof: its
 * kind's colour and glyph, a slab sized to the building, so it shows as
 * you come in close and is the roof's own when you are far. Homes are the
 * bulk of a town and say nothing.
 *
 * The faces are SVG (the kind's colour, its glyph from the blueprints)
 * drawn into a texture, so the icons stay one source.
 */

/** How much of the flat it lies on a sign covers, across its shorter side:
 *  a small flat (a mansard's, a cap's), or a whole bare roof; how thick a plate is, and paint,
 *  of its width; its corners' rounding, of its width. */
const COVER = 0.6;
const PAINT_COVER = 0.55;
const SLAB = 0.06;
const PAINT = 0.004;
const ROUND = 0.2;
/** A face's texels across. */
const SIGN_TEXELS = 256;
/** Roof paint: an off-white, as roof markings are. */
const PAINT_INK = "#F3EEE2";

/** A building's mark: a plate, or a sign painted on its roof. */
type Look = "plate" | "paint";

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

export default function Signs() {
  const { engine } = useEngine();
  const pool = useInstancePool();
  const shapes = { plate: sign(SLAB), paint: sign(PAINT) };
  const faces = new Map<string, Promise<Texture2D>>();
  const faceOf = (look: Look, kind: BuildingKind) => {
    const key = `${look}_${kind}`;
    if (!faces.has(key)) {
      const made = look === "paint" ? paintFace(kind) : signFace(kind);
      faces.set(key, made.then((data) => createTexture2DFromPixels(engine, data, SIGN_TEXELS, SIGN_TEXELS, { format: "rgba8unorm", mipmaps: true, minFilter: "linear", magFilter: "linear" })));
    }
    return faces.get(key)!;
  };

  /** What is shown for each building: its sign, in its bucket. */
  const shown = new Map<number, { bucket: string; id: number; look: Look }>();

  const sync = () => {
    const keep = new Set<number>();
    for (const e of signed()) {
      const b = e.object.data as Building;
      const kind = b.kind;
      const where = seat({ kind, storeys: storeysOf(kind) });
      // Homes say nothing, nor a site, nor a harbour, whose ground is all
      // yard and no roof.
      const look: Look | null = BLUEPRINTS[kind].tab === "homes" || b.site || BLUEPRINTS[kind].quay ? null : where.painted ? "paint" : "plate";
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
      // Paint fills a small flat, a mansard's or a cap's; on a whole bare
      // roof it keeps to the middle, clear of what is cut from its plan.
      const at: [number, number, number] = [x, y, where.z];
      const scale = (where.inset > 0 ? COVER : PAINT_COVER) * flat;
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

  // Again when buildings change.
  createEffect(sync);

  onCleanup(() => {
    for (const { bucket, id } of shown.values()) if (id >= 0) pool.removeInstance(bucket, id);
    shown.clear();
  });
  return null;
}
