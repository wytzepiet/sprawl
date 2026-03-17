import { For } from "solid-js";
import Canvas from "./Canvas";
import { OrthoCamera } from "./OrthoCamera";
import DayNightCycle from "./DayNightCycle";
import { InstancePoolProvider } from "./InstancePool";
import { RoadDrawer } from "./RoadDrawer";
import { BuildingPlacer } from "./BuildingPlacer";
import GameObject from "./GameObject";
import BuildModeToolbar from "../ui/BuildModeToolbar";
import DebugOverlay from "../ui/DebugOverlay";
import { GameProvider, useGame } from "../state/gameObjects";
import { ThemeProvider } from "./theme";

function SceneInner() {
  const { objects, objectIds } = useGame();

  return (
    <>
      <Canvas>
        <OrthoCamera />
        <DayNightCycle>
          <InstancePoolProvider>
            <RoadDrawer />
            <BuildingPlacer />
            <For each={objectIds} keyed={(id) => id}>
              {(id) => {
                console.log("For item", id());
                return <GameObject entry={objects[id()]} />;
              }}
            </For>
          </InstancePoolProvider>
        </DayNightCycle>
      </Canvas>
      <BuildModeToolbar />
      <DebugOverlay />
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
