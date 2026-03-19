import Canvas from "./Canvas";
import { OrthoCamera } from "./OrthoCamera";
import DayNightCycle from "./DayNightCycle";
import { InstancePoolProvider } from "./InstancePool";
import Headlights from "./Headlights";
import { RoadDrawer } from "./RoadDrawer";
import { BuildingPlacer } from "./BuildingPlacer";
import World from "./World";
import BuildModeToolbar from "../ui/BuildModeToolbar";
import { GameProvider } from "../state/gameObjects";
import { ThemeProvider } from "./theme";

function SceneInner() {
  return (
    <>
      <Canvas>
        <OrthoCamera />
        <DayNightCycle>
          <Headlights>
            <InstancePoolProvider>
              <RoadDrawer />
              <BuildingPlacer />
              <World />
            </InstancePoolProvider>
          </Headlights>
        </DayNightCycle>
      </Canvas>
      <BuildModeToolbar />
      {/* <DebugOverlay /> */}
    </>
  );
}

export default function Scene() {
  return (
    <ThemeProvider>
      <GameProvider>
        <SceneInner />
      </GameProvider>
    </ThemeProvider>
  );
}
