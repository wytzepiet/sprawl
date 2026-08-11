import Canvas from "./Canvas";
import { OrthoCamera } from "./OrthoCamera";
import DayNightLights, { DayNightProvider } from "./DayNightCycle";
import { InstancePoolProvider } from "./InstancePool";
import Headlights from "./Headlights";
import { RoadDrawer } from "./RoadDrawer";
import { ZoneDrawer } from "./ZoneDrawer";
import { BuildingPlacer } from "./BuildingPlacer";
import World from "./World";
import BuildModeToolbar from "../ui/BuildModeToolbar";
import TimeControls from "../ui/TimeControls";
import { GameProvider } from "../state/gameObjects";
import { ThemeProvider } from "./theme";
import DebugOverlay from "../ui/DebugOverlay";
import FrameStats from "../ui/FrameStats";

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
              <ZoneDrawer />
              <BuildingPlacer />
              <World />
            </InstancePoolProvider>
          </Headlights>
        </DayNightLights>
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
