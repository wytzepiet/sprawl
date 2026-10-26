import { createEffect } from "solid-js";
import { sea } from "../state/sea";
import { following, setFollowing } from "../state/selection";
import { mayorsLorry } from "../state/haul";
import { missions } from "../state/missions";

/**
 * A new town's first ferry, watched in: the camera rides it to the ramp,
 * then goes to the lorry it brought, the mayor's. Once, in a town that
 * has done nothing yet, while that ferry is still on its way; a pan lets
 * go of it, as of anything followed.
 */
export default function Arrival() {
  let state: "waiting" | "riding" | "done" = "waiting";
  createEffect(() => {
    const lorry = mayorsLorry();
    const sailing = sea.sailings[0];
    const fresh = missions().some((m) => m.key === "Opening" && !m.steps.some((s) => s.done));
    if (state === "waiting" && sailing && missions().length) {
      if (lorry || sailing.berthed || !fresh) state = "done";
      else (state = "riding"), setFollowing(sailing.ferry);
    } else if (state === "riding" && lorry) {
      state = "done";
      if (following() === sailing?.ferry) setFollowing(lorry.id);
    }
  });
  return null;
}
