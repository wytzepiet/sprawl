/** @jsxImportSource ~ui */
import Feed from "./Feed";
import Cargo from "./Cargo";
import Lumps from "./Lumps";
import Held from "./Held";
import Clock from "./Clock";
import Meter from "./Meter";
import Dock from "./Dock";
import Board from "./Board";
import Ring from "./Ring";
import Newer from "./Newer";
import { BEZEL, CORNER, view, wide } from "./kit";

/** Everything the GPU draws over the town, the first under the rest:
 *  what is pinned to the map; the bezel round the game, and grown out of
 *  it the clock and the level and purse in the top corners and the dock
 *  along the foot; on a branch's preview, a newer build under the top;
 *  then the books and the feed over them, and a building's ring over all. */
export default function Hud() {
  return (
    <>
      <Cargo />
      <Lumps />
      <Held />
      <glass layer="bezel" hole at={{ left: BEZEL, right: BEZEL, top: BEZEL }} h={view().h - 2 * BEZEL} round={22} />
      <Clock />
      <Meter />
      <box at={{ left: 0, right: 0, top: BEZEL + CORNER + (wide() ? 14 : 12) }} align="center">
        <Newer />
      </box>
      <Dock />
      <Board />
      <Feed />
      <Ring />
    </>
  );
}
