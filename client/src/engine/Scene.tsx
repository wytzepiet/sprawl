import Canvas, { Registered } from "./Canvas";
import { Camera } from "./Camera";
import DayNightLights, { DayNightProvider } from "./DayNightCycle";
import { InstancePoolProvider } from "./InstancePool";
import { Picker } from "./Picker";
import { Highlight } from "./Highlight";
import World from "./World";
import { GameProvider, type Connect } from "../state/gameObjects";
import PerfReport from "./PerfReport";
import Signs from "./Signs";
import Shipments from "../ui/Shipments";
import Hud from "./Hud";
import Gpu from "../ui/Hud";

function SceneInner() {
  return (
    <DayNightProvider>
      <Canvas>
        <Camera />
        {/* Only while `bun run pan` measures: it names its tab. */}
        {import.meta.env.DEV && new URLSearchParams(location.search).has("tab") && <PerfReport />}
        <DayNightLights>
          <Registered>
            <InstancePoolProvider>
              <Picker />
              <Highlight />
              <World />
              <Signs />
            </InstancePoolProvider>
          </Registered>
        </DayNightLights>
        <Hud ui={Gpu} />
      </Canvas>
      <Shipments />
    </DayNightProvider>
  );
}

export default function Scene(props: { connect: Connect }) {
  return (
    <GameProvider connect={props.connect}>
      <SceneInner />
    </GameProvider>
  );
}
