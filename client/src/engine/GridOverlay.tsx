import { onCleanup, createEffect } from "solid-js";
import { MeshBuilder, Color3, Color4, Vector3 } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import { useDayNight } from "./DayNightCycle";
import { useTheme } from "./theme";

const MIN = -50;
const MAX = 50;
const Z = 0.01;

export default function GridOverlay() {
  const { scene } = useEngine();
  const { ambientColor } = useDayNight();
  const theme = useTheme();

  const lines: Vector3[][] = [];
  for (let i = MIN; i <= MAX; i++) {
    lines.push([new Vector3(MIN, i, Z), new Vector3(MAX, i, Z)]);
    lines.push([new Vector3(i, MIN, Z), new Vector3(i, MAX, Z)]);
  }

  const baseColor = new Color4(theme.grid.r, theme.grid.g, theme.grid.b, 0.3);

  const mesh = MeshBuilder.CreateLineSystem("grid", {
    lines,
    colors: lines.map((line) => line.map(() => baseColor)),
  }, scene);
  mesh.isPickable = false;

  createEffect(
    ambientColor,
    (amb) => {
      const c = new Color4(
        theme.grid.r * amb.r,
        theme.grid.g * amb.g,
        theme.grid.b * amb.b,
        0.3,
      );
      const colors = lines.map((line) => line.map(() => c));
      mesh = MeshBuilder.CreateLineSystem("grid", {
        lines,
        colors,
        instance: mesh,
      }, scene);
    },
  );

  onCleanup(() => mesh.dispose());

  return <></>;
}
