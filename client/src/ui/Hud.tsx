import { Box, Ink, Melt } from "~ui";
import Feed from "./Feed";
import Cargo from "./Cargo";
import Lumps from "./Lumps";
import Pins from "./Pins";
import Held from "./Held";
import Clock from "./Clock";
import Meter from "./Meter";
import Dock from "./Dock";
import Board from "./Board";
import Ring from "./Ring";
import Newer from "./Newer";
import { bezel, CORNER, view, wide, WINDOW } from "./kit";

/** Everything over the town, the first under the rest: what is pinned
 *  to the map; the bezel round the game, one black, and grown out of
 *  it the clock and the level and purse in the top corners and the dock
 *  along the foot; on a branch's preview, a newer build under the top;
 *  then the books and the feed over them, and a building's ring over all. */
export default function Hud() {
  return (
    <>
      <Cargo />
      <Pins />
      <Lumps />
      <Held />
      <Melt layer="bezel" at={{ left: 0, top: 0, right: 0, bottom: 0 }}>
        <Ink layer="bezel" hole at={{ left: bezel(), right: bezel(), top: bezel() }} h={view().h - 2 * bezel()} round={wide() ? WINDOW : 0} />
        <Clock />
        <Meter />
        <Box at={{ left: 0, right: 0, top: bezel() + CORNER + (wide() ? 14 : 12) }} align="center">
          <Newer />
        </Box>
        <Dock />
        <Board />
        <Feed />
        <Ring />
      </Melt>
    </>
  );
}
