import { createMemo } from "solid-js";
import { buildingAt, getEntity } from "../state/gameObjects";
import { now } from "../state/sea";
import { setFollowing } from "../state/selection";
import { type Link } from "./kit";
import type { Building, Good } from "../generated";

/** A depot as a harbour's or a site's card lists it (`card.rs`). */
export interface DepotLine {
  depot: Link;
  tiles: number;
  joined: boolean;
  stocks: Partial<Record<Good, number>>;
}

/** A building of the client's, read again four times a second. */
export const building = (id: number) =>
  createMemo(() => {
    now();
    const e = getEntity(id);
    return e?.object.kind === "Building" ? (e.object.data as Building) : null;
  });

/** The eye: the camera to it, and after it as it goes. */
export function FollowBtn(props: { id: number; fallback?: number }) {
  return (
    <button
      class="press soft -my-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold cursor-pointer"
      style={{ border: "1.5px solid rgb(var(--ink) / 0.15)" }}
      onClick={() => setFollowing(getEntity(props.id)?.position || !props.fallback ? props.id : props.fallback)}
      title="Follow it"
    >
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
      follow
    </button>
  );
}

/** The harbour a lorry is standing at, if any. */
export const atHarbour = (car: { x: number; y: number } | null) => {
  if (!car) return false;
  const b = buildingAt(car.x, car.y);
  return b?.object.kind === "Building" && (b.object.data as Building).kind === "Harbour";
};

