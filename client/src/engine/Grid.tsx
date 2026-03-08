import { onCleanup } from "solid-js";
import { MeshBuilder, ShaderMaterial, Effect } from "@babylonjs/core";
import { useEngine } from "./Canvas";
import { useTheme } from "./theme";
import { useDayNight } from "./DayNightCycle";

const GRID_VERTEX = `
  precision highp float;
  attribute vec3 position;
  uniform mat4 worldViewProjection;
  uniform mat4 world;
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = (world * vec4(position, 1.0)).xyz;
    gl_Position = worldViewProjection * vec4(position, 1.0);
  }
`;

const GRID_FRAGMENT = `
  precision highp float;
  varying vec3 vWorldPos;
  uniform vec3 gridColor;
  uniform float gridSpacing;
  void main() {
    vec2 coord = vWorldPos.xy / gridSpacing;
    vec2 grid = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
    float line = min(grid.x, grid.y);
    float alpha = 1.0 - min(line, 1.0);
    if (alpha < 0.05) discard;
    gl_FragColor = vec4(gridColor, alpha * 0.5);
  }
`;

export function Grid() {
  const { scene } = useEngine();
  const { ambientColor } = useDayNight();

  Effect.ShadersStore["gridVertexShader"] = GRID_VERTEX;
  Effect.ShadersStore["gridFragmentShader"] = GRID_FRAGMENT;

  const ground = MeshBuilder.CreateGround("grid", { width: 200, height: 200 }, scene);
  ground.rotation.x = Math.PI / 2;
  ground.position.z = 0.005; // above shadow ground, below roads

  const material = new ShaderMaterial("gridMat", scene, { vertex: "grid", fragment: "grid" }, {
    attributes: ["position"],
    uniforms: ["worldViewProjection", "world", "gridColor", "gridSpacing"],
    needAlphaBlending: true,
  });

  const theme = useTheme();
  const amb = ambientColor();
  material.setColor3("gridColor", theme.grid.multiply(amb));
  material.setFloat("gridSpacing", 1.0);
  material.backFaceCulling = false;

  ground.material = material;

  // Update grid color each frame to track ambient light
  const obs = scene.onBeforeRenderObservable.add(() => {
    const a = ambientColor();
    material.setColor3("gridColor", theme.grid.multiply(a));
  });

  onCleanup(() => {
    scene.onBeforeRenderObservable.remove(obs);
    ground.dispose();
    material.dispose();
  });

  return <></>;
}
