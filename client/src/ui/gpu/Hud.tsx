/** @jsxImportSource ~ui */
import Feed from "./Feed";
import Clock from "./Clock";
import Meter from "./Meter";
import Dock from "./Dock";

/** Everything the GPU draws over the town, the first under the rest:
 *  the corners and the dock, then the feed over them. */
export default function Hud() {
  return (
    <>
      <Clock />
      <Meter />
      <Dock />
      <Feed />
    </>
  );
}
