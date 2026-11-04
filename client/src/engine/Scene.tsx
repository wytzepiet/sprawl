import Canvas, { Registered } from "./Canvas";
import { Camera } from "./Camera";
import DayNightLights, { DayNightProvider } from "./DayNightCycle";
import { InstancePoolProvider } from "./InstancePool";
import { Picker } from "./Picker";
import { Highlight } from "./Highlight";
import World from "./World";
import { GameProvider, type Connect } from "../state/gameObjects";
import PerfReport, { run } from "./PerfReport";
import Signs from "./Signs";
import { Root } from "~ui";
import Hud from "../ui/Hud";

function SceneInner() {
  return (
    <DayNightProvider>
      <Canvas>
        <Camera />
        {run && <PerfReport />}
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
        <Root>
          <Hud />
        </Root>
      </Canvas>
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
