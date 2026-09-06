import Canvas from "./Canvas";
import { OrthoCamera } from "./OrthoCamera";
import DayNightLights, { DayNightProvider } from "./DayNightCycle";
import { InstancePoolProvider } from "./InstancePool";
import Headlights from "./Headlights";
import { RoadDrawer } from "./RoadDrawer";
import { BuildingPlacer } from "./BuildingPlacer";
import Walkers from "./Walkers";
import World from "./World";
import BuildModeToolbar from "../ui/BuildModeToolbar";
import TimeControls from "../ui/TimeControls";
import { GameProvider } from "../state/gameObjects";
import { ThemeProvider } from "./theme";
import DebugOverlay from "../ui/DebugOverlay";
import FrameStats from "../ui/FrameStats";
import PinLayer from "../ui/PinLayer";
import GrowthMeter from "../ui/GrowthMeter";
import SkillTree from "../ui/SkillTree";

function SceneInner() {
  return (
    <DayNightProvider>
      <Canvas>
        <OrthoCamera />
        {/* <FrameStats /> */}
        <DayNightLights>
          <Headlights>
            <InstancePoolProvider>
              <RoadDrawer />
              <BuildingPlacer />
              <World />
              <Walkers />
            </InstancePoolProvider>
          </Headlights>
        </DayNightLights>
        <PinLayer />
        <GrowthMeter />
        <SkillTree />
      </Canvas>
      <BuildModeToolbar />
      <TimeControls />
      {/* <DebugOverlay /> */}
    </DayNightProvider>
  );
}

export default function Scene(props: { wsUrl: string }) {
  return (
    <ThemeProvider>
      <GameProvider wsUrl={props.wsUrl}>
        <SceneInner />
      </GameProvider>
    </ThemeProvider>
  );
}
