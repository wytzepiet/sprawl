/** @jsxImportSource ~ui */
import Feed from "./Feed";
import Cargo from "./Cargo";
import Lumps from "./Lumps";
import Held, { Carry } from "./Held";
import Clock from "./Clock";
import Meter from "./Meter";
import Dock from "./Dock";
import Board from "./Board";
import Ring from "./Ring";
import { wide } from "./kit";

/** Everything the GPU draws over the town, the first under the rest:
 *  what is pinned to the map, the dials along the top, the dock and its
 *  sheet, then the books and the feed over them, and a building's ring
 *  over all. */
export default function Hud() {
  return (
    <>
      <Cargo />
      <Lumps />
      <Held />
      <Carry />
      <box at={wide() ? { left: 24, top: 24 } : { left: 12, right: 12, top: 12 }} dir="row" align="center" justify="between" gap={12}>
        <Clock />
        <Meter />
      </box>
      <Dock />
      <Board />
      <Feed />
      <Ring />
    </>
  );
}
