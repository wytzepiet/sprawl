/** @jsxImportSource ~ui */
import Feed from "./Feed";
import Held from "./Held";
import Clock from "./Clock";
import Meter from "./Meter";
import Dock from "./Dock";
import Ring from "./Ring";
import Newer from "./Newer";
import Pick from "./Pick";
import Wants from "./Wants";
import { wide } from "./kit";

/** Everything the GPU draws over the town, the first under the rest:
 *  what is pinned to the map, the dials along the top and, on a
 *  branch's preview, a newer build under them, the dock and its
 *  sheet, the pick over it, then the feed, and a building's ring
 *  over all. */
export default function Hud() {
  return (
    <>
      <Wants />
      <Held />
      <box at={wide() ? { left: 24, top: 24 } : { left: 12, right: 12, top: 12 }} dir="row" align="center" justify="between" gap={12}>
        <Clock />
        <Meter />
      </box>
      <box at={{ left: 0, right: 0, top: wide() ? 84 : 72 }} align="center">
        <Newer />
      </box>
      <Dock />
      <Pick />
      <Feed />
      <Ring />
    </>
  );
}
