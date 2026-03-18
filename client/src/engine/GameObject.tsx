import { Dynamic } from "solid-js/web";
import type {
  GameObject as GameObjectType,
  GameObjectEntry,
} from "../generated";
import RoadNode from "./objects/RoadNode";
import BuildingObject from "./objects/BuildingObject";
import CarObject from "./objects/CarObject";
import TerrainTile from "./objects/TerrainTile";

export type KindEntry<K extends GameObjectType["kind"]> = GameObjectEntry & {
  object: Extract<GameObjectType, { kind: K }>;
};

const components: Record<GameObjectType["kind"], any> = {
  RoadNode,
  Building: BuildingObject,
  Car: CarObject,
  Terrain: TerrainTile,
};

export default function GameObject(props: { entry: GameObjectEntry }) {
  return <Dynamic component={components[props.entry.object.kind]} entry={props.entry} />;
}
