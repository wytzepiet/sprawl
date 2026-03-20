import { createContext, useContext, createMemo, onCleanup, type ParentProps } from "solid-js";
import { ClusteredLightContainer } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import { useDayNight } from "./DayNightCycle";

interface HeadlightState {
  container: ClusteredLightContainer;
  headlightIntensity: () => number;
}

const HeadlightCtx = createContext<HeadlightState>();

export function useHeadlights(): HeadlightState {
  const ctx = useContext(HeadlightCtx);
  if (!ctx) throw new Error("useHeadlights must be used within <Headlights>");
  return ctx;
}

const TARGET_TILES = 512;

export default function Headlights(props: ParentProps) {
  const { engine, scene } = useEngine();
  const { timeOfDay } = useDayNight();

  const container = new ClusteredLightContainer("headlights", [], scene);
  container.depthSlices = 1;
  container.maxRange = 5;

  function updateTiles() {
    const aspect = engine.getRenderWidth() / engine.getRenderHeight();
    // TARGET_TILES = h * w = h * (h * aspect) = h² * aspect
    const h = Math.max(1, Math.round(Math.sqrt(TARGET_TILES / aspect)));
    container.verticalTiles = h;
    container.horizontalTiles = Math.max(1, Math.round(h * aspect));
  }
  updateTiles();
  window.addEventListener("resize", updateTiles);

  const headlightIntensity = createMemo(() => {
    const t = timeOfDay();
    if (t < 0.20 || t > 0.80) return 1.0;
    if (t < 0.30) return 1.0 - (t - 0.20) / 0.10;
    if (t > 0.70) return (t - 0.70) / 0.10;
    return 0.0;
  });

  onCleanup(() => {
    window.removeEventListener("resize", updateTiles);
    container.dispose();
  });

  const state: HeadlightState = { container, headlightIntensity };

  return <HeadlightCtx.Provider value={state}>{props.children}</HeadlightCtx.Provider>;
}
