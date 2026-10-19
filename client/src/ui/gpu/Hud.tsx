/** @jsxImportSource ~ui */
import Feed from "./Feed";
import Pins from "./Pins";
import Lumps from "./Lumps";
import Held from "./Held";
import Clock from "./Clock";
import Meter from "./Meter";
import Dock from "./Dock";
import Card from "./Card";
import Board from "./Board";

/** Everything the GPU draws over the town, the first under the rest:
 *  what is pinned to the map, the corners and the dock, then the open
 *  card and the feed over them. */
export default function Hud() {
  return (
    <>
      <Pins />
      <Lumps />
      <Held />
      <Clock />
      <Meter />
      <Dock />
      <Card />
      <Board />
      <Feed />
    </>
  );
}
