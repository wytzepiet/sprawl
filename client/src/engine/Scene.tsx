import { For } from "solid-js";
import Canvas from "./Canvas";
import { OrthoCamera } from "./OrthoCamera";
import DayNightCycle from "./DayNightCycle";
import { Grid } from "./Grid";
import { RoadDrawer } from "./RoadDrawer";
import { BuildingPlacer } from "./BuildingPlacer";
import GameObject from "./GameObject";
import BuildModeToolbar from "../ui/BuildModeToolbar";
import { GameProvider, useGame } from "../state/gameObjects";

function SceneInner() {
  const { objects } = useGame();

  return (
    <>
      <Canvas>
        <OrthoCamera />
        <DayNightCycle>
          <Grid />
          <RoadDrawer />
          <BuildingPlacer />
          <For each={Object.values(objects).filter(Boolean)}>
            {(entry) => <GameObject entry={entry()} />}
          </For>
        </DayNightCycle>
      </Canvas>
      <BuildModeToolbar />
    </>
  );
}

export default function Scene() {
  return (
    <GameProvider>
      <SceneInner />
    </GameProvider>
  );
}
