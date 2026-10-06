import Canvas from "./Canvas";
import { OrthoCamera } from "./OrthoCamera";
import DayNightLights, { DayNightProvider } from "./DayNightCycle";
import { InstancePoolProvider } from "./InstancePool";
import Headlights from "./Headlights";
import { Picker } from "./Picker";
import { Highlight } from "./Highlight";
import World from "./World";
import BuildModeToolbar from "../ui/BuildModeToolbar";
import TimeControls from "../ui/TimeControls";
import { GameProvider } from "../state/gameObjects";
import { ThemeProvider } from "./theme";
import DebugOverlay from "../ui/DebugOverlay";
import FrameStats from "../ui/FrameStats";
import PerfReport from "./PerfReport";
import PinLayer from "../ui/PinLayer";
import LumpLayer from "../ui/LumpLayer";
import GrowthMeter from "../ui/GrowthMeter";
import SkillTree from "../ui/SkillTree";
import Card from "../ui/Card";
import Board from "../ui/Board";
import Glass from "../ui/Glass";

function SceneInner() {
  return (
    <DayNightProvider>
      <Canvas>
        <OrthoCamera />
        {/* <FrameStats /> */}
        {import.meta.env.DEV && <PerfReport />}
        <DayNightLights>
          <Headlights>
            <InstancePoolProvider>
              <Picker />
              <Highlight />
              <World />
            </InstancePoolProvider>
          </Headlights>
        </DayNightLights>
        <PinLayer />
        <LumpLayer />
        <GrowthMeter />
        <Card />
        <Board />
        <SkillTree />
      </Canvas>
      <Glass />
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
