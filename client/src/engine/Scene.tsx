import { For } from "solid-js";
import Canvas from "./Canvas";
import { OrthoCamera } from "./OrthoCamera";
import DayNightCycle from "./DayNightCycle";
import { InstancePoolProvider } from "./InstancePool";
import { RoadDrawer } from "./RoadDrawer";
import { BuildingPlacer } from "./BuildingPlacer";
import GameObject from "./GameObject";
import GridOverlay from "./GridOverlay";
import BuildModeToolbar from "../ui/BuildModeToolbar";
import DebugOverlay from "../ui/DebugOverlay";
import { GameProvider, useGame } from "../state/gameObjects";

function SceneInner() {
  const { objects } = useGame();

  const allObjects = () =>
    Object.values(objects) as (typeof objects[string])[];

  return (
    <>
      <Canvas>
        <OrthoCamera />
        <DayNightCycle>
          <GridOverlay />
          <InstancePoolProvider>
            <RoadDrawer />
            <BuildingPlacer />
            <For each={allObjects()} keyed={(e) => e!.id}>
              {(entry) => <GameObject entry={entry()!} />}
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
    <GameProvider>
      <SceneInner />
    </GameProvider>
  );
}
