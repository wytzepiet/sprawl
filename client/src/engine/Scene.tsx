import Canvas, { Registered } from "./Canvas";
import { OrthoCamera } from "./OrthoCamera";
import DayNightLights, { DayNightProvider } from "./DayNightCycle";
import { InstancePoolProvider } from "./InstancePool";
import { Picker } from "./Picker";
import { Highlight } from "./Highlight";
import World from "./World";
import { GameProvider, type Connect } from "../state/gameObjects";
import { ThemeProvider } from "./theme";
import DebugOverlay from "../ui/DebugOverlay";
import PerfReport from "./PerfReport";
import Pins from "./Pins";
import LumpLayer from "../ui/LumpLayer";
import Glass from "../ui/Glass";
import Shipments, { BoxPins } from "../ui/Shipments";
import Hud from "./Hud";

function SceneInner() {
  return (
    <DayNightProvider>
      <Canvas>
        <OrthoCamera />
        {import.meta.env.DEV && <PerfReport />}
        <DayNightLights>
          <Registered>
            <InstancePoolProvider>
              <Picker />
              <Highlight />
              <World />
              <Pins />
            </InstancePoolProvider>
          </Registered>
        </DayNightLights>
        <LumpLayer />
        <BoxPins />
        <Hud />
      </Canvas>
      <Glass />
      <Shipments />
      {/* <DebugOverlay /> */}
    </DayNightProvider>
  );
}

export default function Scene(props: { connect: Connect }) {
  return (
    <ThemeProvider>
      <GameProvider connect={props.connect}>
        <SceneInner />
      </GameProvider>
    </ThemeProvider>
  );
}
