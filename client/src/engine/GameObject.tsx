import type { GameObjectEntry } from "../generated";
import RoadNode from "./objects/RoadNode";
import BuildingObject from "./objects/BuildingObject";

export default function GameObject(props: { entry: GameObjectEntry }) {
  switch (props.entry.object.kind) {
    case "RoadNode":
      return <RoadNode entry={props.entry} />;
    case "Building":
      return <BuildingObject entry={props.entry} />;
  }
}
